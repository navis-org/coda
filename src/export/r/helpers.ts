/**
 * Generated R helpers.
 *
 * Mirrors `python/helpers.ts`, and the same rule holds: each one mirrors a specific piece of
 * `src/nodes/lib`, and the pairing is what has to stay true — a helper that has quietly stopped
 * agreeing with the TypeScript it was ported from is worse than no helper at all, because the
 * document still runs and still answers.
 */

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
 * Coda's Combine Columns node, in R.
 *
 * `dplyr::coalesce()` is the obvious spelling and is a *different rule* twice over: it treats an
 * empty string as a value, where Coda reads null and blank as one absence, and it requires every
 * argument to share a type, where an annotation dump routinely mixes a text column with a
 * numeric one. The loop widens as R does — assigning a character into a numeric vector coerces
 * the whole vector — which is the same widening `combinedDType` performs.
 */
registerHelper({
  name: 'coda_combine',
  source: [
    '.coda_present <- function(x) !is.na(x) & as.character(x) != ""',
    '',
    "#' The first of `columns` holding a value, per row.",
    'coda_combine <- function(df, columns) {',
    '  out <- rep(NA, nrow(df))',
    '  for (name in columns) {',
    '    if (!name %in% names(df)) next',
    '    col <- df[[name]]',
    '    fill <- is.na(out) & .coda_present(col)',
    '    out[fill] <- col[fill]',
    '  }',
    '  out',
    '}',
  ],
})

/** Which column each value in `coda_combine` came from. */
registerHelper({
  name: 'coda_combine_source',
  needs: ['coda_combine'],
  source: [
    "#' The name of the column `coda_combine` took each value from.",
    'coda_combine_source <- function(df, columns) {',
    '  out <- rep(NA_character_, nrow(df))',
    '  for (name in columns) {',
    '    if (!name %in% names(df)) next',
    '    fill <- is.na(out) & .coda_present(df[[name]])',
    '    out[fill] <- name',
    '  }',
    '  out',
    '}',
  ],
})
