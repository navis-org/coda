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
    def __init__(self, tables, kinds): self.tables, self.kinds = tables, kinds
    def get_unique_string_values(self, table): return self.kinds.get(table, {})
    def query_table(self, table, filter_equal_dict=None, select_columns=None,
                    merge_reference=True):
        df = self.tables[table].copy()
        if filter_equal_dict:
            for col, val in filter_equal_dict.items():
                df = df[df[col] == val]
        if select_columns:
            df = df[[c for c in select_columns if c in df.columns]]
        return df.reset_index(drop=True)

class CG:
    def __init__(self, current, roots): self.current, self.roots = current, roots
    def is_latest_roots(self, ids, timestamp=None):
        return np.array([int(i) in self.current for i in ids])
    def get_roots(self, svids, timestamp=None):
        return np.array([self.roots.get(int(s), 0) for s in svids], dtype=np.uint64)

class Client:
    def __init__(self, mat=None, cg=None):
        self.materialize, self.chunkedgraph, self.timestamp = mat, cg, 'T'
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

print()
print(f'{len(fails)} failed' if fails else 'all passed')
sys.exit(1 if fails else 0)
