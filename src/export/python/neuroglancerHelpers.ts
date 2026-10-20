/**
 * The Neuroglancer node's helpers, Python half: the scene a dataset publishes, pointed at a set of
 * neurons the way `buildScene` does it, and written out for whichever neuroglancer the link opens.
 *
 * nglscenes does the scene work — parsing, finding a layer, writing segments and colours, the
 * two viewer flavours, the URL — and these carry only Coda's own rules: which layer the neurons go
 * in, the edits made in the card's viewer, how a colour is chosen, the keys an embedded scene
 * overrides. Each mirrors one function, named in its comment, so a change there has one place to
 * go here.
 *
 * Checked by running them: the decoded state of every link they build was compared with
 * `buildScene` and `sceneUrl` over the four published neuPrint scenes, with edits, hidden
 * neurons, both layer sets and both colour modes, and came out identical.
 */

import { SEUNGLAB_HOSTS } from '../../data/neuroglancer/scene'
import { registerHelper } from './registry'

/** A Python set literal of strings, sorted so the golden does not depend on insertion order. */
function pySet(values: ReadonlySet<string>): string {
  return `{${[...values]
    .sort()
    .map((v) => `'${v}'`)
    .join(', ')}}`
}

/** A blank cell: `None`, pandas' `NA` or a float NaN. Shared by the readers below. */
registerHelper({
  name: '_coda_blank',
  requires: [['pandas']],
  source: [
    'def _coda_blank(value):',
    '    return value is None or value is pd.NA or (isinstance(value, float) and value != value)',
  ],
})
/**
 * `segmentColors` in `out.neuroglancer`, the id half: `idText` then `isSegmentId`, first
 * appearance kept, the unreadable rows counted in the node's own sentence.
 */
registerHelper({
  name: 'coda_segment_ids',
  needs: ['_coda_blank'],
  requires: [['re']],
  source: [
    'def coda_segment_ids(ids):',
    '    """The ids neuroglancer can read, as text, each once and in order.',
    '',
    '    Neuroglancer takes a segment id only as a plain whole number, and one it cannot read breaks',
    '    the whole layer, so anything else is left out and counted, as on the canvas. A blank row is',
    '    dropped without a word.',
    '    """',
    '    kept, unreadable, total = {}, 0, 0',
    '    for value in ids:',
    '        total += 1',
    '        if _coda_blank(value):',
    '            continue',
    '        text = str(value).strip()',
    "        if re.fullmatch(r'0|[1-9][0-9]*', text):",
    '            kept.setdefault(text, None)',
    '        else:',
    '            unreadable += 1',
    '    if unreadable:',
    "        print(f'{unreadable} of {total} rows have an id neuroglancer cannot use and were left out.')",
    '    return list(kept)',
  ],
})
/** `applySelectionEdits`, over the readable ids: removals out, additions after, in id order. */
registerHelper({
  name: 'coda_shown_segments',
  needs: ['coda_segment_ids'],
  source: [
    'def coda_shown_segments(ids, added=(), removed=()):',
    '    """The segments Coda\'s Neuroglancer node shows.',
    '',
    "    The input's ids less the ones removed in the viewer, then the ones added there that the",
    '    input does not have, in id order.',
    '    """',
    '    shown = coda_segment_ids(ids)',
    '    held = set(shown)',
    '    removed = {str(i) for i in removed}',
    '    extra = sorted({str(i) for i in added} - held, key=int)',
    '    return [i for i in shown if i not in removed] + extra',
  ],
})
/** A colour per segment, the first row's — what `segmentColors` keeps for a repeated id. */
registerHelper({
  name: 'coda_segment_colors',
  needs: ['_coda_blank'],
  source: [
    'def coda_segment_colors(ids, colors):',
    '    """`{segment: colour}` from a column of ids and a colour per row. The first row wins."""',
    '    out = {}',
    '    for value, color in zip(ids, colors):',
    '        if not _coda_blank(value):',
    '            out.setdefault(str(value).strip(), color)',
    '    return out',
  ],
})
/**
 * `resolveColor`'s categorical branch: rank by frequency, ties alphabetically, cycle the palette,
 * an override wins.
 *
 * The tie-break is the part that needed care. The canvas sorts tied labels with `localeCompare`,
 * which ignores case and accents and puts punctuation first, so Python's code-point order
 * coloured differently on every selection where each type appears once — the commonest case. The
 * key below reproduces the browser's order for ASCII punctuation, digits, letters and accents,
 * checked against Node's `localeCompare` on forty labels built to disagree.
 */
registerHelper({
  name: 'coda_category_colors',
  needs: ['_coda_blank'],
  requires: [['unicodedata']],
  source: [
    '_CODA_PUNCTUATION = " _-–—,;:!?.\'\\"()[]{}@*/\\\\&#%`^+<=>|~$"',
    '',
    '',
    'def _coda_label(value):',
    '    # A cell as the canvas spells it: an em dash for a blank, and numbers and flags the way',
    "    # JavaScript writes them, so `overrides` keyed on the canvas' labels still match.",
    '    if _coda_blank(value):',
    "        return '—'",
    "    if isinstance(value, bool) or type(value).__name__ == 'bool_':",
    "        return 'true' if value else 'false'",
    '    if isinstance(value, float) and value.is_integer():',
    '        return str(int(value))',
    '    return str(value)',
    '',
    '',
    'def _coda_collate(label):',
    "    # The order the canvas breaks ties in, which is the browser's alphabetical order: case and",
    '    # accents count only when nothing else differs, and punctuation sorts before digits before',
    "    # letters. Checked against Chrome's for ASCII punctuation, digits, letters and accents.",
    '    primary, accents = [], []',
    '    for ch in label:',
    "        base = unicodedata.normalize('NFD', ch)[0]",
    '        if base in _CODA_PUNCTUATION:',
    "            primary.append((0, _CODA_PUNCTUATION.index(base), ''))",
    '        elif base.isalnum():',
    '            primary.append((2 if base.isalpha() else 1, 0, base.casefold()))',
    '        else:',
    "            primary.append((0, len(_CODA_PUNCTUATION) + ord(base), ''))",
    '        accents.append(base != ch)',
    '    return primary, accents, label.swapcase()',
    '',
    '',
    'def coda_category_colors(values, palette, overrides=None):',
    '    """A colour per row, the way Coda colours a column "by category".',
    '',
    "    The commonest value gets the palette's first colour, the next one the second, and the",
    '    palette starts over when it runs out. Ties go alphabetically. A colour picked for a value on',
    '    the canvas (`overrides`) wins.',
    '    """',
    '    labels = [_coda_label(v) for v in values]',
    '    counts = {}',
    '    for label in labels:',
    '        counts[label] = counts.get(label, 0) + 1',
    '    ranked = sorted(counts, key=lambda label: (-counts[label], _coda_collate(label)))',
    '    overrides = overrides or {}',
    '    color_of = {',
    '        label: overrides.get(label, palette[i % len(palette)]) for i, label in enumerate(ranked)',
    '    }',
    '    return [color_of[label] for label in labels]',
  ],
})
/** `literalColor`: a cell that is a hex colour is itself, anything else the fallback. */
registerHelper({
  name: 'coda_literal_colors',
  requires: [['re']],
  source: [
    'def coda_literal_colors(values, fallback):',
    '    """A colour per row from a column of colours. A cell that is not one gets `fallback`."""',
    '    out = []',
    '    for value in values:',
    "        text = value.strip() if isinstance(value, str) else ''",
    "        hex_color = re.fullmatch(r'#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})', text)",
    '        out.append(text if hex_color else fallback)',
    '    return out',
  ],
})
/**
 * `buildScene`, for one dataset's neurons. Not the parts that need a source the notebook has no
 * equivalent of: `placements` (a scene of several volumes) and extra layers, which the emitter
 * notes instead.
 */
registerHelper({
  name: 'coda_neuroglancer_scene',
  source: [
    'def coda_neuroglancer_scene(',
    '    scene,',
    '    dataset,',
    '    segments,',
    '    colors=None,',
    '    default_color=None,',
    '    hidden=(),',
    "    layout='3d',",
    "    layers='all',",
    '    show_slices=False,',
    '):',
    '    """A copy of a published scene pointed at `segments`, as Coda\'s Neuroglancer node does it.',
    '',
    '    The segments go into the layer named after the dataset (`hemibrain` for `hemibrain:v1.2.1`),',
    '    or the first segmentation layer if none is. Its published colours are replaced by `colors`.',
    "    `hidden` segments are listed but not drawn. `layers='segmentation'` drops every other layer.",
    '    """',
    '    scene = scene.copy()',
    "    family = dataset.split(':')[0]",
    '    segmentation = [',
    '        layer for layer in scene.layers',
    "        if layer['type'] in ('segmentation', 'segmentation_with_graph')",
    '    ]',
    '    target = next(',
    '        (layer for layer in segmentation if str(layer.name).startswith(family)),',
    '        segmentation[0] if segmentation else None,',
    '    )',
    '    if target is not None:',
    '        hidden = {str(i) for i in hidden}',
    '        colors = colors or {}',
    "        target['segments'] = [f'!{i}' if i in hidden else i for i in segments]",
    "        target['segmentColors'] = {i: colors[i] for i in segments if i in colors}",
    '        if default_color:',
    "            target['segmentDefaultColor'] = default_color",
    "        if layers == 'segmentation':",
    '            for at in reversed(range(len(scene.layers))):',
    '                if scene.layers[at] is not target:',
    '                    scene.drop_layer(at)',
    "    # neuPrint Explorer's own bookkeeping, not viewer state.",
    "    scene.state.pop('badlayers', None)",
    "    scene['layout'] = layout",
    "    scene['showSlices'] = show_slices",
    '    # The axis lines read as anatomy, and the layer panel covers a third of the view.',
    "    scene['showAxisLines'] = False",
    "    if isinstance(scene.state.get('selectedLayer'), dict):",
    "        scene['selectedLayer'] = {**scene.state['selectedLayer'], 'visible': False}",
    '    return scene',
  ],
})
/**
 * `sceneUrl`: `viewerKind` by the same host table, then `layerForViewer`'s two halves. nglscenes
 * converts the graphene layers (`for_viewer`); the bounding boxes are Coda's own rule.
 */
registerHelper({
  name: 'coda_neuroglancer_url',
  source: [
    `_CODA_SEUNGLAB_HOSTS = ${pySet(SEUNGLAB_HOSTS)}`,
    '',
    '',
    'def _coda_bounds_off(source):',
    '    if isinstance(source, list):',
    '        return [_coda_bounds_off(s) for s in source]',
    '    if isinstance(source, str):',
    "        return {'url': source, 'subsources': {'bounds': False}}",
    '    if isinstance(source, dict):',
    "        return {**source, 'subsources': {**source.get('subsources', {}), 'bounds': False}}",
    '    return source',
    '',
    '',
    'def coda_neuroglancer_url(scene, viewer):',
    '    """A link to the scene in `viewer`, written the way that viewer reads it.',
    '',
    '    The Seung-lab fork of neuroglancer (ngl.flywire.ai among others) wants a CAVE segmentation',
    '    as `segmentation_with_graph` with a bare `graphene://` source and refuses `middleauth+`.',
    "    Every other deployment wants the opposite. The volumes' bounding boxes are switched off, as",
    '    in Coda, except on the Seung-lab fork, whose format is older.',
    '    """',
    "    host = viewer.split('://', 1)[-1].split('/', 1)[0].split(':', 1)[0]",
    "    flavour = 'seunglab' if host in _CODA_SEUNGLAB_HOSTS else 'spelunker'",
    '    view = scene.for_viewer(flavour)',
    '    view.base_url = viewer',
    "    if flavour != 'seunglab':",
    '        for layer in view.layers:',
    "            volume = layer['type'] in ('image', 'segmentation', 'segmentation_with_graph')",
    "            if volume and 'source' in layer.state:",
    "                layer['source'] = _coda_bounds_off(layer['source'])",
    '    return view.url',
  ],
})
/** `caveScene`: the EM and the segmentation a datastack's info record names. */
registerHelper({
  name: 'coda_cave_scene',
  requires: [['nglscenes', 'Scene']],
  source: [
    'def coda_cave_scene(client):',
    '    """A neuroglancer scene for the client\'s datastack, built from its info record as Coda does.',
    '',
    '    CAVE publishes no curated scene, so this is the EM and the segmentation the datastack names,',
    '    and nothing it does not: no region meshes, no camera.',
    '    """',
    '    info = client.info.get_datastack_info()',
    "    segmentation = info.get('segmentation_source')",
    '    if not segmentation:',
    "        raise ValueError(f'{client.datastack_name} names no segmentation to show neurons in.')",
    '    state = {}',
    "    resolution = [info.get(f'viewer_resolution_{axis}') for axis in 'xyz']",
    '    if all(isinstance(v, (int, float)) and v > 0 for v in resolution):',
    '        # Nanometres per voxel, as metres. Left out if unknown: a wrong scale misplaces everything.',
    "        state['dimensions'] = {axis: [v / 1e9, 'm'] for axis, v in zip('xyz', resolution)}",
    '    layers = []',
    "    image = (info.get('aligned_volume') or {}).get('image_source')",
    '    if image:',
    "        if '://' not in image or image.startswith('gs://'):",
    "            image = f'precomputed://{image}'",
    "        layers.append({'type': 'image', 'name': 'EM', 'source': image})",
    '    layers.append(',
    "        {'type': 'segmentation', 'name': client.datastack_name, 'source': segmentation, 'segments': []}",
    '    )',
    "    state['layers'] = layers",
    '    return Scene.from_dict(state)',
  ],
})
