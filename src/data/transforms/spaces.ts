/**
 * Template spaces, and which one a dataset's coordinates are in.
 *
 * A connectome's coordinates are only meaningful against the volume they were reconstructed
 * in. Two neurons from different datasets can have identical numbers and be nowhere near each
 * other, and nothing in a `SkeletonsValue` used to say so — which is why NBLAST across datasets
 * was recorded as meaningless rather than refused. This is the missing fact: geometry now
 * carries a `space`, exactly as it carries `units`, and both are absent-means-unknown.
 *
 * ## The table is generated, not typed
 *
 * Everything in `manifest.json` — the flip constants, the landmark counts, the column names,
 * the units per side — is written by `scripts/gen-transforms.py`, which reads it off
 * navis/flybrains. The flip constant especially: navis calls it `mirror_axis_size` and derives
 * it as `min + max` of the template's bounding box, which is *twice the midline* whatever the
 * name suggests. It is **not a free parameter** — each mirror landmark set was fitted against
 * exactly that pre-image, so a different number hands the spline coordinates it has never seen
 * and produces a plausible neuron in the wrong place. There is nowhere to type it wrong.
 *
 * **Imported statically, and that is forced.** `inferOutputs` and `validate` need to know
 * whether a space has a mirror before anything has run, and neither may fetch (invariant 2).
 * The manifest is ~5 kB of metadata; only the landmark CSVs are fetched, by `landmarks.ts`.
 */

import type { GeometryUnits, TemplateSpaceId } from '../../core/values'
import { backendOf } from '../source'
import manifest from './manifest.json'

/** What the landmark files' numbers are in. Everything is normalised to nm on load. */
export type SpaceUnits = 'nm' | 'um'

/** One landmark file, and how to read it. Shapes `manifest.json`'s two transform entries. */
export interface LandmarkSetSpec {
  /** Basename under `transforms/`. Also the fitted-transform cache key. */
  readonly file: string
  readonly landmarks: number
  readonly sourceColumns: readonly [string, string, string]
  readonly targetColumns: readonly [string, string, string]
  readonly sourceUnits: SpaceUnits
  readonly targetUnits: SpaceUnits
}

export interface MirrorSpec extends LandmarkSetSpec {
  readonly axis: 'x' | 'y' | 'z'
  /**
   * `c` in `x' = c - x`. navis' `mirror_axis_size`; twice the midline, in the space's own units.
   *
   * The affine half of a mirror. Coda applies this and the spline corrects what is left, which
   * is how navis splits it and how the landmark files were built.
   */
  readonly flipAt: number
  /** Which navis-flybrains file this is a copy of, for the credit. */
  readonly origin: string
}

export interface ToCommonSpec extends LandmarkSetSpec {
  /** How many landmarks came from each anatomical region. See `COMMON_SPACE`. */
  readonly regions: Readonly<Record<string, number>>
  /** Grid spacing the landmarks were sampled at, in nm. */
  readonly resolutionNm: number
}

export interface TemplateSpace {
  /** flybrains' template name, and Coda's space id. In every saved geometry value. */
  readonly id: string
  readonly label: string
  /** What coordinates in this space are in, as Coda holds them. Always `nm` today. */
  readonly units: SpaceUnits
  readonly mirror?: MirrorSpec
  readonly toCommon?: ToCommonSpec
}

/*
 * The one cast in this module, and the only place generated JSON becomes typed data.
 *
 * TypeScript reads `["x","y","z"]` in a JSON import as `string[]`, not as a 3-tuple, and the
 * tuple is worth keeping — `parseLandmarks` indexes 0..2 and a two-column entry would be a
 * silent `undefined` in a coordinate. Widening the interface to satisfy the import would move
 * the failure from the type system to a NaN in somebody's neuron. So the shape is asserted
 * once, at run time, by `transforms.test.ts`, which is also the only thing that can catch a
 * manifest regenerated against a changed script.
 */
const SPACES = manifest.spaces as unknown as readonly TemplateSpace[]

/**
 * The one space everything can be transformed into.
 *
 * **It is a brain template, and a nerve cord is *placed* into it rather than registered.** The
 * VNC half of every `toCommon` set goes to `JRCVNC2018U` — the honest target for a nerve cord —
 * and is then moved into this frame by a fixed affine lifted from navis-flybrains' own
 * notebook. That is a layout: it is what lets a brain and a nerve cord be drawn in one scene,
 * and it is *not* a claim that a VNC coordinate means anything anatomical in JRC2018U. A
 * combined `JRC2018Ucns` space will replace it.
 */
export const COMMON_SPACE = manifest.commonSpace as unknown as {
  readonly id: string
  readonly label: string
  readonly units: SpaceUnits
  readonly note: string
}

export function spaceById(id: string | undefined): TemplateSpace | undefined {
  return id ? SPACES.find((s) => s.id === id) : undefined
}

/** Every space Coda knows, in manifest order. */
export function allSpaces(): readonly TemplateSpace[] {
  return SPACES
}

/**
 * A space's prose name — `Hemibrain`, `FlyWire (FAFB v14.1)` — falling back to the id.
 *
 * For dropdowns and sentences, which have room for it. **Not** what a node footer shows:
 * `describeValue` prints the *id* through `core/values.ts`' `spaceLabel`, because the id is
 * what has to match for two sets to be comparable and "Hemibrain" cannot tell `JRCFIB2018F`
 * from `JRCFIB2018Fraw`. One name per meaning; these are two meanings.
 */
export function spaceName(id: string | undefined): string {
  if (!id) return 'an unknown space'
  // The hub is a space geometry can *be* in — anything through `neuron.xform` lands there — but
  // it is not one of `SPACES`, which is the list of spaces Coda has registrations *from*. So it
  // is resolved here and nowhere else: a footer reading `JRC2018U` where every other space
  // reads a name is the kind of gap that looks like a bug in the footer.
  if (id === COMMON_SPACE.id) return COMMON_SPACE.label
  return spaceById(id)?.label ?? id
}

// ---------------------------------------------------------------------------
// Which space a dataset is in
// ---------------------------------------------------------------------------

/**
 * A dataset id bound to the space its coordinates are in.
 *
 * `scope` is matched against `backendOf(sourceId)`, so `hemibrain` means the same volume on
 * whichever neuPrint deployment serves it — a neuPrint dataset id is a *name*, read off a
 * paper. `exactSource` pins the whole source id instead, for the backend where an id is a
 * *position*: a CATMAID project id is a bare integer whose meaning is per-instance, and `1` is
 * FAFB on Virtual Fly Brain and something else entirely on a lab server. That distinction is
 * `docs/datasets.md`'s, not a new one — the bare `catmaid` source *is* the VFB deployment, and
 * anything else registers as `catmaid:<url>`.
 *
 * Deliberately not on `DatasetFamily`. A family is a dataset Coda ships a *node* for, and the
 * space is a fact about coordinates that the sources — which cannot see the node layer — are
 * the ones to stamp.
 */
interface SpaceBinding {
  /** A key of `BACKENDS`, matched against `backendOf(sourceId)`. */
  readonly scope: string
  /** Full source id, matched instead of `scope`. For backends whose dataset ids are positional. */
  readonly exactSource?: string
  /** Family half of the dataset id — `male-cns` for `male-cns:v1.0`. */
  readonly dataset: string
  /** A key of `SPACES`. */
  readonly space: string
}

const BINDINGS: readonly SpaceBinding[] = [
  { scope: 'neuprint', dataset: 'hemibrain', space: 'JRCFIB2018F' },
  { scope: 'neuprint', dataset: 'male-cns', space: 'JRCFIB2022M' },
  { scope: 'neuprint', dataset: 'manc', space: 'MANC' },
  { scope: 'cave', dataset: 'flywire_fafb_public', space: 'FLYWIRE' },
  /*
   * Project 1 on Virtual Fly Brain, and *only* there. A lab CATMAID's project 1 is whatever
   * that lab numbered first, so this is pinned to the source rather than to the backend.
   */
  { scope: 'catmaid', exactSource: 'catmaid', dataset: '1', space: 'FAFB14' },
]

/**
 * The space a dataset's coordinates are in, or undefined where Coda cannot say.
 *
 * **Undefined is a real answer**, and a third thing from wrong: the optic lobe, FIB-19, the
 * mushroom body and the synthetic connectomes are each their own space with no registration
 * anywhere, and a Custom node can point at a deployment this build has never heard of. Callers
 * treat it the way `capabilityOf` treats an unknown source — no claim, no refusal.
 *
 * Called from source code that has already built the geometry, so it must not fetch and must
 * not throw.
 */
export function spaceForDataset(sourceId: string, datasetId: string): string | undefined {
  // Family half only: a version pins a reconstruction, not a coordinate frame. Split here
  // rather than through `splitDataset`, which lives in the node layer and imports this one.
  const at = datasetId.indexOf(':')
  const family = at === -1 ? datasetId : datasetId.slice(0, at)
  const backend = backendOf(sourceId)
  const hit = BINDINGS.find(
    (b) =>
      b.dataset === family &&
      (b.exactSource ? b.exactSource === sourceId : b.scope === backend),
  )
  return hit?.space
}

/**
 * The units and the template space of a piece of geometry, as one thing.
 *
 * Every source builds this rather than writing `units:` and `space:` separately, because
 * **a space is only claimable once the scale is known**. `JRCFIB2018F` is defined in
 * nanometres; the same hemibrain skeleton in raw 8 nm voxels is in `JRCFIB2018Fraw`, a frame
 * Coda has no landmarks for and does not model. A dataset whose voxel size could not be read
 * therefore returns `voxels` *and* no space, which is the honest pair — naming the space anyway
 * would let a mirror run on coordinates eight times too small and put the neuron somewhere
 * plausible and wrong.
 *
 * Both halves absent-means-unknown, and the object is built without the key rather than with an
 * explicit `undefined`: these values are structure-cloned into IndexedDB and compared by the
 * scheduler, and an absent key and a present-but-undefined one are not the same round trip.
 *
 * Callers pass the units they are *about to stamp*, not the ones the dataset usually has —
 * neuPrint's precomputed meshes are physical nanometres whatever `Meta` said, so one dataset
 * can honestly be in its template space for meshes and in unknown voxels for skeletons.
 */
export function geometryFrame(
  sourceId: string,
  datasetId: string,
  units: GeometryUnits,
): { units: GeometryUnits; space?: TemplateSpaceId } {
  if (units !== 'nm') return { units }
  const space = spaceForDataset(sourceId, datasetId)
  return space ? { units, space } : { units }
}

// ---------------------------------------------------------------------------
// What a space's landmarks actually span
// ---------------------------------------------------------------------------

/**
 * The region key a nerve cord's landmarks are counted under. Written once, here.
 *
 * `ToCommonSpec.regions` is **generated** — `gen-transforms.py` writes one count per region it
 * sampled — so the key is a fact about the manifest rather than about anatomy. Two readers had
 * the literal `'vnc'` open-coded (the Transform node's warning and the notebook exporter's
 * refusal), which means a regeneration that renamed it would change the two independently, and
 * the exporter's is the one guarding a cell that runs and returns coordinates 97 µm out.
 */
const VNC_REGION = 'vnc'

/** Which anatomical regions a space's landmarks span — `brain`, `vnc`, or both. */
export function regionsOf(spaceId: string | undefined): Set<string> {
  const regions = spaceById(spaceId)?.toCommon?.regions ?? {}
  return new Set(Object.keys(regions).filter((name) => (regions[name] ?? 0) > 0))
}

/**
 * Whether a space's landmarks include a nerve cord, and whether that is all of them.
 *
 * `wholly` separates the two cases that need different sentences: MANC is a nerve cord and
 * nothing else, where MaleCNS is both — and therefore also has a seam between them.
 */
export function nerveCordIn(spaceId: string | undefined): { any: boolean; wholly: boolean } {
  const regions = regionsOf(spaceId)
  return {
    any: regions.has(VNC_REGION),
    wholly: regions.has(VNC_REGION) && regions.size === 1,
  }
}
