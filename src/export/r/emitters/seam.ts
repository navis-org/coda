/**
 * `Merge Suggestions`, in arrow and dplyr.
 *
 * The Python emitter's reasoning applies unchanged: a suggestion set is two parquet files and a
 * manifest at a URL, with no model to run and nothing to reproduce, so the document reads exactly
 * what the card read. The column lists come from the node (`suggestionTables.ts`) rather than
 * being copied here, for `googleSheet.ts`' reason.
 *
 * **The files are downloaded before they are read.** `arrow::read_parquet` wants something it can
 * seek, and a `url()` connection in R is a stream — so a direct read either fails or, worse,
 * quietly reads only what came down the pipe. `download.file(mode = "wb")` into a tempfile is the
 * boring route that works, and the binary mode is load-bearing on Windows.
 *
 * **Checked by running it.** Both cells were executed against `packs/seam/__fixtures__` and give
 * the same `expectedRight` per neuron as the node — 1.8199, 1.8199, 1.7648, 1.8199, 1.7648 — and
 * the same joined `candidateId`, which `suggestions.test.ts` pins. That check is not ceremony:
 * the R chunk disagreed on first writing, and this list is re-measured on each recut of the
 * fixtures: it was left behind by the 2026-11-10 one, which is how a header stating numbers
 * nobody re-ran reads for months.
 */

import { ID_COLUMN_NAME } from '../../../core/ids'
import { suggestionsAddress } from '../../../packs/seam/suggestionIndex'
import { FIRST_CANDIDATE } from '../../../packs/seam/suggestionTables'
import type { Field } from '../../../packs/seam/suggestionTables'
import { CANDIDATE_FIELDS, TIP_FIELDS } from '../../../packs/seam/suggestionTables'
import { rCol, rStr, rVector } from '../r'
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
  ctx.library('arrow')
  ctx.library('dplyr')

  const base = `${ctx.name}_base`
  const tips = ctx.output('tips')
  const candidates = ctx.output('candidates')
  const neurons = ctx.output('neurons')

  return [
    ...resolve(ctx, base, url, String(ctx.params['set'] ?? '').trim()),
    ``,
    ...read(tips, base, 'tips.parquet', TIP_FIELDS),
    ``,
    ...read(candidates, base, 'candidates.parquet', CANDIDATE_FIELDS),
    ``,
    `# The first candidate's id, joined from the candidate lists rather than taken from the tips`,
    `# file's own copy. The copy is a denormalised 18-digit id, and in the set as first published`,
    `# it had been through a float64 and named a different segment on 2,661 of 2,691 rows. Fixed`,
    `# upstream; joined here so it cannot come back.`,
    `${tips} <- dplyr::left_join(`,
    `  ${tips},`,
    `  dplyr::select(dplyr::filter(${candidates}, rank == 1), end_uid, candidateId),`,
    `  by = "end_uid"`,
    `)`,
    ``,
    `# One row per neuron. r is the chance a shown first candidate is right, so its sum over the`,
    `# shown rows is how many of them to expect to be real.`,
    `#`,
    `# The two sums are prepared before the grouping rather than written inside summarise(), and`,
    `# that is not style. dplyr evaluates a summarise() argument list in order and each name it`,
    `# binds shadows the column of that name, so an expectedRight written after shown = sum(shown)`,
    `# reads the *scalar* count: ifelse() then takes a length-one condition and returns one`,
    `# element, making the total the first row's r. It is a plausible number and it is wrong.`,
    `${neurons} <- ${tips} |>`,
    `  dplyr::mutate(`,
    `    .shown = as.integer(shown),`,
    `    .right = ifelse(shown, r, 0)`,
    `  ) |>`,
    `  dplyr::group_by(${rCol(ID_COLUMN_NAME)}) |>`,
    `  dplyr::summarise(`,
    `    tips = dplyr::n(),`,
    `    shown = sum(.shown),`,
    `    expectedRight = sum(.right)`,
    `  )`,
    ...ctx.note(
      'The Points and Layers outputs are the same tips drawn — a cloud and a neuroglancer ' +
        'annotation layer. Their coordinates are the `x`, `y` and `z` columns of the tips frame.',
    ),
  ]
})

/** The Python emitter's `resolve`, in jsonlite. Its reasoning applies unchanged. */
function resolve(ctx: EmitContext, base: string, url: string, set: string): string[] {
  if (!set) {
    return [
      `# One set's manifest; its files sit beside it.`,
      `${base} <- sub("[^/]*$", "", ${rStr(url)})`,
    ]
  }
  ctx.library('jsonlite')
  return [
    `# A directory of suggestion sets. The card pins one by id, so look that id up rather than`,
    `# baking in the path it had when this was exported.`,
    `${base}_sets <- jsonlite::fromJSON(${rStr(url)}, simplifyDataFrame = FALSE)$sets`,
    `${base} <- sub("[^/]*$", "", ${rStr(url)})`,
    `${base} <- paste0(`,
    `  ${base},`,
    `  Filter(function(s) s$id == ${rStr(set)}, ${base}_sets)[[1]]$path`,
    `)`,
    `${base} <- sub("[^/]*$", "", ${base})`,
  ]
}

/**
 * Read one of the set's files, keeping its declared columns and renaming them as the card does.
 *
 * `col_select` rather than reading the file whole: a suggestion set carries columns this node
 * does not publish, and a frame with more columns than the card is one nobody can compare with
 * the card. The rename is positional against that same list, so the two cannot come apart.
 */
function read(into: string, base: string, file: string, fields: readonly Field[]): string[] {
  // The joined column is not in the file; see `FIRST_CANDIDATE`.
  const held = fields.filter((field) => field.from !== FIRST_CANDIDATE)
  const tmp = `${into}_file`
  return [
    `${tmp} <- tempfile(fileext = ".parquet")`,
    `download.file(paste0(${base}, ${rStr(file)}), ${tmp}, mode = "wb", quiet = TRUE)`,
    `${into} <- arrow::read_parquet(`,
    `  ${tmp},`,
    `  col_select = dplyr::all_of(${rVector(held.map((f) => f.from))})`,
    `)`,
    `names(${into}) <- ${rVector(held.map((f) => f.name))}`,
  ]
}
