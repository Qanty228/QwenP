/**
 * Qwen "Personalização" — a single, shared personalization profile that is
 * applied to EVERY account so they all answer with the same identity/voice.
 *
 * The profile is stored globally (DB `personalization` row) and pushed to Qwen
 * per account via `POST {baseUrl}/api/v2/users/user/settings/update`. Because
 * each account has its OWN auth cookie/token, the request must be sent with
 * that account's captured headers — there is no shared "apply once" call.
 */

import { config } from '../core/config.js'
import { getBasicHeaders, getQwenHeaders } from './header-interceptor.js'
import { getBxVersion } from './qwen-versions.js'
import { listHeaderAccountIds } from './browser-manager.js'
import { getBaseAccountId } from '../core/account-lanes.js'
import { getPersonalizationRow, savePersonalizationRow } from '../core/database.js'
import { sleep } from '../utils/sleep.js'

export interface PersonalizationConfig {
  name: string
  description: string
  style: string
  instruction: string
}

export interface ApplyResult {
  accountId: string
  email?: string
  ok: boolean
  status?: number
  error?: string
}

export function getPersonalization(): PersonalizationConfig {
  const row = getPersonalizationRow()
  if (!row) return { name: '', description: '', style: 'Default', instruction: '' }
  return {
    name: row.name,
    description: row.description,
    style: row.style || 'Default',
    instruction: row.instruction,
  }
}

export function savePersonalization(cfg: Partial<PersonalizationConfig>): PersonalizationConfig {
  const current = getPersonalization()
  const next: PersonalizationConfig = {
    name: String(cfg.name ?? current.name).slice(0, 128),
    description: String(cfg.description ?? current.description).slice(0, 500),
    style: String(cfg.style ?? current.style).slice(0, 64) || 'Default',
    instruction: String(cfg.instruction ?? current.instruction).slice(0, 2000),
  }
  savePersonalizationRow(next)
  return next
}

export function hasPersonalization(): boolean {
  const c = getPersonalization()
  return Boolean(c.name || c.description || c.instruction)
}

async function applyToAccount(accountId: string, email?: string): Promise<ApplyResult> {
  const cfg = getPersonalization()
  const headers = await getBasicHeaders(accountId)
  if (!headers?.cookie) {
    return { accountId, email, ok: false, error: 'sem cookie/token para esta conta' }
  }
  const url = `${config.qwen.baseUrl}/api/v2/users/user/settings/update`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: config.qwen.baseUrl,
        Referer: `${config.qwen.baseUrl}/settings/personalization`,
        'bx-v': headers.bxV || getBxVersion(),
        'bx-ua': headers.bxUa || '',
        'bx-umidtoken': headers.bxUmidtoken || '',
        source: 'web',
        cookie: headers.cookie,
        'User-Agent': headers.userAgent,
      },
      body: JSON.stringify({
        personalization: {
          name: cfg.name,
          description: cfg.description,
          style: cfg.style,
          instruction: cfg.instruction,
        },
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { accountId, email, ok: false, status: res.status, error: text.slice(0, 200) }
    }
    return { accountId, email, ok: true }
  } catch (err: any) {
    return { accountId, email, ok: false, error: err?.message || 'erro de rede' }
  } finally {
    clearTimeout(timeout)
  }
}

/** Applies the shared personalization to a single account (by id or lane id). */
export async function applyPersonalizationToAccount(accountId: string): Promise<ApplyResult> {
  return applyToAccount(accountId)
}

/** Best cached header key for a base account (handles lanes in single-account mode). */
function headerKeyFor(baseId: string): string {
  for (const id of listHeaderAccountIds()) {
    if (id === 'guest') continue
    if ((getBaseAccountId(id) || id) === baseId) return id
  }
  return baseId
}

/** Warms an account's headers (captures anti-bot cookies) with a hard timeout. */
async function warmAccountHeaders(accountId: string): Promise<void> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout ao aquecer')), 75000))
  await Promise.race([getQwenHeaders(false, accountId), timeout])
}

/**
 * Applies the shared personalization to EVERY configured account. Accounts that
 * already have warm (captured) headers are applied directly; cold accounts are
 * warmed up first (bounded to ~75s each, in parallel) so their own auth token is
 * available. Lanes of the same account are de-duplicated to their base id.
 */
export async function applyPersonalizationToAll(): Promise<ApplyResult[]> {
  const { loadAccounts } = await import('../core/accounts.js')

  const accounts = loadAccounts()
  const warm = new Set(
    listHeaderAccountIds()
      .filter((id) => id !== 'guest')
      .map((id) => getBaseAccountId(id) || id),
  )

  // Warm up cold accounts so they have headers to apply with.
  await Promise.all(
    accounts
      .filter((a) => !warm.has(a.id))
      .map((a) =>
        warmAccountHeaders(a.id)
          .then(() => warm.add(a.id))
          .catch(() => {}),
      ),
  )

  const results: ApplyResult[] = []
  for (const a of accounts) {
    if (warm.has(a.id)) {
      results.push(await applyToAccount(headerKeyFor(a.id), a.email))
    } else {
      results.push({ accountId: a.id, email: a.email, ok: false, error: 'não foi possível obter headers (conta não aquecida)' })
    }
    await sleep(120)
  }

  return results
}
