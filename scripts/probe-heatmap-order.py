#!/usr/bin/env python3
"""Check `coda_cluster_order` in `src/pyodide/linkage.py` against SciPy, in plain CPython.

The Heatmap node's `clustering` order is seaborn's clustermap: rows as vectors, `pdist`, then
`linkage` and `leaves_list`. The bridge cannot load scipy, so `_pairwise` is the three metrics
written in numpy, and *that* is what this checks — the distances to 1e-9 against
`scipy.spatial.distance.pdist`, and the leaf order identical to
`scipy.cluster.hierarchy.leaves_list(linkage(pdist(x)))` on random matrices, both axes, all
five methods Coda offers. Needs numpy, scipy and navis-fastcore, which is why it is a `.py`
beside the `.mjs` probes rather than one of them: nothing here needs Pyodide.

    python3 scripts/probe-heatmap-order.py
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
from scipy.cluster.hierarchy import leaves_list, linkage
from scipy.spatial.distance import pdist, squareform

ROOT = Path(__file__).resolve().parent.parent
source = (ROOT / "src" / "pyodide" / "linkage.py").read_text()
module = types.ModuleType("coda_linkage")
exec(compile(source, "linkage.py", "exec"), module.__dict__)


class Request:
    """What a Pyodide `JsProxy` offers the function: a `.to_py()` returning a dict."""

    def __init__(self, payload):
        self.payload = payload

    def to_py(self):
        return self.payload


failures = 0


def check(what, ok):
    global failures
    if not ok:
        failures += 1
        print(f"  FAIL  {what}")


rng = np.random.default_rng(7)
METHODS = ["ward", "average", "complete", "single", "weighted"]
METRICS = ["euclidean", "correlation", "cosine"]

for trial in range(6):
    rows, cols = int(rng.integers(5, 40)), int(rng.integers(3, 30))
    # Sparse and non-negative, like a connectivity matrix, with a planted block so ties are rare.
    x = np.where(rng.random((rows, cols)) < 0.6, 0.0, rng.random((rows, cols)) * 50)
    x[: rows // 2, : cols // 2] += 20
    # A little noise everywhere: an all-zero row is where Coda and scipy *deliberately* differ
    # (below), so the agreement check must not plant one.
    x += rng.random((rows, cols)) * 1e-3
    for metric in METRICS:
        d = module._pairwise(x, metric)
        ref = squareform(pdist(x, metric=metric))
        check(f"trial {trial} {metric} distances agree with pdist", np.allclose(d, ref, atol=1e-9))
        for axis in ("rows", "columns"):
            v = x if axis == "rows" else x.T
            for method in METHODS:
                got = module.coda_cluster_order(
                    Request(
                        {
                            "values": np.ascontiguousarray(x).tobytes(),
                            "rows": rows,
                            "cols": cols,
                            "axis": axis,
                            "method": method,
                            "metric": metric,
                        }
                    )
                )
                want = leaves_list(linkage(pdist(v, metric=metric), method=method))
                check(
                    f"trial {trial} {axis} {metric} {method} leaf order is scipy's",
                    got["count"] == len(v)
                    and got["order"].dtype == np.int32
                    and np.array_equal(got["order"], want),
                )

# A vector with nothing in it: scipy answers NaN and linkage refuses; Coda puts it at distance 1.
x = rng.random((6, 4))
x[2] = 0.0
d = module._pairwise(x, "cosine")
check("a zero vector is at cosine distance 1 from everything", np.allclose(d[2, [0, 1, 3, 4, 5]], 1.0))
check("…and 0 from itself", d[2, 2] == 0.0)
d = module._pairwise(x, "correlation")
check("a constant vector is at correlation distance 1 from everything", np.allclose(d[2, [0, 1, 3, 4, 5]], 1.0))

# Non-finite cells are read as zero rather than poisoning every distance.
x = rng.random((5, 3))
x[1, 1] = np.nan
got = module.coda_cluster_order(
    Request({"values": x.tobytes(), "rows": 5, "cols": 3, "axis": "rows", "method": "average", "metric": "euclidean"})
)
check("a NaN cell still yields a permutation", sorted(got["order"].tolist()) == list(range(5)))

print("ok" if failures == 0 else f"{failures} failure(s)")
sys.exit(1 if failures else 0)
