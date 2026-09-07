/**
 * Stack Neurons: any number of geometry collections end to end.
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
 * ## As many inputs as you ask for
 *
 * Exactly `Stack Tables`' shape, down to the shared params in `nodes/lib/stackParams.ts`. It used
 * to be a fixed pair chained for more, and that is what made the source column mean two things:
 * each card labelled *its own* two inputs, so a three-dataset scene named the third and coloured
 * the first two alike. One card labels every input once, which is the whole of what the 3D View's
 * colour encoding reads.
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
import { STACK_PORT_LABEL, stackSchema } from '../lib/tableOps'
import {
  readStackOptions,
  stackCountParam,
  stackLabelParams,
  stackSourceColumn,
} from '../lib/stackParams'
import {
  geometryNoun,
  isGeometryKind,
  isGeometryValue,
  kindClashMessage,
  stackGeometry,
  schemaOfGeometry,
} from '../lib/transformOps'

export const stackNeuronsNode = registerNode({
  type: 'neuron.stack',
  label: 'Stack Neurons',
  category: 'transform',
  description: 'Combine several sets of skeletons, meshes or points into one collection.',
  guide:
    'The geometry counterpart of Stack Tables: several collections end to end, with their ' +
    'attribute tables stacked alongside. This is how neurons from two or more datasets reach ' +
    'one 3D View — transform each into a shared space first, then stack them and colour by the ' +
    'source column. Every input must be the same kind, in the same units and the same space.',
  // Concatenating buffers already in hand. No network, no runtime, one pass.
  cost: 'cheap',
  /*
   * `any` on every port, on `core.selectOne`'s reasoning: the type system cannot say "skeletons,
   * meshes or points", so the port says `any` and the refusal is a validation question.
   */
  inputs: [
    {
      repeat: stackCountParam.id,
      ports: [{ id: 'in', label: STACK_PORT_LABEL, type: T.any() }],
      // What indices 1 and 2 were called when this node had a fixed pair.
      formerIds: ['top', 'bottom'],
    },
  ],
  outputs: [{ id: 'out', label: 'Neurons', type: T.any() }],
  params: [
    stackCountParam,
    {
      id: 'sourceColumn',
      kind: 'string',
      label: 'Source column',
      placeholder: 'none',
      /*
       * Filled by default, unlike `Stack Tables`' — and the difference is what the two are for.
       * A stacked *table* is usually rows of the same kind of thing and the column is an extra;
       * a stacked *collection* is usually several datasets in one scene, where being unable to
       * tell which neuron came from where is the failure rather than an inconvenience.
       */
      default: 'source',
      help: 'Adds a column naming which input each neuron came from — this is what a colour encoding reads in the 3D View. Empty adds none.',
    },
    ...stackLabelParams(['First', 'Second']),
  ],

  /**
   * Unknown until *every* input is known, which is `Stack Tables`' rule and not laziness.
   *
   * The attribute schema depends on all of them, so publishing the first's alone would advertise
   * a table missing every column the others contribute — and a picker downstream would be
   * configured against a shape that never arrives.
   */
  inferOutputs: (ctx) => {
    const ports = ctx.inputPorts()
    const types = ports.map((port) => ctx.inputs[port.id])
    const first = types[0]
    if (!first || types.some((type) => !type || type.kind !== first.kind))
      return { out: T.any() }

    // The source column alone, not `readStackOptions`: a label never reaches a *schema*, and
    // this runs on every graph mutation — see that function on what the labels array costs here.
    const schema = stackSchema(types.map(schemaOfGeometry), {
      sourceColumn: stackSourceColumn(ctx.params),
    })
    if (first.kind === 'skeletons') return { out: T.skeletons(schema) }
    if (first.kind === 'meshes') return { out: T.meshes(schema) }
    if (first.kind === 'points') return { out: T.points(schema) }
    return { out: T.any() }
  },

  validate: (ctx) => {
    const issues: string[] = []
    /*
     * One pass, holding both facts each check needs: whether the socket carries geometry at all,
     * and what kind it states. `any` states nothing — an unresolved socket is the ordinary state
     * before anything upstream has run, so it neither answers nor accuses.
     */
    const stated: { name: string; noun: string }[] = []
    for (const port of ctx.inputPorts()) {
      const kind = ctx.inputs[port.id]?.kind
      if (kind === undefined) continue
      if (!isGeometryKind(kind)) {
        issues.push(
          `${port.label} is not geometry — Stack Neurons takes skeletons, meshes or points.`,
        )
        continue
      }
      if (kind !== 'any') stated.push({ name: port.label ?? port.id, noun: kind })
    }

    /*
     * The kind clash is worth saying at edit time because it is a wiring mistake rather than a
     * data one: it is visible from the types alone, it will not fix itself on a Run, and the
     * remedy is a different wire rather than a different upstream node. Units and space are
     * value-level facts a type cannot carry, so those wait for `evaluate`.
     *
     * Against the *first stated* kind rather than pairwise, which is `checkStackable`'s rule and
     * for its reason: a clash at input 4 names the input that has to change, not the one next to
     * it. The sentence is `kindClashMessage`, shared with that check — two layers report this and
     * a reader who meets both must be able to tell they are one complaint.
     */
    const [first, ...rest] = stated
    if (first) {
      for (const entry of rest) {
        if (entry.noun !== first.noun) issues.push(kindClashMessage(first, entry))
      }
    }
    return issues
  },

  evaluate: (ctx) => {
    const ports = ctx.inputPorts()
    const inputs = ports.map((port) => {
      const value = ctx.input(port.id)
      if (!isGeometryValue(value)) {
        throw new Error('Stack Neurons takes skeletons, meshes or points on every input.')
      }
      return value
    })

    // `stackGeometry` runs `checkStackable` itself, so the refusals cannot be skipped by a
    // caller — the same reason `datasetRequest` bundles the annotations with the id.
    const out = stackGeometry(inputs, readStackOptions(ctx.params, ports.length))
    const count = out.kind === 'points' ? out.attributes.length : out.items.length
    ctx.progress(1, `${count.toLocaleString()} ${geometryNoun(out)}`)
    return { out }
  },
})
