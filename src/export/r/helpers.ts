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
  source: [
    "#' A pre/post edge list as one long feature vector per query neuron.",
    'coda_partner_vectors <- function(edges, neurons = NULL, partner_by = "type",',
    '                                 untyped = "id", weight = "weight",',
    '                                 weighting = "raw") {',
    '  df <- edges',
    '  df[["coda_weight_"]] <- suppressWarnings(as.numeric(df[[weight]]))',
    '  df <- df[!is.na(df[["coda_weight_"]]) & df[["coda_weight_"]] != 0, , drop = FALSE]',
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
    '  for (side in sides) {',
    '    frame <- side[[1]]',
    '    if (nrow(frame) == 0) next',
    '    direction <- side[[2]]; query_col <- side[[3]]',
    '    id_col <- side[[4]]; type_col <- side[[5]]',
    '    if (partner_by == "type") {',
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
    '                      weight = numeric(0), stringsAsFactors = FALSE))',
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
    '  if (weighting == "fraction") {',
    '    side <- paste0(long$neuronId, "\\r", long$direction)',
    '    totals <- rowsum(long$weight, side, reorder = FALSE)',
    '    denom <- as.vector(totals)[match(side, rownames(totals))]',
    '    long$weight <- ifelse(denom == 0, 0, long$weight / denom)',
    '  }',
    '  long[, c("neuronId", "direction", "partner", "feature", "weight")]',
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
