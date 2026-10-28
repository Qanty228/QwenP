import type { Page } from 'playwright';
import { accountPages, getAccountHeaderCache, refreshQwenAccessToken, renewAccessTokenViaPage } from './browser-manager.js';
import { getCookies } from './header-interceptor.js';
import { getBearerTokenExpiryMs, hasExpiredBearerToken, isBearerTokenExpired } from '../utils/access-token.js';

/**
 * Central place that keeps the Qwen access token usable.
 *
 * The bearer token is a 15 minute JWT, while the proxy keeps headers, warm
 * pool chats and persisted sessions for far longer. Whenever a cached token
 * turns out to be expired the request would fail with a generic
 * "Unauthorized" error, so the token is renewed here before it is used.
 *
 * Renewal is cheap: the `refresh_token` cookie set during signin is enough
 * to mint a new access token, no interactive login required.
 */

type HeaderStore = { currentHeaders: Record<string, string>; lastHeadersTime: number };

function storeFor(accountId?: string): HeaderStore {
  return getAccountHeaderCache(accountId || 'global') as unknown as HeaderStore;
}

/**
 * Returns the bearer token currently held for the account, or null when
 * there is none or the one we have already expired.
 */
export function getUsableBearerToken(accountId?: string): string | null {
  const store = storeFor(accountId);
  const authorization = store.currentHeaders['authorization'];
  if (!authorization) return null;
  if (isBearerTokenExpired(authorization)) return null;
  return authorization;
}

/**
 * True when the account currently holds a bearer token that has expired.
 */
export function hasExpiredToken(accountId?: string): boolean {
  const store = storeFor(accountId);
  return hasExpiredBearerToken(store.currentHeaders);
}

/**
 * Renews the access token for an account using the `refresh_token` cookie.
 *
 * Returns the new `authorization` header value, or null when the cookie is
 * missing or the renewal was rejected (in which case a full signin is
 * required).
 */
export async function renewAccessToken(accountId?: string, page?: Page): Promise<string | null> {
  const target = page ?? resolveAccountPage(accountId);
  if (!target) return null;

  // The refresh endpoint only accepts requests coming from the real web
  // client, so the direct request is tried first and the page reload is the
  // fallback that lets the frontend perform the refresh itself.
  let token = await refreshQwenAccessToken(target);
  if (!token) {
    token = await renewAccessTokenViaPage(target);
  }
  if (!token) return null;

  const authorization = `Bearer ${token}`;
  const store = storeFor(accountId);
  store.currentHeaders['authorization'] = authorization;
  store.lastHeadersTime = Date.now();
  // Keep every long-lived copy of the headers in sync (cached header sets,
  // warm-pool entries and persisted sessions all embed the bearer token), so
  // a renewed token is picked up everywhere instead of stale copies keeping
  // upstream on the "Token has expired" rejection path.
  try {
    const { applyRenewedTokenToCaches } = await import('./header-interceptor.js');
    applyRenewedTokenToCaches(accountId || 'global', authorization);
  } catch { /* best effort */ }
  try {
    const { upgradeSessionAuthorization } = await import('./session-manager.js');
    upgradeSessionAuthorization(accountId || 'global', authorization);
  } catch { /* best effort */ }
  return authorization;
}

/**
 * Ensures the account holds a usable access token, renewing it when the
 * cached one has expired.
 *
 * Returns true when a usable token is available afterwards.
 */
export async function ensureUsableToken(accountId?: string, page?: Page): Promise<boolean> {
  if (getUsableBearerToken(accountId)) return true;

  const renewed = await renewAccessToken(accountId, page);
  if (renewed) {
    console.log(`[Token] Renewed expired Qwen access token for ${accountId || 'global'}.`);
    return true;
  }

  return getUsableBearerToken(accountId) !== null;
}

// Avoid hammering the refresh flow when the session itself is dead (e.g. the
// refresh_token cookie also expired and a full re-login is required).
const renewalFailures = new Map<string, { count: number; lastAttempt: number }>();
const RENEWAL_BACKOFF_MS = 60_000;
const MAX_RENEWAL_FAILURES = 3;

function shouldThrottleRenewal(cacheKey: string): boolean {
  const state = renewalFailures.get(cacheKey);
  if (!state) return false;
  if (Date.now() - state.lastAttempt > 5 * 60_000) {
    renewalFailures.delete(cacheKey);
    return false;
  }
  return state.count >= MAX_RENEWAL_FAILURES;
}

function recordRenewalResult(cacheKey: string, ok: boolean) {
  if (ok) {
    renewalFailures.delete(cacheKey);
    return;
  }
  const prev = renewalFailures.get(cacheKey);
  renewalFailures.set(cacheKey, { count: (prev?.count ?? 0) + 1, lastAttempt: Date.now() });
}

/**
 * Proactive maintenance hook: renews the bearer token ahead of its expiry so
 * background flows (warm pool refill, keep-alive) never cache or reuse a
 * token that upstream would reject with "Token has expired".
 *
 * Safe to call very frequently: it is a no-op while the current token still
 * has enough lifetime left.
 */
export async function keepTokenFresh(accountId?: string, safetyMs = 2 * 60_000): Promise<boolean> {
  const cacheKey = accountId || 'global';
  const authorization = getUsableBearerToken(accountId);
  if (!authorization) return false;

  const expiry = getBearerTokenExpiryMs(authorization);
  if (expiry === null) return true; // opaque token: nothing to track
  if (expiry - Date.now() > safetyMs) return true;

  if (shouldThrottleRenewal(cacheKey)) return false;

  const renewed = await renewAccessToken(accountId);
  recordRenewalResult(cacheKey, renewed !== null);
  return renewed !== null;
}

/**
 * Recovery hook for an "unauthorized / Token has expired" reply coming from
 * upstream. Works on any header set (warm-pool entry, persisted session or
 * cached capture): drops the rejected bearer token, renews it through the
 * refresh cookie and patches every long-lived copy, so the caller can retry
 * immediately instead of serving the same dead token forever.
 *
 * Returns the updated headers when a fresh token could be installed, or null
 * when the renewal failed (in which case a full re-login is required).
 */
export async function recoverHeadersFromUnauthorized(
  accountId: string | undefined,
  headers?: Record<string, string> | null,
): Promise<Record<string, string> | null> {
  const cacheKey = accountId || 'global';
  if (shouldThrottleRenewal(cacheKey)) return null;

  const store = storeFor(accountId);
  const rejectedAuthorization = headers?.['authorization'] ?? store.currentHeaders['authorization'];
  // Invalidate what upstream just rejected so a concurrent capture cannot
  // hand the same token out again.
  if (rejectedAuthorization && store.currentHeaders['authorization'] === rejectedAuthorization) {
    delete store.currentHeaders['authorization'];
  }

  const renewed = await renewAccessToken(accountId);
  recordRenewalResult(cacheKey, renewed !== null);
  if (!renewed) {
    console.warn(`[Token] Could not renew access token after upstream unauthorized error for ${cacheKey}; a re-login may be required.`);
    return null;
  }
  console.log(`[Token] Renewed access token after upstream unauthorized error for ${cacheKey}.`);
  return headers ? applyBearerToken(headers, renewed) : null;
}

/**
 * Replaces the bearer token inside a header set, keeping every other header
 * untouched. Used to upgrade headers that were captured before a renewal.
 */
export function applyBearerToken(headers: Record<string, string>, authorization: string): Record<string, string> {
  return { ...headers, authorization };
}

/**
 * Refreshes the cookie header of a header set from the live browser context,
 * so long-lived header sets do not keep using a stale cookie jar.
 */
export async function refreshCookieHeader(accountId?: string): Promise<string | null> {
  try {
    const cookie = await getCookies(accountId);
    return cookie || null;
  } catch {
    return null;
  }
}

function resolveAccountPage(accountId?: string): Page | null {
  if (!accountId) return null;
  try {
    return accountPages.get(accountId) ?? null;
  } catch {
    return null;
  }
}
