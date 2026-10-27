import { getBaseAccountId } from './account-lanes.js';
import {
  deleteModelLimit,
  deleteModelLimitsForAccount,
  listPersistedModelLimits,
  upsertModelLimit,
} from './database.js';

/**
 * Tracks which models are out of quota for which account.
 *
 * Qwen enforces a daily limit per model: once an account exhausts
 * "Qwen3.8-Max" it can still serve every other model. Blocking the whole
 * account would throw away a perfectly usable account, so the limit is
 * recorded per (account, model) pair instead.
 *
 * The state is persisted so a proxy restart does not immediately re-pick an
 * account that is known to be out of quota.
 */

export interface ModelLimitEntry {
  accountId: string;
  model: string;
  until: number;
  reason: string;
  updatedAt: number;
}

const modelLimits = new Map<string, ModelLimitEntry>();

const KEY_SEPARATOR = '::';

function limitKey(accountId: string, model: string): string {
  return `${getBaseAccountId(accountId) || accountId}${KEY_SEPARATOR}${model}`;
}

/** Normalizes a model id so "qwen3.8-max" and "Qwen3.8-Max" share a limit. */
export function normalizeModelId(model: string): string {
  return (model || '').trim().toLowerCase();
}

/**
 * Records that an account cannot use a model until `until`.
 */
export function markAccountModelLimited(
  accountId: string,
  model: string,
  until: number,
  reason = 'MembershipLimit',
): void {
  const normalized = normalizeModelId(model);
  if (!normalized) return;
  const entry: ModelLimitEntry = {
    accountId: getBaseAccountId(accountId) || accountId,
    model: normalized,
    until,
    reason,
    updatedAt: Date.now(),
  };
  modelLimits.set(limitKey(accountId, normalized), entry);
  persistModelLimit(entry);
}

/** True when the account is known to be out of quota for the model. */
export function isAccountModelLimited(accountId: string, model: string): boolean {
  const entry = getModelLimit(accountId, model);
  return entry !== null;
}

/** Returns the active limit entry for the account/model pair, if any. */
export function getModelLimit(accountId: string, model: string): ModelLimitEntry | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  const key = limitKey(accountId, normalized);
  const entry = modelLimits.get(key);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    modelLimits.delete(key);
    deletePersistedModelLimit(entry.accountId, normalized);
    return null;
  }
  return entry;
}

/** Milliseconds until the model becomes usable again, or 0 when it is usable. */
export function getModelLimitRemainingMs(accountId: string, model: string): number {
  const entry = getModelLimit(accountId, model);
  if (!entry) return 0;
  return Math.max(0, entry.until - Date.now());
}

/** Clears the limit for one account/model pair. */
export function clearAccountModelLimit(accountId: string, model: string): void {
  const normalized = normalizeModelId(model);
  if (!normalized) return;
  modelLimits.delete(limitKey(accountId, normalized));
  deletePersistedModelLimit(getBaseAccountId(accountId) || accountId, normalized);
}

/** Clears every model limit for an account. */
export function clearAllAccountModelLimits(accountId: string): void {
  const base = getBaseAccountId(accountId) || accountId;
  for (const [key, entry] of [...modelLimits.entries()]) {
    if (entry.accountId === base) {
      modelLimits.delete(key);
    }
  }
  deletePersistedModelLimits(base);
}

/** Snapshot of the active limits, for the admin dashboard. */
export function listModelLimits(): ModelLimitEntry[] {
  const now = Date.now();
  const out: ModelLimitEntry[] = [];
  for (const [key, entry] of [...modelLimits.entries()]) {
    if (entry.until <= now) {
      modelLimits.delete(key);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Loads persisted limits into memory on startup. */
export function loadModelLimits(): void {
  try {
    for (const row of listPersistedModelLimits()) {
      if (row.until <= Date.now()) continue;
      modelLimits.set(limitKey(row.account_id, row.model), {
        accountId: row.account_id,
        model: row.model,
        until: row.until,
        reason: row.reason,
        updatedAt: row.updated_at,
      });
    }
  } catch {
    /* persistence is optional */
  }
}

function persistModelLimit(entry: ModelLimitEntry): void {
  try {
    upsertModelLimit(entry);
  } catch {
    /* persistence is optional */
  }
}

function deletePersistedModelLimit(accountId: string, model: string): void {
  try {
    deleteModelLimit(accountId, model);
  } catch {
    /* persistence is optional */
  }
}

function deletePersistedModelLimits(accountId: string): void {
  try {
    deleteModelLimitsForAccount(accountId);
  } catch {
    /* persistence is optional */
  }
}
