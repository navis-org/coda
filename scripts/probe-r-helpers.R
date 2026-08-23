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

cat("\n", if (fails > 0L) paste(fails, "failed") else "all passed", "\n", sep = "")
quit(status = if (fails > 0L) 1L else 0L)
