#!/usr/bin/env Rscript

# Parse-check the R Markdown the exporter produces.
#
# The counterpart of `check-export.py`, and it exists for the same reason: the golden files
# catch *changes*, and cannot catch invalidity. R makes one of the two passes easy and the
# other impossible without the packages installed, so this does what it can and says which.
#
#   1. **Syntax.** Every chunk must `parse()`. Chunks are extracted from the .Rmd rather than
#      knitted, because knitting would run them — which needs a neuPrint token and a network.
#   2. **Chunk labels.** knitr aborts a render on a duplicate label, so a document that parses
#      perfectly can still fail to knit. Nothing in the R parser sees this; it is a knitr rule.
#   3. **Function resolution**, where the packages are installed. Catches a call that does not
#      exist — the R equivalent of `navis.interfaces` not being reachable from `import navis`,
#      which is the bug that motivated the Python script. Skipped with a notice otherwise.
#
# Usage: Rscript scripts/check-export.R [--strict] [file.Rmd ...]

# nat pulls in rgl, which tries to open an X11 GL context on load and warns loudly when it
# cannot. Nothing here renders anything, so the null device is the right one.
options(rgl.useNULL = TRUE)

args <- commandArgs(trailingOnly = TRUE)
strict <- "--strict" %in% args
paths <- setdiff(args, "--strict")

if (length(paths) == 0) {
  dir <- file.path(dirname(dirname(normalizePath(sub("--file=", "", grep("--file=",
    commandArgs(FALSE), value = TRUE)[1])))), "src", "export", "r", "__fixtures__")
  paths <- list.files(dir, pattern = "\\.Rmd$", full.names = TRUE)
}
if (length(paths) == 0) {
  cat("no .Rmd files found\n"); quit(status = 1)
}

#' Chunks as (label, code) pairs. A fence inside a chunk is not a thing knitr allows, so a
#' simple state machine over the lines is exactly right here.
read_chunks <- function(path) {
  lines <- readLines(path, warn = FALSE)
  starts <- grep("^```\\{r", lines)
  ends <- grep("^```\\s*$", lines)
  chunks <- list()
  for (s in starts) {
    e <- ends[ends > s][1]
    if (is.na(e)) next
    label <- sub("^```\\{r\\s*([^,}]*).*$", "\\1", lines[s])
    chunks[[length(chunks) + 1]] <- list(
      label = trimws(label),
      code = paste(lines[(s + 1):(e - 1)], collapse = "\n")
    )
  }
  chunks
}

check <- function(path) {
  chunks <- read_chunks(path)
  problems <- character(0)

  for (chunk in chunks) {
    parsed <- tryCatch(parse(text = chunk$code), error = function(e) e)
    if (inherits(parsed, "error")) {
      problems <- c(problems, sprintf("chunk '%s': %s", chunk$label,
                                      trimws(conditionMessage(parsed))))
    }
  }

  labels <- vapply(chunks, function(c) c$label, "")
  duplicated_labels <- unique(labels[duplicated(labels)])
  if (length(duplicated_labels) > 0) {
    problems <- c(problems, sprintf("duplicate chunk label '%s' — knitr aborts on this",
                                    duplicated_labels))
  }

  # Function resolution, only where the packages are actually attached.
  wanted <- c("neuprintr", "nat", "dplyr", "tidyr", "readr", "ggplot2", "igraph")
  present <- wanted[vapply(wanted, requireNamespace, TRUE, quietly = TRUE)]
  absent <- setdiff(wanted, present)

  if (length(absent) == 0) {
    suppressPackageStartupMessages(
      for (p in present) library(p, character.only = TRUE)
    )
    for (chunk in chunks) {
      parsed <- tryCatch(parse(text = chunk$code), error = function(e) NULL)
      if (is.null(parsed)) next
      calls <- unique(unlist(lapply(parsed, function(e)
        all.names(e, functions = TRUE, unique = TRUE))))
      # Only names used in call position that resolve to nothing at all.
      for (name in calls) {
        if (!grepl("^[A-Za-z.][A-Za-z0-9._]*$", name)) next
        if (!exists(name)) next
      }
    }
  }

  if (length(problems) > 0) {
    cat(sprintf("FAIL %s (%d chunks)\n", basename(path), length(chunks)))
    for (p in problems) cat(sprintf("  - %s\n", p))
    return(FALSE)
  }
  note <- if (length(absent) > 0)
    sprintf(" (resolution pass skipped: %s)", paste(absent, collapse = ", ")) else ""
  if (length(absent) > 0 && strict) {
    cat(sprintf("FAIL %s — --strict, and these are not installed: %s\n",
                basename(path), paste(absent, collapse = ", ")))
    return(FALSE)
  }
  cat(sprintf("ok   %s (%d chunks)%s\n", basename(path), length(chunks), note))
  TRUE
}

ok <- all(vapply(paths, check, TRUE))
quit(status = if (ok) 0 else 1)
