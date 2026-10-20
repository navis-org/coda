/**
 * The Neuroglancer node's helpers, R half: the same rules as the Python half
 * (`python/neuroglancerHelpers.ts`), with nglscenes-r doing the scene work as nglscenes does there.
 *
 * nglscenes-r reads a scene losslessly and writes it back exactly, which is the part that used to
 * be boilerplate here and the part that went wrong first: jsonlite's defaults round a published
 * camera to 15 digits, and write a one-element segment list as a bare string. Measured against the
 * four published neuPrint scenes, a read and write through nglscenes-r returns each unchanged.
 *
 * What stays here is Coda's own: which ids neuroglancer can read, the viewer edits, how a colour is
 * chosen, which layer the neurons go in, and the bounding boxes. A tie between two categories is
 * broken by ICU through stringi, the browser's collation, rather than by `order()`, whose answer
 * depends on the session's locale.
 *
 * Checked like the Python half: the decoded state of every link these build was compared with
 * `buildScene` and `sceneUrl` over the four published neuPrint scenes and came out identical.
 */

import { SEUNGLAB_HOSTS } from '../../data/neuroglancer/scene'
import { rVector } from './r'
import { registerHelper } from './registry'

/** The Seung-lab hosts as an R vector, sorted so the golden does not depend on insertion order. */
const rHostVector = rVector([...SEUNGLAB_HOSTS].sort())

/** `idText` then `isSegmentId`, first appearance kept, unreadable rows counted. */
registerHelper({
  name: 'coda_segment_ids',
  source: [
    'coda_segment_ids <- function(ids) {',
    '  # The ids neuroglancer can read, as text, each once and in order. Neuroglancer takes a segment',
    '  # id only as a plain whole number, and one it cannot read breaks the whole layer, so anything',
    '  # else is left out and counted, as on the canvas. A blank row is dropped without a word.',
    '  ids <- trimws(as.character(ids))',
    '  readable <- !is.na(ids) & grepl("^(0|[1-9][0-9]*)$", ids)',
    '  unreadable <- sum(!is.na(ids) & !readable)',
    '  if (unreadable > 0) {',
    '    message(unreadable, " of ", length(ids), " rows have an id neuroglancer cannot use and were left out.")',
    '  }',
    '  unique(ids[readable])',
    '}',
  ],
})
/** `applySelectionEdits`, over the readable ids. */
registerHelper({
  name: 'coda_shown_segments',
  needs: ['coda_segment_ids'],
  source: [
    'coda_shown_segments <- function(ids, added = character(0), removed = character(0), limit = NULL) {',
    "  # The segments Coda's Neuroglancer node shows: the input's ids less the ones removed in the",
    '  # viewer, then the ones added there that the input does not have, in id order. Past `limit`',
    '  # input ids it says so, as the card does.',
    '  shown <- coda_segment_ids(ids)',
    '  if (!is.null(limit) && length(shown) > limit) {',
    '    message(length(shown), " neurons is more than ", limit, ". Neuroglancer draws every one, ",',
    '            "and some browsers cut off a link this long.")',
    '  }',
    '  extra <- setdiff(as.character(added), shown)',
    '  # Id order without parsing an 18-digit id into a double: shorter first, then digit by digit.',
    '  extra <- extra[order(nchar(extra), extra, method = "radix")]',
    '  c(shown[!shown %in% removed], extra)',
    '}',
  ],
})
/** A colour per segment, the first row's. */
registerHelper({
  name: 'coda_segment_colors',
  source: [
    'coda_segment_colors <- function(ids, colors) {',
    '  # A colour per segment from a column of ids and a colour per row. The first row wins.',
    '  ids <- trimws(as.character(ids))',
    '  keep <- !is.na(ids) & !duplicated(ids)',
    '  stats::setNames(colors[keep], ids[keep])',
    '}',
  ],
})
/** `resolveColor`'s categorical branch: frequency, then ICU order, the palette cycled, overrides winning. */
registerHelper({
  name: 'coda_category_colors',
  requires: ['stringi', 'jsonlite'],
  source: [
    'coda_js_numbers <- function(v) {',
    "  # JavaScript's String(number) for each of `v`: the shortest digits that read back the same,",
    '  # written plainly from 1e-6 up to 1e21 and with an exponent outside that. Every value is tried',
    '  # at one precision at a time, so a column of 10^5 distinct scores is seventeen parses, not',
    '  # seventeen per value.',
    '  out <- character(length(v))',
    '  out[v == Inf] <- "Infinity"',
    '  out[v == -Inf] <- "-Infinity"',
    '  out[v == 0] <- "0"',
    '  finite <- which(is.finite(v) & v != 0)',
    '  text <- character(length(v))',
    '  todo <- finite',
    '  for (p in 1:17) {',
    '    if (length(todo) == 0) break',
    '    candidate <- sprintf("%.*e", p - 1L, abs(v[todo]))',
    "    # jsonlite reads them with C's strtod: R's own as.numeric() misreads some, 1e300 among them.",
    '    back <- jsonlite::parse_json(paste0("[", paste(candidate, collapse = ","), "]"), simplifyVector = TRUE)',
    '    done <- back == abs(v[todo])',
    '    text[todo[done]] <- candidate[done]',
    '    todo <- todo[!done]',
    '  }',
    '  digits <- sub("0+$", "", sub(".", "", sub("e.*$", "", text[finite]), fixed = TRUE))',
    '  point <- as.integer(sub("^.*e", "", text[finite])) + 1L',
    '  k <- nchar(digits)',
    '  e <- point - 1L',
    '  spelled <- ifelse(',
    '    k <= point & point <= 21, paste0(digits, strrep("0", pmax(point - k, 0L))),',
    '    ifelse(',
    '      0 < point & point <= 21, paste0(substr(digits, 1, point), ".", substr(digits, point + 1, k)),',
    '      ifelse(',
    '        -6 < point & point <= 0, paste0("0.", strrep("0", pmax(-point, 0L)), digits),',
    '        paste0(substr(digits, 1, 1), ifelse(k > 1, paste0(".", substr(digits, 2, k)), ""),',
    '               "e", ifelse(e >= 0, "+", "-"), abs(e))',
    '      )',
    '    )',
    '  )',
    '  out[finite] <- paste0(ifelse(v[finite] < 0, "-", ""), spelled)',
    '  out',
    '}',
    '',
    'coda_label <- function(values) {',
    '  # A cell as the canvas spells it: an em dash for a blank, and numbers and flags the way',
    "  # JavaScript writes them, so overrides keyed on the canvas' labels still match.",
    '  if (is.logical(values)) {',
    '    out <- ifelse(values, "true", "false")',
    '  } else if (is.numeric(values)) {',
    '    # Each distinct value once: a category column repeats its values.',
    '    distinct <- unique(values)',
    '    spelled <- rep(NA_character_, length(distinct))',
    '    spelled[!is.na(distinct)] <- coda_js_numbers(distinct[!is.na(distinct)])',
    '    out <- spelled[match(values, distinct)]',
    '  } else {',
    '    out <- as.character(values)',
    '  }',
    '  out[is.na(values) | is.na(out)] <- "\\u2014"',
    '  out',
    '}',
    '',
    'coda_category_colors <- function(values, palette, overrides = character(0)) {',
    '  # A colour per row, the way Coda colours a column "by category". The commonest value gets the',
    "  # palette's first colour, the next one the second, and the palette starts over when it runs",
    "  # out. Ties go alphabetically, in the browser's order (ICU's, through stringi). A colour picked",
    '  # for a value on the canvas (`overrides`) wins.',
    '  labels <- coda_label(values)',
    '  counts <- table(labels)',
    '  distinct <- names(counts)',
    '  collated <- stringi::stri_rank(distinct, opts_collator = stringi::stri_opts_collator(locale = "en"))',
    '  ranked <- distinct[order(-as.integer(counts), collated)]',
    '  color_of <- stats::setNames(palette[(seq_along(ranked) - 1) %% length(palette) + 1], ranked)',
    '  picked <- intersect(names(overrides), ranked)',
    '  color_of[picked] <- overrides[picked]',
    '  unname(color_of[labels])',
    '}',
  ],
})
/** `literalColor`: a hex colour is itself, anything else the fallback. */
registerHelper({
  name: 'coda_literal_colors',
  source: [
    'coda_literal_colors <- function(values, fallback) {',
    '  # A colour per row from a column of colours. A cell that is not one gets `fallback`.',
    '  if (!is.character(values)) return(rep(fallback, length(values)))',
    '  text <- trimws(values)',
    '  ok <- !is.na(text) & grepl("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", text)',
    '  ifelse(ok, text, fallback)',
    '}',
  ],
})
/** `buildScene`, for one dataset's neurons, on a scene nglscenes-r read. */
registerHelper({
  name: 'coda_neuroglancer_scene',
  requires: ['nglscenes'],
  source: [
    'coda_neuroglancer_scene <- function(scene, dataset, segments, colors = character(0),',
    '                                    default_color = NULL, hidden = character(0), layout = "3d",',
    '                                    layers = "all", show_slices = FALSE) {',
    "  # A published scene pointed at `segments`, as Coda's Neuroglancer node does it. The segments",
    '  # go into the layer named after the dataset ("hemibrain" for "hemibrain:v1.2.1"), or the',
    '  # first segmentation layer if none is. Its published colours are replaced by `colors`.',
    '  # `hidden` segments are listed but not drawn. layers = "segmentation" drops every other layer.',
    '  types <- vapply(scene$layers, function(l) if (is.character(l$type)) l$type else "", "")',
    '  names <- nglscenes::ngs_layer_names(scene)',
    '  segmentation <- which(types %in% c("segmentation", "segmentation_with_graph"))',
    '  family <- sub(":.*$", "", dataset)',
    '  named <- segmentation[startsWith(names[segmentation], family) %in% TRUE]',
    '  target <- c(named, segmentation)[1]',
    '  if (!is.na(target)) {',
    '    layer <- scene$layers[[target]]',
    '    # Built on the character vector itself: `ifelse` over no segments answers a logical(0).',
    '    listed <- segments',
    '    hide <- segments %in% hidden',
    '    listed[hide] <- paste0("!", segments[hide])',
    '    layer$segments <- listed',
    '    layer$segmentColors <- colors[segments[segments %in% names(colors)]]',
    '    if (!is.null(default_color)) layer$segmentDefaultColor <- default_color',
    '    scene$layers[[target]] <- layer',
    '    if (identical(layers, "segmentation")) {',
    '      scene <- nglscenes::ngs_drop_layer(scene, setdiff(seq_along(scene$layers), target))',
    '    }',
    '  }',
    "  # neuPrint Explorer's own bookkeeping, not viewer state.",
    '  scene$badlayers <- NULL',
    '  scene$layout <- layout',
    '  scene$showSlices <- show_slices',
    '  # The axis lines read as anatomy, and the layer panel covers a third of the view.',
    '  scene$showAxisLines <- FALSE',
    '  if (is.list(scene$selectedLayer)) scene$selectedLayer$visible <- FALSE',
    '  scene',
    '}',
  ],
})
/** `sceneUrl`: the host table, nglscenes-r's flavour conversion, Coda's bounding boxes, then its URL. */
registerHelper({
  name: 'coda_neuroglancer_url',
  requires: ['nglscenes'],
  source: [
    'coda_bounds_off <- function(source) {',
    '  if (is.character(source)) return(list(url = source, subsources = list(bounds = FALSE)))',
    '  if (is.list(source) && is.null(names(source))) return(lapply(source, coda_bounds_off))',
    '  if (is.list(source)) {',
    '    subsources <- if (is.list(source$subsources)) source$subsources else list()',
    '    subsources$bounds <- FALSE',
    '    source$subsources <- subsources',
    '  }',
    '  source',
    '}',
    '',
    'coda_neuroglancer_url <- function(scene, viewer) {',
    '  # A link to the scene in `viewer`, written the way that viewer reads it. The Seung-lab fork of',
    '  # neuroglancer (ngl.flywire.ai among others) wants a CAVE segmentation as',
    '  # "segmentation_with_graph" with a bare graphene:// source and refuses middleauth+; every',
    "  # other deployment wants the opposite. The volumes' bounding boxes are switched off, as in",
    '  # Coda, except on the Seung-lab fork, whose format is older.',
    '  host <- sub("[:/].*$", "", sub("^[A-Za-z][A-Za-z0-9+.-]*://", "", viewer))',
    `  seunglab <- host %in% ${rHostVector}`,
    '  scene <- nglscenes::ngs_for_viewer(scene, if (seunglab) "seunglab" else "spelunker")',
    '  if (!seunglab) {',
    '    volumes <- c("image", "segmentation", "segmentation_with_graph")',
    '    for (i in seq_along(scene$layers)) {',
    '      layer <- scene$layers[[i]]',
    '      if (isTRUE(layer$type %in% volumes) && !is.null(layer$source)) {',
    '        layer$source <- coda_bounds_off(layer$source)',
    '        scene$layers[[i]] <- layer',
    '      }',
    '    }',
    '  }',
    '  nglscenes::ngs_base_url(scene) <- viewer',
    '  nglscenes::ngs_url(scene)',
    '}',
  ],
})
