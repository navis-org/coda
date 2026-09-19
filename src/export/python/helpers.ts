/**
 * Generated Python helpers.
 *
 * The parts of a workflow with no equivalent in pandas, neuprint-python or navis, written
 * into the notebook so it stands on those three and nothing else. Each one mirrors a
 * specific piece of `src/nodes/lib`, and the pairing is the thing to keep true — a helper
 * that has quietly stopped agreeing with the TypeScript it was ported from is worse than no
 * helper at all, because the notebook still runs and still answers.
 *
 * `caveHelpers.ts` is the same thing for the other backend, kept apart because it mirrors
 * `src/data/cave` and `src/data/annotations` rather than `src/nodes/lib` — and because a
 * neuPrint notebook should carry none of it.
 */

import { QUALIFIED_SEPARATOR } from '../../core/ids'
import { MIN_EMBED_OBSERVATIONS } from '../../nodes/lib/embedOps'
import { JOIN_SEPARATOR } from '../../core/values'
import { registerHelper } from './registry'

/**
 * Coda's own PRNG, and it has to be Coda's own.
 *
 * `df.sample(random_state=n)` is a Mersenne Twister; this is mulberry32. Same seed, entirely
 * different rows — so a notebook using pandas' sampler would disagree with the canvas it was
 * exported from while looking perfectly reasonable, which is the failure mode the seed param
 * exists to prevent. The arithmetic is JavaScript's `Math.imul` and `>>>` written out in
 * 32-bit masks; `sample_rows.test.ts` checks the two streams agree rather than trusting that
 * the transcription is right.
 */
registerHelper({
  name: 'coda_sample_rows',
  source: [
    'def _coda_rng(seed):',
    '    """mulberry32, the generator behind Coda\'s Sample node."""',
    '    a = int(seed) & 0xFFFFFFFF',
    '',
    '    def rand():',
    '        nonlocal a',
    '        a = (a + 0x6D2B79F5) & 0xFFFFFFFF',
    '        t = a',
    '        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF',
    '        t = (t ^ (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF))) & 0xFFFFFFFF',
    '        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296',
    '',
    '    return rand',
    '',
    '',
    'def coda_sample_rows(length, count, seed):',
    '    """Row positions for a seeded draw, ascending.',
    '',
    '    Partial Fisher-Yates over `count` draws, then sorted: this samples rather than',
    '    shuffles, so a random subset of a sorted table stays sorted.',
    '    """',
    '    length = max(0, int(length))',
    '    count = max(0, min(length, int(count)))',
    '    idx = list(range(length))',
    '    rand = _coda_rng(seed)',
    '    for i in range(count):',
    '        j = i + int(rand() * (length - i))',
    '        idx[i], idx[j] = idx[j], idx[i]',
    '    return sorted(idx[:count])',
  ],
})

/**
 * neuprint-python's `bodyId` → Coda's `neuronId`.
 *
 * The counterpart of R's `coda_neurons`, and it exists for the same reason one seam over:
 * **Coda calls the id column `neuronId` on every source**, because it is the one column every
 * node addresses by name and so the one that has to be Coda's vocabulary rather than a
 * backend's. neuprint-python publishes `bodyId`, which is neuPrint's property name.
 *
 * Every frame that comes back from `fetch_neurons` goes through this, or the next cell — a
 * Filter, a Group By, anything carrying a column param — addresses `neuronId` on a frame that
 * has no such column and raises a `KeyError` a long way from the cause.
 *
 * Note the asymmetry that makes this readable rather than confusing: the *argument* stays
 * neuPrint's, so a call reads `NeuronCriteria(bodyId=df['neuronId'].tolist())`. Coda's column
 * goes in, neuPrint's parameter takes it.
 *
 * Left alone when the frame already carries `neuronId`, so a table from an upload or an
 * aliased Cypher query passes through untouched.
 */
registerHelper({
  name: 'coda_neurons',
  requires: [['pandas']],
  // It *calls* `coda_ids`, so it has to declare it: `resolveHelpers` writes out only what was
  // asked for, and a notebook whose sole helper is this one otherwise emits a call to a function
  // nothing defines. Invisible to the golden file, which looks right only because some other
  // emitter in that fixture happens to request `coda_ids` — the same way `neuron.roiCounts` once
  // lost the `codaNeurons` pairing.
  needs: ['coda_ids'],
  source: [
    'def coda_neurons(df):',
    '    """Rename neuprint-python\'s `bodyId` to the `neuronId` every Coda table uses."""',
    '    if df is None:',
    '        return df',
    "    if 'bodyId' in df.columns and 'neuronId' not in df.columns:",
    "        df = df.rename(columns={'bodyId': 'neuronId'})",
    "    return coda_ids(df, 'neuronId')",
  ],
})

/**
 * A backend's integer ids, as the exact text every Coda column holds.
 *
 * The document's half of invariant 8. Coda carries a neuron id as a decimal *string* on every
 * source, because a CAVE root id is eighteen digits and a float64 — which is what a JSON number
 * and an R `numeric` both are — rounds it into a different neuron. The notebook has to agree,
 * or the two disagree about the one column everything joins on.
 *
 * It matters even where every id is narrow enough to be exact, and that is the half worth
 * saying: `pd.concat` of an `int64` id column and a `string` one gives an object column holding
 * both `10001` and `'10001'`, and `drop_duplicates`, `groupby` and `merge` all read those as two
 * different neurons. So the cast goes at the seam rather than at each comparison — one place,
 * and the same place the app does it.
 *
 * `Int64` then `string`, never `astype(str)`: the nullable-integer step is what keeps a missing
 * id as `<NA>` rather than the four-letter string `'nan'`, and what stops a column pandas widened
 * to `float64` for one null printing as `'10001.0'`. A column that is already text is cast
 * straight through, so applying this twice is safe — which `coda_neurons` relies on.
 *
 * Measured against pandas 2.3 rather than reasoned about, including the eighteen-digit case:
 * `int64` holds `720575940632499757` exactly, which is the whole reason the intermediate step
 * is an integer type rather than a float one.
 */
registerHelper({
  name: 'coda_ids',
  requires: [['pandas']],
  source: [
    'def coda_ids(df, *columns):',
    '    """Cast id columns to exact text — Coda holds every neuron id as a string."""',
    '    if df is None:',
    '        return df',
    '    for name in columns:',
    '        if name not in df.columns:',
    '            continue',
    '        col = df[name]',
    '        df[name] = (',
    "            col.astype('Int64').astype('string')",
    '            if pd.api.types.is_numeric_dtype(col)',
    "            else col.astype('string')",
    '        )',
    '    return df',
  ],
})

/**
 * `coda_neurons` one column further on, for a synapse frame.
 *
 * The same job — neuprint-python's vocabulary into Coda's — and it sits beside it rather than
 * inline at the call site because of the collision. neuprint-python calls the pre/post column
 * **`type`**; Coda calls it `polarity` and keeps `type` for the neuron's **cell type**, which
 * `NeuPrintSource` fetches alongside in the same Cypher. So a bare
 * `rename(columns={'type': 'polarity'})` on a frame that somehow carries both would produce
 * two columns named `polarity`, and every column param downstream would address whichever
 * pandas handed back. Guarded and idempotent, exactly as `coda_neurons` is, for exactly that
 * reason.
 *
 * Coda's `type` is genuinely **absent** from this frame rather than misnamed — the library
 * never fetches it — and no rename can conjure it. That is a gap the emitters state in a note
 * rather than something a helper can close.
 */
registerHelper({
  name: 'coda_synapses',
  source: [
    'def coda_synapses(df):',
    '    """neuprint-python synapse columns as Coda names them: `type` is the polarity."""',
    "    if df is None or 'type' not in df.columns or 'polarity' in df.columns:",
    '        return df',
    "    return df.rename(columns={'type': 'polarity'})",
  ],
})

/**
 * A synapse-connection frame — neuprint-python's `fetch_synapse_connections` or a CAVE synapse
 * table read with `split_positions=True` — as the canvas's Synapses Between cloud.
 *
 * One helper for both backends because the rule is the node's and not either library's: the
 * presynaptic body is `neuronId` and the postsynaptic one `partnerId` **whichever end is drawn**,
 * `polarity` names that end, and `x`/`y`/`z` are its coordinate. Each backend hands in its own
 * column names; `position` is a template with `{axis}` in it, since the two libraries put the axis
 * at opposite ends of the name (`x_pre` against `pre_pt_position_x`).
 *
 * The confidence column may be absent — a CAVE table with no score — and then the column is
 * empty rather than missing, as it is on the canvas.
 */
registerHelper({
  name: 'coda_synapses_between',
  needs: ['coda_ids'],
  requires: [['pandas']],
  source: [
    'def coda_synapses_between(df, pre, post, position, confidence, location):',
    '    """A synapse-connection frame as Coda\'s Synapses Between cloud: source, target, one end."""',
    '    out = pd.DataFrame(index=df.index)',
    "    out['neuronId'] = df[pre]",
    "    out['partnerId'] = df[post]",
    "    out['polarity'] = location",
    "    out['confidence'] = (",
    "        df[confidence].astype('float64') if confidence in df.columns else float('nan')",
    '    )',
    "    for axis in 'xyz':",
    '        out[axis] = df[position.format(axis=axis)].to_numpy()',
    "    return coda_ids(out.reset_index(drop=True), 'neuronId', 'partnerId')",
  ],
})

/**
 * Coda's Combine Columns node, both halves.
 *
 * `df[columns].bfill(axis=1).iloc[:, 0]` is the obvious pandas spelling and is a *different
 * rule*: it reads an empty string as a value, so a blank cell stops the search where Coda reads
 * null and blank as one absence. On a real annotation dump that is most of the difference —
 * FlyWire's published TSV writes an unset `cell_type` as a blank field rather than as nothing.
 *
 * `source=True` answers which column each value came from. One function rather than two,
 * because the loop and — the part that matters — the *absence rule* are identical; two copies is
 * two places for "what counts as a value" to drift, and a drifted pair puts a source name beside
 * a blank or a value beside no source.
 */
registerHelper({
  name: 'coda_combine',
  requires: [['pandas']],
  source: [
    'def coda_combine(df, columns, source=False):',
    '    """The first of `columns` holding a value per row, or which column that was."""',
    '    out = pd.Series([None] * len(df), index=df.index, dtype=object)',
    '    for name in columns:',
    '        if name not in df.columns:',
    '            continue',
    '        col = df[name]',
    '        # Null and the empty string are one absence: a blank must not stop the search.',
    "        have = col.notna() & (col.astype(str) != '')",
    '        out = out.mask(out.isna() & have, name if source else col)',
    '    return out',
  ],
})

/**
 * Coda's Relabel node, and the match rule under it.
 *
 * `df[column].map(dict(zip(mapping[key], mapping[value])))` is the obvious spelling and is a
 * different operation four ways, each of which produces a plausible wrong column rather than an
 * error. `zip` into a dict keeps the **last** value for a repeated key where Coda keeps the
 * first. `.map` cannot tell "mapped to nothing" from "not in the mapping", which is exactly the
 * distinction `unmatched` is about. It matches on the values as pandas typed them, where Coda
 * matches on their text — so an `int64` key column and an `object` one silently agree on nothing.
 * And a null in the relabelled column would match no key at all, where Coda pairs it with a null
 * key.
 *
 * The last two are `coda_match_keys`, which is a helper of its own rather than two functions in
 * one `source`: it is `rowKey`'s rule one language over — the rule Dedupe, Group By and Join all
 * share in TypeScript — so the next helper that needs it should `needs` it rather than copy it.
 * `registerHelper` de-duplicates on the *helper* name and not on the function names inside a
 * `source`, so a second registration carrying its own copy would emit both definitions into one
 * cell and let the later one win, silently.
 */
registerHelper({
  name: 'coda_match_keys',
  requires: [['pandas'], ['numpy']],
  source: [
    'def coda_match_keys(s):',
    '    """A column as Coda\'s match keys — `rowKey`\'s rule, one language over."""',
    '    def key(v):',
    '        if pd.isna(v):',
    "            return '\\x00'  # a null is its own key, never a value that matches nothing",
    '        if isinstance(v, (bool, np.bool_)):',
    "            return 'true' if v else 'false'",
    '        if isinstance(v, float) and float(v).is_integer():',
    '            return str(int(v))  # a JS number has no float/int distinction to print',
    '        return str(v)',
    '    return s.map(key)',
  ],
})

/**
 * Coda's Relabel node. `coda_match_keys` above carries the match rule.
 *
 * Two of that function's lines exist because a JS number is not a Python one: `String(3)` is
 * `'3'` where a column pandas typed `float64` — which is what an `i64` column with one null
 * becomes — prints `'3.0'`, and a JS boolean prints lower case. Its null sentinel is `rowKey`'s
 * own `\x00`, written as an escape for that function's stated reason: a literal control
 * character is invisible to every reader.
 */
registerHelper({
  name: 'coda_relabel',
  requires: [['pandas']],
  needs: ['coda_match_keys'],
  source: [
    "def coda_relabel(df, column, mapping, key, value, into=None, unmatched='null'):",
    '    """Rewrite `column` by looking each value up in `mapping`. Coda\'s Relabel node."""',
    '    keys = coda_match_keys(mapping[key])',
    "    # First occurrence wins, and rows are never multiplied — Coda's rule, and `Join`'s.",
    '    first = ~keys.duplicated()',
    '    lookup = dict(zip(keys[first], mapping[value][first]))',
    '    probe = coda_match_keys(df[column])',
    '    hit = probe.isin(lookup.keys())',
    '    values = probe.map(lookup)',
    "    if unmatched == 'keep':",
    '        values = values.where(hit, df[column])',
    "    elif unmatched == 'drop':",
    '        # Narrowed before the copy, not after: the mode meant to shrink the frame has no',
    '        # business materialising the whole of it first.',
    '        df, values = df[hit.values], values[hit.values]',
    '    out = df.copy()',
    '    out[into or column] = values',
    '    return out',
  ],
})

/**
 * Coda's Compare Connectivity, and the per-label totals under it.
 *
 * The longest helper in this file, and it earns the length: every rule it carries is one that
 * pandas would otherwise get *plausibly* wrong. Four of them.
 *
 * **A repeated key resolves to the first row**, `coda_relabel`'s rule and `Join`'s — where
 * `dict(zip(...))` keeps the last.
 *
 * **The label pool is the mapping's, not the edges'.** `set(lookup.values())` rather than the
 * labels that appear in the summed frame, and the whole absent-versus-unsampled distinction
 * rests on it: a pool derived from the edges makes every absence unsampled by construction, and
 * the `present_` columns would then all be true.
 *
 * **`0` and `None` are different answers.** `merge(how='outer')` fills a missing pair with NaN
 * whatever the reason, so the obvious translation collapses "this brain has both types and no
 * such connection" into "this brain was never asked" — which is the finding this node exists to
 * surface, deleted. Written out per key instead.
 *
 * **`min_weight` drops a whole row, never a value.** Thresholding per dataset would suppress a
 * number into a `0` that then means "below the threshold" as well as "really absent".
 *
 * `nNeurons` is a union over both ends rather than two `nunique` calls added together, which
 * would count a neuron twice where it is both pre and post of something.
 *
 * Returns the two frames as a tuple, in the node's port order. `_coda_label_totals` is
 * underscore-prefixed for `_coda_rng`'s reason: it is spec-private, and `registerHelper`
 * de-duplicates on the *helper* name rather than on the function names inside a `source`, so an
 * unprefixed one invites a later helper to land a second definition in the same cell.
 */
registerHelper({
  name: 'coda_compare_connectivity',
  requires: [['pandas']],
  needs: ['coda_match_keys'],
  source: [
    'def _coda_label_totals(frame, name):',
    '    """Per label: the neurons this edge list covered, and the weight out of and into it."""',
    '    ends = pd.concat([',
    "        frame[['preLabel', 'idPre']].rename(columns={'preLabel': 'label', 'idPre': 'id'}),",
    "        frame[['postLabel', 'idPost']].rename(columns={'postLabel': 'label', 'idPost': 'id'}),",
    '    ])',
    '    per = pd.DataFrame({',
    '        # A union over both ends: two nunique calls added together count a neuron twice.',
    "        'nNeurons': ends.groupby('label', sort=False)['id'].nunique(),",
    "        'outWeight': frame.groupby('preLabel', sort=False)['w'].sum(),",
    "        'inWeight': frame.groupby('postLabel', sort=False)['w'].sum(),",
    '    }).fillna(0)',
    "    per.index.name = 'label'",
    '    per = per.reset_index()',
    "    per.insert(1, 'dataset', name)",
    '    return per',
    '',
    '',
    'def coda_compare_connectivity(datasets, min_weight=0):',
    '    """Coda\'s Compare Connectivity: one type-to-type edge, counted in each dataset."""',
    '    summed, pools, counts = {}, {}, []',
    '    for d in datasets:',
    "        name, labels, edges = d['name'], d['labels'], d['edges']",
    "        keys = coda_match_keys(labels[d.get('id_column', 'neuronId')])",
    "        # First occurrence wins — `coda_relabel`'s rule, where zip into a dict keeps the last.",
    '        first = ~keys.duplicated()',
    "        lookup = dict(zip(keys[first], labels[d.get('label_column', 'label')][first]))",
    "        lookup = {k: v for k, v in lookup.items() if pd.notna(v) and v != ''}",
    '        frame = pd.DataFrame({',
    "            'idPre': coda_match_keys(edges[d['pre']]),",
    "            'idPost': coda_match_keys(edges[d['post']]),",
    "            'w': edges[d['weight']] if d.get('weight') else 1.0,",
    '        })',
    "        frame['preLabel'] = frame['idPre'].map(lookup)",
    "        frame['postLabel'] = frame['idPost'].map(lookup)",
    '        # An edge with an unlabelled end has no place in a label-level comparison.',
    "        frame = frame.dropna(subset=['preLabel', 'postLabel'])",
    "        summed[name] = frame.groupby(['preLabel', 'postLabel'], sort=False)['w'].sum().to_dict()",
    "        # The mapping's labels, not the edges' — a pool taken from the edges would make every",
    '        # absence unsampled and every `present_` column true.',
    '        pools[name] = set(lookup.values())',
    '        counts.append(_coda_label_totals(frame, name))',
    '',
    "    # First-appearance order, `coda_join`'s idiom: a set would not promise one.",
    '    seen_keys = dict.fromkeys(k for group in summed.values() for k in group)',
    '    # A row survives where *any* dataset reaches the threshold, so an asymmetry outlives it.',
    '    keys = [k for k in seen_keys',
    '            if any(k in g and g[k] >= min_weight for g in summed.values())]',
    '',
    "    out = pd.DataFrame(keys, columns=['preLabel', 'postLabel'])",
    '    present = {name: [p in pools[name] and q in pools[name] for p, q in keys]',
    '               for name in summed}',
    '    for name, group in summed.items():',
    '        # 0 where the dataset holds both labels and has no such edge — a real absence — and',
    '        # None where it holds neither, because then nothing was asked.',
    "        out['weight_' + name] = [group[k] if k in group else (0.0 if seen else None)",
    '                                 for k, seen in zip(keys, present[name])]',
    '    for name in summed:',
    "        out['present_' + name] = present[name]",
    '',
    "    empty = ['label', 'dataset', 'nNeurons', 'outWeight', 'inWeight']",
    '    return out, pd.concat(counts, ignore_index=True) if counts else pd.DataFrame(columns=empty)',
  ],
})

/**
 * Coda's Qualify Ids, both directions.
 *
 * `prefix + df[col].astype(str)` is the obvious spelling and gets all three of this node's rules
 * wrong, each silently. A null becomes the string `"flywire:nan"` — an id for a neuron that does
 * not exist, which then joins to nothing and looks like missing data. `str.split(':')` without
 * `n=1` splits on *every* separator, so an id that contains one loses its tail. And stripping a
 * prefix that was never there must leave the value alone rather than empty it, because a graph
 * where the strip is one node too early is a graph that should still work.
 *
 * The `dataset` column is `None` rather than the whole value where there was no prefix, which is
 * `qualifiedDataset` answering undefined — a column of ids masquerading as dataset names is the
 * one output nobody could spot.
 *
 * The separator is spliced from `QUALIFIED_SEPARATOR`, `coda_join`'s idiom with `JOIN_SEPARATOR`
 * and for its reason: `src/core/ids.ts` exists so the rule has one home, and a colon typed out
 * here is a third spelling that stays on `:` when that constant changes, with every golden still
 * green.
 */
registerHelper({
  name: 'coda_qualify_ids',
  requires: [['pandas']],
  source: [
    "def coda_qualify_ids(df, column, direction='add', prefix='', into=None):",
    '    """Tag an id column with its dataset, or take that tag off again."""',
    '    out = df.copy()',
    '    ids = df[column]',
    '    text = ids.astype(str)',
    "    if direction == 'add':",
    '        # A null stays null: tagging one invents a neuron that does not exist.',
    `        out[column] = ((prefix + ${JSON.stringify(QUALIFIED_SEPARATOR)} + text) if prefix else text).where(ids.notna())`,
    '        return out',
    '    # `n=1`, so a separator inside the id keeps its tail. Without it "flywire:a:b" loses ":b".',
    `    parts = text.str.split(${JSON.stringify(QUALIFIED_SEPARATOR)}, n=1)`,
    '    out[column] = parts.str[-1].where(ids.notna())',
    '    if into:',
    '        # Only where there actually was a prefix — otherwise this column would be full of ids',
    '        # wearing the name "dataset", which is the one wrong answer nobody would notice.',
    `        had = text.str.contains(${JSON.stringify(QUALIFIED_SEPARATOR)}, regex=False)`,
    '        out[into] = parts.str[0].where(ids.notna() & had)',
    '    return out',
  ],
})

/**
 * Coda's `join` aggregation.
 *
 * `', '.join(...)` is the obvious spelling and is a different rule four ways: it raises on a
 * NaN, it keeps empty strings — which Coda reads as absences, the same call `coda_combine`
 * makes — it keeps repeats, and it answers `''` for a group with nothing in it where Coda
 * answers null. The
 * separator is spliced from `JOIN_SEPARATOR`, so the notebook and the canvas cannot disagree
 * about where one value ends and the next begins.
 *
 * `dict.fromkeys` rather than a `set`: it deduplicates *and* keeps first-appearance order,
 * which a set does not promise in Python.
 */
registerHelper({
  name: 'coda_join',
  requires: [['pandas']],
  source: [
    'def coda_join(values):',
    '    """Coda\'s `join` aggregation: distinct, first-appearance order, absences skipped."""',
    "    kept = dict.fromkeys(str(v) for v in values.dropna() if str(v) != '')",
    `    return ${JSON.stringify(JOIN_SEPARATOR)}.join(kept) if kept else None`,
  ],
})

/**
 * A shared Google Sheet as a Coda neuron table.
 *
 * `data/annotations/googleSheet.ts` is what this mirrors, and the two rules worth transcribing
 * exactly are the ones that produce a plausible wrong table rather than an error.
 *
 * **The id column is read as text rather than guessed.** pandas types a column of
 * eighteen-digit root ids as `int64` — exact — and then as `float64` the moment one row is
 * blank, at which point `720575940628857210` comes back as `720575940628857216` — a *different*
 * neuron, with every later comparison wrong about a value nothing flagged. Measured rather than
 * reasoned: removing the `dtype=` below and re-running `pnpm probe:helpers` collapses two
 * adjacent ids in the probe's fixture onto one value. That is `coda_int64`'s finding at a
 * different seam, and `dtype=` is the cheap way to never form the float at all.
 * Coda's own reader arrives at the same column by a different route — `inferDType` refuses a
 * numeric reading of any value that would not survive a round trip through a double.
 *
 * **A column named but not present is dropped rather than filled with NaN**, which is what the
 * node does; the canvas says so in a warning on the card, and here the frame simply lacks it.
 *
 * `coda_annotation_columns` does the rest — see `caveHelpers.ts`, where it lives because
 * `coda_seatable` wanted it first. It is not a CAVE helper: it is `annotationColumn`, which
 * every annotation source in the tree renames through.
 */
registerHelper({
  name: 'coda_google_sheet',
  needs: ['coda_annotation_columns'],
  requires: [['pandas']],
  source: [
    "def coda_google_sheet(url, id_column='root_id', columns=None):",
    '    """A shared Google Sheet, read through its CSV export URL."""',
    '    # `dtype=` rather than a cast afterwards: a float64 id is already the wrong neuron by',
    '    # the time you could cast it back.',
    "    df = pd.read_csv(url, dtype={id_column: 'string'})",
    '    if id_column not in df.columns:',
    '        raise KeyError(',
    '            f"{id_column!r} is not a column of that tab. It has: {list(df.columns)}"',
    '        )',
    '    if columns:',
    '        keep = [c for c in columns if c in df.columns and c != id_column]',
    '    else:',
    '        # Empty means every column but the id, which is how a sheet says "all of it".',
    '        keep = [c for c in df.columns if c != id_column]',
    '    return coda_annotation_columns(df[[id_column] + keep], id_column)',
  ],
})

/**
 * A connectivity edge list as one long feature vector per query neuron.
 *
 * Mirrors `nodes/lib/partnerVectors.ts`. Three of its rules are the ones worth transcribing
 * exactly, because getting any of them wrong produces a plausible frame rather than an error:
 *
 * **The direction prefix is unconditional.** `out:DA1_lPN` and `in:DA1_lPN` are two features,
 * and dropping the prefix on a single-direction table would silently change what a stacked pair
 * of these means.
 *
 * **An untyped partner falls back to its own id**, never to a shared bucket — pandas would
 * happily group every `NaN` type together, which is the one grouping that makes strangers look
 * alike.
 *
 * **Ids are compared as text.** `astype(str)` on both sides of the membership test rather than
 * a numeric join: an eighteen-digit root id does not survive a float (invariant 8), and the
 * `neuronId` column is carried through untouched so the frame keeps whatever dtype it arrived
 * with.
 *
 * Row order is not the canvas's — Coda emits a query's features together, this emits the
 * groupby's first-appearance order — and nothing downstream of it reads row order.
 *
 * **`labels` replaces `partner_by` and `untyped` where it is given**, and `cnFrac` says what
 * that cost each neuron. Both mirror the TypeScript: a partner the mapping does not cover is
 * dropped rather than falling back to a type or an id, because a feature outside the shared
 * label space can only exist in one dataset — and a neuron left with a few percent of its
 * connectivity clusters as noise unless something says so. `cnFrac` is computed **before**
 * `weighting == 'fraction'` rescales the weights, or it would be a fraction of a fraction.
 */
registerHelper({
  name: 'coda_partner_vectors',
  requires: [['pandas']],
  needs: ['coda_match_keys'],
  source: [
    "def coda_partner_vectors(edges, neurons=None, partner_by='type', untyped='id',",
    "                         weight='weight', weighting='raw', labels=None,",
    "                         label_id='neuronId', label_name='label'):",
    '    """A pre/post edge list as one long feature vector per query neuron."""',
    '    # One copy, not two: the coerced weight rides alongside rather than being written into',
    "    # a duplicate of the caller's frame, which also leaves the input unmutated.",
    "    w = pd.to_numeric(edges[weight], errors='coerce')",
    '    keep = w.notna() & (w != 0)',
    '    df, w = edges[keep], w[keep]',
    '',
    '    lookup = None',
    '    if labels is not None:',
    "        # First occurrence wins, `coda_relabel`'s rule, where zip into a dict keeps the last.",
    '        keys = coda_match_keys(labels[label_id])',
    '        first = ~keys.duplicated()',
    '        lookup = dict(zip(keys[first], labels[label_name][first]))',
    "        lookup = {k: v for k, v in lookup.items() if pd.notna(v) and v != ''}",
    '',
    '    if neurons is not None:',
    "        queries = set(neurons['neuronId'].astype(str))",
    "        sides = [(df[df['preId'].astype(str).isin(queries)], 'out', 'preId', 'postId', 'postType'),",
    "                 (df[df['postId'].astype(str).isin(queries)], 'in', 'postId', 'preId', 'preType')]",
    '    else:',
    "        if 'direction' not in df.columns:",
    '            raise ValueError(',
    '                \'Pass the neurons you asked about, or an edge list carrying a "direction" \'',
    "                'column saying how each edge was found.')",
    '        # `direction` only names the neuron that was asked about while the frontier still',
    '        # is the seed set, which is the first hop.',
    "        if 'hop' in df.columns:",
    "            df = df[pd.to_numeric(df['hop'], errors='coerce') == 1]",
    "        sides = [(df[df['direction'].isin(['downstream', 'both'])], 'out', 'preId', 'postId', 'postType'),",
    "                 (df[df['direction'].isin(['upstream', 'both'])], 'in', 'postId', 'preId', 'preType')]",
    '',
    "    columns = ['neuronId', 'direction', 'partner', 'feature', 'weight', 'cnFrac']",
    '    parts = []',
    "    # Every gram attributable to a neuron, before anything is dropped. This is cnFrac's",
    '    # denominator and it can only be counted here: a dropped connection leaves nothing behind.',
    '    seen = []',
    '    for frame, direction, query_col, id_col, type_col in sides:',
    '        if frame.empty:',
    '            continue',
    "        seen.append(pd.DataFrame({'neuronId': frame[query_col].to_numpy(),",
    "                                  'w': w.loc[frame.index].to_numpy()}))",
    '        if lookup is not None:',
    '            # The mapping replaces partner_by and untyped: a partner outside the shared label',
    '            # space can only exist in one dataset, so it is dropped rather than falling back to',
    '            # a type or an id.',
    '            mapped = coda_match_keys(frame[id_col]).map(lookup)',
    '            frame, label = frame[mapped.notna()], mapped.dropna()',
    "        elif partner_by == 'type':",
    '            if type_col not in frame.columns:',
    '                raise ValueError(\'Grouping partners by cell type needs a "%s" column.\' % type_col)',
    "            typed = frame[type_col].astype('string').str.strip()",
    "            have = typed.notna() & (typed != '')",
    "            if untyped == 'drop':",
    '                frame, typed, have = frame[have], typed[have], have[have]',
    '            label = typed.where(have, frame[id_col].astype(str))',
    '        else:',
    '            label = frame[id_col].astype(str)',
    '        if frame.empty:',
    '            continue',
    '        parts.append(pd.DataFrame({',
    "            'neuronId': frame[query_col].to_numpy(),",
    "            'direction': direction,",
    "            'partner': label.astype(str).to_numpy(),",
    "            'weight': w.loc[frame.index].to_numpy(),",
    '        }))',
    '',
    '    if not parts:',
    '        return pd.DataFrame(columns=columns)',
    '    long = pd.concat(parts, ignore_index=True)',
    "    long['feature'] = long['direction'] + ':' + long['partner']",
    '    # Repeats of one neuron/partner pair are summed, exactly as a Pivot set to sum would.',
    "    long = (long.groupby(['neuronId', 'direction', 'partner', 'feature'],",
    "                         sort=False, dropna=False)['weight'].sum().reset_index())",
    '    # cnFrac against the pre-restriction totals, keyed as text so an i64 and a str id column',
    '    # meet — the same reason `coda_match_keys` exists.',
    '    before = pd.concat(seen, ignore_index=True)',
    "    before = before.groupby(before['neuronId'].astype(str), sort=False)['w'].sum()",
    "    kept = long.groupby(long['neuronId'].astype(str), sort=False)['weight'].sum()",
    '    frac = (kept / before).fillna(1.0).clip(upper=1.0)',
    "    if weighting == 'fraction':",
    "        totals = long.groupby(['neuronId', 'direction'], sort=False)['weight'].transform('sum')",
    "        long['weight'] = (long['weight'] / totals).fillna(0.0)",
    "    long['cnFrac'] = long['neuronId'].astype(str).map(frac).fillna(1.0).to_numpy()",
    '    return long[columns]',
  ],
})

/**
 * Pairwise similarity over sparse feature vectors.
 *
 * Mirrors `nodes/lib/similarityOps.ts`, including the part that module is mostly about: the
 * dense observation × feature matrix is never built. `sparse.coo_matrix` is the same coordinate
 * form the long table already is, `tocsr()` sums the repeated pairs, and `X @ X.T` is the one
 * pass — the same `Σ_f |column f|²` work, done by scipy instead of by hand.
 *
 * Two differences from the canvas, both deliberate and neither affecting a cell:
 *
 * - **Labels sort lexicographically here and numerically there**, so `L10` precedes `L2` in
 *   this index and follows it on the canvas. That is already true of the Pivot emitter, which
 *   leaves the ordering to `pivot_table`; matching Coda would mean transcribing a collator.
 * - Euclidean has no similarity form, so `output` is forced for it — the same exception
 *   `effectiveOutput` makes, made in the same place rather than at each call.
 *
 * The weighted Jaccard is the one metric with no product form: `Σ min(a,b)` is recovered from
 * `Σ a + Σ b − Σ |a − b|` over two rows at a time, which stays sparse but is a loop rather than
 * a matmul. It is why the TypeScript accumulates three different sums and not one.
 */
registerHelper({
  name: 'coda_similarity',
  requires: [['pandas'], ['numpy'], ['scipySparse']],
  source: [
    'def _coda_gram(X, metric):',
    '    """The per-pair sum a metric needs: a dot product, a shared count, or a sum of minima."""',
    "    if metric == 'jaccard':",
    '        B = X.copy()',
    '        B.data = np.ones_like(B.data)',
    '        return np.asarray((B @ B.T).todense())',
    "    if metric == 'jaccardWeighted':",
    '        # No product form, so this is the feature-major pass the canvas runs: a column of',
    '        # the transpose is exactly the observations carrying that feature, and every pair',
    '        # that shares it is one outer minimum. Cost is the same sum-of-squared-column-',
    '        # heights, against O(n x nnz) for tiling one row against the whole matrix.',
    '        n = X.shape[0]',
    '        G = np.zeros((n, n))',
    '        Xc = X.tocsc()',
    '        for c in range(Xc.shape[1]):',
    '            lo, hi = Xc.indptr[c], Xc.indptr[c + 1]',
    '            if hi - lo < 2:',
    '                continue',
    '            rows, vals = Xc.indices[lo:hi], Xc.data[lo:hi]',
    '            G[np.ix_(rows, rows)] += np.minimum.outer(vals, vals)',
    '        return G',
    '    return np.asarray((X @ X.T).todense())',
    '',
    '',
    'def _coda_similarity(X, labels, metric, output):',
    '    """Observations against themselves, as a square frame."""',
    '    # `copy=False`: already-float input is the ordinary case and copying it is nnz for nothing.',
    '    X = X.tocsr().astype(float, copy=False)',
    '    n, width = X.shape',
    "    if metric == 'euclidean':",
    "        output = 'distance'",
    '    total = np.asarray(X.sum(axis=1)).ravel()',
    '    present = np.diff(X.indptr).astype(float)',
    '    # Row sums of squares without building a second sparse matrix, which `X.multiply(X)`',
    '    # would allocate in full for every metric including the two that never read it.',
    '    squares = np.bincount(np.repeat(np.arange(n), np.diff(X.indptr)),',
    '                          weights=X.data ** 2, minlength=n)',
    '    G = _coda_gram(X, metric)',
    "    with np.errstate(divide='ignore', invalid='ignore'):",
    "        if metric == 'cosine':",
    '            norm = np.sqrt(squares)',
    '            S = G / np.outer(norm, norm)',
    "        elif metric == 'euclidean':",
    '            S = np.sqrt(np.maximum(0.0, squares[:, None] + squares[None, :] - 2.0 * G))',
    "        elif metric == 'jaccard':",
    '            S = G / (present[:, None] + present[None, :] - G)',
    "        elif metric == 'jaccardWeighted':",
    '            S = G / (total[:, None] + total[None, :] - G)',
    "        elif metric == 'pearson':",
    '            # Centred over the ambient feature space, counting an absent feature as the',
    '            # zero it is -- not over the features an observation happens to have.',
    '            mean = total / width',
    '            sd = np.sqrt(np.maximum(0.0, squares / width - mean ** 2))',
    '            S = (G / width - np.outer(mean, mean)) / np.outer(sd, sd)',
    '        else:',
    "            raise ValueError('Unknown metric: %s' % metric)",
    '    # In place, both of them: S is n x n, and at the size this refuses at each spare copy',
    '    # is half a gigabyte. The canvas reuses one accumulator for the same reason.',
    '    np.nan_to_num(S, nan=0.0, posinf=0.0, neginf=0.0, copy=False)',
    "    if output == 'distance' and metric != 'euclidean':",
    '        np.subtract(1.0, S, out=S)',
    '    # Written rather than computed: an observation with no features at all divides 0 by 0,',
    '    # and a non-zero distance to itself is not a distance.',
    "    np.fill_diagonal(S, 0.0 if output == 'distance' else 1.0)",
    '    return pd.DataFrame(S, index=labels, columns=labels)',
    '',
    '',
    "def coda_similarity_long(df, observations, features, value=None, metric='cosine',",
    "                         output='similarity'):",
    '    """Triplets -- observation, feature, value -- compared pairwise."""',
    '    obs = df[observations].astype(str)',
    '    feat = df[features].astype(str)',
    "    w = (pd.to_numeric(df[value], errors='coerce') if value",
    '         else pd.Series(1.0, index=df.index))',
    '    keep = w.notna() & (w != 0)',
    '    obs, feat, w = obs[keep], feat[keep], w[keep]',
    '    labels = sorted(obs.unique())',
    '    columns = sorted(feat.unique())',
    '    # `labels` and `columns` are sorted, so the codes are one C call rather than a Python',
    '    # dict lookup per non-zero.',
    '    rows = np.searchsorted(labels, obs.to_numpy())',
    '    cols = np.searchsorted(columns, feat.to_numpy())',
    '    # `tocsr` sums duplicate coordinates, which is the coalescing step by another name.',
    '    X = sparse.coo_matrix((w.to_numpy(float), (rows, cols)),',
    '                          shape=(len(labels), len(columns))).tocsr()',
    '    if value is None:',
    '        # Presence is applied after the merge, not by passing ones in: an ungrouped table',
    "        # listing a pair four times would otherwise carry a 4 under presence's name.",
    '        X.data = np.ones_like(X.data)',
    '    return _coda_similarity(X, labels, metric, output)',
    '',
    '',
    "def coda_similarity_wide(df, id_column, columns, metric='cosine', output='similarity'):",
    '    """One row per observation, one picked column per feature."""',
    '    ids = df[id_column].astype(str)',
    '    labels = sorted(ids.unique())',
    '    rows = np.searchsorted(labels, ids.to_numpy())',
    "    values = df[list(columns)].apply(pd.to_numeric, errors='coerce').fillna(0.0)",
    '    # `groupby(sort=False)` rather than `np.add.at`, which is the documented unbuffered',
    '    # ufunc path and an order of magnitude slower at this job.',
    '    dense = values.groupby(rows, sort=True).sum().to_numpy(float)',
    '    return _coda_similarity(sparse.csr_matrix(dense), labels, metric, output)',
  ],
})

/**
 * Coda's Describe Table, column by column.
 *
 * A helper rather than a one-liner because the one-liner is wrong. `df.describe()` looks like
 * exactly this node and answers a different question: it drops every non-numeric column unless
 * asked otherwise, has no notion of an empty string being an absence, reports a standard
 * deviation this node does not, and omits the non-zero count it does. A notebook that quietly
 * substituted it would still run, still print a table of numbers under the node's own name, and
 * disagree with the canvas on the two columns anybody exported it to check.
 *
 * Mirrors `src/nodes/lib/describeOps.ts`, including the two rules that are decisions rather than
 * arithmetic: absence is null *or* a string that is empty once trimmed, and the id column is
 * counted and never measured.
 *
 * The one thing that is deliberately *not* mirrored is `dtype`, which reports pandas' own name
 * (`int64`, `object`) rather than Coda's (`i64`, `str`). The column says what the frame in front
 * of the reader actually holds, which is the more useful of the two answers in a notebook.
 */
registerHelper({
  name: 'coda_describe',
  requires: [['pandas'], ['numpy']],
  source: [
    'CODA_DESCRIBE_COLUMNS = [',
    "    'column', 'dtype', 'non_nulls', 'nulls', 'non_zero', 'unique',",
    "    'min', 'q1', 'median', 'q3', 'max', 'mean',",
    ']',
    '',
    '',
    'def coda_describe(df):',
    '    """One row per column: what is filled in, how varied it is, and how it is spread.',
    '',
    "    Not `df.describe()` -- see the note in Coda's exporter. Non-numeric columns get the",
    '    counts and nothing else, and so does `neuronId`: a mean neuron id names no neuron.',
    '    """',
    '    rows = []',
    '    for name in df.columns:',
    '        s = df[name]',
    "        # Coda's absence rule: null, or a string that is empty once trimmed. `False` stays",
    '        # a real answer, which is why this tests the text rather than truthiness.',
    '        label = s.astype(str).str.strip()',
    "        present = s.notna() & (label != '')",
    '        # `is_numeric_dtype` is True for a boolean column, so the flags are excluded here',
    '        # rather than surprising somebody with a mean of 0.4 under a column of True/False.',
    '        numeric = (pd.api.types.is_numeric_dtype(s)',
    '                   and not pd.api.types.is_bool_dtype(s))',
    "        measured = numeric and name != 'neuronId'",
    '        row = dict.fromkeys(CODA_DESCRIBE_COLUMNS)',
    '        row.update(',
    '            column=name,',
    '            dtype=str(s.dtype),',
    '            non_nulls=int(present.sum()),',
    '            nulls=int((~present).sum()),',
    '            # Distinct values as printed, which is the count a Group By downstream agrees',
    '            # with.',
    '            unique=int(label[present].nunique()),',
    '        )',
    '        if measured:',
    "            v = pd.to_numeric(s[present], errors='coerce')",
    '            # A NaN or an infinity arrived, so it is present and distinct above -- but it',
    '            # takes no part in the spread, where it would drag a quartile with it.',
    '            v = v[np.isfinite(v)]',
    "            row['non_zero'] = int((v != 0).sum())",
    '            if len(v):',
    '                row.update(',
    '                    min=float(v.min()),',
    '                    # pandas interpolates linearly by default, which is the type-7',
    '                    # definition `quantileSorted` implements.',
    '                    q1=float(v.quantile(0.25)),',
    '                    median=float(v.quantile(0.5)),',
    '                    q3=float(v.quantile(0.75)),',
    '                    max=float(v.max()),',
    '                    mean=float(v.mean()),',
    '                )',
    '        rows.append(row)',
    "    # `columns=` explicitly, so an empty frame still comes back with the summary's shape",
    '    # rather than with no columns at all.',
    '    return pd.DataFrame(rows, columns=CODA_DESCRIBE_COLUMNS)',
  ],
})

/**
 * The graph statistics behind `net.metrics`, in networkx.
 *
 * A helper rather than eight lines in the emitter because the *projection* is the part that has
 * to be got right and would otherwise be written into a notebook cell where nobody would read
 * it: clustering, k-core, transitivity and assortativity are defined over an undirected simple
 * graph, and a connectome is neither. `nx.Graph(G)` alone keeps self-loops, which cannot close a
 * triangle and would inflate every one of them.
 *
 * Two departures from networkx's own defaults, both matching Coda and both stated in the
 * docstring: clustering is empty rather than 0 on a node with fewer than two neighbours, and
 * `assortativity` is empty rather than `nan` where the correlation is 0/0.
 */
registerHelper({
  name: 'coda_network_metrics',
  requires: [['pandas'], ['networkx']],
  source: [
    'def coda_network_metrics(G):',
    '    """Per-node and graph-level statistics -- Coda\'s Network Metrics node.',
    '',
    '    Returns `(nodes, summary)`: one row per node, and a single row for the graph.',
    '',
    '    Structural measures are taken over the undirected simple projection, so a reciprocal',
    '    pair is one neighbour relationship and a self-loop counts towards degree and nothing',
    '    else. `clustering` is empty rather than 0 where a node has fewer than two neighbours:',
    '    it has no pair of them to close, and calling that 0 makes the mean a count of the',
    '    leaves.',
    '    """',
    '    directed = G.is_directed()',
    '    ids = list(G.nodes())',
    '    n = len(ids)',
    '    U = nx.Graph()',
    '    U.add_nodes_from(ids)',
    '    U.add_edges_from((a, b) for a, b in G.edges() if a != b)',
    '',
    '    deg_in = dict(G.in_degree()) if directed else dict(G.degree())',
    '    deg_out = dict(G.out_degree()) if directed else dict(G.degree())',
    "    w_in = dict(G.in_degree(weight='weight')) if directed else dict(G.degree(weight='weight'))",
    "    w_out = dict(G.out_degree(weight='weight')) if directed else dict(G.degree(weight='weight'))",
    '    clustering = nx.clustering(U)',
    '    core = nx.core_number(U)',
    '',
    '    # Largest component first, ties by the earliest node -- the ordering Coda gives these,',
    '    # so that colouring by component ranks the same way in both.',
    '    component = {}',
    '    sizes = {}',
    '    ranked = sorted(nx.connected_components(U), key=len, reverse=True)',
    '    for rank, members in enumerate(ranked, start=1):',
    '        for node in members:',
    '            component[node] = rank',
    '            sizes[node] = len(members)',
    '',
    '    nodes = pd.DataFrame({',
    "        'id': [str(v) for v in ids],",
    "        'degreeIn': [deg_in[v] for v in ids],",
    "        'degreeOut': [deg_out[v] for v in ids],",
    "        'degree': [deg_in[v] + deg_out[v] for v in ids],",
    "        'weightIn': [w_in[v] for v in ids],",
    "        'weightOut': [w_out[v] for v in ids],",
    "        'strength': [w_in[v] + w_out[v] for v in ids],",
    "        'clustering': [clustering[v] if U.degree(v) >= 2 else None for v in ids],",
    "        'coreness': [core[v] for v in ids],",
    "        'component': [component[v] for v in ids],",
    "        'componentSize': [sizes[v] for v in ids],",
    '    })',
    '',
    '    loops = nx.number_of_selfloops(G)',
    '    links = G.number_of_edges()',
    '    observed = (links - loops) if directed else U.number_of_edges()',
    '    possible = n * (n - 1) if directed else n * (n - 1) / 2',
    '    triples = sum(d * (d - 1) / 2 for _, d in U.degree())',
    '    assort = (nx.degree_assortativity_coefficient(U)',
    "              if U.number_of_edges() else float('nan'))",
    '    # Not `nx.overall_reciprocity`, which divides by *every* edge including the self-loops.',
    '    # Coda counts a self-loop towards degree and nothing else, so the denominator here is',
    '    # the ordered pairs between two different nodes -- on a graph with autapses the two',
    '    # answers differ, and only one of them agrees with the card.',
    '    pairs = {(a, b) for a, b in G.edges() if a != b}',
    '    recip = sum(1 for a, b in pairs if (b, a) in pairs)',
    "    weights = pd.Series([float(d.get('weight', 1)) for _, _, d in G.edges(data=True)],",
    "                        dtype='float64')",
    "    degrees = nodes['degree']",
    "    defined = nodes['clustering'].dropna()",
    '',
    '    summary = pd.DataFrame([{',
    "        'nodes': n,",
    "        'links': links,",
    "        'directed': directed,",
    "        'selfLoops': loops,",
    "        # Always 0 here, and kept so the column set matches Coda's: the graph came from",
    '        # `from_pandas_edgelist` over grouped links, which cannot hold two edges on one pair.',
    "        'parallelLinks': 0,",
    "        'isolated': int((degrees == 0).sum()) if n else 0,",
    "        'density': (observed / possible) if possible else None,",
    "        'meanDegree': float(degrees.mean()) if n else None,",
    "        'medianDegree': float(degrees.median()) if n else None,",
    "        'maxDegree': int(degrees.max()) if n else 0,",
    '        # Undirected reciprocity is 1 by construction, so reporting it would be reporting',
    '        # the value of `directed` in a column nobody would read that way.',
    "        'reciprocity': (recip / len(pairs)) if (directed and pairs) else None,",
    "        'components': len(ranked),",
    "        'largestComponent': len(ranked[0]) if ranked else 0,",
    "        'meanClustering': float(defined.mean()) if len(defined) else None,",
    "        'transitivity': nx.transitivity(U) if triples else None,",
    "        'assortativity': None if pd.isna(assort) else float(assort),",
    "        'totalWeight': float(weights.sum()) if len(weights) else 0.0,",
    "        'meanWeight': float(weights.mean()) if len(weights) else None,",
    "        'medianWeight': float(weights.median()) if len(weights) else None,",
    "        'maxWeight': float(weights.max()) if len(weights) else None,",
    '    }])',
    '    return nodes, summary',
  ],
})

/**
 * The centrality set behind `net.centrality`, in networkx.
 *
 * Every measure here is networkx's own, which is the point: Coda's implementations are pinned
 * against these exact functions by a checked-in fixture (`scripts/probe-network-metrics.py`), so
 * the notebook is not a reimplementation that has to be kept in step — it is the thing the
 * canvas was checked against.
 *
 * Three places the notebook and the canvas genuinely differ, each written into the docstring
 * rather than smoothed over. Louvain is networkx's implementation and not graphology's, so a
 * partition may differ while scoring the same modularity. `eigenvector_centrality` raises where
 * Coda returns its last iterate. And the path statistics are skipped entirely under sampling —
 * networkx's `k` argument does not expose the distances its pivots visited, and computing them
 * exactly is the cost sampling was chosen to avoid.
 */
registerHelper({
  name: 'coda_network_centrality',
  requires: [['pandas'], ['networkx']],
  source: [
    'def coda_network_centrality(G, betweenness=True, closeness=True, pagerank=True,',
    '                            eigenvector=False, communities=True, weighted=False,',
    '                            samples=0, seed=1, resolution=1.0, damping=0.85):',
    '    """Centrality columns -- Coda\'s Network Centrality node.',
    '',
    '    Returns `(nodes, summary)`. Weighted paths use 1/weight as a distance, so a strong',
    '    connection is a short path; `samples` sweeps from that many random sources rather than',
    '    from every node, and 0 is exact.',
    '',
    '    `closeness` is harmonic centrality over incoming distances, divided by n - 1 so it is',
    '    comparable across graphs -- classical closeness is undefined for any node that cannot',
    '    reach everything, which on a connectome is most of them.',
    '',
    "    Three differences from Coda worth knowing. Communities come from networkx's Louvain",
    "    rather than graphology's, so a partition may differ while scoring the same modularity.",
    '    Eigenvector centrality raises here if the power iteration does not converge, where Coda',
    "    keeps its last iterate. And the summary's path statistics are skipped under sampling,",
    '    because networkx does not hand back the distances its pivots visited.',
    '    """',
    '    ids = list(G.nodes())',
    '    n = len(ids)',
    "    # Self-loops leave first, which is Coda's rule throughout: a self-loop counts towards",
    '    # degree and towards nothing else. It matters most here -- networkx keeps them, and one',
    '    # heavy autapse is an eigenvector all of its own, scoring 1.0 while every real hub in',
    '    # the graph rounds to zero.',
    '    if nx.number_of_selfloops(G):',
    '        G = G.copy()',
    '        G.remove_edges_from(nx.selfloop_edges(G))',
    '    distance = None',
    '    if weighted:',
    '        G = G.copy()',
    '        for _, _, d in G.edges(data=True):',
    "            w = float(d.get('weight', 1) or 0)",
    "            d['_distance'] = (1 / w) if w > 0 else 1",
    "        distance = '_distance'",
    '',
    "    cols = {'id': [str(v) for v in ids]}",
    '    if betweenness:',
    '        scores = nx.betweenness_centrality(',
    '            G, k=(samples or None), normalized=True, weight=distance, seed=seed,',
    '        )',
    "        cols['betweenness'] = [scores[v] for v in ids]",
    '    if closeness:',
    '        scores = nx.harmonic_centrality(G, distance=distance)',
    "        cols['closeness'] = [scores[v] / (n - 1) if n > 1 else 0.0 for v in ids]",
    '    if pagerank:',
    '        # `tol` and `max_iter` explicitly: networkx stops at 1e-6 by default, which is about',
    '        # five decimal places short of converged -- close enough for a ranking and not close',
    '        # enough to agree with the card, which iterates to 1e-10.',
    "        scores = nx.pagerank(G, alpha=damping, weight='weight', tol=1e-12, max_iter=500)",
    "        cols['pagerank'] = [scores[v] for v in ids]",
    '    if eigenvector:',
    "        scores = nx.eigenvector_centrality(G, max_iter=1000, tol=1e-10, weight='weight')",
    "        cols['eigenvector'] = [scores[v] for v in ids]",
    '',
    '    parts = []',
    '    if communities:',
    '        parts = nx.community.louvain_communities(',
    "            G, weight='weight', resolution=resolution, seed=seed,",
    '        )',
    '        # Largest first, as Coda numbers both communities and components -- so that the',
    '        # colour a category gets is decided by its size rather than by a merge order.',
    '        parts = sorted(parts, key=len, reverse=True)',
    '        rank = {v: i + 1 for i, members in enumerate(parts) for v in members}',
    "        cols['community'] = [rank[v] for v in ids]",
    '    nodes = pd.DataFrame(cols)',
    '',
    '    total = 0.0',
    '    pairs = 0',
    '    longest = 0.0',
    '    swept = (betweenness or closeness) and not samples',
    '    if swept:',
    '        walk = (nx.all_pairs_dijkstra_path_length(G, weight=distance) if distance',
    '                else nx.all_pairs_shortest_path_length(G))',
    '        for _, lengths in walk:',
    '            for d in lengths.values():',
    '                if d == 0:',
    '                    continue',
    '                total += d',
    '                pairs += 1',
    '                longest = max(longest, d)',
    '',
    '    summary = pd.DataFrame([{',
    "        'sources': (samples or n) if (betweenness or closeness) else None,",
    "        'meanPathLength': (total / pairs) if pairs else None,",
    '        # A sampled maximum is a lower bound with no error bar, so it says nothing rather',
    '        # than something that reads like an answer.',
    "        'diameter': longest if pairs else None,",
    "        'reachable': (pairs / (n * (n - 1))) if (swept and n > 1) else None,",
    "        'communities': len(parts) if communities else None,",
    "        'modularity': (nx.community.modularity(",
    "            G, parts, weight='weight', resolution=resolution,",
    '        ) if communities else None),',
    '    }])',
    '    return nodes, summary',
  ],
})

/**
 * Coda's label order: `LC4` before `LC10`, case ignored.
 *
 * `matrixShape.ts` sorts labels with `Intl.Collator({ numeric: true, sensitivity: 'base' })`,
 * and a plain `sorted()` disagrees with it on every label carrying a number — which is every
 * cell type and every neuron id. The key splits a label into digit runs and the text between
 * them, compares the runs as integers (arbitrary precision, so an 18-digit id is exact) and the
 * text case-folded, with a digit run sorting before text as ICU's numeric collation does.
 */
registerHelper({
  name: 'coda_natural_key',
  requires: [['re']],
  source: [
    'def coda_natural_key(label):',
    '    """Sort key giving Coda\'s label order: LC4 before LC10, case ignored."""',
    '    return [',
    '        (0, int(part)) if part.isdigit() else (1, part.lower())',
    "        for part in re.split(r'(\\d+)', str(label))",
    "        if part != ''",
    '    ]',
  ],
})

/**
 * The Heatmap's `Selected Rows` / `Selected Columns`.
 *
 * A helper rather than seven lines in every heatmap cell, because both outputs are bound
 * whether or not anything is wired to them — an emitter cannot ask who is downstream — and this
 * node already emits four other things.
 *
 * **`picked` is positions into the matrix the cell has just finished reshaping**, which is what
 * a rectangle on the card means: the lines under it and no others. It was the drawn *labels*
 * first, and that is the bug it was reported as — naming rows by cell type is one-to-many, so a
 * box round one cell of a fourteen-row `LC4` block took all fourteen.
 *
 * `arrival` is the axis before the Labels tab renamed it and is what `label` carries; where
 * nothing renamed anything the two are the same string, which is the honest reading of "what the
 * card showed". `index` is the position itself, so a sort downstream can put the lines back in
 * the order the card had them. An index the axis does not reach is skipped rather than raising —
 * the canvas drops it too, and a document that failed where the card carried on would be the
 * disagreement these helpers exist to prevent.
 */
registerHelper({
  name: 'coda_matrix_selection',
  requires: [['pandas']],
  source: [
    'def coda_matrix_selection(labels, picked, arrival=None):',
    '    """Coda\'s Selected Rows / Selected Columns: the lines a rectangle covered."""',
    '    labels = [str(label) for label in labels]',
    '    arrival = labels if arrival is None else [str(label) for label in arrival]',
    '    keep = [i for i in sorted(set(picked)) if 0 <= i < len(labels)]',
    '    return pd.DataFrame({',
    "        'label': [arrival[i] for i in keep],",
    "        'index': keep,",
    "        'relabel': [labels[i] for i in keep],",
    '    })',
  ],
})

/**
 * The Heatmap's "other axis follows", as positions.
 *
 * `followOrder` in `matrixShape.ts`, and it is a helper rather than a comprehension because of
 * the one rule a comprehension cannot express: **the first unclaimed line of a repeated name
 * wins**. The obvious spelling — `[l for l in lead if l in follower] + [l for l in follower if
 * l not in set(lead)]` — was what this emitted, and it is wrong twice over once axis labels can
 * repeat, which naming rows by cell type makes routine: a lead label appearing twice takes the
 * same follower line twice, and every follower line sharing a name with it is dropped.
 *
 * Positions rather than labels for the same reason the callers now use `.iloc`: `df.loc[[…]]`
 * with a repeated label returns the *cross product*, so a 3x3 matrix ordered by name came back
 * with five rows. Measured, not reasoned about.
 */
registerHelper({
  name: 'coda_follow_order',
  source: [
    'def coda_follow_order(lead, follower):',
    '    """Positions putting `follower` in `lead`\'s order, matched by label. Coda\'s rule."""',
    '    where = {}',
    '    for i, label in enumerate(follower):',
    '        where.setdefault(label, []).append(i)',
    '    taken = set()',
    '    out = []',
    '    for label in lead:',
    '        for i in where.get(label, []):',
    '            if i not in taken:',
    '                taken.add(i)',
    '                out.append(i)',
    '    # Everything the leader did not name, in the order it already had.',
    '    return out + [i for i in range(len(follower)) if i not in taken]',
  ],
})

/**
 * A long `(query, neighbour, score)` table as umap-learn's `precomputed_knn` pair.
 *
 * Coda's Embedding node, Neighbours port — the route that exists to skip the all-by-all matrix,
 * so pivoting to one here and letting `metric='precomputed'` sort it out would be emitting the
 * cost the node was reached for to avoid.
 *
 * Every rule in it is one the obvious pandas spelling gets *plausibly* wrong, which is
 * `coda_relabel`'s reason for existing one node over:
 *
 * - **The rows are the queries**, in first-appearance order, and a neighbour that is never
 *   itself a query has no row to be placed in and is dropped. With a Target wired, NBLAST k-NN
 *   compares two populations and nearly every reference goes; the canvas warns about the count
 *   and a notebook cannot, so the docstring says it.
 * - **Row `i` names itself first, at distance 0.** umap-learn's `smooth_knn_dist` sums from
 *   index 1, because the reference convention is that a point is its own nearest neighbour;
 *   without the self entry the closest real neighbour is silently dropped from every bandwidth
 *   search.
 * - **`-1` pads a short row** — the value `fuzzy_simplicial_set` skips on ("we didn't get the
 *   full knn for i"), and the same one `umap-js` skips on, so the two implementations agree
 *   about this without either being told. The *distance* at a padded slot is the row's own
 *   furthest real neighbour rather than infinity, which would make the row's mean infinite and
 *   destroy its neighbourhood.
 * - **A repeated pair keeps its smallest distance**, where `dict(zip(...))` keeps the last.
 *
 * Checked by running it: `pnpm probe:helpers`.
 *
 * The observation floor is spliced from `MIN_EMBED_OBSERVATIONS` rather than transcribed —
 * `QUALIFIED_SEPARATOR`'s idiom — so the emitted cell refuses exactly what the card refuses.
 */
registerHelper({
  name: 'coda_umap_knn',
  requires: [['pandas'], ['numpy']],
  needs: ['coda_match_keys'],
  source: [
    "def coda_umap_knn(df, query, target, score=None, scores_are='similarity', k=15):",
    '    """A long neighbour table as umap-learn\'s (indices, distances). Coda\'s Embedding node."""',
    '    q = list(coda_match_keys(df[query]))',
    '    t = list(coda_match_keys(df[target]))',
    '    # First-appearance order, which is the order the canvas lays the points out in.',
    '    labels = list(dict.fromkeys(q))',
    '    row_of = {label: i for i, label in enumerate(labels)}',
    '    n = len(labels)',
    `    if n < ${MIN_EMBED_OBSERVATIONS}:`,
    `        raise ValueError(f"an embedding needs at least ${MIN_EMBED_OBSERVATIONS} observations, got {n}")`,
    '    k = max(2, min(int(k), n - 1))',
    '    if score is None:',
    '        values = np.ones(len(df))',
    '    else:',
    "        values = pd.to_numeric(df[score], errors='coerce').to_numpy(dtype=float)",
    "    if scores_are == 'similarity':",
    '        values = 1.0 - values',
    '    if np.nanmin(values, initial=0.0) < 0:',
    '        raise ValueError("scores give negative distances; check `scores_are`")',
    '    buckets = [{} for _ in range(n)]',
    '    for a, b, d in zip(q, t, values):',
    '        i, j = row_of.get(a), row_of.get(b)',
    '        # A self-match is added back at position 0; kept here it would be a duplicate.',
    '        if i is None or j is None or i == j or not np.isfinite(d):',
    '            continue',
    '        seen = buckets[i].get(j)',
    '        if seen is None or d < seen:',
    '            buckets[i][j] = d',
    '    indices = np.full((n, k), -1, dtype=np.int32)',
    '    dists = np.zeros((n, k), dtype=np.float32)',
    '    for i, bucket in enumerate(buckets):',
    '        found = sorted(bucket.items(), key=lambda pair: pair[1])[: k - 1]',
    '        dists[i, :] = found[-1][1] if found else 1.0',
    '        indices[i, 0], dists[i, 0] = i, 0.0',
    '        for s, (j, d) in enumerate(found):',
    '            indices[i, s + 1], dists[i, s + 1] = j, d',
    '    return labels, indices, dists',
  ],
})

/**
 * Each point's enclosing volume, as Coda's `Points in Volumes` column.
 *
 * A helper rather than lines in the emitter for the reason the rest of this file exists: the
 * rules are the *node's* and not navis's. `navis.in_volume` answers one volume at a time and
 * says nothing about what to do when two of them contain a point, so the loop, the
 * first-on-the-wire rule, the null for a point inside none and the overlap count would
 * otherwise be written out in the cell where nobody can run them.
 *
 * **Every volume is tested, not just until one hits**, which is what makes `overlaps` a real
 * number rather than a guess. The canvas does the same and for the same reason: it is the only
 * way "these synapses are in LO(R)" can be told from "these synapses are in LO(R) and three
 * other things", and short-circuiting hides it behind a perfectly ordinary table.
 *
 * **`None` in an object column, not `NaN`**, so the two ports below are `notna()`/`isna()` and
 * a region name and an absence never share a dtype question. An empty frame keeps the column
 * and its dtype, which is what stops a downstream `groupby` raising on a cloud that happened to
 * miss every shell.
 *
 * The one thing it cannot promise is cell-for-cell agreement with the canvas: navis tests
 * containment through ncollpyde and Coda through a BVH ray, so a point exactly on a face, or
 * any point at all in a mesh that is not closed, is each library's own answer. The emitter says
 * so; a helper cannot fix it.
 */
registerHelper({
  name: 'coda_in_volumes',
  requires: [['pandas'], ['numpy'], ['navis']],
  source: [
    'def coda_in_volumes(df, volumes, column):',
    '    """Each point\'s enclosing volume; first volume wins. Coda\'s Points in Volumes."""',
    "    xyz = df[['x', 'y', 'z']].to_numpy(dtype='float64')",
    '    named = np.full(len(df), None, dtype=object)',
    '    found = np.zeros(len(df), dtype=bool)',
    '    # Boolean, not a counter: the only question asked of it is "more than one", and an',
    '    # int64 column is eight bytes a point where this is one.',
    '    ambiguous = np.zeros(len(df), dtype=bool)',
    '    # An empty cloud still keeps the column and its dtype, so the loop is skipped rather',
    '    # than the frame short-circuited.',
    '    for i, volume in enumerate(volumes if len(df) else []):',
    '        hit = np.asarray(navis.in_volume(xyz, volume), dtype=bool)',
    '        # A point is ambiguous the moment a volume claims one something else already had.',
    '        ambiguous |= hit & found',
    '        # First on the wire wins, so only points nothing has claimed are named here.',
    '        named[hit & ~found] = getattr(volume, "name", None) or str(i)',
    '        found |= hit',
    '    out = df.copy()',
    "    out[column] = pd.Series(named, index=out.index, dtype='object')",
    '    return out, int(ambiguous.sum())',
  ],
})

/**
 * A synapse cloud counted into an edge list, as Coda's `Synapses to Edges`.
 *
 * A helper rather than lines in the cell for `coda_in_volumes`' reason: the rules are the
 * *node's*, and three of them are exactly the ones a reader writing this by hand gets wrong —
 * which is also why the node exists. See `nodes/lib/synapseEdges.ts`.
 *
 * - **The flip.** A row whose polarity reads `post` holds the downstream neuron in the column
 *   the pickers call presynaptic, so both ids *and* both types swap. Under the fixed
 *   orientation nothing is read and nothing swaps.
 * - **`sort=False`**, because the canvas emits groups in first-appearance order and pandas
 *   sorts by default — a diff of the two tables would otherwise be every row.
 * - **`dropna=False`**, because a split column is routinely null: `Points in Volumes` writes
 *   one on both ports and the `Outside` half holds nothing else.
 *
 * A type is `first()`, which skips nulls in pandas — `labelsByNeuron`'s first-non-null rule,
 * for free and by coincidence rather than by design, so it is asserted in the probe rather
 * than assumed here. A synapse with no id at either end is not an edge and is dropped, counted,
 * and printed by the cell, a notebook having no status bar to warn into.
 */
registerHelper({
  name: 'coda_synapse_edges',
  requires: [['pandas']],
  needs: ['coda_ids'],
  source: [
    'def coda_synapse_edges(df, source, target, source_type, target_type, polarity, by):',
    '    """Count a synapse cloud into an edge list. Coda\'s Synapses to Edges."""',
    '    # Only the two id columns are cast, so only they are copied: a million-point cloud',
    '    # carries x/y/z as well, and `coda_ids` writes into the frame it is handed.',
    '    ids = coda_ids(df[[source, target]].copy(), source, target)',
    '    if polarity:',
    "        text = df[polarity].astype('string').str.strip().str.lower()",
    "        flip = text.eq('post').fillna(False)",
    "        unoriented = int((~text.isin(['pre', 'post'])).sum())",
    '    else:',
    '        flip = pd.Series(False, index=df.index)',
    '        unoriented = 0',
    '    # `where` keeps the left where the condition holds, so a flipped row reads the target',
    '    # column as its presynaptic end. Both types swap with them or a pair is named backwards.',
    '    rows = pd.DataFrame(index=df.index)',
    "    rows['preId'] = ids[target].where(flip, ids[source])",
    "    rows['postId'] = ids[source].where(flip, ids[target])",
    '    if source_type or target_type:',
    '        left = df[source_type] if source_type else pd.Series(pd.NA, index=df.index)',
    '        right = df[target_type] if target_type else pd.Series(pd.NA, index=df.index)',
    '        if source_type:',
    "            rows['preType'] = right.where(flip, left)",
    '        if target_type:',
    "            rows['postType'] = left.where(flip, right)",
    '    for name in by:',
    '        rows[name] = df[name]',
    '    # `idText` reads a blank as an absence, so a blank id is not an end — the same rule',
    '    # the R helper spells as `blank()`. Without it a cloud with an empty id cell yields',
    '    # a real edge the canvas never counted, and `dropped` under-reports by those rows.',
    "    for end in ('preId', 'postId'):",
    "        rows[end] = rows[end].astype('string').str.strip().replace('', pd.NA)",
    "    kept = rows[rows['preId'].notna() & rows['postId'].notna()]",
    '    dropped = int(len(rows) - len(kept))',
    "    keys = ['preId', 'postId'] + list(by)",
    "    aggs = {'weight': ('preId', 'size')}",
    "    for name in ('preType', 'postType'):",
    '        if name in kept.columns:',
    "            aggs[name] = (name, 'first')",
    '    edges = (',
    '        kept.groupby(keys, dropna=False, sort=False)',
    '        .agg(**aggs)',
    '        .reset_index()',
    '    )',
    "    # Connectivity's column order, which is what makes the two results interchangeable.",
    "    order = [c for c in ('preId', 'preType', 'postId', 'postType', 'weight')",
    '             if c in edges.columns]',
    '    return edges[order + list(by)], dropped, unoriented',
  ],
})

/**
 * The weighted median, which is the one statistic `Distance between` cannot get from numpy.
 *
 * `np.median` weights every sample equally, and the whole point of the node's arithmetic is that
 * samples are not equal — a skeleton node stands for however much cable happens to be at it. So
 * this is the distance at which half the neuron's cable or surface is nearer and half further.
 *
 * `searchsorted` on the cumulative weight rather than a loop, and the tie arm matters: landing
 * **exactly** on the half takes the midpoint of the two samples either side, as a plain median
 * takes the mean of the two middle values. Without it the canvas and the notebook disagree by one
 * sample's distance on every evenly-weighted neuron, which is most of them after a resample.
 */
registerHelper({
  name: 'coda_weighted_median',
  requires: [['numpy']],
  source: [
    'def coda_weighted_median(values, weights):',
    '    """Half the weight is nearer than this. Coda\'s Distance between node."""',
    "    order = np.argsort(values, kind='stable')",
    '    v, w = np.asarray(values)[order], np.asarray(weights)[order]',
    '    total = w.sum()',
    '    # No cable and no area anywhere — a one-node skeleton, a mesh of loose vertices. The',
    '    # plain median is the honest fallback; NaN would read as "this pair was not measured".',
    '    if total <= 0:',
    '        return float(np.median(v)) if len(v) else float("nan")',
    '    half = total / 2',
    '    cum = np.cumsum(w)',
    '    i = min(int(np.searchsorted(cum, half)), len(v) - 1)',
    '    if i + 1 < len(v) and cum[i] == half:',
    '        return float((v[i] + v[i + 1]) / 2)',
    '    return float(v[i])',
  ],
})

/**
 * Every sample of one neuron, and how much neuron each one stands for.
 *
 * This is the whole of what makes `Distance between` agree with itself across reconstructions, and it is
 * the part a reader writing the cell by hand would leave out: **half the length of each edge at a
 * skeleton node, a third of the area of each triangle at a mesh vertex**. Unweighted, a mean
 * separation measures how finely the neuron was traced as much as how far away the other one is,
 * and `navis.resample_skeleton` upstream moves it.
 *
 * `np.add.at` rather than `+=` on a fancy index, which is the trap: `w[faces[:, 0]] += a`
 * evaluates the right-hand side once and assigns, so a vertex shared by twenty triangles — every
 * vertex — gets **one** triangle's share rather than twenty. The weights would then not sum to
 * the surface area, and nothing else about the answer would look wrong.
 *
 * The weights are checked against the libraries' own totals by `pnpm probe:helpers`: a skeleton's
 * sum to `navis` `cable_length` and a mesh's to `trimesh.area`, exactly.
 */
registerHelper({
  name: 'coda_geom_samples',
  requires: [['pandas'], ['numpy'], ['navis']],
  source: [
    'def coda_geom_samples(n):',
    '    """Sample points and the cable or surface area each stands for. Coda\'s Distance between node."""',
    '    if isinstance(n, navis.MeshNeuron):',
    "        pts = np.asarray(n.vertices, dtype='float64')",
    '        weights = np.zeros(len(pts))',
    '        faces = np.asarray(n.faces)',
    '        if len(faces):',
    '            a, b, c = pts[faces[:, 0]], pts[faces[:, 1]], pts[faces[:, 2]]',
    '            area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)',
    '            for k in range(3):',
    '                np.add.at(weights, faces[:, k], area / 3)',
    '        return pts, weights',
    '    nodes = n.nodes',
    "    pts = nodes[['x', 'y', 'z']].to_numpy(dtype='float64')",
    '    weights = np.zeros(len(pts))',
    '    # navis node ids are not row numbers, so the parent column is mapped through the index',
    "    # rather than used directly. A root's parent is -1 and reindexes to NaN, which is what",
    '    # `child` filters on — an edge per non-root node, exactly as the canvas walks it.',
    '    row = pd.Series(np.arange(len(nodes)), index=nodes.node_id.to_numpy())',
    "    parent = row.reindex(nodes.parent_id.to_numpy()).to_numpy(dtype='float64')",
    '    child = np.flatnonzero(~np.isnan(parent))',
    "    parent = parent[child].astype('int64')",
    '    length = np.linalg.norm(pts[child] - pts[parent], axis=1)',
    '    np.add.at(weights, child, length / 2)',
    '    np.add.at(weights, parent, length / 2)',
    '    return pts, weights',
  ],
})

/**
 * What one neuron answers about a set of points: the distance to the nearest part of it.
 *
 * **The two kinds are indexed differently and it is not an implementation detail.** A skeleton is
 * a set of points and a distance to it is a distance to the nearest of them. A mesh is a
 * *surface*, and the nearest point on it is almost never a vertex — so this asks trimesh for the
 * closest point on a triangle, which is what the canvas's bounding-volume hierarchy answers.
 * Taking the nearest vertex instead would make every number depend on how finely the neuron
 * happened to be tessellated.
 *
 * The mesh path needs **rtree**, which trimesh uses to find candidate faces and which navis does
 * not depend on. Without it `trimesh` falls back to a scan of every triangle, measured here at
 * **131 points a second** against a 71,424-face neuron — one pair of mesh neurons would be five
 * minutes. The helper says so rather than running it: an unusably slow cell that looks like a
 * working one is worse than a line naming the `pip install`.
 */
registerHelper({
  name: 'coda_geom_nearest',
  requires: [['numpy'], ['navis'], ['scipySpatial', 'cKDTree']],
  source: [
    'def coda_geom_nearest(n, points):',
    '    """Distances from arbitrary points to the nearest part of one neuron. Coda\'s Distance between node."""',
    '    if isinstance(n, navis.MeshNeuron):',
    '        try:',
    '            import rtree  # noqa: F401',
    '        except ImportError as exc:',
    '            raise ImportError(',
    '                "Distances to a mesh need rtree (pip install rtree). Without it trimesh "',
    '                "scans every triangle for every point, which is minutes per pair of "',
    '                "neurons rather than milliseconds."',
    '            ) from exc',
    '        query = n.trimesh.nearest',
    '        # `on_surface` returns (closest point, distance, triangle id) — the distance is [1].',
    "        return lambda pts: np.asarray(query.on_surface(pts)[1], dtype='float64')",
    '    tree = cKDTree(points)',
    '    return lambda pts: tree.query(pts, k=1, workers=-1)[0]',
  ],
})

/**
 * The matrix: every Query neuron against every Target neuron. Coda's `Distance between` node.
 *
 * A helper rather than lines in the cell for `coda_in_volumes`' reason — the rules are the
 * *node's* — and here there are five of them, every one of which a reader writing this by hand
 * gets wrong in a way the result cannot show. See `nodes/lib/geometryDistance.ts`.
 *
 * - **Nearest-point, never all-pairs.** Each statistic reduces the set of distances from the
 *   Query's samples to the *nearest* part of the Target. An all-pairs mean measures how big each
 *   neuron is rather than how near the two are, and `min` is the same number either way — so the
 *   distinction is invisible on the one statistic people check first.
 * - **Weighted.** `mean` and `median` are over the neuron's cable or surface, not over its
 *   samples. `min` and `max` are not averages of anything and ignore the weights.
 * - **Within counts each sample once**, which is where this parts company with
 *   `navis.cable_overlap`: that queries the *target's* points against the query's tree and sums
 *   the length of every query node that came back as somebody's nearest neighbour, so a node two
 *   target points both pick is counted twice and one no target point happens to pick is not
 *   counted at all. Measured on two of navis's own example neurons at 2 µm: 1378.68 against
 *   1361.03, a little over one per cent, in a number reported to five figures.
 * - **An unmeasured direction propagates.** The smaller of a measured 4 µm and a pair half of
 *   which says nothing is not 4 µm.
 * - **The upper triangle is mirrored** on an all-by-all whose symmetry combines both directions,
 *   because `mean`, `min` and `max` are symmetric in their two arguments. Half the work.
 */
registerHelper({
  name: 'coda_neuron_distance',
  requires: [['pandas'], ['numpy'], ['scipyDistance', 'cdist']],
  needs: ['coda_geom_samples', 'coda_geom_nearest', 'coda_weighted_median'],
  source: [
    'def coda_neuron_distance(query, target=None, method="nearest", statistic="min",',
    '                         within=2.0, report="absolute", symmetry="mean"):',
    '    """Distance between every pair of neurons, in the neurons\' own units. Coda\'s Distance between node."""',
    '    all_by_all = target is None',
    '    target = query if all_by_all else target',
    '    rows = [str(n.id) for n in query]',
    '    cols = [str(n.id) for n in target]',
    '    out = np.full((len(rows), len(cols)), np.nan)',
    '    # Sampled once per neuron, not once per pair: `coda_geom_samples` is a reindex and two',
    '    # scatter-adds over the whole neuron, so inside the loop a 500-neuron all-by-all would',
    '    # run it a quarter of a million times rather than five hundred.',
    '    qs = [coda_geom_samples(n) for n in query]',
    '    ts = qs if all_by_all else [coda_geom_samples(n) for n in target]',
    '',
    '    if method == "centroid":',
    '        def centre(sample):',
    '            pts, w = sample',
    '            if len(pts) == 0:',
    '                return np.zeros(3)',
    '            return np.average(pts, axis=0, weights=w) if w.sum() > 0 else pts.mean(axis=0)',
    '        a = np.vstack([centre(s) for s in qs])',
    '        b = a if all_by_all else np.vstack([centre(s) for s in ts])',
    '        # cdist, not a broadcast difference: `a[:, None, :] - b[None, :, :]` materialises an',
    '        # N x M x 3 float64 before reducing it — 24 GB at a thousand neurons, where the',
    '        # matrix it reduces to is 8 MB.',
    '        return pd.DataFrame(cdist(a, b), index=rows, columns=cols)',
    '',
    '    both = symmetry != "query"',
    '    target_index = [coda_geom_nearest(n, s[0]) for n, s in zip(target, ts)]',
    '    query_index = target_index if all_by_all else (',
    '        [coda_geom_nearest(n, s[0]) for n, s in zip(query, qs)] if both else None',
    '    )',
    '',
    '    def directed(sample, index):',
    '        pts, w = sample',
    '        if len(pts) == 0:',
    '            return float("nan")',
    '        d = np.asarray(index(pts), dtype="float64")',
    '        if method == "within":',
    '            inside = w[d <= within].sum()',
    '            if report == "fraction":',
    '                total = w.sum()',
    '                return float(inside / total) if total > 0 else float("nan")',
    '            return float(inside)',
    '        if statistic == "min":',
    '            return float(d.min())',
    '        if statistic == "max":',
    '            return float(d.max())',
    "        # Reduced where it is read and nowhere else: the neuron's whole cable or surface is",
    '        # fixed for the matrix, and doing it per *cell* is ~20 us a neuron over 125k cells in',
    '        # a 500-neuron all-by-all — for a number min, max and an absolute within never see.',
    '        total = w.sum()',
    '        if total <= 0:',
    '            return float(d.mean()) if statistic == "mean" else float(np.median(d))',
    '        if statistic == "mean":',
    '            return float(np.average(d, weights=w))',
    '        return coda_weighted_median(d, w)',
    '',
    '    def combine(forward, reverse):',
    '        if symmetry == "query":',
    '            return forward',
    '        if np.isnan(forward) or np.isnan(reverse):',
    '            return float("nan")',
    '        if symmetry == "min":',
    '            return min(forward, reverse)',
    '        if symmetry == "max":',
    '            return max(forward, reverse)',
    '        return (forward + reverse) / 2',
    '',
    '    mirrored = all_by_all and both',
    '    for i in range(len(rows)):',
    '        for j in range(len(cols)):',
    '            if mirrored and j < i:',
    '                continue',
    '            forward = directed(qs[i], target_index[j])',
    '            reverse = directed(ts[j], query_index[i]) if both else float("nan")',
    '            out[i, j] = combine(forward, reverse)',
    '            if mirrored and j != i:',
    '                out[j, i] = out[i, j]',
    '    return pd.DataFrame(out, index=rows, columns=cols)',
  ],
})

/**
 * Coda's flow-chart layering, so a notebook's figure has the columns the card had.
 *
 * A generated helper rather than a networkx call, because networkx has no longest-path layering
 * and the two things it does have are each the wrong answer. `topological_generations` is
 * *earliest*-possible layering, which puts a node one column right of its nearest predecessor
 * rather than its furthest — so `a -> c` beside `a -> b -> c` draws `c` in column 1 with the
 * route through `b` running backwards out of it. And `nx_agraph.graphviz_layout(prog='dot')`
 * does layer properly but needs pygraphviz, a system package a notebook has no business
 * requiring.
 *
 * The cycle pass is the half that has to be here rather than approximated: a connectome subgraph
 * holds reciprocal pairs as a matter of course, and longest-path layering over a graph with a
 * cycle in it does not terminate. Roots first, so the marked edge of a reciprocal pair is the one
 * pointing back towards the sources — `longestPathLayers` in `nodes/lib/flowChartOps.ts`, whose
 * answer this has to match or the notebook's figure is a different picture from the card's.
 */
registerHelper({
  name: 'coda_flow_layers',
  source: [
    'def coda_flow_layers(graph, layer_attr=None):',
    '    """Coda\'s flow-chart layering: a column index per node, as the card drew it."""',
    '    nodes = list(graph.nodes())',
    '    if layer_attr is not None:',
    '        # Read off a column, renumbered densely: the numbers are a measurement and the',
    '        # layers are positions, so 0/2/5 hops draw as three adjacent columns. Anything',
    '        # unmeasured lands in one layer after every measured one, never in layer 0.',
    '        raw = {}',
    '        for node in nodes:',
    '            value = graph.nodes[node].get(layer_attr)',
    '            try:',
    '                raw[node] = None if value is None or value == "" else float(value)',
    '            except (TypeError, ValueError):',
    '                raw[node] = None',
    '        ranks = {',
    '            value: rank',
    '            for rank, value in enumerate(sorted({v for v in raw.values() if v is not None}))',
    '        }',
    '        return {n: ranks.get(raw[n], len(ranks)) for n in nodes}',
    '',
    '    out = {n: [v for v in graph.successors(n) if v != n] for n in nodes}',
    '    indegree = {n: 0 for n in nodes}',
    '    for node in nodes:',
    '        for nxt in out[node]:',
    '            indegree[nxt] += 1',
    '',
    '    # Depth-first, roots first, marking the edges that close a cycle.',
    '    back, state = set(), {n: 0 for n in nodes}',
    '    order = [n for n in nodes if indegree[n] == 0] + [n for n in nodes if indegree[n]]',
    '    for root in order:',
    '        if state[root]:',
    '            continue',
    '        state[root] = 1',
    '        stack = [(root, iter(out[root]))]',
    '        while stack:',
    '            node, pending = stack[-1]',
    '            nxt = next(pending, None)',
    '            if nxt is None:',
    '                state[node] = 2',
    '                stack.pop()',
    '            elif state[nxt] == 1:',
    '                back.add((node, nxt))',
    '            elif state[nxt] == 0:',
    '                state[nxt] = 1',
    '                stack.append((nxt, iter(out[nxt])))',
    '',
    '    # Longest path over what is left, in Kahn order.',
    '    layers = {n: 0 for n in nodes}',
    '    kept = {n: [v for v in out[n] if (n, v) not in back] for n in nodes}',
    '    pending = {n: 0 for n in nodes}',
    '    for node in nodes:',
    '        for nxt in kept[node]:',
    '            pending[nxt] += 1',
    '    queue = [n for n in nodes if pending[n] == 0]',
    '    for node in queue:',
    '        for nxt in kept[node]:',
    '            layers[nxt] = max(layers[nxt], layers[node] + 1)',
    '            pending[nxt] -= 1',
    '            if pending[nxt] == 0:',
    '                queue.append(nxt)',
    '    return layers',
  ],
})

/**
 * The graph a set of routes spans — `neuron.paths`' `Network` port.
 *
 * `fetch_paths` returns one row per *step*: `path` says which route the row belongs to, `bodyId`
 * the neuron reached, and `weight` the strength of the connection **from the previous body in
 * the same path** (0 on a route's first row, which has no previous body). So consecutive rows of
 * one `path` group are an edge, which is `pathsToNetwork`'s rule exactly.
 *
 * A helper rather than eight lines in the cell because of the one thing a comprehension cannot
 * state: the shift is **within a path**, not down the frame. Applied to the frame whole it joins
 * the last body of one route to the first body of the next — a connection that does not exist,
 * carrying the next route's first weight, and it looks like an ordinary edge.
 *
 * Parallel steps are deduplicated: the same connection appearing on forty routes is one edge,
 * and its weight is the same number on each, so `first` rather than a sum — summing would
 * multiply a connection by how many routes happen to run through it.
 */
registerHelper({
  name: 'coda_paths_network',
  requires: [['pandas'], ['networkx']],
  source: [
    'def coda_paths_network(paths):',
    '    """The graph a fetch_paths result spans, as Coda\'s Paths node emits it."""',
    '    graph = nx.DiGraph()',
    '    if len(paths) == 0:',
    '        return graph',
    '    for _, row in paths.iterrows():',
    '        graph.add_node(str(row["bodyId"]), neuronId=str(row["bodyId"]),',
    '                       type=row.get("type"))',
    '    # Shifted *within* each path: down the whole frame it would join the last body of one',
    '    # route to the first body of the next, which is an edge that does not exist.',
    '    steps = paths.copy()',
    '    steps["_from"] = steps.groupby("path")["bodyId"].shift()',
    '    steps = steps.dropna(subset=["_from"])',
    '    for (a, b), group in steps.groupby(["_from", "bodyId"]):',
    '        # One edge however many routes run through it; every row carries the same weight',
    '        # for a given connection, so the first is the value rather than the sum.',
    '        graph.add_edge(str(int(a)), str(int(b)), weight=float(group["weight"].iloc[0]))',
    '    return graph',
  ],
})

/**
 * Coda's Rank Plot ordering and its cumulative share.
 *
 * A generated helper rather than three lines in the cell, because two of the rules are ones a
 * reader would not put in by hand and cannot see the absence of.
 *
 * **The share is of the values, never of the rows.** `cumcount() / len(frame)` is the obvious
 * thing to write and answers a different question — "90% of neurons score below 1e-4" rather
 * than "the top twenty carry 60%". Only the second is what a concentration question asks.
 *
 * **A share of a total means nothing over a signed column.** Ranked descending, a column that
 * can go negative has a running sum that climbs past the total and comes back down: a curve
 * that looks exactly like a Lorenz curve, reaches 1.4, and is not one. The canvas withholds the
 * panel and says why; here the column comes back as NaN, which matplotlib draws as a gap rather
 * than as a line — the same refusal, in the idiom of the thing doing the drawing.
 *
 * `mergesort` because it is the stable one: ties have to break on the frame's own order or two
 * runs of one query rank the same neurons differently, which is invariant 4's requirement of
 * anything reaching a drawing and `rankSeries.ts`' comparator on the canvas.
 */
registerHelper({
  name: 'coda_rank',
  requires: [['pandas']],
  source: [
    'def coda_rank(frame, value, flag=None, descending=True, drop_non_positive=False):',
    '    """Coda\'s Rank Plot ordering and cumulative share, as the card computes them."""',
    '    out = frame.copy()',
    '    out[value] = pd.to_numeric(out[value], errors="coerce")',
    '    out = out[out[value].notna()]',
    '    if drop_non_positive:',
    '        # A log axis has no room for a value at or below zero.',
    '        out = out[out[value] > 0]',
    "    # Stable, so ties break on the frame's own order rather than on whichever the sort left.",
    '    out = out.sort_values(value, ascending=not descending, kind="mergesort")',
    '    out["coda_rank"] = range(1, len(out) + 1)',
    '    # Of the values, never of the rows. Flagged rows are out of both halves: on an Influence',
    '    # result they are the seeds, which carry most of the total and say nothing about the rest.',
    '    counted = out[value] if flag is None else out[value].where(~out[flag].astype(bool), 0.0)',
    '    total = counted.sum()',
    '    if (counted < 0).any() or total <= 0:',
    '        # A share of a total means nothing over a signed column: ranked descending the',
    '        # running sum climbs past the total and comes back down.',
    '        out["coda_share"] = float("nan")',
    '    else:',
    '        out["coda_share"] = counted.cumsum() / total',
    '    return out',
  ],
})
