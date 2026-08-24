/**
 * Stack Neurons: two collections of geometry end to end.
 *
 * The geometry sibling of `Stack Tables`, and it exists for one thing above all — **putting
 * neurons from two datasets in one 3D View**. That is now a question worth asking, because
 * `Transform Neurons` can put them in one space first; before that, combining two datasets
 * produced two clouds in opposite corners of an empty scene.
 *
 * ## Why a node, rather than more wires
 *
 * The obvious alternative is to let the 3D View take several skeleton wires. Input ports are
 * single-connection by construction — `addEdge` replaces any existing edge on the same input
 * port — and widening that is a change to the graph model rather than to a viewer.
 *
 * It would also solve only the viewer. A combined collection is equally what `Download`,
 * `NBLAST` and `Select One` want, and each of those would need the same widening again. One
 * value that *is* the union is the thing worth having; drawing it is one consumer.
 *
 * ## Two inputs, chained for more
 *
 * Exactly `Stack Tables`' shape, and the same consequence follows: the source column
 * distinguishes the two inputs of the stack that *added* it, so three collections want either a
 * distinct column name per level or the labels set at each one.
 *
 * ## What it refuses
 *
 * Kind, units and space, all in `checkStackable` — see there for why each would otherwise
 * produce a picture instead of an error. The space check is the one this feature was built for:
 * it turns "I forgot to transform one side" from a broken-looking viewer into a sentence naming
 * the node that fixes it.
 *
 * ## The source column is the point, not a detail
 *
 * Two datasets in one scene are only worth looking at if you can tell them apart. The column
 * this adds is what a colour encoding reads, so `Source column: dataset` and then colouring by
 * it is the whole co-visualisation gesture. Empty adds none, as in `Stack Tables` — but here
 * the default is a *filled* one, because a combined collection with nothing distinguishing its
 * halves is the case somebody almost never wants.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { StackOptions } from '../lib/tableOps'
import { stackSchema } from '../lib/tableOps'
import {
  geometryNoun,
  isGeometryKind,
  isGeometryValue,
  stackGeometry,
  schemaOfGeometry,
} from '../lib/transformOps'

/** The two labels and the column they go in, read once so both halves cannot disagree. */
function stackOptions(params: Record<string, unknown>): StackOptions {
  return {
    sourceColumn: String(params.sourceColumn ?? ''),
    topLabel: String(params.topLabel ?? STACK_LABELS.top),
    bottomLabel: String(params.bottomLabel ?? STACK_LABELS.bottom),
  }
}

/**
 * What the source column says when nobody renamed the inputs.
 *
 * One pair, read by the param declarations *and* by the reader that falls back when a param is
 * absent — which is exactly the disagreement this replaced: the params declared `First`/`Second`
 * while the fallback said `Top`/`Bottom`, so which one a column ended up carrying depended on
 * whether the param had ever been written. `core.stack` keeps its own `Top`/`Bottom`, which are
 * that node's declared defaults and appear in saved graphs.
 */
export const STACK_LABELS = { top: 'First', bottom: 'Second' } as const

export const stackNeuronsNode = registerNode({
  type: 'neuron.stack',
  label: 'Stack Neurons',
  category: 'transform',
  description: 'Combine two sets of skeletons, meshes or points into one collection.',
  guide:
    'The geometry counterpart of Stack Tables: two collections end to end, with their ' +
    'attribute tables stacked alongside. This is how neurons from two datasets reach one 3D ' +
    'View — transform both into a shared space first, then stack them and colour by the ' +
    'source column. Both sides must be the same kind, in the same units and the same space.',
  // Concatenating buffers already in hand. No network, no runtime, one pass.
  cost: 'cheap',
  /*
   * `any` on both ports, on `core.selectOne`'s reasoning: the type system cannot say "skeletons,
   * meshes or points", so the port says `any` and the refusal is a validation question.
   */
  inputs: [
    { id: 'top', label: 'First', type: T.any() },
    { id: 'bottom', label: 'Second', type: T.any() },
  ],
  outputs: [{ id: 'out', label: 'Neurons', type: T.any() }],
  params: [
    {
      id: 'sourceColumn',
      kind: 'string',
      label: 'Source column',
      placeholder: 'none',
      /*
       * Filled by default, unlike `Stack Tables`' — and the difference is what the two are for.
       * A stacked *table* is usually rows of the same kind of thing and the column is an extra;
       * a stacked *collection* is usually two datasets in one scene, where being unable to tell
       * which neuron came from where is the failure rather than an inconvenience.
       */
      default: 'source',
      help: 'Adds a column naming which input each neuron came from — this is what a colour encoding reads in the 3D View. Empty adds none.',
    },
    {
      id: 'topLabel',
      kind: 'string',
      label: 'First label',
      default: STACK_LABELS.top,
      advanced: true,
      // Out of the provenance key while there is no column to put them in, so renaming the
      // inputs of a stack that is not labelling anything cannot stale a downstream result.
      visibleIf: (params) => String(params.sourceColumn ?? '').trim() !== '',
    },
    {
      id: 'bottomLabel',
      kind: 'string',
      label: 'Second label',
      default: STACK_LABELS.bottom,
      advanced: true,
      visibleIf: (params) => String(params.sourceColumn ?? '').trim() !== '',
    },
  ],

  /**
   * Unknown until *both* sides are known, which is `Stack Tables`' rule and not laziness.
   *
   * The attribute schema depends on both, so publishing the first's alone would advertise a
   * table missing every column the second contributes — and a picker downstream would be
   * configured against a shape that never arrives.
   */
  inferOutputs: (ctx) => {
    const top = ctx.inputs.top
    const bottom = ctx.inputs.bottom
    if (!top || !bottom || top.kind !== bottom.kind) return { out: T.any() }

    const schema = stackSchema(
      schemaOfGeometry(top),
      schemaOfGeometry(bottom),
      stackOptions(ctx.params),
    )
    if (top.kind === 'skeletons') return { out: T.skeletons(schema) }
    if (top.kind === 'meshes') return { out: T.meshes(schema) }
    if (top.kind === 'points') return { out: T.points(schema) }
    return { out: T.any() }
  },

  validate: (ctx) => {
    const top = ctx.inputs.top
    const bottom = ctx.inputs.bottom
    const issues: string[] = []

    for (const [label, type] of [
      ['First', top],
      ['Second', bottom],
    ] as const) {
      if (type && !isGeometryKind(type.kind)) {
        issues.push(`${label} is not geometry — Stack Neurons takes skeletons, meshes or points.`)
      }
    }

    /*
     * The kind clash is worth saying at edit time because it is a wiring mistake rather than a
     * data one: it is visible from the types alone, it will not fix itself on a Run, and the
     * remedy is a different wire rather than a different upstream node. Units and space are
     * value-level facts a type cannot carry, so those wait for `evaluate`.
     */
    if (
      top &&
      bottom &&
      isGeometryKind(top.kind) &&
      isGeometryKind(bottom.kind) &&
      top.kind !== bottom.kind
    ) {
      {
        issues.push(
          `First is ${top.kind} and Second is ${bottom.kind}. Different kinds of geometry ` +
            'cannot share one collection — the 3D View takes them on separate ports.',
        )
      }
    }
    return issues
  },

  evaluate: (ctx) => {
    const top = ctx.input('top')
    const bottom = ctx.input('bottom')
    if (!isGeometryValue(top) || !isGeometryValue(bottom)) {
      throw new Error('Stack Neurons takes skeletons, meshes or points on both inputs.')
    }

    // `stackGeometry` runs `checkStackable` itself, so the refusals cannot be skipped by a
    // caller — the same reason `datasetRequest` bundles the annotations with the id.
    const out = stackGeometry(top, bottom, stackOptions(ctx.params))
    const count = out.kind === 'points' ? out.attributes.length : out.items.length
    ctx.progress(1, `${count.toLocaleString()} ${geometryNoun(out)}`)
    return { out }
  },
})
