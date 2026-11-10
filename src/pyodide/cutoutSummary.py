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
900 roots: the EDT and the per-root reduction 314 ms, the `point_dist` pass another 131 ms, and
the moments and centroids another 762 ms — about **1.2 s** for everything the ranker reads.
scipy's exact EDT is 190 ms of that, against 166 ms for the same call in CPython.

The EDT is also where the memory goes: `return_indices=True` returns a float64 distance and three
int32 index planes, 95 MB for a box this size, live for the length of the call.
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

    size = np.asarray(request["size"], dtype=np.int64)
    inv = np.asarray(request["index"], dtype=np.int32).reshape(tuple(size[::-1]))
    # `readLabelBox` writes x fastest, which numpy reads as the **last** axis. The vendored code
    # indexes `inv.shape` as (x, y, z) throughout — `cv` out of `np.unravel_index`, the per-slice
    # loops, `_local_moments` — so the box is transposed into that order here rather than left
    # for the vendored side to be wrong about. A transposed cutout summarises perfectly happily
    # and puts every contact point somewhere else.
    inv = np.ascontiguousarray(inv.transpose(2, 1, 0))
    uniq = np.asarray(request["labels"], dtype=np.uint64)
    roots = np.asarray(request["roots"], dtype=np.uint64)
    res = np.asarray(request["resolutionNm"], dtype=np.float64)
    lo = np.asarray(request["loVoxels"], dtype=np.int64)

    if report:
        report(0.1, "measuring the box")
    point = request.get("pointNm")
    frame = cutout.summarize_cutout(
        uniq,
        inv,
        roots,
        int(request["queryRoot"]),
        res,
        lo,
        centroids=bool(request.get("centroids", True)),
        **(
            {}
            if point is None or len(point) == 0
            else {
                "point_nm": np.asarray(point, dtype=np.float64),
                "touch_um": float(request.get("touchUm", 0.5)),
                "moments_um": float(request.get("momentsUm", 3.0)),
            }
        ),
    )
    if frame is None:
        return {"rows": 0, "missingQuery": True, "ms": int((time.perf_counter() - started) * 1000)}

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
    if report:
        report(1.0)
    return out
