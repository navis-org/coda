/**
 * The generated R a CAVE datastack needs — the R twin of `python/caveHelpers.ts`, through fafbseg.
 *
 * fafbseg drives Python's caveclient through reticulate, and that seam is the whole design:
 *
 * - **Rows come back through `fafbseg::flywire_cave_query`**, which carries pandas into R by way
 *   of arrow and keeps an eighteen-digit root id exact as `integer64`. A plain reticulate
 *   conversion of the same frame turns every root id into `NA` — it overflows R's 32-bit integer
 *   with only a warning, measured on `flywire_fafb_public`. `coda_cave_query` is the one door,
 *   and it turns each `integer64` column into text, the form Coda keeps ids in (invariant 8).
 * - **A client is caveclient's own `CAVEclient`, pinned to the dataset's materialization**, for
 *   what fafbseg does not wrap: listings, table metadata, the two row counts. fafbseg's own client
 *   follows the newest materialization, and a listing should describe the one the graph names.
 * - **Update root IDs is run as Python**: the notebook's functions, defined in reticulate's
 *   session by `coda_cave_python()` from the same registry the notebook is written from, so the
 *   two documents run one algorithm. Its vote is int64 arithmetic R has no exact type for, and
 *   the ids cross both ways as text.
 *
 * fafbseg reaches CAVE's global server only — its client takes a datastack name and no server —
 * so a datastack on another deployment is a TODO in the emitter rather than a query sent to the
 * wrong service. Checked by `pnpm probe:cave`, which runs both documents against
 * `flywire_fafb_public` and compares them with the canvas.
 */

import '../python/caveHelpers'
import { resolveHelpers as resolvePythonHelpers } from '../python/registry'
import { registerHelper } from './registry'

/** A dataset, its pinned client, and the one query every read goes through — fafbseg's, with integer64 ids turned to text. */
registerHelper({
  name: 'coda_cave_dataset',
  requires: ['fafbseg', 'arrow', 'reticulate'],
  source: [
    'coda_cave_dataset <- function(datastack, version, neuron_table = NULL, id_column = "pt_root_id",',
    '                              annotation_table = NULL, ref_column = NULL,',
    '                              system_column = NULL, value_column = NULL, labels = NULL) {',
    '  # A CAVE datastack at one materialization, and the neuron table Coda labels it with.',
    '  #',
    "  # An environment -- this function's own frame, which already holds every argument -- so",
    '  # the neuron table (coda_cave_labels) is built once and shared by every chunk that reads it.',
    '  # `labels` is passed in when an annotation source was wired to the Dataset on the canvas,',
    "  # and replaces the datastack's own.",
    '  version <- as.integer(version)',
    '  environment()',
    '}',
    '',
    '.coda_cave_clients <- new.env()',
    '',
    'coda_cave_client <- function(ds) {',
    "  # caveclient's CAVEclient pinned to the dataset's materialization, so its timestamp is the",
    "  # snapshot's: what Update root IDs brings ids forward to, and what listings describe. One",
    '  # per datastack and materialization for the session, however many chunks name them.',
    '  key <- paste(ds$datastack, ds$version)',
    '  if (is.null(.coda_cave_clients[[key]])) {',
    '    caveclient <- reticulate::import("caveclient")',
    '    .coda_cave_clients[[key]] <- caveclient$CAVEclient(ds$datastack, version = ds$version)',
    '  }',
    '  .coda_cave_clients[[key]]',
    '}',
    '',
    'coda_cave_query <- function(ds, table, ..., limit = NULL) {',
    "  # Rows of a table or view at the dataset's materialization, through fafbseg, with every",
    '  # integer64 column -- an id -- as exact text, the form Coda keeps ids in.',
    '  out <- fafbseg::flywire_cave_query(',
    '    table, datastack_name = ds$datastack, version = ds$version,',
    '    limit = limit, fetch_all_rows = is.null(limit), ...',
    '  )',
    '  for (name in names(out)) {',
    '    if (inherits(out[[name]], "integer64")) out[[name]] <- as.character(out[[name]])',
    '  }',
    '  # Only the columns a plain list asked for: a bound point brings its supervoxel along',
    "  # whatever `select_columns` names. A join's {table: columns} map is read as it comes.",
    '  select <- list(...)$select_columns',
    '  if (is.list(select) && is.null(names(select))) {',
    '    out <- out[, intersect(unlist(select), names(out)), drop = FALSE]',
    '  }',
    '  out',
    '}',
  ],
})

/** Coda's neuron table for a datastack: the `CaveSource` index, one annotation kind at a time. */
registerHelper({
  name: 'coda_cave_labels',
  needs: ['coda_cave_dataset', 'coda_annotation_columns'],
  requires: ['dplyr'],
  source: [
    'coda_cave_wide <- function(ds, table, kind_column, value_column, key, select, ...) {',
    '  # One column per value of `kind_column`, each the first `value_column` per `key` -- an',
    '  # annotation table read one kind at a time, as Coda does, since the whole of one can exceed',
    "  # a deployment's row cap, which the server applies by truncating.",
    '  client <- coda_cave_client(ds)',
    '  kinds <- client$materialize$get_unique_string_values(table)[[kind_column]]',
    '  wide <- NULL',
    '  for (kind in unlist(kinds)) {',
    '    rows <- coda_cave_query(',
    '      # Through to caveclient as it is: fafbseg would read a kind like "1" in a',
    '      # `filter_in_dict` as an id and send it as a number, which matches no string.',
    '      ds, table, filter_equal_dict = stats::setNames(list(kind), kind_column),',
    '      select_columns = select, ...',
    '    )',
    '    rows <- rows[!duplicated(rows[[key]]), , drop = FALSE]',
    '    rows <- rows[, c(key, value_column), drop = FALSE]',
    '    names(rows)[2] <- kind',
    '    wide <- if (is.null(wide)) rows else dplyr::full_join(wide, rows, by = key)',
    '  }',
    '  wide',
    '}',
    '',
    'coda_cave_labels <- function(ds) {',
    "  # Coda's neuron table for the datastack, one row per neuron and one column per annotation",
    '  # kind, built on first use.',
    '  if (!is.null(ds$labels)) return(ds$labels)',
    '  if (is.null(ds$neuron_table)) {',
    '    stop("This datastack publishes no neuron table, so the only list of its neurons is an ",',
    '         "annotation source. Wire one to the Dataset on the canvas and export again.")',
    '  }',
    '  neurons <- coda_cave_query(',
    '    ds, ds$neuron_table, select_columns = as.list(c("id", ds$id_column)),',
    '    merge_reference = FALSE',
    '  )',
    '  out <- neurons',
    '  if (!is.null(ds$annotation_table)) {',
    '    wide <- coda_cave_wide(',
    '      ds, ds$annotation_table, ds$system_column, ds$value_column, ds$ref_column,',
    '      as.list(c(ds$ref_column, ds$value_column)), merge_reference = FALSE',
    '    )',
    '    if (!is.null(wide)) {',
    '      names(wide)[names(wide) == ds$ref_column] <- "id"',
    '      neurons$id <- as.character(neurons$id)',
    '      wide$id <- as.character(wide$id)',
    '      out <- dplyr::left_join(neurons, wide, by = "id")',
    '    }',
    '  }',
    '  out$id <- NULL',
    '  ds$labels <- coda_annotation_columns(out, ds$id_column)',
    '  ds$labels',
    '}',
  ],
})

/** A CAVE annotation table read as a neuron table, through its reference table where it has one. */
registerHelper({
  name: 'coda_cave_table',
  needs: ['coda_cave_labels', 'coda_annotation_columns'],
  requires: ['dplyr'],
  source: [
    'coda_cave_table <- function(ds, table, id_column = "pt_root_id", columns = NULL,',
    '                            pivot_on = NULL, value_column = NULL) {',
    '  # A CAVE annotation table as a Coda neuron table. A reference table has no root id of its',
    '  # own -- it lives in the table it references -- so it is read through that join.',
    '  client <- coda_cave_client(ds)',
    '  reference <- client$materialize$get_table_metadata(table)$reference_table',
    '  if (!is.null(reference) && !nzchar(reference)) reference <- NULL',
    '  select <- function(own) {',
    '    # A join needs a {table: columns} map naming both tables; a plain query needs a list.',
    '    if (is.null(reference)) return(as.list(c(id_column, own)))',
    '    stats::setNames(list(as.list(own), list(id_column)), c(table, reference))',
    '  }',
    '  if (!is.null(pivot_on)) {',
    '    out <- coda_cave_wide(',
    '      ds, table, pivot_on, value_column, id_column, select(value_column),',
    '      merge_reference = !is.null(reference)',
    '    )',
    '    if (is.null(out)) out <- stats::setNames(data.frame(character(0)), id_column)',
    '  } else {',
    '    own <- columns',
    '    if (!is.null(reference) && is.null(own)) {',
    '      # A join must name its columns, so read one row to learn them.',
    '      sample <- coda_cave_query(ds, table, limit = 1L, merge_reference = FALSE)',
    '      own <- setdiff(names(sample), id_column)',
    '    }',
    '    out <- coda_cave_query(',
    '      ds, table, select_columns = if (is.null(own)) NULL else select(own),',
    '      merge_reference = !is.null(reference)',
    '    )',
    '    if (!is.null(own)) out <- out[, c(id_column, intersect(own, names(out))), drop = FALSE]',
    '  }',
    '  coda_annotation_columns(out, id_column)',
    '}',
  ],
})

/** List CAVE tables: the materialization's tables and, optionally, its views. */
registerHelper({
  name: 'coda_cave_tables',
  needs: ['coda_cave_dataset'],
  source: [
    'coda_cave_tables <- function(ds, include_views = TRUE) {',
    "  # The annotation tables in the dataset's materialization and, optionally, its views --",
    "  # which hold a datastack's aggregations, FlyWire's connectivity among them.",
    '  client <- coda_cave_client(ds)',
    '  tables <- sort(unlist(client$materialize$get_tables()))',
    '  out <- data.frame(table = tables, kind = rep("table", length(tables)))',
    '  if (include_views) {',
    '    views <- sort(names(client$materialize$get_views()))',
    '    out <- rbind(out, data.frame(table = views, kind = rep("view", length(views))))',
    '  }',
    '  out',
    '}',
  ],
})

/** CAVE table info: metadata and both row counts printed, the columns returned. */
registerHelper({
  name: 'coda_cave_table_info',
  needs: ['coda_cave_dataset'],
  source: [
    'coda_cave_table_info <- function(ds, table) {',
    '  # Describe a table or view: print its metadata and row counts, and return its columns, each',
    '  # with its R class and an example value from one row.',
    '  client <- coda_cave_client(ds)',
    '  views <- names(client$materialize$get_views())',
    '  tables <- unlist(client$materialize$get_tables())',
    '  if (!(table %in% c(tables, views))) {',
    '    stop(sprintf(\'"%s" is not a table or view in this datastack. Available: %s\',',
    '                 table, paste(c(sort(tables), sort(views)), collapse = ", ")))',
    '  }',
    '  if (table %in% views) {',
    '    meta <- client$materialize$get_view_metadata(table)',
    '    cat(sprintf("%s  (view)\\n", table))',
    '    cat("  note: CAVE does not push a row limit into a view, so an aggregating one builds its",',
    '        "whole result before handing back the single row read below.\\n")',
    '  } else {',
    '    meta <- client$materialize$get_table_metadata(table)',
    '    cat(sprintf("%s  (%s)\\n", table, if (is.null(meta$schema_type)) "?" else meta$schema_type))',
    '    # Two row counts that can differ by up to a third: the live table and the frozen snapshot.',
    '    live <- client$annotation$get_annotation_count(table)',
    '    frozen <- client$materialize$get_annotation_count(table)',
    '    cat(sprintf("  rows: %s live, %s in v%d\\n", format(live, big.mark = ","),',
    '                format(frozen, big.mark = ","), ds$version))',
    '    if (!is.null(meta$reference_table)) cat(sprintf("  annotates: %s\\n", meta$reference_table))',
    '    if (!is.null(meta$notice_text)) cat(sprintf("  NOTICE: %s\\n", meta$notice_text))',
    '  }',
    '  if (!is.null(meta$description)) cat("\\n", trimws(meta$description), "\\n", sep = "")',
    '  # split_positions gives separate x/y/z columns, matching the columns Coda lists.',
    '  sample <- coda_cave_query(ds, table, limit = 1L, split_positions = TRUE)',
    '  example <- function(x) {',
    '    if (nrow(sample) == 0) return("")',
    '    value <- x[[1]]',
    '    if (length(value) == 1 && is.na(value)) "" else paste(format(value), collapse = " ")',
    '  }',
    '  data.frame(',
    '    column = names(sample),',
    '    type = vapply(sample, function(x) class(x)[1], ""),',
    '    example = vapply(sample, example, ""),',
    '    row.names = NULL',
    '  )',
    '}',
  ],
})

/** A synapse table reshaped into Synapses Between's columns, at the drawn end. */
registerHelper({
  name: 'coda_synapses_between',
  source: [
    'coda_synapses_between <- function(df, pre, post, position, confidence, location) {',
    "  # Reshape a synapse-connection table into Coda's Synapses Between columns. `position` names",
    "  # the drawn end's columns with {axis} for x, y and z.",
    '  at <- function(axis) df[[sub("{axis}", axis, position, fixed = TRUE)]]',
    '  tibble::tibble(',
    '    neuronId = as.character(df[[pre]]),',
    '    partnerId = as.character(df[[post]]),',
    '    polarity = rep(location, nrow(df)),',
    '    confidence = if (confidence %in% names(df)) as.numeric(df[[confidence]]) else NA_real_,',
    '    x = as.numeric(at("x")),',
    '    y = as.numeric(at("y")),',
    '    z = as.numeric(at("z"))',
    '  )',
    '}',
  ],
})

/**
 * The notebook's root-id repair, as the Python source `coda_cave_python()` defines in reticulate's
 * session. Read from the notebook's registry rather than copied, so a fix there reaches both.
 */
const ROOT_ID_PYTHON: string[] = [
  'import numpy as np',
  'import pandas as pd',
  ...resolvePythonHelpers(['coda_update_root_ids', 'coda_update_root_ids_majority']).flatMap(
    (spec) => ['', '', ...spec.source],
  ),
  '',
  '',
  'def coda_update_root_ids_for_r(client, df, id_column, sample=None, supervoxel_column=None):',
  '    """Either method, with text handed back as plain strings: pandas may hold text as',
  '    Arrow arrays, which reticulate does not convert into R."""',
  '    if supervoxel_column is None:',
  '        out = coda_update_root_ids_majority(client, df, int(sample), id_column)',
  '    else:',
  '        out = coda_update_root_ids(client, df, id_column, supervoxel_column)',
  '    text = [c for c in out.columns if pd.api.types.is_string_dtype(out[c])]',
  '    return out.astype({c: object for c in text})',
]

/** Update root IDs: the notebook's two methods, run as Python, with the ids crossing as text. */
registerHelper({
  name: 'coda_update_root_ids',
  needs: ['coda_cave_dataset'],
  requires: ['reticulate'],
  source: [
    'coda_update_root_ids <- function(ds, df, id_column = "neuronId", sample = NULL,',
    '                                 supervoxel_column = NULL) {',
    "  # Bring outdated root ids forward to the dataset's materialization, as Coda's Update root",
    "  # IDs node: by each row's supervoxel where `supervoxel_column` is given, otherwise by the",
    "  # majority of the old root's chunks (`sample` of them), adding `idConfidence`.",
    '  #',
    "  # Run as Python, with the notebook's own functions: the vote is int64 arithmetic, which R",
    '  # has no exact type for, and the ids cross to Python and back as text.',
    '  coda_cave_python()',
    '  # Only the columns the repair reads cross to Python, as text; the rest of the table stays',
    '  # in R, where the repaired ids (and, by majority, `idConfidence`) are written back into it.',
    '  cols <- unique(c(id_column, supervoxel_column))',
    '  asked <- as.data.frame(lapply(df[cols], as.character), stringsAsFactors = FALSE)',
    '  names(asked) <- cols',
    '  out <- reticulate::py$coda_update_root_ids_for_r(',
    '    coda_cave_client(ds), reticulate::r_to_py(asked), id_column,',
    '    sample = sample, supervoxel_column = supervoxel_column',
    '  )',
    '  df[[id_column]] <- out[[id_column]]',
    '  if (is.null(supervoxel_column)) df$idConfidence <- out$idConfidence',
    '  df',
    '}',
    '',
    'coda_cave_python <- function() {',
    "  # Define the notebook's root-id functions in reticulate's Python, once per session.",
    '  if (!reticulate::py_has_attr(reticulate::import_main(), "coda_update_root_ids_for_r")) {',
    '    reticulate::py_run_string(CODA_CAVE_PYTHON)',
    '  }',
    '  invisible(NULL)',
    '}',
    '',
    'CODA_CAVE_PYTHON <- r"---(',
    ...ROOT_ID_PYTHON,
    ')---"',
  ],
})
