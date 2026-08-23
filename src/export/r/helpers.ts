/**
 * Generated R helpers.
 *
 * Mirrors `python/helpers.ts`, and the same rule holds: each one mirrors a specific piece of
 * `src/nodes/lib`, and the pairing is what has to stay true — a helper that has quietly stopped
 * agreeing with the TypeScript it was ported from is worse than no helper at all, because the
 * document still runs and still answers.
 */

import { JOIN_SEPARATOR } from '../../core/values'
import { registerHelper } from './registry'

/**
 * Coda's own PRNG, and it has to be Coda's own.
 *
 * `set.seed()` seeds a Mersenne Twister; this is mulberry32. Same seed, entirely different
 * rows — so a document using R's sampler would disagree with the canvas it was exported from
 * while looking perfectly reasonable.
 *
 * R has no unsigned 32-bit integer type and its bitwAnd/bitwXor are signed, so the arithmetic
 * runs in doubles with an explicit modulo. `%%` on a double is exact well past 2^32, which is
 * what keeps this identical to the JavaScript rather than approximately so.
 */
registerHelper({
  name: 'coda_sample_rows',
  source: [
    '.coda_u32 <- function(x) x %% 4294967296',
    '',
    '.coda_xor32 <- function(a, b) {',
    '  # bitwXor is signed 32-bit, so the top bit has to be handled outside it.',
    '  a <- .coda_u32(a); b <- .coda_u32(b)',
    '  hi <- bitwXor(a %/% 65536, b %/% 65536)',
    '  lo <- bitwXor(a %% 65536, b %% 65536)',
    '  hi * 65536 + lo',
    '}',
    '',
    '.coda_or1 <- function(x) x + (1 - x %% 2)',
    '',
    '.coda_or61 <- function(x) {',
    '  # bitwOr is signed 32-bit and returns NA above 2^31, so the OR is done on the low six',
    '  # bits -- which is all 61 touches -- and added back.',
    '  low <- x %% 64',
    '  x - low + bitwOr(as.integer(low), 61L)',
    '}',
    '',
    '.coda_mul32 <- function(a, b) {',
    '  # Split so the product never exceeds 2^53 and stays exact in a double.',
    '  a <- .coda_u32(a); b <- .coda_u32(b)',
    '  ah <- a %/% 65536; al <- a %% 65536',
    '  .coda_u32(.coda_u32(ah * b) * 65536 + al * b)',
    '}',
    '',
    '.coda_rng <- function(seed) {',
    "  # mulberry32, the generator behind Coda's Sample node.",
    '  a <- .coda_u32(as.numeric(seed))',
    '  function() {',
    '    a <<- .coda_u32(a + 1831565813)',
    '    t <- a',
    '    t <- .coda_mul32(.coda_xor32(t, t %/% 32768), .coda_or1(t))',
    '    t <- .coda_xor32(t, .coda_u32(t + .coda_mul32(.coda_xor32(t, t %/% 128),',
    '                                                  .coda_or61(t))))',
    '    .coda_u32(.coda_xor32(t, t %/% 16384)) / 4294967296',
    '  }',
    '}',
    '',
    'coda_sample_rows <- function(length, count, seed) {',
    '  # Row positions for a seeded draw, ascending and 1-based.',
    '  #',
    '  # Partial Fisher-Yates over `count` draws, then sorted: this samples rather than',
    '  # shuffles, so a random subset of a sorted table stays sorted.',
    '  length <- max(0, as.integer(length))',
    '  count <- max(0, min(length, as.integer(count)))',
    '  if (count == 0) return(integer(0))',
    '  idx <- seq_len(length)',
    '  rand <- .coda_rng(seed)',
    '  for (i in seq_len(count)) {',
    '    j <- i + floor(rand() * (length - i + 1))',
    '    held <- idx[i]; idx[i] <- idx[j]; idx[j] <- held',
    '  }',
    '  sort(idx[seq_len(count)])',
    '}',
  ],
})

/**
 * neuprintr's column names to Coda's.
 *
 * **neuprintr returns `bodyid`; every Coda table uses `neuronId`.** Verified against the
 * package reference, not assumed — and it matters more than a spelling usually would, because
 * `df$neuronId` on a tibble is `NULL` rather than an error, so the mismatch travels silently
 * until something downstream reports zero neurons. Every emitter that calls a neuprintr
 * function that returns neurons passes the result through this, so the rest of the document
 * addresses the same column names the canvas does.
 *
 * Left alone when the frame already uses `neuronId`, so a table from an upload or a Cypher
 * query with an explicit alias passes through untouched.
 */
registerHelper({
  name: 'coda_neurons',
  requires: ['dplyr'],
  source: [
    'coda_neurons <- function(df) {',
    '  # neuprintr publishes `bodyid`; Coda calls the id column `neuronId` everywhere.',
    '  # `df$neuronId` on a tibble is NULL rather than an error, so an unrenamed frame',
    '  # reports zero neurons somewhere far from here.',
    '  if (!is.null(df) && "bodyid" %in% names(df) && !("neuronId" %in% names(df))) {',
    '    df <- dplyr::rename(df, neuronId = bodyid)',
    '  }',
    '  df',
    '}',
  ],
})

/**
 * Coda's Combine Columns node, both halves.
 *
 * `dplyr::coalesce()` is the obvious spelling and is a *different rule* twice over: it treats an
 * empty string as a value, where Coda reads null and blank as one absence, and it requires every
 * argument to share a type, where an annotation dump routinely mixes a text column with a
 * numeric one. The loop widens as R does — assigning a character into a numeric vector coerces
 * the whole vector — which is the same widening `combinedDType` performs.
 *
 * `source = TRUE` answers which column each value came from. One function rather than two,
 * because the absence rule is the same in both and two copies is two places for it to drift.
 */
registerHelper({
  name: 'coda_combine',
  source: [
    "#' The first of `columns` holding a value per row, or which column that was.",
    'coda_combine <- function(df, columns, source = FALSE) {',
    '  out <- if (source) rep(NA_character_, nrow(df)) else rep(NA, nrow(df))',
    '  for (name in columns) {',
    '    if (!name %in% names(df)) next',
    '    col <- df[[name]]',
    '    # Null and the empty string are one absence: a blank must not stop the search.',
    '    fill <- is.na(out) & !is.na(col) & as.character(col) != ""',
    '    out[fill] <- if (source) name else col[fill]',
    '  }',
    '  out',
    '}',
  ],
})

/**
 * Coda's `join` aggregation, in R.
 *
 * `paste(x, collapse = "; ")` is the obvious spelling and keeps an `NA` — as the literal two
 * letters — an empty string, and every repeat, where Coda reads the first two as absences and
 * folds the third away. A group with nothing in it answers `NA_character_` rather than `""`, so
 * the column stays a real absence and `is.na` finds it. The separator is spliced from
 * `JOIN_SEPARATOR`, and `unique` keeps first-appearance order.
 */
registerHelper({
  name: 'coda_join',
  source: [
    "#' Coda's `join` aggregation: distinct, first-appearance order, absences skipped.",
    'coda_join <- function(x) {',
    '  kept <- as.character(x[!is.na(x)])',
    '  kept <- unique(kept[kept != ""])',
    `  if (length(kept) == 0) NA_character_ else paste(kept, collapse = ${JSON.stringify(JOIN_SEPARATOR)})`,
    '}',
  ],
})

/**
 * Coda's names for an annotation table's columns.
 *
 * `annotationColumn` in `data/annotations/types.ts`: two renames and no more. The id column
 * becomes `neuronId`, and a `cell_type`/`celltype` column becomes `type`. Those are the two
 * columns nodes address **by name**, and missing the second is entirely silent — `df$type` on a
 * tibble is `NULL` rather than an error, which is the same trap `coda_neurons` exists for one
 * seam over.
 *
 * The id is kept as **character**, which is invariant 8 in R: there is no 64-bit integer here,
 * so an eighteen-digit root id read as a numeric is a double and a *different* neuron. A row
 * with no id names no neuron and is dropped, matching what every provider does on the canvas.
 */
registerHelper({
  name: 'coda_annotation_columns',
  source: [
    "#' Rename an annotation table's columns to the two names Coda addresses by name.",
    'coda_annotation_columns <- function(df, id_column) {',
    '  if (id_column %in% names(df)) names(df)[names(df) == id_column] <- "neuronId"',
    '  if (!("type" %in% names(df))) {',
    '    for (name in c("cell_type", "celltype")) {',
    '      if (name %in% names(df)) {',
    '        names(df)[names(df) == name] <- "type"',
    '        break',
    '      }',
    '    }',
    '  }',
    '  if (!("neuronId" %in% names(df))) return(df)',
    '  ids <- as.character(df$neuronId)',
    '  df$neuronId <- ids',
    '  df[!is.na(ids) & ids != "", , drop = FALSE]',
    '}',
  ],
})

/**
 * Two annotation sources chained.
 *
 * `joinAnnotations` in `nodes/lib/annotationOps.ts`, and the two rules that matter both produce
 * a plausible wrong table rather than an error. It is a **full outer** join, because two sources
 * routinely cover different populations and an inner one would silently return their
 * intersection. And the later source **wins, falling back to the earlier one where it has no
 * value** — a coalesce rather than a replace, which getting backwards produces a table that is
 * right except in the cells one source left blank.
 *
 * Each side is deduplicated on the id first, or `full_join` cross-products a repeated one — an
 * annotation base is somebody's spreadsheet and routinely holds two rows for one neuron.
 *
 * The fill is done by index rather than with `ifelse`, which drops a column's attributes and
 * evaluates both branches. Assigning a character into a numeric column widens the whole vector,
 * which is R doing what `combinedDType` does.
 */
registerHelper({
  name: 'coda_join_annotations',
  requires: ['dplyr'],
  source: [
    "#' Chain two annotation sources: outer join on `neuronId`, the later one winning.",
    'coda_join_annotations <- function(left, right) {',
    '  if (is.null(left)) return(right)',
    '  if (is.null(right)) return(left)',
    '  left <- left[!duplicated(left$neuronId), , drop = FALSE]',
    '  right <- right[!duplicated(right$neuronId), , drop = FALSE]',
    '  shared <- setdiff(intersect(names(right), names(left)), "neuronId")',
    '  merged <- dplyr::full_join(left, right, by = "neuronId",',
    '                             suffix = c("", ".coda_later"))',
    '  for (name in shared) {',
    '    later <- merged[[paste0(name, ".coda_later")]]',
    '    take <- !is.na(later)',
    '    merged[[name]][take] <- later[take]',
    '    merged[[paste0(name, ".coda_later")]] <- NULL',
    '  }',
    '  merged',
    '}',
  ],
})

/**
 * A shared Google Sheet as a Coda neuron table.
 *
 * **The id column is forced to character and everything else is guessed**, which is the whole
 * of what makes this faithful. `readr` guesses well, and R's numeric is a double: a column of
 * eighteen-digit root ids guessed as numeric is `7.205759e+17`, which matches nothing and is a
 * different neuron besides. Coda's own reader reaches the same column by a different route —
 * `inferDType` refuses a numeric reading of any value that would not survive a round trip.
 *
 * **A column named but not present is dropped rather than becoming a column of `NA`**, which is
 * what the node does; the card carries the warning, and here the frame simply lacks it.
 */
registerHelper({
  name: 'coda_google_sheet',
  needs: ['coda_annotation_columns'],
  requires: ['readr'],
  source: [
    "#' A shared Google Sheet, read through its CSV export URL.",
    'coda_google_sheet <- function(url, id_column = "root_id", columns = NULL) {',
    '  spec <- stats::setNames(list(readr::col_character()), id_column)',
    '  df <- readr::read_csv(url, col_types = do.call(readr::cols, spec),',
    '                        show_col_types = FALSE, progress = FALSE)',
    '  if (!(id_column %in% names(df))) {',
    '    stop(sprintf("\'%s\' is not a column of that tab. It has: %s",',
    '                 id_column, paste(names(df), collapse = ", ")))',
    '  }',
    '  keep <- if (length(columns)) {',
    '    columns[columns %in% names(df) & columns != id_column]',
    '  } else {',
    '    # Empty means every column but the id, which is how a sheet says "all of it".',
    '    setdiff(names(df), id_column)',
    '  }',
    '  coda_annotation_columns(df[, c(id_column, keep), drop = FALSE], id_column)',
    '}',
  ],
})
