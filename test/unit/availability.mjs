/**
 * Unit check for the availability ledger: classification of every probe answer
 * the two gateways are known to produce, the dead-within-TTL rule, and the
 * append-by-id merge.
 *
 * Run: `node test/unit/availability.mjs`
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-availability-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { AVAILABILITY_TTL_MS, availabilitySummary, classifyProbe, deadModelIds, probeBody, probeModel, readAvailability, runSweep, writeAvailability } = await import('../../src/catalog/availability.js')
const { REGIONS, chatRoutes } = await import('../../src/core/regions.js')

// A deployment is probed with **its own** credential and route, never the other
// one's: an overseas model asked with a mainland token would answer nonsense.
// `fetch` is stubbed here to capture exactly what leaves the process.
const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), authorization: init?.headers?.Authorization ?? '', body: init?.body })
  return {
    status: 400,
    text: async () => '{"code":11133,"msg":"the request parameters were rejected by the model provider"}'
  }
}
// Credentials come from the plugin's own document now (src/paths.js).
const { setCredential } = await import('../../src/core/paths.js')
setCredential(REGIONS.cn.tokenRef, `token-for-${REGIONS.cn.tokenRef}`)
setCredential(REGIONS.intl.tokenRef, `token-for-${REGIONS.intl.tokenRef}`)

const probeCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => undefined }
}
await probeModel(probeCtx, REGIONS.cn, 'hy3')
await probeModel(probeCtx, REGIONS.intl, 'hy3')
globalThis.fetch = realFetch

const [cnCall, intlCall] = calls
assert.equal(cnCall.url, `${chatRoutes(REGIONS.cn)[0].endpoint}/v2/chat/completions`, 'the mainland probe goes to the mainland chat route')
assert.equal(cnCall.authorization, `Bearer token-for-${REGIONS.cn.tokenRef}`, 'the mainland probe uses the mainland token')
assert.deepEqual(JSON.parse(cnCall.body).messages, [], 'and the free mainland shape')
assert.equal(intlCall.url, `${chatRoutes(REGIONS.intl)[0].endpoint}/v2/chat/completions`, 'the overseas probe goes to the overseas chat route')
assert.equal(intlCall.authorization, `Bearer token-for-${REGIONS.intl.tokenRef}`, 'the overseas probe uses the overseas token')
assert.notEqual(cnCall.url, intlCall.url, 'the two deployments do not share a route')
assert.equal(probeBody(REGIONS.intl, 'hy3').messages[0].role, 'system', 'the overseas shape opens with a system message')

// Verdicts, taken from real gateway answers (see docs/workbuddy-protocol.md §6
// and §4.9). The probe sends an invalid request on purpose, so a healthy model
// answers a 4xx rather than `200`: reaching the parameter layer is itself the
// proof that the model id is routed. `11102` is the only "gone" answer.
assert.equal(classifyProbe(400, '{"code":11102,"msg":"model [glm-4.6] service info not found"}').state, 'dead')
assert.match(classifyProbe(400, '{"code":11102,"msg":"model [glm-4.6] service info not found"}').detail, /11102/)
// The same code also carries a permission answer: China replies this way for an
// id that exists but is gated (`gpt-5.3-codex`).
assert.equal(classifyProbe(400, '{"code":11102,"msg":"model [gpt-5.3-codex] is only available for authorized users"}').state, 'denied')
assert.equal(classifyProbe(400, '{"code":11158,"msg":"model [x] is not allowed for user type [personal_free_user]"}').state, 'denied')
assert.equal(classifyProbe(400, '{"code":11133,"msg":"the request parameters were rejected by the model provider"}').state, 'ok', 'params rejected means the model exists')
assert.equal(classifyProbe(400, '{"code":11133,"msg":"Invalid request parameters"}').state, 'ok', 'the short wording of the same verdict')
assert.equal(classifyProbe(400, '{"code":11151,"msg":"a message has empty content, please check the conversation history"}').state, 'ok', 'hy3/hy3-x validate the conversation before the provider does')
assert.equal(classifyProbe(200, 'data: {"code":0,"choices":[]}').state, 'ok')
assert.equal(classifyProbe(400, '{"code":9999,"msg":"模型配置异常，请切换其他模型"}').state, 'ok', 'any other 4xx still proves the model is routed')
assert.match(classifyProbe(400, '{"code":9999,"msg":"模型配置异常，请切换其他模型"}').detail, /模型配置异常/)
assert.equal(classifyProbe(429, '{"code":6020,"msg":"queue.waiting.title","data":{"queue_position":1144}}').state, 'busy')

// The other two 429s are not "busy" — they are "you cannot call this right now", and the
// panel groups them with the unusable models instead of leaving them under 可用 with a grey
// chip. Measured on 2026-10-24 with an empty overseas balance and a used-up mainland window.
assert.equal(
  classifyProbe(429, '{"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the link below to purchase add-on packs"}}}').state,
  'noquota',
  'an empty balance reads as no credits, not as a throttled model'
)
assert.match(classifyProbe(429, '{"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}').detail, /积分已用尽/)
assert.equal(
  classifyProbe(429, '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-24 09:54:53 UTC+8 重置"}').state,
  'throttled'
)
assert.equal(classifyProbe(429, '{"code":429,"msg":"usage exceeds frequency limit"}').state, 'throttled')
// Busy without a queue, and a bare 429 with no window wording at all: neither states a rate
// window, so neither may claim one (measured 2026-10-25 — the model-busy text used to be
// reported as an account rate window).
assert.equal(classifyProbe(429, '{"code":429,"msg":"模型繁忙，请换模型或稍后重试 too many requests"}').state, 'busy', 'plain model-busy wording is transient')
// A bare 429 with no window wording reaches the parameter layer, which *proves the model is
// routed* — the same "any other 4xx" rule as above — so it reads ok rather than claiming a
// window the body never stated.
assert.equal(classifyProbe(429, '{"code":429,"msg":"too many requests"}').state, 'ok', 'a bare 429 proves nothing about a window, only that the model exists')
assert.notEqual(classifyProbe(429, '{"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}').state, 'busy', 'exhausted is never queued')
assert.equal(classifyProbe(400, '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}').state, 'blocked')
assert.equal(classifyProbe(401, 'nope').state, 'auth')
assert.equal(classifyProbe(502, '<html>502</html>').state, 'down')
assert.equal(classifyProbe(0, '').state, 'error', 'a transport failure is not a verdict about the model')

// Only `dead` counts as delisted; queueing and provider hiccups are not verdicts about
// the model (they no longer *hide* one — the switch decides that — but they still group).
assert.deepEqual(deadModelIds('cn'), new Set(), 'nothing is dead before the first sweep')

writeAvailability('cn', [
  { id: 'glm-4.6', state: 'dead', detail: '模型不存在', at: Date.now() },
  { id: 'hy3', state: 'ok', detail: '', at: Date.now() },
  { id: 'step-5-preview', state: 'busy', detail: '排队', at: Date.now() },
  { id: 'glm-5.1', state: 'rejected', detail: '参数被拒', at: Date.now() }
])
assert.deepEqual([...deadModelIds('cn')], ['glm-4.6'], 'only the dead verdict counts as delisted')

const ledger = readAvailability('cn')
assert.equal(ledger.models.size, 4)
assert.equal(ledger.models.get('hy3').state, 'ok')

// A fresh verdict for the same id replaces the old one, others are kept.
writeAvailability('cn', [{ id: 'glm-4.6', state: 'ok', detail: '', at: Date.now() }])
assert.equal(readAvailability('cn').models.get('glm-4.6').state, 'ok', 'a fresh verdict wins')
assert.equal(readAvailability('cn').models.size, 4, 'other verdicts stay')

// An old `dead` verdict ages out, so a model is advertised again and re-probed.
writeAvailability('cn', [{ id: 'glm-4.7', state: 'dead', detail: '模型不存在', at: Date.now() - AVAILABILITY_TTL_MS - 1000 }])
assert.ok(!deadModelIds('cn').has('glm-4.7'), 'a verdict past its TTL is no longer delisted')
assert.equal(readAvailability('cn').models.get('glm-4.7').state, 'dead', 'the stale verdict is still shown')

const summary = availabilitySummary('cn')
assert.equal(summary.total, 5)
assert.deepEqual(summary.counts, { ok: 2, busy: 1, rejected: 1, dead: 1 })
assert.ok(summary.models.every((entry) => typeof entry.id === 'string'))

// Deployments keep separate ledgers.
assert.equal(readAvailability('intl').models.size, 0)
writeAvailability('intl', [{ id: 'gpt-5.6-sol', state: 'ok', detail: '', at: Date.now() }])
assert.equal(readAvailability('intl').models.size, 1)
assert.equal(readAvailability('cn').models.size, 5, 'ledgers are per deployment')

// Verdicts belong to an account: another account must not inherit "denied", and its
// own probe results start a fresh ledger.
writeAvailability('acct', [{ id: 'hy3', state: 'denied', detail: '账号无权限', at: Date.now() }], 'account-a')
assert.equal(readAvailability('acct', 'account-a').models.size, 1, 'the owning account sees its verdicts')
assert.equal(readAvailability('acct', 'account-b').models.size, 0, 'another account starts empty')
writeAvailability('acct', [{ id: 'glm-5.2', state: 'ok', detail: '', at: Date.now() }], 'account-b')
assert.equal(readAvailability('acct', 'account-b').models.size, 1, 'the new account only has its own probe')
assert.ok(!readAvailability('acct', 'account-b').models.has('hy3'), 'the previous account denial is gone')

console.log('availability.mjs: OK — probe classification, dead-in-TTL rule, merge, per-deployment ledgers, and per-account verdicts verified')
