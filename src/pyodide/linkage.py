"""Hierarchical clustering of a score matrix, as Coda asks for it.

The second capability on the bridge, and it changed nothing in `engine.ts`, `worker.ts` or
`types.ts` — which was the point of making the protocol about *calling a function* rather
than about scoring neurons. It is registered in `runtime.ts`'s `MODULES` beside `nblast`,
declares the same two packages, and so costs nothing at all when NBLAST has already run:
numpy and the fastcore wheel are in by then, and this file's own `runPython` is a few
milliseconds of definitions.

**fastcore's `linkage` is SciPy's, not an approximation of it.** Checked rather than assumed,
against `scipy.cluster.hierarchy.linkage` on NBLAST-shaped matrices: merge order identical on
every one of 60 trials across the five methods Coda offers, heights agreeing to 1.3e-15. So
`Z` here can be handed to `fcluster`, `cut_tree`, `dendrogram` or R's `as.hclust` unchanged,
and the notebook export is a translation rather than a second implementation that has to be
kept in step.

The whole pipeline — symmetrise, similarity to distance, condense, cluster — runs as one
fused pass inside fastcore, so the only allocation is the condensed `n(n-1)/2` vector. The
numpy spelling of the same thing (`squareform(1 - (M + M.T) / 2)`) materialises three more
`n x n` arrays on the way, which is the part that stops being affordable first.
"""

import numpy as np
import navis_fastcore as fc


def coda_linkage_run(request, report=None):
    """A square score matrix in, a linkage matrix and a leaf order out.

    Progress is reported either side of the clustering and never from inside it, for the
    reason `coda_nblast` records about `nblast_allbyall`: fastcore exposes no per-merge hook,
    so the alternative is not a finer bar but a different, slower algorithm driving one.

    The matrix arrives as a buffer and is read with `np.frombuffer`, which yields a
    **read-only** array. That is fine and was verified rather than reasoned: `linkage` borrows
    its input and builds its own condensed buffer, so nothing here needs a writeable copy.
    (`fc.symmetrize` would — it works in place — which is why this does not call it.)
    """
    req = request.to_py()
    n = int(req["n"])
    scores = np.frombuffer(req["scores"], dtype=np.float64).reshape(n, n)

    if report is not None:
        report(0.1, f"clustering {n} x {n}")

    Z = fc.linkage(
        scores,
        method=str(req["method"]),
        symmetry=str(req["symmetry"]),
        transform=str(req["transform"]),
    )

    if report is not None:
        report(0.9, "leaf order")

    # `leaf_order` is fastcore's `scipy.cluster.hierarchy.leaves_list` — checked identical on
    # 20 random matrices — and returns **int64**, which crosses to JavaScript as a
    # `BigInt64Array` that converts without complaint and then compares equal to nothing.
    # Cast, for the reason `coda_nblast_knn_run` casts its `idx`.
    order = np.ascontiguousarray(fc.leaf_order(Z), dtype=np.int32)

    # Flat, with the shape beside it: a 2-D numpy array does not fail to convert, it converts
    # to nested plain Arrays with nothing to say it went wrong. `Z` is (n - 1) x 4, so the
    # count is what makes the ravelled buffer readable on the other side.
    return {
        "merges": np.ascontiguousarray(Z, dtype=np.float64).ravel(),
        "count": int(Z.shape[0]),
        "order": order,
    }
