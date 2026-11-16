/**
 * The one place that tells the harness its model list changed.
 *
 * The Web client's model directory caches the catalog and only re-reads it when
 * it hears a forwarded host event — `llm/adapters-updated` among them. Its
 * declared contract says exactly what this needs: a payload-free notification
 * after which "consumers re-read `listProviders()`, `listModels()`, or
 * `listConfigurableProviders()` for the new state". Nothing else re-lists on a
 * timer, so a switch the user just flipped, an imported account list, or a probe
 * that retired a model stays invisible: the picker keeps offering models the panel
 * has already switched off.
 *
 * `llm/adapters-updated` is on the app's forwarded-event allowlist and the
 * forwarding layer subscribes with a plain `ctx.on(event, …)`, so emitting it
 * reaches host listeners and every connected client. `ctx.emit` is preferred
 * because the event name is a declared contract; the `llm` service's own
 * `emitAdaptersUpdated()` (same dispatch, absent from the published contract) is
 * the fallback.
 *
 * Everything is duck-typed, and the outcome is logged: when neither channel
 * exists the panel still works, and the log says so instead of leaving a silent
 * "the picker didn't refresh" mystery.
 */

/**
 * @param {object} ctx - host plugin context.
 * @returns {boolean} whether a notification was delivered.
 */
export function notifyModelTopology(ctx) {
  let route = 'none'
  let delivered = false
  try {
    if (typeof ctx?.emit === 'function') {
      ctx.emit('llm/adapters-updated')
      route = 'ctx.emit'
      delivered = true
    } else {
      const llm = ctx?.llm ?? ctx?.get?.('llm')
      if (llm !== undefined && llm !== null && typeof llm.emitAdaptersUpdated === 'function') {
        llm.emitAdaptersUpdated()
        route = 'llm.emitAdaptersUpdated'
        delivered = true
      }
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[workbuddy] 通知模型拓扑变化失败（不影响本次操作）：${error instanceof Error ? error.message : String(error)}`)
    return false
  }

  ctx?.logger?.info?.(
    delivered
      ? `[workbuddy] 已通知模型拓扑变化（${route}）`
      : '[workbuddy] 无法通知模型拓扑变化：当前上下文既没有 ctx.emit 也没有 llm.emitAdaptersUpdated，模型选择器要等它自己重读才会更新'
  )
  return delivered
}
