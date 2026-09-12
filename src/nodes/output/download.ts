import { registerNode } from '../../core/registry'
import { T } from '../../core/types'

/**
 * Write whatever arrives on the wire to a file.
 *
 * The one node here whose purpose is a **side effect**, and everything odd about it follows
 * from that.
 *
 * ## `evaluate` does not download
 *
 * It passes its input through and nothing else. Two reasons, and either alone would be enough.
 * `src/nodes` is headless — there is no `URL.createObjectURL` and no anchor to click — and a
 * cache hit means `evaluate` never runs, so a download performed there would happen on the first
 * Run and silently not on the second. The file is written by `ui/useDownloads.ts`, which watches
 * for runs in which this node actually *executed*.
 *
 * ## `expensive`, which here is a safety property rather than a cost one
 *
 * Nothing about writing a file is slow. But `cheap` nodes re-run on the 180ms pass after every
 * edit, and a node that writes a file on every keystroke is not a node anybody can leave on a
 * canvas. `expensive` also makes the signal reliable: only `runFull` records a `RunSummary`, so
 * the driver has something to watch.
 *
 * ## What "on every run" actually means
 *
 * `On run` is **on by default** and can be switched off. What bounds it is the provenance key:
 * a run in which nothing upstream changed does not re-execute this node, so pressing Run twice
 * writes one file. What it does *not* bound is auto-run — with that on, every edit that changes
 * the data upstream is a full pass, and every one of those writes a file. The card says so
 * beside the checkbox, which is the only place that warning can be true, since a node definition
 * cannot see the store.
 *
 * ## Pictures come from a viewer, not from the wire
 *
 * A viewer is a tap: `out.scatter` passes its *table* on, not its picture, so nothing on this
 * node's input could ever be an image. `svg`/`png` therefore read the rendered chart belonging
 * to whatever node feeds this one — which is why they work only while that card is on screen
 * and not collapsed. That is a real limit and the card states it rather than failing quietly.
 */
registerNode({
  type: 'out.download',
  label: 'Download',
  category: 'utility',
  // Wide enough for a filename field and for the auto-run warning to read as a sentence — that
  // line is the whole reason somebody does not end up with four hundred files.
  cardWidth: 300,
  description: 'Write the incoming value to a file, on every run or on demand.',
  guide:
    'Save whatever is connected to a file — CSV for tables, SWC for skeletons, OBJ for meshes, SVG or PNG for an upstream chart.',
  cost: 'expensive',
  /*
   * `T.any()`: a Download node refusing what it was wired to would be the one node in the tree
   * that cares what it is carrying, and it does not.
   *
   * **The only port in the registry that means `any` literally**, alongside its own output.
   * Every other one — both passthroughs, both loop ends, Select One — turned out to mean one of
   * five named sets, which is what `PortDef.kinds` exists to say. `anyKind` is how this one says
   * the omission is deliberate rather than unaudited, and `sockets.test.ts` sweeps the registry
   * for a bare `T.any()` that says neither. It is last in `socketTier`, so it sits under every
   * node that wanted the wire specifically, and it is still offered, because saving an
   * intermediate is a real answer to any wire at all.
   */
  inputs: [{ id: 'in', label: 'Value', type: T.any(), anyKind: true }],
  // Passed through so it can sit mid-chain, exactly as the viewers do. An endpoint that broke
  // the chain would have to be the last node in every workflow that saves an intermediate.
  outputs: [{ id: 'out', label: 'Value', type: T.any(), anyKind: true }],
  /*
   * **Every param here is presentational, and that is not a stretch of the word.**
   *
   * `presentational` means "cannot change what `evaluate` returns", and `evaluate` returns its
   * input unchanged whatever these say — the filename, the format and the timestamp decide what
   * is *written*, never what is passed on. Leaving them in the provenance key would make
   * renaming a file re-run this node and invalidate the entire graph downstream of it, which on
   * an expensive pipeline is minutes of queries for a change to a string.
   *
   * The consequence to know: changing one of them and pressing Run writes nothing, because the
   * node is not stale and does not re-execute. The button on the card is what writes a file on
   * demand, and that is exactly what it is there for.
   */
  params: [
    {
      id: 'filename',
      kind: 'string',
      label: 'Filename',
      placeholder: 'auto',
      help: 'Without the extension. Empty uses the graph name and this node’s title.',
      default: '',
      presentational: true,
    },
    {
      id: 'format',
      kind: 'enum',
      label: 'Format',
      default: 'auto',
      /*
       * A static list rather than one derived from the input's kind. The options a value
       * supports are decided in `ui/exportValue.ts`, which `src/nodes` must not import — and a
       * format that does not apply is reported by the card, where the value is in hand, rather
       * than by hiding the control and leaving nothing to explain its absence.
       */
      options: [
        { value: 'auto', label: 'auto (by type)' },
        { value: 'csv', label: 'CSV' },
        { value: 'graphml', label: 'GraphML (networks)' },
        { value: 'cx2', label: 'CX2 (networks, Cytoscape Web)' },
        { value: 'json', label: 'JSON' },
        { value: 'swc', label: 'SWC (skeletons)' },
        { value: 'obj', label: 'OBJ (meshes)' },
        { value: 'newick', label: 'Newick (trees)' },
        { value: 'svg', label: 'SVG (upstream chart)' },
        { value: 'png', label: 'PNG (upstream chart)' },
      ],
      presentational: true,
    },
    {
      id: 'onRun',
      kind: 'boolean',
      label: 'On run',
      help: 'Write the file whenever this node runs. Off makes the button the only trigger.',
      default: true,
      presentational: true,
    },
    {
      id: 'timestamp',
      kind: 'boolean',
      label: 'Timestamp',
      help: 'Append the date and time, so repeated runs do not collide.',
      default: false,
      presentational: true,
    },
  ],

  // A tap: the type passes through untouched, so nothing downstream can tell this node is here.
  inferOutputs: (ctx) => ({ out: ctx.inputs.in ?? T.any() }),

  /*
   * No `validate`, deliberately. The only thing worth reporting is a format the value cannot be
   * written as, and that is decided *from the value* — a `Table` type says nothing about whether
   * the node feeding this one has a chart on screen. The card has the value and says it there.
   */

  /*
   * A pure pass-through, and it must stay one. The download is `ui/useDownloads.ts`'s job; see
   * the note above for why putting it here would write a file on the first Run and none after.
   */
  evaluate: (ctx) => {
    const value = ctx.input('in')
    // The port is required, so the scheduler blocks before this — the throw is here because
    // `ctx.input` cannot know that, and a silent `undefined` on the output would make every
    // node downstream of a mid-chain Download fail somewhere else entirely.
    if (value === undefined) throw new Error('Nothing is connected to Value')
    return { out: value }
  },
})
