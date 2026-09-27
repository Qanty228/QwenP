/**
 * Read/write helpers for the `.env` file so the admin dashboard can adjust
 * essential settings. Only a curated allow-list of keys can be persisted and
 * values are validated; a server restart is required for most to take effect.
 */

import fs from 'fs'
import path from 'path'

const ENV_FILE = process.env.QWENPROXY_ENV_FILE || path.resolve('.env')

const BOOLEAN_KEYS = new Set([
  'HEADLESS',
  'LOG_CONSOLE',
  'QWEN_GUEST_MODE_ONLY',
  'SINGLE_ACCOUNT_MODE',
  'SESSION_KEEPER_ENABLED',
  'BACKGROUND_HEADER_REFRESH',
  'WARM_POOL_STARTUP',
  'HYBRID_SESSIONS_ENABLED',
  'HYBRID_SESSION_VERIFY',
  'QWEN_DIRECT_FETCH',
  'QWEN_TEMPORARY_CHAT',
])

const INTEGER_KEYS = new Set([
  'PORT',
  'WARM_POOL_SIZE',
  'WARM_POOL_LOW_WATER',
  'WARM_POOL_TTL_MS',
  'ACCOUNT_LANES',
  'ACCOUNT_MAX_CONCURRENT_STREAMS',
  'ACCOUNT_STREAM_SLOT_WAIT_MS',
  'HEADERS_TTL_MS',
  'LARGE_PROMPT_THRESHOLD',
  'HYBRID_SESSION_TTL_MS',
  'USER_RATE_LIMIT_RPM',
  'USER_MAX_CONCURRENCY',
])

const STRING_KEYS = new Set(['HOST', 'BROWSER'])

export const SETTINGS_ALLOWLIST = new Set([...BOOLEAN_KEYS, ...INTEGER_KEYS, ...STRING_KEYS])
export { BOOLEAN_KEYS, INTEGER_KEYS }

/** Secret/derived settings that are shown masked and never written via the UI. */
export const SETTINGS_SECRETS = new Set(['API_KEY', 'ADMIN_PASSWORD', 'QWEN_PASSWORD'])

export function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {}
  const out: Record<string, string> = {}
  const raw = fs.readFileSync(ENV_FILE, 'utf-8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function validateValue(key: string, value: string): string {
  const v = value.trim()
  if (v === '') throw new Error(`Empty value for ${key}`)
  if (INTEGER_KEYS.has(key)) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`)
    return String(n)
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (!/^(true|false)$/i.test(v)) throw new Error(`${key} must be true or false`)
    return v
  }
  return v
}

/**
 * Applies a validated, allowlisted patch to `.env`. `null` removes the key.
 * Returns the list of applied keys.
 */
export function persistEnvPatch(patch: Record<string, string | null>): string[] {
  const applied: string[] = []
  const existing = readEnvFile()
  const removed = new Set<string>()
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : ''
  if (content && !content.endsWith('\n')) content += '\n'

  for (const [key, rawValue] of Object.entries(patch)) {
    if (!SETTINGS_ALLOWLIST.has(key)) continue
    if (rawValue === null) {
      removed.add(key)
      delete existing[key]
      applied.push(key)
      continue
    }
    const validated = validateValue(key, rawValue)
    existing[key] = validated
    applied.push(key)
  }

  // Rebuild the file preserving comments, replacing values for known keys.
  const lines = content ? content.split(/\r?\n/) : []
  const rebuilt: string[] = []
  const seen = new Set<string>()
  for (let line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=') || trimmed.startsWith('=')) {
      rebuilt.push(line)
      continue
    }
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim()
    if (removed.has(key)) {
      seen.add(key)
      continue // drop the key line
    }
    if (key in existing) {
      const val = existing[key]
      if (val !== undefined && val !== '') {
        line = `${key}=${val}`
        rebuilt.push(line)
      } else {
        continue
      }
      seen.add(key)
      continue
    }
    rebuilt.push(line)
  }

  // Append keys that were not present yet.
  for (const [key, val] of Object.entries(existing)) {
    if (!seen.has(key) && val !== undefined && val !== '') {
      rebuilt.push(`${key}=${val}`)
    }
  }

  fs.writeFileSync(ENV_FILE, rebuilt.join('\n') + (rebuilt.length ? '\n' : ''))
  return applied
}

export function restartServer(): void {
  // Give the response time to flush before the process restarts (PM2/systemd
  // restart policies pick it back up).
  setTimeout(() => process.exit(0), 750)
}