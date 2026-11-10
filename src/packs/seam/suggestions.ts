/**
 * Merge Suggestions: read a set of SEAM's merge candidates and publish it as a queue.
 *
 * ## The direction of the error
 *
 * This node is about **false splits** — a neuron that stops at a tip where a separate piece of
 * segmentation is very likely its continuation, and the fix is a merge. The pack's other two
 * nodes look for false *merges* and are retired. "Find Merges finds false merges; Merge
 * Suggestions suggests merges" is the sentence to keep hold of.
 *
 * ## It reads a set; it does not compute one
 *
 * SEAM's pipeline is nine stages, four of which need models that are not exported for the browser
 * yet. This node reads what that pipeline produced — the manifest, the tips, the kept candidate
 * lists — and publishes them. Everything it shows was decided on the cluster, and the manifest
 * says by which commit, at which snapshot.
 *
 * That is deliberate rather than provisional. The stages move into the browser one at a time
 * (`docs/seam-suggestions-plan.md`), each checked against this same fixture, and every one of
 * them ends by producing exactly the tables this node already publishes. The queue a reader works
 * through never changes shape.
 *
 * ## No filter, and the reason is the last node
 *
 * `shown` is SEAM's absolute cutoff applied (invariant 14) and `r` is on every row. There is no
 * threshold param here: narrowing is a `Filter Table` on `shown` or `r`, where the cut is visible
 * as something somebody did. `seam:findMerges` is why — its `Score cutoff` was a cut inside an
 * expensive node, which made every nudge a re-run and made a discarded answer look like a verdict
 * the model had given.
 *
 * ## Read-only
 *
 * SEAM suggests; the proofreader makes the merge with their own tools and their own token. This
 * node fetches files over HTTP and nothing else.
 */

import { packNode } from '../../core/registry'
import { ID_COLUMN_NAME } from '../../core/ids'
import { T } from '../../core/types'
import type { CellValue, LayersValue, PointsValue, TableValue } from '../../core/values'
import { boundsOf, layersFrom } from '../../core/values'
import { plural } from '../../style/format'
import type { Suggestion } from './scene'
import { suggestionLayer } from './scene'
import { fetchText } from '../../data/fetchText'
import {
  entryById,
  entryLabel,
  parseSuggestionIndex,
  peekSuggestions,
  suggestionsAddress,
} from './suggestionIndex'
import { CANDIDATES_FILE, TIPS_FILE, fileUrl, loadSuggestionSet } from './suggestionSet'
import type { SuggestionSet } from './suggestionSet'
import { openOverHttp, readFields } from './suggestionRead'
import type { OpenFile } from './suggestionRead'
import type { NeuronTips } from './suggestionTables'
import {
  CANDIDATE_FIELDS,
  FIRST_CANDIDATE,
  TIP_FIELDS,
  neuronsSchema,
  neuronsTable,
  schemaOf,
  tableOf,
} from './suggestionTables'

/** Where the tips land on the progress bar; the candidate file is thirty times larger. */
const TIPS_SHARE = 0.25

export const suggestionsNode = packNode({
  type: 'seam:suggestions',
  label: 'Merge Suggestions',
  category: 'query',
  description:
    'Reads a set of SEAM’s merge suggestions — places a neuron stops where a nearby piece of segmentation is probably its continuation — as a queue of tips with their ranked candidates.',
  guide:
    'Reads SEAM’s merge candidates for a set of neurons from a published suggestion set. Each ' +
    'row is a tip, with the piece SEAM would merge into it, how likely that is to be right, and ' +
    'whether it clears SEAM’s own cutoff. Nothing is computed here and nothing is written: the ' +
    'merge is the proofreader’s, in the Neuroglancer card.',
  cost: 'expensive',

  inputs: [{ id: 'layers', label: 'Layers', type: T.layers(), required: false }],
  outputs: [
    { id: 'tips', label: 'Tips', type: T.table() },
    { id: 'candidates', label: 'Candidates', type: T.table() },
    { id: 'points', label: 'Points', type: T.points() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
    { id: 'layers', label: 'Layers', type: T.layers() },
  ],
  params: [
    {
      id: 'url',
      kind: 'string',
      label: 'Suggestions',
      default: '',
      placeholder:
        'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/suggestions/aedes/index.json',
      help: 'The address of a directory of suggestion sets, or of one set’s manifest directly. A directory is read through its `index.json`, which is filled in for you if you paste the directory itself. Pick which of its sets to read in `Set`.',
    },
    {
      /*
       * An enum whose options come from a *peek* of the address, which is how every dataset
       * picker in Coda is filled: invariant 2 forbids fetching from the edit-time path, so the
       * options read a memo that starts the fetch it cannot answer and fires
       * `reportSourceLearned` when it lands.
       *
       * Deliberately **not** `visibleIf` the address is an index. A hidden param drops out of
       * the provenance key, and whether an address is an index is not known until the peek
       * resolves — so hiding this would mean the key changing shape when a fetch landed. It is
       * always here, and empty is what a single-manifest address means.
       */
      id: 'set',
      kind: 'enum',
      label: 'Set',
      default: '',
      options: (ctx) => {
        const peek = peekSuggestions(String(ctx.params.url ?? ''))
        if (peek.state !== 'index') return []
        return peek.index.sets.map((entry) => ({ value: entry.id, label: entryLabel(entry) }))
      },
      help: 'Which of the directory’s sets to read. A card holds the set it was pointed at, so a newer one appearing in the directory changes nothing until you pick it — and a run months later reads the same files. Leave empty when `Suggestions` is one set’s manifest.',
    },
    {
      id: 'layerName',
      kind: 'string',
      label: 'Layer name',
      default: '',
      advanced: true,
      placeholder: 'merge suggestions',
      help: 'The annotation layer’s name in neuroglancer.',
    },
  ],

  inferOutputs: () => ({
    tips: T.table(schemaOf(TIP_FIELDS)),
    candidates: T.table(schemaOf(CANDIDATE_FIELDS)),
    points: T.points(schemaOf(TIP_FIELDS)),
    neurons: T.neurons(neuronsSchema()),
    layers: T.layers(),
  }),

  validate: (ctx) => {
    const url = String(ctx.params.url).trim()
    if (!url) {
      return ['Paste the address of a directory of suggestion sets, or of one set’s manifest.']
    }
    if (!/^https?:\/\//i.test(url)) return ['`Suggestions` must be an http or https address.']
    const chosen = String(ctx.params.set).trim()
    const peek = peekSuggestions(url)
    // `pending` says nothing: a card that has not finished looking is not a card with a problem.
    if (peek.state === 'failed') return [`That address could not be read: ${peek.why}`]
    if (peek.state === 'single') {
      return chosen
        ? ['That address is one set’s manifest, so `Set` has nothing to choose from. Clear it.']
        : []
    }
    if (peek.state !== 'index') return []
    if (!chosen) return [pickOne(peek.index.sets)]
    return entryById(peek.index, chosen)
      ? []
      : [`That directory has no set called “${chosen}”. ${pickOne(peek.index.sets)}`]
  },

  evaluate: async (ctx) => {
    const url = String(ctx.params.url).trim()
    if (!url) {
      throw new Error(
        'No suggestions. Paste the address of a directory of sets, or of one set.',
      )
    }

    ctx.progress(0, 'reading the suggestion set')
    const set = await loadSuggestionSet(
      await chosenManifest(url, String(ctx.params.set), ctx.signal),
      ctx.signal,
    )
    const built = await readSuggestions(
      set,
      openOverHttp((file) => fileUrl(set, file)),
      {
        signal: ctx.signal,
        onProgress: (fraction, note) => ctx.progress(fraction, note),
      },
    )
    warnOnCounts(ctx, set, built)
    if (built.damaged > 0 || built.stray > 0) {
      ctx.warn(
        `This set's ids do not check out, which has one known cause: an id that has been through ` +
          `a 64-bit float names a different segment, and does so silently. ` +
          (built.damaged > 0
            ? `${built.damaged.toLocaleString()} tips disagree with their own candidate list about ` +
              `the first candidate — \`candidateId\` is the sound one, joined from the lists. `
            : '') +
          (built.stray > 0
            ? `${built.stray.toLocaleString()} judged ids name nothing among their neuron's ` +
              `candidates. `
            : '') +
          `Ask whoever published the set to regenerate it.`,
      )
    }

    const name = String(ctx.params.layerName).trim() || 'merge suggestions'
    const layer = suggestionLayer(built.suggestions, name)
    if (layer.dropped > 0) {
      ctx.warn(
        `The neuroglancer layer draws the first ${plural(layer.drawn / 2, 'suggestion')} and ` +
          `leaves ${(layer.dropped / 2).toLocaleString()} out — a local annotation layer of more ` +
          `than that does not draw at a usable frame rate. The Tips output is whole.`,
      )
    }
    return {
      tips: built.tips,
      candidates: built.candidates,
      points: built.points,
      neurons: built.neurons,
      layers: {
        kind: 'layers',
        items: [...layersFrom(ctx.input('layers')), layer.layer],
      } satisfies LayersValue,
    }
  },
})

/**
 * Which manifest this card means, resolving the directory where its address is one.
 *
 * `evaluate` may fetch, so this does not go through the edit-time peek — it reads the address
 * afresh. That is not a second implementation of the peek's decision: both ask the same question
 * of the same document (`sets` or `pipeline`), and a run that disagreed with the card would be
 * reading a directory that had changed under it, which is exactly the thing worth finding out
 * from the run rather than from a memo.
 */
async function chosenManifest(
  raw: string,
  set: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const chosen = set.trim()
  const url = suggestionsAddress(raw)
  const text = await fetchText(url, { signal })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${url} is not JSON.`)
  }
  const root = (json ?? {}) as { sets?: unknown; pipeline?: unknown }
  // A single set's manifest: read where it is, and say so if a set was named as well, since a
  // card quietly ignoring one of its own controls is worse than one that refuses.
  if (!Array.isArray(root.sets)) {
    if (!root.pipeline) {
      throw new Error(
        `${url} is neither a suggestion set's manifest (which has \`pipeline\`) nor a ` +
          `directory index (which has \`sets\`).`,
      )
    }
    if (chosen) {
      throw new Error(
        `${url} is one set's manifest, so there is nothing for \`Set\` to choose. Clear it, or ` +
          `point \`Suggestions\` at a directory's index.`,
      )
    }
    return url
  }
  const index = parseSuggestionIndex(json, url)
  if (!chosen) throw new Error(pickOne(index.sets))
  const entry = entryById(index, chosen)
  if (!entry) {
    throw new Error(`That directory has no set called “${chosen}”. ${pickOne(index.sets)}`)
  }
  return new URL(entry.path, url).toString()
}

/** The one sentence both surfaces say when a directory needs a set chosen out of it. */
function pickOne(sets: readonly { id: string }[]): string {
  if (sets.length === 0) return 'That directory lists no suggestion sets.'
  return `Choose one of its sets in \`Set\`: ${sets.map((s) => s.id).join(', ')}.`
}

export interface BuiltSuggestions {
  readonly tips: TableValue
  readonly candidates: TableValue
  readonly points: PointsValue
  readonly neurons: TableValue
  /** The shown suggestions only — what the layer draws. */
  readonly suggestions: readonly Suggestion[]
  readonly shown: number
  /** Tips whose own copy of the first candidate's id disagrees with the candidates table. */
  readonly damaged: number
  /** Judged candidate ids naming nothing among their neuron's candidates. */
  readonly stray: number
}

/**
 * Read a set's two files and fold them into the node's outputs.
 *
 * Separated from `evaluate` and given its opener, so a test reads the committed fixture from a
 * blob over the same code the node runs over HTTP. A test that stubbed this function instead
 * would check the folding and nothing about the reading, which is where the failures are.
 */
export async function readSuggestions(
  set: SuggestionSet,
  open: OpenFile,
  options: {
    signal?: AbortSignal
    onProgress?: (fraction: number, note?: string) => void
  } = {},
): Promise<BuiltSuggestions> {
  const { signal } = options
  const tipReader = await open(TIPS_FILE, signal)
  const tipRead = await readFields(tipReader, TIP_FIELDS, 'The tips file', {
    ...(signal ? { signal } : {}),
    onProgress: (f) => options.onProgress?.(f * TIPS_SHARE, 'reading the tips'),
  })

  const candidateReader = await open(CANDIDATES_FILE, signal)
  const candidateRead = await readFields(
    candidateReader,
    CANDIDATE_FIELDS,
    'The candidates file',
    {
      ...(signal ? { signal } : {}),
      onProgress: (f) =>
        options.onProgress?.(TIPS_SHARE + f * (1 - TIPS_SHARE), 'reading the candidate lists'),
    },
  )
  const candidates = tableOf(CANDIDATE_FIELDS, candidateRead.data)

  /*
   * The first candidate's id, joined from the table where it is authoritative, and the two
   * checks SEAM's exporter now runs before writing — run again here, on read.
   *
   * Both exist because of one incident. The tips file's own copy of this id had been through a
   * float64 (a `Series.map` over a nullable `Int64` column, which pandas hands floats), so 2,661
   * of 2,691 values named a different segment. It was a *string* column of *rounded* ids, which
   * is why "every id is a string column" did not catch it, and nothing downstream could have.
   *
   * SEAM fixed the exporter and checks both properties before writing. Checking them again on
   * read is not distrust: it is the only place a *reader* can see the failure, and the next set
   * will be written by a pipeline nobody here runs.
   */
  const first = firstCandidates(candidateRead.data)
  const damaged = fillFirstCandidate(tipRead.data, first)
  const stray = strayVerdicts(tipRead.data, candidateRead.data)
  const tips = tableOf(TIP_FIELDS, tipRead.data)

  // Read from the published table rather than from the file's own columns, so the positions the
  // cloud draws and the positions the `Tips` table reports cannot come apart.
  const ids = tips.data[ID_COLUMN_NAME] ?? []
  const positions = new Float32Array(tips.length * 3)
  const perNeuron = new Map<string, { tips: number; shown: number; expectedRight: number }>()
  const suggestions: Suggestion[] = []
  let shown = 0
  for (let i = 0; i < tips.length; i++) {
    const id = String(ids[i] ?? '')
    const tip = triple(tips, 'x', 'y', 'z', i)
    positions[i * 3] = tip[0]
    positions[i * 3 + 1] = tip[1]
    positions[i * 3 + 2] = tip[2]

    const r = numberAt(tips, 'r', i) ?? 0
    const isShown = tips.data['shown']?.[i] === true
    const held = perNeuron.get(id) ?? { tips: 0, shown: 0, expectedRight: 0 }
    held.tips += 1
    if (isShown) {
      held.shown += 1
      // Summed over the shown rows only: r is the chance a *shown* first is right, and the
      // handoff's "expected right firsts per neuron" is the sum over what was shown.
      held.expectedRight += r
    }
    perNeuron.set(id, held)
    if (!isShown) continue
    shown += 1
    const candidateId = String(tips.data['candidateId']?.[i] ?? '')
    const contact = triple(tips, 'contact_x', 'contact_y', 'contact_z', i)
    suggestions.push({
      neuronId: id,
      endUid: numberAt(tips, 'end_uid', i) ?? -1,
      tipNm: tip,
      contactNm: contact,
      candidateId,
      r,
    })
  }

  const points: PointsValue = {
    kind: 'points',
    positions,
    attributes: tips,
    bounds: boundsOf([positions]),
    units: 'nm',
  }
  return {
    tips,
    candidates,
    points,
    neurons: neuronsTable(set.neurons, perNeuron as ReadonlyMap<string, NeuronTips>),
    suggestions,
    shown,
    damaged,
    stray,
  }
}

/**
 * Judged candidate ids that name no candidate of their own neuron.
 *
 * SEAM's exporter checks a tip's judged ids against *that tip's* list. This checks them against
 * the **neuron's**, which is deliberately weaker, because the stricter form has two honest
 * failures in rv2: a reviewer looking at tip 12 marked two pieces that sit on tip 15's list, the
 * two tips being neighbours on one neuron. That is a reviewer using their eyes rather than a
 * corrupted id, and a warning about it would be noise.
 *
 * A *rounded* id, by contrast, names nothing anywhere — which is exactly what this catches.
 */
function strayVerdicts(
  tips: Readonly<Record<string, CellValue[]>>,
  candidates: Readonly<Record<string, CellValue[]>>,
): number {
  const known = new Map<string, Set<string>>()
  const candNeurons = candidates['neuron'] ?? []
  const roots = candidates['cand_root'] ?? []
  for (let i = 0; i < candNeurons.length; i++) {
    const neuron = candNeurons[i]
    const root = roots[i]
    if (typeof neuron !== 'string' || typeof root !== 'string') continue
    let held = known.get(neuron)
    if (!held) known.set(neuron, (held = new Set()))
    held.add(root)
  }
  const neurons = tips['neuron'] ?? []
  let stray = 0
  for (const column of ['belongs', 'not_belongs']) {
    const cells = tips[column] ?? []
    for (let i = 0; i < cells.length; i++) {
      const text = cells[i]
      const neuron = neurons[i]
      // Empty is "judged, nothing belongs" and null is "nobody looked"; neither names an id.
      if (typeof text !== 'string' || !text || typeof neuron !== 'string') continue
      const held = known.get(neuron)
      for (const id of text.split(';')) if (id && !held?.has(id)) stray += 1
    }
  }
  return stray
}

/** The rank-1 candidate's root id per tip, keyed by `end_uid`. */
function firstCandidates(read: Readonly<Record<string, CellValue[]>>): Map<number, string> {
  const ends = read['end_uid'] ?? []
  const ranks = read['rank'] ?? []
  const roots = read['cand_root'] ?? []
  const first = new Map<number, string>()
  for (let i = 0; i < ends.length; i++) {
    if (ranks[i] !== 1) continue
    const end = ends[i]
    const root = roots[i]
    if (typeof end === 'number' && typeof root === 'string') first.set(end, root)
  }
  return first
}

/**
 * Write the joined id into the tips read, and count how many disagree with the file's own copy.
 *
 * Counted rather than thrown on: the set is still readable and every other column of it is
 * right, so the useful thing is to publish the sound id and say how much of the copy was wrong.
 * A tip with no candidate list has neither, which is not a disagreement.
 */
function fillFirstCandidate(
  read: Record<string, CellValue[]>,
  first: ReadonlyMap<number, string>,
): number {
  const ends = read['end_uid'] ?? []
  const said = read['top_cand_root'] ?? []
  const out: CellValue[] = []
  let damaged = 0
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i]
    const root = typeof end === 'number' ? first.get(end) : undefined
    out.push(root ?? null)
    if (root !== undefined && said[i] !== null && said[i] !== root) damaged += 1
  }
  read[FIRST_CANDIDATE] = out
  return damaged
}

function numberAt(table: TableValue, name: string, row: number): number | undefined {
  const cell = table.data[name]?.[row]
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : undefined
}

function triple(
  table: TableValue,
  x: string,
  y: string,
  z: string,
  row: number,
): [number, number, number] {
  return [
    numberAt(table, x, row) ?? 0,
    numberAt(table, y, row) ?? 0,
    numberAt(table, z, row) ?? 0,
  ]
}

/**
 * Compare what was read with what the manifest says the set holds.
 *
 * The manifest carries `counts`, so this node can check itself — and a mismatch is the failure a
 * reader could not otherwise see: a file half-replaced, a directory holding one run's manifest
 * beside another's tips, a truncated upload. Warned rather than refused, because the tables are
 * still readable and saying "the set says 2,708 tips and the file holds 2,690" is more use than
 * refusing to show either.
 */
function warnOnCounts(
  ctx: { warn: (message: string) => void },
  set: SuggestionSet,
  built: BuiltSuggestions,
): void {
  const seen = [
    ['tips', set.counts.tips, built.tips.length],
    ['candidates', set.counts.candidates, built.candidates.length],
    ['shown', set.counts.shown, built.shown],
  ] as const
  const off = seen.filter(([, said, got]) => said !== got)
  if (off.length === 0) return
  ctx.warn(
    `This suggestion set does not match its own manifest: ` +
      off.map(([what, said, got]) => `${what} says ${said} and ${got} were read`).join(', ') +
      `. The manifest is from SEAM commit ${set.commit}; the files beside it may be from ` +
      `another run.`,
  )
}
