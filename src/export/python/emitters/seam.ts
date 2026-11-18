/**
 * `Merge Suggestions`, in pandas.
 *
 * The one node in the SEAM pack with a faithful translation, and the reason is what it does *not*
 * do: no model, no GPU, no sampler to reproduce. A suggestion set is two parquet files and a
 * manifest at a URL, so the cell reads exactly what the card read, and the numbers in a notebook
 * are the numbers on the canvas rather than that notebook's GPU's.
 *
 * **The column lists come from the node**, not from a copy of them here. `TIP_FIELDS` and
 * `CANDIDATE_FIELDS` are what the card publishes; a second list in this file is how a column
 * renamed on the canvas quietly keeps its old name in every exported notebook. `src/export →
 * src/packs` is the same licensed direction as `src/export → src/data` (see `googleSheet.ts`),
 * and licensed for the same reason: several consumers have to agree, and agreement by copying is
 * how they stop agreeing.
 *
 * **`Points` and `Layers` are not emitted and the cell says so.** They are the same tips in a
 * drawing's shape — a cloud and a neuroglancer annotation layer — and a reader with the `Tips`
 * frame has their coordinates in three columns.
 *
 * **Checked by running it.** Both cells were executed against `packs/seam/__fixtures__` and give
 * the same `tips` and `shown` per neuron as the node and the same joined `candidateId`, which
 * `suggestions.test.ts` pins. That check is not ceremony: the R chunk disagreed on first writing
 * (over `expectedRight`, the sum of `r` that all three dropped on 2026-11-18 at SEAM's word), and
 * both have been re-run on each recut of the fixtures (2026-11-10, 2026-11-11 for SEAM's `za`
 * refit, 2026-11-14 for nest 3, and 2026-11-18) rather than the node's new answer being taken as
 * all three.
 */

import { ID_COLUMN_NAME } from '../../../core/ids'
import { suggestionsAddress } from '../../../packs/seam/suggestionIndex'
import type { Field } from '../../../packs/seam/suggestionTables'
import {
  CANDIDATE_FIELDS,
  SET_SOURCE_PREFIX,
  SOURCE_COLUMN,
  TIP_FIELDS,
} from '../../../packs/seam/suggestionTables'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

registerEmitter('seam:suggestions', (ctx: EmitContext) => {
  // Through the node's own normaliser, so a card holding a directory's address exports a cell
  // that reads the file the card read. A second rule here is how the two come to disagree.
  const url = suggestionsAddress(String(ctx.params['url'] ?? ''))
  if (!url) {
    return ctx.todo(
      'This Merge Suggestions card has no suggestion set yet — paste the address of SEAM’s ' +
        '`fixture.json` into it and export again.',
    )
  }
  ctx.require('pandas')

  const manifest = `${ctx.name}_manifest`
  const base = `${ctx.name}_base`
  const version = `${ctx.name}_version`
  const tips = ctx.output('tips')
  const candidates = ctx.output('candidates')
  const neurons = ctx.output('neurons')

  return [
    ...resolve(manifest, url, String(ctx.params['set'] ?? '').trim()),
    `${base} = ${manifest}.rsplit("/", 1)[0] + "/"`,
    ``,
    ...read(tips, base, 'tips.parquet', TIP_FIELDS),
    ``,
    ...read(candidates, base, 'candidates.parquet', CANDIDATE_FIELDS),
    ``,
    `# The first candidate's id, joined from the candidate lists rather than taken from the tips`,
    `# file's own copy. The copy is a denormalised 18-digit id, and in the set as first published`,
    `# it had been through a float64 and named a different segment on 2,661 of 2,691 rows. Fixed`,
    `# upstream; joined here so it cannot come back.`,
    `${tips} = ${tips}.merge(`,
    `    ${candidates}.loc[${candidates}["rank"] == 1, ["end_uid", "candidateId"]],`,
    `    on="end_uid", how="left", validate="one_to_one",`,
    `)`,
    ``,
    `# Which set these numbers are, as the card labels them: q, the cutoff and r belong to this`,
    `# version of the set, and are never to be read against another's.`,
    `${version} = pd.read_json(${manifest}, typ="series").get("version")`,
    `${tips}[${pyStr(SOURCE_COLUMN)}] = (`,
    `    ${pyStr(SET_SOURCE_PREFIX)} + ${version} if isinstance(${version}, str) and ${version} else None`,
    `)`,
    ``,
    `# One row per neuron: its tips, and how many of them clear the cutoff. Sort the tips by q,`,
    `# never r: r is a staircase over q, and SEAM advises against summing it.`,
    `${neurons} = (`,
    `    ${tips}.assign(_shown=${tips}["shown"].astype(int))`,
    `    .groupby(${pyStr(ID_COLUMN_NAME)}, as_index=False)`,
    `    .agg(tips=(${pyStr(ID_COLUMN_NAME)}, "size"), shown=("_shown", "sum"))`,
    `)`,
    ...ctx.note(
      'The Points and Layers outputs are the same tips drawn — a cloud and a neuroglancer ' +
        'annotation layer. Their coordinates are the `x`, `y` and `z` columns of the tips frame.',
    ),
  ]
})

/**
 * Where the set's files are, which depends on which kind of address the card holds.
 *
 * A directory is resolved **at runtime, by id**, exactly as the card does: the notebook reads the
 * index and looks the chosen set up in it. Baking the resolved path in at export time would be
 * shorter and would quietly stop agreeing with the card the first time a pipeline rewrote a
 * set's path — and the id is what both are pinned to, so looking it up is also what makes the
 * two provably the same set.
 */
function resolve(manifest: string, url: string, set: string): string[] {
  if (!set)
    return [`# One set's manifest; its files sit beside it.`, `${manifest} = ${pyStr(url)}`]
  return [
    `# A directory of suggestion sets. The card pins one by id, so look that id up rather than`,
    `# baking in the path it had when this was exported.`,
    `${manifest} = ${pyStr(url)}.rsplit("/", 1)[0] + "/" + next(`,
    `    s["path"] for s in pd.read_json(${pyStr(url)}, typ="series")["sets"]`,
    `    if s["id"] == ${pyStr(set)}`,
    `)`,
  ]
}

/**
 * Read one of the set's files, keeping its declared columns and renaming them as the card does.
 *
 * The columns are listed rather than read whole: a suggestion set carries columns this node does
 * not publish, and a notebook whose frame has more columns than the card is a frame nobody can
 * compare with the card.
 *
 * `dtype_backend` is left alone on purpose — SEAM writes every id as a string column, which
 * pandas reads as `object`, and that is the one property this cell must not lose. A root id
 * through a float names a different neuron (invariant 8).
 */
function read(into: string, base: string, file: string, fields: readonly Field[]): string[] {
  // The columns the loader fills in itself are not in the file; see `Field.filled`.
  const held = fields.filter((field) => !field.filled)
  const renames = held.filter((field) => field.from !== field.name)
  const columns = pyList(held.map((field) => field.from))
  /*
   * **A column SEAM added later (`Field.optional`) is null where the set predates it**, as on the
   * card. `columns=` refuses a name the file lacks, so the file is read whole, the late columns
   * filled where missing, and the selection made after — where a missing *required* column
   * still stops the cell by name, as the card refuses it. Whole costs nothing extra over a URL:
   * pandas downloads all of it either way.
   */
  const late = held.filter((field) => field.optional).map((field) => field.from)
  const reading =
    late.length === 0
      ? [`${into} = pd.read_parquet(${base} + ${pyStr(file)}, columns=${columns})`]
      : [
          `${into} = pd.read_parquet(${base} + ${pyStr(file)})`,
          `# Null where the set predates them, as on the card.`,
          `for column in ${pyList(late)}:`,
          `    if column not in ${into}:`,
          `        ${into}[column] = None`,
          `${into} = ${into}[${columns}]`,
        ]
  return [
    ...reading,
    `${into} = ${into}.rename(columns={${renames
      .map((field) => `${pyStr(field.from)}: ${pyStr(field.name)}`)
      .join(', ')}})`,
  ]
}
