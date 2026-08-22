/**
 * Generated Python helpers for CAVE datastacks.
 *
 * The counterpart of `helpers.ts` one backend over, and it exists for the same reason: these are
 * the parts of a workflow with no equivalent in `caveclient` or pandas, written into the notebook
 * so it stands on those two and nothing else. Each mirrors a specific piece of `src/data/cave` or
 * `src/data/annotations`, and the pairing is the thing to keep true — a helper that has quietly
 * stopped agreeing with the TypeScript it was ported from still runs and still answers.
 *
 * Every signature they call was read off **caveclient 8.2.1** by introspection rather than
 * recalled. Three of those are not what an experienced user would guess and are noted where they
 * are used: `CAVEclient(..., version=N)` pins the materialization for every subsequent query
 * *and* sets `client.timestamp`; `client.materialize.version` reads that back off the
 * frameworkclient rather than holding its own; and `get_unique_string_values` is the cheap way
 * to learn a long table's kinds without reading the table.
 */

import { registerHelper } from './registry'

/**
 * A column of ids as exact `int64`, never through a float.
 *
 * **`pd.to_numeric` is the wrong function here, and it fails silently.** On a clean column of
 * decimal strings it answers `int64` and is exact — but one null anywhere in the column, which
 * is the ordinary case for a supervoxel column whose whole point is that some rows have none,
 * forces the result to `float64`. Measured: `720575940628857210` comes back as
 * `720575940628857344`, a **different neuron**, and every later comparison is then wrong about
 * a value nothing ever flagged.
 *
 * Invariant 8 at the one seam in this notebook that has to hold it, and it was caught by running
 * the helpers rather than by reading them. A per-value `int()` parses decimal text exactly at any
 * width; anything unreadable becomes 0, which every caller here already treats as "no id".
 */
registerHelper({
  name: 'coda_int64',
  source: [
    'def coda_int64(values):',
    '    """A column of ids as exact int64. Anything unreadable becomes 0."""',
    '',
    '    def one(value):',
    '        try:',
    '            # Exact for an int and for decimal text of any width, which pd.to_numeric is',
    '            # not: a single null in the column makes it answer float64, and an',
    '            # eighteen-digit root id through a float is a different neuron.',
    '            return int(value)',
    '        except (TypeError, ValueError):',
    '            try:',
    '                return int(float(value))',
    '            except (TypeError, ValueError):',
    '                return 0',
    '',
    "    return values.map(one).astype('int64')",
  ],
})

/**
 * A Coda Dataset, which on CAVE is two things rather than one.
 *
 * The neuPrint side binds a bare `Client`, because a neuPrint dataset's labels are properties on
 * the neuron and come back with every query. A CAVE datastack has no such thing: its labels live
 * in an annotation table, and an annotation chain wired on the canvas *replaces* them. So a
 * Coda `DatasetValue` here is a client **and** a neuron table, and one Python name has to carry
 * both — hence a small object rather than the client itself.
 *
 * **`labels` is fetched on first use, not at construction**, and that is the point of the class
 * rather than a tuple. A graph that only cleans an annotation table never asks for the index, and
 * on FlyWire that fetch is 139,255 rows over six queries; binding it eagerly would spend it on
 * every notebook whether or not a cell reads it.
 */
registerHelper({
  name: 'CodaCaveDataset',
  needs: ['coda_cave_neurons'],
  source: [
    'class CodaCaveDataset:',
    '    """A CAVE datastack: the client, and the neuron table Coda labels it with.',
    '',
    '    `client` is a `caveclient.CAVEclient` pinned to one materialization, so every query',
    '    through it answers from the same frozen snapshot and `client.timestamp` is that',
    "    snapshot's instant.",
    '',
    '    `labels` is one row per neuron with Coda\'s column names — `neuronId`, `type` — built',
    "    from the datastack's own tables, or handed over ready-made when something is wired to",
    '    the Dataset\'s Annotations socket on the canvas. It is fetched on first use: a graph',
    '    that never asks about neurons should not pay for the index.',
    '    """',
    '',
    '    def __init__(',
    '        self,',
    '        client,',
    '        neuron_table=None,',
    '        id_column=\'pt_root_id\',',
    '        annotation_table=None,',
    '        ref_column=None,',
    '        system_column=None,',
    '        value_column=None,',
    '        labels=None,',
    '    ):',
    '        self.client = client',
    '        self.neuron_table = neuron_table',
    '        self.id_column = id_column',
    '        self.annotation_table = annotation_table',
    '        self.ref_column = ref_column',
    '        self.system_column = system_column',
    '        self.value_column = value_column',
    '        self._labels = labels',
    '',
    '    @property',
    '    def labels(self):',
    '        if self._labels is None:',
    '            if self.neuron_table is None:',
    '                raise ValueError(',
    "                    'This datastack publishes no neuron table, so the only list of its '",
    "                    'neurons is an annotation source. Wire one to the Dataset on the canvas '",
    "                    'and export again, or pass labels= here.'",
    '                )',
    '            self._labels = coda_cave_neurons(',
    '                self.client,',
    '                self.neuron_table,',
    '                id_column=self.id_column,',
    '                annotation_table=self.annotation_table,',
    '                ref_column=self.ref_column,',
    '                system_column=self.system_column,',
    '                value_column=self.value_column,',
    '            )',
    '        return self._labels',
  ],
})

/**
 * Coda's column names for an annotation table.
 *
 * Two renames and no more, which is `annotationColumn` in `data/annotations/types.ts`: the id
 * column becomes `neuronId`, and a `cell_type`/`celltype` column becomes `type`. Those are the
 * two columns nodes address **by name** — everything else is a passthrough only a column picker
 * ever names — and missing the second is entirely silent: a chain publishing `cell_type` leaves
 * every type-by-name consumer blank while the schema still declares the column.
 *
 * The id is cast to `str`, which is invariant 8 at this seam. An eighteen-digit root id is not
 * exact as a float64, and pandas will happily make one the moment a column of them meets a null.
 */
registerHelper({
  name: 'coda_annotation_columns',
  needs: ['coda_int64'],
  requires: [['pandas']],
  source: [
    'def coda_annotation_columns(df, id_column):',
    '    """Rename a CAVE table\'s columns to the two names Coda addresses by name."""',
    '    renames = {}',
    '    if id_column in df.columns:',
    "        renames[id_column] = 'neuronId'",
    '    for name in (\'cell_type\', \'celltype\'):',
    "        if name in df.columns and 'type' not in df.columns:",
    "            renames[name] = 'type'",
    '            break',
    '    out = df.rename(columns=renames)',
    "    if 'neuronId' not in out.columns:",
    '        return out',
    '    # A row with no id names no neuron, which is what Coda\'s shaping drops. An empty',
    '    # string counts: SeaTable spells a blank cell that way.',
    "    ids = out['neuronId']",
    "    out = out[ids.notna() & (ids.astype(str) != '')].copy()",
    "    ids = out['neuronId']",
    '    if pd.api.types.is_float_dtype(ids):',
    '        # Already lossy — a float64 cannot hold an eighteen-digit root id — but `str()` of',
    '        # one is `7.2e+17`, which matches nothing at all. Integer text at least keeps the',
    '        # shape of an id. Text and int columns go straight through, exact at any width.',
    '        ids = coda_int64(ids)',
    "    out['neuronId'] = ids.astype(str)",
    '    return out',
  ],
})

/**
 * The neuron index: one row per neuron, one column per annotation kind.
 *
 * `CaveSource.neuronIndex`, and the two things that make it more than a query are both forced.
 *
 * **The annotation table is read one kind at a time.** FlyWire's
 * `hierarchical_neuron_annotations` is long — one row per (neuron, kind, value) — and the whole
 * table is over CAVE's 500,000-row result cap, which the server applies by **truncating** rather
 * than failing. Filtered by kind the largest is 139,255. `get_unique_string_values` is what makes
 * the split free: it is a 52 kB call that names the kinds without reading the table.
 *
 * **The join back is written out rather than left to `merge_reference`.** caveclient will merge a
 * reference table with its target for you, and that is very likely the tidier call — but it was
 * not verified against a live datastack here, and a silently different frame is exactly the class
 * of thing this exporter refuses to guess at. `merge_reference=False` asks for the raw table, and
 * the merge below is the join Coda performs itself.
 */
registerHelper({
  name: 'coda_cave_neurons',
  needs: ['coda_annotation_columns'],
  requires: [['pandas']],
  source: [
    'def coda_cave_neurons(',
    '    client,',
    '    neuron_table,',
    "    id_column='pt_root_id',",
    '    annotation_table=None,',
    '    ref_column=None,',
    '    system_column=None,',
    '    value_column=None,',
    '):',
    '    """Coda\'s neuron index for a CAVE datastack: one row per neuron, a column per kind."""',
    '    neurons = client.materialize.query_table(',
    "        neuron_table, select_columns=['id', id_column], merge_reference=False",
    '    )',
    '    if annotation_table is None:',
    "        return coda_annotation_columns(neurons.drop(columns=['id']), id_column)",
    '',
    '    kinds = client.materialize.get_unique_string_values(annotation_table).get(',
    '        system_column, []',
    '    )',
    '    wide = None',
    '    for kind in kinds:',
    '        rows = client.materialize.query_table(',
    '            annotation_table,',
    '            filter_equal_dict={system_column: kind},',
    '            select_columns=[ref_column, value_column],',
    '            merge_reference=False,',
    '        )',
    '        # First row wins a repeat, as Coda\'s pivot does: an annotation base can carry two',
    '        # rows for one neuron, and a cross product here would double every downstream count.',
    "        rows = rows.drop_duplicates(subset=[ref_column], keep='first')",
    '        rows = rows.rename(columns={value_column: kind})',
    "        wide = rows if wide is None else wide.merge(rows, on=ref_column, how='outer')",
    '',
    '    if wide is None:',
    "        return coda_annotation_columns(neurons.drop(columns=['id']), id_column)",
    "    out = neurons.merge(wide, left_on='id', right_on=ref_column, how='left')",
    "    out = out.drop(columns=[c for c in ('id', ref_column) if c in out.columns])",
    '    return coda_annotation_columns(out, id_column)',
  ],
})

/**
 * One CAVE annotation table as an ordinary neuron table.
 *
 * `annotation.caveTable`'s two shapes, which are `wideRows` and `pivotRows` in
 * `data/annotations/caveTable.ts`. Wide is taken as it stands; long is pivoted on the kind
 * column, one query per kind for `coda_cave_neurons`' reason.
 *
 * **A repeated root id is kept in the wide form and collapsed in the long one**, which looks
 * inconsistent and is the honest difference between them: many rows per neuron is a long table's
 * *input* shape, so folding them is the operation rather than a dedupe on top of it — while a
 * wide table keyed by a point genuinely carries two rows where a segment holds two nuclei, and
 * that is a fact about somebody's data worth seeing on a Table node.
 */
registerHelper({
  name: 'coda_cave_table',
  needs: ['coda_annotation_columns'],
  requires: [['pandas']],
  source: [
    'def coda_cave_table(',
    '    client,',
    '    table,',
    "    id_column='pt_root_id',",
    '    columns=None,',
    '    pivot_on=None,',
    '    value_column=None,',
    '):',
    '    """A CAVE annotation table as a Coda neuron table."""',
    '    if pivot_on:',
    '        kinds = client.materialize.get_unique_string_values(table).get(pivot_on, [])',
    '        wide = None',
    '        for kind in kinds:',
    '            rows = client.materialize.query_table(',
    '                table,',
    '                filter_equal_dict={pivot_on: kind},',
    '                select_columns=[id_column, value_column],',
    '                merge_reference=False,',
    '            )',
    "            rows = rows.drop_duplicates(subset=[id_column], keep='first')",
    '            rows = rows.rename(columns={value_column: kind})',
    "            wide = rows if wide is None else wide.merge(rows, on=id_column, how='outer')",
    '        out = wide if wide is not None else pd.DataFrame({id_column: []})',
    '    else:',
    '        select = [id_column] + list(columns) if columns else None',
    '        out = client.materialize.query_table(',
    '            table, select_columns=select, merge_reference=False',
    '        )',
    '        if columns:',
    '            out = out[[id_column] + [c for c in columns if c in out.columns]]',
    '    return coda_annotation_columns(out, id_column)',
  ],
})

/**
 * A SeaTable base's table as a Coda neuron table.
 *
 * `shapeRows` in `data/annotations/seaTable.ts`: the id column renamed, the named columns kept,
 * a row with no id dropped, and a repeated id **kept** — a base carrying two rows for one neuron
 * is a fact about somebody's spreadsheet, and collapsing it here would hide it from the only
 * person who can act on it. Measured on FlyTable's `main.info`: 58,340 rows over 56,309 distinct
 * ids, one segment appearing 104 times with its `side` disagreeing between them.
 *
 * **`to_frame()` rather than a SQL query**, and the reason is dtypes rather than convenience.
 * sea-serpent sanitises on the way out — a date column becomes datetimes, a checkbox becomes
 * booleans, and a text column stays text, so an eighteen-digit root id arrives exact under
 * pandas' `string` dtype. `Table.query()` hands back raw records and loses all of that. Measured
 * live against FlyTable: `to_frame()` is 3.3 s for 58,340 × 52 and about 134 MB in memory,
 * against 0.8 s for three columns through `query(..., no_limit=True)` — so the narrowing is a
 * real win where it is wanted, and the emitter offers it as a comment beside the call rather
 * than as the default.
 */
registerHelper({
  name: 'coda_seatable',
  needs: ['coda_annotation_columns'],
  requires: [['pandas']],
  source: [
    "def coda_seatable(table, id_column='root_id', columns=None):",
    '    """A SeaTable table as a Coda neuron table."""',
    '    df = table.to_frame(row_id_index=False)',
    '    # sea-serpent names its columns with numpy `str_`, which indexes fine and reads oddly',
    '    # in anything that prints the column list.',
    '    df.columns = [str(c) for c in df.columns]',
    '    if columns:',
    '        keep = [c for c in columns if c in df.columns and c != id_column]',
    '    else:',
    '        # Empty means every column but the id, which is what a base says without being',
    '        # asked what "every" is.',
    '        keep = [c for c in df.columns if c != id_column]',
    '    return coda_annotation_columns(df[[id_column] + keep], id_column)',
  ],
})

/**
 * Two annotation sources chained.
 *
 * `joinAnnotations` in `nodes/lib/annotationOps.ts`: a **full outer** join on `neuronId`, so
 * every neuron either source knows about comes through — which is what makes chaining two
 * sources the way to combine populations on a datastack that publishes no neuron table.
 *
 * The collision rule is the part worth transcribing exactly: a later source **wins, falling back
 * to the earlier one where it has no value**. That is a coalesce rather than a replace, and
 * getting it backwards produces a table that is right except in the cells one source left blank.
 *
 * Each side is deduplicated on the id first. Without that, pandas cross-products a repeated root
 * id — 1,089 of them on FlyTable's `main.info`, one appearing 104 times — and every downstream
 * count is multiplied rather than merged.
 */
registerHelper({
  name: 'coda_join_annotations',
  requires: [['pandas']],
  source: [
    'def coda_join_annotations(left, right):',
    '    """Chain two annotation sources: outer join on `neuronId`, the later one winning."""',
    '    if left is None:',
    '        return right',
    '    if right is None:',
    '        return left',
    "    left = left.drop_duplicates(subset=['neuronId'], keep='first')",
    "    right = right.drop_duplicates(subset=['neuronId'], keep='first')",
    "    shared = [c for c in right.columns if c in left.columns and c != 'neuronId']",
    '    merged = left.merge(',
    "        right, on='neuronId', how='outer', suffixes=('', '_coda_later')",
    '    )',
    '    for name in shared:',
    "        later = merged[name + '_coda_later']",
    '        # Later wins, falling back to the earlier source where the later one is null.',
    '        merged[name] = later.combine_first(merged[name])',
    "        merged = merged.drop(columns=[name + '_coda_later'])",
    '    return merged',
  ],
})

/**
 * An anchored, case-sensitive regex over one column — Coda's own filter, and Neo4j's `=~`.
 *
 * `str.fullmatch` is the exact pandas equivalent of `compileRegex`'s `^(?:…)$`: anchored at both
 * ends, case-sensitive, and `na=False` so a missing value is not a match. `str.match` anchors
 * only the start and would quietly widen every pattern.
 *
 * **A column the table does not have matches no row**, which is what Coda answers rather than an
 * accident of it: a filter naming a column this dataset does not publish is Cypher's null rule,
 * and it is reachable here because a CAVE datastack's columns are whatever its annotations
 * happen to carry.
 */
registerHelper({
  name: 'coda_match',
  requires: [['pandas']],
  source: [
    'def coda_match(df, column, pattern):',
    '    """Rows whose `column` matches `pattern` end to end, case-sensitively."""',
    '    if column not in df.columns:',
    '        return df.iloc[0:0]',
    "    return df[df[column].astype('string').str.fullmatch(pattern, na=False)]",
  ],
})

/**
 * Rows whose `column` is one of `values`, with the same missing-column rule as `coda_match`.
 *
 * Compared as text throughout, which is invariant 8 at this seam: a CAVE id column is `str`
 * because an eighteen-digit root id is not exact as a float, so `isin` against a list of Python
 * ints matches nothing at all — silently, and on every row.
 */
registerHelper({
  name: 'coda_isin',
  requires: [['pandas']],
  source: [
    'def coda_isin(df, column, values):',
    '    """Rows whose `column` is one of `values`, compared as text."""',
    '    if column not in df.columns:',
    '        return df.iloc[0:0]',
    '    wanted = [str(v) for v in values]',
    '    return df[df[column].astype(str).isin(wanted)]',
  ],
})

/**
 * Bring stale root ids forward to a materialization.
 *
 * `cave.updateRootIds`, and the shape is the whole cost control: **the staleness check runs
 * first**, so only rows whose root is not current are looked up and an unedited base costs one
 * `is_latest_roots` pass and no `get_roots` at all.
 *
 * A supervoxel is what makes the repair possible — it is the atom of the segmentation, so
 * proofreading regroups supervoxels rather than splitting them, and `get_roots(sv, timestamp=)`
 * answers which segment one belonged to at any past instant. A row without one is left alone:
 * there is nothing to recover from, and a stale id beats a null or a dropped row.
 *
 * The id column keeps its storage, which matters because a CAVE id column is text: writing
 * numpy `int64`s into it would change its dtype under every downstream operation, and an
 * eighteen-digit id is not exact as a float the moment a null joins it.
 */
registerHelper({
  name: 'coda_update_root_ids',
  needs: ['coda_int64'],
  requires: [['pandas'], ['numpy']],
  source: [
    'def coda_update_root_ids(',
    "    client, df, id_column='neuronId', supervoxel_column='supervoxel_id'",
    '):',
    '    """Repair root ids that were retired before this materialization was frozen."""',
    '    out = df.copy()',
    '    ids = coda_int64(out[id_column])',
    '    svids = coda_int64(out[supervoxel_column])',
    '    askable = ids > 0',
    '    if not askable.any():',
    '        return out',
    '',
    '    # Current at the materialization? Only the rows that are not get looked up.',
    '    latest = client.chunkedgraph.is_latest_roots(',
    "        ids[askable].astype('int64').to_numpy(), timestamp=client.timestamp",
    '    )',
    '    stale = pd.Series(False, index=out.index)',
    '    stale.loc[askable] = ~np.asarray(latest, dtype=bool)',
    '    stale &= svids > 0',
    '    if not stale.any():',
    '        return out',
    '',
    '    roots = client.chunkedgraph.get_roots(',
    "        svids[stale].astype('int64').to_numpy(), timestamp=client.timestamp",
    '    )',
    '    repaired = pd.Series(np.asarray(roots), index=out.index[stale])',
    '    # A supervoxel the graph does not know answers 0, which is not a root to write anywhere.',
    '    repaired = repaired[repaired > 0]',
    '    if repaired.empty:',
    '        return out',
    '    if out[id_column].dtype == object:',
    '        repaired = repaired.astype(str)',
    '    else:',
    '        # Keep the column\'s own storage rather than widening it to uint64 or object,',
    '        # which would change how every later comparison and sort behaves.',
    '        repaired = repaired.astype(out[id_column].dtype)',
    '    out.loc[repaired.index, id_column] = repaired',
    '    return out',
  ],
})
