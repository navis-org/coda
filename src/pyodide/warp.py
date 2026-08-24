"""Landmark transforms, as Coda asks for them.

The third capability on the bridge, and the cheapest one yet: it declares the same two
packages NBLAST does, so on a runtime that has already scored anything it costs a
`runPython` of these definitions and nothing else.

A thin-plate spline is two operations with very different costs, and keeping them apart is
the whole design of this file.

**Fitting** solves an `(M+4) x (M+4)` system and is cubic in the landmark count. Measured in
this runtime, single-threaded, against the shipped sets: 4,704 ms for FlyWire's 3,390
landmarks, 813 ms for MANC's 1,887, 136 ms for the hemibrain's 1,023 route to JRC2018U.
Native, the same three are 623 ms / ~110 ms / ~20 ms — so wasm costs about 7.5x here, which
is more than the 2-5x a reader would guess and worth stating rather than leaving to be
rediscovered.

**Applying** is a reduction over landmarks per point and is linear in both: 262k points per
second against 3,390 landmarks, 878k against 1,023. A 100,000-point set through the FlyWire
mirror is 382 ms.

So the fit is paid once and the result is kept — twice over. `_FITTED` holds live transforms
for the session, and `coda_warp_fit` hands the *coefficients* back so the JavaScript side can
put them in IndexedDB and return them next session through `TpsTransform.from_coefs`, which
costs 0.1-0.5 ms. Storing them as float32 costs 0.026 nm of accuracy on a value of order 1e6,
against an EM voxel of 4 nm; that was measured rather than assumed.

Both entry points take and return **float32**, which is what a `Float32Array` on the other
side is and what `SkeletonGeometry.positions` already holds. fastcore wants float64 and the
cast happens here, on the wasm heap, rather than doubling what crosses the bridge.
"""

import time

import numpy as np
import navis_fastcore as fc

#: Fitted transforms for this session, by landmark set id.
#:
#: A plain dict, never evicted. The largest entry is a 3,390-landmark spline — its source
#: points and weights are about 160 kB — and there are ten sets in total, so a session that
#: somehow touched every one of them would hold under two megabytes on a heap that is already
#: 216 MB. Evicting would mean re-paying a four-second fit to save nothing anybody would miss.
_FITTED = {}


def _as_xyz(buffer, dtype=np.float32):
    """A flat buffer from the bridge as an (N, 3) float64 array fastcore will take.

    `np.frombuffer` yields a **read-only** view, which `TpsTransform` is happy with — it reads
    its landmarks and its points and writes only into its own output. The `astype` makes the
    copy that the float64 promotion needs anyway, so nothing here is copied twice.
    """
    return np.frombuffer(buffer, dtype=dtype).reshape(-1, 3).astype(np.float64)


def _build(req):
    """The transform this request names, fitting it only if there is no other way.

    Three sources, cheapest first — the coefficients the caller brought back from IndexedDB,
    a transform already fitted in this session, and last the fit itself. The caller decides
    which of the first two it can offer; this decides nothing except the order.
    """
    key = str(req["key"])

    cached = _FITTED.get(key)
    if cached is not None:
        return cached, 0.0

    source = _as_xyz(req["source"], np.float64)

    coefs = req.get("coefficients")
    if coefs is not None:
        # `from_coefs` skips the solve entirely. No `landmarks_target`, so the result cannot
        # be negated — Coda never asks a mirror for its inverse, and a spline has no exact one
        # anyway (`__neg__` is a fresh fit in the other direction, not an inversion).
        transform = fc.TpsTransform.from_coefs(
            source,
            np.frombuffer(coefs["weights"], dtype=np.float32).reshape(-1, 3).astype(np.float64),
            np.frombuffer(coefs["affine"], dtype=np.float32).reshape(4, 3).astype(np.float64),
        )
        _FITTED[key] = transform
        return transform, 0.0

    started = time.perf_counter()
    transform = fc.TpsTransform(source, _as_xyz(req["target"], np.float64))
    _FITTED[key] = transform
    return transform, (time.perf_counter() - started) * 1000.0


def coda_warp_fit(request, report=None):
    """Fit a landmark set and hand back its coefficients, without transforming anything.

    Called when the JavaScript side has no stored coefficients for this set. It could have
    been folded into `coda_warp_apply` — and the apply path does fit when it has to — but a
    separate entry point is what lets the caller pay the four seconds *once*, write the result
    away, and then never reach this function again on any later run or in any later session.

    Returns float32, because that is what goes into the store. See the module docstring for
    what the narrowing costs.
    """
    req = request.to_py()
    if report is not None:
        report(0.05, "fitting spline (one-off)")

    transform, fit_ms = _build(req)

    if report is not None:
        report(1.0, "fitted")

    return {
        "weights": np.ascontiguousarray(transform.W, dtype=np.float32).ravel(),
        "affine": np.ascontiguousarray(transform.A, dtype=np.float32).ravel(),
        "landmarks": len(transform),
        "fitMs": fit_ms,
    }


#: Points per chunk when reporting progress.
#:
#: Chunking is **free here**, which is the opposite of the finding recorded on
#: `coda_nblast`: every point's cost is independent of every other's, so splitting the array
#: repeats no work at all. 20,000 points is about 76 ms against the largest landmark set,
#: which is a bar that moves without being a bar that costs anything.
_CHUNK = 20_000


def coda_warp_apply(request, report=None):
    """Transform points through a landmark set.

    `n_cores=1` explicitly. Pyodide has no `SharedArrayBuffer`, so `get_num_threads()` is 1
    and `None` would resolve to the same thing — passing it says which number was measured
    rather than leaving a reader to wonder whether the timings above were multi-core.
    """
    req = request.to_py()
    transform, fit_ms = _build(req)

    points = _as_xyz(req["points"])
    total = len(points)
    out = np.empty((total, 3), dtype=np.float64)

    started = time.perf_counter()
    for begin in range(0, total, _CHUNK):
        end = min(begin + _CHUNK, total)
        out[begin:end] = transform.xform(points[begin:end], 1)
        if report is not None:
            report(0.1 + 0.9 * (end / max(1, total)), f"{end:,} of {total:,} points")
    apply_ms = (time.perf_counter() - started) * 1000.0

    return {
        # float32 back, matching what the geometry buffers on the other side already are.
        "positions": np.ascontiguousarray(out, dtype=np.float32).ravel(),
        "count": total,
        "fitMs": fit_ms,
        "applyMs": apply_ms,
    }
