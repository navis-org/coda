/**
 * The split session's reads, faked over a toy neuron (`packs/seam/__fixtures__/splitToy.ts`), for
 * the session's and the gallery's tests. Nothing here reaches a server.
 */
import { vi } from 'vitest'

import {
  FANC_LAYOUT,
  toy,
  toyNeuron,
  TWO_NEURONS,
} from '../../../packs/seam/__fixtures__/splitToy'
import type { PlacedLabels } from '../../../packs/seam/splitColours'
import type { SplitServices } from '../splitSession'

/** Two neurons, past `MIN_PIECE` (20) supervoxels a chunk — the size the session's walk asks for. */
export const SPLIT_INPUT = toy({ ...TWO_NEURONS, svs: 24 })
export const SPLIT_ROOT = '720575940000000001'

/** Spies over the toy's box and neuron on FANC's grid; the mesh is a single vertex. */
export function toyServices() {
  return {
    chunkedgraph: vi.fn(() =>
      Promise.resolve({
        graphene: { server: 's', table: 't', base: 's/t' },
        layout: FANC_LAYOUT,
        base: 'gs://toy',
      }),
    ),
    neuron: vi.fn(() => Promise.resolve(toyNeuron(SPLIT_INPUT, SPLIT_ROOT))),
    box: vi.fn(() => Promise.resolve(SPLIT_INPUT)),
    mesh: vi.fn(() =>
      Promise.resolve({ positions: new Float32Array([0, 0, 0]), indices: new Uint32Array() }),
    ),
    // No segmentation: every vertex keeps its chunk's colour.
    labels: vi.fn(() =>
      Promise.resolve<PlacedLabels>({
        box: {
          labels: new BigUint64Array(0),
          index: new Uint16Array(0),
          size: [0, 0, 0] as const,
        },
        lo: [0, 0, 0] as const,
        resolution: [32, 32, 45] as const,
      }),
    ),
    // The box holds every chunk the toy has near the click: nothing outside it to ask about.
    chunkSupervoxels: vi.fn(() => Promise.resolve(new Map<string, string[]>())),
    pause: () => Promise.resolve(),
    now: () => 0,
  } satisfies SplitServices
}

/** Until the session's promises have settled. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
