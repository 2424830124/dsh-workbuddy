/**
 * How loaded each model's backend is, from `POST /v2/chat/busy`.
 *
 * China answers `{data: [{model, busy_level}]}` with `idle` / `normal` / `busy` /
 * `congested`, and `unknown` for anything outside the active set — which is why
 * this is a *display* signal and never an availability verdict (a model can be
 * perfectly usable and still say `unknown`). The international deployment has no
 * such route at all (`404 Route Not Found`), so its map simply stays empty.
 *
 * The web client caches this for about a minute, and so does this module: the
 * panel asks whenever it opens, and the levels are shared between callers.
 */

import { freshToken } from '../account/auth.js'
import { requestJson } from '../core/http.js'
import { chatRoutes } from '../core/regions.js'

const BUSY_TTL_MS = 50_000
const BUSY_TIMEOUT_MS = 15_000

/** @type {Map<string, { at: number, levels: Map<string, string> }>} */
const cache = new Map()

/**
 * @returns {Promise<Map<string, string>>} model id → busy level (`''` when the
 * deployment has no such endpoint)
 */
export async function fetchBusyLevels(ctx, region, ids) {
  const cached = cache.get(region.id)
  if (cached !== undefined && Date.now() - cached.at < BUSY_TTL_MS) return cached.levels

  const token = await freshToken(ctx, region)
  if (token.length === 0) return new Map()
  const [route] = chatRoutes(region)
  const { status, json } = await requestJson('POST', `${route.endpoint}/v2/chat/busy`, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Domain': route.apiDomain,
    'X-Product': 'SaaS',
    'X-Product-Code': route.productCode,
    'User-Agent': route.userAgent
  }, { body: JSON.stringify({ models: ids }), timeoutMs: BUSY_TIMEOUT_MS })

  if (status !== 200 || !Array.isArray(json?.data)) {
    // Remember the miss briefly too, so a panel refresh does not retry a route
    // that does not exist on this deployment.
    cache.set(region.id, { at: Date.now(), levels: new Map() })
    return new Map()
  }

  const levels = new Map()
  for (const item of json.data) {
    if (typeof item?.model !== 'string' || typeof item?.busy_level !== 'string') continue
    levels.set(item.model, item.busy_level)
  }
  cache.set(region.id, { at: Date.now(), levels })
  return levels
}

/** Drop the cache, so a manual check sees fresh levels. */
export function invalidateBusy(regionId) {
  cache.delete(regionId)
}
