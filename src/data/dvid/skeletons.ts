/**
 * DVID skeletons: one SWC per body, in a keyvalue instance — **in voxels**.
 *
 * **Not yet reachable from the app**: nothing wires this up, because a DVID skeleton route needs
 * a port on `SkeletonSource` mirroring `MeshBodyReader`. See `docs/backends.md` § What is not
 * built.
 *
 * ## The unit split, which is the whole reason this file is careful
 *
 * DVID's skeletons are in **voxels** and its meshes are in **nanometres** — same body, same repo,
 * measured; `docs/backends.md` has the numbers. So the skeleton is scaled and the mesh is not,
 * and neither file may assume the other's rule. Left unscaled a DVID skeleton draws at 1/8 inside
 * the mesh it should thread, with a cable length 8× short — and nothing fails, which is what
 * makes this worth a paragraph rather than a line. `data/units.ts` is where
 * nanometres-as-the-one-space is argued; this is the second backend that needed it, which is why
 * that file moved out of `neuprint/`.
 *
 * The scale comes from the **segmentation** instance's `Extended.VoxelSize`, not from the
 * skeleton store — a keyvalue instance describes no geometry — so reading skeletons costs one
 * extra `info`, cached for the session by the source that asks.
 *
 * **A scale that cannot be read is a refusal, not an identity.** `voxelScale` answers undefined
 * when the units are missing or unrecognised, and that distinction is the reason it returns an
 * option: an identity scale would silently publish voxels as nanometres, and every consumer
 * whose answer depends on physical size — NBLAST above all — would score against a neuron eight
 * times too small, well inside the range its matrix finds plausible.
 *
 * ## Which instance, and why not a search
 *
 * `<segmentation>_skeletons`, neuroglancer's convention (`datasource/dvid/frontend.ts`), and
 * following it exactly is deliberate. On the public server `AL-VA1v` keeps skeletons in
 * `bodies121714_skeletons` while its segmentation is now called `segmentation`, so neuroglancer
 * itself shows none there — and Coda showing skeletons that neuroglancer says are absent is a
 * worse answer than matching it. The alternative is `/api/repos/info`, which lists every repo on
 * the host; see `refs.ts`.
 *
 * ## Two key spellings
 *
 * `<id>_swc` is neuroglancer's, and it is what this asks for first. `AL-VA1v` publishes both
 * `1010_swc` and `1010.swc` for all 192 of its bodies, byte-identical — so the fallback costs a
 * second request only for a body that has neither, and covers a store written by a tool that
 * chose the other spelling.
 */

import type { NeuronId } from '../../core/ids'
import type { SkeletonGeometry } from '../../core/values'
import { parseSwcText } from '../swc'
import type { VoxelScale } from '../units'
import { scalePositions, scaleRadii, voxelScale } from '../units'
import type { DvidOptions } from './client'
import { readInstanceInfo, readKey, requireInstance } from './client'
import type { DvidRef } from './refs'
import { instanceUrl, serverOf, skeletonInstance } from './refs'

/** neuroglancer's spelling first; see the header on why there is a second. */
const KEY_SUFFIXES: readonly string[] = ['_swc', '.swc']

/** Everything a skeleton read needs, resolved once per dataset rather than per neuron. */
export interface DvidSkeletonSource {
  /** URL of the `<segmentation>_skeletons` keyvalue instance. */
  base: string
  /** Dataset voxels to nanometres, from the *segmentation* instance. */
  scale: VoxelScale
  /**
   * The key spelling that last answered, so a store is only probed the long way once.
   *
   * Mutable, and session-scoped like the transport's route memory rather than stored anywhere.
   * Without it a store written with only `.swc` pays two round trips for **every** neuron
   * forever — 400 requests for a 200-neuron scene instead of 200, against somebody's server.
   */
  spelling?: string
}

/**
 * Resolve the skeleton store and its scale, or refuse saying which half is missing.
 *
 * Two `info` reads, both load-bearing and both at once: one says the store exists, the other says
 * what its coordinates mean. Failing to read the second is a refusal rather than a fallback to
 * 1 — see the header.
 */
export async function openDvidSkeletonSource(
  ref: DvidRef,
  options: DvidOptions = {},
): Promise<DvidSkeletonSource> {
  /*
   * Both probes at once. They are independent — one asks whether the store exists, the other
   * what its coordinates mean — and this sits at the front of "show me skeletons", so the serial
   * pair was a round trip of user-visible latency for nothing. `allSettled` rather than `all`,
   * because the two failures must still be reported in *this* order: `all` would surface
   * whichever rejected first and could replace "publishes no skeletons" with the segmentation's
   * error, leaving the loser unhandled.
   */
  const [store, segmentationInfo] = await Promise.allSettled([
    requireInstance(ref, skeletonInstance(ref), 'skeletons', options),
    readInstanceInfo(instanceUrl(ref, ref.instance), options),
  ])
  if (store.status === 'rejected') throw store.reason
  const base = store.value
  if (segmentationInfo.status === 'rejected') throw segmentationInfo.reason
  const extended = segmentationInfo.value?.Extended
  // DVID gives `VoxelUnits` per axis where neuPrint's `Meta` gives one string; the first is the
  // whole answer, since a scale with mixed units is not something either publisher produces.
  const scale = voxelScale(extended?.VoxelSize, extended?.VoxelUnits?.[0])
  if (!scale) {
    throw new Error(
      `${serverOf(base)} does not say what ${ref.instance}'s voxels measure, so its skeletons ` +
        `cannot be placed in nanometres. Drawing them unscaled would put them inside the meshes ` +
        `at a fraction of their size.`,
    )
  }
  return { base, scale }
}

/**
 * One body's skeleton in nanometres, or undefined when it has none.
 *
 * Absence is ordinary — a DVID skeleton store is usually a subset of the segmentation, 192
 * bodies of it on `AL-VA1v` — so a scene of two hundred neurons must not fail because one was
 * never traced.
 *
 * **Radii are scaled too, through `scaleRadii`.** That is `data/units.ts`' decision, not this
 * file's: it scales by the mean because every dataset in reach is isotropic, which makes the mean
 * exact, and `NeuPrintSource` already applies it to its own SWC. Leaving them in voxels here
 * would give one file format two treatments across two backends, and would quietly falsify the
 * header `exportValue.ts` writes onto every SWC it saves — `# Coordinates and radii are in
 * nanometres.`
 */
export async function readDvidSkeleton(
  source: DvidSkeletonSource,
  neuronId: NeuronId,
  options: DvidOptions = {},
): Promise<SkeletonGeometry | undefined> {
  // Whatever answered last first; see `DvidSkeletonSource.spelling`.
  const order = source.spelling
    ? [source.spelling, ...KEY_SUFFIXES.filter((s) => s !== source.spelling)]
    : KEY_SUFFIXES
  for (const suffix of order) {
    const bytes = await readKey(source.base, `${neuronId}${suffix}`, options)
    if (!bytes) continue
    source.spelling = suffix
    const skeleton = parseSwcText(neuronId, new TextDecoder().decode(bytes))
    return {
      ...skeleton,
      positions: scalePositions(skeleton.positions, source.scale),
      radii: scaleRadii(skeleton.radii, source.scale),
    }
  }
  return undefined
}
