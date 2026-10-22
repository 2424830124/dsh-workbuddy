/**
 * The one place that tells the harness its model list changed.
 *
 * The Web client's model directory caches the catalog and only re-reads it when
 * it hears a forwarded host event — `llm/adapters-updated` among them. Nothing
 * else re-lists on a timer, so a switch the user just flipped, an imported
 * account list, or a probe that retired a model stays invisible: the picker keeps
 * offering models the panel has already switched off.
 *
 * `llm/adapters-updated` is on the app's forwarded-event allowlist, and the
 * forwarding layer subscribes with a plain `ctx.on(event, …)`, so emitting the
 * event reaches both host listeners and every connected client. `ctx.emit` is the
 * route used here because the event name is a declared contract, unlike the
 * service's own `emitAdaptersUpdated()` helper (same dispatch, but absent from the
 * published `llm` contract) which stays as a fallback.
 *
 * Everything is duck-typed: a headless composition without either hook keeps
 * working with one fewer notification instead of failing to load.
 */

/**
 * @param {object} ctx - host plugin context.
 * @returns {boolean} whether a notification was delivered.
 */
export function notifyModelTopology(ctx) {
  const emit = () => {
    if (typeof ctx?.emit === 'function') {
      ctx.emit('llm/adapters-updated')
      return true
    }
    const llm = ctx?.llm ?? ctx?.get?.('llm')
    if (llm !== undefined && llm !== null && typeof llm.emitAdaptersUpdated === 'function') {
      llm.emitAdaptersUpdated()
      return true
    }
    return false
  }

  try {
    return emit()
  } catch (error) {
    ctx?.logger?.warn?.(`[workbuddy] 通知模型拓扑变化失败（不影响本次操作）：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
