#!/usr/bin/env python3
"""Run generated Python helpers and check what they answer.

`pnpm probe:helpers`. The counterpart of `probe-nblast.mjs` one language over, and it exists for
the same reason: the golden file says the emitted text is unchanged and `check-export.py` says it
parses and its module attributes resolve, but **nothing executes a line of it**. These helpers are
pandas, which is exactly where the mistakes are.

It reads two generated cells: `caveHelpers.ts`' out of the CAVE golden, and the general helper
cell out of `everything.ipynb`. It does *not* claim to cover every helper in the latter — what is
exercised is listed below, and a helper nobody probes is still a helper nobody has run.

It earned its place immediately. `coda_update_root_ids` read its id columns with
`pd.to_numeric(..., errors='coerce')` — exact on a clean column, and **float64** the moment the
column holds one null, which a supervoxel column does by design. `720575940628857210` came back as
`720575940628857344`: a different neuron, no error, and every comparison after it wrong about a
value nothing flagged. Reading the code did not catch it; running it did, on the first try.

The client is a stub rather than a recording, because what is checked here is the pandas — which
rows survive, which value wins a collision, what a repaired id column's dtype is — and not
caveclient's wire format. `check-export.py` covers the signatures against the real package, and
`src/data/cave` covers the service.

Nothing here needs a token or a network.

    python3 scripts/probe-py-helpers.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sparse
from scipy.spatial import distance

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "src" / "export" / "python" / "__fixtures__"
NOTEBOOK = FIXTURES / "cave.ipynb"

# The *generated* helper cell, read out of the golden notebook rather than transcribed here —
# so this probes what the exporter actually writes, exactly as `probe-nblast.mjs` runs the real
# `nblast.py` through the real entry point rather than a copy of it.
def load_cell(notebook: Path, marker: str, ns: dict) -> dict:
    """Exec the generated cell containing `marker` into `ns`, and hand `ns` back.

    Reads the *golden* rather than a transcription, so this probes what the exporter actually
    writes — `probe-nblast.mjs`'s rule, one language over.
    """
    cells = json.loads(notebook.read_text())["cells"]
    src = next(("".join(c["source"]) for c in cells if marker in "".join(c["source"])), None)
    if src is None:
        sys.exit(f"no cell containing {marker!r} in {notebook}")
    exec(src, ns)  # noqa: S102 - the point is to run what was generated
    return ns


ns = load_cell(NOTEBOOK, "def coda_annotation_columns", {"pd": pd, "np": np})

# ---- stub CAVE client -------------------------------------------------------
class Mat:
    def __init__(self, tables, kinds, views=None, metadata=None, counts=None):
        self.tables, self.kinds = tables, kinds
        # A **dict**, which is what caveclient 8.2.1 really answers despite annotating
        # `get_views -> list[str]`. Probed as a dict on purpose: a helper that indexed it
        # would raise a KeyError from a signature that promised a list.
        self.views = views or {}
        self.metadata = metadata or {}
        self.counts = counts or {}
        self.version = 783
    def get_unique_string_values(self, table): return self.kinds.get(table, {})
    # The real `get_tables` does not list views, which is the whole reason `get_views` exists.
    # `self.tables` doubles as the frame store here, so the views are subtracted back out.
    def get_tables(self): return [t for t in self.tables if t not in self.views]
    def get_views(self): return dict(self.views)
    def get_table_metadata(self, table): return self.metadata.get(table, {})
    def get_view_metadata(self, view): return self.views.get(view, {})
    def get_annotation_count(self, table): return self.counts.get(table, (0, 0))[1]
    def query_table(self, table, filter_equal_dict=None, select_columns=None,
                    merge_reference=True, limit=None, split_positions=False):
        df = self.tables[table].copy()
        if filter_equal_dict:
            for col, val in filter_equal_dict.items():
                df = df[df[col] == val]
        if select_columns:
            df = df[[c for c in select_columns if c in df.columns]]
        if limit is not None:
            df = df.head(limit)
        return df.reset_index(drop=True)
    def query_view(self, view, limit=None, split_positions=False):
        df = self.tables[view].copy()
        return (df.head(limit) if limit is not None else df).reset_index(drop=True)

class Anno:
    """The other sub-client, and the only reason it exists here.

    `client.annotation.get_annotation_count` and `client.materialize.get_annotation_count`
    are two different numbers — the table as it stands against what one materialization
    froze — and the whole point of the card is that it shows both and says which is which.
    A stub with one of them could not tell whether the helper had confused them.
    """
    def __init__(self, counts): self.counts = counts
    def get_annotation_count(self, table): return self.counts.get(table, (0, 0))[0]

class CG:
    def __init__(self, current, roots): self.current, self.roots = current, roots
    def is_latest_roots(self, ids, timestamp=None):
        return np.array([int(i) in self.current for i in ids])
    def get_roots(self, svids, timestamp=None):
        return np.array([self.roots.get(int(s), 0) for s in svids], dtype=np.uint64)

class Client:
    def __init__(self, mat=None, cg=None, anno=None):
        self.materialize, self.chunkedgraph, self.timestamp = mat, cg, 'T'
        self.annotation = anno
        self.datastack_name = 'stub'

fails = []
def check(name, cond, detail=''):
    print(('ok   ' if cond else 'FAIL ') + name + (('  ' + detail) if detail and not cond else ''))
    if not cond: fails.append(name)

# ---- coda_cave_neurons ------------------------------------------------------
neurons = pd.DataFrame({'id': [1, 2, 3], 'pt_root_id': [720575940628857210, 720575940628857211, 720575940628857212]})
ann = pd.DataFrame({
    'target_id':            [1, 1, 2, 2, 2],
    'classification_system':['cell_type', 'super_class', 'cell_type', 'cell_type', 'super_class'],
    'cell_type':            ['LC4', 'visual', 'DNp01', 'DNp01_dup', 'descending'],
})
c = Client(Mat({'proofread_neurons': neurons, 'hier': ann},
               {'hier': {'classification_system': ['cell_type', 'super_class']}}), None)
out = ns['coda_cave_neurons'](c, 'proofread_neurons', id_column='pt_root_id',
                              annotation_table='hier', ref_column='target_id',
                              system_column='classification_system', value_column='cell_type')
check('index: one row per neuron', len(out) == 3, str(len(out)))
check('index: cell_type renamed to type', 'type' in out.columns, str(list(out.columns)))
check('index: super_class kept', 'super_class' in out.columns, str(list(out.columns)))
check('index: id is text', out['neuronId'].map(type).eq(str).all())
check('index: 18-digit id exact', out['neuronId'].iloc[0] == '720575940628857210', out['neuronId'].iloc[0])
check('index: first row wins a repeat', out.loc[out['neuronId'] == '720575940628857211', 'type'].iloc[0] == 'DNp01')
check('index: unannotated neuron kept, null', pd.isna(out.loc[out['neuronId'] == '720575940628857212', 'type'].iloc[0]))
check('index: bookkeeping columns dropped', 'id' not in out.columns and 'target_id' not in out.columns, str(list(out.columns)))

bare = ns['coda_cave_neurons'](c, 'proofread_neurons', id_column='pt_root_id')
check('index: no annotation table still works', list(bare.columns) == ['neuronId'], str(list(bare.columns)))

# ---- coda_cave_table --------------------------------------------------------
wide = pd.DataFrame({'id': [9, 8], 'pt_root_id': [111, 111], 'volume': [1.5, 2.5], 'side': ['L', 'R']})
c2 = Client(Mat({'nuclei': wide, 'hier': ann}, {'hier': {'classification_system': ['cell_type']}}), None)
t = ns['coda_cave_table'](c2, 'nuclei', id_column='pt_root_id', columns=['volume'])
check('table: named columns kept', list(t.columns) == ['neuronId', 'volume'], str(list(t.columns)))
check('table: repeated root id kept', len(t) == 2, str(len(t)))
tall = ns['coda_cave_table'](c2, 'nuclei', id_column='pt_root_id')
check('table: empty columns keeps everything', set(tall.columns) >= {'neuronId', 'volume', 'side'}, str(list(tall.columns)))
p = ns['coda_cave_table'](c2, 'hier', id_column='target_id',
                          pivot_on='classification_system', value_column='cell_type')
check('table: pivot folds to one row per neuron', len(p) == 2, str(len(p)))
check('table: pivot names the kind', 'cell_type' in p.columns or 'type' in p.columns, str(list(p.columns)))

# ---- coda_seatable ----------------------------------------------------------
class SeaStub:
    """Enough of `seaserpent.Table` for the helper: one method, returning a frame.

    The dtypes are the ones sea-serpent really hands back, checked live against FlyTable:
    `string` for a text column — which is why an eighteen-digit root id survives here at all —
    and `category` for a single-select.
    """

    def __init__(self, frame):
        self._frame = frame

    def to_frame(self, row_id_index=True, workers=None):
        return self._frame.copy()


sea = pd.DataFrame(
    {
        "root_id": pd.array(
            ["720575940621522189", "720575940628857210", "720575940628857210", "", None],
            dtype="string",
        ),
        "cell_type": pd.array(["LC4", "DNp01", "DNp01", "x", "y"], dtype="string"),
        "side": pd.Categorical(["left", "right", "right", "left", "left"]),
        "notes": pd.array(["a", "b", "c", "d", "e"], dtype="string"),
    }
)
st = ns["coda_seatable"](SeaStub(sea), id_column="root_id", columns=["cell_type", "side"])
check("seatable: named columns kept, in order", list(st.columns) == ["neuronId", "type", "side"], str(list(st.columns)))
check("seatable: 18-digit id exact", st["neuronId"].iloc[0] == "720575940621522189", st["neuronId"].iloc[0])
check("seatable: blank and null ids dropped", len(st) == 3, str(len(st)))
check("seatable: a repeated id is kept", (st["neuronId"] == "720575940628857210").sum() == 2)
check("seatable: cell_type renamed to type", "type" in st.columns and "cell_type" not in st.columns)

st_all = ns["coda_seatable"](SeaStub(sea), id_column="root_id")
check(
    "seatable: empty columns keeps everything but the id",
    list(st_all.columns) == ["neuronId", "type", "side", "notes"],
    str(list(st_all.columns)),
)

# ---- coda_match / coda_isin -------------------------------------------------
# Coda's own filter semantics rather than pandas' defaults: anchored at both ends,
# case-sensitive, and a column the table does not have matching no row.
#
# **Currently unreachable, and said out loud rather than crashed on.** Both helpers are
# registered in `caveHelpers.ts` and no emitter calls `ctx.helper` for either, so neither
# reaches a golden and `ns[...]` raises a KeyError that took the whole script down before any
# later section ran. Pre-existing; skipping it is not a decision about the helpers, which need
# either an emitter that requires them or deleting. A loud skip beats a stack trace, and beats
# silently dropping the checks.
if "coda_match" not in ns:
    print("SKIP coda_match / coda_isin — not in any golden; no emitter requires them")
else:
    idx = pd.DataFrame(
        {
            "neuronId": ["1", "2", "3", "4"],
            "type": pd.array(["LC4", "LPLC1", "LC6", None], dtype="string"),
        }
    )
    check(
        "match: anchored at both ends",
        list(ns["coda_match"](idx, "type", "LC.*")["neuronId"]) == ["1", "3"],
        str(list(ns["coda_match"](idx, "type", "LC.*")["neuronId"])),
    )
    check("match: case-sensitive", len(ns["coda_match"](idx, "type", "lc4")) == 0)
    check("match: a null is not a match", len(ns["coda_match"](idx, "type", ".*")) == 3)
    check("match: a missing column matches nothing", len(ns["coda_match"](idx, "side", ".*")) == 0)
    check(
        "isin: compares as text",
        list(ns["coda_isin"](idx, "neuronId", [1, 3])["neuronId"]) == ["1", "3"],
        str(list(ns["coda_isin"](idx, "neuronId", [1, 3])["neuronId"])),
    )
    check("isin: a missing column matches nothing", len(ns["coda_isin"](idx, "status", ["Traced"])) == 0)

# ---- coda_join_annotations --------------------------------------------------
left  = pd.DataFrame({'neuronId': ['1', '2'], 'type': ['A', 'B'], 'side': ['L', None]})
right = pd.DataFrame({'neuronId': ['2', '3'], 'type': ['B2', None], 'nt': ['ACh', 'GABA']})
j = ns['coda_join_annotations'](left, right)
check('join: outer', sorted(j['neuronId']) == ['1', '2', '3'], str(sorted(j['neuronId'])))
check('join: later wins', j.loc[j['neuronId'] == '2', 'type'].iloc[0] == 'B2')
check('join: falls back where later is null', j.loc[j['neuronId'] == '3', 'type'].isna().all())
check('join: earlier survives where later says nothing', j.loc[j['neuronId'] == '1', 'type'].iloc[0] == 'A')
check('join: no suffix columns left', not any(str(c).endswith('_coda_later') for c in j.columns), str(list(j.columns)))

# ---- coda_update_root_ids ---------------------------------------------------
df = pd.DataFrame({
    'neuronId':      ['720575940628857210', '720575940628857211', '720575940628857212', '720575940628857213'],
    'supervoxel_id': ['81000000000000001', '81000000000000002', None, '81000000000000004'],
    'note':          ['current', 'stale', 'stale no sv', 'stale unknown sv'],
})
cg = CG(current={720575940628857210}, roots={81000000000000002: 720575940628857299})
c3 = Client(None, cg)
r = ns['coda_update_root_ids'](c3, df)
check('repair: current row untouched', r['neuronId'].iloc[0] == '720575940628857210')
check('repair: stale row rewritten', r['neuronId'].iloc[1] == '720575940628857299', r['neuronId'].iloc[1])
check('repair: no supervoxel left alone', r['neuronId'].iloc[2] == '720575940628857212')
check('repair: unknown supervoxel left alone', r['neuronId'].iloc[3] == '720575940628857213', r['neuronId'].iloc[3])
check('repair: still text', r['neuronId'].map(type).eq(str).all())
check('repair: other columns kept', list(r.columns) == list(df.columns))
check('repair: input not mutated', df['neuronId'].iloc[1] == '720575940628857211')

# nothing stale at all: must make no get_roots call
class CountingCG(CG):
    def __init__(self, *a, **k):
        super().__init__(*a, **k); self.asked = 0
    def get_roots(self, svids, timestamp=None):
        self.asked += 1; return super().get_roots(svids, timestamp)
cg2 = CountingCG(current=set(int(i) for i in df['neuronId']), roots={})
r2 = ns['coda_update_root_ids'](Client(None, cg2), df)
check('repair: unedited base costs no get_roots', cg2.asked == 0, str(cg2.asked))
check('repair: unedited base unchanged', r2['neuronId'].tolist() == df['neuronId'].tolist())

# an integer id column keeps its storage
idf = df.copy(); idf['neuronId'] = idf['neuronId'].astype('int64')
r3 = ns['coda_update_root_ids'](Client(None, CG(current={720575940628857210}, roots={81000000000000002: 720575940628857299})), idf)
check('repair: int column stays int', str(r3['neuronId'].dtype).startswith('int'), str(r3['neuronId'].dtype))
check('repair: int rewrite exact', r3['neuronId'].iloc[1] == 720575940628857299, str(r3['neuronId'].iloc[1]))

# ---- coda_combine, out of the *other* golden ---------------------------------
#
# Combine Columns is an ordinary table op, so its helpers live in `everything.ipynb`'s general
# helper cell rather than in the CAVE one. They are pandas either way, and the rule they carry —
# null and blank are one absence — is precisely the sort that reads as correct and answers wrong:
# `df[cols].bfill(axis=1)` is the obvious spelling and stops at the first empty string.
# One cell carries both `coda_combine` and `coda_join`, so it is loaded once.
cns = load_cell(FIXTURES / "everything.ipynb", "def coda_combine(", {"pd": pd, "np": np})

ann = pd.DataFrame({
    'cell_type':      ['LC4', '', None, None],
    'hemibrain_type': ['LC4b', 'PS180', 'DNp01', None],
})
combined = cns['coda_combine'](ann, ['cell_type', 'hemibrain_type'])
check('combine: first with a value wins', combined.iloc[0] == 'LC4', str(combined.iloc[0]))
# Row 1 is the whole point: a blank must not stop the search.
check('combine: blank is absent', combined.iloc[1] == 'PS180', str(combined.iloc[1]))
check('combine: null is absent', combined.iloc[2] == 'DNp01', str(combined.iloc[2]))
check('combine: nothing anywhere stays absent', pd.isna(combined.iloc[3]), str(combined.iloc[3]))

reversed_ = cns['coda_combine'](ann, ['hemibrain_type', 'cell_type'])
check('combine: picked order is priority', reversed_.iloc[0] == 'LC4b', str(reversed_.iloc[0]))

missing = cns['coda_combine'](ann, ['gone', 'hemibrain_type'])
check('combine: a column the frame lacks is skipped', missing.iloc[1] == 'PS180', str(missing.iloc[1]))

src = cns['coda_combine'](ann, ['cell_type', 'hemibrain_type'], source=True)
check('combine: source names the winner', src.iloc[0] == 'cell_type', str(src.iloc[0]))
check('combine: source follows the blank rule', src.iloc[1] == 'hemibrain_type', str(src.iloc[1]))
check('combine: no source where nothing won', pd.isna(src.iloc[3]), str(src.iloc[3]))

# ---- coda_join, the `join` aggregation --------------------------------------
#
# Read out of the same cell. `', '.join(...)` is the obvious spelling and is a different rule
# three ways: it raises on a NaN, it keeps empty strings — which Coda reads as absences — and it
# answers '' for a group with nothing in it where Coda answers None.
jf = pd.DataFrame({
    'type': ['LC4', 'LC4', 'LC4', 'LC6', 'DNp01'],
    'tag':  ['left', '', 'left', None, 'putative giant fibre'],
})
g = jf.groupby('type', dropna=False).agg(n=('tag', 'size'), join_tag=('tag', cns['coda_join']))
row = lambda t: g.loc[t, 'join_tag']
check('join: repeat folded away', row('LC4') == 'left', str(row('LC4')))
check('join: blank skipped', '; ; ' not in str(row('LC4')), str(row('LC4')))
check('join: nothing at all is None, not empty string', row('LC6') is None, repr(row('LC6')))
check('join: single value unwrapped', row('DNp01') == 'putative giant fibre', str(row('DNp01')))
check('join: n still counts every row', int(g.loc['LC4', 'n']) == 3, str(g.loc['LC4', 'n']))
of = pd.DataFrame({'k': ['a', 'a', 'a'], 'v': ['b', 'a', 'b']})
go = of.groupby('k').agg(j=('v', cns['coda_join']))
check('join: first-appearance order, not sorted', go.loc['a', 'j'] == 'b; a', str(go.loc['a', 'j']))
cf = pd.DataFrame({'k': ['a', 'a'], 'v': ['DA?', 'da?']})
gc = cf.groupby('k').agg(j=('v', cns['coda_join']))
check('join: folds on exact text only', gc.loc['a', 'j'] == 'DA?; da?', str(gc.loc['a', 'j']))

# A numeric column joined: str() per value, so no float formatting surprises on integers.
nf = pd.DataFrame({'k': ['a', 'a'], 'v': [1, 2]})
gn = nf.groupby('k').agg(j=('v', cns['coda_join']))
check('join: integers are not floated', gn.loc['a', 'j'] == '1; 2', str(gn.loc['a', 'j']))

# The mixed-dtype case, where Coda widens to text rather than refusing.
mixed = pd.DataFrame({'name': [None, 'LC4'], 'cluster': [12693, 7]})
m = cns['coda_combine'](mixed, ['name', 'cluster']).astype('string')
check('combine: a number widened to text', m.iloc[0] == '12693', str(m.iloc[0]))
check('combine: text kept', m.iloc[1] == 'LC4', str(m.iloc[1]))

# ---- coda_google_sheet, out of the same general cell -------------------------
#
# Read from a file rather than a URL: `pd.read_csv` takes either, and what is being checked is
# the dtype and the shaping rather than Google's transport, which `data/annotations/googleSheet.ts`
# records having probed live. The trap is the id column — pandas types eighteen-digit root ids as
# int64 and then as float64 the moment one row is blank, at which point the value is a different
# neuron with nothing to say so.
import tempfile

gns = load_cell(FIXTURES / "everything.ipynb", "def coda_google_sheet(", {"pd": pd, "np": np})
SHEET = (
    "root_id,cell_type,side,synapses\n"
    "720575940628857210,LC4,left,120\n"
    "720575940628857211,,right,4\n"
    ",orphan,left,1\n"
    "720575940628857210,LC4,left,7\n"
)
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "sheet.csv"
    path.write_text(SHEET)

    out = gns['coda_google_sheet'](str(path), id_column='root_id', columns=['cell_type', 'side'])
    ids = list(out['neuronId'])
    check('sheet: a wide id survives exactly',
          ids[0] == '720575940628857210', ids[0])
    check('sheet: and is text, not a rounded float',
          out['neuronId'].dtype == object or str(out['neuronId'].dtype) == 'string',
          str(out['neuronId'].dtype))
    check('sheet: a blank-id row is dropped', len(out) == 3, str(len(out)))
    check('sheet: a repeated id is kept', ids.count('720575940628857210') == 2, str(ids))
    check('sheet: cell_type becomes type', 'type' in out.columns, str(list(out.columns)))
    check('sheet: an unnamed column is left out',
          'synapses' not in out.columns, str(list(out.columns)))

    every = gns['coda_google_sheet'](str(path), id_column='root_id')
    check('sheet: empty columns keeps all but the id',
          list(every.columns) == ['neuronId', 'type', 'side', 'synapses'],
          str(list(every.columns)))

    absent = gns['coda_google_sheet'](str(path), id_column='root_id', columns=['side', 'nope'])
    check('sheet: a named column the tab lacks is dropped, not filled with NaN',
          list(absent.columns) == ['neuronId', 'side'], str(list(absent.columns)))

    try:
        gns['coda_google_sheet'](str(path), id_column='neuronId')
        check('sheet: a missing id column raises', False, 'no error')
    except KeyError as err:
        check('sheet: a missing id column raises, naming the columns',
              'root_id' in str(err), str(err))

# ---- coda_cave_tables / coda_cave_table_info --------------------------------
# The discovery pair. What is worth running rather than reading here is the *shape* of what
# caveclient hands back — a views listing that is a dict where the annotation says list, and a
# sampled row whose null cell must become a blank rather than the string "None" or a NaN.
import io
import contextlib

sample = pd.DataFrame(
    {
        # `Int64` rather than `int64`: a nullable column is what the real query answers, and it
        # is the one `pd.isna` behaves differently on.
        "id": pd.array([7393349], dtype="Int64"),
        "superceded_id": pd.array([None], dtype="Int64"),
        "volume": [26.14124544],
        "pt_root_id": pd.array([720575940626838909], dtype="Int64"),
        # An array-valued cell, which is what caveclient answers for an unsplit bound point —
        # and what `pd.isna` answers elementwise for, raising where a scalar would not.
        "bbox": [np.array([1, 2, 3])],
    }
)
conn = pd.DataFrame({"pre_pt_root_id": [1], "post_pt_root_id": [2], "n_syn": [7]})
# (annotation service, materialization engine) — the measured disagreement, and the reason the
# card shows both. One literal, read by both sub-clients: two copies is exactly how the stub comes
# to disagree about the pair and quietly stops testing the confusion it exists to catch.
COUNTS = {"proofread_neurons": (139540, 127978), "nuclei_v1": (143140, 143140)}
disco = Client(
    Mat(
        {"nuclei_v1": sample, "proofread_neurons": sample, "valid_connection_v2": conn},
        {},
        views={"valid_connection_v2": {"description": "A roll-up of synapses."}},
        metadata={
            "nuclei_v1": {"schema_type": "nucleus_detection", "description": "FlyWire nuclei."},
            "proofread_neurons": {"schema_type": "proofreading_status"},
        },
        counts=COUNTS,
    ),
    None,
    Anno(COUNTS),
)

listed = ns["coda_cave_tables"](disco)
check("tables: two columns", list(listed.columns) == ["table", "kind"], str(list(listed.columns)))
check(
    "tables: sorted, tables before views",
    list(listed["table"]) == ["nuclei_v1", "proofread_neurons", "valid_connection_v2"],
    str(list(listed["table"])),
)
check("tables: kind says which", list(listed["kind"]) == ["table", "table", "view"], str(list(listed["kind"])))
# The caveclient quirk: `get_views` is annotated `list[str]` and answers a dict. `sorted()` reads
# the keys either way, and this is what proves the helper did not index it.
check("tables: a dict views listing is read as its keys", "valid_connection_v2" in set(listed["table"]))

tables_only = ns["coda_cave_tables"](disco, include_views=False)
check(
    "tables: include_views=False is get_tables exactly",
    list(tables_only["table"]) == ["nuclei_v1", "proofread_neurons"],
    str(list(tables_only["table"])),
)
check(
    "tables: kind stays put with views off",
    list(tables_only.columns) == ["table", "kind"] and set(tables_only["kind"]) == {"table"},
)

out = io.StringIO()
with contextlib.redirect_stdout(out):
    cols = ns["coda_cave_table_info"](disco, "proofread_neurons")
printed = out.getvalue()
# Both counts, each labelled. Showing one without saying which it is, is the failure.
check("info: prints the live count", "139,540 live" in printed, printed)
check("info: prints the materialized count, naming the version", "127,978 in v783" in printed, printed)
check("info: prints the schema type", "proofreading_status" in printed, printed)

check("info: three columns", list(cols.columns) == ["column", "type", "example"], str(list(cols.columns)))
by = dict(zip(cols["column"], cols["example"]))
# Invariant 8's other half: pandas holds an eighteen-digit id exactly, so the example is the
# digits rather than 7.2e+17.
check("info: 18-digit id exact", by["pt_root_id"] == "720575940626838909", by["pt_root_id"])
check("info: a null cell is blank, not 'None' or 'NaN'", by["superceded_id"] == "", repr(by["superceded_id"]))
# `pd.isna` on an array raises rather than answering, which the helper has to survive.
check("info: an array-valued cell does not raise", by["bbox"].startswith("["), by["bbox"])
types = dict(zip(cols["column"], cols["type"]))
check("info: reports the pandas dtype", types["pt_root_id"] == "Int64", types["pt_root_id"])

out = io.StringIO()
with contextlib.redirect_stdout(out):
    view_cols = ns["coda_cave_table_info"](disco, "valid_connection_v2")
printed = out.getvalue()
check("info: a view is named as one", "(view)" in printed, printed)
# The wait before the wait, in the notebook where there is no Cancel button — so it has to be
# said before the call rather than after it.
check("info: a view says the row limit will not help", "row limit" in printed, printed)
check("info: a view has no counts printed", "live," not in printed, printed)
check("info: a view is sampled through query_view", list(view_cols["column"]) == ["pre_pt_root_id", "post_pt_root_id", "n_syn"], str(list(view_cols["column"])))

try:
    ns["coda_cave_table_info"](disco, "nuclei_v2")
    check("info: an unknown name raises", False, "no error")
except ValueError as err:
    check("info: an unknown name raises, naming the alternatives", "nuclei_v1" in str(err), str(err))

# ---- coda_partner_vectors ---------------------------------------------------
#
# The reshape the whole connectivity-similarity chain stands on, and the two routes through it
# are genuinely different code: a wired `Neurons` table names the queries outright and works at
# any hop, where the `direction` column answers the same question for the first hop only. The
# fixture below has one hop-2 edge, which is what tells the two apart.
pvns = load_cell(FIXTURES / "everything.ipynb", "def coda_partner_vectors(",
                 {"pd": pd, "np": np})
edges = pd.DataFrame({
    "preId":     [1, 1, 1, 2, 20, 1, 2],
    "postId":    [10, 12, 11, 10, 1, 2, 30],
    "preType":   ["A", "A", "A", "B", "Y", "A", "B"],
    "postType":  ["X", "X", None, "X", "A", "B", "Z"],
    "weight":    [3, 1, 2, 5, 7, 4, 6],
    "hop":       [1, 1, 1, 1, 1, 1, 2],
    "direction": ["downstream", "downstream", "downstream", "downstream",
                  "upstream", "both", "downstream"],
})
queries = pd.DataFrame({"neuronId": [1, 2]})


def vector(frame, neuron):
    rows = frame[frame["neuronId"] == neuron]
    return dict(zip(rows["feature"], rows["weight"]))


pv = pvns["coda_partner_vectors"](edges, neurons=queries)
one = vector(pv, 1)
check("vectors: both directions, kept apart by the prefix",
      one == {"out:X": 4, "out:11": 2, "out:B": 4, "in:Y": 7}, str(one))
# The em-dash trap: an untyped partner stands in for itself rather than pooling with every
# other untyped one, which is the grouping that makes strangers look alike.
check("vectors: an untyped partner falls back to its own id", "out:11" in one)
check("vectors: repeats of one pair are summed", one.get("out:X") == 4, str(one.get("out:X")))
check("vectors: an edge inside the query set counts for both ends",
      vector(pv, 2).get("in:A") == 4, str(vector(pv, 2)))
check("vectors: a wired Neurons table reaches past the first hop",
      vector(pv, 2).get("out:Z") == 6, str(vector(pv, 2)))

derived = pvns["coda_partner_vectors"](edges)
check("vectors: direction alone answers the first hop identically",
      vector(derived, 1) == one, str(vector(derived, 1)))
check("vectors: and drops what it cannot attribute",
      "out:Z" not in vector(derived, 2), str(vector(derived, 2)))

dropped = pvns["coda_partner_vectors"](edges, neurons=queries, untyped="drop")
check("vectors: dropping untyped partners removes exactly those",
      set(vector(dropped, 1)) == {"out:X", "out:B", "in:Y"}, str(vector(dropped, 1)))

byid = vector(pvns["coda_partner_vectors"](edges, neurons=queries, partner_by="id"), 1)
check("vectors: by id, every partner is its own feature",
      byid == {"out:10": 3, "out:12": 1, "out:11": 2, "out:2": 4, "in:20": 7}, str(byid))

frac = vector(pvns["coda_partner_vectors"](edges, neurons=queries, weighting="fraction"), 1)
# Per direction, which is the point: a neuron with far more input than output still has both
# halves of its vector count for something.
check("vectors: fractions are per direction", abs(frac["out:X"] - 0.4) < 1e-12, str(frac))
check("vectors: a lone feature in a direction is all of it", frac["in:Y"] == 1.0, str(frac))

# ---- coda_similarity --------------------------------------------------------
#
# Checked against scipy's own metrics on the dense form of the same data rather than against
# numbers typed in here: what the helper claims is that never building that dense form gives
# the same answer, and the only way to see that is to build it and compare.
sns_ = load_cell(FIXTURES / "everything.ipynb", "def coda_similarity_long(",
                 {"pd": pd, "np": np, "sparse": sparse})
long = pd.DataFrame({
    "obs":  ["a", "a", "a", "b", "b", "c"],
    "feat": ["f1", "f2", "f2", "f1", "f2", "f3"],
    "w":    [1.0, 1.5, 0.5, 2.0, 4.0, 1.0],
})
# `a` is two rows on f2 summing to 2, which makes it exactly parallel to `b`.
dense = np.array([[1.0, 2.0, 0.0], [2.0, 4.0, 0.0], [0.0, 0.0, 1.0]])


def near(a, b, tol=1e-9):
    return bool(np.max(np.abs(np.asarray(a) - np.asarray(b))) < tol)


for metric, scipy_name in (("cosine", "cosine"), ("euclidean", "euclidean"),
                           ("jaccard", "jaccard"), ("pearson", "correlation")):
    got = sns_["coda_similarity_long"](long, "obs", "feat", value="w", metric=metric)
    reference = distance.squareform(distance.pdist(
        dense.astype(bool) if metric == "jaccard" else dense, metric=scipy_name))
    if metric != "euclidean":
        reference = 1.0 - reference
    np.fill_diagonal(reference, 0.0 if metric == "euclidean" else 1.0)
    check(f"similarity: {metric} agrees with scipy on the dense form",
          near(got.to_numpy(), reference), str(got.to_numpy() - reference))

check("similarity: duplicate pairs are summed, so a and b come out parallel",
      near(sns_["coda_similarity_long"](long, "obs", "feat", value="w").loc["a", "b"], 1.0))
# scipy has no weighted Jaccard, so this one is the identity written out: sum of minima over
# sum of maxima, which for a and b is 3/6.
weighted = sns_["coda_similarity_long"](long, "obs", "feat", value="w",
                                        metric="jaccardWeighted")
check("similarity: weighted Jaccard is min over max", near(weighted.loc["a", "b"], 0.5),
      str(weighted.loc["a", "b"]))
check("similarity: and zero where nothing is shared", weighted.loc["a", "c"] == 0.0)

presence = sns_["coda_similarity_long"](long, "obs", "feat")
check("similarity: no value column asks about presence rather than strength",
      near(presence.loc["a", "b"], 1.0) and presence.loc["a", "c"] == 0.0,
      str(presence.to_numpy()))

dist = sns_["coda_similarity_long"](long, "obs", "feat", value="w", output="distance")
check("similarity: a distance is one minus the similarity, diagonal included",
      near(dist.to_numpy(), 1.0 - sns_["coda_similarity_long"](long, "obs", "feat",
                                                               value="w").to_numpy()))
# Euclidean has no similarity form, so the setting is forced rather than honoured — the same
# exception `effectiveOutput` makes on the canvas.
euclid = sns_["coda_similarity_long"](long, "obs", "feat", value="w", metric="euclidean",
                                      output="similarity")
check("similarity: Euclidean is a distance whatever the setting says",
      euclid.loc["a", "a"] == 0.0 and euclid.loc["a", "b"] > 0, str(euclid.to_numpy()))

wide = pd.DataFrame({"id": ["a", "b", "c"], "f1": [1.0, 2.0, 0.0],
                     "f2": [2.0, 4.0, 0.0], "f3": [0.0, 0.0, 1.0]})
check("similarity: the wide layout answers what the long one does",
      near(sns_["coda_similarity_wide"](wide, "id", ["f1", "f2", "f3"]).to_numpy(),
           sns_["coda_similarity_long"](long, "obs", "feat", value="w").to_numpy()))

print()
print(f'{len(fails)} failed' if fails else 'all passed')
sys.exit(1 if fails else 0)
