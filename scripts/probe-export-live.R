# Run the R Markdown exported from a live fixture and compare it with what the canvas produced.
#
#     pnpm probe:catmaid           # Rscript scripts/probe-export-live.R catmaid
#     CAVE_TOKEN=… pnpm probe:cave    # Rscript scripts/probe-export-live.R cave
#
# The R half of `scripts/probe-export-live.py`, for the same reason and against the same
# directory: `src/export/live.test.ts` ran the fixture's graph against the live servers and wrote
# `canvas.json` and `<fixture>.Rmd` side by side. This evaluates every chunk of the document in
# one environment, against the same servers and only reading, and compares each node's variable
# with the canvas's value for it.
#
# Rows are compared as a set, for the Python probe's reason, and the same columns are left out
# (`uncompared`). One column is compared as a set *within* each cell: rcatmaid reads a neuron's
# annotations through a different endpoint from the canvas, which hands back the same labels in
# another order (see `r/catmaidHelpers.ts`).
#
# Needs the fixture's packages (rcatmaid; fafbseg, arrow and reticulate; seatabler) and a
# network. The CAVE and FlyTable fixtures reach Python through reticulate: where no Python is
# configured, this points RETICULATE_PYTHON at the `python3` on the PATH, which must have
# caveclient or seatable_api. Exits non-zero on any disagreement.

suppressPackageStartupMessages({
  library(jsonlite)
})
options(warn = -1)

args <- commandArgs(trailingOnly = TRUE)
fixture <- if (length(args) > 0) args[[1]] else Sys.getenv("EXPORT_LIVE")
dir <- Sys.getenv("EXPORT_LIVE_OUT", file.path("/tmp/coda-export-live", fixture))
if (fixture %in% c("cave", "flytable") && !nzchar(Sys.getenv("RETICULATE_PYTHON"))) {
  Sys.setenv(RETICULATE_PYTHON = Sys.which("python3"))
}

# Node id on the canvas -> port -> the document variable bound to it. Written out, as in the
# Python probe: a variable an emitter stops binding should fail here by name.
ports <- list()
ports$catmaid <- list(
  find = list(neurons = "find_neurons"),
  explore = list(all = "explore_dataset_all", hits = "explore_dataset_hits", selected = "explore_dataset_selected"),
  ids = list(neurons = "input_ids"),
  conn = list(connections = "connectivity_connections", neuronSet = "connectivity_neuron_set"),
  walk = list(connections = "connectivity_2_connections", neuronSet = "connectivity_2_neuron_set"),
  adj = list(matrix = "adjacency_matrix_df", links = "adjacency_links"),
  adjType = list(matrix = "adjacency_2_matrix_df", links = "adjacency_2_links"),
  skel = list(skeletons = "skeletons"),
  syn = list(points = "synapses"),
  synPre = list(points = "synapses_2"),
  between = list(points = "synapses_between"),
  betweenOut = list(points = "synapses_between_2"),
  rmesh = list(meshes = "roi_meshes"),
  l1find = list(neurons = "find_neurons_2")
)
ports$cave <- list(
  find = list(neurons = "find_neurons"),
  explore = list(all = "explore_dataset_all", hits = "explore_dataset_hits", selected = "explore_dataset_selected"),
  between = list(points = "synapses_between"),
  betweenOut = list(points = "synapses_between_2"),
  ann = list(annotations = "cave_table"),
  stale = list(neurons = "input_ids"),
  repair = list(out = "update_root_ids"),
  repairVote = list(out = "update_root_ids_2"),
  tables = list(out = "list_cave_tables"),
  info = list(columns = "cave_table_info")
)
ports$flytable <- list(
  fly = list(annotations = "flytable"),
  flyAll = list(annotations = "flytable_2"),
  flyChain = list(annotations = "flytable_3")
)

# Node -> canvas columns a document leaves out on purpose, as in the Python probe.
uncompared <- list(
  cave = list(
    between = c("type", "partnerType"),
    betweenOut = c("type", "partnerType"),
    info = c("type", "example")
  ),
  # Not left out but read wrong, upstream, as in the Python probe.
  flytable = list(flyAll = "root_last_modified")
)

run_document <- function(path) {
  lines <- readLines(path, warn = FALSE)
  starts <- grep("^```\\{r", lines)
  env <- globalenv()
  for (start in starts) {
    end <- start + which(lines[(start + 1):length(lines)] == "```")[1]
    code <- lines[(start + 1):(end - 1)]
    suppressMessages(eval(parse(text = code), envir = env))
  }
  env
}

# One cell as text, so a row can be compared as one string. Numbers to six significant figures:
# a position or a cable length has been through JSON and a float32 on the canvas side. A blank is
# missing, as Coda reads it (`tableOps.ts`).
cell <- function(value, column) {
  if (is.null(value) || length(value) == 0 || is.na(value) || identical(value, "")) return("NA")
  if (column == "annotations") return(paste(sort(strsplit(as.character(value), "; ", fixed = TRUE)[[1]]), collapse = "; "))
  if (is.numeric(value)) return(format(signif(as.numeric(value), 6), scientific = FALSE, trim = TRUE))
  as.character(value)
}

row_strings <- function(frame, columns) {
  if (nrow(frame) == 0) return(character(0))
  sort(vapply(seq_len(nrow(frame)), function(i) {
    paste(vapply(columns, function(c) cell(frame[[c]][[i]], c), ""), collapse = " | ")
  }, ""))
}

compare_rows <- function(label, canvas_rows, frame, skip = character(0)) {
  frame <- as.data.frame(frame)
  canvas <- if (length(canvas_rows) == 0) data.frame() else as.data.frame(canvas_rows)
  columns <- setdiff(if (ncol(canvas)) names(canvas) else names(frame), skip)
  missing <- setdiff(columns, names(frame))
  if (length(missing)) return(sprintf("%s: the document has no column(s) %s; it has %s", label, paste(missing, collapse = ", "), paste(names(frame), collapse = ", ")))
  problems <- character(0)
  extra <- setdiff(names(frame), c(names(canvas), skip))
  if (ncol(canvas) && length(extra)) {
    problems <- c(problems, sprintf("%s: the document has column(s) the canvas does not: %s",
                                    label, paste(extra, collapse = ", ")))
  }
  a <- row_strings(canvas, columns)
  b <- row_strings(frame, columns)
  if (length(a) != length(b)) problems <- c(problems, sprintf("%s: %d rows on the canvas, %d in the document", label, length(a), length(b)))
  differ <- setdiff(a, b)
  if (length(differ)) {
    problems <- c(problems, sprintf("%s: %d canvas rows not in the document, e.g.\n  canvas   %s\n  document %s",
      label, length(differ), differ[1], setdiff(b, a)[1]))
  }
  problems
}

compare <- function(label, canvas, value, skip = character(0)) {
  kind <- canvas$kind
  if (kind %in% c("table", "points")) return(compare_rows(label, canvas$rows, value, skip))
  if (kind == "matrix") {
    problems <- character(0)
    if (!identical(rownames(value), as.character(canvas$rowLabels))) problems <- c(problems, sprintf("%s: row labels differ", label))
    if (!identical(colnames(value), as.character(canvas$colLabels))) problems <- c(problems, sprintf("%s: column labels differ", label))
    # The canvas is row-major; R stores a matrix by column.
    cells <- as.numeric(t(value))
    if (length(cells) != length(canvas$values) || any(abs(cells - canvas$values) > 1e-9)) {
      problems <- c(problems, sprintf("%s: cell values differ (sum %g vs %g)", label, sum(canvas$values), sum(cells)))
    }
    return(problems)
  }
  if (kind == "skeletons") {
    problems <- character(0)
    summary <- summary(value)
    for (i in seq_len(nrow(canvas$items))) {
      id <- canvas$items$id[[i]]
      if (!(id %in% names(value))) { problems <- c(problems, sprintf("%s: no neuron %s", label, id)); next }
      n <- value[[id]]
      if (nrow(n$d) != canvas$items$nodes[[i]]) problems <- c(problems, sprintf("%s %s: %d nodes vs %d", label, id, canvas$items$nodes[[i]], nrow(n$d)))
      cable <- summary[id, "cable.length"]
      if (abs(cable - canvas$attributes$cableLength[[i]]) > 1e-3 * canvas$attributes$cableLength[[i]]) {
        problems <- c(problems, sprintf("%s %s: cable %g vs %g", label, id, canvas$attributes$cableLength[[i]], cable))
      }
      if (summary[id, "nsoma"] != canvas$items$soma[[i]]) problems <- c(problems, sprintf("%s %s: %d soma vs %d", label, id, canvas$items$soma[[i]], summary[id, "nsoma"]))
    }
    return(problems)
  }
  if (kind == "meshes") {
    problems <- character(0)
    for (i in seq_len(nrow(canvas$items))) {
      id <- canvas$items$id[[i]]
      m <- value[[id]]
      if (is.null(m)) { problems <- c(problems, sprintf("%s: no volume %s", label, id)); next }
      if (ncol(m$it) != canvas$items$faces[[i]]) problems <- c(problems, sprintf("%s %s: %d faces vs %d", label, id, canvas$items$faces[[i]], ncol(m$it)))
      lo <- apply(m$vb[1:3, , drop = FALSE], 1, min)
      hi <- apply(m$vb[1:3, , drop = FALSE], 1, max)
      want <- canvas$items$bounds[i, ]
      # Relative: the canvas holds positions as float32, about seven significant figures.
      near <- function(a, b) all(abs(a - b) <= 1e-6 * pmax(abs(a), abs(b)) + 1e-3)
      if (!near(lo, unlist(want$min)) || !near(hi, unlist(want$max))) {
        problems <- c(problems, sprintf("%s %s: bounds differ", label, id))
      }
    }
    return(problems)
  }
  sprintf("%s: no comparison for kind %s", label, kind)
}

if (!fixture %in% names(ports)) stop("Which fixture? One of ", paste(names(ports), collapse = ", "))
canvas <- fromJSON(file.path(dir, "canvas.json"), simplifyVector = TRUE)
env <- run_document(file.path(dir, paste0(fixture, ".Rmd")))
problems <- character(0)
checked <- 0
for (node in names(ports[[fixture]])) {
  entry <- canvas[[node]]
  if (entry$state != "ok") { problems <- c(problems, sprintf("%s: the canvas did not run it", node)); next }
  for (port in names(ports[[fixture]][[node]])) {
    variable <- ports[[fixture]][[node]][[port]]
    if (!exists(variable, envir = env)) { problems <- c(problems, sprintf("%s.%s: the document binds no `%s`", node, port, variable)); next }
    skip <- uncompared[[fixture]][[node]]
    if (is.null(skip)) skip <- character(0)
    found <- compare(sprintf("%s.%s", node, port), entry$outputs[[port]], get(variable, envir = env), skip)
    problems <- c(problems, found)
    checked <- checked + 1
    cat(sprintf("%s %s.%s (%s)\n", if (length(found)) "FAIL" else "ok  ", node, port, variable))
  }
}
if (length(problems)) {
  cat("\n", paste(problems, collapse = "\n"), "\n", sep = "")
  quit(status = 1)
}
cat(sprintf("\n%d outputs agree with the canvas.\n", checked))
