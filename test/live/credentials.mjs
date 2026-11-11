/**
 * Where the probes get their tokens.
 *
 * The plugin stopped using the host's `.credentials.yaml` in 0.3.0: tokens live in its own
 * document, `$DSH_HOME/dsh-workbuddy/credentials.json`, written by the panel login. Every
 * probe here used to parse the YAML itself, so after that move they all read a file that no
 * longer holds their keys — they did not fail loudly, they just found no token.
 *
 * Import this instead of re-implementing the lookup: it goes through the plugin's own
 * `readCredential`, so a probe exercises the same path the plugin does and a future move of
 * the document breaks one file rather than forty-four.
 *
 *   import { tokenOf } from './credentials.mjs'
 *   const token = tokenOf('WORKBUDDY_CN_TOKEN')   // '' when absent, like readCredential
 */

import { readCredential } from '../../src/core/paths.js'

/** One credential value, or `''` when it is absent. */
export const tokenOf = (ref) => readCredential(ref)

/**
 * A stand-in for the host's credentials service.
 *
 * Several probes hand one to `fetchModelEntries` / `runSweep` / an adapter rather than
 * reading a token themselves; this keeps that shape while reading the plugin's document.
 */
export const credentialService = {
  resolve: async (ref) => {
    const value = readCredential(ref)
    return value.length === 0 ? undefined : { value, source: 'stored', writable: true }
  },
  set: async () => {}
}

/** The `ctx` a probe needs when it only reads credentials. */
export const silentCtx = () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: credentialService,
  get: () => undefined
})
