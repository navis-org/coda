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
    "#' A column as Coda's match keys — `rowKey`'s rule, one language over.",
    'coda_match_keys <- function(x) {',
    '  # A JS boolean prints lower case; everything else is as.character already.',
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
    '  # `match` takes the first of a repeated key and pairs NA with NA, both of which are',
    "  # Coda's rules; `miss` is what tells 'no match' from 'mapped to nothing'.",
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
    '  # Vectorised rather than a pass per label. `sum(frame$w[frame$preLabel == l])` inside a',
    '  # loop over labels is a full-length comparison each time, i.e. quadratic: measured at',
    '  # 116s for a million edges over ten thousand labels, against 1.35s for this.',
    '  # A union over both ends: two distinct-counts added together count a neuron twice.',
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
    "    # The mapping's labels, not the edges' — see the note above.",
    '    pools[[d$name]] <- unname(lookup)',
    '    counts[[d$name]] <- .coda_label_totals(frame, d$name)',
        '  }',
    '',
    '  # First-appearance order across the datasets.',
    '  keys <- unique(unlist(lapply(summed, names), use.names = FALSE))',
    '  # A row survives where *any* dataset reaches the threshold, so an asymmetry outlives it.',
    '  # One vectorised index per dataset, never one per key: `s[k]` on a named vector re-hashes',
    '  # the whole names vector, measured at 36s for 20,000 lookups into a million names.',
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
    '    # 0 where the dataset holds both labels and has no such edge — a real absence — and NA',
    '    # where it holds neither, because then nothing was asked.',
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
    '    # A null stays null: tagging one invents a neuron that does not exist.',
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
    '    # `direction` only names the neuron that was asked about while the frontier still is',
    '    # the seed set, which is the first hop.',
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
    '    # Every gram attributable to a neuron, before anything is dropped. cnFracs denominator,',
    '    # countable only here: a dropped connection leaves nothing behind to count it against.',
    '    seen[[length(seen) + 1L]] <- data.frame(',
    '      neuronId = as.character(frame[[query_col]]),',
    '      w = frame[["coda_weight_"]], stringsAsFactors = FALSE)',
    '    if (!is.null(lookup)) {',
    '      # The mapping replaces partner_by and untyped: a partner outside the shared label',
    '      # space can only exist in one dataset, so it is dropped rather than falling back.',
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
    '    # After the branch, not inside one: `untyped == "drop"` can empty the frame too, which',
    '    # is where the Python this mirrors puts the same guard.',
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
    '  # Repeats of one neuron/partner pair are summed, exactly as a Pivot set to sum would.',
    '  # `rowsum` rather than `aggregate(weight ~ ...)`, which builds an interaction factor and',
    '  # dispatches per group in R -- minutes on a million-edge frame. Grouping by (neuronId,',
    '  # feature) is the whole key: `feature` already determines `direction` and `partner`.',
    '  key <- paste0(long$neuronId, "\\r", long$feature)',
    '  summed <- rowsum(long$weight, key, reorder = FALSE)',
    '  long <- long[match(rownames(summed), key), , drop = FALSE]',
    '  long$weight <- as.vector(summed)',
    '  # cnFrac against the pre-restriction totals, and *before* the fraction weighting below',
    '  # rescales the weights -- after it, this would be a fraction of a fraction.',
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
    '    # No product form, so this is the feature-major pass the canvas runs. A dgCMatrix is',
    '    # already column-major, so @p/@i/@x give each feature\'s observations directly, and',
    '    # every pair that shares it is one outer minimum. Cost is the same sum-of-squared-',
    '    # column-heights, against O(n x nnz) for tiling one row against the whole matrix.',
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
    '  # `tabulate` over the stored row indices: how many features each observation has, with',
    '  # no lgCMatrix allocated to count them.',
    '  present <- tabulate(X@i + 1L, nbins = nrow(X))',
    '  G <- .coda_gram(X, metric)',
    '  S <- switch(metric,',
    '    cosine = {',
    '      norm <- sqrt(squares)',
    '      G / outer(norm, norm)',
    '    },',
    '    # `pmax(m, 0)` and not `pmax(0, m)`: pmax keeps the attributes of its *first*',
    '    # argument, so the scalar-first spelling returns a bare vector and `diag<-` then',
    '    # refuses it. Found by running this, not by reading it.',
    '    euclidean = sqrt(pmax(outer(squares, squares, "+") - 2 * G, 0)),',
    '    jaccard = G / (outer(present, present, "+") - G),',
    '    jaccardWeighted = G / (outer(total, total, "+") - G),',
    '    pearson = {',
    '      # Centred over the ambient feature space, counting an absent feature as the zero it',
    '      # is -- not over the features an observation happens to have.',
    '      mu <- total / width',
    '      sd_ <- sqrt(pmax(squares / width - mu^2, 0))',
    '      (G / width - outer(mu, mu)) / outer(sd_, sd_)',
    '    },',
    '    stop(sprintf("Unknown metric: %s", metric)))',
    '  S[!is.finite(S)] <- 0',
    '  if (output == "distance" && metric != "euclidean") S <- 1 - S',
    '  # Written rather than computed: an observation with no features at all divides 0 by 0,',
    '  # and a non-zero distance to itself is not a distance.',
    '  diag(S) <- if (output == "distance") 0 else 1',
    '  dimnames(S) <- list(labels, labels)',
    '  S',
    '}',
    '',
    "#' Triplets -- observation, feature, value -- compared pairwise.",
    'coda_similarity_long <- function(df, observations, features, value = NULL,',
    '                                 metric = "cosine", output = "similarity") {',
    '  obs <- as.character(df[[observations]])',
    '  feat <- as.character(df[[features]])',
    '  w <- if (is.null(value)) rep(1, nrow(df)) else suppressWarnings(as.numeric(df[[value]]))',
    '  keep <- !is.na(w) & w != 0 & !is.na(obs) & !is.na(feat)',
    '  obs <- obs[keep]; feat <- feat[keep]; w <- w[keep]',
    '  labels <- sort(unique(obs))',
    '  columns <- sort(unique(feat))',
    '  # `sparseMatrix` sums duplicated (i, j) pairs, which is the coalescing step by another name.',
    '  X <- Matrix::sparseMatrix(i = match(obs, labels), j = match(feat, columns), x = w,',
    '                            dims = c(length(labels), length(columns)))',
    '  # Presence is applied after the merge, not by passing ones in: an ungrouped table listing',
    '  # a pair four times would otherwise carry a 4 under presence\'s name.',
    '  if (is.null(value)) X@x <- rep(1, length(X@x))',
    '  .coda_similarity(X, labels, metric, output)',
    '}',
    '',
    "#' One row per observation, one picked column per feature.",
    'coda_similarity_wide <- function(df, id_column, columns, metric = "cosine",',
    '                                 output = "similarity") {',
    '  ids <- as.character(df[[id_column]])',
    '  labels <- sort(unique(ids))',
    '  # `vapply` already returns an nrow x ncol matrix -- reshaping it copied the whole dense',
    '  # block a second time. `drop = FALSE` keeps the one-column case a matrix.',
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
    '  # The zero-row template is rbound in ahead of the rows, which fixes the column order and',
    '  # the types -- and answers a frame with no columns at all, where `do.call(rbind, list())`',
    '  # would otherwise return NULL.',
    '  template <- data.frame(',
    '    column = character(), dtype = character(), non_nulls = integer(), nulls = integer(),',
    '    non_zero = numeric(), unique = integer(), min = numeric(), q1 = numeric(),',
    '    median = numeric(), q3 = numeric(), max = numeric(), mean = numeric(),',
    '    stringsAsFactors = FALSE',
    '  )',
    '',
    '  one <- function(name) {',
    '    v <- df[[name]]',
    "    # Coda's absence rule: NA, or a string that is empty once trimmed. FALSE stays a real",
    '    # answer, which is why this tests the text rather than truthiness.',
    '    label <- trimws(as.character(v))',
    '    present <- !is.na(v) & !is.na(label) & nzchar(label)',
    '    # `is.numeric` is FALSE for a logical column, which is what we want: a mean of 0.4',
    '    # under a column of TRUE/FALSE is not a summary anybody asked for. An id is excluded',
    '    # for the other reason -- a mean neuron id names no neuron.',
    '    measured <- is.numeric(v) && !identical(name, "neuronId")',
    '',
    '    row <- template[1, ]',
    '    row$column <- name',
    '    row$dtype <- class(v)[1]',
    '    row$non_nulls <- as.integer(sum(present))',
    '    row$nulls <- as.integer(sum(!present))',
    '    # Distinct values as printed, which is the count a group-and-count downstream agrees',
    '    # with.',
    '    row$unique <- as.integer(length(unique(label[present])))',
    '',
    '    if (measured) {',
    '      x <- as.numeric(v[present])',
    '      # An NA or an infinity arrived, so it is present and distinct above -- but it takes',
    '      # no part in the spread, where it would drag a quantile with it.',
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
    '# Per-node and graph-level statistics -- Coda\'s Network Metrics node.',
    '#',
    '# Returns list(nodes = <data.frame>, summary = <one-row data.frame>). Structural measures',
    '# are taken over the undirected simple projection, so a reciprocal pair is one neighbour',
    '# relationship and a self-loop counts towards degree and nothing else. `clustering` is NA',
    '# rather than 0 where a node has fewer than two neighbours: it has no pair of them to',
    '# close, and calling that 0 makes the mean a count of the leaves.',
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
    '  # Largest component first, ties by the earliest vertex -- the ordering Coda gives these,',
    '  # so that colouring by component ranks the same way in both.',
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
    '  # NaN is igraph saying the coefficient is 0/0 -- a regular graph has no variation in the',
    '  # degrees at its link ends. NA says the question does not apply; 0 would say "no',
    '  # preference", which is a different and wrong claim.',
    '  na_if_nan <- function(x) if (length(x) != 1 || is.nan(x)) NA_real_ else as.numeric(x)',
    '',
    '  summary <- data.frame(',
    '    nodes = n,',
    '    links = ecount(g),',
    '    directed = directed,',
    '    selfLoops = as.integer(loops),',
    '    # Always 0 here, and kept so the column set matches Coda\'s: the graph was built from',
    '    # grouped links, which cannot hold two edges between one pair.',
    '    parallelLinks = 0L,',
    '    isolated = as.integer(sum(nodes$degree == 0)),',
    '    density = if (possible > 0) observed / possible else NA_real_,',
    '    meanDegree = if (n > 0) mean(nodes$degree) else NA_real_,',
    '    medianDegree = if (n > 0) stats::median(nodes$degree) else NA_real_,',
    '    maxDegree = if (n > 0) max(nodes$degree) else 0L,',
    '    # Undirected reciprocity is 1 by construction, so reporting it would be reporting the',
    '    # value of `directed` in a column nobody would read that way.',
    '    # Not igraph\'s `reciprocity()` default, which counts self-loops in its denominator.',
    '    # Coda counts a self-loop towards degree and nothing else, so `ignore.loops` is what',
    '    # makes the two agree on a graph with autapses.',
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
    '# Centrality columns -- Coda\'s Network Centrality node.',
    '#',
    '# Returns list(nodes = <data.frame>, summary = <one-row data.frame>). Weighted paths use',
    '# 1/weight as a distance, so a strong connection is a short path. `closeness` is harmonic',
    '# centrality over incoming distances, divided by n - 1: classical closeness is undefined',
    '# for any node that cannot reach everything, which on a connectome is most of them.',
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
    '  # NA is igraph for "unweighted"; a non-positive weight cannot become a length, so it',
    '  # falls back to one hop rather than making every path through it free.',
    '  d <- if (weighted) ifelse(w > 0, 1 / w, 1) else NA',
    '  # Self-loops leave first, which is Coda\'s rule throughout: a self-loop counts towards',
    '  # degree and towards nothing else. It matters most for eigenvector centrality, where one',
    '  # heavy autapse is an eigenvector all of its own.',
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
    '    # igraph\'s Louvain is undirected only, so a directed graph is collapsed for this pass.',
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
