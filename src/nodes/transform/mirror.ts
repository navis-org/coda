/**
 * Mirror Neurons: put a neuron on the other side of the brain.
 *
 * The gesture this exists for is comparing left with right — a neuron and its contralateral
 * partner never overlap in a 3D view and never score against each other in NBLAST, because they
 * are on opposite sides of a midline, not because they are different shapes. Mirroring one of
 * them makes both questions answerable.
 *
 * ## It reads the space off the wire, and there is no Dataset socket
 *
 * A `SkeletonsValue` now says which template space its coordinates are in — `space`, beside
 * `units`, stamped by whichever source fetched it. So this node has one input. The alternative
 * was a second wire from the Dataset node, and the reason against it is not tidiness: nothing
 * would stop somebody wiring FlyWire skeletons into a Mirror pointed at a MaleCNS Dataset, and
 * the answer is a plausible-looking neuron a quarter of a millimetre from where it belongs with
 * nothing anywhere saying so. Read off the geometry, that is unrepresentable.
 *
 * The `Space` param is the escape hatch, not the normal route: it names a space for geometry
 * that arrived without one, which today means a Custom node pointed at a deployment this build
 * has never heard of. Empty means "whatever the data says", which is nearly always right.
 *
 * **It fills a gap; it does not overrule.** Set to something the geometry contradicts, this
 * refuses rather than obeying — because the realistic way that combination arises is a value
 * left over from an earlier experiment, and obeying it mirrors FlyWire neurons about MANC's
 * midline and puts them 654 µm from where they belong, looking entirely normal. Reinterpreting
 * coordinates as belonging to a different volume is a different operation from mirroring them,
 * and this node is not it.
 *
 * ## Two halves, and the switch between them
 *
 * A mirror is a flip and then a correction, which is how navis splits it and how the landmark
 * files were built.
 *
 * **The flip** is `x' = c - x` about the template's own midline, where `c` comes from
 * `data/transforms/manifest.json` — generated from the same bounding box `navis.mirror_brain`
 * reads, so it cannot drift from the landmark sets fitted against it. `scripts/check-mirror.py`
 * holds the two to exact agreement.
 *
 * **The correction** is a thin-plate spline through a few thousand landmark pairs, because an
 * insect brain is not symmetric: flipped and left there, a neuron sits about 7 µm from its
 * contralateral partner on FlyWire and 33 µm on MaleCNS. That is the residual `Warp` removes,
 * and it is roughly the width of a small neuropil — enough to make NBLAST score a homologue as
 * a stranger.
 *
 * `Warp` is on by default and off is a real answer, because off costs *nothing*: the flip is a
 * pass over a buffer, where the correction pulls in a ten-megabyte Python runtime on first use
 * and a landmark file per template. Somebody framing a picture may not want to pay that;
 * somebody about to NBLAST does.
 *
 * ## What it hands on
 *
 * The same kind it was given, in the same space, with the same ids — a mirrored neuron *is*
 * that neuron — plus a `mirrored` column on the attribute table. See `transformOps.ts` for why
 * that column rather than a decorated id, and for the mesh winding that has to be reversed with
 * the coordinates.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTransformValue } from '../../core/values'
import { allSpaces, spaceName } from '../../data/transforms/spaces'
import { loadLandmarks, mirrorFor } from '../../data/transforms/landmarks'
import {
  geometryNoun,
  geometryPointCount,
  isGeometryKind,
  isGeometryValue,
  mirrorGeometry,
  mirroredSchema,
  geometryTypeOf,
  schemaOfGeometry,
  warpGeometry,
} from '../lib/transformOps'
import { FROM_DATA, resolveSpace } from '../lib/spaceParam'

/**
 * Spaces with a midline to flip about — which is what this node's Space override may name.
 *
 * `neuron.xform`'s `bridgeableSpaces()`, the other way round, and the pair is the point: a
 * space's two halves are separately optional, so each node offers the half it can actually
 * perform. Every space ships both today except `AEDES`, which has a mirror and no bridge — so
 * this filter is inert now and stops being inert the first time the reverse arrives.
 */
function mirrorableSpaces() {
  return allSpaces().filter((space) => space.mirror)
}

export const mirrorNode = registerNode({
  type: 'neuron.mirror',
  label: 'Mirror Neurons',
  category: 'transform',
  description: 'Flip skeletons, meshes or points to the other side of the brain.',
  /*
   * Held under 400 characters because this node has a help document, and the overlay prints
   * this above it under a `TL;DR` label. Everything that used to be here and is not now — the
   * two halves, what the correction is worth, the Python download — is in that document.
   */
  guide:
    'Reflect neurons across the midline of the space they were fetched in, so a left neuron ' +
    'can be compared with a right one — by eye or by NBLAST, neither of which can see past ' +
    'the fact that the two are simply in different places. The space is read off the ' +
    'geometry, so there is nothing to configure.',
  /*
   * `expensive`, and it is the `Warp` default that decides it. Cost is a property of the node
   * rather than of a param, so it has to be true of the *default* path — which fetches a
   * landmark file and boots a Python runtime. Marking it cheap would fire that on every
   * keystroke anywhere in the graph (invariant 6). The consequence worth knowing is that with
   * Warp off this node still waits for Run, doing arithmetic it could have done instantly.
   */
  cost: 'expensive',
  /*
   * `any` in, `any` out, on `core.selectOne`'s reasoning: the type system cannot say "skeletons,
   * meshes or points", so the port says `any` and the refusal is a validation question. The
   * output type is the input type with one column added, so nothing downstream loses a picker.
   */
  inputs: [
    { id: 'in', label: 'Neurons', type: T.any() },
    /*
     * Landmarks of your own, in place of the ones Coda ships. **It replaces the spline only.**
     * The flip is `x' = c - x` and `c` is a property of the template rather than of the
     * landmarks, so this node still needs a resolvable space — which is also the contract the
     * landmark file itself is written against, its source side being already-flipped
     * coordinates. Supplying a warp for a space Coda cannot name is therefore not a thing this
     * port can do; `Transform Neurons` is where an unknown space has a route.
     */
    { id: 'warp', label: 'Warp', type: T.transform(), required: false },
  ],
  outputs: [{ id: 'out', label: 'Mirrored', type: T.any() }],
  params: [
    {
      id: 'warp',
      kind: 'boolean',
      label: 'Warp',
      default: true,
      help:
        'Correct for the brain’s left/right asymmetry with a landmark spline, rather than ' +
        'flipping and leaving it. Off is a few micrometres out — fine for a picture, not for ' +
        'NBLAST. On needs the Python runtime, which is a ~10 MB download the first time.',
    },
    {
      id: 'space',
      kind: 'enum',
      label: 'Space',
      default: '',
      options: [FROM_DATA, ...mirrorableSpaces().map((s) => ({ value: s.id, label: s.label }))],
      help:
        'Which template space to mirror in. Leave on “From the data” unless the geometry ' +
        'arrived without one — a Custom dataset node, usually — in which case naming it here ' +
        'is a claim you are making about coordinates nobody else can identify.',
    },
  ],

  /*
   * Kind and schema through, plus the column. It has to be computed here as well as in
   * `evaluate` — that is invariant 3, and `mirroredSchema`/`mirroredTable` are the pair that
   * keeps the two answers the same one.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!input || input.kind === 'any') return { out: T.any() }
    return { out: geometryTypeOf(input.kind, mirroredSchema(schemaOfGeometry(input))) }
  },

  validate: (ctx) => {
    const input = ctx.inputs.in
    if (!isGeometryKind(input?.kind)) {
      return ['Mirror takes skeletons, meshes or points — not a table.']
    }

    /*
     * A type carries no `space`; only a value does. So at edit time this can check the
     * *override* and nothing else — an unset override with an unresolved input is the ordinary
     * state, and a warning there would sit on every freshly-wired node. `evaluate` is where the
     * real answer arrives, and its message is the one that names what is missing.
     */
    /*
     * Asked as `mirrorFor` rather than `spaceById`: what this node needs is the *mirror* half,
     * and a space Coda knows with no midline registered is exactly as unusable here as a space
     * it has never heard of. The two used to be the same question because every space had
     * both halves; `evaluate` has always refused on this lookup, and now the card agrees.
     */
    const override = String(ctx.params.space ?? '')
    if (override && !mirrorFor(override)) {
      return [`Coda ships no mirror for “${override}”.`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const value = ctx.input('in')
    if (!isGeometryValue(value)) {
      throw new Error('Mirror takes skeletons, meshes or points.')
    }

    const { space: spaceId, conflict } = resolveSpace(
      String(ctx.params.space ?? ''),
      value.space,
    )
    if (conflict) {
      const [carried, override] = conflict
      throw new Error(
        `These coordinates are in ${spaceName(carried)} (${carried}), but Space is set to ` +
          `${spaceName(override)} (${override}). Mirroring about the wrong template’s midline ` +
          'moves neurons hundreds of micrometres and looks perfectly normal, so this refuses ' +
          'rather than picking one. Set Space back to “From the data”.',
      )
    }
    if (!spaceId) {
      /*
       * The commonest real failure, so it names the two ways out rather than stating the fact.
       * Geometry with no space is a dataset Coda has no registration for — the optic lobe, a
       * synthetic connectome, a Custom node — not a bug upstream.
       */
      throw new Error(
        'These coordinates do not say which template space they are in, so there is no ' +
          'midline to mirror about. Fetch them from a dataset Coda has a registration for, ' +
          'or name the space on this node if you know it.',
      )
    }

    /*
     * The flip constant comes from the shipped registration either way, because it is a
     * property of the *template* rather than of the landmarks — and a landmark file's source
     * side is already-flipped coordinates, so any file, ours or yours, was fitted against
     * exactly this number. A space with no entry has no constant to substitute, which is why a
     * supplied Warp cannot rescue an unknown space; `Transform Neurons` is the node for that.
     */
    const supplied = ctx.input('warp')
    const spec = mirrorFor(spaceId)
    if (!spec) {
      throw new Error(
        isTransformValue(supplied)
          ? `A supplied Warp replaces the correction, not the flip — and Coda has no midline ` +
              `for ${spaceName(spaceId)} (${spaceId}) to flip about. Transform Neurons is the ` +
              'node for a space this build does not know.'
          : `Coda ships no mirror landmarks for ${spaceName(spaceId)} (${spaceId}), and there ` +
              'is no route to one that works in a browser.',
      )
    }

    const count = value.kind === 'points' ? geometryPointCount(value) : value.items.length
    ctx.progress(0.05, `${count.toLocaleString()} ${geometryNoun(value)} · ${spaceId}`)

    // The flip first, always: it is what the landmark file's *source* side is in, so the
    // spline's input is the flipped coordinate rather than the original one. Getting that
    // order wrong produces a neuron on the correct side of the brain and the wrong shape.
    const flipped = mirrorGeometry(value, spec, spaceId)
    if (ctx.params.warp === false) return { out: flipped }

    // Yours if wired, ours otherwise — the only difference between the two paths, and the
    // reason they are one path.
    const pairs = isTransformValue(supplied) ? supplied : await loadLandmarks(spec)
    return {
      out: await warpGeometry(flipped, [pairs], {
        progress: (fraction, note) => ctx.progress(0.1 + 0.9 * fraction, note),
        signal: ctx.signal,
        warn: ctx,
      }),
    }
  },
})
