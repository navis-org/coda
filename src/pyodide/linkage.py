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


# ---------------------------------------------------------------------------
# The Heatmap node's cluster order
# ---------------------------------------------------------------------------


def _pairwise(x, metric):
    """Distances between the rows of ``x``, as an ``n x n`` array with a zero diagonal.

    The three metrics ``scipy.spatial.distance.pdist`` is usually asked for by a clustermap,
    written in numpy rather than imported, because scipy is not among the packages the bridge
    loads and this file's whole point is that it costs nothing once numpy and the wheel are in.
    Checked against ``pdist`` rather than assumed — see ``scripts/probe-heatmap-order.py``.

    **A vector with nothing in it gets distance 1 under correlation and cosine** — scipy
    answers ``NaN`` for a constant row and ``linkage`` then refuses the whole matrix. Here a
    zero row is a neuron with no partners among these columns, which is not an error but a
    thing with no profile to compare, so it is "unlike everything" and lands at the end of the
    tree rather than taking the picture down. The Coda side counts and says so.
    """
    x = np.asarray(x, dtype=np.float64)
    if metric == "correlation":
        x = x - x.mean(axis=1, keepdims=True)
    if metric in ("correlation", "cosine"):
        norms = np.sqrt((x * x).sum(axis=1))
        with np.errstate(divide="ignore", invalid="ignore"):
            sim = (x @ x.T) / np.outer(norms, norms)
        d = 1.0 - np.nan_to_num(sim, nan=0.0)
        d = np.clip(d, 0.0, 2.0)
    elif metric == "euclidean":
        sq = (x * x).sum(axis=1)
        d2 = sq[:, None] + sq[None, :] - 2.0 * (x @ x.T)
        d = np.sqrt(np.maximum(d2, 0.0))
    else:
        raise ValueError(f"Unknown metric {metric!r}")
    # Symmetric by construction up to rounding, but fastcore reads the upper triangle and the
    # diagonal must be exactly zero for a self-distance rather than 1e-9 of one.
    d = (d + d.T) / 2.0
    np.fill_diagonal(d, 0.0)
    return d


def coda_cluster_order(request, report=None):
    """Rows (or columns) of a matrix in hierarchical-clustering leaf order — a clustermap's axis.

    Not ``coda_linkage_run`` with a different matrix. That one reads its input *as* the
    distances, which is right for an NBLAST score matrix; this one reads each row as a vector
    across the columns and clusters rows by the distance between those vectors, which is what
    ``seaborn.clustermap`` does and what "sort a connectivity matrix by clustering" means.
    ``axis == "columns"`` transposes first and is otherwise the same question.

    Non-finite cells are read as zero before anything is measured — a cell nobody recorded is
    not a partner — and the Coda side has already counted them.
    """
    req = request.to_py()
    rows = int(req["rows"])
    cols = int(req["cols"])
    values = np.frombuffer(req["values"], dtype=np.float64).reshape(rows, cols)
    x = values if str(req["axis"]) == "rows" else values.T
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    n = x.shape[0]

    if report is not None:
        report(0.1, f"distances between {n} vectors")
    d = _pairwise(x, str(req["metric"]))

    if report is not None:
        report(0.5, f"clustering {n} observations")
    Z = fc.linkage(d, method=str(req["method"]), symmetry="none", transform="none")

    if report is not None:
        report(0.9, "leaf order")
    # int32 for the reason `coda_linkage_run` casts: int64 crosses as a BigInt64Array.
    order = np.ascontiguousarray(fc.leaf_order(Z), dtype=np.int32)
    return {"order": order, "count": int(n)}
