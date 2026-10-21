/**
 * The canvas half of the CATMAID export probe. **Skipped unless `CATMAID_LIVE=1`.**
 *
 *     pnpm probe:catmaid
 *
 * Runs `catmaidGraph` against Virtual Fly Brain's two public instances through a real Scheduler,
 * writes every node's outputs to `<dir>/canvas.json`, and writes the notebook and the R Markdown
 * exported from the same graph beside it. `scripts/probe-catmaid-export.py` and
 * `scripts/probe-catmaid-export.R` then execute those documents and compare each cell's result
 * with what the canvas produced.
 *
 * It exists for the rule `out.topology` records in `coverage.test.ts`: an emitter has to be
 * checked by *running* it against the node. The goldens say the text is unchanged and
 * `check-export.py` that its names resolve; neither executes a line of `CodaCatmaidDataset`, and
 * every rule in it — the meta-annotated type, the per-pair weight floor, which end a synapse's
 * confidence is read from — is one that produces a plausible wrong table rather than an error.
 *
 * Out of CI for `src/data/catmaid/live.test.ts`' reason: it is somebody's public server. It only
 * reads.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it } from 'vitest'

import '../nodes'
import { Scheduler } from '../core/scheduler'
import type { TableValue, Value } from '../core/values'
import { boundsOf, getRow } from '../core/values'
import { registerBuiltinSources } from '../data/builtins'
import { requireSource } from '../data/source'
import { catmaidGraph } from './fixture'
import { exportNotebook, serializeNotebook } from './python/exporter'
import { exportRmd } from './r/exporter'

const LIVE = process.env.CATMAID_LIVE === '1'
const OUT = process.env.CATMAID_PROBE_OUT ?? '/tmp/coda-catmaid-probe'

/** A value as plain JSON: rows for anything tabular, a summary for geometry. */
function plain(value: Value | undefined): unknown {
  if (value === undefined) return null
  switch (value.kind) {
    case 'table':
    case 'neurons':
      return { kind: 'table', rows: rowsOf(value) }
    case 'matrix':
      return {
        kind: 'matrix',
        rowLabels: value.rowLabels,
        colLabels: value.colLabels,
        values: [...value.values],
      }
    case 'points': {
      const rows = rowsOf(value.attributes)
      rows.forEach((row, i) => {
        row.x = value.positions[i * 3]
        row.y = value.positions[i * 3 + 1]
        row.z = value.positions[i * 3 + 2]
      })
      return { kind: 'points', rows }
    }
    case 'skeletons':
      return {
        kind: 'skeletons',
        attributes: rowsOf(value.attributes),
        items: value.items.map((item) => ({
          id: item.id,
          nodes: item.parents.length,
          soma: item.compartments ? [...item.compartments].filter((c) => c === 1).length : 0,
        })),
      }
    case 'meshes':
      return {
        kind: 'meshes',
        // Faces and bounds rather than vertices: the canvas keeps a vertex per triangle corner
        // where pymaid and rcatmaid share them, so the counts differ for the same surface.
        items: value.items.map((item) => ({
          id: item.id,
          faces: item.indices.length / 3,
          bounds: boundsOf([item.positions]),
        })),
      }
    default:
      return { kind: value.kind }
  }
}

function rowsOf(table: TableValue): Array<Record<string, unknown>> {
  return Array.from({ length: table.length }, (_, i) => getRow(table, i))
}

describe.skipIf(!LIVE)('CATMAID export probe, against VFB', () => {
  it('writes the canvas outputs and both exported documents', async () => {
    registerBuiltinSources()
    const graph = catmaidGraph({ withLab: false })
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(graph, { mode: 'full' })

    const canvas: Record<string, unknown> = {}
    for (const node of graph.nodes) {
      const info = sched.info(node.id)
      const outputs: Record<string, unknown> = {}
      for (const [port, value] of Object.entries(sched.outputs(node.id) ?? {})) {
        outputs[port] = plain(value as Value)
      }
      canvas[node.id] = { type: node.type, state: info.state, error: info.error, outputs }
    }

    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'canvas.json'), JSON.stringify(canvas, null, 1))
    const notebook = exportNotebook(graph)
    if (!notebook.ok) throw new Error(`notebook refused: ${notebook.reason}`)
    writeFileSync(join(OUT, 'catmaid.ipynb'), serializeNotebook(notebook.notebook))
    const rmd = exportRmd(graph)
    if (!rmd.ok) throw new Error(`R Markdown refused: ${rmd.reason}`)
    writeFileSync(join(OUT, 'catmaid.Rmd'), rmd.source)
  }, 600_000)
})
