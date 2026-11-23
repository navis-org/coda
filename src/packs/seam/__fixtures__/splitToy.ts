/**
 * A toy neuron for the split gallery's tests (`splitGallery.test.ts`, `ui/seam/splitSession.test.ts`).
 */
import type { SupervoxelGraph } from '../../../data/cave/subgraph'
import type { Triple } from '../../../data/precomputed/volume'
import type { SplitGalleryInput } from '../splitGallery'
import type { BoxableLayout } from '../../../data/cave/graphLayout'
import { cellAt } from '../../../data/cave/graphLayout'
import { nodeId } from '../../../test/chunkedgraphIds'
import type { SplitNeuron } from '../splitGalleryRun'

/**
 * A toy neuron: chains of level-2 chunks, each chunk four supervoxels joined strongly, each chunk
 * joined strongly to the next. Chunk `A3` is chain A's fourth, at x = 3 µm; chain B runs beside A
 * at y = 0.5 µm; chain C, where present, beside A on the other side.
 */
export interface Toy {
  readonly chains: Readonly<Record<string, { readonly length: number; readonly y: number }>>
  /** Extra supervoxel edges, `[chunkA, chunkB, mean affinity]`, between the chunks' first supervoxels. */
  readonly contacts?: ReadonlyArray<readonly [string, string, number]>
  /** Extra level-2 links (to join pieces outside the box). */
  readonly links?: ReadonlyArray<readonly [string, string]>
  /** Chunk indices (along x) inside the wide box, and inside the click's box. */
  readonly wide: readonly [number, number]
  readonly inner: readonly [number, number]
  readonly click: Triple
  /** Supervoxels per chunk (default 4). */
  readonly svs?: number
  /** Edges inside a chunk to weaken, `[chunk, i, mean]`: the edge from supervoxel `i - 1` to `i`. */
  readonly inside?: ReadonlyArray<readonly [string, number, number]>
}

export function toy(spec: Toy): SplitGalleryInput {
  const perChunk = spec.svs ?? 4
  const rows: Array<[string, string, number, number]> = []
  const chunks: string[] = []
  const links: Array<readonly [string, string]> = []
  const positions = new Map<string, Triple>()
  const sv = (chunk: string, i: number) => `${chunk}.${i}`
  for (const [name, { length, y }] of Object.entries(spec.chains)) {
    for (let k = 0; k < length; k++) {
      const chunk = `${name}${k}`
      chunks.push(chunk)
      positions.set(chunk, [k * 1000, y * 1000, 0])
      for (let i = 1; i < perChunk; i++) {
        const weak = spec.inside?.find(([c, at]) => c === chunk && at === i)
        rows.push([sv(chunk, i - 1), sv(chunk, i), weak ? weak[2] : 0.9, 100])
      }
      if (k > 0) {
        rows.push([sv(`${name}${k - 1}`, perChunk - 1), sv(chunk, 0), 0.8, 100])
        links.push([`${name}${k - 1}`, chunk])
      }
    }
  }
  for (const [x, y, mean] of spec.contacts ?? []) {
    rows.push([sv(x, 0), sv(y, 0), mean, 100])
    links.push([x, y])
  }
  links.push(...(spec.links ?? []))
  const indexOf = (chunk: string) => Number(chunk.slice(1))
  const inRange = (chunk: string, [lo, hi]: readonly [number, number]) =>
    indexOf(chunk) >= lo && indexOf(chunk) <= hi
  const members = new Map<string, string[]>()
  for (const chunk of chunks) {
    if (inRange(chunk, spec.wide))
      members.set(
        chunk,
        Array.from({ length: perChunk }, (_, i) => sv(chunk, i)),
      )
  }
  // `subgraph` keeps only edges with both ends in the box.
  const inBox = (id: string) => members.has(id.split('.')[0]!)
  const kept = rows.filter(([a, b]) => inBox(a) && inBox(b))
  const wide: SupervoxelGraph = {
    a: kept.map((r) => r[0]),
    b: kept.map((r) => r[1]),
    affinity: Float64Array.from(kept, (r) => r[2] * r[3]),
    area: Float64Array.from(kept, (r) => r[3]),
  }
  return {
    wide,
    members,
    inner: new Set(chunks.filter((c) => inRange(c, spec.inner))),
    chunks,
    links,
    positions,
    click: spec.click,
  }
}

/** Two neurons side by side, joined by one weak contact at A2–B2; the click beside it. */
export const TWO_NEURONS: Toy = {
  chains: { A: { length: 6, y: 0 }, B: { length: 6, y: 0.5 } },
  contacts: [['A2', 'B2', 0.1]],
  wide: [1, 4],
  inner: [2, 3],
  click: [2000, 250, 0],
}

/**
 * Two longer chains, each with a weak join inside chunks 1–4: thirteen splits near the click, so
 * more than one gallery set (6 + 6 + 1) — Regenerate's.
 */
export const MANY_SPLITS: Toy = {
  ...TWO_NEURONS,
  chains: { A: { length: 8, y: 0 }, B: { length: 8, y: 0.5 } },
  wide: [0, 7],
  inner: [1, 6],
  svs: 24,
  inside: ['A', 'B'].flatMap((chain) =>
    [1, 2, 3, 4].map((k) => [`${chain}${k}`, 12, 0.05] as const),
  ),
}

/** FANC's chunk grid: 512 × 512 × 128 voxels of 4.3 × 4.3 × 45 nm. */
export const FANC_LAYOUT: BoxableLayout = {
  baseMip: 0,
  layerBits: 8,
  bitsPerAxis: new Map(),
  baseResolutionNm: [4.3, 4.3, 45],
  chunkSize: [512, 512, 128],
  voxelOffset: [0, 0, 0],
}

/** The neuron a toy's box belongs to, as `readSplitNeuron` would answer. */
export function toyNeuron(input: SplitGalleryInput, root: string): SplitNeuron {
  return {
    root,
    chunks: input.chunks,
    links: input.links,
    positions: input.positions,
    // Each chunk in the cell of FANC's grid its point is in, as the session places vertices.
    cells: new Map(
      input.chunks.map((chunk) => {
        const at = input.positions.get(chunk)!
        const cell: Triple = [
          cellAt(FANC_LAYOUT, at[0], 0),
          cellAt(FANC_LAYOUT, at[1], 1),
          cellAt(FANC_LAYOUT, at[2], 2),
        ]
        return [chunk, cell]
      }),
    ),
  }
}

/**
 * The toy with every supervoxel renamed to a chunkedgraph id, as a write needs: `confirmSplit`
 * refuses anything else. Each is a layer-1 id in its chunk's place — chain `A`, `B`, … along y,
 * the chunk's index along x — with the supervoxel's index as its counter (`nodeId`). Chunk names
 * and the level-2 links are left as they are: only supervoxels are sent.
 */
export function withNodeIds(input: SplitGalleryInput): SplitGalleryInput {
  const id = (sv: string) => {
    const [chunk, i] = sv.split('.') as [string, string]
    const at = [Number(chunk.slice(1)), chunk.charCodeAt(0) - 65, 0]
    return nodeId(1, at, Number(i) + 1).toString()
  }
  return {
    ...input,
    wide: { ...input.wide, a: input.wide.a.map(id), b: input.wide.b.map(id) },
    members: new Map([...input.members].map(([chunk, svs]) => [chunk, svs.map(id)])),
  }
}
