/**
 * Landmark Transform: somebody else's registration, as a value on a wire.
 *
 * The extension point for everything `data/transforms` does not ship. Coda carries direct
 * mirrors and one bridge per dataset, generated offline against the full navis stack — which
 * covers the published fly connectomes and nothing else. A lab with its own volume, a template
 * Coda has never heard of, a registration that flybrains re-fitted last week: all of them are a
 * **table of six columns**, and the two nodes that already read tables from anywhere —
 * `Upload Table` and `Table from URL` — are the way in.
 *
 * So this node is deliberately small. It does not fetch, it does not fit, and it does not know
 * about template spaces. It reads six columns, converts them to nanometres, and hands out a
 * `TransformValue` that `Transform Neurons` and `Mirror Neurons` take on an optional port.
 *
 * ## Six required pickers, and why the obvious `optional: true` is wrong here
 *
 * There is no default that fits — navis-flybrains' own files use `x_flip`/`x_mirr` for a mirror
 * and `x`/`jrc2018u_x` for a bridge, and a user's will use something else again — so an unset
 * picker resolving to "the first compatible column" is a real hazard. `optional: true` is the
 * obvious guard against it, and it was the first thing tried.
 *
 * It is wrong, because of what `resolveColumn` does on the two kinds. **An optional picker's
 * chosen column is dropped whenever the schema is not visible**, where a required one's is
 * kept: `if (chosen && available.includes(chosen)) return chosen; if (param.optional) return
 * undefined`. The landmark table here comes from `Upload Table` more often than not, and an
 * uploaded schema is exactly what is missing after a reload until the browser peek settles. So
 * optional pickers would silently unset all six of somebody's choices on every reopen.
 *
 * Required, the first-compatible fallback lands all six on the *same* column — same port, same
 * dtypes, same list — and the distinctness check in `validate` refuses that by name. The
 * failure mode this was guarding against turns out to be the one the node can detect.
 *
 * ## The id is provenance, not content
 *
 * `ctx.inputKey('in')` plus the params, which is `DatasetAnnotations.key`'s idea exactly. It
 * keys the fitted-spline cache in `pyodide/warp.ts`, so it has to change when the landmarks
 * would and no more often. Hashing three thousand float64 coordinates on every edit is the
 * alternative, and the scheduler has already computed a provenance key for the table.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import type { TransformValue } from '../../core/values'
import { isTableValue } from '../../core/values'
import { COMMON_SPACE, allSpaces } from '../../data/transforms/spaces'
import { checkLandmarkCount, landmarkTriple } from '../lib/transformOps'
import { scaleFor } from '../../data/transforms/landmarks'
import type { SpaceUnits } from '../../data/transforms/spaces'

/** The six pickers, in the order they are read. */
export const LANDMARK_AXES = ['x', 'y', 'z'] as const
export const LANDMARK_SIDES = ['source', 'target'] as const

/**
 * The param id for one picker.
 *
 * Exported because both notebook emitters have to ask this node for the same six columns, and
 * they were re-deriving `` `${side}${axis}` `` from their own local axis lists. A rename here
 * left both of them silently falling through to their "unset coordinate columns" TODO — a
 * refusal that looks exactly like a user who had not finished configuring the node.
 */
export function landmarkParamId(
  side: (typeof LANDMARK_SIDES)[number],
  axis: (typeof LANDMARK_AXES)[number],
): string {
  return `${side}${axis.toUpperCase()}`
}

/**
 * A unit the landmark file might be in, per side.
 *
 * Per side rather than one for both, because the two halves of a registration routinely differ
 * — Coda's own hub landmarks are nanometres against micrometres, which is what template spaces
 * published in different eras look like. One control for both would silently scale one side.
 */
const UNIT_OPTIONS = [
  { value: 'nm', label: 'Nanometres' },
  { value: 'um', label: 'Micrometres' },
]

/**
 * A units param back to its union.
 *
 * Params arrive as `ParamValue`, so every enum has to be narrowed somewhere; here rather than
 * by widening `scaleFor`, which is the data layer's and should keep saying which two units a
 * landmark file can be in. Anything unrecognised reads as nanometres, which is this param's
 * declared default.
 */
function unitsOf(raw: unknown): SpaceUnits {
  return raw === 'um' ? 'um' : 'nm'
}

export const landmarkTransformNode = registerNode({
  type: 'core.landmarkTransform',
  label: 'Landmark Transform',
  category: 'transform',
  description: 'Build a spatial transform from a table of matched landmark coordinates.',
  guide:
    'Turns a six-column table — three coordinates before, three after — into a transform that ' +
    'Transform Neurons and Mirror Neurons can use in place of the registrations Coda ships. ' +
    'Pair it with Upload Table or Table from URL to bring in your own registration, or one ' +
    'from navis-flybrains that this build predates.',
  // Reading six columns out of a table already in hand. The fitting happens where the transform
  // is *used*, which is what keeps this off the expensive path.
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Landmarks', type: T.table() }],
  outputs: [{ id: 'transform', label: 'Transform', type: T.transform() }],
  params: [
    ...LANDMARK_SIDES.flatMap((side) =>
      LANDMARK_AXES.map((axis) => ({
        id: landmarkParamId(side, axis),
        kind: 'column' as const,
        label: `${side === 'source' ? 'From' : 'To'} ${axis}`,
        from: 'in',
        dtypes: NUMERIC_DTYPES,
        default: '',
        // Required rather than optional, which is the opposite of the obvious call — see the
        // header. An unset one falls back to the first numeric column, all six alike, and
        // `validate`'s distinctness check is what turns that into a message.
        help:
          side === 'source'
            ? 'A coordinate before the transform.'
            : 'The same landmark after it.',
      })),
    ),
    {
      id: 'sourceUnits',
      kind: 'enum',
      label: 'From units',
      default: 'nm',
      options: UNIT_OPTIONS,
      advanced: true,
      help: 'What the first three columns are in. Everything in Coda is nanometres, so anything else is converted on the way in.',
    },
    {
      id: 'targetUnits',
      kind: 'enum',
      label: 'To units',
      default: 'nm',
      options: UNIT_OPTIONS,
      advanced: true,
      help: 'What the last three columns are in. Often different from the first three — a template published in micrometres registered against a volume in nanometres.',
    },
    {
      id: 'targetSpace',
      kind: 'enum',
      label: 'Lands in',
      default: '',
      options: [
        { value: '', label: 'Unknown' },
        { value: COMMON_SPACE.id, label: COMMON_SPACE.label },
        ...allSpaces().map((space) => ({ value: space.id, label: space.label })),
      ],
      help:
        'Which template space the second three columns are in, if it is one Coda knows. ' +
        'Geometry transformed through this is stamped with it, which is what lets a later ' +
        'Mirror or NBLAST check that two sets are comparable. Leave Unknown if it is your own.',
    },
  ],

  // A transform carries no schema — its landmarks are data, decided by the run — so there is
  // nothing to infer beyond the kind. Same answer `neuron.nblast` gives for its matrix.
  inferOutputs: () => ({ transform: T.transform() }),

  validate: (ctx) => {
    const input = ctx.inputs.in
    if (input && input.kind !== 'table' && input.kind !== 'neurons' && input.kind !== 'any') {
      return ['Landmark Transform takes a table.']
    }

    const chosen = LANDMARK_SIDES.flatMap((side) => LANDMARK_AXES.map((axis) => ctx.column(landmarkParamId(side, axis))))
    if (chosen.some((name) => !name)) {
      return ['Pick all six coordinate columns — three before the transform, three after.']
    }

    /*
     * The same column twice is a landmark set with a collapsed axis: the spline it fits
     * flattens every neuron onto a plane, and it runs without complaint.
     *
     * It is also what an *unset* picker looks like here, which is the whole reason the six are
     * required rather than optional (see the header). Six pickers over one port with one dtype
     * list all fall back to the same first column, so "nobody chose" and "somebody chose badly"
     * arrive as the same thing and this catches both.
     */
    if (new Set(chosen).size !== chosen.length) {
      return [
        'Each of the six columns must be different — a repeat collapses an axis, and six ' +
          'identical ones mean the pickers have not been set.',
      ]
    }
    return []
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Landmark Transform takes a table.')

    const names = LANDMARK_SIDES.map((side) =>
      LANDMARK_AXES.map((axis) => ctx.column(landmarkParamId(side, axis)) ?? ''),
    )
    if (names.flat().some((name) => !name)) {
      throw new Error('Pick all six coordinate columns before running.')
    }
    /*
     * No column-existence loop here: `landmarkTriple` refuses a missing column by the same
     * sentence, one line later. Two copies of one message is one wording change away from
     * saying two different things about the same failure.
     *
     * fastcore refuses below four landmarks too; refusing here names the table rather than
     * surfacing as a Python error three layers down.
     */
    checkLandmarkCount(table.length)

    const transform: TransformValue = {
      kind: 'transform',
      // Provenance rather than content — see the header.
      id: `custom:${ctx.inputKey('in')}:${names.flat().join(',')}`,
      source: landmarkTriple(table, names[0]!, scaleFor(unitsOf(ctx.params.sourceUnits))),
      target: landmarkTriple(table, names[1]!, scaleFor(unitsOf(ctx.params.targetUnits))),
      count: table.length,
      label: 'Landmark Transform',
      ...(ctx.params.targetSpace ? { targetSpace: String(ctx.params.targetSpace) } : {}),
    }
    return { transform }
  },
})
