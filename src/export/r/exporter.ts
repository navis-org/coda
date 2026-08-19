/**
 * The R Markdown exporter.
 *
 * Importing this registers every R emitter and helper. Loaded on demand from
 * `ui/export.ts` — same doctrine as the notebook exporter, and for the same measured reason:
 * this is inert string-building that only runs when somebody asks for a document.
 */

import './helpers'
import './emitters/analysis'
import './emitters/connectivity'
import './emitters/query'
import './emitters/table'
import './emitters/viewers'

export { exportRmd } from './emit'
export type { ExportOptions, ExportResult } from './emit'
