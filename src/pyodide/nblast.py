"""NBLAST, as Coda asks for it.

This file is the whole of the Python side. It is loaded as a string (vite's `?raw`) and
executed once per runtime boot, so everything here is a definition — the worker calls in
through `coda_dotprops` and `coda_nblast`.

**It is a real `.py` rather than a template literal in the worker** so that it can be read
with syntax highlighting, diffed, and — the half that matters — *run directly against the
same wheel*. Every claim in the comments below was established that way rather than
recalled.

Points arrive in **micrometres**. That is not a preference: the FCWB scoring matrix
fastcore embeds has its last distance bin at 40 um, and beyond it every cell is about -10.
Handed nanometres, every pair of neurons in a dataset scores like two neurons that have
never met — a confident, uniform, entirely wrong answer with no error anywhere. The
conversion happens in `nblastOps.ts`, on the JS side, where the skeletons still know they
are in nm.
"""

import numpy as np
import navis_fastcore as fc


def _coda_prepare(req, k, resample, report=None):
    """Both sides of a comparison as fastcore `Dotprop`s.

    The step every entry point here starts with, and the place the progress split lives: a
    query-only call spends more of the bar on its one set than a query/target call spends on
    its first. Shared so the two entry points cannot come to disagree about either.
    """
    target_set = req.get("target")

    def phase(lo, hi):
        if report is None:
            return None
        return lambda f: report(lo + (hi - lo) * f, "tangent vectors")

    split = 0.25 if target_set else 0.45
    query = coda_dotprops(req["query"], k, resample, phase(0.0, split))
    target = coda_dotprops(target_set, k, resample, phase(split, 0.5)) if target_set else None
    return query, target


def coda_nblast_run(request, report=None):
    """The whole of one NBLAST: resample, tangent vectors, score.

    Composed here rather than in TypeScript so the bridge stays one call. Progress is reported
    across the two phases this can see — dotprops, then the blast — and the blast itself is
    opaque for a measured reason, recorded on `coda_nblast` below.
    """
    req = request.to_py()
    query, target = _coda_prepare(req, int(req["k"]), float(req["resample"]), report)

    if report is not None:
        rows, cols = len(query), len(target) if target else len(query)
        report(0.5, f"scoring {rows} x {cols}")

    scores = coda_nblast(
        query, target, bool(req["normalize"]), str(req["symmetry"]), bool(req["useAlpha"])
    )
    return {
        "scores": scores.ravel(),
        "rows": scores.shape[0],
        "cols": scores.shape[1],
    }


def coda_nblast_knn_run(request, report=None):
    """The k nearest neighbours of each neuron, without the full matrix.

    The same three steps as `coda_nblast_run` up to the scoring, and then a different
    question: fastcore shortlists candidates from a coarse voxel signature and scores only
    those, so the cost is `n * n_candidates` rather than `n^2`. Every score returned is an
    exact NBLAST value — only *which* pairs made the shortlist is approximate. Measured by
    fastcore on 163,976 neurons: recall@20 of 0.990 at the default 200 candidates, having
    scored 0.16% of the pairs.

    Returns the two `(n_query, k)` arrays flat, with their shape beside them. `idx` is cast to
    **int32** on the way out, deliberately: it is int64 in fastcore, and an int64 numpy array
    converts to a `BigInt64Array` in JavaScript, which nothing on the other side is expecting
    and which does not compare with a number. Neuron *counts* here are bounded by the node's
    Max neurons long before int32 is.

    Rows with fewer than `k` candidates are padded — `-1` in `idx`, `-inf` in `scores` — and
    the padding is left in place for the caller to drop, since dropping it here would lose the
    shape that makes the two arrays readable.
    """
    req = request.to_py()
    k = int(req["k"])
    query, target = _coda_prepare(req, int(req["tangentK"]), float(req["resample"]), report)

    if report is not None:
        report(0.5, f"{k} nearest of {len(target) if target else len(query)}")

    symmetry = req["symmetry"]
    idx, scores = fc.nblast_knn(
        query,
        target=target,
        k=k,
        symmetry=None if symmetry == "none" else symmetry,
        n_candidates=int(req["nCandidates"]),
        normalize=bool(req["normalize"]),
        use_alpha=bool(req["useAlpha"]),
    )
    idx = np.asarray(idx)
    scores = np.asarray(scores)
    return {
        "idx": np.ascontiguousarray(idx, dtype=np.int32).ravel(),
        "scores": np.ascontiguousarray(scores, dtype=np.float64).ravel(),
        "rows": int(idx.shape[0]),
        "k": int(idx.shape[1]),
    }


def coda_dotprops(point_set, k, resample, report=None):
    """Concatenated skeleton points in, a list of fastcore `Dotprop`s out.

    `points` is xyz interleaved, float32, every neuron laid after the last; `offsets` says
    where each one starts, counted in points rather than floats. `parents` is one parent
    index per point (-1 for a root), neuron-local — which is exactly the shape
    `resample_skeleton` wants once the node ids are the row numbers.

    **Nothing here guards the small cases, and that is deliberate.** Checked against this
    wheel: fastcore clamps `k` to the point count itself, resamples a forest without
    complaint (both roots survive), and accepts a one-point neuron. A guard here would be
    dead code asserting the opposite of what the library does.
    """
    xyz = np.frombuffer(point_set["points"], dtype=np.float32).reshape(-1, 3).astype(np.float64)
    par = np.frombuffer(point_set["parents"], dtype=np.int32)
    off = np.frombuffer(point_set["offsets"], dtype=np.int32)
    count = len(off) - 1

    out = []
    for i in range(count):
        a, b = int(off[i]), int(off[i + 1])
        pts = np.ascontiguousarray(xyz[a:b])
        if resample > 0 and b - a > 1:
            ids = np.arange(b - a, dtype=np.int32)
            # resample_skeleton returns (ids, parents, xyz, source, alpha, node_map); the
            # geometry is all NBLAST wants, and re-rooting or re-parenting is not our business.
            pts = np.ascontiguousarray(
                fc.resample_skeleton(ids, par[a:b], pts, resample)[2], dtype=np.float64
            )
        vect, alpha = fc.dotprops(pts, k=k)
        out.append(fc.Dotprop(pts, vect, alpha))
        if report is not None and (i % 8 == 7 or i == count - 1):
            report((i + 1) / count)
    return out


def coda_nblast(query, target, normalize, symmetry, use_alpha):
    """Score one set against another, or a set against itself.

    **The square case goes through `nblast_allbyall` as a single call**, which is why no
    progress is reported from inside the blast. Chunking the rows to drive a progress bar
    was measured on this wheel at 1.8x (50-row chunks) to 5.1x (10-row) the run it would be
    reporting on, for byte-identical scores. A bar that costs several times the wait it
    describes is not a bar.

    `symmetry=None` is fastcore's own default and means "no symmetry"; Coda passes `mean`
    unless asked otherwise, because a heatmap that disagrees with itself across the diagonal
    is a puzzle rather than a finding.
    """
    sym = None if symmetry == "none" else symmetry
    if target is None:
        scores = fc.nblast_allbyall(
            query, normalize=normalize, symmetry=sym, use_alpha=use_alpha
        )
    else:
        scores = fc.nblast(
            query, target, normalize=normalize, symmetry=sym, use_alpha=use_alpha
        )
    # C-contiguous float64 is what `getBuffer('f64')` on the JS side reads without a copy.
    return np.ascontiguousarray(scores, dtype=np.float64)
