/**
 * The Text note: a paragraph on the canvas, not a step in the pipeline.
 *
 * A graph explains *what* it computes and never *why*. Which cell types were picked and on what
 * grounds, why a threshold is 10 and not 5, what the reader is supposed to notice in the chart at
 * the end — none of that is derivable from the nodes, and all of it is what someone opening a
 * shared workflow a month later actually needs. This is where it goes.
 *
 * **`annotation: true` is the whole design.** It carries no data, so it has no ports, is never
 * evaluated, never goes stale, never blocks anything and never appears in a run summary — see
 * `NodeDefinition.annotation`. It is still an ordinary `GraphNode`, which is what gives it
 * position, selection, undo, autosave, the saved file, duplication and the minimap without a
 * second document model; what makes it "not a node" is the absence of dataflow, plus a card that
 * looks nothing like one (`ui/nodes/NoteCard.tsx`).
 *
 * **The text is markdown**, rendered through the same `ui/markdown.ts` subset the dataset
 * Description card uses. Reused rather than re-parsed: that module exists because a blurb from a
 * foreign deployment must not be able to become markup, and text someone pastes into a graph they
 * then share has exactly the same property. Headings, lists, emphasis, code and links, and raw
 * HTML stays text.
 *
 * `cost` is required by the definition shape and is meaningless here — nothing runs. `cheap` is
 * the honest of the two: an annotation costs nothing, and claiming `expensive` would put it in
 * front of anyone reading the browser's cost badges.
 */

import { registerNode } from '../../core/registry'

/** Wide enough for a sentence to breathe, short enough not to bury the node it sits beside. */
export const NOTE_DEFAULT_SIZE = { width: 320, height: 140 }

export const textNoteNode = registerNode({
  type: 'note.text',
  label: 'Text',
  category: 'utility',
  description: 'A block of text on the canvas — what a graph is for, in words. Markdown.',
  annotation: true,
  cost: 'cheap',
  inputs: [],
  outputs: [],
  defaultSize: NOTE_DEFAULT_SIZE,
  params: [
    {
      id: 'text',
      label: 'Text',
      kind: 'string',
      multiline: true,
      /*
       * Empty, and the card shows a hint instead. A default sentence would have to be either
       * instructions, which every copy of the note then repeats until someone deletes them, or
       * lorem, which is worse. The hint lives in the card, where it can disappear the moment
       * there is something to say.
       */
      default: '',
      placeholder: '## Heading\n\nWhat this part of the graph is for.',
      help: 'Markdown: **bold**, *italic*, `code`, - lists, # headings and [links](https://example.org).',
    },
    {
      id: 'outline',
      label: 'Outline',
      kind: 'boolean',
      default: true,
      /*
       * Inspector-only. A note's card is the text and nothing else — putting a checkbox on it
       * would spend the one row of chrome the card does not have on a control used once. On by
       * default because the frame is what makes a note look like an object you can move; off is
       * for a caption that should read as writing on the canvas rather than as a card on it.
       */
      advanced: true,
      help: 'Off draws the text with no frame, paper or shadow — a caption rather than a card.',
    },
  ],

  /*
   * Never called — the scheduler skips annotations before it reaches an evaluate. Present
   * because the node contract requires it, and returning nothing is the truthful implementation
   * of a node with no outputs.
   */
  evaluate: () => ({}),
})
