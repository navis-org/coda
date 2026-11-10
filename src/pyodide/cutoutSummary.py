"""What is in a box of segmentation around a point, as SEAM's candidate search asks it.

The seventh capability on the bridge, and the second whose working code Coda did not write:
`seam/cutout.py` is `summarize_cutout` and `_local_moments` taken out of SEAM's `negatives.py`
**without editing a character**, which `scripts/vendor-seam-cutout.mjs` re-cuts and byte-compares.
SEAM's invariant 11 keeps that code numpy-only precisely so the same text can run in CPython for
the fit and here for the search; four of the geometric ranker's eight features come out of the
moments pass alone, and a feature computed slightly differently still *ranks*, which is the
failure a port would produce and nothing downstream could see.

## What this file is for

The vendored function wants `(uniq, inv, roots_u, res, lo)` — a cutout already factored into
distinct supervoxels, an index per voxel, and the root each supervoxel belongs to. Coda's
`precomputed/volume.ts` produces exactly the first two from a real store and
`cavePostBinary` the third, so this is the marshalling between them and nothing else: flat
arrays in, one flat array per column out.

**It does not fetch.** The cutout and the root lookup are the caller's, because one is a public
bucket read and the other is an authenticated chunkedgraph call at a timestamp, and neither
belongs on this side of the worker.

## What it costs

Measured in Pyodide on a 188x188x134 box (the real Aedes cutout) holding 14,424 supervoxels over
900 roots: **about 560 ms warm** for everything the ranker reads, of which scipy's exact EDT is
~190 ms (against 166 ms for the same call in CPython). A first call in a fresh worker is roughly
twice that, carrying scipy's and pandas' own warm-up — paid once per worker, not per open end,
so 560 ms is the number to price a search with.
scipy's exact EDT is 190 ms of that, against 166 ms for the same call in CPython.

The EDT is also where the memory goes: `return_indices=True` returns a float64 distance and three
int32 index planes, 95 MB for a box this size, and the vendored code's own ravel adds 38 MB — so
one call peaks near 180 MB in a heap that is never given back.
"""

import sys
import time
import types

import numpy as np


#: The vendored module, installed under this name so its own `from __future__` and imports work.
VENDORED = ("seam.cutout",)


def _install(name: str, source: str, parent):
    """Execute one vendored source as a module, the way `seamWindows.py` does."""
    module = types.ModuleType(name)
    module.__dict__["__name__"] = name
    sys.modules[name] = module
    try:
        exec(compile(source, f"<vendored {name}>", "exec"), module.__dict__)
    except BaseException:
        # Out of `sys.modules` before re-raising, or a retry finds a half-built module and
        # fails somewhere further on with no sign of what actually broke.
        del sys.modules[name]
        raise
    setattr(parent, name.rsplit(".", 1)[-1], module)
    return module


def _seam(vendored):
    """`seam.cutout`, installed once per worker."""
    installed = sys.modules.get("seam.cutout")
    if installed is not None:
        return installed
    package = sys.modules.get("seam")
    if package is None:
        package = types.ModuleType("seam")
        package.__path__ = []
        sys.modules["seam"] = package
    for name in VENDORED:
        _install(name, vendored[name], package)
    return sys.modules["seam.cutout"]


def _number(value, fallback: float) -> float:
    """A request number, defaulting on absent **and** on an explicit `undefined`.

    `dict.get(key, default)` only answers the first: an optional TypeScript property that is
    spread rather than omitted arrives as `None`, and `float(None)` raises. The app does that
    routinely, so the plain `.get` form was a crash waiting on an ordinary caller.
    """
    return fallback if value is None else float(value)


def coda_cutout_summary(request, report=None):
    """One box of segmentation summarised per root.

    `inv` is the box's voxels as indices into `uniq`, x fastest — `LabelBox.index` and
    `LabelBox.labels` exactly as `readLabelBox` returns them. `roots` is the root of each entry
    of `uniq`, in the same order, `0` where the supervoxel belongs to no object.

    Returns one flat array per column, plus `rows`. **`None` where the query root is not in the
    box at all**, which the vendored function answers for itself and is not an error: a tip whose
    neuron does not reach its own cutout is a tip somebody should look at, not a failed read.
    """
    started = time.perf_counter()
    cutout = _seam(dict(__vendored__))  # noqa: F821 -- seeded by runtime.ts, see the header
    # The request crosses as a `JsProxy` of a plain object, which has neither `__getitem__` nor
    # `.get` — so subscripting one raises rather than reading the key. Every other entry point on
    # this bridge converts first for the same reason. Unconditional, not `hasattr`-guarded: a
    # hedge would let a caller hand over a real dict, which is a shape the app never sends, and
    # that is exactly how this shipped unable to read its own request.
    req = request.to_py()

    size = np.asarray(req["size"], dtype=np.int64)
    # The scalars first, so the box's own entry is the last reference to 19 MB.
    point = req.get("pointNm")
    has_point = point is not None and len(point) > 0

    # The box, in one copy rather than two. It arrives `uint32`, so asking for `int32` here
    # would be a full 19 MB copy before the transpose makes a second one; `ascontiguousarray`
    # takes the dtype, so the cast rides on the copy that has to happen anyway. That matters
    # less for the pass than for the allocation, in a heap that is never given back.
    #
    # **`int32`, not `uint32`, and it has to stay that way.** Pyodide is wasm32, so `np.intp` is
    # four bytes and `np.bincount` casts its input to `intp` under numpy's `safe` rule, which a
    # `uint32` index does not satisfy. The vendored code bincounts this array, so a reader
    # "simplifying" the cast away finds out in a browser.
    #
    # `transpose(2, 1, 0)` is the layout crossing: `readLabelBox` writes x fastest, which numpy
    # reads as the *last* axis, while the vendored code indexes `inv.shape` as (x, y, z)
    # throughout. A transposed cutout summarises happily and puts every contact point elsewhere.
    inv = np.asarray(req["index"], dtype=np.uint32).reshape(tuple(size[::-1]))
    inv = np.ascontiguousarray(inv.transpose(2, 1, 0), dtype=np.int32)
    uniq = np.asarray(req["labels"], dtype=np.uint64)
    roots = np.asarray(req["roots"], dtype=np.uint64)
    res = np.asarray(req["resolutionNm"], dtype=np.float64)
    lo = np.asarray(req["loVoxels"], dtype=np.int64)
    # The box is in `inv` now, and the EDT below peaks around 180 MB. Dropping the request's own
    # reference takes 19 MB off that high-water mark in a heap that never shrinks.
    req["index"] = None
    query = int(req["queryRoot"])
    if query == 0:
        # **Refused, because the answer would look fine.** `0` is the sentinel for "no object" in
        # `roots`, so a zero query makes `q` the background voxels and every `min_dist_um` a
        # distance to empty space — a full table of plausible candidates measured from nothing.
        # A zero reaches here from an unmapped supervoxel or a root lookup that soft-failed, so
        # it is a real input rather than a typo.
        raise ValueError(
            "cutout summary: the query root is 0, which is the id for 'no object' — "
            "the box has no neuron to measure to"
        )
    if report is not None:
        report(0.1, "measuring the box")
    frame = cutout.summarize_cutout(
        uniq,
        inv,
        roots,
        query,
        res,
        lo,
        # **Required, not an option.** The ranker's eighth feature, `ahead`, is the cosine
        # between the query's outward direction at the end and the direction to a candidate's
        # centroid — so it reads `centroid_*_nm` on both rows (`candidates.py`'s `features`).
        # This was briefly a request field nothing could set, which prices an 80 ms pass as free.
        centroids=True,
        point_nm=np.asarray(point, dtype=np.float64) if has_point else None,
        touch_um=_number(req.get("touchUm"), 0.5),
        moments_um=_number(req.get("momentsUm"), 3.0),
    )
    if frame is None:
        # Empty columns rather than absent ones, so the wrapper has one exit and no branch that
        # restates the result's shape.
        if report is not None:
            report(1.0)
        return {
            "rows": 0,
            "missingQuery": True,
            "root": np.zeros(0, dtype=np.uint64),
            "rep_svid": np.zeros(0, dtype=np.uint64),
            "ms": int((time.perf_counter() - started) * 1000),
        }

    out = {"rows": int(len(frame)), "missingQuery": False}
    for name in frame.columns:
        column = frame[name].to_numpy()
        # Root and supervoxel ids stay 64-bit and unsigned: an 18-digit id through a float64 is a
        # different object, which is the one error in this file that could not be seen.
        if name in ("root", "rep_svid"):
            out[name] = np.ascontiguousarray(column, dtype=np.uint64)
        else:
            out[name] = np.ascontiguousarray(column, dtype=np.float64)
    out["ms"] = int((time.perf_counter() - started) * 1000)
    if report is not None:
        report(1.0)
    return out
