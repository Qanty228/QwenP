export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  /** True when the upstream rejected the request because the bearer access
   *  token expired (or was otherwise invalid). Callers can use this to renew
   *  the token and retry instead of surfacing a permanent 502. */
  readonly isUnauthorized: boolean;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
    const code = String(upstreamCode || '').toLowerCase();
    const msg = String(message || '').toLowerCase();
    this.isUnauthorized = code.includes('unauthorized')
      || msg.includes('token has expired')
      || msg.includes('please log in again');
  }
}

/**
 * Detects an "expired/invalid bearer token" reply coming straight from the
 * Qwen upstream.
 *
 * The access token is a 15 minute JWT while the proxy caches headers, warm
 * pool chats and persisted sessions for far longer. When such a cached token
 * silently expires, upstream answers with
 * `{"success":false,"data":{"code":"unauthorized","details":"Token has expired..."}}`
 * and every following request would keep failing with a generic 502 until the
 * process is restarted — unless the error is recognised here so the caller
 * can renew the token and retry.
 */
export function isQwenUnauthorizedPayload(json: any): boolean {
  if (!json) return false;
  if (json.success !== false && !json.error) return false;
  const candidates = [
    json.data?.code,
    json.code,
    json.error?.code,
    json.data?.details,
    json.message,
    json.error?.message,
  ];
  return candidates.some((value: any) => {
    if (typeof value !== 'string') return false;
    const lower = value.toLowerCase();
    return lower.includes('unauthorized')
      || lower.includes('token has expired')
      || lower.includes('please log in again');
  });
}

/**
 * True when a response body carries Qwen's "expired token" rejection. Accepts
 * either a raw JSON string or an already-parsed object. Shared by the HTTP
 * paths and the SSE tail detector so every layer recognises the same
 * condition — parsed defensively, since upstream sometimes wraps the JSON in
 * extra text or answers with plain HTML.
 */
export function bodyIndicatesExpiredToken(body: string | any): boolean {
  if (!body) return false;
  if (typeof body !== 'string') return isQwenUnauthorizedPayload(body);
  try {
    if (isQwenUnauthorizedPayload(JSON.parse(body))) return true;
  } catch { /* not plain JSON */ }
  // Fallback: find the JSON object embedded in the text (SSE payloads,
  // error pages that prepend/append markup, etc.).
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      if (isQwenUnauthorizedPayload(JSON.parse(body.slice(start, end + 1)))) return true;
    } catch { /* ignore malformed fragments */ }
  }
  const lower = body.toLowerCase();
  return lower.includes('token has expired') || lower.includes('please log in again');
}

/**
 * True when an error thrown anywhere in the pipeline signals that the bearer
 * access token was rejected by upstream. Such errors are worth a token
 * renewal + retry instead of being surfaced as a permanent failure.
 */
export function isExpiredTokenError(err: any): boolean {
  if (!err) return false;
  if (err instanceof QwenUpstreamError) return err.isUnauthorized;
  // A transport-level failure (browser relay header timeout, socket hang up,
  // DNS "fetch failed") can carry upstream text in its message but says
  // nothing about the bearer token's validity. Never route those into the
  // token-renewal replay path — they belong to the retry/failover path.
  if (isRetryableStreamFailure(err)) return false;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('token has expired')
    || msg.includes('please log in again')
    || msg.includes('unauthorized');
}

const RETRYABLE_STREAM_FAILURE_PATTERNS = [
  'timed out waiting for response headers',
  'browser stream fetch timed out',
  'browser stream fetch failed',
  'idle timeout',
  'socket hang up',
  'network error',
  'failed to fetch',
  'fetch failed',
];

/**
 * True when an error signals a transient transport/stream failure rather than
 * a permanent upstream rejection. These should be retried (with backoff and/or
 * lane failover) instead of surfacing a raw 502 to the client.
 */
export function isRetryableStreamFailure(err: any): boolean {
  if (!err) return false;
  if (err instanceof RetryableQwenStreamError) return true;
  // Explicit upstream rejections (rate limit, captcha, dead token) are not
  // transport failures — the caller handles them via quarantine/rotation.
  if (err instanceof QwenUpstreamError) return false;
  const msg = String(err?.message || '').toLowerCase();
  return RETRYABLE_STREAM_FAILURE_PATTERNS.some(p => msg.includes(p));
}

export function handleErrorBody(peekText: string, status: number): never {
  try {
    const errorJson = JSON.parse(peekText);
    if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
      const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
    }
    if (errorJson && (errorJson.success === false || errorJson.error)) {
      const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
      const details = errorJson.data?.details || errorJson.message || errorJson.error?.message || 'Qwen returned an error';
      const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
      let errStatus = 502;
      if (code === 'RateLimited') errStatus = 429;
      throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, errStatus);
    }
  } catch (e) {
    if (e instanceof QwenUpstreamError || e instanceof RetryableQwenStreamError) throw e;
  }
  throw new Error(`Qwen returned status ${status}: ${peekText.slice(0, 500)}`);
}

export function handleJsonErrorBody(errText: string): never {
  try {
    const errorJson = JSON.parse(errText);
    if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
      const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
    }
    if (errorJson?.success === false) {
      const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
      const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
      const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
      let status: number;
      if (code === 'RateLimited') status = 429;
      else if (code === 'Not_Found') status = 404;
      else status = 502;
      throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
    }
    if (errorJson?.data?.details?.includes('is not exist') || errorJson?.data?.details?.includes('not exist') || errorJson.data?.details?.includes('does not exist')) {
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, 0);
    }
  } catch (e) {
    if (e instanceof RetryableQwenStreamError || e instanceof QwenUpstreamError) throw e;
  }
  throw new Error(`Qwen JSON error: ${errText.slice(0, 500)}`);
}
