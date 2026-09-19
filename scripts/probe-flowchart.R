#!/usr/bin/env Rscript
# Run the generated `coda_flow_layers` and check it answers what the canvas answered.
#
#     pnpm probe:flowchart
#
# The last third of a three-language check; `scripts/probe-flowchart.ts` writes the reference.
# The helper is read out of the golden R Markdown rather than transcribed here, so what runs is
# exactly what the exporter writes — `probe-r-helpers.R`' arrangement and for its reason.
#
# **The second half is the part that could not be settled by reading.** The emitted cell draws on
# `layout_with_sugiyama`'s `extd_graph`, which is the original graph plus a dummy vertex per layer
# a long edge crosses — that is the whole reason this emitter reaches for Sugiyama rather than
# `layout_as_tree`, since it is what routes an arrow around the boxes between its ends. But an
# edge that gets split is not the edge that arrived, and whether the pieces keep the original's
# attributes decides whether `E(.g)$weight` and `E(.g)$label` are the right numbers, the wrong
# numbers, or NULL. igraph's documentation does not say. So it is measured here.

suppressPackageStartupMessages(library(igraph))

root <- normalizePath(file.path(dirname(sub("^--file=", "", grep("^--file=",
  commandArgs(trailingOnly = FALSE), value = TRUE)[1])), ".."))
rmd <- file.path(root, "src", "export", "r", "__fixtures__", "everything.Rmd")
reference <- if (length(commandArgs(trailingOnly = TRUE))) {
  commandArgs(trailingOnly = TRUE)[1]
} else "/tmp/coda-flowchart-probe.json"

if (!file.exists(reference)) {
  stop(sprintf("%s missing - run the vite-node half of `pnpm probe:flowchart` first", reference))
}

# The generated helper, lifted out of the golden document by its own first line.
lines <- readLines(rmd, warn = FALSE)
start <- grep("^coda_flow_layers <- function", lines)[1]
if (is.na(start)) stop("no coda_flow_layers in the golden document")
# To the closing brace at column zero, which is where a top-level function ends.
ends <- grep("^\\}$", lines)
stop_at <- ends[ends > start][1]
eval(parse(text = paste(lines[start:stop_at], collapse = "\n")), envir = globalenv())

fails <- character(0)
check <- function(name, cond, detail = "") {
  cat(sprintf("%s %s%s\n", if (isTRUE(cond)) "ok  " else "FAIL", name,
              if (nzchar(detail)) paste0("   ", detail) else ""))
  if (!isTRUE(cond)) fails <<- c(fails, name)
}

# `simplifyVector = FALSE` throughout, so an edge stays a three-element list rather than being
# collapsed into a character matrix — which is what jsonlite does by default to an array of
# same-length arrays, and which silently turns `e[[2]]` into the wrong subscript.
cases <- jsonlite::fromJSON(reference, simplifyVector = FALSE)

for (case in cases) {
  ids <- unlist(case$nodes)
  edges <- do.call(rbind, lapply(case$edges, function(e) {
    data.frame(from = e[[1]], to = e[[2]], weight = as.numeric(e[[3]]))
  }))
  g <- igraph::graph_from_data_frame(edges, directed = TRUE, vertices = data.frame(
    name = ids,
    hops = vapply(ids, function(id) {
      v <- case$hops[[id]]
      if (is.null(v)) NA_real_ else as.numeric(v)
    }, numeric(1))
  ))

  layers <- if (is.null(case$layerColumn)) {
    coda_flow_layers(g)
  } else {
    coda_flow_layers(g, layer_attr = case$layerColumn)
  }
  # Coda is 0-based and igraph's `layers` argument is 1-based, so the helper returns 1-based and
  # the comparison takes the offset back off. That offset is real rather than cosmetic — see the
  # helper — so it is stated here rather than hidden in either side.
  got <- setNames(as.integer(layers) - 1L, igraph::V(g)$name)
  want <- vapply(ids, function(id) as.integer(case$layers[[id]]), integer(1))
  same <- all(got[ids] == want)
  check(sprintf("%s: the same layering as the canvas", case$name), same,
        if (same) "" else paste(sprintf("%s=%d/%d", ids, got[ids], want), collapse = " "))

  kinds <- vapply(case$edges, function(e) {
    a <- got[[e[[1]]]]; b <- got[[e[[2]]]]
    if (e[[1]] == e[[2]]) "self" else if (b > a) "forward" else if (b < a) "back" else "within"
  }, character(1))
  names(kinds) <- vapply(case$edges, function(e) paste0(e[[1]], "->", e[[2]]), character(1))
  want_kinds <- unlist(case$kinds)
  check(sprintf("%s: the same feedback edges", case$name),
        identical(kinds[names(want_kinds)], want_kinds))

  # The call the emitted cell makes.
  sugi <- igraph::layout_with_sugiyama(g, layers = as.integer(layers))
  check(sprintf("%s: sugiyama places every real vertex", case$name),
        nrow(sugi$layout) == length(ids))

  # One row per layer, and the layers run **downwards**: layer 1 sits at the largest y, which
  # plots at the top since igraph's y increases upward. Measured, not assumed — the first
  # version of the emitted cell exchanged the two axes for left-to-right and drew the circuit
  # right to left, which is what this check now pins.
  ys <- split(round(sugi$layout[, 2], 6), got[igraph::V(g)$name])
  one_per_layer <- all(vapply(ys, function(v) length(unique(v)) == 1, logical(1)))
  descending <- unlist(lapply(ys[order(as.integer(names(ys)))], function(v) unique(v)))
  check(sprintf("%s: one row per layer, layers running downwards", case$name),
        one_per_layer && !is.unsorted(rev(descending)),
        if (one_per_layer) "" else paste(capture.output(str(ys)), collapse = " "))
}

# ---------------------------------------------------------------------------
# What `extd_graph` does to an edge it splits
# ---------------------------------------------------------------------------

cat("\n-- extd_graph, measured --\n")

# `a -> d` skips two layers, so Sugiyama has to route it: this is the case the emitter exists for.
skip <- igraph::graph_from_data_frame(
  data.frame(
    from = c("a", "b", "c", "a"),
    to = c("b", "c", "d", "d"),
    weight = c(10, 20, 30, 999)
  ),
  directed = TRUE
)
layers <- coda_flow_layers(skip)
sugi <- igraph::layout_with_sugiyama(skip, layers = as.integer(layers))
ext <- sugi$extd_graph

cat(sprintf("original: %d vertices, %d edges\n", igraph::vcount(skip), igraph::ecount(skip)))
cat(sprintf("extended: %d vertices, %d edges\n", igraph::vcount(ext), igraph::ecount(ext)))
cat(sprintf("edge attributes on the extended graph: %s\n",
            paste(igraph::edge_attr_names(ext), collapse = ", ") ))
cat(sprintf("vertex attributes on the extended graph: %s\n",
            paste(igraph::vertex_attr_names(ext), collapse = ", ") ))

check("extd_graph adds a dummy vertex per crossed layer",
      igraph::vcount(ext) > igraph::vcount(skip),
      sprintf("%d -> %d", igraph::vcount(skip), igraph::vcount(ext)))

# The question. If `weight` is absent, `E(.g)$weight` is NULL and every arrow in the emitted
# figure is one width. If it is present but the split pieces carry NA, the widths are wrong for
# exactly the long edges. Either way the emitter has to know which.
has_weight <- "weight" %in% igraph::edge_attr_names(ext)
cat(sprintf("weight kept on the extended graph: %s\n", has_weight))
check("extd_graph drops every original edge attribute", !has_weight)
check("extd_graph carries `orig`, the 1-based original edge index",
      "orig" %in% igraph::edge_attr_names(ext))

# So this is how the emitted cell has to read a weight, and the check is that it lands the
# original's value on every piece of a split edge.
orig <- igraph::E(ext)$orig
mapped <- igraph::E(skip)$weight[orig]
pieces <- which(orig == 4L)
check("reading through `orig` gives every piece of a split edge the original's weight",
      length(pieces) == 3 && all(mapped[pieces] == 999),
      sprintf("%d pieces, weights %s", length(pieces),
              paste(mapped[pieces], collapse = "/")))

# And the gift: igraph has already suppressed the arrowheads on all but the last piece, so a
# routed arrow draws one head at its real target and the emitter must not overwrite this.
modes <- igraph::E(ext)$arrow.mode[pieces]
check("arrow.mode leaves one arrowhead on the last piece of a split edge",
      sum(modes != 0) == 1 && tail(modes, 1) != 0,
      paste(modes, collapse = "/"))

# The real vertices come first, which is what makes `.real <- seq_len(vcount(g))` right.
check("the dummy vertices come after every real one",
      identical(igraph::V(ext)$dummy,
                c(rep(FALSE, igraph::vcount(skip)),
                  rep(TRUE, igraph::vcount(ext) - igraph::vcount(skip)))))

# ---------------------------------------------------------------------------
# The emitted cell itself, run
# ---------------------------------------------------------------------------

# Lifted out of the golden document and executed against a graph of our own, because the checks
# above cover the *helper* and the golden covers the *text* — and neither runs the twelve lines
# that actually draw. Both bugs this probe found were in those twelve lines, not in the helper.
cat("\n-- the emitted cell, run --\n")

suppressPackageStartupMessages({
  library(dplyr)
  library(tibble)
})

chunk_start <- grep("^```\\{r flow-chart\\}$", lines)[1]
if (is.na(chunk_start)) stop("no flow-chart chunk in the golden document")
fence <- grep("^```$", lines)
chunk_end <- fence[fence > chunk_start][1]
cell <- lines[(chunk_start + 1):(chunk_end - 1)]

# The cell's input variable, bound to a graph carrying everything it reads: a `hop` column to
# layer by, a `role` column to label by, `weight` for the widths and `pairs` for the labels —
# and an edge that skips a layer, which is the case `extd_graph` exists for.
paths_network <- igraph::graph_from_data_frame(
  data.frame(
    from = c("in1", "via", "via2", "in1"),
    to = c("via", "via2", "out", "out"),
    weight = c(120, 45, 300, 8),
    pairs = c(3L, 2L, 7L, 1L)
  ),
  directed = TRUE,
  vertices = data.frame(
    name = c("in1", "via", "via2", "out"),
    hop = c(0L, 1L, 2L, 3L),
    role = c("source", "via", "via", "target")
  )
)

pdf(NULL)
ran <- tryCatch({
  eval(parse(text = paste(cell, collapse = "\n")), envir = globalenv())
  TRUE
}, error = function(e) {
  cat(sprintf("   error: %s\n", conditionMessage(e)))
  FALSE
}, warning = function(w) {
  cat(sprintf("   warning: %s\n", conditionMessage(w)))
  FALSE
})
invisible(dev.off())

check("the emitted cell runs with no error or warning", ran)
check("it binds the pass-through and the selection",
      exists("flow_chart_out") && exists("flow_chart_selected"))
if (exists("flow_chart_selected")) {
  # The fixture's selection names a neuron this graph does not have, so the frame is empty —
  # what is checked is that the column survives, since an empty double column is what makes a
  # later `bind_rows` against a real one error outright.
  check("the selection frame keeps a character neuronId column",
        is.character(flow_chart_selected$neuronId),
        sprintf("%d rows", nrow(flow_chart_selected)))
}

if (length(fails)) {
  cat(sprintf("\n%d failed\n", length(fails)))
  quit(status = 1)
}
cat("\nall passed\n")
