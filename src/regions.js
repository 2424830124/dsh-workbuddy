/**
 * The two WorkBuddy deployments and the little that is shared about them.
 *
 * Login, catalog and billing live on the web host of each deployment; chat
 * lives wherever that deployment's model gateway answers. China's web host
 * refuses harness traffic on `/v2/chat/completions` ("Illegal API invocation
 * from an unapproved channel"), so its chat runs on the CodeBuddy China
 * gateway instead, with the web host kept as the fallback route.
 */

import { spawn } from 'node:child_process'

export const REGIONS = {
  intl: {
    id: 'intl',
    label: 'WorkBuddy 海外版',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    platform: 'workbuddy-ai',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    version: '5.5.2',
    provider: 'workbuddy-intl',
    displayName: 'WorkBuddy (Overseas)',
    tokenRef: 'WORKBUDDY_INTL_TOKEN',
    metaRef: 'WORKBUDDY_INTL_ACCOUNT',
    // This gateway validates the conversation before the model, so only a
    // well-formed request reaches the checks worth making — and against a usable
    // model that starts a completion. Probes here cost a token or two, hence a
    // daily automatic sweep at most (measured 2026-10-21, §4.9).
    freeProbe: false,
    autoProbeIntervalMs: 24 * 3600_000,
    // No per-model load endpoint here (`POST /v2/chat/busy` answers 404), so the
    // panel hides the busy column on this deployment.
    hasBusy: false
  },
  cn: {
    id: 'cn',
    label: 'WorkBuddy 大陆版',
    endpoint: 'https://www.workbuddy.cn',
    apiDomain: 'www.workbuddy.cn',
    chatEndpoint: 'https://copilot.tencent.com',
    chatApiDomain: 'copilot.tencent.com',
    platform: 'workbuddy',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
    version: '5.5.2',
    provider: 'workbuddy-cn',
    displayName: 'WorkBuddy (Mainland)',
    tokenRef: 'WORKBUDDY_CN_TOKEN',
    metaRef: 'WORKBUDDY_CN_ACCOUNT',
    // Resolves the model before it validates the conversation, so an empty
    // `messages` array is answered without ever starting a completion — which is
    // why this deployment may probe as often as the panel is opened.
    freeProbe: true,
    autoProbeIntervalMs: 10 * 60_000,
    // This is the deployment that publishes per-model load.
    hasBusy: true
  }
}

/**
 * Display order: the mainland deployment first, the overseas one second. This
 * drives every place the two are listed side by side — the tab strip and the
 * account table's columns.
 */
export const REGION_IDS = ['cn', 'intl']

function regionOf(id) {
  return REGIONS[String(id ?? '').toLowerCase()] ?? undefined
}

/** `''` / `all` / `both` select every deployment; anything else must name one. */
export function regionList(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value.length === 0 || value === 'all' || value === 'both') return REGION_IDS.map((id) => REGIONS[id])
  const region = regionOf(value)
  return region === undefined ? [] : [region]
}

/** Chat routes in preference order: the gateway first, the web host as fallback. */
export function chatRoutes(region) {
  const primary = {
    endpoint: region.chatEndpoint ?? region.endpoint,
    apiDomain: region.chatApiDomain ?? region.apiDomain,
    productCode: 'workbuddy',
    ideName: 'WorkBuddy',
    ideVersion: region.version,
    userAgent: region.userAgent
  }
  if (region.chatEndpoint === undefined || region.chatEndpoint === region.endpoint) return [primary]
  return [primary, {
    endpoint: region.endpoint,
    apiDomain: region.apiDomain,
    productCode: 'workbuddy',
    ideName: 'WorkBuddy',
    ideVersion: region.version,
    userAgent: region.userAgent
  }]
}

/**
 * Open a URL in the user's default browser.
 *
 * Windows needs the `cmd /c start "" "<url>"` form with
 * `windowsVerbatimArguments`: the login URL carries `&`, and an unquoted
 * argument list lets cmd.exe split it at the first `&` — the browser then
 * receives a truncated link and WorkBuddy answers "登录链接不完整". Quoting keeps
 * the whole query string inside one cmd token.
 *
 * Failure is not fatal: callers also surface the URL itself.
 */
export function openInBrowser(url) {
  if (process.platform === 'win32') {
    try {
      const child = spawn('cmd', ['/c', 'start', '""', `"${url}"`], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true
      })
      child.on('error', () => {})
      child.unref()
      return true
    } catch {
      return false
    }
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
