/**
 * Generated R helpers.
 *
 * Mirrors `python/helpers.ts`, and the same rule holds: each one mirrors a specific piece of
 * `src/nodes/lib`, and the pairing is what has to stay true — a helper that has quietly stopped
 * agreeing with the TypeScript it was ported from is worse than no helper at all, because the
 * document still runs and still answers.
 */

import { QUALIFIED_SEPARATOR } from '../../core/ids'
import { JOIN_SEPARATOR } from '../../core/values'
import { MIN_EMBED_OBSERVATIONS } from '../../nodes/lib/embedOps'
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
    '  # bitwOr is signed 32-bit and returns NA above 2^31, so OR only the low six bits',
    '  # (all that 61 touches) and add them back.',
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
    '  # Partial Fisher-Yates over `count` draws, then sorted, so a sample of a sorted',
    '  # table stays sorted.',
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
  needs: ['coda_ids'],
  source: [
    'coda_neurons <- function(df) {',
    "  # Rename neuprintr's `bodyid` column to `neuronId`, Coda's name, and keep ids as text.",
    '  if (!is.null(df) && "bodyid" %in% names(df) && !("neuronId" %in% names(df))) {',
    '    df <- dplyr::rename(df, neuronId = bodyid)',
    '  }',
    '  coda_ids(df, "neuronId")',
    '}',
  ],
})

/**
 * A backend's ids, as the character column every Coda table holds — invariant 8's R half.
 *
 * Three reasons, and only the first is shared with the Python helper of the same name.
 *
 * **The document has to agree with the canvas**, which holds every neuron id as text. Without
 * that, `bind_rows()` on two frames whose id columns are `<integer>` and `<character>` does not
 * coerce — it **errors**: `Can't combine ..1$neuronId <integer> and ..2$neuronId <character>`.
 * Measured against dplyr 1.2, and it is the failure that made this necessary rather than tidy;
 * pandas quietly gives an object column in the same situation, which is worse.
 *
 * **`format`, never `as.character`.** R's default numeric printing switches to scientific
 * notation, so `as.character(7.2e17)` is `"7.20575940628857e+17"` — not an id, and no longer a
 * key anything can match. `trim = TRUE` is the other half: `format` pads a vector to a common
 * width by default, and a column of space-padded ids joins against nothing.
 *
 * **What it cannot do is recover precision, and that is worth stating here** because it is the
 * one thing a reader would assume. R has no 64-bit integer type, so a wide id that arrived as a
 * `numeric` was already a different neuron before this ran — `format()` on it prints the rounded
 * value. Checked rather than assumed: R parses the literal `720575940628857216` and prints back
 * `720575940628857344`. The fix for that is to never let it be numeric, which is what
 * `coda_google_sheet` does with `col_types` at *read* time, and what neuprintr's own
 * `neuprint_ids()` does by returning a character vector.
 */
registerHelper({
  name: 'coda_ids',
  source: [
    "#' Convert id columns to text, the form Coda stores neuron ids in.",
    'coda_ids <- function(df, ...) {',
    '  for (name in c(...)) {',
    '    if (!name %in% names(df)) next',
    '    col <- df[[name]]',
    '    if (is.character(col)) next',
    '    # `format` avoids the scientific notation `as.character` gives large ids; `trim`',
    '    # stops padding to a common width.',
    '    text <- format(col, scientific = FALSE, trim = TRUE)',
    '    text[is.na(col)] <- NA_character_',
    '    df[[name]] <- text',
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
    '    # NA and the empty string both count as missing.',
    '    fill <- is.na(out) & !is.na(col) & as.character(col) != ""',
    '    out[fill] <- if (source) name else col[fill]',
    '  }',
    '  out',
    '}',
  ],
})

/**
 * Coda's Relabel node, in R.
 *
 * `dplyr::recode` and a named vector are the obvious spellings and are a different operation
 * three ways, each producing a plausible wrong column rather than an error: a named vector keeps
 * the **last** of a repeated key where Coda keeps the first, neither can tell "mapped to nothing"
 * from "not in the mapping" — the distinction `unmatched` is entirely about — and a named vector
 * cannot carry an `NA` name at all, where Coda pairs a null with a null key.
 *
 * `match()` gets all three right on its own, and gets the fourth for free: it returns the *first*
 * index, `is.na(idx)` is exactly "not in the mapping", and it pairs `NA` with `NA`. The rule this
 * *does* have to state is the text one — `coda_match_keys`, `rowKey` one language over. Only one
 * line of it differs from `as.character`, and it is the case R prints in the other case from
 * JavaScript: `TRUE` against `true`. The wide-id case has no fix here and needs none — R has no
 * 64-bit integer, so an id that arrived as a numeric was already a different neuron (invariant 8),
 * which is what the node warns about on the canvas.
 *
 * `keep` widens as R does: assigning a character into a numeric vector coerces the whole vector,
 * which is the same widening `relabelLayout` publishes.
 */
registerHelper({
  name: 'coda_match_keys',
  source: [
    "#' Convert a column to the text keys Coda matches on.",
    'coda_match_keys <- function(x) {',
    '  # Logicals become lower-case "true"/"false", as in Coda; everything else as.character.',
    '  if (is.logical(x)) return(ifelse(is.na(x), NA_character_, tolower(as.character(x))))',
    '  as.character(x)',
    '}',
  ],
})

/** Coda's Relabel node. `coda_match_keys` above carries the match rule. */
registerHelper({
  name: 'coda_relabel',
  needs: ['coda_match_keys'],
  source: [
    "#' Rewrite `column` by looking each value up in `mapping`. Coda's Relabel node.",
    'coda_relabel <- function(df, column, mapping, key, value, into = NULL,',
    '                         unmatched = "null") {',
    '  # `match` takes the first of a repeated key and pairs NA with NA, as Coda does.',
    '  # `miss` marks values not found in the mapping.',
    '  idx <- match(coda_match_keys(df[[column]]), coda_match_keys(mapping[[key]]))',
    '  miss <- is.na(idx)',
    '  values <- mapping[[value]][idx]',
    '  if (unmatched == "keep") {',
    '    values[miss] <- df[[column]][miss]',
    '  } else if (unmatched == "drop") {',
    '    df <- df[!miss, , drop = FALSE]',
    '    values <- values[!miss]',
    '  }',
    '  df[[if (is.null(into) || into == "") column else into]] <- values',
    '  df',
    '}',
  ],
})

/**
 * Coda's Compare Connectivity, in R.
 *
 * The pandas helper's four rules, and R gets two of them for free and two not at all. `match()`
 * already takes the first of a repeated key; `tapply` already groups without sorting away the
 * distinction between an absent group and an empty one. What it does *not* do is tell a real
 * zero from an unasked question — a `merge(all = TRUE)` fills both with `NA` — or keep a whole
 * row when only one dataset reaches the threshold. Both are written out.
 *
 * The label pool is the *mapping's* labels rather than the ones the edges reached, which is what
 * the whole absent-versus-unsampled distinction rests on: a pool taken from the edges makes
 * every absence unsampled and every `present_` column `TRUE`.
 *
 * `nNeurons` is a union over both ends, so a neuron that is both pre and post of something is
 * counted once — two `n_distinct` calls added together is the plausible wrong answer.
 *
 * Returns a list of the two frames; the chunk destructures it in the node's port order.
 */
registerHelper({
  name: 'coda_compare_connectivity',
  needs: ['coda_match_keys'],
  source: [
    "#' Per label: the neurons this edge list covered, and the weight out of and into it.",
    '.coda_label_totals <- function(frame, name) {',
    '  ends_label <- c(frame$preLabel, frame$postLabel)',
    '  ends_id <- c(frame$idPre, frame$idPost)',
    '  labels <- unique(ends_label)',
    '  # Vectorised over labels; a loop per label is very slow on large tables.',
    '  # A neuron is counted once even if it appears at both ends.',
    '  uniq <- !duplicated(paste(ends_label, ends_id, sep = "\\u0001"))',
    '  n <- tabulate(match(ends_label[uniq], labels), length(labels))',
    '  out <- tapply(frame$w, factor(frame$preLabel, levels = labels), sum)',
    '  into <- tapply(frame$w, factor(frame$postLabel, levels = labels), sum)',
    '  out[is.na(out)] <- 0; into[is.na(into)] <- 0',
    '  data.frame(label = labels, dataset = name, nNeurons = n,',
    '             outWeight = as.numeric(out), inWeight = as.numeric(into),',
    '             stringsAsFactors = FALSE, row.names = NULL)',
    '}',
    '',
    "#' Coda's Compare Connectivity: one type-to-type edge, counted in each dataset.",
    'coda_compare_connectivity <- function(datasets, min_weight = 0) {',
    '  summed <- list(); pools <- list(); counts <- list()',
    '  for (d in datasets) {',
    '    id_col <- if (is.null(d$id_column)) "neuronId" else d$id_column',
    '    lab_col <- if (is.null(d$label_column)) "label" else d$label_column',
    '    keys <- coda_match_keys(d$labels[[id_col]])',
    '    vals <- as.character(d$labels[[lab_col]])',
    '    # First occurrence wins, and a blank label is no label.',
    '    keep <- !duplicated(keys) & !is.na(keys) & !is.na(vals) & vals != ""',
    '    lookup <- stats::setNames(vals[keep], keys[keep])',
    '    idPre <- coda_match_keys(d$edges[[d$pre]])',
    '    idPost <- coda_match_keys(d$edges[[d$post]])',
    '    w <- if (is.null(d$weight)) rep(1, nrow(d$edges)) else as.numeric(d$edges[[d$weight]])',
    '    pre <- unname(lookup[idPre]); post <- unname(lookup[idPost])',
    '    # An edge with an unlabelled end has no place in a label-level comparison.',
    '    ok <- !is.na(pre) & !is.na(post)',
    '    frame <- data.frame(preLabel = pre[ok], postLabel = post[ok], idPre = idPre[ok],',
    '                        idPost = idPost[ok], w = w[ok], stringsAsFactors = FALSE)',
    '    key <- paste(frame$preLabel, frame$postLabel, sep = "\\u0001")',
    '    summed[[d$name]] <- tapply(frame$w, key, sum)',
    '    # Every label in the mapping, used below to tell a missing edge (0) from a label',
    '    # the dataset does not have (NA).',
    '    pools[[d$name]] <- unname(lookup)',
    '    counts[[d$name]] <- .coda_label_totals(frame, d$name)',
    '  }',
    '',
    '  # First-appearance order across the datasets.',
    '  keys <- unique(unlist(lapply(summed, names), use.names = FALSE))',
    '  # Keep a row if any dataset reaches min_weight. Looked up once per dataset for speed.',
    '  reached <- logical(length(keys))',
    '  for (n in names(summed)) {',
    '    v <- unname(summed[[n]][keys])',
    '    reached <- reached | (!is.na(v) & v >= min_weight)',
    '  }',
    '  keys <- keys[reached]',
    '  parts <- strsplit(keys, "\\u0001", fixed = TRUE)',
    '  out <- data.frame(preLabel = vapply(parts, `[`, character(1), 1),',
    '                    postLabel = vapply(parts, `[`, character(1), 2),',
    '                    stringsAsFactors = FALSE)',
    '  present <- lapply(names(summed), function(n)',
    '    out$preLabel %in% pools[[n]] & out$postLabel %in% pools[[n]])',
    '  names(present) <- names(summed)',
    '  for (n in names(summed)) {',
    '    got <- unname(summed[[n]][keys])',
    '    # 0 where the dataset has both labels but no such edge; NA where it lacks either label.',
    '    got[is.na(got) & present[[n]]] <- 0',
    '    out[[paste0("weight_", n)]] <- got',
    '  }',
    '  for (n in names(summed)) out[[paste0("present_", n)]] <- present[[n]]',
    '  list(comparison = out, counts = do.call(rbind, unname(counts)))',
    '}',
  ],
})

/**
 * Coda's Qualify Ids, both directions. See the Python helper for the three rules the obvious
 * spelling gets wrong; R gets one of them free — `paste0` with an `NA` gives `"NA"`, which is
 * the same trap by another name, so the mask is explicit here too.
 *
 * `sub()` with a non-greedy-equivalent pattern rather than `strsplit`: it replaces only the
 * first separator, which is the rule, and it leaves a value with no separator untouched — which
 * is the other rule, for free.
 *
 * The separator is spliced from `QUALIFIED_SEPARATOR` rather than typed, `coda_join`'s idiom
 * with `JOIN_SEPARATOR`: `src/core/ids.ts` exists so the rule has one home, and a literal here
 * would stay on `:` when that constant changes, with every golden still green.
 */
registerHelper({
  name: 'coda_qualify_ids',
  source: [
    "#' Tag an id column with its dataset, or take that tag off again.",
    'coda_qualify_ids <- function(df, column, direction = "add", prefix = "", into = NULL) {',
    '  ids <- df[[column]]',
    '  text <- as.character(ids)',
    '  if (direction == "add") {',
    '    # A missing id stays missing.',
    '    df[[column]] <- if (nzchar(prefix)) ifelse(is.na(ids), NA_character_,',
    `                                               paste0(prefix, ${JSON.stringify(QUALIFIED_SEPARATOR)}, text)) else text`,
    '    return(df)',
    '  }',
    '  # `sub` replaces the first match only, and leaves a value with no separator untouched.',
    `  df[[column]] <- ifelse(is.na(ids), NA_character_, sub(${JSON.stringify('^[^' + QUALIFIED_SEPARATOR + ']*' + QUALIFIED_SEPARATOR)}, "", text))`,
    '  if (!is.null(into) && nzchar(into)) {',
    `    had <- !is.na(ids) & grepl(${JSON.stringify(QUALIFIED_SEPARATOR)}, text, fixed = TRUE)`,
    `    df[[into]] <- ifelse(had, sub(${JSON.stringify(QUALIFIED_SEPARATOR + '.*$')}, "", text), NA_character_)`,
    '  }',
    '  df',
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
    "#' Coda's `join` aggregation: distinct values in order of appearance, NA and blanks skipped.",
    'coda_join <- function(x) {',
    '  kept <- as.character(x[!is.na(x)])',
    '  kept <- unique(kept[kept != ""])',
    `  if (length(kept) == 0) NA_character_ else paste(kept, collapse = ${JSON.stringify(JOIN_SEPARATOR)})`,
    '}',
  ],
})

/**
 * Coda's `min` and `max` aggregations, in R.
 *
 * `min(x, na.rm = TRUE)` is the obvious spelling and it answers **`Inf`** for a group whose every
 * value is missing — with a warning, once per group, so a knit over a sparse column fills the
 * console with them. `Inf` is not an absence: it survives `is.na`, it is not dropped by a
 * `filter`, and it plots off the end of an axis. Coda answers null there, and so does its
 * neighbour `mean`, which needs no helper because R already gives `NaN`.
 *
 * Two named functions rather than one taking a comparator, on `coda_join`'s terms: the name is
 * what appears in the `summarise` call somebody reads, and `coda_extreme(x, min)` says less about
 * what the column holds than `coda_min(x)` does.
 */
registerHelper({
  name: 'coda_min',
  source: [
    "#' Coda's `min` aggregation; returns NA for a group with no values (base min gives Inf).",
    'coda_min <- function(x) {',
    '  kept <- x[!is.na(x)]',
    '  if (length(kept) == 0) NA_real_ else min(kept)',
    '}',
  ],
})

registerHelper({
  name: 'coda_max',
  source: [
    "#' Coda's `max` aggregation; returns NA for a group with no values (base max gives -Inf).",
    'coda_max <- function(x) {',
    '  kept <- x[!is.na(x)]',
    '  if (length(kept) == 0) NA_real_ else max(kept)',
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
    "#' Rename an annotation table's id column to `neuronId` and its cell type column to `type`.",
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
    "#' Combine two annotation tables: outer join on `neuronId`, the later table's values win.",
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
    '    # Empty means every column except the id.',
    '    setdiff(names(df), id_column)',
    '  }',
    '  coda_annotation_columns(df[, c(id_column, keep), drop = FALSE], id_column)',
    '}',
  ],
})

/**
 * A connectivity edge list as one long feature vector per query neuron.
 *
 * Mirrors `nodes/lib/partnerVectors.ts` and the Python helper beside it. The three rules that
 * produce a plausible wrong frame rather than an error are the same three: the direction prefix
 * is unconditional, an untyped partner stands in for itself rather than joining a shared
 * bucket, and ids are compared as **character** — R has no 64-bit integer, so an eighteen-digit
 * root id read as a numeric is a double and a different neuron (invariant 8). The `neuronId`
 * column is carried through untouched, so it keeps whatever the edge list held it as.
 *
 * Base R rather than dplyr, for `coda_combine`'s reason: this is column arithmetic on a frame
 * whose column *names* are arguments, which is exactly where tidy evaluation costs more than
 * it saves.
 */
registerHelper({
  name: 'coda_partner_vectors',
  needs: ['coda_match_keys'],
  source: [
    "#' A pre/post edge list as one long feature vector per query neuron.",
    'coda_partner_vectors <- function(edges, neurons = NULL, partner_by = "type",',
    '                                 untyped = "id", weight = "weight",',
    '                                 weighting = "raw", labels = NULL,',
    '                                 label_id = "neuronId", label_name = "label") {',
    '  df <- edges',
    '  df[["coda_weight_"]] <- suppressWarnings(as.numeric(df[[weight]]))',
    '  df <- df[!is.na(df[["coda_weight_"]]) & df[["coda_weight_"]] != 0, , drop = FALSE]',
    '',
    '  lookup <- NULL',
    '  if (!is.null(labels)) {',
    '    lk <- coda_match_keys(labels[[label_id]])',
    '    lv <- as.character(labels[[label_name]])',
    '    # First occurrence wins, and a blank label is no label.',
    '    keep <- !duplicated(lk) & !is.na(lk) & !is.na(lv) & nzchar(lv)',
    '    lookup <- stats::setNames(lv[keep], lk[keep])',
    '  }',
    '',
    '  if (!is.null(neurons)) {',
    '    queries <- as.character(neurons$neuronId)',
    '    sides <- list(',
    '      list(df[as.character(df$preId) %in% queries, , drop = FALSE],',
    '           "out", "preId", "postId", "postType"),',
    '      list(df[as.character(df$postId) %in% queries, , drop = FALSE],',
    '           "in", "postId", "preId", "preType"))',
    '  } else {',
    '    if (!"direction" %in% names(df)) {',
    '      stop("Pass the neurons you asked about, or an edge list carrying a \\"direction\\" ",',
    '           "column saying how each edge was found.")',
    '    }',
    '    # `direction` only identifies the queried neuron on the first hop.',
    '    if ("hop" %in% names(df)) {',
    '      df <- df[suppressWarnings(as.numeric(df$hop)) == 1, , drop = FALSE]',
    '    }',
    '    sides <- list(',
    '      list(df[df$direction %in% c("downstream", "both"), , drop = FALSE],',
    '           "out", "preId", "postId", "postType"),',
    '      list(df[df$direction %in% c("upstream", "both"), , drop = FALSE],',
    '           "in", "postId", "preId", "preType"))',
    '  }',
    '',
    '  parts <- list()',
    '  seen <- list()',
    '  for (side in sides) {',
    '    frame <- side[[1]]',
    '    if (nrow(frame) == 0) next',
    '    direction <- side[[2]]; query_col <- side[[3]]',
    '    id_col <- side[[4]]; type_col <- side[[5]]',
    '    # Total weight per neuron before anything is dropped: the denominator for cnFrac.',
    '    seen[[length(seen) + 1L]] <- data.frame(',
    '      neuronId = as.character(frame[[query_col]]),',
    '      w = frame[["coda_weight_"]], stringsAsFactors = FALSE)',
    '    if (!is.null(lookup)) {',
    '      # With a mapping, partners are labelled from it and those it lacks are dropped.',
    '      mapped <- unname(lookup[coda_match_keys(frame[[id_col]])])',
    '      frame <- frame[!is.na(mapped), , drop = FALSE]',
    '      label <- mapped[!is.na(mapped)]',
    '    } else if (partner_by == "type") {',
    '      if (!type_col %in% names(frame)) {',
    '        stop(sprintf("Grouping partners by cell type needs a \\"%s\\" column.", type_col))',
    '      }',
    '      typed <- trimws(as.character(frame[[type_col]]))',
    '      have <- !is.na(typed) & nzchar(typed)',
    '      if (untyped == "drop") {',
    '        frame <- frame[have, , drop = FALSE]',
    '        typed <- typed[have]',
    '        have <- have[have]',
    '      }',
    '      label <- ifelse(have, typed, as.character(frame[[id_col]]))',
    '    } else {',
    '      label <- as.character(frame[[id_col]])',
    '    }',
    '    # `untyped == "drop"` can also leave the frame empty.',
    '    if (nrow(frame) == 0) next',
    '    parts[[length(parts) + 1L]] <- data.frame(',
    '      neuronId = frame[[query_col]],',
    '      direction = direction,',
    '      partner = label,',
    '      weight = frame[["coda_weight_"]],',
    '      stringsAsFactors = FALSE)',
    '  }',
    '',
    '  if (length(parts) == 0) {',
    '    return(data.frame(neuronId = character(0), direction = character(0),',
    '                      partner = character(0), feature = character(0),',
    '                      weight = numeric(0), cnFrac = numeric(0),',
    '                      stringsAsFactors = FALSE))',
    '  }',
    '  long <- do.call(rbind, parts)',
    '  long$feature <- paste0(long$direction, ":", long$partner)',
    '  # Sum repeats of each neuron/feature pair, as a Pivot set to sum would.',
    '  key <- paste0(long$neuronId, "\\r", long$feature)',
    '  summed <- rowsum(long$weight, key, reorder = FALSE)',
    '  long <- long[match(rownames(summed), key), , drop = FALSE]',
    '  long$weight <- as.vector(summed)',
    "  # cnFrac: the fraction of each neuron's total weight that was kept, computed before",
    '  # the fraction weighting below.',
    '  before <- do.call(rbind, seen)',
    '  before <- rowsum(before$w, before$neuronId, reorder = FALSE)',
    '  kept <- rowsum(long$weight, as.character(long$neuronId), reorder = FALSE)',
    '  frac <- as.vector(kept) / as.vector(before)[match(rownames(kept), rownames(before))]',
    '  long$cnFrac <- pmin(1, frac[match(as.character(long$neuronId), rownames(kept))])',
    '  if (weighting == "fraction") {',
    '    side <- paste0(long$neuronId, "\\r", long$direction)',
    '    totals <- rowsum(long$weight, side, reorder = FALSE)',
    '    denom <- as.vector(totals)[match(side, rownames(totals))]',
    '    long$weight <- ifelse(denom == 0, 0, long$weight / denom)',
    '  }',
    '  long[, c("neuronId", "direction", "partner", "feature", "weight", "cnFrac")]',
    '}',
  ],
})

/**
 * Pairwise similarity over sparse feature vectors.
 *
 * Mirrors `nodes/lib/similarityOps.ts`, including what that module is mostly about: the dense
 * observation × feature matrix is never built. `Matrix::sparseMatrix` takes the coordinate form
 * the long table already is — and sums duplicated `(i, j)` pairs, which is the coalescing step
 * by another name — and `tcrossprod` is the one pass.
 *
 * Labels sort with R's collation where Coda sorts numerically, so `L10` precedes `L2` here and
 * follows it on the canvas. Same cells, different axis order; the Pivot emitter already leaves
 * this to the language for the same reason.
 *
 * The weighted Jaccard is the one metric with no product form. `Σ min(a,b)` comes back out of
 * `Σ a + Σ b − Σ |a − b|`, a row at a time — `X[rep(i, n), ]` stays sparse, where subtracting a
 * plain numeric vector would densify the whole thing.
 */
registerHelper({
  name: 'coda_similarity',
  // Declared here rather than by the emitter that calls it. `emit.ts` walks the resolved helper
  // closure and emits a `library()` per package, which is what stops a *second* caller pulling
  // this in without one — the Python twin already did it this way.
  requires: ['Matrix'],
  source: [
    "#' The per-pair sum a metric needs: a dot product, a shared count, or a sum of minima.",
    '.coda_gram <- function(X, metric) {',
    '  if (metric == "jaccard") {',
    '    B <- X',
    '    B@x <- rep(1, length(B@x))',
    '    return(as.matrix(Matrix::tcrossprod(B)))',
    '  }',
    '  if (metric == "jaccardWeighted") {',
    '    # No product form, so loop over features: each dgCMatrix column lists the',
    '    # observations that have it, and every pair of them adds an outer minimum.',
    '    n <- nrow(X)',
    '    G <- matrix(0, n, n)',
    '    for (c in seq_len(ncol(X))) {',
    '      lo <- X@p[c] + 1L; hi <- X@p[c + 1L]',
    '      if (hi - lo < 1L) next',
    '      rows <- X@i[lo:hi] + 1L; vals <- X@x[lo:hi]',
    '      G[rows, rows] <- G[rows, rows] + outer(vals, vals, pmin)',
    '    }',
    '    return(G)',
    '  }',
    '  as.matrix(Matrix::tcrossprod(X))',
    '}',
    '',
    "#' Observations against themselves, as a square labelled matrix.",
    '.coda_similarity <- function(X, labels, metric, output) {',
    '  width <- ncol(X)',
    '  if (metric == "euclidean") output <- "distance"',
    '  total <- Matrix::rowSums(X)',
    '  squares <- Matrix::rowSums(X * X)',
    '  # Number of features each observation has.',
    '  present <- tabulate(X@i + 1L, nbins = nrow(X))',
    '  G <- .coda_gram(X, metric)',
    '  S <- switch(metric,',
    '    cosine = {',
    '      norm <- sqrt(squares)',
    '      G / outer(norm, norm)',
    '    },',
    '    # The matrix goes first in `pmax` so the result keeps its matrix attributes.',
    '    euclidean = sqrt(pmax(outer(squares, squares, "+") - 2 * G, 0)),',
    '    jaccard = G / (outer(present, present, "+") - G),',
    '    jaccardWeighted = G / (outer(total, total, "+") - G),',
    '    pearson = {',
    '      # Centred over all features, counting an absent feature as zero.',
    '      mu <- total / width',
    '      sd_ <- sqrt(pmax(squares / width - mu^2, 0))',
    '      (G / width - outer(mu, mu)) / outer(sd_, sd_)',
    '    },',
    '    stop(sprintf("Unknown metric: %s", metric)))',
    '  S[!is.finite(S)] <- 0',
    '  if (output == "distance" && metric != "euclidean") S <- 1 - S',
    '  # Set the diagonal explicitly; an observation with no features would give 0/0.',
    '  diag(S) <- if (output == "distance") 0 else 1',
    '  dimnames(S) <- list(labels, labels)',
    '  S',
    '}',
    '',
    "#' Compare observations pairwise from a long table of observation, feature and value.",
    'coda_similarity_long <- function(df, observations, features, value = NULL,',
    '                                 metric = "cosine", output = "similarity") {',
    '  obs <- as.character(df[[observations]])',
    '  feat <- as.character(df[[features]])',
    '  w <- if (is.null(value)) rep(1, nrow(df)) else suppressWarnings(as.numeric(df[[value]]))',
    '  keep <- !is.na(w) & w != 0 & !is.na(obs) & !is.na(feat)',
    '  obs <- obs[keep]; feat <- feat[keep]; w <- w[keep]',
    '  labels <- sort(unique(obs))',
    '  columns <- sort(unique(feat))',
    '  # `sparseMatrix` sums duplicated (i, j) pairs.',
    '  X <- Matrix::sparseMatrix(i = match(obs, labels), j = match(feat, columns), x = w,',
    '                            dims = c(length(labels), length(columns)))',
    '  # Without a value column, set entries to 1 after summing, so a pair listed several',
    '  # times still counts once.',
    '  if (is.null(value)) X@x <- rep(1, length(X@x))',
    '  .coda_similarity(X, labels, metric, output)',
    '}',
    '',
    "#' One row per observation, one picked column per feature.",
    'coda_similarity_wide <- function(df, id_column, columns, metric = "cosine",',
    '                                 output = "similarity") {',
    '  ids <- as.character(df[[id_column]])',
    '  labels <- sort(unique(ids))',
    '  # `vapply` returns an nrow x ncol matrix; setting `dim` keeps the one-column case a matrix.',
    '  values <- vapply(columns, function(nm) suppressWarnings(as.numeric(df[[nm]])),',
    '                   numeric(nrow(df)))',
    '  dim(values) <- c(nrow(df), length(columns))',
    '  values[is.na(values)] <- 0',
    '  dense <- rowsum(values, group = match(ids, labels), reorder = TRUE)',
    '  .coda_similarity(Matrix::Matrix(dense, sparse = TRUE), labels, metric, output)',
    '}',
  ],
})

/**
 * Coda's Describe Table, column by column.
 *
 * The counterpart of `coda_describe` in `python/helpers.ts`, and it exists for the same reason:
 * the obvious substitute answers a different question. `summary(df)` returns a character matrix
 * of formatted text rather than a frame anybody can sort or join, applies the six-number
 * summary only to numeric columns and reports the quartiles it does compute without a non-zero
 * count or a distinct count at all — so the document would print something that looks like the
 * card and cannot be compared with it.
 *
 * Base R throughout, so this costs the document no package. `stats::quantile`'s default is
 * type 7, which is the definition `quantileSorted` implements — stated explicitly here rather
 * than relied on, because it is the sort of default that a reader has no reason to check.
 *
 * `dtype` reports R's class (`integer`, `character`) rather than Coda's (`i64`, `str`), the
 * same call the Python helper makes: the column says what the frame in front of the reader
 * holds.
 */
registerHelper({
  name: 'coda_describe',
  source: [
    'coda_describe <- function(df) {',
    '  # A zero-row template bound first fixes column order and types, and covers a frame',
    '  # with no columns.',
    '  template <- data.frame(',
    '    column = character(), dtype = character(), non_nulls = integer(), nulls = integer(),',
    '    non_zero = numeric(), unique = integer(), min = numeric(), q1 = numeric(),',
    '    median = numeric(), q3 = numeric(), max = numeric(), mean = numeric(),',
    '    stringsAsFactors = FALSE',
    '  )',
    '',
    '  one <- function(name) {',
    '    v <- df[[name]]',
    "    # Coda's rule for missing: NA, or a string that is empty once trimmed. FALSE counts",
    '    # as present.',
    '    label <- trimws(as.character(v))',
    '    present <- !is.na(v) & !is.na(label) & nzchar(label)',
    '    # Statistics only for numeric columns, excluding logicals and neuronId.',
    '    measured <- is.numeric(v) && !identical(name, "neuronId")',
    '',
    '    row <- template[1, ]',
    '    row$column <- name',
    '    row$dtype <- class(v)[1]',
    '    row$non_nulls <- as.integer(sum(present))',
    '    row$nulls <- as.integer(sum(!present))',
    '    # Distinct values as printed.',
    '    row$unique <- as.integer(length(unique(label[present])))',
    '',
    '    if (measured) {',
    '      x <- as.numeric(v[present])',
    '      # Infinite values count as present above but are left out of the statistics.',
    '      x <- x[is.finite(x)]',
    '      row$non_zero <- sum(x != 0)',
    '      if (length(x)) {',
    '        q <- stats::quantile(x, c(0.25, 0.5, 0.75), type = 7, names = FALSE)',
    '        row$min <- min(x)',
    '        row$q1 <- q[1]',
    '        row$median <- q[2]',
    '        row$q3 <- q[3]',
    '        row$max <- max(x)',
    '        row$mean <- mean(x)',
    '      }',
    '    }',
    '    row',
    '  }',
    '',
    '  do.call(rbind, c(list(template), lapply(names(df), one)))',
    '}',
  ],
})

/**
 * The graph statistics behind `net.metrics`, in igraph.
 *
 * The counterpart of `coda_network_metrics` in `python/helpers.ts`, and a helper for the same
 * reason: the *projection* is the part that has to be right and is the part nobody would read
 * in a generated cell. Clustering, k-core, transitivity and assortativity are defined over an
 * undirected simple graph, and a connectome is neither — `as_undirected(mode = "collapse")`
 * folds the reciprocal pairs and `simplify` takes the self-loops out, which cannot close a
 * triangle and would inflate all four.
 *
 * Two departures from igraph's own answers, both matching Coda and both stated in the roxygen
 * line: `NaN` becomes `NA` where a coefficient is 0/0, and `clustering` is `NA` rather than 0
 * on a node with fewer than two neighbours.
 */
registerHelper({
  name: 'coda_network_metrics',
  requires: ['igraph'],
  source: [
    "# Per-node and graph-level statistics, like Coda's Network Metrics node.",
    '#',
    '# Returns list(nodes = <data.frame>, summary = <one-row data.frame>). Structural measures',
    '# use the undirected simple graph: a reciprocal pair is one neighbour, and a self-loop',
    '# counts towards degree only. `clustering` is NA for nodes with fewer than two neighbours.',
    'coda_network_metrics <- function(g) {',
    '  directed <- is_directed(g)',
    '  n <- vcount(g)',
    '  ids <- V(g)$name',
    '  if (is.null(ids)) ids <- as.character(seq_len(n))',
    '  w <- E(g)$weight',
    '  if (is.null(w)) w <- rep(1, ecount(g))',
    '',
    '  u <- simplify(as_undirected(g, mode = "collapse"),',
    '                remove.multiple = TRUE, remove.loops = TRUE)',
    '  deg_u <- degree(u)',
    '',
    '  in_mode <- if (directed) "in" else "all"',
    '  out_mode <- if (directed) "out" else "all"',
    '  deg_in <- degree(g, mode = in_mode)',
    '  deg_out <- degree(g, mode = out_mode)',
    '  w_in <- strength(g, mode = in_mode, weights = w)',
    '  w_out <- strength(g, mode = out_mode, weights = w)',
    '',
    '  local <- transitivity(u, type = "local")',
    '  local[deg_u < 2] <- NA_real_',
    '',
    '  # Number components largest first (ties by earliest vertex), as Coda does.',
    '  cmp <- components(u)',
    '  by_size <- order(-cmp$csize, seq_along(cmp$csize))',
    '  rank <- integer(length(cmp$csize))',
    '  rank[by_size] <- seq_along(cmp$csize)',
    '',
    '  nodes <- data.frame(',
    '    id = as.character(ids),',
    '    degreeIn = as.integer(deg_in),',
    '    degreeOut = as.integer(deg_out),',
    '    degree = as.integer(deg_in + deg_out),',
    '    weightIn = as.numeric(w_in),',
    '    weightOut = as.numeric(w_out),',
    '    strength = as.numeric(w_in + w_out),',
    '    clustering = as.numeric(local),',
    '    coreness = as.integer(coreness(u)),',
    '    component = as.integer(rank[cmp$membership]),',
    '    componentSize = as.integer(cmp$csize[cmp$membership]),',
    '    stringsAsFactors = FALSE',
    '  )',
    '',
    '  loops <- sum(which_loop(g))',
    '  observed <- if (directed) ecount(g) - loops else ecount(u)',
    '  possible <- if (directed) n * (n - 1) else n * (n - 1) / 2',
    '  triples <- sum(deg_u * (deg_u - 1) / 2)',
    '  # igraph returns NaN where a coefficient is 0/0 (e.g. on a regular graph); report NA.',
    '  na_if_nan <- function(x) if (length(x) != 1 || is.nan(x)) NA_real_ else as.numeric(x)',
    '',
    '  summary <- data.frame(',
    '    nodes = n,',
    '    links = ecount(g),',
    '    directed = directed,',
    '    selfLoops = as.integer(loops),',
    "    # Always 0 here (the graph is built from grouped links); kept to match Coda's columns.",
    '    parallelLinks = 0L,',
    '    isolated = as.integer(sum(nodes$degree == 0)),',
    '    density = if (possible > 0) observed / possible else NA_real_,',
    '    meanDegree = if (n > 0) mean(nodes$degree) else NA_real_,',
    '    medianDegree = if (n > 0) stats::median(nodes$degree) else NA_real_,',
    '    maxDegree = if (n > 0) max(nodes$degree) else 0L,',
    '    # NA for an undirected graph. Self-loops are ignored, as in Coda.',
    '    reciprocity = if (directed && ecount(g) > 0)',
    '                    reciprocity(g, ignore.loops = TRUE) else NA_real_,',
    '    components = length(cmp$csize),',
    '    largestComponent = if (length(cmp$csize)) max(cmp$csize) else 0L,',
    '    meanClustering = if (any(!is.na(local))) mean(local, na.rm = TRUE) else NA_real_,',
    '    transitivity = if (triples > 0) na_if_nan(transitivity(u, type = "global")) else NA_real_,',
    '    assortativity = if (ecount(u) > 0) na_if_nan(assortativity_degree(u, directed = FALSE))',
    '                    else NA_real_,',
    '    totalWeight = sum(w),',
    '    meanWeight = if (length(w)) mean(w) else NA_real_,',
    '    medianWeight = if (length(w)) stats::median(w) else NA_real_,',
    '    maxWeight = if (length(w)) max(w) else NA_real_,',
    '    stringsAsFactors = FALSE',
    '  )',
    '',
    '  list(nodes = nodes, summary = summary)',
    '}',
  ],
})

/**
 * The centrality set behind `net.centrality`, in igraph.
 *
 * Three of igraph's answers need converting rather than copying, and each would be a plausible
 * wrong number if it were not:
 *
 *   - **Betweenness normalisation.** igraph's `normalized = TRUE` divides an undirected graph's
 *     betweenness by `(n-1)(n-2)/2` and Coda (with networkx) divides by `(n-1)(n-2)` — ordered
 *     pairs. So this asks for the raw score and scales it here, doubling on an undirected graph
 *     because igraph counts each pair once where Brandes counts it twice. Off by a factor of two
 *     is exactly the kind of difference nobody spots in a column of small numbers.
 *   - **Eigenvector scaling.** igraph normalises the vector to a maximum of 1; Coda and networkx
 *     normalise to unit L2. Rescaled here, so the two columns are the same numbers.
 *   - **Louvain is undirected in igraph**, full stop, so a directed graph is collapsed for the
 *     community pass alone. The emitter says so.
 *
 * Sampling has no igraph equivalent — `betweenness` takes a `cutoff`, which bounds path *length*
 * rather than drawing pivots — so the exact sweep runs and the emitter notes that the document
 * will be slower and more precise than the canvas it came from.
 */
registerHelper({
  name: 'coda_network_centrality',
  requires: ['igraph'],
  source: [
    "# Centrality columns, like Coda's Network Centrality node.",
    '#',
    '# Returns list(nodes = <data.frame>, summary = <one-row data.frame>). Weighted paths use',
    '# 1/weight as a distance, so a strong connection is a short path. `closeness` is harmonic',
    '# centrality over incoming distances divided by n - 1, which stays defined when some',
    '# nodes are unreachable.',
    'coda_network_centrality <- function(g, betweenness = TRUE, closeness = TRUE,',
    '                                    pagerank = TRUE, eigenvector = FALSE,',
    '                                    communities = TRUE, weighted = FALSE,',
    '                                    seed = 1, resolution = 1, damping = 0.85) {',
    '  directed <- is_directed(g)',
    '  n <- vcount(g)',
    '  ids <- V(g)$name',
    '  if (is.null(ids)) ids <- as.character(seq_len(n))',
    '  w <- E(g)$weight',
    '  if (is.null(w)) w <- rep(1, ecount(g))',
    '  # NA means unweighted in igraph. A non-positive weight counts as one hop.',
    '  d <- if (weighted) ifelse(w > 0, 1 / w, 1) else NA',
    '  # Drop self-loops first; as in Coda, they count towards degree only.',
    '  if (any(which_loop(g))) {',
    '    keep <- !which_loop(g)',
    '    d <- if (weighted) d[keep] else NA',
    '    w <- w[keep]',
    '    g <- delete_edges(g, E(g)[!keep])',
    '  }',
    '',
    '  out <- data.frame(id = as.character(ids), stringsAsFactors = FALSE)',
    '  if (betweenness) {',
    '    raw <- igraph::betweenness(g, directed = directed, weights = d, normalized = FALSE)',
    '    scale <- if (directed) 1 else 2',
    '    out$betweenness <- if (n > 2) raw * scale / ((n - 1) * (n - 2)) else rep(0, n)',
    '  }',
    '  if (closeness) {',
    '    out$closeness <- harmonic_centrality(g, mode = "in", weights = d, normalized = TRUE)',
    '  }',
    '  if (pagerank) {',
    '    out$pagerank <- page_rank(g, damping = damping, weights = w)$vector',
    '  }',
    '  if (eigenvector) {',
    '    vec <- eigen_centrality(g, directed = directed, weights = w)$vector',
    '    # igraph scales to a maximum of 1; Coda and networkx scale to unit L2.',
    '    norm <- sqrt(sum(vec^2))',
    '    out$eigenvector <- if (norm > 0) vec / norm else vec',
    '  }',
    '',
    '  cl <- NULL',
    '  if (communities) {',
    '    set.seed(seed)',
    "    # igraph's Louvain is undirected only, so a directed graph is collapsed for this pass.",
    '    u <- simplify(as_undirected(g, mode = "collapse", edge.attr.comb = list(weight = "sum")),',
    '                  remove.multiple = TRUE, remove.loops = TRUE)',
    '    cl <- cluster_louvain(u, weights = E(u)$weight, resolution = resolution)',
    '    # Largest first, as Coda numbers both communities and components.',
    '    sizes <- as.integer(table(membership(cl)))',
    '    by_size <- order(-sizes, seq_along(sizes))',
    '    rank <- integer(length(sizes))',
    '    rank[by_size] <- seq_along(sizes)',
    '    out$community <- as.integer(rank[membership(cl)])',
    '  }',
    '',
    '  swept <- betweenness || closeness',
    '  reach <- if (swept) mean_distance(g, weights = d, directed = directed,',
    '                                    unconnected = TRUE, details = TRUE) else NULL',
    '',
    '  summary <- data.frame(',
    '    sources = if (swept) n else NA_integer_,',
    '    meanPathLength = if (swept) reach$res else NA_real_,',
    '    diameter = if (swept) diameter(g, directed = directed, weights = d,',
    '                                   unconnected = TRUE) else NA_real_,',
    '    reachable = if (swept && n > 1) 1 - reach$unconnected / (n * (n - 1)) else NA_real_,',
    '    communities = if (communities) length(sizes) else NA_integer_,',
    '    modularity = if (communities) modularity(cl) else NA_real_,',
    '    stringsAsFactors = FALSE',
    '  )',
    '',
    '  list(nodes = out, summary = summary)',
    '}',
  ],
})

/**
 * The Heatmap's "other axis follows", as positions.
 *
 * `followOrder` in `matrixShape.ts`, and a helper for the rule a one-liner cannot express: the
 * **first unclaimed** line of a repeated name wins. What this emitted before was
 * `c(intersect(lead, follower), setdiff(follower, lead))`, and both halves are wrong once axis
 * labels can repeat — which naming rows by cell type makes routine. `intersect` and `setdiff`
 * **de-duplicate**, so a follower with two lines called `LC4` came back with one.
 *
 * Positions rather than labels for the same reason the caller now subscripts with integers:
 * `m[c("LC4", "LC4"), ]` matches the *first* `LC4` twice and silently drops the second row.
 * Measured against a real 3x3, not reasoned about — R and pandas get this wrong in two
 * different directions and both look plausible.
 */
registerHelper({
  name: 'coda_follow_order',
  source: [
    'coda_follow_order <- function(lead, follower) {',
    "  # Positions that put `follower` in `lead`'s order, matched by label.",
    '  taken <- rep(FALSE, length(follower))',
    '  out <- integer(0)',
    '  for (label in lead) {',
    '    hits <- which(follower == label & !taken)',
    '    if (length(hits) > 0) {',
    '      # Take every untaken line with this label; one lead label can match several.',
    '      taken[hits] <- TRUE',
    '      out <- c(out, hits)',
    '    }',
    '  }',
    '  # Everything the leader did not name, in the order it already had.',
    '  c(out, which(!taken))',
    '}',
  ],
})

/**
 * Coda's label order: `LC4` before `LC10`, case ignored — `labelOrder` in `matrixShape.ts`.
 *
 * Base R's `order` is neither natural nor locale-stable, and the packages that are
 * (`stringr::str_sort(numeric = TRUE)`, `gtools::mixedorder`) are two more dependencies for
 * one sort. So each label becomes a key: digit runs zero-padded to twenty places, the rest
 * lower-cased, compared byte-wise. Padding rather than `as.numeric`, because an 18-digit
 * neuron id does not survive a double and the Python helper's `int()` is exact.
 */
registerHelper({
  name: 'coda_natural_order',
  source: [
    'coda_natural_order <- function(labels) {',
    "  # Positions that put the labels in Coda's order: LC4 before LC10, case ignored.",
    '  key <- vapply(as.character(labels), function(label) {',
    '    parts <- regmatches(label, gregexpr("[0-9]+|[^0-9]+", label))[[1]]',
    '    digits <- grepl("^[0-9]+$", parts)',
    '    parts[digits] <- paste0(strrep("0", pmax(0, 20 - nchar(parts[digits]))), parts[digits])',
    '    tolower(paste(parts, collapse = ""))',
    '  }, character(1), USE.NAMES = FALSE)',
    '  order(key, seq_along(labels), method = "radix")',
    '}',
  ],
})

/**
 * The Heatmap's `Selected Rows` / `Selected Columns`.
 *
 * The notebook helper's twin — see it for why this is a helper, why `picked` is positions rather
 * than names, and what the three columns mean. **Coda counts from 0 and R subscripts from 1**,
 * and both ends of that are here: `picked` arrives zero-based and is shifted to subscript with,
 * and `index` goes back out zero-based because it is Coda's position rather than an R one. A
 * document that quietly dropped either shift would disagree with the canvas beside it.
 */
registerHelper({
  name: 'coda_matrix_selection',
  source: [
    'coda_matrix_selection <- function(labels, picked, arrival = NULL) {',
    "  # Coda's Selected Rows / Selected Columns: the lines a rectangle covered.",
    '  labels <- as.character(labels)',
    '  if (is.null(arrival)) arrival <- labels',
    '  # `as.integer` so `index` is an integer column, as in Coda.',
    '  keep <- as.integer(sort(unique(picked[picked >= 0 & picked < length(labels)]))) + 1L',
    '  data.frame(',
    '    label = as.character(arrival)[keep],',
    '    # Zero-based, as Coda counts positions.',
    '    index = keep - 1L,',
    '    relabel = labels[keep],',
    '    stringsAsFactors = FALSE',
    '  )',
    '}',
  ],
})

/**
 * A long `(query, neighbour, score)` table as uwot's `nn_method` pair.
 *
 * `coda_umap_knn`'s counterpart, and the two differ in exactly one thing that matters: **uwot's
 * `idx` is 1-based and has no `-1` sentinel**, so a row with fewer than `k` neighbours pads with
 * its *own* index rather than with a miss. That is not a fudge — `compute_membership_strengths`
 * scores a self-edge as 0 in every implementation of this algorithm, umap-learn's `== i` branch
 * and umap-js's alike, so a repeated self is the same "no neighbour here" the sentinel means.
 * Checked by running it (`pnpm probe:r-helpers`) rather than reasoned from the source.
 *
 * The observation floor is spliced from `MIN_EMBED_OBSERVATIONS` rather than transcribed —
 * `QUALIFIED_SEPARATOR`'s idiom — so the emitted cell refuses exactly what the card refuses.
 *
 * The rest is the Python helper's rules, which are Coda's: the rows are the queries in
 * first-appearance order, a neighbour that is never itself a query is dropped, row `i` names
 * itself first at distance 0, and a repeated pair keeps its smallest distance — where `match()`
 * would keep the first listed rather than the closest.
 */
registerHelper({
  name: 'coda_umap_knn',
  needs: ['coda_match_keys'],
  source: [
    "#' A long neighbour table as uwot's list(idx, dist). Coda's Embedding node.",
    'coda_umap_knn <- function(df, query, target, score = NULL,',
    '                          scores_are = "similarity", k = 15) {',
    '  q <- coda_match_keys(df[[query]])',
    '  t <- coda_match_keys(df[[target]])',
    '  # First-appearance order, the order Coda lays the points out in.',
    '  labels <- unique(q)',
    '  n <- length(labels)',
    `  if (n < ${MIN_EMBED_OBSERVATIONS}) stop("an embedding needs at least ${MIN_EMBED_OBSERVATIONS} observations, got ", n)`,
    '  k <- max(2, min(as.integer(k), n - 1))',
    '  from <- match(q, labels)',
    '  to <- match(t, labels)',
    '  d <- if (is.null(score)) rep(1, nrow(df)) else suppressWarnings(as.numeric(df[[score]]))',
    '  if (scores_are == "similarity") d <- 1 - d',
    '  keep <- !is.na(from) & !is.na(to) & from != to & is.finite(d)',
    '  if (any(d[keep] < 0)) stop("scores give negative distances; check `scores_are`")',
    '  from <- from[keep]; to <- to[keep]; d <- d[keep]',
    '  # Sort closest first, so a repeated pair keeps its smallest distance.',
    '  ord <- order(d)',
    '  from <- from[ord]; to <- to[ord]; d <- d[ord]',
    '  dup <- duplicated(cbind(from, to))',
    '  from <- from[!dup]; to <- to[!dup]; d <- d[!dup]',
    '  idx <- matrix(seq_len(n), nrow = n, ncol = k)',
    '  dist <- matrix(0, nrow = n, ncol = k)',
    '  by_row <- split(seq_along(from), from)',
    '  for (row in names(by_row)) {',
    '    i <- as.integer(row)',
    '    take <- head(by_row[[row]], k - 1)',
    "    # Padded slots repeat the distance to the row's furthest real neighbour.",
    '    dist[i, ] <- d[take[length(take)]]',
    '    dist[i, 1] <- 0',
    '    idx[i, seq_along(take) + 1] <- to[take]',
    '    dist[i, seq_along(take) + 1] <- d[take]',
    '  }',
    '  list(labels = labels, idx = idx, dist = dist)',
    '}',
  ],
})

/**
 * Each point's enclosing volume — `nat::pointsinside`, folded by Coda's rules.
 *
 * The Python helper of the same name one language over, and the same three rules: every volume
 * is tested rather than stopping at the first hit, so the overlap count is a real number; the
 * **first volume on the wire** names a point two of them contain; and a point inside none gets
 * `NA` rather than a sentinel, which is what makes the two ports `!is.na()` and `is.na()`.
 *
 * `nat::pointsinside` needs **Rvcg**, which nat lists as a suggestion rather than a dependency,
 * so a reader with nat alone meets an error naming the package. It is named in the emitter's
 * note rather than papered over, because a helper that fell back to a bounding-box test would
 * answer a different question in silence.
 *
 * The volume list is named — `neuron.roiMeshes` emits `names(out) <- out_rois` — so the column
 * is filled with region names. `seq_along` is the fallback for a list that has none, which is
 * what a hand-built list of `mesh3d`s arrives as.
 */
registerHelper({
  name: 'coda_in_volumes',
  requires: ['nat'],
  source: [
    'coda_in_volumes <- function(df, volumes, column) {',
    '  xyz <- as.matrix(df[, c("x", "y", "z")])',
    '  labels <- names(volumes)',
    '  if (is.null(labels)) labels <- as.character(seq_along(volumes))',
    '  named <- rep(NA_character_, nrow(df))',
    '  found <- logical(nrow(df))',
    '  ambiguous <- logical(nrow(df))',
    '  # Skip the loop on an empty point cloud; pointsinside builds a tree on every call.',
    '  for (i in if (nrow(df)) seq_along(volumes) else integer(0)) {',
    '    hit <- as.logical(nat::pointsinside(xyz, volumes[[i]]))',
    '    hit[is.na(hit)] <- FALSE',
    '    # A point is ambiguous if more than one volume contains it.',
    '    ambiguous <- ambiguous | (hit & found)',
    '    # The first volume in the list that contains a point names it.',
    '    named[hit & !found] <- labels[[i]]',
    '    found <- found | hit',
    '  }',
    '  df[[column]] <- named',
    '  list(points = df, overlapping = sum(ambiguous))',
    '}',
  ],
})

/**
 * Read one mesh file, whichever of the three formats it is.
 *
 * A helper rather than a definition inside `core.uploadMesh`'s own chunk, which is what every
 * other `coda_*` function here is and what `resolveHelpers` dedupes: emitters run once per node,
 * so two Upload Mesh cards wrote the definition into the document twice.
 *
 * **Three routes, because R has no one reader.** `rgl::readOBJ` answers a `mesh3d` directly.
 * `rgl::readSTL` with `plot = FALSE` answers a **matrix of triangle corners**, so `m$vb` on it is
 * "$ operator is invalid for atomic vectors", which reads as a corrupt file — `tmesh3d` is what
 * turns it into a mesh. PLY has no reader in rgl at all and goes through `Rvcg::vcgImport`, which
 * nat only *suggests* — the node's own note is what tells a reader with PLY files to install it.
 */
registerHelper({
  name: 'coda_read_mesh',
  // No `requires`: every call is namespaced, rgl is in nat's `Depends` so it is already attached,
  // and naming Rvcg in the setup chunk would demand it of a reader whose files are all OBJ.
  source: [
    'coda_read_mesh <- function(path) {',
    '  ext <- tolower(tools::file_ext(path))',
    '  if (ext == "obj") return(rgl::readOBJ(path))',
    '  if (ext == "stl") {',
    '    corners <- rgl::readSTL(path, plot = FALSE)',
    '    return(rgl::tmesh3d(t(corners), seq_len(nrow(corners)), homogeneous = FALSE))',
    '  }',
    '  Rvcg::vcgImport(path)',
    '}',
  ],
})

/**
 * A synapse cloud counted into an edge list, as Coda's `Synapses to Edges`.
 *
 * The notebook helper's twin, and base R rather than dplyr for once — the whole of it is a
 * grouped count with a first-appearance order, which `match`/`tabulate` say directly, where
 * `group_by |> summarise()` would need `.drop = FALSE` reasoning about factors and still sort.
 *
 * Three rules it carries, all the node's (see `nodes/lib/synapseEdges.ts`): a row whose polarity
 * reads `post` swaps both ids *and* both types; a group's type is its first non-missing one; and
 * an end with no id is not an edge, so the row is dropped and counted.
 *
 * The composite key's two sentinels are not the TypeScript's and cannot be — R refuses an
 * embedded nul in a character vector outright, so `rowKey`'s own missing-value sentinel has no
 * spelling here. The line that uses them says the rest.
 */
registerHelper({
  name: 'coda_synapse_edges',
  needs: ['coda_ids', 'coda_match_keys'],
  source: [
    "#' Count a synapse cloud into an edge list. Coda's Synapses to Edges.",
    'coda_synapse_edges <- function(df, source, target, source_type, target_type,',
    '                               polarity, by = character(0)) {',
    '  df <- coda_ids(df, source, target)',
    '  # A column that was not picked is treated as all missing.',
    '  held <- function(name) {',
    '    if (is.null(name)) rep(NA_character_, nrow(df)) else as.character(df[[name]])',
    '  }',
    '  if (is.null(polarity)) {',
    '    flip <- rep(FALSE, nrow(df))',
    '    unoriented <- 0L',
    '  } else {',
    '    text <- tolower(trimws(as.character(df[[polarity]])))',
    '    flip <- !is.na(text) & text == "post"',
    '    # Rows whose polarity is neither "pre" nor "post" (NA included) are counted here.',
    '    unoriented <- sum(!text %in% c("pre", "post"))',
    '  }',
    '  # Ids that are blank once trimmed count as missing.',
    '  blank <- function(v) { v <- trimws(v); v[!is.na(v) & v == ""] <- NA_character_; v }',
    '  # Swap pre and post on rows whose polarity is "post".',
    '  side <- function(when_flipped, otherwise) {',
    '    if (is.null(polarity)) return(held(otherwise))',
    '    ifelse(flip, held(when_flipped), held(otherwise))',
    '  }',
    '  pre <- blank(side(target, source))',
    '  post <- blank(side(source, target))',
    '  keep <- !is.na(pre) & !is.na(post)',
    '  dropped <- sum(!keep)',
    '  kept <- which(keep)',
    '  pre <- pre[kept]; post <- post[kept]',
    "  # The `by` columns are keyed with coda_match_keys, Coda's matching rule.",
    '  parts <- c(list(pre, post), lapply(by, function(name) coda_match_keys(df[[name]][kept])))',
    '  # \\x1f stands for a missing value and \\x1e separates the fields.',
    '  parts <- lapply(parts, function(v) { v[is.na(v)] <- "\\x1f"; v })',
    '  keys <- do.call(paste, c(parts, list(sep = "\\x1e")))',
    '  # First occurrence of each group.',
    '  first <- which(!duplicated(keys))',
    '  groups <- keys[first]',
    '  at <- match(keys, groups)',
    '  # Assigned in reverse so each group keeps its earliest non-missing value, as in Coda.',
    '  carried <- function(values) {',
    '    values <- as.character(values)[kept]',
    '    out <- rep(NA_character_, length(groups))',
    '    ok <- rev(which(!is.na(values)))',
    '    out[at[ok]] <- values[ok]',
    '    out',
    '  }',
    '  edges <- data.frame(preId = pre[first], stringsAsFactors = FALSE)',
    '  if (!is.null(source_type)) edges$preType <- carried(side(target_type, source_type))',
    '  edges$postId <- post[first]',
    '  if (!is.null(target_type)) edges$postType <- carried(side(source_type, target_type))',
    '  edges$weight <- tabulate(at, nbins = length(groups))',
    '  for (name in by) edges[[name]] <- df[[name]][kept[first]]',
    '  list(edges = edges, dropped = dropped, unoriented = unoriented)',
    '}',
  ],
})

/**
 * Every sample of one nat neuron, and how much cable each one stands for.
 *
 * `Distance between`'s whole arithmetic rests on this: a skeleton node stands for half the length of each
 * edge at it, so a mean separation is a mean over the neuron's *cable* rather than over however
 * finely somebody traced it. Unweighted, resampling upstream moves every number — 4.61 against
 * 4.21 µm on two of nat's own `Cell07PNs`, and a median of 4.05 against 3.35.
 *
 * **`tapply` rather than `weights[child] <- weights[child] + half`**, which is the R trap and the
 * one a reader writing this by hand walks into: a vector subscript that repeats does not
 * accumulate — R evaluates the right-hand side once and assigns, so a branch point with three
 * edges at it keeps **one** of them. The weights would then not sum to the cable length, and
 * nothing else about the answer would look wrong. `pnpm probe:r-helpers` checks the sum against
 * `summary(n)$cable.length` exactly, which is what catches it.
 */
registerHelper({
  name: 'coda_geom_samples',
  source: [
    'coda_geom_samples <- function(n) {',
    '  d <- n$d',
    '  pts <- as.matrix(d[, c("X", "Y", "Z")])',
    '  # WKNND needs a double matrix; a neuronlist can carry integer coordinates.',
    '  storage.mode(pts) <- "double"',
    '  weights <- numeric(nrow(pts))',
    '  # Each node gets half the length of every edge at it. Parent is a PointNo, so it is',
    '  # matched to a row; roots (-1) give NA and are skipped.',
    '  parent <- match(d$Parent, d$PointNo)',
    '  child <- which(!is.na(parent))',
    '  if (length(child)) {',
    '    p <- parent[child]',
    '    len <- sqrt(rowSums((pts[child, , drop = FALSE] - pts[p, , drop = FALSE])^2))',
    '    half <- len / 2',
    '    add <- tapply(c(half, half), c(child, p), sum)',
    '    weights[as.integer(names(add))] <- as.numeric(add)',
    '  }',
    '  list(points = pts, weights = weights)',
    '}',
  ],
})

/**
 * The weighted median — the one statistic base R cannot supply.
 *
 * `median()` weights every sample equally, which is exactly what this node's arithmetic does not
 * do. Landing **exactly** on the half takes the midpoint of the two samples either side, as a
 * plain median takes the mean of the two middle values; without that arm the canvas and the
 * document disagree by one sample's distance on every evenly-weighted neuron.
 */
registerHelper({
  name: 'coda_weighted_median',
  source: [
    'coda_weighted_median <- function(values, weights) {',
    '  o <- order(values)',
    '  v <- values[o]; w <- weights[o]',
    '  total <- sum(w)',
    '  if (total <= 0) return(stats::median(v))',
    '  half <- total / 2',
    '  cum <- cumsum(w)',
    '  i <- min(which(cum >= half)[1], length(v))',
    '  if (i + 1 <= length(v) && cum[i] == half) return((v[i] + v[i + 1]) / 2)',
    '  v[i]',
    '}',
  ],
})

/**
 * The matrix: every Query neuron against every Target neuron. Coda's `Distance between` node.
 *
 * A helper rather than lines in the chunk for `coda_in_volumes`' reason — the rules are the
 * *node's* — and four of them are the ones a reader gets wrong in a way the result cannot show.
 * See `nodes/lib/geometryDistance.ts`.
 *
 * - **Nearest-point, never all-pairs.** Each statistic reduces the distances from the Query's
 *   samples to the *nearest* part of the Target. An all-pairs mean measures how big each neuron
 *   is rather than how near the two are — and `min` is the same number either way, so the
 *   distinction is invisible on the statistic people check first.
 * - **Weighted**, per `coda_geom_samples`. `min` and `max` are not averages and ignore it.
 * - **An unmeasured direction propagates**: the smaller of a measured 4 µm and a pair half of
 *   which says nothing is not 4 µm.
 * - **The upper triangle is mirrored** on an all-by-all combining both directions, `mean`, `min`
 *   and `max` all being symmetric in their two arguments.
 *
 * `nabor::knn` rather than a distance matrix: it is the k-d tree the canvas builds and scipy
 * builds, so all three agree on the structure as well as on the answer. Checked against a brute
 * force scan by `pnpm probe:r-helpers`.
 */
registerHelper({
  name: 'coda_neuron_distance',
  requires: ['nat', 'nabor'],
  needs: ['coda_geom_samples', 'coda_weighted_median'],
  source: [
    'coda_neuron_distance <- function(query, target = NULL, method = "nearest",',
    '                                 statistic = "min", within = 2, report = "absolute",',
    '                                 symmetry = "mean") {',
    '  all_by_all <- is.null(target)',
    '  if (all_by_all) target <- query',
    '  rows <- names(query); cols <- names(target)',
    '  out <- matrix(NA_real_, length(rows), length(cols), dimnames = list(rows, cols))',
    '  qs <- lapply(query, coda_geom_samples)',
    '  ts <- if (all_by_all) qs else lapply(target, coda_geom_samples)',
    '',
    '  if (method == "centroid") {',
    '    centre <- function(s) {',
    '      total <- sum(s$weights)',
    '      if (total > 0) colSums(s$points * s$weights) / total else colMeans(s$points)',
    '    }',
    '    a <- t(vapply(qs, centre, numeric(3)))',
    '    b <- if (all_by_all) a else t(vapply(ts, centre, numeric(3)))',
    '    # Per-axis differences, which give exactly zero on the diagonal.',
    '    out[] <- sqrt(outer(a[, 1], b[, 1], "-")^2 + outer(a[, 2], b[, 2], "-")^2 +',
    '                  outer(a[, 3], b[, 3], "-")^2)',
    '    return(out)',
    '  }',
    '',
    '  both <- symmetry != "query"',
    '  # One k-d tree per neuron, built once and reused. WKNND matches nabor::knn exactly.',
    '  tree <- function(s) if (nrow(s$points) == 0) NULL else nabor::WKNND(s$points)',
    '  # Build query trees only where they are used.',
    '  qt <- if (all_by_all || both) lapply(qs, tree) else NULL',
    '  tt <- if (all_by_all) qt else lapply(ts, tree)',
    '  directed <- function(s, to) {',
    '    if (nrow(s$points) == 0 || is.null(to)) return(NA_real_)',
    '    d <- to$query(s$points, k = 1, eps = 0, radius = 0)$nn.dists[, 1]',
    '    if (method == "within") {',
    '      inside <- sum(s$weights[d <= within])',
    '      if (report == "fraction") {',
    '        total <- sum(s$weights)',
    '        return(if (total > 0) inside / total else NA_real_)',
    '      }',
    '      return(inside)',
    '    }',
    '    if (statistic == "min") return(min(d))',
    '    if (statistic == "max") return(max(d))',
    '    # Mean and median are weighted by cable length.',
    '    total <- sum(s$weights)',
    '    if (total <= 0)',
    '      return(if (statistic == "mean") mean(d) else stats::median(d))',
    '    if (statistic == "mean") return(stats::weighted.mean(d, s$weights))',
    '    coda_weighted_median(d, s$weights)',
    '  }',
    '  combine <- function(forward, reverse) {',
    '    if (!both) return(forward)',
    '    if (is.na(forward) || is.na(reverse)) return(NA_real_)',
    '    if (symmetry == "min") return(min(forward, reverse))',
    '    if (symmetry == "max") return(max(forward, reverse))',
    '    (forward + reverse) / 2',
    '  }',
    '',
    '  mirrored <- all_by_all && both',
    '  for (i in seq_along(rows)) {',
    '    for (j in seq_along(cols)) {',
    '      if (mirrored && j < i) next',
    '      forward <- directed(qs[[i]], tt[[j]])',
    '      reverse <- if (both) directed(ts[[j]], qt[[i]]) else NA_real_',
    '      out[i, j] <- combine(forward, reverse)',
    '      if (mirrored && j != i) out[j, i] <- out[i, j]',
    '    }',
    '  }',
    '  out',
    '}',
  ],
})

/**
 * Coda's flow-chart layering, as a vector igraph's Sugiyama layout takes directly.
 *
 * `layout_with_sugiyama(g, layers = ...)` is the one library call in either document that does
 * what the canvas does — layers you hand it, crossing minimisation, and dummy vertices in
 * `extd_graph` so an edge spanning several layers is routed rather than drawn through whatever
 * is between its ends. What it will not do is *assign* the layers, which is what this is for.
 *
 * The cycle pass is why this is a helper rather than a call: `topo_sort` warns and returns a
 * partial order on a graph with a cycle in it, and a connectome subgraph holds reciprocal pairs
 * as a matter of course. Roots first, so the marked edge of a reciprocal pair is the one running
 * back towards the sources — `longestPathLayers` in `nodes/lib/flowChartOps.ts`, whose answer
 * this has to match or the figure has different columns from the card.
 *
 * **1-based, because igraph's `layers` argument is** — the JS and Python sides are 0-based and
 * the offset is real rather than cosmetic: `layout_with_sugiyama` reads the numbers as positions.
 */
registerHelper({
  name: 'coda_flow_layers',
  requires: ['igraph'],
  source: [
    "# Coda's flow-chart layering: a 1-based column index per vertex, as the card drew it.",
    'coda_flow_layers <- function(g, layer_attr = NULL) {',
    '  n <- igraph::vcount(g)',
    '  if (n == 0) return(integer(0))',
    '  if (!is.null(layer_attr)) {',
    '    # Layers from a column, renumbered so 0/2/5 hops draw as three adjacent columns.',
    '    # Vertices without a value go in one extra layer after the rest.',
    '    raw <- suppressWarnings(as.numeric(igraph::vertex_attr(g, layer_attr)))',
    '    known <- sort(unique(raw[is.finite(raw)]))',
    '    out <- match(raw, known)',
    '    out[is.na(out)] <- length(known) + 1L',
    '    return(as.integer(out))',
    '  }',
    '',
    '  adj <- igraph::as_adj_list(g, mode = "out")',
    '  adj <- lapply(seq_len(n), function(v) setdiff(as.integer(adj[[v]]), v))',
    '  indeg <- integer(n)',
    '  for (v in seq_len(n)) for (w in adj[[v]]) indeg[w] <- indeg[w] + 1L',
    '',
    '  # Depth-first, roots first, marking the edges that close a cycle.',
    '  state <- integer(n)',
    '  back <- new.env(hash = TRUE, parent = emptyenv())',
    '  order <- c(which(indeg == 0L), which(indeg != 0L))',
    '  for (root in order) {',
    '    if (state[root] != 0L) next',
    '    state[root] <- 1L',
    '    stack <- c(root)',
    '    at <- c(1L)',
    '    while (length(stack)) {',
    '      v <- stack[length(stack)]',
    '      i <- at[length(at)]',
    '      if (i > length(adj[[v]])) {',
    '        state[v] <- 2L',
    '        stack <- stack[-length(stack)]',
    '        at <- at[-length(at)]',
    '        next',
    '      }',
    '      at[length(at)] <- i + 1L',
    '      w <- adj[[v]][i]',
    '      if (state[w] == 1L) {',
    '        assign(paste0(v, "-", w), TRUE, envir = back)',
    '      } else if (state[w] == 0L) {',
    '        state[w] <- 1L',
    '        stack <- c(stack, w)',
    '        at <- c(at, 1L)',
    '      }',
    '    }',
    '  }',
    '',
    '  # Longest path over what is left, in Kahn order.',
    '  kept <- lapply(seq_len(n), function(v) {',
    '    adj[[v]][!vapply(adj[[v]], function(w) exists(paste0(v, "-", w), envir = back,',
    '      inherits = FALSE), logical(1))]',
    '  })',
    '  pending <- integer(n)',
    '  for (v in seq_len(n)) for (w in kept[[v]]) pending[w] <- pending[w] + 1L',
    '  layers <- integer(n)',
    '  queue <- which(pending == 0L)',
    '  head <- 1L',
    '  while (head <= length(queue)) {',
    '    v <- queue[head]',
    '    head <- head + 1L',
    '    for (w in kept[[v]]) {',
    '      layers[w] <- max(layers[w], layers[v] + 1L)',
    '      pending[w] <- pending[w] - 1L',
    '      if (pending[w] == 0L) queue <- c(queue, w)',
    '    }',
    '  }',
    '  as.integer(layers + 1L)',
    '}',
  ],
})

/**
 * Coda's Rank Plot ordering and its cumulative share.
 *
 * The twin of the Python helper, and here for the same two rules a reader would not put in by
 * hand: the share is of the **values** rather than of the rows, and a column that can go
 * negative gets no share at all — ranked descending its running sum climbs past the total and
 * comes back down, which draws as a Lorenz curve and is not one. `NA` rather than a number, so
 * ggplot leaves a gap instead of a line.
 *
 * `order` on a numeric vector is radix and therefore stable, which is what makes ties break on
 * the frame's own order — the same requirement `rankSeries.ts`' comparator has on the canvas.
 */
registerHelper({
  name: 'coda_rank',
  source: [
    'coda_rank <- function(frame, value, flag = NULL, descending = TRUE,',
    '                      drop_non_positive = FALSE) {',
    "  # Coda's Rank Plot ordering and cumulative share, as the card computes them.",
    '  out <- frame',
    '  out[[value]] <- suppressWarnings(as.numeric(out[[value]]))',
    '  out <- out[!is.na(out[[value]]), , drop = FALSE]',
    '  # A log axis has no room for a value at or below zero.',
    '  if (drop_non_positive) out <- out[out[[value]] > 0, , drop = FALSE]',
    '  out <- out[order(out[[value]], decreasing = descending), , drop = FALSE]',
    '  out$coda_rank <- seq_len(nrow(out))',
    '  # Cumulative share of the summed values. Flagged rows (e.g. the seeds of an Influence',
    '  # result) are left out of the share.',
    '  counted <- out[[value]]',
    '  if (!is.null(flag)) counted[as.logical(out[[flag]])] <- 0',
    '  total <- sum(counted)',
    '  out$coda_share <- if (any(counted < 0) || total <= 0) {',
    '    NA_real_',
    '  } else {',
    '    cumsum(counted) / total',
    '  }',
    '  out',
    '}',
  ],
})
