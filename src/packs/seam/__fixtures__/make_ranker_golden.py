"""LightGBM's own predictions on sampled feature vectors, as the golden for Coda's TS scorer.

`treeRanker.ts` reads LightGBM's model text and walks it in TypeScript, because LightGBM is a
compiled extension with no Pyodide build. The only honest check of a hand-written traversal is
the library's own answer, so this asks for it:

    python3 -I src/packs/seam/__fixtures__/make_ranker_golden.py \
        ~/Github/SEAM/data/fixtures/coda_rv2/ranker/model.txt \
        src/packs/seam/__fixtures__/treeRanker.json

Needs `lightgbm` and `numpy`, which Coda does not depend on — a throwaway venv is the intended
way (`python3 -m venv …; pip install lightgbm numpy`). It is committed beside `make.py` and
`make_search.py` for the reason those are: a golden only regenerable by whoever still has the
scratchpad is not regenerable.

**The rows are chosen, not sampled.** Each group buys a failure that 191 averaged trees would
otherwise hide — and the first version of this file lacked the threshold rows, which let `<`
pass for `<=` through every one of its 269 vectors.
"""
import json, sys
from pathlib import Path

import numpy as np, lightgbm as lgb

model, out = sys.argv[1], sys.argv[2]
b = lgb.Booster(model_file=model)
n = b.num_feature()
rng = np.random.default_rng(0)

# The per-feature observed ranges, from feature_infos in the model text.
infos = []
for line in open(model):
    if line.startswith('feature_infos='):
        for part in line.split('=', 1)[1].split():
            # LightGBM writes a bare `none` for a feature no tree splits on, which has no range
            # to sample from. A unit interval keeps the row shape without pretending to know one.
            if part == 'none':
                infos.append((0.0, 1.0))
                continue
            lo, hi = part.strip('[]').split(':')
            infos.append((float(lo), float(hi)))
        break

rows = []
for _ in range(200):                                   # inside the ranges
    rows.append([rng.uniform(lo, hi) for lo, hi in infos])
for lo, hi in infos:                                   # at each range's ends, and beyond
    for v in (lo, hi, lo - abs(lo) - 1, hi + abs(hi) + 1, 0.0):
        rows.append([v] * n)
# **Exactly on the split thresholds**, which is what tells `<=` from `<`. Without these the
# two readings agree on every row and a mutation test catches nothing -- the first version of
# this golden claimed to cover them and did not.
thresholds = {}
for line in open(model):
    if line.startswith('split_feature='):
        feats = [int(v) for v in line.split('=', 1)[1].split()]
    elif line.startswith('threshold='):
        for f, t in zip(feats, (float(v) for v in line.split('=', 1)[1].split())):
            thresholds.setdefault(f, set()).add(t)
for f, ts in thresholds.items():
    for t in sorted(ts)[:40]:
        r = [rng.uniform(lo, hi) for lo, hi in infos]
        r[f] = t                                       # exactly on it
        rows.append(list(r))
        r2 = list(r); r2[f] = np.nextafter(t, t + 1)   # the smallest step above it
        rows.append(r2)

rows.append([0.0] * n)
rows.append([1e-35] * n)
# Under missing_type = None -- which this model declares throughout -- LightGBM reads a
# missing value as zero and never consults default_left. This row proves it: its score is
# the all-zero row's.
rows.append([np.nan] * n)
for i in range(n):                                     # one NaN at a time
    r = [rng.uniform(lo, hi) for lo, hi in infos]
    r[i] = np.nan
    rows.append(r)

X = np.array(rows, float)
pred = b.predict(X, raw_score=True)
# Stamped so a model that moves without its golden is a failed test rather than a wrong rank:
# `treeRanker.test.ts` holds this against the set the fixture directory came from.
set_version = None
manifest = Path(model).resolve().parent.parent / 'fixture.json'
if manifest.exists():
    set_version = json.loads(manifest.read_text()).get('version')

json.dump({'trees': b.num_trees(), 'features': n, 'set_version': set_version,
           'rows': [[None if np.isnan(v) else v for v in r] for r in X.tolist()],
           'score': pred.tolist()}, open(out, 'w'))
print(f'{len(rows)} rows, {b.num_trees()} trees, set {set_version}, '
      f'score range {pred.min():.4f} .. {pred.max():.4f}')
