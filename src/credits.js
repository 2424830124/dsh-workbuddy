/**
 * Credits and the daily check-in.
 *
 * WorkBuddy meters usage through `/v2/billing/meter/*`, all reachable with the
 * plugin access token:
 *
 *   POST /v2/billing/meter/get-user-resource  → the credit packages of an account
 *   POST /v2/billing/meter/checkin-status     → activity + today's check-in state
 *   POST /v2/billing/meter/daily-checkin      → claim today's credits
 *
 * `daily-checkin` is idempotent server-side: claiming twice answers
 * `code 10001` ("今天已签到，请明天再来"), which is why the automatic claim can
 * safely run on every start and again at midnight without tracking local state
 * as the source of truth.
 *
 * The international deployment has no check-in endpoint (its backend does not
 * ship one), so claiming is marked unsupported there while the balance still
 * works.
 */

import { readMeta, readToken } from './auth.js'
import { localDayKey, requestJson, responseCode, responseMessage } from './http.js'
import { REGIONS } from './regions.js'

const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'
const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-status'
const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'
/** Meter calls are small and fast; a shorter ceiling than the default. */
const METER_TIMEOUT_MS = 30_000

/** Server codes: 10001/1001 already claimed, 1002/1003 no qualification. */
const CODE_ALREADY_CLAIMED = new Set([10001, 1001])
const CODE_INACTIVE = new Set([1002, 1003])

/** The international backend ships no check-in endpoint at all. */
const CHECKIN_SUPPORTED = { intl: false, cn: true }

function creditHeaders(token, region) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Domain': region.apiDomain,
    'X-Product': 'SaaS',
    'X-Product-Code': 'workbuddy',
    'User-Agent': region.userAgent
  }
}

async function postMeter(ctx, region, path) {
  const token = await readToken(ctx, region)
  if (token.length === 0) return { ok: false, reason: '未登录' }
  const { status, json } = await requestJson('POST', `${region.endpoint}${path}`, creditHeaders(token, region), {
    body: '{}',
    timeoutMs: METER_TIMEOUT_MS
  })
  if (status !== 200) {
    const message = responseMessage(json)
    return { ok: false, reason: message.length > 0 ? message : `HTTP ${status}`, code: responseCode(json) }
  }
  if (responseCode(json) !== 0) {
    return { ok: false, reason: responseMessage(json) || `code ${responseCode(json)}`, code: responseCode(json) }
  }
  return { ok: true, data: json?.data }
}

function preciseNumber(source, key) {
  const precise = source?.[`${key}Precise`]
  if (typeof precise === 'string') {
    const parsed = Number.parseFloat(precise)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof precise === 'number' && Number.isFinite(precise)) return precise
  const raw = source?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

function stringField(source, key) {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

/** One package is active unless it is expired or its deduction window is over. */
function packageActive(entry, now) {
  if (entry?.Status === 3) return false
  const expired = Date.parse(stringField(entry, 'ExpiredTime').replace(' ', 'T'))
  if (Number.isFinite(expired) && now >= expired) return false
  const deductionEnd = typeof entry?.DeductionEndTime === 'number' ? entry.DeductionEndTime : 0
  if (deductionEnd > 0 && now >= deductionEnd) return false
  return true
}

function attributeOf(entry, key) {
  const attributes = entry?.AccountAttributes
  if (!Array.isArray(attributes)) return ''
  for (const attribute of attributes) {
    if (attribute?.Key === key && typeof attribute.Value === 'string') return attribute.Value
    if (attribute?.Key === key && typeof attribute.Value === 'number') return String(attribute.Value)
  }
  return ''
}

const round = (value) => Math.round(value * 100) / 100

/**
 * Read one account's credit packages.
 *
 * `total` counts only what is still usable; `daily` isolates the packages the
 * daily check-in granted, which is what the panel shows next to the account.
 * The server tags those with `grantSource: daily_checkin` (observed live on
 * the China deployment), so any `daily…` source counts.
 */
export async function fetchCredits(ctx, region) {
  const result = await postMeter(ctx, region, USER_RESOURCE_PATH)
  if (!result.ok) return { supported: true, ok: false, reason: result.reason }
  const accounts = result.data?.Response?.Data?.Accounts
  if (!Array.isArray(accounts)) return { supported: true, ok: false, reason: '余额响应无法解析' }
  const now = Date.now()
  const packages = []
  let total = 0
  let daily = 0
  for (const entry of accounts) {
    if (typeof entry !== 'object' || entry === null) continue
    const active = packageActive(entry, now)
    // A remaining balance of 0 is a real value: a spent package must not fall through
    // to a second field (or read as a missing one) and make the account look funded.
    const cycleRemain = preciseNumber(entry, 'CycleCapacityRemain')
    const remaining = cycleRemain ?? preciseNumber(entry, 'CapacityRemain') ?? 0
    const grantedBy = attributeOf(entry, 'grantSource')
    if (!active) continue
    total += remaining
    if (grantedBy.startsWith('daily')) daily += remaining
    packages.push({
      name: stringField(entry, 'PackageName') || stringField(entry, 'SubProductName') || stringField(entry, 'PackageCode'),
      unit: stringField(entry, 'CapacityUnit') || stringField(entry, 'OriginUnit') || 'credits',
      remaining,
      size: preciseNumber(entry, 'CycleCapacitySize') || preciseNumber(entry, 'CapacitySize'),
      grantedBy,
      expiresAt: stringField(entry, 'CycleEndTime')
    })
  }
  return { supported: true, ok: true, total: round(total), daily: round(daily), packages }
}

/** Today's check-in state; `supported: false` on the international deployment. */
export async function fetchCheckinStatus(ctx, region) {
  if (CHECKIN_SUPPORTED[region.id] !== true) return { supported: false }
  const result = await postMeter(ctx, region, CHECKIN_STATUS_PATH)
  if (!result.ok) return { supported: true, ok: false, reason: result.reason }
  const data = result.data ?? {}
  return {
    supported: true,
    ok: true,
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: typeof data.streak_days === 'number' ? data.streak_days : 0,
    dailyCredit: typeof data.daily_credit === 'number' ? data.daily_credit : 0,
    todayCredit: typeof data.today_credit === 'number' ? data.today_credit : 0,
    weekProgress: Array.isArray(data.week_progress) ? data.week_progress.filter((day) => typeof day === 'boolean') : [],
    activityName: stringField(data, 'activity_name'),
    weekCheckinDays: typeof data.week_checkin_days === 'number' ? data.week_checkin_days : 0
  }
}

/**
 * Claim today's credits. Never throws: a spent claim is reported, not raised.
 * @returns {{ claimed: boolean, already?: boolean, inactive?: boolean, credit?: number, streakDays?: number, reason?: string }}
 */
export async function claimDailyCheckin(ctx, region) {
  if (CHECKIN_SUPPORTED[region.id] !== true) return { claimed: false, reason: '该部署没有签到接口' }
  const token = await readToken(ctx, region)
  if (token.length === 0) return { claimed: false, reason: '未登录' }
  const { status, json } = await requestJson('POST', `${region.endpoint}${DAILY_CHECKIN_PATH}`, creditHeaders(token, region), {
    body: '{}',
    timeoutMs: METER_TIMEOUT_MS
  })
  const code = responseCode(json)
  if (CODE_ALREADY_CLAIMED.has(code)) return { claimed: false, already: true, reason: responseMessage(json) || '今天已签到' }
  if (CODE_INACTIVE.has(code)) return { claimed: false, inactive: true, reason: responseMessage(json) || '当前没有可领取的活动' }
  if (status !== 200 || code !== 0) {
    return { claimed: false, reason: responseMessage(json) || `HTTP ${status}` }
  }
  const data = json?.data ?? {}
  return {
    claimed: true,
    credit: typeof data.credit === 'number' ? data.credit : 0,
    streakDays: typeof data.streak_days === 'number' ? data.streak_days : 0,
    isStreakDay: data.is_streak_day === true
  }
}

async function rememberClaim(ctx, region, outcome) {
  try {
    const meta = await readMeta(ctx, region)
    if (meta === undefined) return
    await ctx.credentials.set(region.metaRef, JSON.stringify({
      ...meta,
      checkin: { day: localDayKey(), at: Date.now(), ...outcome }
    }))
  } catch {
    // bookkeeping only — never let it break the claim path
  }
}

/**
 * Run one automatic claim pass over both deployments, remembering the outcome
 * on each account so the panel can show when it last ran.
 */
export async function runAutoClaim(ctx, reason) {
  const outcomes = []
  for (const id of Object.keys(REGIONS)) {
    const region = REGIONS[id]
    if (CHECKIN_SUPPORTED[region.id] !== true) continue
    try {
      const outcome = await claimDailyCheckin(ctx, region)
      await rememberClaim(ctx, region, { reason, ...outcome })
      if (outcome.claimed) {
        ctx.logger.info(`[workbuddy] ${region.id}: 自动签到成功，获得 ${outcome.credit ?? 0} 积分（${reason}）`)
      } else if (outcome.already !== true && outcome.reason !== '未登录') {
        ctx.logger.warn(`[workbuddy] ${region.id}: 自动签到未完成 — ${outcome.reason}`)
      }
      outcomes.push({ region: region.id, ...outcome })
    } catch (error) {
      ctx.logger.warn(`[workbuddy] ${region.id}: 自动签到异常 — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return outcomes
}
