import { registerNode } from '../../core/registry'
import { T, columnNames, findColumn } from '../../core/types'
import { getUpload, peekUploadSchema, uploadPeekSettled } from '../../data/uploads'
import { importShapeIssues, importShapeParams, readImportShape } from '../lib/importParams'
import { uploadIsNeurons, uploadShapeSchema, uploadShapeTable } from '../lib/tableOps'

/**
 * A table the user brought in themselves: annotations, custom cell types, an embedding.
 *
 * The one node here with no inputs and no data source behind it. What makes that work is
 * `src/data/uploads.ts` — read its module note first, because the two decisions that shape
 * this node are both taken there: the rows live in IndexedDB rather than in the graph, and
 * the schema reaches inference through a synchronous peek.
 *
 * ## The graph carries a reference, not the data
 *
 * `dataId` is a content address, so it is the whole of this node's contribution to the
 * provenance key: the same file re-picked re-runs nothing, a different file invalidates
 * everything downstream, and no `refresh` nonce is needed. `fileName` rides along purely so
 * the card and the error message can name what is missing.
 *
 * The cost, and it is deliberate rather than overlooked: **a `.coda.json` sent to somebody
 * else arrives without its rows.** They see the workflow, the node names the file, and
 * `evaluate` throws so everything after it is `blocked` rather than running on nothing.
 *
 * ## Why the column pickers can be empty for a moment
 *
 * The schema is not in the graph either, so on a cold load `peekUploadSchema` answers "I do
 * not know yet" and starts the read that will fill it. Inference re-runs when it lands
 * (`subscribeUploadLearned`). That window is normally a millisecond or two and is why
 * `ID column` is an **enum** rather than a `column` param: an enum's stored value goes into
 * the provenance key verbatim, where a column param's is resolved against the schema — which
 * would key the node one way before the peek landed and another way after, and mark a node
 * that had just run stale.
 */
export const uploadTableNode = registerNode({
  type: 'core.uploadTable',
  label: 'Upload Table',
  category: 'utility',
  description: 'Bring in a CSV of your own — annotations, cell types, an embedding.',
  guide:
    'Your own CSV: annotations, cell types, embeddings. The only node with no inputs and no backend. Rows live in this browser, not in the graph — a .coda.json sent to a colleague arrives without them. The card shows which file is missing if you need to pick it again.',
  // No network and no parse: `evaluate` is one IndexedDB read of an already-parsed table.
  cost: 'cheap',
  inputs: [],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    /*
     * Both written by the node's own body, never typed. `advanced` keeps them out of the card
     * — where the body draws the file picker instead — while leaving them visible in the
     * inspector, which is the only place the reference behind a card is inspectable at all.
     */
    { id: 'dataId', kind: 'string', label: 'Data', default: '', advanced: true },
    /*
     * `presentational`, which looks wrong on a param that is not a viewer knob and is not.
     * The name cannot change a byte of what `evaluate` returns — `dataId` decides that, and
     * two people importing one file under two names hold identical rows. Leaving it in the
     * provenance key means renaming a file re-runs the node and invalidates everything
     * downstream of it for no reason anybody could see.
     */
    {
      id: 'fileName',
      kind: 'string',
      label: 'File',
      default: '',
      advanced: true,
      presentational: true,
    },
    ...importShapeParams({ read: (params) => peekUploadSchema(String(params.dataId ?? '')) }),
  ],

  /**
   * Pure, synchronous, and never throwing — against whatever the peek can answer.
   *
   * An unknown schema publishes a bare `T.table()` rather than nothing, so the socket still
   * types and the wire still connects; the columns fill in when the peek lands.
   */
  inferOutputs: (ctx) => {
    const stored = peekUploadSchema(String(ctx.params.dataId ?? ''))
    const shape = readImportShape(ctx)
    const shaped = uploadShapeSchema(stored, shape)
    return {
      out: uploadIsNeurons(stored, shape.idColumn ?? '') ? T.neurons(shaped) : T.table(shaped),
    }
  },

  /**
   * Only two things are worth saying, and both are about the file rather than the controls.
   *
   * Nothing is reported while the peek has not settled: "no file chosen" over a node that is
   * about to fill itself in is the false alarm that stops a real one being read, and it would
   * fire on every single graph load.
   */
  validate: (ctx) => {
    const dataId = String(ctx.params.dataId ?? '')
    if (!dataId) return ['No file chosen — use the button on the node']
    if (!uploadPeekSettled(dataId)) return []
    const schema = peekUploadSchema(dataId)
    if (!schema) {
      const name = String(ctx.params.fileName ?? '') || 'this file'
      return [`${name} is not stored in this browser — pick the file again`]
    }
    return importShapeIssues(ctx, schema, String(ctx.params.fileName ?? '') || 'the file')
  },

  evaluate: async (ctx) => {
    const dataId = String(ctx.params.dataId ?? '')
    const name = String(ctx.params.fileName ?? '') || 'the uploaded file'
    if (!dataId) throw new Error('No file chosen. Use the button on the node to pick a CSV.')

    const table = await getUpload(dataId)
    /*
     * The message names the file rather than the id, because the id is a hash nobody can act
     * on and the filename is the thing to go and find. This is the state a graph opened on
     * another machine lands in, so it has to read as an instruction and not as a fault.
     */
    if (!table) {
      throw new Error(
        `"${name}" is not stored in this browser. Uploaded rows stay on the machine that ` +
          `uploaded them — pick the file again on this node to restore it.`,
      )
    }

    const idColumn = String(ctx.params.idColumn ?? '')
    if (idColumn && !findColumn(table.schema, idColumn)) {
      throw new Error(
        `ID column "${idColumn}" is not in "${name}". Available: ${columnNames(table.schema).join(', ')}`,
      )
    }
    return { out: uploadShapeTable(table, readImportShape(ctx)) }
  },
})
