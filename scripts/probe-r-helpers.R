#!/usr/bin/env Rscript
#
# Run generated R helpers and check what they answer.
#
# `pnpm probe:r-helpers`. The counterpart of `probe-py-helpers.py` one language over, and it
# exists for that script's reason: the golden file says the emitted text is unchanged and
# `check-export.R` says it parses and its function names resolve, but **nothing executes a line
# of it**. These helpers are dplyr and readr, which is exactly where the mistakes are.
#
# It reads the *generated* helper chunk out of `everything.Rmd` rather than a transcription, so
# what runs is what the exporter actually writes.
#
# It earned its place on the helper it was written for. `coda_google_sheet` forces the id column
# to character, and without that readr guesses: R has no 64-bit integer, so an eighteen-digit
# root id becomes a double and `720575940628857210` reads back as `720575940628857216` — a
# different neuron, and two adjacent ids collapsing onto one value, with nothing to say so.
# Confirmed by mutation rather than assumed: dropping the `col_types` spec fails two checks here
# and nothing else in the tree.
#
# Nothing here needs a token or a network — a sheet is read from a local file, because what is
# checked is the shaping rather than Google's transport. `data/annotations/googleSheet.ts`
# records what was probed live about the export URL.
#
#     Rscript scripts/probe-r-helpers.R

root <- normalizePath(file.path(dirname(sub("^--file=", "",
  grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)[1])), ".."))
rmd <- file.path(root, "src", "export", "r", "__fixtures__", "everything.Rmd")

# The generated chunk, by label. knitr fences are ``` and the label chunk is the only one that
# defines the helpers, so this is a two-line reader rather than a dependency on knitr itself.
lines <- readLines(rmd, warn = FALSE)
open_at <- grep("^```\\{r coda-helpers", lines)
if (length(open_at) != 1L) stop("no single `coda-helpers` chunk in ", rmd)
close_at <- open_at + which(lines[(open_at + 1L):length(lines)] == "```")[1]
eval(parse(text = paste(lines[(open_at + 1L):(close_at - 1L)], collapse = "\n")),
     envir = globalenv())

fails <- 0L
check <- function(name, ok, detail = "") {
  if (isTRUE(ok)) {
    cat("ok   ", name, "\n")
  } else {
    fails <<- fails + 1L
    cat("FAIL ", name, " ", paste(detail, collapse = ", "), "\n")
  }
}

# ---- coda_google_sheet ------------------------------------------------------
#
# Read from a file rather than a URL: `read_csv` takes either. The fixture carries the four rows
# that each stand for a rule — a wide id, a blank cell, a row with no id at all, and a repeat.
sheet <- tempfile(fileext = ".csv")
writeLines(c(
  "root_id,cell_type,side,synapses",
  "720575940628857210,LC4,left,120",
  "720575940628857211,,right,4",
  ",orphan,left,1",
  "720575940628857210,LC4,left,7"
), sheet)

out <- coda_google_sheet(sheet, id_column = "root_id", columns = c("cell_type", "side"))
check("sheet: a wide id survives exactly",
      identical(out$neuronId[1], "720575940628857210"), out$neuronId[1])
check("sheet: and is character, not a rounded double",
      is.character(out$neuronId), class(out$neuronId))
check("sheet: a blank-id row is dropped", nrow(out) == 3L, nrow(out))
check("sheet: a repeated id is kept",
      sum(out$neuronId == "720575940628857210") == 2L, "")
check("sheet: cell_type becomes type",
      "type" %in% names(out), names(out))
check("sheet: an unnamed column is left out",
      !("synapses" %in% names(out)), names(out))

every <- coda_google_sheet(sheet, id_column = "root_id")
check("sheet: empty columns keeps all but the id",
      identical(names(every), c("neuronId", "type", "side", "synapses")), names(every))

absent <- coda_google_sheet(sheet, id_column = "root_id", columns = c("side", "nope"))
check("sheet: a named column the tab lacks is dropped, not filled with NA",
      identical(names(absent), c("neuronId", "side")), names(absent))

# readr warns about a parser naming a column that is not there before this stops, which is worth
# knowing so the warning is not mistaken for the failure.
err <- tryCatch({
  suppressWarnings(coda_google_sheet(sheet, id_column = "neuronId"))
  NULL
}, error = function(e) conditionMessage(e))
check("sheet: a missing id column stops, naming the columns",
      !is.null(err) && grepl("root_id", err), err)

# ---- coda_join_annotations --------------------------------------------------
#
# The chain. An inner join would silently answer the intersection of two populations, and a
# replace rather than a coalesce would blank every cell the later source left empty.
left <- data.frame(neuronId = c("1", "2"), type = c("LC4", NA),
                   a = c("x", "y"), stringsAsFactors = FALSE)
right <- data.frame(neuronId = c("2", "3"), type = c("LC6", "DNp01"),
                    b = c(1, 2), stringsAsFactors = FALSE)
j <- coda_join_annotations(left, right)
check("join: outer — every id either side knows about survives",
      identical(sort(j$neuronId), c("1", "2", "3")), j$neuronId)
check("join: the later source wins a collision",
      j$type[j$neuronId == "2"] == "LC6", j$type[j$neuronId == "2"])
check("join: falling back where the later one has no value",
      j$type[j$neuronId == "1"] == "LC4", j$type[j$neuronId == "1"])
check("join: left order kept, right-only ids appended",
      identical(j$neuronId, c("1", "2", "3")), j$neuronId)
dupes <- data.frame(neuronId = c("2", "2"), type = c("a", "b"),
                    stringsAsFactors = FALSE)
check("join: a repeated id does not cross-product",
      nrow(coda_join_annotations(dupes, right)) == 2L,
      nrow(coda_join_annotations(dupes, right)))

# ---- coda_partner_vectors ---------------------------------------------------
#
# The same fixture `probe-py-helpers.py` uses, deliberately: these two helpers are ports of one
# TypeScript module, and the cheapest way to catch one of them drifting is to ask both the same
# questions. The one hop-2 edge is what tells the two routes apart — a wired `Neurons` table
# names the queries outright and reaches it, where the `direction` column answers only for the
# first hop.
edges <- data.frame(
  preId = c(1, 1, 1, 2, 20, 1, 2),
  postId = c(10, 12, 11, 10, 1, 2, 30),
  preType = c("A", "A", "A", "B", "Y", "A", "B"),
  postType = c("X", "X", NA, "X", "A", "B", "Z"),
  weight = c(3, 1, 2, 5, 7, 4, 6),
  hop = c(1, 1, 1, 1, 1, 1, 2),
  direction = c("downstream", "downstream", "downstream", "downstream",
                "upstream", "both", "downstream"),
  stringsAsFactors = FALSE)
queries <- data.frame(neuronId = c(1, 2))

vector_for <- function(frame, neuron) {
  rows <- frame[frame$neuronId == neuron, , drop = FALSE]
  stats::setNames(as.numeric(rows$weight), rows$feature)
}
same <- function(a, b) isTRUE(all.equal(a[order(names(a))], b[order(names(b))]))

pv <- coda_partner_vectors(edges, neurons = queries)
one <- vector_for(pv, 1)
check("vectors: both directions, kept apart by the prefix",
      same(one, c(`out:X` = 4, `out:11` = 2, `out:B` = 4, `in:Y` = 7)),
      paste(names(one), one, collapse = " "))
# The em-dash trap: an untyped partner stands in for itself rather than pooling with every
# other untyped one, which is the grouping that makes strangers look alike.
check("vectors: an untyped partner falls back to its own id", "out:11" %in% names(one))
check("vectors: repeats of one pair are summed", one[["out:X"]] == 4)
check("vectors: an edge inside the query set counts for both ends",
      vector_for(pv, 2)[["in:A"]] == 4)
check("vectors: a wired Neurons table reaches past the first hop",
      vector_for(pv, 2)[["out:Z"]] == 6)

derived <- coda_partner_vectors(edges)
check("vectors: direction alone answers the first hop identically",
      same(vector_for(derived, 1), one))
check("vectors: and drops what it cannot attribute",
      !"out:Z" %in% names(vector_for(derived, 2)))
check("vectors: dropping untyped partners removes exactly those",
      setequal(names(vector_for(coda_partner_vectors(edges, neurons = queries,
                                                     untyped = "drop"), 1)),
               c("out:X", "out:B", "in:Y")))
byid <- vector_for(coda_partner_vectors(edges, neurons = queries, partner_by = "id"), 1)
check("vectors: by id, every partner is its own feature",
      same(byid, c(`out:10` = 3, `out:12` = 1, `out:11` = 2, `out:2` = 4, `in:20` = 7)),
      paste(names(byid), byid, collapse = " "))
frac <- vector_for(coda_partner_vectors(edges, neurons = queries, weighting = "fraction"), 1)
# Per direction, which is the point: a neuron with far more input than output still has both
# halves of its vector count for something.
check("vectors: fractions are per direction", isTRUE(all.equal(frac[["out:X"]], 0.4)))
check("vectors: a lone feature in a direction is all of it", frac[["in:Y"]] == 1)

# ---- coda_similarity --------------------------------------------------------
#
# Checked against `stats::dist` on the dense form rather than against numbers typed in here:
# what the helper claims is that never building that dense form gives the same answer, and the
# only way to see that is to build it and compare.
long <- data.frame(obs = c("a", "a", "a", "b", "b", "c"),
                   feat = c("f1", "f2", "f2", "f1", "f2", "f3"),
                   w = c(1, 1.5, 0.5, 2, 4, 1),
                   stringsAsFactors = FALSE)
# `a` is two rows on f2 summing to 2, which makes it exactly parallel to `b`.
dense <- matrix(c(1, 2, 0, 2, 4, 0, 0, 0, 1), nrow = 3, byrow = TRUE,
                dimnames = list(c("a", "b", "c"), NULL))

euclid <- coda_similarity_long(long, "obs", "feat", value = "w", metric = "euclidean")
check("similarity: Euclidean agrees with stats::dist on the dense form",
      isTRUE(all.equal(unname(euclid), unname(as.matrix(dist(dense))))),
      paste(round(euclid - as.matrix(dist(dense)), 6), collapse = " "))
cosine <- coda_similarity_long(long, "obs", "feat", value = "w")
reference <- dense %*% t(dense) / outer(sqrt(rowSums(dense^2)), sqrt(rowSums(dense^2)))
check("similarity: cosine agrees with the dense product",
      isTRUE(all.equal(unname(cosine), unname(reference))))
check("similarity: duplicate pairs are summed, so a and b come out parallel",
      isTRUE(all.equal(cosine["a", "b"], 1)))
pearson <- coda_similarity_long(long, "obs", "feat", value = "w", metric = "pearson")
# Centred over the ambient feature space, which is what `cor` on the dense rows does — and is
# not what centring over the features an observation happens to have would give.
check("similarity: Pearson agrees with cor on the dense form",
      isTRUE(all.equal(unname(pearson), unname(cor(t(dense))))),
      paste(round(pearson - cor(t(dense)), 6), collapse = " "))
weighted <- coda_similarity_long(long, "obs", "feat", value = "w", metric = "jaccardWeighted")
check("similarity: weighted Jaccard is min over max",
      isTRUE(all.equal(weighted["a", "b"], 0.5)), weighted["a", "b"])
check("similarity: and zero where nothing is shared", weighted["a", "c"] == 0)
presence <- coda_similarity_long(long, "obs", "feat")
check("similarity: no value column asks about presence rather than strength",
      isTRUE(all.equal(presence["a", "b"], 1)) && presence["a", "c"] == 0,
      paste(presence, collapse = " "))
check("similarity: a distance is one minus the similarity, diagonal included",
      isTRUE(all.equal(coda_similarity_long(long, "obs", "feat", value = "w",
                                            output = "distance"), 1 - cosine)))
# Euclidean has no similarity form, so the setting is forced rather than honoured — the same
# exception `effectiveOutput` makes on the canvas.
forced <- coda_similarity_long(long, "obs", "feat", value = "w", metric = "euclidean",
                               output = "similarity")
check("similarity: Euclidean is a distance whatever the setting says",
      forced["a", "a"] == 0 && forced["a", "b"] > 0)
wide <- data.frame(id = c("a", "b", "c"), f1 = c(1, 2, 0), f2 = c(2, 4, 0), f3 = c(0, 0, 1),
                   stringsAsFactors = FALSE)
check("similarity: the wide layout answers what the long one does",
      isTRUE(all.equal(coda_similarity_wide(wide, "id", c("f1", "f2", "f3")), cosine)))

cat("\n", if (fails > 0L) paste(fails, "failed") else "all passed", "\n", sep = "")
quit(status = if (fails > 0L) 1L else 0L)
