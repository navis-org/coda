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

# ---- coda_compare_connectivity ----------------------------------------------
#
# The rules checked here are the ones `merge(all = TRUE)` erases: a real zero against an unasked
# question, a pool taken from the mapping rather than from the edges, and a threshold that drops
# a row rather than a value. None is visible in the generated source.
ce_a <- data.frame(preId = c("1", "7"), postId = c("3", "3"), weight = c(20, 4),
                   stringsAsFactors = FALSE)
ca_a <- data.frame(neuronId = c("1", "3", "7"), label = c("LC4", "DNp01", "LPLC1"),
                   stringsAsFactors = FALSE)
ce_b <- data.frame(preId = "11", postId = "13", weight = 6, stringsAsFactors = FALSE)
ca_b <- data.frame(neuronId = c("11", "13"), label = c("LC4", "DNp01"),
                   stringsAsFactors = FALSE)

spec <- list(
  list(name = "A", edges = ce_a, labels = ca_a, pre = "preId", post = "postId", weight = "weight"),
  list(name = "B", edges = ce_b, labels = ca_b, pre = "preId", post = "postId", weight = "weight")
)
both <- coda_compare_connectivity(spec)
cmp_ <- both$comparison
cnt <- both$counts
at <- function(df, pre) df[df$preLabel == pre, ][1, ]

check("compare: the same connection side by side",
      at(cmp_, "LC4")$weight_A == 20 && at(cmp_, "LC4")$weight_B == 6,
      paste(at(cmp_, "LC4")$weight_A, at(cmp_, "LC4")$weight_B))
check("compare: an unasked question is NA, not zero", is.na(at(cmp_, "LPLC1")$weight_B),
      at(cmp_, "LPLC1")$weight_B)
check("compare: and it says so in present", identical(at(cmp_, "LPLC1")$present_B, FALSE),
      at(cmp_, "LPLC1")$present_B)
check("compare: a dataset that could answer says present", identical(at(cmp_, "LC4")$present_B, TRUE),
      at(cmp_, "LC4")$present_B)
check("compare: the pool comes from the mapping, not the edges",
      identical(at(cmp_, "LPLC1")$present_A, TRUE), at(cmp_, "LPLC1")$present_A)

# A real absence: B holds both labels the other way round and has no LC4 to DNp01 edge.
ca_c <- data.frame(neuronId = c("11", "13"), label = c("DNp01", "LC4"), stringsAsFactors = FALSE)
cmp2 <- coda_compare_connectivity(list(
  list(name = "A", edges = ce_a, labels = ca_a, pre = "preId", post = "postId", weight = "weight"),
  list(name = "B", edges = ce_b, labels = ca_c, pre = "preId", post = "postId", weight = "weight")
))$comparison
zero <- cmp2[cmp2$preLabel == "LC4" & cmp2$postLabel == "DNp01", ][1, ]
check("compare: a real absence is zero, not NA", zero$weight_B == 0, zero$weight_B)
check("compare: a real absence is present", identical(zero$present_B, TRUE), zero$present_B)

cmp3 <- coda_compare_connectivity(list(
  list(name = "A", edges = ce_a, labels = ca_a, pre = "preId", post = "postId"),
  list(name = "B", edges = ce_b, labels = ca_b, pre = "preId", post = "postId")
))$comparison
check("compare: no weight column counts one per row", at(cmp3, "LC4")$weight_A == 1,
      at(cmp3, "LC4")$weight_A)

dupes <- data.frame(neuronId = c("1", "1", "3"), label = c("LC4", "WRONG", "DNp01"),
                    stringsAsFactors = FALSE)
cmp4 <- coda_compare_connectivity(list(
  list(name = "A", edges = ce_a, labels = dupes, pre = "preId", post = "postId", weight = "weight"),
  list(name = "B", edges = ce_b, labels = ca_b, pre = "preId", post = "postId", weight = "weight")
))$comparison
check("compare: a repeated key resolves to the first row", !("WRONG" %in% cmp4$preLabel),
      paste(cmp4$preLabel, collapse = ", "))

cmp5 <- coda_compare_connectivity(spec, min_weight = 10)$comparison
pairs5 <- paste(cmp5$preLabel, cmp5$postLabel)
check("compare: min_weight keeps a pair any dataset reaches", "LC4 DNp01" %in% pairs5,
      paste(pairs5, collapse = ", "))
check("compare: min_weight drops a pair none reaches", !("LPLC1 DNp01" %in% pairs5),
      paste(pairs5, collapse = ", "))

cat_ <- function(label, ds) cnt[cnt$label == label & cnt$dataset == ds, ][1, ]
check("counts: neurons are the ones the edges covered", cat_("DNp01", "A")$nNeurons == 1,
      cat_("DNp01", "A")$nNeurons)
check("counts: out and in are separate, so input fraction is expressible",
      cat_("DNp01", "A")$outWeight == 0 && cat_("DNp01", "A")$inWeight == 24,
      paste(cat_("DNp01", "A")$outWeight, cat_("DNp01", "A")$inWeight))
check("counts: a dataset total is the sum of one column",
      sum(cnt$outWeight[cnt$dataset == "A"]) == 24, sum(cnt$outWeight[cnt$dataset == "A"]))

reciprocal <- data.frame(preId = c("1", "3"), postId = c("3", "1"), weight = c(5, 7),
                         stringsAsFactors = FALSE)
cnt2 <- coda_compare_connectivity(list(
  list(name = "A", edges = reciprocal, labels = ca_a, pre = "preId", post = "postId", weight = "weight"),
  list(name = "B", edges = ce_b, labels = ca_b, pre = "preId", post = "postId", weight = "weight")
))$counts
check("counts: a neuron at both ends is counted once",
      cnt2$nNeurons[cnt2$label == "LC4" & cnt2$dataset == "A"] == 1,
      cnt2$nNeurons[cnt2$label == "LC4" & cnt2$dataset == "A"])

# ---- coda_join, coda_min ----------------------------------------------------
#
# Two of the three aggregations whose R form is a generated helper rather than a function name,
# and both exist because base R answers something that is not Coda's answer for a group holding no
# value: `paste(collapse=)` keeps the two letters "NA", and `min` answers `Inf` with a warning.
# `Inf` is the one worth running rather than reading — it survives `is.na`, it is not dropped by a
# `filter`, and it plots off the end of an axis, so a document that produced it would look
# finished and read wrong.
#
# `coda_min` alone, because the helper chunk carries only what the fixture reaches and the
# fixture's second Group By aggregates with `min`. `coda_max` is its mirror to the character and
# is pinned in `export.test.ts` instead, at the emitter — what needs *running* is the pattern, and
# there is one of it.
check("join: distinct, first-appearance order, absences skipped",
      identical(coda_join(c("b", NA, "a", "b", "")), "b; a"),
      coda_join(c("b", NA, "a", "b", "")))
check("join: a group with nothing in it is NA, not an empty string",
      is.na(coda_join(c(NA, ""))), coda_join(c(NA, "")))
check("min: absences skipped rather than propagated",
      identical(coda_min(c(10, NA, 20)), 10), coda_min(c(10, NA, 20)))
check("min: a group with no values is NA, never Inf",
      is.na(coda_min(c(NA_real_, NA_real_))), coda_min(c(NA_real_, NA_real_)))
# The warning is half of what base `min` gets wrong here: one per empty group, so a knit over a
# sparse column fills the console with them.
check("min: and it does not warn on the way",
      length(withCallingHandlers(
        { coda_min(c(NA_real_, NA_real_)); character(0) },
        warning = function(w) invokeRestart("muffleWarning"))) == 0L)

# ---- coda_qualify_ids -------------------------------------------------------
#
# The same three rules one language over. R turns an NA into the string "NA" through `paste0`,
# which is the null trap by another name, so the mask is explicit there too.
qf <- data.frame(neuronId = c("720575940623374218", NA, "a:b"),
                 type = c("LC4", "LC6", "X"), stringsAsFactors = FALSE)
tagged <- coda_qualify_ids(qf, "neuronId", direction = "add", prefix = "flywire")
check("qualify: tags an id with its dataset",
      tagged$neuronId[1] == "flywire:720575940623374218", tagged$neuronId[1])
check("qualify: a null stays null rather than becoming \"flywire:NA\"",
      is.na(tagged$neuronId[2]), tagged$neuronId[2])
check("qualify: the result is not digits, so a query builder refuses it",
      !grepl("^[0-9]+$", tagged$neuronId[1]), tagged$neuronId[1])

back <- coda_qualify_ids(tagged, "neuronId", direction = "remove", into = "dataset")
check("qualify: round-trips", back$neuronId[1] == "720575940623374218", back$neuronId[1])
check("qualify: keeps the dataset in its own column", back$dataset[1] == "flywire", back$dataset[1])
check("qualify: and leaves it empty where there was no prefix", is.na(back$dataset[2]), back$dataset[2])

inner <- coda_qualify_ids(qf, "neuronId", direction = "remove")
check("qualify: splits on the first separator only", inner$neuronId[3] == "b", inner$neuronId[3])
check("qualify: an unqualified id passes through unchanged",
      inner$neuronId[1] == "720575940623374218", inner$neuronId[1])

# ---- coda_relabel -----------------------------------------------------------
#
# `dplyr::recode` and a named vector are the obvious spellings and are a different operation
# three ways, each answering plausibly rather than erroring: a named vector keeps the *last* of a
# repeated key, neither can tell "no match" from "mapped to nothing", and neither can carry an NA
# name. `match()` gets all three right, which is exactly the claim worth executing.
rdf <- data.frame(
  preType = c("LC4", "DNp01", NA, "12"),
  weight = c(30, 10, 5, 1),
  stringsAsFactors = FALSE
)
mdf <- data.frame(
  from = c("LC4", "LC4", NA, "12"),
  to = c("LC4_LC6", "second", "untyped", "twelve"),
  stringsAsFactors = FALSE
)

rnull <- coda_relabel(rdf, "preType", mdf, "from", "to")
check("relabel: the default leaves an unmapped value empty", is.na(rnull$preType[2]), rnull$preType[2])
check("relabel: a repeated key is used once, first winning", rnull$preType[1] == "LC4_LC6", rnull$preType[1])
check("relabel: a null is its own key", rnull$preType[3] == "untyped", rnull$preType[3])
check("relabel: rows are never multiplied", nrow(rnull) == 4L, nrow(rnull))
check("relabel: other columns ride along", identical(rnull$weight, c(30, 10, 5, 1)), paste(rnull$weight))

# A numeric column against a text key: Coda matches on the text of both.
ndf <- data.frame(cluster = c(12, 99), stringsAsFactors = FALSE)
rnum <- coda_relabel(ndf, "cluster", mdf, "from", "to")
check("relabel: matched as text, so a number and its text are one key", rnum$cluster[1] == "twelve", rnum$cluster[1])

rkeep <- coda_relabel(rdf, "preType", mdf, "from", "to", unmatched = "keep")
check("relabel: keep puts the original back", rkeep$preType[2] == "DNp01", rkeep$preType[2])
check("relabel: keep does not touch what matched", rkeep$preType[1] == "LC4_LC6", rkeep$preType[1])

rdrop <- coda_relabel(rdf, "preType", mdf, "from", "to", unmatched = "drop")
check("relabel: drop removes the unmatched row", nrow(rdrop) == 3L, nrow(rdrop))
check("relabel: drop takes the whole row with it", identical(rdrop$weight, c(30, 5, 1)), paste(rdrop$weight))

rinto <- coda_relabel(rdf, "preType", mdf, "from", "to", into = "label")
check("relabel: a name appends rather than rewriting", identical(names(rinto), c("preType", "weight", "label")), paste(names(rinto)))
check("relabel: the original column is left alone", rinto$preType[1] == "LC4", rinto$preType[1])

# A JS boolean prints lower case, which is the one line `coda_match_keys` adds to as.character.
bdf <- data.frame(flag = c(TRUE, FALSE), stringsAsFactors = FALSE)
bmap <- data.frame(from = c("true", "false"), to = c("yes", "no"), stringsAsFactors = FALSE)
rbool <- coda_relabel(bdf, "flag", bmap, "from", "to")
check("relabel: a boolean matches its JavaScript text", identical(rbool$flag, c("yes", "no")), paste(rbool$flag))

# The shared label space, and what it costs each neuron — the same arithmetic the TypeScript
# tests and the Python probe assert against the same fixture, which is what makes a drift
# between the three visible as a disagreement rather than as three plausible answers.
pv_labels <- data.frame(neuronId = c("10", "12", "20"),
                        label = c("shared:X", "shared:X", "shared:Y"),
                        stringsAsFactors = FALSE)
mapped <- coda_partner_vectors(edges, neurons = queries, labels = pv_labels)
check("vectors: two partners mapping onto one label pool into one feature",
      isTRUE(all.equal(vector_for(mapped, 1),
                       c("out:shared:X" = 4, "in:shared:Y" = 7))),
      paste(names(vector_for(mapped, 1)), collapse = ", "))
check("vectors: an unmapped partner is dropped, not renamed",
      !("out:B" %in% names(vector_for(mapped, 1))),
      paste(names(vector_for(mapped, 1)), collapse = ", "))
by_id_mapped <- coda_partner_vectors(edges, neurons = queries, labels = pv_labels,
                                     partner_by = "id")
check("vectors: a mapping overrides partner_by",
      isTRUE(all.equal(vector_for(by_id_mapped, 1), vector_for(mapped, 1))),
      paste(names(vector_for(by_id_mapped, 1)), collapse = ", "))

cn_frac <- function(frame, neuron) {
  rows <- frame[as.character(frame$neuronId) == as.character(neuron), ]
  if (nrow(rows) == 0) NA_real_ else rows$cnFrac[1]
}

# Neuron 1 keeps 3 + 1 + 7 of 17; neuron 2 keeps 5 of 15.
check("cnFrac: the share of a neuron that survived the restriction",
      abs(cn_frac(mapped, 1) - 11 / 17) < 1e-12, cn_frac(mapped, 1))
check("cnFrac: and it differs per neuron, which is the whole point",
      abs(cn_frac(mapped, 2) - 5 / 15) < 1e-12, cn_frac(mapped, 2))
check("cnFrac: is 1 where nothing was dropped", cn_frac(pv, 1) == 1, cn_frac(pv, 1))
dropped_pv <- coda_partner_vectors(edges, neurons = queries, untyped = "drop")
check("cnFrac: counts what untyped='drop' removes too",
      abs(cn_frac(dropped_pv, 1) - 15 / 17) < 1e-12, cn_frac(dropped_pv, 1))
frac_mapped <- coda_partner_vectors(edges, neurons = queries, labels = pv_labels,
                                    weighting = "fraction")
check("cnFrac: survives the fraction weighting unchanged",
      abs(cn_frac(frac_mapped, 1) - 11 / 17) < 1e-12, cn_frac(frac_mapped, 1))
check("cnFrac: rides on every row of a neuron",
      max(tapply(mapped$cnFrac, as.character(mapped$neuronId),
                 function(x) length(unique(x)))) == 1, "")


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

# ---- coda_describe ----------------------------------------------------------
#
# The helper whose obvious substitute is `summary(df)`, which is the reason to run it: the two
# look alike in a rendered document and answer different questions, so a transcription drifting
# towards base R's semantics would still print something perfectly plausible. Checked against
# the numbers `describeOps.test.ts` pins one language over.

described <- coda_describe(data.frame(
  neuronId = c(1, 2, 3, 4, 5),
  type = c("LC4", "LC4", "", "LC6", NA),
  weight = c(0, 10, 20, 30, NA),
  flagged = c(TRUE, FALSE, FALSE, TRUE, TRUE),
  stringsAsFactors = FALSE
))
rownames(described) <- described$column

check("describe: one row per column, in order",
      identical(coda_describe(data.frame(a = 1, b = 2))$column, c("a", "b")))
check("describe: an empty string is missing, not a value",
      described["type", "non_nulls"] == 3L && described["type", "nulls"] == 2L &&
        described["type", "unique"] == 2L,
      paste(described["type", ], collapse = " "))
check("describe: FALSE is a real answer",
      described["flagged", "non_nulls"] == 5L && described["flagged", "unique"] == 2L,
      paste(described["flagged", ], collapse = " "))
check("describe: the five-number spread, type 7",
      isTRUE(all.equal(unlist(described["weight", c("min", "q1", "median", "q3", "max", "mean")],
                              use.names = FALSE), c(0, 7.5, 15, 22.5, 30, 15))),
      paste(described["weight", ], collapse = " "))
check("describe: zero is present and not counted as non-zero",
      described["weight", "non_zero"] == 3, described["weight", "non_zero"])
# `is.numeric` is already FALSE for a logical column, so this is the branch that costs nothing
# in R and everything in pandas — pinned on both sides so the two documents cannot part company.
check("describe: a logical column is counted, never measured",
      all(is.na(unlist(described["flagged", c("non_zero", "min", "max", "mean")]))),
      paste(described["flagged", ], collapse = " "))
check("describe: the id column is counted, never measured",
      described["neuronId", "unique"] == 5L &&
        all(is.na(unlist(described["neuronId", c("non_zero", "min", "max", "mean")]))),
      paste(described["neuronId", ], collapse = " "))
# The reason this is a helper at all: `summary()` is a different answer under the same name.
check("describe: and it is not what summary() says",
      is.data.frame(described) && "unique" %in% names(described),
      paste(names(described), collapse = " "))
check("describe: a frame with no columns keeps the summary's shape",
      identical(names(coda_describe(data.frame()))[1:4],
                c("column", "dtype", "non_nulls", "nulls")) &&
        nrow(coda_describe(data.frame())) == 0L,
      paste(names(coda_describe(data.frame())), collapse = " "))

# ---- coda_endpoint_neurons --------------------------------------------------
#
# The same fixture the Python probe uses, for the same reason: these two are ports of one
# derivation, and a case that passes in one language and not the other is the whole point.
conn <- data.frame(
  preId = c(1, 1, 2),
  preType = c("A", "A", "B"),
  postId = c(2, 3, 3),
  postType = c("B", "", "C"),
  weight = c(5, 5, 5),
  stringsAsFactors = FALSE
)

eps <- coda_endpoint_neurons(conn, c(1, 9))
check("endpoints: seeds first, then partners in first-appearance order",
      identical(eps$neuronId, c(1, 9, 2, 3)), paste(eps$neuronId, collapse = " "))
check("endpoints: one row per neuron",
      nrow(eps) == length(unique(eps$neuronId)), as.character(nrow(eps)))
check("endpoints: a seed no edge mentions survives, untyped",
      is.na(eps$type[eps$neuronId == 9]))
# 3 arrives first as an untyped post ("" is no type, not a type named blank) and is typed by a
# later row. Keying the type off the row that fixed the order would leave it empty.
check("endpoints: the first non-empty type wins, not the first row",
      identical(eps$type[eps$neuronId == 3], "C"),
      paste(eps$type[eps$neuronId == 3]))
check("endpoints: a type from either end is picked up",
      identical(eps$type[eps$neuronId %in% c(1, 2)], c("A", "B")),
      paste(eps$type[eps$neuronId %in% c(1, 2)], collapse = " "))

bare <- coda_endpoint_neurons(conn)
check("endpoints: no seeds is the edges alone",
      identical(bare$neuronId, c(1, 2, 3)), paste(bare$neuronId, collapse = " "))
empty <- coda_endpoint_neurons(conn[0, ], 7)
check("endpoints: an empty edge list is the seeds",
      identical(empty$neuronId, 7), paste(empty$neuronId, collapse = " "))

# --- the heatmap's label order --------------------------------------------------------------
# `coda_natural_order` mirrors `labelOrder` in `matrixOrder.ts` and the Python helper: LC4
# before LC10, case ignored, an id that starts with digits first. The 18-digit case is the one
# R would get wrong through `as.numeric`, which is why the helper zero-pads instead.
labels <- c("LC10", "LC4", "DNp02", "lc9", "720575940621234567")
got <- labels[coda_natural_order(labels)]
check("natural: LC4 before LC10, ids first, case ignored",
      identical(got, c("720575940621234567", "DNp02", "LC4", "lc9", "LC10")),
      paste(got, collapse = " "))
ids <- c("720575940621234568", "720575940621234567")
check("natural: an 18-digit id is compared exactly",
      identical(ids[coda_natural_order(ids)], rev(ids)))
check("natural: a tie keeps arrival order",
      identical(coda_natural_order(c("b", "A", "a")), c(2L, 3L, 1L)))

cat("\n", if (fails > 0L) paste(fails, "failed") else "all passed", "\n", sep = "")
quit(status = if (fails > 0L) 1L else 0L)
