import type { Page } from 'playwright';
import crypto from 'crypto';
import { config } from '../core/config.js';
import { startCaptchaWatcher } from './captcha-solver.js';

const streamCallbacks = new Map<string, {
  onChunk: (chunk: string) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
  onMeta: (meta: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  onBody: (body: string) => void;
}>();

const abortControllers = new Map<string, () => void>();

// Requests whose response headers ("meta") have already been relayed to Node.
// The in-page fetch timeout must NOT abort these requests: once the headers are
// out, the upstream may legitimately keep streaming SSE events for many minutes
// and an AbortError at that point would surface as a spurious mid-stream error.
// This set is keyed by reqId so a late timer inside the page can only cancel
// its own request, never a newer one sharing the page.
const metaDeliveredReqIds = new Set<string>();

const pagesWithExposed = new WeakSet<Page>();

async function ensureStreamBridge(page: Page): Promise<void> {
  if (pagesWithExposed.has(page)) return;
  pagesWithExposed.add(page);
  await page.exposeFunction('__streamRelay', (reqId: string, type: string, data: any) => {
    const cb = streamCallbacks.get(reqId);
    if (!cb) return;
    switch (type) {
      case 'meta': metaDeliveredReqIds.add(reqId); cb.onMeta(data); break;
      case 'chunk': cb.onChunk(data); break;
      case 'end': cb.onEnd(); streamCallbacks.delete(reqId); abortControllers.delete(reqId); metaDeliveredReqIds.delete(reqId); break;
      case 'error': cb.onError(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); metaDeliveredReqIds.delete(reqId); break;
      case 'body': cb.onBody(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); metaDeliveredReqIds.delete(reqId); break;
    }
  });
}

export async function browserFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; statusText: string; contentType: string; body: string; headers: Record<string, string> }> {
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();

  const timeoutMs = options.timeoutMs || 30000;
  const watcher = startCaptchaWatcher(page, timeoutMs);

  try {
    if (page.isClosed()) throw new Error('Page is closed');
    return await page.evaluate(async ({ url, options }: any) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
      try {
        const resp = await fetch(url, {
          method: options.method || 'POST',
          headers: options.headers || {},
          body: options.body || undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
        const body = await resp.text();
        return {
          status: resp.status,
          statusText: resp.statusText,
          contentType: resp.headers.get('content-type') || '',
          body,
          headers: respHeaders,
        };
      } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error(`browserFetch failed: ${e.message}`, { cause: e });
      }
    }, { url, options, reqId });
  } catch (err: any) {
    if (err.message?.includes('Execution context was destroyed') || err.message?.includes('Target closed') || err.message?.includes('Page is closed')) {
      throw new Error(`browserFetch context lost: ${err.message}`, { cause: err });
    }
    throw err;
  } finally {
    watcher.stop();
  }
}

export async function browserStreamFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  body: string;
  reqId: string;
  abort: () => void;
}> {
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();
  const enc = new TextEncoder();

  let metaResolve!: (value: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  let metaReject!: (reason: Error) => void;
  const metaPromise = new Promise<{ status: number; statusText: string; contentType: string; headers: Record<string, string> }>((resolve, reject) => {
    metaResolve = resolve;
    metaReject = reject;
  });

  const metaTimeoutMs = options.timeoutMs || config.timeouts.chat;
  // The in-page fetch uses a longer overall timeout than the metadata wait:
  // headers must arrive within metaTimeoutMs, but once they do, the SSE body
  // may legitimately stream for far longer without being aborted.
  const inPageTimeoutMs = Math.max(metaTimeoutMs * 2, metaTimeoutMs + 60000);
  const metaTimeout = setTimeout(() => {
    streamCallbacks.delete(reqId);
    abortControllers.delete(reqId);
    metaDeliveredReqIds.delete(reqId);
    // Ask the page to cancel the still-pending fetch so the request does not
    // linger on the browser lane after we gave up waiting for its headers.
    page.evaluate((reqId: string) => {
      const c = (window as any).__abortControllers?.[reqId];
      if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
    }, reqId).catch(() => {});
    metaReject(new Error(`Browser stream fetch timed out waiting for response headers after ${metaTimeoutMs}ms`));
  }, metaTimeoutMs);

  streamCallbacks.set(reqId, {
    onMeta: (meta) => {
      clearTimeout(metaTimeout);
      metaResolve(meta);
    },
    onChunk: () => {},
    onEnd: () => {},
    onError: (msg: string) => {
      clearTimeout(metaTimeout);
      metaReject(new Error(msg));
    },
    onBody: () => {},
  });

  // If the caller never consumes the result (e.g. an error path abandons it),
  // clean up the reqId marker so it cannot leak into the global set.
  const cleanupReqIdState = () => {
    streamCallbacks.delete(reqId);
    abortControllers.delete(reqId);
    metaDeliveredReqIds.delete(reqId);
  };

  let bodyResolve!: (value: string) => void;
  let bodyReject!: (reason: Error) => void;
  const bodyPromise = new Promise<string>((resolve, reject) => {
    bodyResolve = resolve;
    bodyReject = reject;
  });
  bodyPromise.catch(() => {});

  const watcher = startCaptchaWatcher(page, metaTimeoutMs);

  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cb = streamCallbacks.get(reqId);
        if (!cb) return;
        cb.onChunk = (chunk: string) => {
          try { controller.enqueue(enc.encode(chunk)); } catch { /* ignore */ }
        };
        cb.onEnd = () => {
          try { controller.close(); } catch { /* ignore */ }
          bodyResolve('');
          cleanupReqIdState();
        };
        cb.onError = (msg: string) => {
          try { controller.error(new Error(msg)); } catch { /* ignore */ }
          bodyReject(new Error(msg));
          cleanupReqIdState();
        };
        cb.onBody = (text: string) => {
          bodyResolve(text);
          cleanupReqIdState();
        };

        page.evaluate(async ({ url, options, reqId, evalTimeoutMs }: any) => {
          const controller = new AbortController();
          (window as any).__abortControllers = (window as any).__abortControllers || {};
          (window as any).__abortControllers[reqId] = controller;
          // This timer only guards the wait for response HEADERS. Once the meta
          // event has been relayed to Node, the request is considered "accepted"
          // and must not be aborted mid-stream — long SSE generations are normal.
          let headersArrived = false;
          const timeoutId = setTimeout(() => {
            if (headersArrived) return;
            controller.abort();
          }, evalTimeoutMs);
          try {
            const resp = await fetch(url, {
              method: options.method || 'POST',
              headers: options.headers || {},
              body: options.body || undefined,
              signal: controller.signal,
            });
            headersArrived = true;
            clearTimeout(timeoutId);
            const respHeaders: Record<string, string> = {};
            resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
            (window as any).__streamRelay(reqId, 'meta', {
              status: resp.status,
              statusText: resp.statusText,
              contentType: resp.headers.get('content-type') || '',
              headers: respHeaders,
            });

            const responseContentType = resp.headers.get('content-type') || '';
            if (!resp.ok || !resp.body || !responseContentType.includes('text/event-stream')) {
              const bodyText = await resp.text().catch(() => '');
              (window as any).__streamRelay(reqId, 'body', bodyText);
              delete (window as any).__abortControllers[reqId];
              return;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            // Coalesce chunks before crossing the CDP bridge. Each __streamRelay call
            // is an expensive serialized round-trip; batching by time/size reduces
            // bridge overhead. Thresholds tuned for LOW LATENCY: small byte budget +
            // short interval flush ~2-3 SSE events at a time, and the very first chunk
            // is flushed immediately for minimum first-token latency (TTFT).
            // NOTE: keep this inline (no named functions) — code inside page.evaluate
            // runs in the browser where esbuild's __name helper does not exist.
            const FLUSH_BYTES = 512;
            const FLUSH_INTERVAL_MS = 8;
            let pending = '';
            let flushTimer: any = null;
            let firstChunkSent = false;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
                  if (pending) { (window as any).__streamRelay(reqId, 'chunk', pending); pending = ''; }
                  (window as any).__streamRelay(reqId, 'end', null);
                  break;
                }
                pending += decoder.decode(value, { stream: true });
                if (!firstChunkSent) {
                  // Fast-path: flush the first byte(s) immediately to minimize TTFT.
                  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
                  (window as any).__streamRelay(reqId, 'chunk', pending);
                  pending = '';
                  firstChunkSent = true;
                } else if (pending.length >= FLUSH_BYTES) {
                  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
                  (window as any).__streamRelay(reqId, 'chunk', pending);
                  pending = '';
                } else if (!flushTimer) {
                  flushTimer = setTimeout(() => {
                    flushTimer = null;
                    if (pending) { (window as any).__streamRelay(reqId, 'chunk', pending); pending = ''; }
                  }, FLUSH_INTERVAL_MS);
                }
              }
            } finally {
              if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            }
            delete (window as any).__abortControllers[reqId];
          } catch (e: any) {
            clearTimeout(timeoutId);
            // The in-page header-wait timer fired before response headers arrived.
            // Node may have already surfaced its own "timed out waiting for response
            // headers" error and torn down the callbacks; relay anyway so a still-
            // listening consumer gets a clear message instead of hanging forever.
            const abortedByHeaderTimeout = !headersArrived && e && (e.name === 'AbortError' || String(e.message || '').includes('abort'));
            const msg = abortedByHeaderTimeout
              ? `Browser stream fetch timed out waiting for response headers after ${evalTimeoutMs}ms`
              : e.message;
            (window as any).__streamRelay(reqId, 'error', msg);
            delete (window as any).__abortControllers[reqId];
          }
        }, { url, options, reqId, evalTimeoutMs: inPageTimeoutMs }).catch((e: any) => {
          const cb = streamCallbacks.get(reqId);
          if (cb) {
            cb.onError(e.message);
          }
          cleanupReqIdState();
        });
      },
      cancel() {
        page.evaluate((reqId: string) => {
          const c = (window as any).__abortControllers?.[reqId];
          if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
        }, reqId).catch(() => {});
        cleanupReqIdState();
      },
    });

    const meta = await metaPromise;

    // Safety net: if the caller abandons this request without ever consuming or
    // aborting the stream (e.g. an error thrown between meta and return), drop
    // all reqId state after the overall in-page timeout would have elapsed.
    // Legitimate consumers keep state alive via the relayed end/error/body events.
    const leakTimer = setTimeout(cleanupReqIdState, inPageTimeoutMs);
    leakTimer.unref?.();

    const abortFn = () => {
      page.evaluate((reqId: string) => {
        const c = (window as any).__abortControllers?.[reqId];
        if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
      }, reqId).catch(() => {});
      clearTimeout(leakTimer);
      cleanupReqIdState();
    };

    abortControllers.set(reqId, abortFn);

    return {
      ...meta,
      stream,
      body: meta.contentType.includes('text/event-stream') ? '' : await bodyPromise,
      reqId,
      abort: abortFn,
    };
  } finally {
    watcher.stop();
  }
}
