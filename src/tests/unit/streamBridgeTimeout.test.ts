/*
 * File: streamBridgeTimeout.test.ts
 * Project: qwenproxy
 *
 * Regression tests for the CDP stream bridge timeout semantics:
 *  - Waiting for response headers must time out with a clear
 *    "timed out waiting for response headers" error.
 *  - Once headers arrive, a long-running SSE body must NOT be aborted by
 *    the in-page fetch timeout (previously caused spurious mid-stream errors).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { browserStreamFetch } from '../../services/stream-bridge.js';

type RelayFn = (reqId: string, type: string, data: any) => void | Promise<void>;

function makeFakePage(opts: {
  /** Simulated latency before response headers are available. */
  headersDelayMs?: number;
  /** When true, the fake upstream never sends headers (hangs). */
  hangHeaders?: boolean;
}) {
  let relay: RelayFn | undefined;
  const abortControllers: Record<string, { signal: { aborted: boolean }; abort: () => void }> = {};
  const win: Record<string, any> = {
    get __abortControllers() { return abortControllers; },
    set __abortControllers(v) { Object.assign(abortControllers, v); },
    get __streamRelay() { return relay; },
    set __streamRelay(fn) { relay = fn as RelayFn; },
  };

  const page: any = {
    _win: win,
    isClosed: () => false,
    async exposeFunction(name: string, fn: RelayFn) {
      assert.strictEqual(name, '__streamRelay');
      relay = fn;
      win.__streamRelay = ((rid: string, type: string, data: any) => fn(rid, type, data)) as any;
    },
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    async evaluate(code: any, arg: any) {
      // Only the main fetch evaluation matters for these tests.
      if (!arg || typeof arg.reqId !== 'string') return undefined;
      const { reqId } = arg;
      const controller: { signal: { aborted: boolean }; abort: () => void } = {
        signal: { aborted: false },
        abort() { this.signal.aborted = true; },
      };
      abortControllers[reqId] = controller;
      try {
        if (opts.hangHeaders) {
          // Never resolve — simulates an upstream that does not send headers.
          await new Promise(() => {});
        }
        await new Promise((r) => setTimeout(r, opts.headersDelayMs ?? 0));
        if (controller.signal.aborted) throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
        relay!(reqId, 'meta', { status: 200, statusText: 'OK', contentType: 'text/event-stream', headers: {} });
        // Hold the stream open briefly to emulate a slow SSE body, then finish.
        await new Promise((r) => setTimeout(r, 50));
        if (controller.signal.aborted) throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
        relay!(reqId, 'chunk', 'data: hello\n\n');
        relay!(reqId, 'end', null);
      } catch (e: any) {
        relay!(reqId, 'error', e.message);
      } finally {
        delete abortControllers[reqId];
      }
      return undefined;
    },
  };
  return page;
}

describe('stream-bridge header timeout', () => {
  it('rejects with a clear "response headers" timeout when headers never arrive', async () => {
    const page = makeFakePage({ hangHeaders: true });
    await assert.rejects(
      browserStreamFetch(page, 'https://example.invalid/api', { timeoutMs: 150 }),
      (err: Error) => {
        assert.match(err.message, /timed out waiting for response headers after 150ms/);
        return true;
      },
    );
  });

  it('resolves normally and streams the full body when headers arrive quickly', async () => {
    const page = makeFakePage({ headersDelayMs: 10 });
    const result = await browserStreamFetch(page, 'https://example.invalid/api', { timeoutMs: 5000 });
    assert.strictEqual(result.status, 200);
    assert.ok(result.contentType.includes('text/event-stream'));

    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let all = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      all += decoder.decode(value, { stream: true });
    }
    assert.strictEqual(all, 'data: hello\n\n');
  });

  it('does not abort the stream body after headers have been delivered', async () => {
    // Headers arrive fast; body streams longer than the header timeout window.
    // The old behavior aborted at options.timeoutMs and surfaced a mid-stream
    // AbortError; the new behavior lets the body complete.
    const page = makeFakePage({ headersDelayMs: 10 });
    const result = await browserStreamFetch(page, 'https://example.invalid/api', { timeoutMs: 80 });
    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let all = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      all += decoder.decode(value, { stream: true });
    }
    assert.strictEqual(all, 'data: hello\n\n');
  });
});
