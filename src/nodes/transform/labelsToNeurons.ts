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
    // Wide enough for two column pickers and for "N matched nothing" to sit beside the counts.
    cardWidth: 300,
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
        help: 'The column holding the labels. Dendrogram and Cut Tree both call it `label`.',
      },
      {
        id: 'matchColumn',
        kind: 'column',
        label: 'Match on',
        from: 'neurons',
        default: 'neuronId',
        help: 'The column of the neuron table the labels are matched against. Use the column NBLAST used for `Label by`, e.g. `type`.',
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
        String(ctx.params.suffix),
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
          `The input has no "${flavour.expects}" column, so nothing downstream can colour by ` +
            `it. Wire in the \`Clusters\` output of a Cut Tree.`,
        )
      }
      // Without a neuron table the labels have to *be* neuron ids, which is only true when
      // NBLAST was left to label by id. Said here because the alternative is an empty result.
      if (!ctx.inputs.neurons) {
        issues.push(
          'Nothing is wired into `Neurons`, so the labels are read as neuron ids. If the tree is ' +
            'labelled by anything else, wire in the neuron table you clustered.',
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
        suffix: String(ctx.params.suffix),
      })
      return { neurons: result.neurons }
    },
  })
}

define({
  type: 'cluster.selectedToNeurons',
  label: 'Selected to Neurons',
  inputLabel: 'Selected',
  description:
    'Turn a Dendrogram selection into neurons. The selection’s columns are carried along, and any whose name the neuron table already uses is suffixed `_c`.',
  guide:
    'Turns the leaf names selected in a Dendrogram back into neurons, ready for Neuroglancer, ' +
    'a 3D View or Skeletons. Wire the neuron table you clustered and set Match on to the column ' +
    'NBLAST used for Label by; if that was neuron id (the default), leave Neurons unwired.',
})

define({
  type: 'cluster.clustersToNeurons',
  label: 'Clusters to Neurons',
  inputLabel: 'Clusters',
  expects: 'cluster',
  description:
    'Put cluster numbers back onto the neurons they came from. `cluster`, `order` and `size` are carried along, and any column whose name the neuron table already uses is suffixed `_c`.',
  guide:
    'Maps the cluster numbers from Cut Tree back onto the neurons they came from, e.g. to colour ' +
    'by cluster in Neuroglancer. Wire the neuron table you clustered into Neurons and set Match ' +
    'on to the column NBLAST used for Label by.',
})
