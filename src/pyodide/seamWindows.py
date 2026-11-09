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
resample of the faces in 27 grid cells. `limit` exists because that is a real per-neuron cost and
the node, not this file, knows what the reader asked for.

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
    vertices = np.frombuffer(req["positions"], dtype=np.float32).reshape(-1, 3).astype(np.float64)
    faces = np.frombuffer(req["indices"], dtype=np.uint32).reshape(-1, 3).astype(np.int64)
    radius_um = float(req["radiusUm"])
    spacing_um = float(req["spacingUm"])
    n_points = int(req["nPoints"])
    use_normals = bool(req["useNormals"])
    seed = int(req["seed"])
    limit = int(req["limit"])
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
    sequence = scan.Scan(vertices, faces, radius_um, spacing_um, n_points, use_normals, seed)
    tile_ms = (time.perf_counter() - t0) * 1000
    tiled = len(sequence)
    wanted = min(tiled, limit) if limit > 0 else tiled

    # The grid the tiling is laid on: one centre per occupied cell, so a *cell* is a window and
    # cells do not overlap even though the 15 um windows they centre do. A surface point is in
    # exactly one cell, which is what lets a label be assigned without resolving the overlap.
    cell_um = radius_um * scan.TILE_FRACTION
    points, feats, source, own = [], [], [], []
    centres = []
    empty = 0
    t1 = time.perf_counter()
    for i in range(wanted):
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
        points.append(np.asarray(window_points, dtype=np.float32).ravel())
        feats.append(np.asarray(window_feats, dtype=np.float32).ravel())
        source.append(drawn_nm.astype(np.float32).ravel())
        own.append(in_cell.astype(np.uint8))
        centres.append(centre.astype(np.float32))
        # `% 8 == 7 or the last`, which is the stride `skeletons.py`, `nblast.py` and
        # `skeletonize.py` all use. `% 8 == 0` reports windows 1, 9, 17 ... and never the last,
        # so the bar stops short of the count it is counting towards.
        if report is not None and (i % 8 == 7 or i == wanted - 1):
            report(0.05 + 0.9 * (i + 1) / wanted, f"window {i + 1} of {wanted}")

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
        # uint8 rather than bool: `types.ts` carries typed arrays, and a Python bool array
        # crosses as something the wrapper would have to unpack element by element.
        "inOwnCell": (
            np.concatenate(own) if own else np.zeros(0, np.uint8)
        ).astype(np.uint8),
        "cellUm": cell_um,
        "windows": built,
        "tiled": tiled,
        "empty": empty,
        "drawEvery": draw_every,
        "drawnPerWindow": len(range(0, n_points, draw_every)),
        "tileMs": round(tile_ms),
        "windowMs": round(window_ms),
    }
