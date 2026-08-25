/**
 * Transform Neurons: move geometry into the one space everything shares.
 *
 * `Mirror Neurons` compares two neurons from the *same* brain. This is the other half — the one
 * that lets neurons from *different* brains be compared at all. A hemibrain skeleton and a
 * FlyWire skeleton are two reconstructions of the same anatomy in two unrelated coordinate
 * systems, hundreds of micrometres apart and differently scaled; drawn together they are two
 * clouds in different corners of the scene, and NBLAST scores them as strangers. Both sides
 * through here first, and the question becomes answerable.
 *
 * ## One edge per dataset, and no path finding
 *
 * Every space Coda knows has exactly one registration, into `JRC2018U` — the unisex template
 * that navis and the natverse both treat as the meeting point. That is a **star**, not a graph:
 * `toCommonFor` is a lookup, there is nothing to search, and a space with no entry has no route
 * rather than a longer one.
 *
 * An arbitrary space-to-space transform therefore needs **no path finding either**: it is out
 * through the hub and back, always exactly two hops, from two lookups. The return leg is the
 * target's own registration fitted backwards (`invertPairs`) — a refit rather than an
 * inversion, since a thin-plate spline has no closed form for one.
 *
 * ## Two hops cost about what one does, twice
 *
 * Worth stating because the intuition says otherwise — composing transforms sounds like it
 * should compound. Measured against `navis.xform_brain`, median error, restricted to the region
 * the target space actually covers:
 *
 * | | two hops | the two one-hops added |
 * | --- | --- | --- |
 * | hemibrain → FlyWire | 1.33 µm | 1.61 µm |
 * | FlyWire → hemibrain | 1.87 µm | 1.61 µm |
 *
 * About the sum, and on the first pair slightly *under* it — two splines' errors are as likely
 * to cancel as to add. So the return leg is not a reason to avoid a dataset-space target.
 *
 * **What does degrade an answer is asking for coordinates in a space that does not cover the
 * neuron**, and that is a fact about the target rather than about the route. The hemibrain is
 * roughly one hemisphere: 60% of a FlyWire neuron falls outside it, and out there a hemibrain
 * coordinate is not defined for Coda or for navis — navis' own deformation field warns on the
 * same region. Unrestricted, that pair reads 5.8 µm, essentially all of it from the 60%.
 *
 * Deliberate, and the alternative was considered rather than skipped. navis carries a real
 * bridging graph and will happily route through four intermediate templates; most of those
 * edges are CMTK and H5 registration files, which are native libraries and gigabytes of data
 * and do not exist in a browser. What is left after that filter is a handful of landmark sets —
 * from which the *useful* answer is one hop each, generated offline by `gen-transforms.py`
 * against the full navis stack. Somebody who needs the exhaustive version has navis.
 *
 * The cost is stated rather than hidden: a shortcut through landmarks is about **a micron** off
 * the long route. Measured per space on 3,000 shell vertices, against `navis.xform_brain`:
 * median 0.54–0.87 µm, p95 1.8–4.4 µm. On a 250 µm brain, and against the several micrometres
 * of biological variation between two animals, that is not the limiting error.
 *
 * ## Mirror first, then transform
 *
 * The two nodes compose in one order and not the other, and it is worth saying because both
 * orders run. Mirroring in a dataset's own space uses landmarks fitted for *that* brain's
 * asymmetry; mirroring after transforming would be a flip in `JRC2018U` with no correction
 * available. (A flip there is at least geometrically sound — the template is symmetric by
 * construction, and the placed nerve cord's midline lands within 10 nm of the brain's, which
 * was checked rather than assumed. It is simply less accurate than doing it upstream.)
 *
 * ## The nerve cord is placed, not registered
 *
 * `JRC2018U` is a **brain** template; there is no nerve cord in it. A VNC is registered to
 * `JRCVNC2018U`, which is the honest target for one, and then moved into the brain's frame by a
 * fixed affine — so a brain and a nerve cord can be drawn in one scene. That is a layout. A VNC
 * coordinate in this space does not mean anything anatomical, and `validate` says so on any
 * dataset with a nerve cord in it rather than leaving it to the docs.
 *
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTransformValue } from '../../core/values'
import {
  COMMON_SPACE,
  allSpaces,
  nerveCordIn,
  regionsOf,
  spaceName,
} from '../../data/transforms/spaces'
import { invertPairs, loadLandmarks, toCommonFor } from '../../data/transforms/landmarks'
import {
  geometryNoun,
  geometryPointCount,
  isGeometryKind,
  isGeometryValue,
  geometryTypeOf,
  schemaOfGeometry,
  warpGeometry,
} from '../lib/transformOps'
import { FROM_DATA, resolveSpace } from '../lib/spaceParam'

/** Spaces with a route into the hub — which is what this node's Space override may name. */
function bridgeableSpaces() {
  return allSpaces().filter((space) => space.toCommon)
}

export const xformNode = registerNode({
  type: 'neuron.xform',
  label: 'Transform Neurons',
  category: 'transform',
  description: `Move skeletons, meshes or points into ${COMMON_SPACE.id}, the shared template space.`,
  /*
   * Under 400 characters: this node has a help document and the overlay prints the guide above
   * it under a `TL;DR` label. The accuracy numbers, the placed nerve cord and the ordering rule
   * are all in that document.
   */
  guide:
    'Put neurons from different brains into one coordinate system, so they can be drawn ' +
    'together or compared by NBLAST — neither of which works while two reconstructions sit in ' +
    'unrelated spaces. One landmark transform per dataset, straight into JRC2018U. Mirror ' +
    'before transforming, not after.',
  /*
   * `expensive` for the reason the Mirror node is: this fetches a landmark file and runs a
   * spline in a Python runtime that is a ten megabyte download on first use. There is no cheap
   * path here at all — unlike a mirror, a bridge is *only* a spline.
   */
  cost: 'expensive',
  // `any` in, `any` out, on `core.selectOne`'s reasoning: the type system cannot say "skeletons,
  // meshes or points", so the port says `any` and the refusal is a validation question.
  inputs: [
    { id: 'in', label: 'Neurons', type: T.any() },
    /*
     * A registration this build does not ship. Wired, it **replaces the route entirely** —
     * Target and Space are ignored, because a supplied transform already says what it maps and
     * a node that combined the two would be composing a hop the user did not ask for. See
     * `core.landmarkTransform`.
     */
    { id: 'transform', label: 'Transform', type: T.transform(), required: false },
  ],
  outputs: [{ id: 'out', label: 'Transformed', type: T.any() }],
  params: [
    {
      id: 'target',
      kind: 'enum',
      label: 'Target',
      default: COMMON_SPACE.id,
      options: [
        { value: COMMON_SPACE.id, label: `${COMMON_SPACE.label} (shared)` },
        ...bridgeableSpaces().map((s) => ({ value: s.id, label: s.label })),
      ],
      help:
        'Where to transform into. The shared template is one hop; another dataset’s space goes ' +
        'out through it and back, which costs a second fit in time but little in accuracy. ' +
        'What does cost accuracy is a target that does not cover the neuron — the hemibrain is ' +
        'one hemisphere, so most of a whole-brain neuron has no coordinate there at all.',
    },
    {
      id: 'space',
      kind: 'enum',
      label: 'Space',
      default: '',
      options: [FROM_DATA, ...bridgeableSpaces().map((s) => ({ value: s.id, label: s.label }))],
      help:
        'Which space the geometry is coming *from*. Leave on “From the data” unless it ' +
        'arrived without one — a Custom dataset node, usually — in which case naming it here ' +
        'is a claim you are making about coordinates nobody else can identify.',
    },
  ],

  /*
   * Kind and schema straight through: a bridge moves coordinates and touches no column. That is
   * the one visible difference from the Mirror node, which adds `mirrored` — and it is why this
   * has no schema pair in `transformOps.ts` to keep in step.
   */
  inferOutputs: (ctx) => ({
    out: geometryTypeOf(ctx.inputs.in?.kind, schemaOfGeometry(ctx.inputs.in)),
  }),

  validate: (ctx) => {
    const input = ctx.inputs.in
    if (!isGeometryKind(input?.kind)) {
      return ['Transform takes skeletons, meshes or points — not a table.']
    }

    /*
     * A wired transform answers every question this node would otherwise ask, so none of the
     * checks below apply — they are all about a route that is no longer being taken. Said
     * plainly rather than left as silence, because two controls that stop working when a wire
     * is plugged in is exactly the thing somebody needs told.
     */
    if (ctx.inputs.transform) {
      return ['Using the wired Transform; Target and Space are ignored.']
    }

    /*
     * A type carries no `space`; only a value does. So edit time can check the *override* and
     * nothing else — an unset override on an unresolved input is the ordinary state, and a
     * warning there would sit on every freshly wired node. `evaluate` has the real answer.
     */
    /*
     * There is deliberately **no warning about picking a dataset space as the Target.** There
     * was one, and it was wrong: it said a second hop costs accuracy, where the measurement
     * says two hops cost about what the two one-hops cost added, sometimes less. See the header.
     */
    const target = String(ctx.params.target ?? COMMON_SPACE.id)

    const override = String(ctx.params.space ?? '')
    if (!override) return []
    if (!toCommonFor(override)) {
      return [`Coda ships no route from “${override}” into ${COMMON_SPACE.id}.`]
    }
    if (override === target) {
      return [`Source and Target are both ${override} — there is nothing to do.`]
    }

    /*
     * Two spaces that describe different parts of the animal. Knowable from the manifest alone,
     * and the one thing about a dataset-to-dataset target worth saying in advance — a nerve cord
     * has no coordinate anywhere in a brain-only volume, so the result is the spline's affine
     * extrapolation throughout rather than a transform of anything.
     */
    if (target !== COMMON_SPACE.id) {
      const from = regionsOf(override)
      const to = regionsOf(target)
      const shared = [...from].filter((region) => to.has(region))
      if (from.size > 0 && to.size > 0 && shared.length === 0) {
        return [
          `${spaceName(override)} covers ${[...from].join(' and ')} where ` +
            `${spaceName(target)} covers ${[...to].join(' and ')}. There is no shared ` +
            'territory, so every point would be extrapolated rather than transformed.',
        ]
      }
      // Beyond that there is nothing to say in advance: the placement below is a fact about
      // the hub, and a round trip through it puts the nerve cord back where it started.
      return []
    }

    /*
     * A warning rather than a refusal, and it is the honest one: the answer is usable, it is
     * just not the kind of answer the space's name implies. Said on the card because a reader
     * comparing a descending neuron's arbor across datasets needs to know which half of it is
     * registered and which half is merely placed.
     */
    const vnc = nerveCordIn(override)
    if (vnc.wholly) {
      return [
        `${COMMON_SPACE.id} is a brain template. A nerve cord is registered to JRCVNC2018U and ` +
          'then placed beside the brain by a fixed affine — good for drawing, not a claim ' +
          'about anatomy.',
      ]
    }
    if (vnc.any) {
      return [
        `${COMMON_SPACE.id} is a brain template, so the nerve cord half of this dataset is ` +
          'placed rather than registered. The two halves reach the frame by different routes ' +
          'and disagree slightly where they meet, around the neck.',
      ]
    }
    return []
  },

  evaluate: async (ctx) => {
    const value = ctx.input('in')
    if (!isGeometryValue(value)) {
      throw new Error('Transform takes skeletons, meshes or points.')
    }

    /*
     * The supplied route, which short-circuits everything below. Nothing here consults the
     * space the geometry claims: a custom transform is somebody asserting what these
     * coordinates are and where they go, and second-guessing it would refuse the case the port
     * exists for — a volume Coda ships no binding for at all.
     */
    const supplied = ctx.input('transform')
    if (isTransformValue(supplied)) {
      ctx.progress(0.05, `${supplied.count.toLocaleString()} landmarks`)
      return {
        // `null` where the author did not say where it lands: these coordinates have left the
        // space they were in, so clearing is the honest answer.
        out: await warpGeometry(value, [supplied], {
          progress: (fraction, note) => ctx.progress(0.1 + 0.9 * fraction, note),
          signal: ctx.signal,
          warn: ctx,
          space: supplied.targetSpace ?? null,
        }),
      }
    }

    const { space: spaceId, conflict } = resolveSpace(String(ctx.params.space ?? ''), value.space)
    if (conflict) {
      const [carried, override] = conflict
      throw new Error(
        `These coordinates are in ${spaceName(carried)} (${carried}), but Space is set to ` +
          `${spaceName(override)} (${override}). Transforming from the wrong space produces ` +
          'neurons that look reasonable and are in the wrong place, so this refuses rather ' +
          'than picking one. Set Space back to “From the data”.',
      )
    }
    if (!spaceId) {
      throw new Error(
        'These coordinates do not say which template space they are in, so there is nothing ' +
          `to transform them from. Fetch them from a dataset Coda has a registration for, or ` +
          'name the space on this node if you know it.',
      )
    }

    const target = String(ctx.params.target ?? COMMON_SPACE.id)

    if (spaceId === target) {
      /*
       * Refused rather than passed through. A no-op that reports success is how a chain comes
       * to contain two of these — one doing the work and one doing nothing — with the card
       * giving no hint which. The message says the transform already happened.
       */
      throw new Error(
        `These coordinates are already in ${spaceName(target)} (${target}). Remove this node, ` +
          'or move it upstream of whatever put them there.',
      )
    }

    const outbound = toCommonFor(spaceId)
    if (!outbound) {
      throw new Error(
        `Coda ships no route from ${spaceName(spaceId)} (${spaceId}) into ${COMMON_SPACE.id}. ` +
          'The registrations that would build one are native libraries, so there is no route ' +
          'to it that works in a browser.',
      )
    }
    /*
     * The return leg, where there is one: the *target's* own registration, fitted backwards.
     * `spaceId === COMMON_SPACE.id` is the case of coming *from* the hub, which needs only this
     * leg — nothing produces such geometry today except this node, so it is reachable only by
     * chaining two of them, and it costs nothing to answer correctly.
     */
    const inbound = target === COMMON_SPACE.id ? undefined : toCommonFor(target)
    if (target !== COMMON_SPACE.id && !inbound) {
      throw new Error(
        `Coda ships no route from ${COMMON_SPACE.id} into ${spaceName(target)} (${target}).`,
      )
    }

    const count = value.kind === 'points' ? geometryPointCount(value) : value.items.length
    ctx.progress(0.05, `${count.toLocaleString()} ${geometryNoun(value)} · ${spaceId} → ${target}`)

    /*
     * Both files requested together rather than the return leg waiting on the outbound *warp*
     * — the two fetches are independent, and serialised the second one's round trip sat behind
     * a fit that the module docstring measures in seconds. `loadLandmarks` is memoised by
     * promise, so asking twice for one file cannot fetch it twice.
     *
     * The inbound leg is its own registration fitted backwards: a spline has no closed-form
     * inverse, so `invertPairs` swaps the pairs and the fit is redone in the other direction.
     */
    const legs = [outbound, ...(inbound ? [inbound] : [])]
    const pairs = await Promise.all(
      legs.map(async (leg, index) => {
        const loaded = await loadLandmarks(leg)
        return index === 0 ? loaded : invertPairs(loaded)
      }),
    )

    /*
     * The space is restamped, and this is the node that makes the field earn its keep: from
     * here on the value says where it is, so a second Transform refuses, a Mirror looks for the
     * right landmarks, and NBLAST can tell that both its inputs are finally comparable. The
     * units do not move — `landmarks.ts` normalises the hub's micrometres to nanometres on
     * load, which is exact for a 3-D spline.
     */
    return {
      out: await warpGeometry(value, pairs, {
        progress: (fraction, note) => ctx.progress(0.1 + 0.9 * fraction, note),
        signal: ctx.signal,
        warn: ctx,
        space: target,
      }),
    }
  },
})
