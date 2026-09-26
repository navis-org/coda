/**
 * What a node pack may add to the Workflow Wizard — the extension point, and the one place that
 * finds each pack's contribution.
 *
 * The wizard's own answers are tables in `options.ts` and branches of `build.ts`, written against
 * a closed set of ids. A pack cannot edit either, and should not: a pack is switched off, and the
 * wizard it leaves behind must be exactly the built-in one. So a pack **adds** — ways to choose
 * neurons (a start), single-dataset techniques (an analysis, with the viewers it ends on), and the
 * dialog rows for its own viewers — and the wizard merges what it adds into each question, every
 * question reading one list whoever wrote the entries.
 *
 * ## The file, and the rules it is held to
 *
 * A pack declares its answers in `src/packs/<pack>/wizard.ts`, a default export of
 * `WizardContribution`, found by glob beside `glyphs.ts` and `seeAlso.ts` (`packs/index.ts` on
 * why a glob). Refused at load rather than discovered in a dialog:
 *
 *  - **Every id is `<pack>:<name>`** — `core/nodeType.ts`' grammar, checked by its own functions, and the
 *    pack must be the file's own directory. Two packs cannot mint one id, and no pack can mint a
 *    built-in's, which is also what makes an id in a saved share link say whose answer it was. One
 *    id names one answer, across starts, analyses and viewers alike.
 *  - **A pack never modifies a built-in answer.** Hiding, rewording or rewiring one would make the
 *    built-in wizard depend on which packs are switched on, which nothing downstream — the node
 *    guide, the demo links, `wizard.test.ts`' sweeps — could see. An analysis may end on a built-in
 *    viewer (`table`), but only as the node the built-in wizard means by it. What an id *means* is
 *    `options.ts`' to check (`viewsById`): a built-in viewer as the same node, and a pack's own
 *    viewer as one node wherever it is offered, with a dialog row, ended on by some analysis. Here
 *    is only the grammar and the uniqueness.
 *  - **Gates are declarations**: the option fields every built-in answer has, and `when`, asked of
 *    each chosen dataset, for a fact none of those answers — a cortical frame is the first. The
 *    pack switch needs none: the dialog builds every combination and keeps those whose nodes are
 *    all offered (`offeredCombinations`), so an answer built of a switched-off pack's nodes is not
 *    offered there.
 *  - **A builder emits placements and wires, never a graph** — the shapes `build.ts`' own arms
 *    return, so layout, hints, notes, the dashboard and any annotation chain in front of the
 *    dataset are the wizard's for every answer alike.
 *
 * Every sweep in `wizard.test.ts` walks the merged lists, so a contributed answer is held to what
 * a built-in one is: it builds with no type error for every dataset that offers it, its glyph
 * names a node it builds, and its hint docks to a card that exists. What a pack cannot yet add,
 * and why, is in `docs/wizard.md`.
 *
 * **A refused file stops the app from booting**, deliberately: `options.ts` is in the store's
 * import graph, so a throw here is a blank page and every suite red naming the file. For a pack
 * in this tree that is the right failure — it cannot ship — where refusing one answer and loading
 * the rest would let a broken answer disappear from the dialog with nothing to say why.
 * `NODE_GLYPHS`' refusal of a pack redrawing a built-in type is the precedent.
 */

import type { Wire } from '../core/graph'
import { nodeTypeProblem, packOf } from '../core/nodeType'
import type { Placement } from './build'
import type { ViewSpec, VisualisationId, WizardOption } from './options'

/** An answer a pack adds: `<pack>:<name>`, never a built-in's spelling. */
export type ContributedId = `${string}:${string}`

/** What a start's builder is handed: where its one card goes and what it reads from. */
export interface HeadContext {
  /** The card's id, suffixed per dataset — `id('gallery')` is `gallery`, then `gallery2`. */
  id(base: string): string
  /** The dataset node this head reads from. */
  datasetId: string
  /** The row this dataset's band is laid out on. */
  row: number
}

/** A start's output: its card, the port its neurons leave by, and the wires into it. */
export interface HeadPart {
  node: Placement
  port: [nodeId: string, portId: string]
  links: Wire[]
}

/** What an analysis' builder is handed: the chosen answers, and the helpers every arm uses. */
export interface BodyContext {
  /** The dataset node. */
  datasetId: string
  /** A wire from the chosen neurons into `to`'s `toPort`. */
  neurons(to: string, toPort: string): Wire
  /**
   * The ticked viewers as cards on `baseRow`, each wired by `wire` — the viewer's node and params
   * are the analysis' `views` entry, so the builder says only what feeds each one.
   */
  views(baseRow: number, wire: (visualisation: VisualisationId, id: string) => Wire[]): BodyPart
}

/** An analysis' output: its cards (viewers included), the wires, and the first viewer's id. */
export interface BodyPart {
  nodes: Placement[]
  links: Wire[]
  viewId: string | undefined
}

/** A way of choosing neurons: the option the dialog shows, and the card it builds. */
export interface StartContribution extends WizardOption<ContributedId> {
  head(context: HeadContext): HeadPart
}

/** A single-dataset technique: the option, the viewers it can end on, and the chain it builds. */
export interface AnalysisContribution extends WizardOption<ContributedId> {
  /** The viewers it can end on, and the node each is — in the order the dialog offers them. */
  views: Partial<Record<VisualisationId, ViewSpec>>
  body(context: BodyContext): BodyPart
}

export interface WizardContribution {
  starts?: readonly StartContribution[]
  analyses?: readonly AnalysisContribution[]
  /** The dialog's row for each viewer this pack adds; its node is its analysis' `views` entry. */
  visualisations?: readonly WizardOption<ContributedId>[]
}

const FILES = import.meta.glob('../packs/*/wizard.ts', {
  eager: true,
  import: 'default',
}) as Record<string, WizardContribution>

/**
 * The contributions, checked: each id `<pack>:<name>` for the file's own pack, and no id offered
 * twice. Exported so a test can merge a file list of its own.
 */
export function mergeContributions(
  files: Record<string, WizardContribution>,
): Required<WizardContribution> {
  const merged = {
    starts: [] as StartContribution[],
    analyses: [] as AnalysisContribution[],
    visualisations: [] as WizardOption<ContributedId>[],
  }
  const seen = new Set<string>()
  for (const [path, contribution] of Object.entries(files)) {
    const pack = /packs\/([^/]+)\/wizard\.ts$/.exec(path)?.[1]
    const claim = <T extends { id: string }>(list: T[], items: readonly T[] | undefined) => {
      for (const item of items ?? []) {
        if (nodeTypeProblem(item.id) || packOf(item.id) !== pack) {
          throw new Error(
            `${path}: "${item.id}" is not an answer of pack "${pack}" ("${pack}:<name>").`,
          )
        }
        if (seen.has(item.id)) throw new Error(`${path}: "${item.id}" is offered twice.`)
        seen.add(item.id)
        list.push(item)
      }
    }
    claim(merged.starts, contribution.starts)
    claim(merged.analyses, contribution.analyses)
    claim(merged.visualisations, contribution.visualisations)
  }
  return merged
}

export const CONTRIBUTIONS: Required<WizardContribution> = mergeContributions(FILES)
