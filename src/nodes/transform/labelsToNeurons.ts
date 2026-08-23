/**
 * `Selected to Neurons` and `Clusters to Neurons`.
 *
 * Two registrations over one operation, which is unusual enough here to be worth saying out
 * loud. They take the same inputs, run the same `labelsToNeurons`, and emit the same shape;
 * what differs is the name, what the input socket is called, and what the guide points at. The
 * case for two rather than one is discoverability — somebody with a Cut Tree on the canvas
 * looks for a node named after what they are holding — and the cost is paid once, here, rather
 * than as two implementations that drift.
 *
 * **Why they are needed at all.** A `LinkageValue` knows its leaves only by label, because that
 * is all a `MatrixValue` axis carries. So a Dendrogram's `Selected` and a Cut Tree's `Clusters`
 * are tables of *names*, and everything that draws neurons — Neuroglancer, the 3D view,
 * Skeletons — wants `T.neurons()`, a table with a `neuronId`. These cross that gap.
 *
 * **Local, never a query.** The neurons come from a table already on the canvas — the one that
 * fed the Skeletons that fed the NBLAST — so a clade of three cell types resolves to the
 * neurons that were actually clustered, not to every neuron of those types in the connectome.
 * That is a different question, and `IDs from Label` is the node that asks it.
 */

import type { NodeDefinition } from '../../core/node'
import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import {
  DEFAULT_LABEL_SUFFIX,
  labelsToNeurons,
  labelsToNeuronsSchema,
} from '../lib/labelsToNeurons'

/** What the two nodes disagree about, which is nothing that runs. */
interface Flavour {
  type: string
  label: string
  /** What the labels socket is called. */
  inputLabel: string
  description: string
  guide: string
  /** Warned about at edit time when the labels table does not carry it. */
  expects?: string
}

function define(flavour: Flavour): NodeDefinition {
  return registerNode({
    type: flavour.type,
    label: flavour.label,
    category: 'transform',
    description: flavour.description,
    guide: flavour.guide,
    // No network, no Python: one pass over the neuron table and a map lookup per row.
    cost: 'cheap',
    inputs: [
      { id: 'labels', label: flavour.inputLabel, type: T.table() },
      { id: 'neurons', label: 'Neurons', type: T.neurons(), required: false },
    ],
    outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],
    params: [
      {
        id: 'labelColumn',
        kind: 'column',
        label: 'Label column',
        from: 'labels',
        default: 'label',
        help:
          'Which column names the neurons. Both the Dendrogram and Cut Tree call it "label", ' +
          'which is what a matrix axis carried — a neuron id unless NBLAST was told to label by ' +
          'something else.',
      },
      {
        id: 'matchColumn',
        kind: 'column',
        label: 'Match on',
        from: 'neurons',
        default: 'neuronId',
        help:
          'Which column of the wired neuron table a label is compared with. Set this to the ' +
          'same column NBLAST used for "Label by" — `type` where the tree is labelled by cell ' +
          'type. Compared as text, so a number and a name both work.',
      },
      {
        id: 'suffix',
        kind: 'string',
        label: 'Suffix',
        default: DEFAULT_LABEL_SUFFIX,
        advanced: true,
        help: 'Appended to a carried column whose name the neuron table already uses.',
      },
    ],

    /*
     * The joined schema, so a picker downstream — Neuroglancer's colour-by above all — is
     * offered `cluster` before anything has run. Both halves come from `labelsToNeuronsSchema`,
     * which is what keeps invariant 3 true by construction.
     */
    inferOutputs: (ctx) => {
      const labels = schemaOf(ctx.inputs.labels)
      const neurons = isTabular(ctx.inputs.neurons) ? schemaOf(ctx.inputs.neurons) : undefined
      // A wired-but-unknown neuron schema is not the same as no neuron table: the first is a
      // shape that has not arrived, and guessing `neuronId` for it would advertise a one-column
      // result the run will not produce. Same unknown-is-not-empty rule as `columnSchemaFor`.
      if (ctx.inputs.neurons && !neurons) return { neurons: T.neurons() }
      const schema = labelsToNeuronsSchema(
        labels,
        ctx.column('labelColumn'),
        neurons,
        String(ctx.params.suffix ?? DEFAULT_LABEL_SUFFIX),
      )
      return { neurons: schema ? T.neurons(schema) : T.neurons() }
    },

    validate: (ctx) => {
      const issues: string[] = []
      const labels = schemaOf(ctx.inputs.labels)
      /*
       * The one thing worth saying at edit time, and only for the Clusters flavour: carrying
       * the cluster number is the whole reason that node exists, so a labels table without one
       * is somebody who has wired the Dendrogram's Selected in by mistake. A warning rather
       * than a refusal — the match itself is perfectly valid without it.
       */
      if (
        flavour.expects &&
        labels &&
        !labels.columns.some((c) => c.name === flavour.expects)
      ) {
        issues.push(
          `No "${flavour.expects}" column on the input, so nothing downstream can colour by ` +
            `it. Wire the Clusters output of a Cut Tree.`,
        )
      }
      // Without a neuron table the labels have to *be* neuron ids, which is only true when
      // NBLAST was left to label by id. Said here because the alternative is an empty result.
      if (!ctx.inputs.neurons) {
        issues.push(
          'No Neurons wired, so the labels are read as neuron ids. Wire the neuron table that ' +
            'was clustered if the tree is labelled by anything else.',
        )
      }
      return issues
    },

    evaluate: (ctx) => {
      const labels = ctx.input('labels')
      if (!isTableValue(labels)) throw new Error('Input is not a table')
      const neurons = ctx.input('neurons')
      if (neurons !== undefined && !isTableValue(neurons)) {
        throw new Error('Neurons input is not a table')
      }

      const result = labelsToNeurons({
        labels,
        labelColumn: ctx.column('labelColumn') ?? 'label',
        neurons,
        matchColumn: ctx.column('matchColumn'),
        suffix: String(ctx.params.suffix ?? DEFAULT_LABEL_SUFFIX),
      })
      return { neurons: result.neurons }
    },
  })
}

export const selectedToNeuronsNode = define({
  type: 'cluster.selectedToNeurons',
  label: 'Selected to Neurons',
  inputLabel: 'Selected',
  description: 'Turn a Dendrogram selection into neurons.',
  guide:
    'A Dendrogram selects branches, and a branch is a set of *names* — which is all a tree ' +
    'knows about its leaves. This turns those names back into neurons, so the clade you picked ' +
    'can go to a Neuroglancer link, a 3D view or a Skeletons fetch. Wire the neuron table that ' +
    'was clustered into Neurons and set "Match on" to whatever NBLAST used for "Label by"; if ' +
    'the tree is labelled by neuron id, which is the default, you can leave Neurons unwired and ' +
    'the ids are read straight off. Every column of the matched neurons comes through.',
})

export const clustersToNeuronsNode = define({
  type: 'cluster.clustersToNeurons',
  label: 'Clusters to Neurons',
  inputLabel: 'Clusters',
  expects: 'cluster',
  description: 'Put cluster numbers back onto the neurons they belong to.',
  guide:
    'Cut Tree gives one row per leaf with its cluster number, and a leaf is a name rather than ' +
    'a neuron. This puts those numbers back onto the neurons — so Neuroglancer can colour ' +
    'segments by cluster, a Filter can take one group, and Group By can count them. Wire the ' +
    'neuron table that was clustered into Neurons and set "Match on" to whatever NBLAST used ' +
    'for "Label by". Where a label names several neurons, as a cell type does, every one of ' +
    'them comes back carrying that cluster.',
})
