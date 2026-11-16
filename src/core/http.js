/**
 * Transport and envelope helpers shared by every WorkBuddy call.
 *
 * Both deployments answer with the same `{ code, msg, data }` envelope, and
 * errors carry a localized `displayMsg`; these helpers normalize that shape so
 * callers never guess between `msg` and `message`, or between `data` and
 * `data.data`. Nothing here knows about regions or credentials.
 */

const REQUEST_TIMEOUT_MS = 60_000
export const STATE_TIMEOUT_MS = 15_000

/**
 * JSON request that never throws for a non-JSON body: WorkBuddy answers errors
 * with a JSON envelope, but a proxy or captcha can still return HTML, and the
 * caller's status handling is what decides the outcome.
 */
export async function requestJson(method, url, headers, options = {}) {
  const signal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      signal,
      ...(options.body === undefined ? {} : { body: options.body })
    })
  } catch (error) {
    throw new Error(`${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

export function responseData(json) {
  if (typeof json !== 'object' || json === null) return undefined
  const data = json.data
  return typeof data === 'object' && data !== null ? data : undefined
}

/**
 * The envelope's business code, or `undefined` when there is no envelope at all.
 *
 * Returning 0 for an unparseable body made a timed-out or truncated 200 read as
 * success — the claim path then recorded a check-in that never happened. Callers that
 * act on the result compare against 0 explicitly, so `undefined` means "no answer".
 */
export function responseCode(json) {
  if (typeof json !== 'object' || json === null) return undefined
  return typeof json.code === 'number' ? json.code : undefined
}

export function responseMessage(json) {
  if (typeof json !== 'object' || json === null) return ''
  if (typeof json.message === 'string' && json.message.length > 0) return json.message
  if (typeof json.msg === 'string' && json.msg.length > 0) return json.msg
  const display = json.displayMsg
  if (typeof display === 'object' && display !== null && typeof display.zh === 'string') return display.zh
  return ''
}

export function readString(source, key) {
  const value = source?.[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Decode a JWT payload without verifying it — display metadata only. */
function decodeJwt(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload === 'object' && payload !== null ? payload : undefined
  } catch {
    return undefined
  }
}

export function tokenExpiryMs(token) {
  const payload = decodeJwt(token)
  return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined
}

export function tokenNickname(token) {
  const payload = decodeJwt(token)
  for (const key of ['nickname', 'preferred_username', 'name']) {
    const value = payload?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * Local calendar day, used as the bookkeeping key for the daily check-in. The
 * server is authoritative about whether a claim still counts; this only keys
 * the remembered outcome.
 */
export function localDayKey(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Milliseconds until the next local midnight. */
export function msUntilNextMidnight(now = new Date()) {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return next.getTime() - now.getTime()
}

/** `setTimeout` that never keeps the host process alive. */
export const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export function formatWhen(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '未知'
  return new Date(ms).toLocaleString()
}
