/**
 * The chain above Suggest Merges' `Tips` that the extend probes run a piece through.
 *
 * Shared by `probe-seam-extend.mjs` and `probe-seam-flake.mjs` so the two measure one chain: a
 * number from one is only comparable with a number from the other while this is the same graph.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { AEDES_DEPLOYMENT } from './browserProbe.mjs'

/**
 * Where the two probes keep the truth file and their records, and what the truth file is
 * called. One spelling: `probe-seam-flake.mjs` reads the file `probe-seam-extend.mjs` writes.
 */
export function extendWorkDir() {
  const dir = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-seam-extend')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function truthFileFor(neuron, t0, t1) {
  return join(extendWorkDir(), `truth-${neuron}-${Date.parse(t0)}-${Date.parse(t1)}.json`)
}

/**
 * The on-demand workflow's chain above Suggest Merges' `Tips`, with its own settings.
 *
 * Kept here as a document rather than read from a file: the probe measures *this* chain, and a
 * reader comparing two runs needs to see that it did not change.
 *
 * **Without the workflow's Sort and Sample, which the page does itself.** A rewound root has no
 * row in the nucleus table, so Find Open Ends cannot mask the cell body, and a start's best
 * `e_tip` ends are then the hairball around it. So the page drops tips near the nucleus (read
 * at `t1` by the truth script), and only then sorts on `e_tip` and keeps the first `--ends` —
 * the same two steps, in the place the mask has to come before.
 */
export function extendChain(firstId) {
  return {
    version: 1,
    nodes: [
      {
        id: 'ds',
        type: 'dataset.cave',
        position: { x: 0, y: 0 },
        params: {
          server: AEDES_DEPLOYMENT,
          datastack: 'wclee_aedes_brain',
          version: '',
          neuronTable: '',
          idColumn: 'pt_root_id',
          synapseTable: '',
          connectionView: '',
          refresh: 1,
          edgeSetId: '',
          edgeSetName: '',
        },
      },
      {
        id: 'ids',
        type: 'neuron.inputIds',
        position: { x: 0, y: 200 },
        params: { ids: firstId, column: 'neuronId' },
      },
      {
        id: 'meshes',
        type: 'neuron.meshes',
        position: { x: 300, y: 0 },
        params: { limit: 10000, carry: [], detail: '1500000', downsample: 1 },
      },
      {
        id: 'clean1',
        type: 'neuron.cleanMeshes',
        position: { x: 600, y: 0 },
        params: {
          dropInternals: false,
          openness: 0.05,
          rays: 8,
          passes: 3,
          fillHoles: false,
          ratio: 0.2,
          smooth: 10,
          method: 'taubin',
          volumeCorrection: false,
        },
      },
      {
        id: 'clean2',
        type: 'neuron.cleanMeshes',
        position: { x: 900, y: 0 },
        params: {
          dropInternals: true,
          openness: 0.05,
          rays: 16,
          passes: 3,
          fillHoles: false,
          ratio: 1,
          smooth: 0,
          method: 'taubin',
          volumeCorrection: false,
        },
      },
      {
        id: 'ends',
        type: 'seam:openEnds',
        position: { x: 1200, y: 0 },
        params: {
          model: 'E_oe3_all_s0',
          download: true,
          prune: 1,
          somaMask: 10,
          nucleusTable: 'nuclei_v1_aedes',
          kinks: false,
        },
      },
    ],
    edges: [
      ['ds', 'dataset', 'meshes', 'dataset'],
      ['ids', 'neurons', 'meshes', 'neurons'],
      ['meshes', 'meshes', 'clean1', 'in'],
      ['clean1', 'out', 'clean2', 'in'],
      ['clean2', 'out', 'ends', 'meshes'],
      ['ds', 'dataset', 'ends', 'dataset'],
    ].map(([source, sourceHandle, target, targetHandle], at) => ({
      id: `e${at}`,
      source,
      sourceHandle,
      target,
      targetHandle,
    })),
  }
}
