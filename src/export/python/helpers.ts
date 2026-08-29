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
  source: [
    'def coda_neurons(df):',
    '    """Rename neuprint-python\'s `bodyId` to the `neuronId` every Coda table uses."""',
    "    if df is None or 'bodyId' not in df.columns or 'neuronId' in df.columns:",
    '        return df',
    "    return df.rename(columns={'bodyId': 'neuronId'})",
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
    '    # First occurrence wins, and rows are never multiplied — Coda\'s rule, and `Join`\'s.',
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
 */
registerHelper({
  name: 'coda_partner_vectors',
  requires: [['pandas']],
  source: [
    "def coda_partner_vectors(edges, neurons=None, partner_by='type', untyped='id',",
    "                         weight='weight', weighting='raw'):",
    '    """A pre/post edge list as one long feature vector per query neuron."""',
    '    # One copy, not two: the coerced weight rides alongside rather than being written into',
    '    # a duplicate of the caller\'s frame, which also leaves the input unmutated.',
    "    w = pd.to_numeric(edges[weight], errors='coerce')",
    '    keep = w.notna() & (w != 0)',
    '    df, w = edges[keep], w[keep]',
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
    "    columns = ['neuronId', 'direction', 'partner', 'feature', 'weight']",
    '    parts = []',
    '    for frame, direction, query_col, id_col, type_col in sides:',
    '        if frame.empty:',
    '            continue',
    "        if partner_by == 'type':",
    '            if type_col not in frame.columns:',
    "                raise ValueError('Grouping partners by cell type needs a \"%s\" column.' % type_col)",
    "            typed = frame[type_col].astype('string').str.strip()",
    "            have = typed.notna() & (typed != '')",
    "            if untyped == 'drop':",
    '                frame, typed, have = frame[have], typed[have], have[have]',
    '            label = typed.where(have, frame[id_col].astype(str))',
    '        else:',
    '            label = frame[id_col].astype(str)',
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
    "    if weighting == 'fraction':",
    "        totals = long.groupby(['neuronId', 'direction'], sort=False)['weight'].transform('sum')",
    "        long['weight'] = (long['weight'] / totals).fillna(0.0)",
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
    '        # listing a pair four times would otherwise carry a 4 under presence\'s name.',
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
    '    Not `df.describe()` -- see the note in Coda\'s exporter. Non-numeric columns get the',
    '    counts and nothing else, and so does `neuronId`: a mean neuron id names no neuron.',
    '    """',
    '    rows = []',
    '    for name in df.columns:',
    '        s = df[name]',
    '        # Coda\'s absence rule: null, or a string that is empty once trimmed. `False` stays',
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
    '            row[\'non_zero\'] = int((v != 0).sum())',
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
    '    # `columns=` explicitly, so an empty frame still comes back with the summary\'s shape',
    '    # rather than with no columns at all.',
    '    return pd.DataFrame(rows, columns=CODA_DESCRIBE_COLUMNS)',
  ],
})
