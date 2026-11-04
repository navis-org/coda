/**
 * The predicted clusters as a neuroglancer annotation layer.
 *
 * A **local** annotation layer — `local://annotations`, with the points inline — so nothing has to
 * be published, uploaded or served. That is the whole reason this display route is cheap, and it
 * is why the node emits `Layers` rather than growing a viewer of its own: the layer drops into the
 * Neuroglancer card's `Extra layers` socket beside the segmentation it is about, over the actual
 * EM, where a proofreader can already act on what they see.
 *
 * **The sampled points, not the skeleton nodes.** `labelSkeleton.ts` folds the answer back onto
 * every node, which is what the 3D view and the `cluster` node value draw; here the drawn points
 * are the honest thing to show, because they are what the model actually saw. A cloud of 338,087
 * annotations would also not draw.
 *
 * **Nanometres.** `outputDimensions` states the scale explicitly rather than hoping the viewer
 * infers it; the node refuses a skeleton in anything else (`skipReason`), so there is one unit
 * here and no conversion to get wrong.
 */

import { clusterColor } from '../../style/encoding'
import { clusterName } from './affinityTables'

/**
 * How many points one layer draws.
 *
 * Neuroglancer keeps local annotations in memory and re-uploads the buffer on each change, so a
 * scene of tens of thousands is a viewer that scrolls at a frame a second. Ten thousand is ten
 * neurons at the default `Points` — which is well past what anybody checks by eye in one frame —
 * and going over drops the tail rather than the layer, with the node saying so.
 */
export const MAX_ANNOTATIONS = 10_000

/** One neuron's drawn points, in the source's own coordinates. */
export interface ClusterPoints {
  readonly neuronId: string
  /** xyz interleaved, in nanometres — the *original* positions, not the scaled cloud. */
  readonly positions: Float32Array
  /** One per point; 0 is background. */
  readonly labels: Int32Array
}

/**
 * Gather one neuron's drawn points at their **original** coordinates.
 *
 * The scaled, centred cloud is what the encoder saw; neuroglancer has to be given where the
 * points actually are. `into` is this neuron's slice of a buffer the caller sized once — every
 * neuron contributes exactly `Points` points, so the total is known before the loop, and the
 * alternative is one array per neuron plus a concatenating copy of the whole cloud. A `subarray`
 * writes through, so taking the slice rather than a buffer and an offset costs nothing and
 * removes the arithmetic this function would otherwise have to get right.
 */
export function writeDrawnPositions(
  positions: Float32Array,
  sourceIndex: Int32Array,
  into: Float32Array,
): void {
  for (let i = 0; i < sourceIndex.length; i++) {
    const from = sourceIndex[i]! * 3
    into[i * 3] = positions[from]!
    into[i * 3 + 1] = positions[from + 1]!
    into[i * 3 + 2] = positions[from + 2]!
  }
}

export interface ClusterLayer {
  readonly layer: Readonly<Record<string, unknown>>
  /** How many points the layer holds. */
  readonly drawn: number
  /** How many points did not fit. Zero where everything was drawn. */
  readonly dropped: number
}

/** The layer, and how much of the answer it left out. */
export function clusterLayer(neurons: readonly ClusterPoints[], name: string): ClusterLayer {
  const annotations: Record<string, unknown>[] = []
  let dropped = 0
  for (const neuron of neurons) {
    // One colour and one caption per *distinct* label on this neuron. Both are constant across
    // the thousand points of a cluster, and the layer retains every string it is given.
    const said = new Map<number, { color: string; description: string }>()
    for (let i = 0; i < neuron.labels.length; i++) {
      if (annotations.length >= MAX_ANNOTATIONS) {
        dropped += neuron.labels.length - i
        break
      }
      const label = neuron.labels[i]!
      let say = said.get(label)
      if (!say) {
        say = {
          // `src/style/encoding.ts`' own rather than a second copy of it — the rule for
          // "cluster 0 is the residual, the rest cycle the categorical palette" is written once,
          // where the Dendrogram's cut already reads it. Note this does **not** make the layer
          // agree with the 3D view: a cluster reaches that view as a `nodeValues` float on a
          // continuous ramp, which is a different picture of the same answer.
          color: clusterColor(label, 'dark'),
          description: `${neuron.neuronId} · ${clusterName(label)}`,
        }
        said.set(label, say)
      }
      annotations.push({
        type: 'point',
        // Stable and unique: neuroglancer keys annotations by id, and two points sharing one
        // leave the second undrawn with nothing to say so.
        id: `${neuron.neuronId}-${i}`,
        point: [
          neuron.positions[i * 3]!,
          neuron.positions[i * 3 + 1]!,
          neuron.positions[i * 3 + 2]!,
        ],
        props: [say.color],
        description: say.description,
      })
    }
  }
  return {
    dropped,
    drawn: annotations.length,
    layer: {
      type: 'annotation',
      name,
      source: {
        url: 'local://annotations',
        transform: {
          // Written out rather than through `data/neuroglancer/scene.ts`' `nanometreDimensions`,
          // which takes a voxel-size triple and answers `undefined` for anything not finite and
          // positive — so reaching it from here costs a `!` on a call that cannot fail. The float
          // trap that helper exists for (`45 * 1e-9` serialising as 4.5000000000000006e-8) cannot
          // bite at a scale of exactly 1 nm.
          outputDimensions: { x: [1e-9, 'm'], y: [1e-9, 'm'], z: [1e-9, 'm'] },
        },
      },
      annotationProperties: [{ id: 'color', type: 'rgb', default: '#ffffff' }],
      // Without a shader every point draws in the layer's single colour: neuroglancer's default
      // annotation shader calls `defaultColor()` and never looks at the properties, so the whole
      // clustering would render as one uniform cloud with nothing wrong on screen to notice.
      shader: 'void main() { setColor(prop_color()); setPointMarkerSize(6.0); }',
      annotations,
    },
  }
}
