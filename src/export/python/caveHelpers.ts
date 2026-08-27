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
 * table is over FlyWire's deployment's result cap, which the server applies by **truncating** rather
 * than failing. Filtered by kind the largest is 139,255. `get_unique_string_values` is what makes
 * the split free: it is a 52 kB call that names the kinds without reading the table.
 *
 * **The join back is written out rather than left to `merge_reference`**, where its sibling
 * `coda_cave_table` uses the call. Not a disagreement: this one already has the neuron frame in
 * hand — it read it for the population list — so merging on it is a pandas join over rows it is
 * holding, where `merge_reference` would buy a *server-side* join on each of the per-kind
 * queries to learn what is already there. `CaveSource.buildIndex` splits the same way for the
 * same reason. (Note the two do not join different tables: `flywire_fafb_public` is the only spec
 * with an `annotations` block, and there `proofread_neurons` is both the spec's neuron table and
 * `hierarchical_neuron_annotations`' `reference_table`.)
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
 *
 * **This one *does* use `merge_reference`, where `coda_cave_neurons` above does not**, and the
 * two are not in tension. That one joins through the datastack spec's neuron table, which is a
 * fact the spec holds and the metadata does not. This one joins through whatever
 * `reference_table` names, which is the same thing `merge_reference` reads — so writing the
 * merge out by hand here would be reimplementing the call rather than avoiding a guess. The
 * reservation the helper above records is discharged: it is verified against a live datastack
 * now, on BANC's `codex_annotations`, a `cell_type_reference` into `cell_representative_point`
 * that answers a 500 for `pt_root_id` without the join.
 *
 * Two details the join forces, both of which produce a plausible wrong frame rather than an
 * error. `select_columns` has to become the table-keyed **map** and name *both* sides — naming
 * one drops the other's columns — which is why a wide read with no `columns` samples the table's
 * own set with `limit=1` first. And the join sends `pt_supervoxel_id` along with any root id, so
 * every branch narrows to what it asked for; without that the per-kind outer merge collides on
 * it and pandas suffixes `_x`/`_y` across every kind.
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
    '    # A reference table carries `target_id` and no root id anywhere in it, so asking this',
    '    # table for one is a 500: the root id lives on the table it references, and `id_column`',
    "    # names a column over there. `merge_reference` is caveclient's name for that join.",
    "    reference = client.materialize.get_table_metadata(table).get('reference_table') or None",
    '',
    '    def select(own):',
    '        # The join takes the table-keyed map and needs *both* sides named; it rejects a',
    '        # plain list, and a single-table query rejects the map.',
    '        if reference:',
    '            return {table: list(own), reference: [id_column]}',
    '        return [id_column] + list(own)',
    '',
    '    if pivot_on:',
    '        kinds = client.materialize.get_unique_string_values(table).get(pivot_on, [])',
    '        wide = None',
    '        for kind in kinds:',
    '            rows = client.materialize.query_table(',
    '                table,',
    '                filter_equal_dict={pivot_on: kind},',
    '                select_columns=select([value_column]),',
    '                merge_reference=bool(reference),',
    '            )',
    "            rows = rows.drop_duplicates(subset=[id_column], keep='first')",
    '            # Narrowed before the merge: the join sends `pt_supervoxel_id` along with any',
    '            # root id, and merging on the id alone would collide on it once per kind.',
    '            rows = rows.rename(columns={value_column: kind})[[id_column, kind]]',
    "            wide = rows if wide is None else wide.merge(rows, on=id_column, how='outer')",
    '        out = wide if wide is not None else pd.DataFrame({id_column: []})',
    '    else:',
    '        own = list(columns) if columns else None',
    '        if reference and not own:',
    '            # "Everything but the id" cannot stay implicit across a join, since the map has',
    '            # to name both sides. One row is all it takes to read the column set.',
    '            sample = client.materialize.query_table(',
    '                table, limit=1, merge_reference=False',
    '            )',
    '            own = [c for c in sample.columns if c != id_column]',
    '        out = client.materialize.query_table(',
    '            table,',
    '            select_columns=select(own) if own else None,',
    '            merge_reference=bool(reference),',
    '        )',
    '        if own:',
    '            out = out[[id_column] + [c for c in own if c in out.columns]]',
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
 * `str.fullmatch` is the exact pandas equivalent of `anchoredPattern`'s `^(?:…)$`: anchored at both
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

/**
 * The listing behind `List CAVE tables`.
 *
 * **Two endpoints, because CAVE has two kinds of object**, and `get_tables` alone would omit the
 * most useful thing in most datastacks — FlyWire aggregates its connectivity into
 * `valid_connection_v2`, which is a view and appears in no table listing.
 *
 * One caveclient quirk, read off 8.2.1 by running it rather than from the annotation:
 * `MaterializationClient.get_views` is annotated `-> list[str]` and actually returns a **dict**
 * keyed by view name. `sorted()` reads the keys either way, which is why this is a note rather
 * than a workaround, but a caller writing `views[0]` would get a `KeyError` from a signature that
 * promised an index.
 *
 * Sorted, tables first, for the reason `tableListFor` sorts in `data/cave/tables.ts`: the server
 * returns tables in query-planner order and views as an object, so nothing about either order is
 * a promise, and a notebook re-run should produce the frame it produced last time.
 */
registerHelper({
  name: 'coda_cave_tables',
  requires: [['pandas']],
  source: [
    'def coda_cave_tables(client, include_views=True):',
    '    """Every annotation table in a materialization, and optionally its views.',
    '',
    '    Two endpoints rather than one. `get_tables` answers the annotation tables;',
    '    `get_views` answers the saved queries, which is where a datastack\'s aggregations',
    '    live — FlyWire\'s connectivity is `valid_connection_v2`, a view, and no table',
    '    holds it.',
    '    """',
    '    rows = [',
    "        {'table': name, 'kind': 'table'}",
    '        for name in sorted(client.materialize.get_tables())',
    '    ]',
    '    if include_views:',
    '        # caveclient 8.2.1 annotates get_views as list[str] and returns a dict keyed by',
    '        # name. sorted() reads the keys either way.',
    '        rows += [',
    "            {'table': name, 'kind': 'view'}",
    '            for name in sorted(client.materialize.get_views())',
    '        ]',
    "    return pd.DataFrame(rows, columns=['table', 'kind'])",
  ],
})

/**
 * The four reads behind `CAVE table info`, and the two of them that surprise people.
 *
 * **A table has two row counts and they disagree.** caveclient spells them as two methods on two
 * sub-clients, which is the clearest statement of the difference anyone has written down:
 * `client.annotation.get_annotation_count` counts the table as it stands, and
 * `client.materialize.get_annotation_count` counts what this materialization froze. Against
 * `flywire_fafb_public` v783, `proofread_neurons` is **139,540** live and **127,978** in v783,
 * and `hierarchical_neuron_annotations` is 512,957 against 377,699. The live one is the one that
 * is closest to what a query returns, but **neither is it**: a `count=true` query answers 512,957
 * and 139,255 respectively, which is the number `refuseIfCapped` actually checks against. This
 * card shows the two the card is about. Printing one of them without saying which is what
 * `docs/backends.md` records as having cost a debugging round trip.
 *
 * **`split_positions=True` is what makes this agree with Coda.** caveclient's default folds a
 * bound point back into one object column (`pt_position` holding an array), where Coda's raw
 * query args ask for the split form and get `pt_position_x`, `pt_position_y`, `pt_position_z`.
 * Both were run against `nuclei_v1`: the split form is the same sixteen columns in the same order
 * the app lists, and the default is ten. Since this node exists to say what the columns *are*,
 * the two must not answer differently.
 *
 * The `type` column reports the **pandas** dtype rather than Coda's four-name vocabulary, and
 * that is deliberate rather than an oversight. `pt_root_id` is `Int64` here and `str` in Coda,
 * and both are true of their own runtime: pandas holds an eighteen-digit id exactly where a
 * float64 cannot, which is why the app carries it as text (invariant 8). A notebook claiming
 * Coda's answer would be describing a frame the reader does not have.
 */
registerHelper({
  name: 'coda_cave_table_info',
  requires: [['pandas']],
  source: [
    'def coda_cave_table_info(client, table):',
    '    """What one table or view of a datastack is. Prints its facts, returns its columns.',
    '',
    '    Four reads: the listing (so a mistyped name can name the alternatives), the',
    '    metadata record, the two row counts, and one real row to read the materialized',
    '    column set off.',
    '    """',
    '    views = client.materialize.get_views()',
    '    tables = client.materialize.get_tables()',
    '    if table in views:',
    "        kind = 'view'",
    '    elif table in tables:',
    "        kind = 'table'",
    '    else:',
    '        raise ValueError(',
    '            f\'"{table}" is not a table or view in this datastack. \'',
    "            f'Available: {\", \".join(sorted(tables) + sorted(views))}'",
    '        )',
    '',
    "    if kind == 'table':",
    '        meta = client.materialize.get_table_metadata(table)',
    "        print(f'{table}  ({meta.get(\"schema_type\", \"?\")})')",
    '        # Two counts, both true, and they disagree by up to a third. The annotation',
    '        # service counts the table as it stands; the materialization engine counts what',
    '        # this snapshot froze. The live one is what predicts a truncated query.',
    '        live = client.annotation.get_annotation_count(table)',
    '        frozen = client.materialize.get_annotation_count(table)',
    "        print(f'  rows: {live:,} live, {frozen:,} in v{client.materialize.version}')",
    "        if meta.get('reference_table'):",
    '            print(f\'  annotates: {meta["reference_table"]}\')',
    '        # The publisher went out of its way to attach this; every table probed has none.',
    "        if meta.get('notice_text'):",
    '            print(f\'  NOTICE: {meta["notice_text"]}\')',
    '    else:',
    '        meta = client.materialize.get_view_metadata(table)',
    "        print(f'{table}  (view)')",
    '        print(',
    "            '  note: CAVE does not push a row limit into a view, so an aggregating one'",
    "            ' builds its whole result before handing back the single row read below.'",
    '        )',
    "    if meta.get('description'):",
    '        print()',
    "        print(meta['description'].strip())",
    '',
    '    # split_positions=True is what makes these the columns Coda lists: caveclient folds a',
    '    # bound point back into one object column by default, where the app asks for x/y/z.',
    "    query = client.materialize.query_view if kind == 'view' else client.materialize.query_table",
    '    sample = query(table, limit=1, split_positions=True)',
    '',
    '    def example(name):',
    '        if sample.empty:',
    "            return ''",
    '        value = sample[name].iloc[0]',
    '        try:',
    '            if pd.isna(value):',
    "                return ''",
    '        except (TypeError, ValueError):',
    '            # An array-valued cell, which pd.isna answers elementwise for.',
    '            pass',
    '        return str(value)',
    '',
    '    return pd.DataFrame(',
    '        {',
    "            'column': list(sample.columns),",
    "            'type': [str(dtype) for dtype in sample.dtypes],",
    "            'example': [example(name) for name in sample.columns],",
    '        },',
    "        columns=['column', 'type', 'example'],",
    '    )',
  ],
})
