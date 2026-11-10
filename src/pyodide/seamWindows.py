"""A neuron's mesh cut into the windows a SEAM model takes.

The sixth capability on the bridge, and the only one whose working code Coda did not write:
`seam/canonical.py` and `seam/scan.py` are **byte-identical copies** of SEAM's own files (see
`seam/VENDORED.md`). SEAM's invariant 3 is that training and inference build the model's input
through one function, and its invariant 11 keeps that function numpy-only so the same file runs
in CPython for training and here for inference. A TypeScript port would be the drift those rules
exist to prevent, and nothing downstream could see it: a window built slightly differently still
scores plausibly.

## Why the sources arrive as text

`scan.py` does `from . import canonical`, so the two have to be a package. The bridge executes
one source per module in its own namespace with no import machinery, so this file assembles the
package in `sys.modules` from `__vendored__`, which `runtime.ts` seeds into this module's globals
beside `__name__`. They are a property of the module rather than of a call, which also keeps the
Python text in the worker chunk — a `?raw` import in the main-thread wrapper would put it in the
app bundle. Installed once: a second call finds `seam.scan` already there.

## What a window costs, and why the caller says how many

A neuron is tiled at `TILE_FRACTION` of the window radius — 8 µm for a 15 µm window — so a
largish arbour is on the order of a hundred windows, each of which is an area-uniform surface
resample of the faces in 27 grid cells. `only` and `limit` exist because that is a real
per-neuron cost and the node, not this file, knows which windows the reader's question needs.

Everything crosses as one flat array per quantity, which is `meshes.py`'s shape: a window is
4,096 points of xyz plus 4,096 normals, so a hundred of them is ~20 MB and a list of arrays
would be a hundred proxies to destroy.
"""

import sys
import time
import types

import numpy as np


#: Installed in this order: `scan` does `from . import canonical`, which resolves through the
#: attribute the install below sets rather than through the filesystem.
VENDORED = ("seam.canonical", "seam.scan")


#: The one `Scan` kept between calls, as `{"key": (meshKey, args), "scan": Scan}`.
#:
#: **One, not a dictionary of them.** A `Scan` holds the mesh as float64 — a 3.7 M-face neuron is
#: about 134 MB of vertices and faces — in a wasm heap that never gives memory back, so a second
#: one is not a cache, it is a leak with a lookup. A node scores the tips of one neuron at a time,
#: which is exactly what this serves.
#:
#: It exists because the tiling is paid in the *constructor*: the face grid and the seeded surface
#: draw. Measured on `648518347558097460` (`probe:seam-e-cells`): scoring one tip's dozen windows
#: took 5.4 s, of which 4.9 s was re-tiling a mesh that had not changed, and the whole neuron took
#: 126 s of which 69 s was fourteen re-tilings — against 3.5 s of actual inference.
#:
#: Keyed by a name the **caller** gives, never by hashing the mesh: the caller knows which neuron
#: at which resolution it is holding, and a checksum over 20 MB per call would spend a good part
#: of what this saves. A key that does not match rebuilds, which is the safe direction.
_SCAN = {}


def _install(name: str, source: str, parent):
    """One vendored file as a real module, without touching its text."""
    module = types.ModuleType(name)
    module.__package__ = name.rpartition(".")[0]
    sys.modules[name] = module
    try:
        exec(compile(source, f"{name.replace('.', '/')}.py", "exec"), module.__dict__)
    except BaseException:
        # Out of `sys.modules` before re-raising. The import system leaves a half-built module
        # there on purpose (circular imports need it), but here it would be *cached*: the memo
        # below only asks whether the key exists, and `runtime.ts` caches the namespace so this
        # file never runs again either. Every later call would then fail with "module seam.scan
        # has no attribute Scan", which points nowhere near a syntax error in a vendored file.
        del sys.modules[name]
        raise
    # `from . import canonical` reads the attribute before it tries to import a file, and this
    # package has no files to find -- its `__path__` is empty on purpose.
    setattr(parent, name.rpartition(".")[2], module)
    return module


def _seam(sources: dict):
    installed = sys.modules.get("seam.scan")
    if installed is not None and hasattr(installed, "Scan"):
        return installed
    package = types.ModuleType("seam")
    package.__path__ = []
    sys.modules["seam"] = package
    for name in VENDORED:
        module = _install(name, sources[name], package)
    return module


def coda_seam_windows(request, report=None):
    """Tile one mesh and build every window's model input.

    `request` carries the mesh (`positions` nm, `indices`) and the model's own constants, which
    come from the manifest rather than from here: a window built at the wrong radius or scale is
    a confident answer to a question the checkpoint was never asked.
    """
    scan = _seam(dict(__vendored__))  # noqa: F821 -- seeded by runtime.ts, see the header
    # `to_py()` first, as every other module here does: the request crosses as a JsProxy and
    # subscripting one raises rather than reading the key.
    req = request.to_py()
    # Refused, not assumed. `scan.py` multiplies the radius by 1000 to reach nanometres, so a
    # voxel-space mesh tiles at a wrong physical scale and returns a plausible window count,
    # plausible windows and a plausible timing -- the same silent-wrong-answer shape the header
    # names for the radius, applied to the geometry instead.
    if req["units"] != "nm":
        raise ValueError(f"the mesh is in {req['units']}; SEAM windows are built in nanometres")

    # `frombuffer` on the typed arrays, `meshes.py`'s arrangement: the mesh is the large thing
    # crossing and a copy of it per call is the one cost worth not paying twice.
    # Both may be empty, which is how a caller says "use the tiling you already have" — see
    # `_SCAN`. The `.astype` copies, so an empty one costs nothing.
    vertices = np.frombuffer(req["positions"], dtype=np.float32).reshape(-1, 3).astype(np.float64)
    faces = np.frombuffer(req["indices"], dtype=np.uint32).reshape(-1, 3).astype(np.int64)
    radius_um = float(req["radiusUm"])
    spacing_um = float(req["spacingUm"])
    n_points = int(req["nPoints"])
    use_normals = bool(req["useNormals"])
    seed = int(req["seed"])
    # Which of a window's points come back for *drawing*. The model sees all `n_points` of them
    # -- that is what `points`/`feats` carry -- but a neuron's worth of them at full density is
    # 27 MB of coordinates nobody looks at individually. A stride rather than a count, so the
    # caller can apply the same one to the per-point logits and get a matching pair without this
    # file having to return an index array.
    draw_every = max(1, int(req["drawEvery"]))

    # Timed in three parts, because they scale with different things and a single total hides
    # that: the grid and the tiling are paid once per *mesh* (and grow with its faces), the rest
    # is per *window*. A neuron with few windows and a big mesh and one with the opposite would
    # otherwise report wildly different "ms per window" for the same code.
    if report is not None:
        report(0.05, "tiling the surface")
    t0 = time.perf_counter()
    # The window constants are part of the key: the same mesh tiled at another radius is another
    # tiling, and serving the old one would answer a question the caller did not ask.
    args = (radius_um, spacing_um, n_points, use_normals, seed)
    key = str(req.get("meshKey") or "")
    cached = bool(key) and _SCAN.get("key") == (key, args)
    if cached:
        sequence = _SCAN["scan"]
    else:
        if not len(vertices) or not len(faces):
            # The caller asked for a cached tiling that is not here and sent no mesh to build one
            # from. Said rather than guessed at: the alternative is an empty answer for a neuron
            # that has plenty of surface, which reads as a neuron with no windows.
            raise ValueError(
                f"no tiling cached for {key!r} and no mesh to build one from — send the mesh "
                "with the first call for a key"
            )
        sequence = scan.Scan(vertices, faces, *args)
        if key:
            # Replaced, not added to. See `_SCAN`.
            _SCAN.clear()
            _SCAN.update(key=(key, args), scan=sequence)
    tile_ms = (time.perf_counter() - t0) * 1000
    tiled = len(sequence)

    # Which centres to build, and in which order: the caller's `only`, or the whole tiling where
    # it named none. **One mechanism**, because it is the only one a caller needs — selecting by
    # distance, paging, and asking for the tiling alone are all "these centres, in this order",
    # and each spelled separately was a second place for the geometry to be decided.
    #
    # **A subset is a selection, not a re-sampling.** The centres come from one seeded draw over
    # the whole surface and window `i` is built from its own stream `[seed, i]`, so a window is
    # the same window whether or not its neighbours were asked for, and whatever order they come
    # in. That is what lets a caller sweep a neuron tip by tip, and what makes a tip's answer over
    # the centres within reach of it the whole neuron's answer for that tip.
    order = np.arange(tiled, dtype=np.int64)
    named = req.get("only")
    if named is not None:
        # **Named none is not named nothing.** An empty `only` is a caller asking for the tiling
        # and no windows, which is the first call a streaming caller makes; an absent one is a
        # caller asking for everything. Erasing the difference needed a second flag to say which.
        only = np.frombuffer(named, dtype=np.int32)
        if len(only) and (only.min() < 0 or only.max() >= tiled):
            raise ValueError(
                f"a centre index outside this tiling's 0..{tiled - 1} was asked for"
            )
        order = only.astype(np.int64)
    selected = len(order)
    # A cap, which is a different thing from a selection: `Find Merges` offers a reader a
    # `Max windows` rail and cannot name the centres it wants, not knowing the tiling until the
    # call returns. `0` or less takes everything `only` named.
    limit = int(req.get("limit") or 0)
    wanted = min(selected, limit) if limit > 0 else selected

    # The grid the tiling is laid on: one centre per occupied cell, so a *cell* is a window and
    # cells do not overlap even though the 15 um windows they centre do. A surface point is in
    # exactly one cell, which is what lets a label be assigned without resolving the overlap.
    cell_um = radius_um * scan.TILE_FRACTION
    points, feats, source, own = [], [], [], []
    centres = []
    index = []
    empty = 0
    t1 = time.perf_counter()
    for at, i in enumerate(order[:wanted]):
        i = int(i)
        built = sequence[i]
        if built is None:
            # A centre whose 27 cells hold no surface after the crop. Counted rather than
            # dropped silently: it is the one thing that makes the window count disagree with
            # the tiling, and a reader comparing the two needs the difference explained.
            empty += 1
            continue
        window_points, window_feats, window_nm = built
        centre = np.asarray(sequence.centres[i], dtype=np.float64)
        drawn_nm = np.asarray(window_nm, dtype=np.float64)[::draw_every]
        # Which of the drawn points belong to *this* window's own cell. A window's crop is a
        # 15 um sphere, so most of its points sit in a neighbour's cell and are that window's
        # context rather than its subject; taking them all would give one surface point a label
        # from every window that can see it.
        in_cell = np.all(
            np.floor(drawn_nm / (cell_um * 1000.0)) == np.floor(centre / (cell_um * 1000.0)),
            axis=1,
        )
        index.append(i)
        points.append(np.asarray(window_points, dtype=np.float32).ravel())
        feats.append(np.asarray(window_feats, dtype=np.float32).ravel())
        source.append(drawn_nm.astype(np.float32).ravel())
        own.append(in_cell.astype(np.uint8))
        centres.append(centre.astype(np.float32))
        # `% 8 == 7 or the last`, which is the stride `skeletons.py`, `nblast.py` and
        # `skeletonize.py` all use. `% 8 == 0` reports windows 1, 9, 17 ... and never the last,
        # so the bar stops short of the count it is counting towards.
        if report is not None and (at % 8 == 7 or at == wanted - 1):
            report(0.05 + 0.9 * (at + 1) / wanted, f"window {at + 1} of {wanted}")

    window_ms = (time.perf_counter() - t1) * 1000
    built = len(points)

    def flat(parts):
        # Cast *during* the concatenate, `meshes.py`'s `joined` for the reason it gives: every
        # part is already float32, so a trailing `.astype` would copy the whole thing again --
        # a transient 80 MB on a large neuron, in a wasm heap that never gives memory back.
        return np.concatenate(parts, dtype=np.float32) if parts else np.zeros(0, np.float32)

    if report is not None:
        report(0.99, "packing")
    return {
        "points": flat(points),
        "feats": flat(feats),
        "sourceNm": flat(source),
        "centresNm": flat(centres),
        # Which centre each built window came from, so a caller that selected can say which.
        "windowIndex": np.asarray(index, dtype=np.int32),
        # **The whole tiling's** centres, indexed by centre number, whatever was selected or
        # paged — a few thousand triples, so always, rather than behind a flag nobody would know
        # to set. With `windowIndex` this is what lets a caller say which centres it still owes.
        "tilingCentresNm": np.asarray(sequence.centres, dtype=np.float32).ravel(),
        # uint8 rather than bool: `types.ts` carries typed arrays, and a Python bool array
        # crosses as something the wrapper would have to unpack element by element.
        "inOwnCell": (
            np.concatenate(own) if own else np.zeros(0, np.uint8)
        ).astype(np.uint8),
        "cellUm": cell_um,
        "windows": built,
        "tiled": tiled,
        "selected": selected,
        # Whether this call reused a tiling rather than building one, so a caller that means to
        # be reusing can assert it instead of inferring it from a timing.
        "scanCached": cached,
        "empty": empty,
        "drawEvery": draw_every,
        "drawnPerWindow": len(range(0, n_points, draw_every)),
        "tileMs": round(tile_ms),
        "windowMs": round(window_ms),
    }


def coda_seam_reduce(request, report=None):
    """Per-point scores pooled to the best point in each `cellUm` cell — SEAM's `reduce_max`.

    The second half of `score_neuron`'s reduction, and vendored rather than ported for the
    reason the header gives: it decides which point in a cell *is* the cell, and a cell whose
    position came from a slightly different rule still reads as a plausible open end.

    Reducing is idempotent — the max of maxima per cell is the max — so a caller streaming
    batches reduces each one and reduces the concatenation again, which is exactly what the
    pipeline does and is what keeps a whole neuron's points from having to exist at once.
    """
    scan = _seam(dict(__vendored__))  # noqa: F821 -- seeded by runtime.ts, see the header
    req = request.to_py()
    points = np.frombuffer(req["pointsNm"], dtype=np.float32).reshape(-1, 3)
    scores = np.frombuffer(req["scores"], dtype=np.float32)
    if len(points) != len(scores):
        raise ValueError(f"{len(points)} points against {len(scores)} scores")
    cell_um = float(req["cellUm"])
    pos, logit = scan.reduce_max(points, scores, cell_um)
    return {
        "pointsNm": np.asarray(pos, dtype=np.float32).ravel(),
        "scores": np.asarray(logit, dtype=np.float32),
        "cells": len(pos),
    }


def coda_seam_forget(request=None, report=None):
    """Drop the cached tiling, freeing the mesh it holds.

    For a caller that has finished with a neuron and knows nothing follows soon — the memory is
    the whole reason, since a cached `Scan` is on the order of 134 MB of float64 mesh in a heap
    that never gives it back. Moving to another neuron does not need this: a key that does not
    match replaces the entry.
    """
    had = bool(_SCAN)
    _SCAN.clear()
    return {"dropped": had}
