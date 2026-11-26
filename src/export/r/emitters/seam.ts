/**
 * `Load Merge Candidates`, in arrow and dplyr.
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
 * the same `tips` and `shown` per neuron as the node and the same joined `candidateId`, which
 * `suggestions.test.ts` pins. That check is not ceremony: the R chunk disagreed on first writing
 * (over `expectedRight`, the sum of `r` that all three dropped on 2026-11-18 at SEAM's word), and
 * it is re-run on each recut of the fixtures (2026-11-10, 2026-11-11, 2026-11-14, 2026-11-18).
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
import { rCol, rStr, rVector } from '../r'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

registerEmitter('seam:loadMergeCandidates', (ctx: EmitContext) => {
  // Through the node's own normaliser, so a card holding a directory's address exports a cell
  // that reads the file the card read. A second rule here is how the two come to disagree.
  const url = suggestionsAddress(String(ctx.params['url'] ?? ''))
  if (!url) {
    return ctx.todo(
      'This Load Merge Candidates card has no suggestion set yet — paste the address of SEAM’s ' +
        '`fixture.json` into it and export again.',
    )
  }
  ctx.library('arrow')
  ctx.library('dplyr')
  ctx.library('jsonlite')

  const manifest = `${ctx.name}_manifest`
  const base = `${ctx.name}_base`
  const version = `${ctx.name}_version`
  const tips = ctx.output('tips')
  const candidates = ctx.output('candidates')
  const neurons = ctx.output('neurons')

  return [
    ...resolve(manifest, url, String(ctx.params['set'] ?? '').trim()),
    `${base} <- sub("[^/]*$", "", ${manifest})`,
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
    `# Which set these numbers are, as the card labels them: q, the cutoff and r belong to this`,
    `# version of the set, and are never to be read against another's.`,
    // `[[`, not `$`, which would take a key that merely starts with "version".
    `${version} <- jsonlite::fromJSON(${manifest})[["version"]]`,
    `${tips}[[${rStr(SOURCE_COLUMN)}]] <- if (is.character(${version}) && length(${version}) == 1 && nzchar(${version})) {`,
    `  paste0(${rStr(SET_SOURCE_PREFIX)}, ${version})`,
    `} else {`,
    `  NA_character_`,
    `}`,
    ``,
    `# One row per neuron: its tips, and how many of them clear the cutoff. Sort the tips by q,`,
    `# never r: r is a staircase over q, and SEAM advises against summing it.`,
    `${neurons} <- ${tips} |>`,
    `  dplyr::group_by(${rCol(ID_COLUMN_NAME)}) |>`,
    `  dplyr::summarise(tips = dplyr::n(), shown = sum(shown))`,
    ...ctx.note(
      'The Points and Layers outputs are the same tips drawn — a cloud and a neuroglancer ' +
        'annotation layer. Their coordinates are the `x`, `y` and `z` columns of the tips frame.',
    ),
  ]
})

/** The Python emitter's `resolve`, in jsonlite. Its reasoning applies unchanged. */
function resolve(manifest: string, url: string, set: string): string[] {
  if (!set)
    return [`# One set's manifest; its files sit beside it.`, `${manifest} <- ${rStr(url)}`]
  return [
    `# A directory of suggestion sets. The card pins one by id, so look that id up rather than`,
    `# baking in the path it had when this was exported.`,
    `${manifest}_sets <- jsonlite::fromJSON(${rStr(url)}, simplifyDataFrame = FALSE)$sets`,
    `${manifest} <- paste0(`,
    `  sub("[^/]*$", "", ${rStr(url)}),`,
    `  Filter(function(s) s$id == ${rStr(set)}, ${manifest}_sets)[[1]]$path`,
    `)`,
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
  // The columns the loader fills in itself are not in the file; see `Field.filled`.
  const held = fields.filter((field) => !field.filled)
  const tmp = `${into}_file`
  const columns = rVector(held.map((f) => f.from))
  /*
   * **A column SEAM added later (`Field.optional`) is `NA` where the set predates it**, as on the
   * card. `all_of` refuses a name the file lacks, so the read takes `any_of`, the late columns
   * are filled where missing, and the selection after it is the check: a missing *required*
   * column still stops the chunk by name, as the card refuses it.
   */
  const late = held.filter((f) => f.optional).map((f) => f.from)
  const reading =
    late.length === 0
      ? [`  col_select = dplyr::all_of(${columns})`, `)`]
      : [
          `  col_select = dplyr::any_of(${columns})`,
          `)`,
          `# NA where the set predates them, as on the card.`,
          `for (column in ${rVector(late)}) {`,
          `  if (!column %in% names(${into})) ${into}[[column]] <- NA`,
          `}`,
          `${into} <- ${into}[${columns}]`,
        ]
  return [
    `${tmp} <- tempfile(fileext = ".parquet")`,
    `download.file(paste0(${base}, ${rStr(file)}), ${tmp}, mode = "wb", quiet = TRUE)`,
    `${into} <- arrow::read_parquet(`,
    `  ${tmp},`,
    ...reading,
    `names(${into}) <- ${rVector(held.map((f) => f.name))}`,
  ]
}
