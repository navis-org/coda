import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { DEFAULT_SEPARATOR, SEPARATOR_OPTIONS } from '../lib/copyIds'

/**
 * Put the incoming neurons' ids on the clipboard.
 *
 * The second node whose purpose is a **side effect**, and it inherits `out.download`'s shape
 * because the constraints are the same ones.
 *
 * ## `evaluate` does not copy
 *
 * It passes its input through and nothing else. `src/nodes` is headless — there is no
 * `navigator.clipboard` in it — and a cache hit means `evaluate` never runs, so a copy performed
 * there would happen on the first Run and silently not on the second. `ui/nodes/CopyIdsBody.tsx`
 * is what writes, through `ui/export.ts`'s `copyText`.
 *
 * ## No `On run`, which is where it parts company with Download
 *
 * A file can be written whenever the graph runs; a clipboard write cannot. Every engine but
 * Chrome refuses `clipboard.writeText` outside a user gesture, so a run-triggered copy would
 * work on one browser and fail on the others — and the *silent* half of that is worse than the
 * noisy one, since the clipboard still holds whatever was there before and a paste therefore
 * succeeds with the wrong ids in it. The button is the trigger, and it is the only one.
 *
 * ## `cheap`, where Download is `expensive`
 *
 * Download is `expensive` as a safety property: it writes on run, and `cheap` would have it
 * write a file per keystroke. Nothing here runs off a run at all, so the only thing cost decides
 * is whether a node downstream of this tap gets its value without pressing Run — and a
 * pass-through that made a chain need a Run it did not need before would be a tax charged for
 * dropping a copy button on it.
 */
export const copyIdsNode = registerNode({
  type: 'out.copyIds',
  label: 'Copy IDs',
  category: 'utility',
  description: 'Copy the incoming neuron ids to the clipboard, ready to paste elsewhere.',
  guide:
    'Puts the ids of whatever neurons are wired to it on the clipboard, in the shape the thing you are pasting into wants — one per line for a list, comma-separated and quoted for a Python or R literal. It is a tap, so it passes the neurons on unchanged and can sit mid-chain; the button is the only trigger, because a browser refuses a clipboard write that no one clicked for.',
  cost: 'cheap',

  inputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],
  // Passed through so it can sit mid-chain, exactly as the viewers and Download do. An endpoint
  // would have to be the last node in every workflow that copies an intermediate set of ids.
  outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],

  /*
   * **Every param is presentational**, in the strict sense invariant 4 requires: `evaluate`
   * returns its input unchanged whatever these say, so none of them can change what is passed
   * on. They decide the *text*, never the value. Leaving them in the provenance key would make
   * switching a separator re-run this node and invalidate everything downstream of it — on a
   * chain fed by a connectome query, minutes of refetching for a comma.
   */
  params: [
    {
      id: 'separator',
      kind: 'enum',
      label: 'Separator',
      help: 'What goes between two ids. New line pastes into a column or an ID field; comma into a list.',
      default: DEFAULT_SEPARATOR,
      // Read from `lib/copyIds.ts`, which is also what joins them — a list written out here
      // would be a second table, and the way it fails is an option the copy does not honour.
      options: SEPARATOR_OPTIONS,
      presentational: true,
    },
    {
      id: 'dedupe',
      kind: 'boolean',
      label: 'Deduplicate',
      help: 'Copy each id once, in first-seen order. A partner column or a stacked table repeats them.',
      default: true,
      presentational: true,
    },
    {
      id: 'quoted',
      kind: 'boolean',
      label: 'Quote ids',
      help: 'Wrap each id in double quotes, for a Python or R list — where an 18-digit id must be a string.',
      default: false,
      presentational: true,
    },
  ],

  // A tap: the type passes through untouched, so nothing downstream can tell this node is here.
  inferOutputs: (ctx) => ({ neurons: ctx.inputs.neurons ?? T.neurons() }),

  /*
   * No `validate`. The only thing worth reporting is "there are no ids to copy", which is
   * decided from the *value* — a neuron type says nothing about how many rows arrived — and the
   * card has the value and says it there, beside the button it disables.
   */

  evaluate: (ctx) => {
    const value = ctx.input('neurons')
    // The port is required, so the scheduler blocks before this — the throw is here because
    // `ctx.input` cannot know that, and a silent `undefined` on the output would make every
    // node downstream of a mid-chain Copy IDs fail somewhere else entirely.
    if (value === undefined) throw new Error('Nothing is connected to Neurons')
    return { neurons: value }
  },
})
