/**
 * The Python/notebook exporter.
 *
 * Importing this module registers every emitter and helper, exactly as `src/nodes/index.ts`
 * registers every node. Keep the imports explicit so the bundle stays analysable, and note
 * that nothing here is reachable from `src/core` or `src/data` — the exporter reads the
 * graph, never the other way round.
 */

import './helpers'
import './emitters/analysis'
import './emitters/connectivity'
import './emitters/explore'
import './emitters/profile'
import './emitters/query'
import './emitters/table'
import './emitters/viewers'

export { exportNotebook } from './emit'
export type { ExportOptions, ExportResult } from './emit'
export { serializeNotebook } from './notebook'
export type { Notebook } from './notebook'
