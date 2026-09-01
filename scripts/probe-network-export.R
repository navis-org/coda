#!/usr/bin/env Rscript
#
# Run the *generated* R graph helpers and check they agree with the canvas.
#
# `pnpm probe:netexport` (this is the third of its three steps). The counterpart of
# `probe-network-export.py` one language over, and it exists for that script's reason: the golden
# says the emitted text is unchanged and `check-export.R` says it parses and its names resolve,
# but nothing executes a line of it. These helpers are igraph, and igraph is where the mistakes
# are — three of its answers need converting rather than copying, and every one of them is a
# plausible wrong number:
#
#   * `normalized = TRUE` divides an undirected graph's betweenness by (n-1)(n-2)/2 where Coda
#     and networkx divide by (n-1)(n-2). Off by a factor of two, in a column of small numbers.
#   * `eigen_centrality` scales to a maximum of 1; Coda scales to unit L2.
#   * `reciprocity()` counts self-loops in its denominator and Coda does not.
#
# It reads the generated chunk out of `everything.Rmd` rather than a transcription, so what runs
# is what the exporter actually writes, and compares against `/tmp/coda-network-probe.json`, which
# `probe-network-export.ts` wrote by running Coda's own implementation over the same graph.
#
# Two things are compared loosely, both said out loud rather than quietly skipped. `community` is
# a *partition* from a different Louvain implementation, so what is checked is the modularity it
# scores rather than the labels it assigns. And the two power iterations stop by different rules,
# so they are compared to 1e-8 — measured, not picked: on this graph they land about a nanounit
# apart.
#
#     Rscript scripts/probe-network-export.R

suppressPackageStartupMessages({
  library(igraph)
  library(dplyr)
  library(jsonlite)
})

root <- normalizePath(file.path(dirname(sub("^--file=", "",
  grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)[1])), ".."))
rmd <- file.path(root, "src", "export", "r", "__fixtures__", "everything.Rmd")
args <- commandArgs(trailingOnly = TRUE)
probe_path <- if (length(args)) args[1] else "/tmp/coda-network-probe.json"

lines <- readLines(rmd, warn = FALSE)
open_at <- grep("^```\\{r coda-helpers", lines)
if (length(open_at) != 1L) stop("no single `coda-helpers` chunk in ", rmd)
close_at <- open_at + which(lines[(open_at + 1L):length(lines)] == "```")[1]
eval(parse(text = paste(lines[(open_at + 1L):(close_at - 1L)], collapse = "\n")),
     envir = globalenv())

probe <- fromJSON(probe_path, simplifyVector = TRUE)

# The graph as the *document* would have it: grouped links, exactly as `net.build` emits, with the
# vertex table supplied so an isolated node survives — "how many nodes are isolated" is one of the
# numbers being checked, and an edge list alone loses them.
raw <- as.data.frame(probe$links, stringsAsFactors = FALSE)
names(raw) <- c("source", "target", "weight")
raw$weight <- as.numeric(raw$weight)
grouped <- raw |>
  group_by(source, target) |>
  summarise(weight = sum(weight), edges = n(), .groups = "drop")
g <- graph_from_data_frame(grouped, directed = probe$directed,
                           vertices = data.frame(name = probe$nodes, stringsAsFactors = FALSE))

fails <- 0L
checks <- 0L
# A partition is not a number, and `parallelLinks` is 0 by construction in a graph built from
# grouped links, so neither is compared cell by cell.
skip <- c("id", "community", "communities")
loose <- c(pagerank = 1e-8, eigenvector = 1e-8, modularity = 0.05)

compare <- function(what, ours, theirs, tolerance) {
  checks <<- checks + 1L
  ok <- if (is.null(ours) || (is.numeric(ours) && is.na(ours))) {
    is.null(theirs) || (length(theirs) == 1L && is.na(theirs))
  } else if (is.logical(ours) || is.logical(theirs)) {
    isTRUE(as.logical(ours) == as.logical(theirs))
  } else if (is.character(ours) || is.character(theirs)) {
    identical(as.character(ours), as.character(theirs))
  } else {
    !is.na(theirs) && abs(as.numeric(ours) - as.numeric(theirs)) <= tolerance
  }
  if (!isTRUE(ok)) {
    fails <<- fails + 1L
    cat("  MISMATCH ", what, ": canvas ", format(ours), ", document ", format(theirs), "\n",
        sep = "")
  }
}

# Aligned on `id` rather than zipped: `graph_from_data_frame` is given a vertex table here so the
# orders do match, but a comparison that only works because of that would go quietly wrong the
# day the emitter stops passing one.
check_frame <- function(label, ours, theirs) {
  missing <- setdiff(names(ours), names(theirs))
  if (length(missing)) {
    fails <<- fails + 1L
    cat("  MISSING in ", label, ": ", paste(missing, collapse = ", "), "\n", sep = "")
  }
  order_of <- if (!is.null(ours$id) && !is.null(theirs$id)) {
    match(as.character(ours$id), as.character(theirs$id))
  } else {
    seq_len(nrow(theirs))
  }
  for (name in setdiff(names(ours), skip)) {
    if (!(name %in% names(theirs))) next
    tolerance <- if (name %in% names(loose)) loose[[name]] else 1e-9
    mine <- ours[[name]]
    yours <- theirs[[name]][order_of]
    for (row in seq_along(mine)) {
      compare(sprintf("%s.%s[%d]", label, name, row), mine[[row]], yours[[row]], tolerance)
    }
  }
}

cat(vcount(g), " nodes, ", ecount(g), " links\n", sep = "")

metrics <- coda_network_metrics(g)
check_frame("metrics.nodes", probe$metrics$nodes, metrics$nodes)
check_frame("metrics.summary", probe$metrics$summary, metrics$summary)

options <- probe$options
central <- coda_network_centrality(
  g,
  betweenness = options$betweenness,
  closeness = options$closeness,
  pagerank = options$pagerank,
  eigenvector = options$eigenvector,
  communities = options$communities,
  weighted = options$weighted,
  seed = options$seed,
  resolution = options$resolution,
  damping = options$damping
)
check_frame("centrality.nodes", probe$centrality$nodes, central$nodes)
check_frame("centrality.summary", probe$centrality$summary, central$summary)

# The partition itself is not compared — see the header — but its quality is, and a Louvain that
# had silently fallen back to one group per node would fail here.
cat("  communities: canvas ", probe$centrality$summary$communities[1], " at modularity ",
    sprintf("%.4f", probe$centrality$summary$modularity[1]), "; document ",
    central$summary$communities[1], " at ",
    sprintf("%.4f", central$summary$modularity[1]), "\n", sep = "")
compare("centrality.summary.modularity", probe$centrality$summary$modularity[1],
        central$summary$modularity[1], 0.05)

cat(checks - fails, "/", checks, " comparisons agree\n", sep = "")
if (fails > 0L) {
  quit(status = 1L)
}
