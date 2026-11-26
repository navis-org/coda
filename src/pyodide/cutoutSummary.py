"""SEAM's candidate search, and the cutout summary underneath it.

Three entry points over one set of vendored code. `coda_candidate_pool` is the one a caller
wants — an open end in, the pool of candidates out with its features measured, stage 4 and the
measuring half of stage 5. `coda_pool_sizes` is the short second call that adds `l2c` and `l2x`
once the caller has fetched the level-2 chunk counts those two read, which only it can do; the
ranking itself is `packs/seam/treeRanker.ts`, and `coda_candidate_pool`'s own docstring says why
it is no longer here. `coda_cutout_summary` is the lower-level question the pool is built on
("what objects are in this box"), kept because `pnpm probe:cutout-summary` is what compares the
vendored code under CPython against the same code under wasm, and what checks the axis-order
crossing both share.

The capability on the bridge whose working code Coda did not write, in its second form:
`seam/cutout.py` and `seam/candidates.py` are runs taken out of SEAM's `negatives.py` and
`candidates.py` **without editing a character**, which `scripts/vendor-seam.mjs` re-cuts
and byte-compares.
SEAM's invariant 11 keeps that code numpy-only precisely so the same text can run in CPython for
the fit and here for the search; four of the geometric ranker's eight features come out of the
moments pass alone, and a feature computed slightly differently still *ranks*, which is the
failure a port would produce and nothing downstream could see.

## What this file is for

The vendored code wants `(uniq, inv, roots_u, res, lo)` — a cutout already factored into
distinct supervoxels, an index per voxel, and the root each supervoxel belongs to. Coda's
`precomputed/volume.ts` produces exactly the first two from a real store and `cavePostBinary`
the third, so what this file adds is the marshalling: flat arrays in, one flat array per column
out. **Nothing here computes a feature or a score** — those are the vendored files, because a
feature computed slightly differently still ranks.

**It does not fetch.** The cutout and the root lookup are the caller's, because one is a public
bucket read and the other is an authenticated chunkedgraph call at a timestamp, and neither
belongs on this side of the worker.

## What it costs

Measured in Pyodide on a 188x188x134 box (the real Aedes cutout) holding 14,424 supervoxels over
900 roots: **about 560 ms warm** for both the summary and the pool, of which scipy's exact EDT is
~190 ms (against 166 ms for the same call in CPython). `coda_pool_sizes` is 0.7 ms, four fifths of
it inside the vendored `size_features`, and does not register against those.

A first call in a fresh worker is roughly four times that, because `started` is taken before the
vendored modules are `exec`'d and before `summarize_cutout`'s own `from scipy import ndimage` —
so both first imports sit inside the measured `ms`. Paid **once per worker, not per open end**,
which is also what a caller should do about it: keep one worker across a neuron's ends.

The EDT is also where the memory goes: `return_indices=True` returns a float64 distance and three
int32 index planes, 95 MB for a box this size, and the vendored code's own ravel adds 38 MB — so
one call peaks near 180 MB in a heap that is never given back.
"""

import sys
import time
import types

import numpy as np


#: The vendored modules, installed under these names so their own imports work.
VENDORED = ("seam.cutout", "seam.candidates", "seam.enclosure")


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
    """The vendored `seam` package, installed once per worker."""
    if sys.modules.get("seam.candidates") is not None:
        return sys.modules
    package = sys.modules.get("seam")
    if package is None:
        package = types.ModuleType("seam")
        package.__path__ = []
        sys.modules["seam"] = package
    for name in VENDORED:
        _install(name, vendored[name], package)
    return sys.modules


def _box(req):
    """The request's box, as the vendored code wants it, and the query root it is measured to.

    One statement of the layout crossing, because it was two and the copy lost two rules — the
    memory drop below, and every comment that makes the cast and the transpose load-bearing. The
    entry points differ in what they ask `summarize_cutout` for, not in how the box gets there.

    **`int32`, not `uint32`, and it has to stay that way.** Pyodide is wasm32, so `np.intp` is
    four bytes and `np.bincount` casts its input to `intp` under numpy's `safe` rule, which a
    `uint32` index does not satisfy. The vendored code bincounts this array, so a reader
    "simplifying" the cast away finds out in a browser.

    **`transpose(2, 1, 0)` is the layout crossing.** `readLabelBox` writes x fastest, which numpy
    reads as the *last* axis, while the vendored code indexes `inv.shape` as (x, y, z)
    throughout. A transposed cutout summarises perfectly happily and puts every contact point
    somewhere else.

    It arrives as narrow as the box's own label table allowed -- `uint16` for a real cutout,
    `uint32` only above 65,536 supervoxels -- so asking for `int32` on the way *in* would widen
    it before the transpose made its own copy. `ascontiguousarray` takes the dtype, so the cast
    rides on the copy that has to happen anyway and the arriving array is never widened in
    place. **No dtype on the `asarray`**, for the same reason: naming one there undoes the
    narrowing `readLabelBox` did.
    """
    size = np.asarray(req["size"], dtype=np.int64)
    inv = np.asarray(req["index"]).reshape(tuple(size[::-1]))
    # **The one check on the crossing**, and it is the same line `assessorPatches.py` carries.
    # A table too big for the width it arrived in has already wrapped every index past that
    # width onto a different supervoxel, which summarises into a full table of plausible rows
    # about the wrong objects.
    if inv.dtype.kind in "ui" and len(req["labels"]) > int(np.iinfo(inv.dtype).max) + 1:
        raise ValueError(
            f"cutout: {len(req['labels'])} supervoxels cannot be named by a {inv.dtype} index, "
            f"which holds {int(np.iinfo(inv.dtype).max) + 1}"
        )
    inv = np.ascontiguousarray(inv.transpose(2, 1, 0), dtype=np.int32)
    # The box is in `inv` now, and the EDT below peaks near 180 MB. Dropping the request's own
    # reference takes the arriving copy off that high-water mark in a heap that never shrinks --
    # 9.5 MB where the box came narrow, 19 where it did not. Here rather than in each caller,
    # because the caller that was copied from this one forgot it.
    req["index"] = None

    query = int(req["queryRoot"])
    if query == 0:
        # **Refused, because the answer would look fine.** `0` is the sentinel for "no object" in
        # `roots`, so a zero query makes `q` the background voxels and every `min_dist_um` a
        # distance to empty space — a full table of plausible candidates measured from nothing.
        # A zero reaches here from an unmapped supervoxel or a root lookup that soft-failed, so
        # it is a real input rather than a typo.
        raise ValueError(
            "cutout: the query root is 0, which is the id for 'no object' — the box has no "
            "neuron to measure to"
        )
    return inv, query


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
    cutout = _seam(dict(__vendored__))["seam.cutout"]  # noqa: F821 -- seeded by runtime.ts
    # The request crosses as a `JsProxy` of a plain object, which has neither `__getitem__` nor
    # `.get` — so subscripting one raises rather than reading the key. Every other entry point on
    # this bridge converts first for the same reason. Unconditional, not `hasattr`-guarded: a
    # hedge would let a caller hand over a real dict, which is a shape the app never sends, and
    # that is exactly how this shipped unable to read its own request.
    req = request.to_py()

    # The scalars first, so the box's own entry is the last reference to 19 MB.
    point = req.get("pointNm")
    has_point = point is not None and len(point) > 0
    inv, query = _box(req)
    uniq = np.asarray(req["labels"], dtype=np.uint64)
    roots = np.asarray(req["roots"], dtype=np.uint64)
    res = np.asarray(req["resolutionNm"], dtype=np.float64)
    lo = np.asarray(req["loVoxels"], dtype=np.int64)

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


def coda_candidate_pool(request, report=None):
    """One open end's candidates, unranked — stage 4 and the measuring half of stage 5.

    The box in, the **whole** pool out with every feature `pool_features` computes on it. Two
    vendored steps with nothing of Coda's between them: `summarize_cutout` says what objects are
    in the box and where each touches the query, and `pool_features` turns that into the eight
    geometric features the ranker reads, plus `end_dist_um`, which is a ninth.

    **Why the ranking left this file** (2026-11-14). It used to be here, and the pool crossed
    already sorted, cut to `top_k` and numbered — one call, because each step's output was the
    next one's input and none was useful alone. SEAM replaced the logistic fit with a LightGBM
    forest on eleven features, and two of the eleven are `l2c` and `l2x`: log counts of how many
    level-2 chunks the candidate and the query hold. Those counts come from an authenticated
    chunkedgraph call, and **the roots to ask about are not known until `pool_features` has
    run**. No ordering of this file's work gets them before the pool exists, so the pool has to
    cross unranked whatever else is decided. The scoring followed it over, into
    `packs/seam/treeRanker.ts`.

    So a search is now three parts: this call, a batched `l2ChunkCounts` read, then
    `coda_pool_sizes` for the two size columns and the forest in TypeScript. The cost of the
    extra crossings is a frame of a few hundred rows and two columns; the alternative is a model
    format and a tree walk inside the worker, which is the ask recorded for SEAM.

    `None` where the query root has no voxel in its own box, which `summarize_cutout` answers for
    itself — a tip whose neuron does not reach its own cutout is one to look at, not a failure.
    """
    started = time.perf_counter()
    seam = _seam(dict(__vendored__))  # noqa: F821 -- seeded by runtime.ts, see the header
    cutout, candidates = seam["seam.cutout"], seam["seam.candidates"]
    req = request.to_py()

    end_nm = np.asarray(req["endNm"], dtype=np.float64)
    inv, query = _box(req)
    # Once, for the summary and for the enclosure measure below.
    roots = np.asarray(req["roots"], dtype=np.uint64)

    if report is not None:
        report(0.1, "measuring the box")
    # **`summary_args` rather than this file's own options.** SEAM states that contract in one
    # place precisely so a caller cannot ask for a cutout summary the features were not fitted
    # against — `touch_um` and `moments_um` are part of what the ranker means.
    frame = cutout.summarize_cutout(
        np.asarray(req["labels"], dtype=np.uint64),
        inv,
        roots,
        query,
        np.asarray(req["resolutionNm"], dtype=np.float64),
        np.asarray(req["loVoxels"], dtype=np.int64),
        **candidates.summary_args(end_nm),
    )
    if frame is None:
        if report is not None:
            report(1.0)
        return {
            "rows": 0,
            "missingQuery": True,
            "candRoot": np.zeros(0, dtype=np.uint64),
            "rep_svid": np.zeros(0, dtype=np.uint64),
            "ms": int((time.perf_counter() - started) * 1000),
        }

    if report is not None:
        report(0.7, "measuring the pool")
    pool = candidates.pool_features(frame, query, end_nm)

    # **The pool's roots go out now, before the organelle measure**: the level-2 counts need
    # exactly these and nothing below, and the measure is a third of this call (2026-11-18). A
    # dict, the third argument the bridge's `report` takes, converted as the result is
    # (`runtime.ts`) — and the very array `candRoot` is at the end, not a second spelling of it.
    cand_root = np.ascontiguousarray(pool["root"].to_numpy(), dtype=np.uint64)
    if report is not None:
        report(0.85, "measuring how enclosed each piece is", {"candRoot": cand_root})

    # **The organelle flag's measure, on the box already in hand** — SEAM's `seam/enclosure.py`,
    # vendored whole, which reads exactly what is here: `inv` and each supervoxel's root. It costs
    # no request, which is why SEAM put it on the search's cutout. `enclosed`, the candidate's own
    # share of faces towards its largest neighbour, is the column SEAM publishes as
    # `organelle_score` (`ORGANELLE_COLUMN` in its `tip_pipeline.py`); the group measure beside
    # it was tried and not adopted, and is left unread. Every object in the box is measured and
    # the pool's looked up by root, as Python ints both sides: `enclosure`'s own `roots=` filter
    # compares with `isin` against `int64`, and `uint64` against `int64` goes through a float,
    # which rounds an 18-digit id onto its neighbours.
    enclosure = seam["seam.enclosure"]
    enclosed = enclosure.enclosure(inv, roots)
    by_root = dict(zip(enclosed["root"].tolist(), enclosed["enclosed"].tolist()))
    pool = pool.assign(
        enclosed=[by_root.get(int(root), np.nan) for root in pool["root"].tolist()]
    )

    # Every column `pool_features` produced, by its own name — a pass-through rather than a
    # list of the ones this file happens to know about. That is what `cutoutSummary.ts`' header
    # argues for and what the summary above already does: naming a subset here would be a second
    # list to keep in step with a file that is vendored precisely so it cannot drift, and a
    # feature SEAM adds would arrive in the frame and silently never cross.
    out = {
        "rows": int(len(pool)),
        "missingQuery": False,
        "ms": int((time.perf_counter() - started) * 1000),
    }
    for name in pool.columns:
        column = pool[name].to_numpy()
        # The ids stay 64-bit and unsigned: an 18-digit id through a float64 is a different
        # object, which is the one error here that could not be seen. `root` is renamed on the
        # way out because the wrapper calls it `candRoot` — the candidate, not the query.
        if name == "root":
            out["candRoot"] = cand_root
        elif name == "rep_svid":
            out[name] = np.ascontiguousarray(column, dtype=np.uint64)
        elif column.dtype.kind in "fiub":
            out[name] = np.ascontiguousarray(column, dtype=np.float64)
    if report is not None:
        report(1.0)
    return out


def coda_pool_sizes(request, report=None):
    """`l2c` and `l2x` for a pool whose level-2 chunk counts have been fetched.

    The second crossing of a candidate search, and it exists because `candidates.size_features`
    is a vendored feature and must stay one. The arithmetic is two expressions, and writing them
    in TypeScript is exactly the drift SEAM's invariant 11 is for: dropping the `clip(min=1)`, or
    the `/5`, or reading `log` for `log10` still ranks, and nothing downstream can see that it
    ranks differently. So the counts come back here and the vendored function does the work.

    **The counts arrive by position, not by id**, as `candCount` alongside `candRoot` with the
    query's own as a scalar: TypeScript already holds them in the pool's order, so keying them
    only made this side re-join what had just been taken apart. The dict and the frame are now
    built from one array, so nothing here can pair a count with the wrong root.

    The gap that *can* still happen — the chunkedgraph answering short — is refused one layer up,
    by `countsInPoolOrder` in `packs/seam/searchRun.ts`, where the absent root still has a name.
    (`size_features` keeps its own `pd.Series(l2_chunks)` over python int keys, so a root at or
    above 2**63 would be indexed as a negative one and find nothing — but that surfaces as its
    own `ValueError`, loudly, rather than as a wrong count.)
    """
    seam = _seam(dict(__vendored__))  # noqa: F821 -- seeded by runtime.ts, see the header
    candidates = seam["seam.candidates"]
    # Imported here, not at module scope: `coda_cutout_summary` has no use for pandas, and the
    # vendored modules pull it in for themselves when they are installed.
    import pandas as pd

    req = request.to_py()
    roots = np.asarray(req["candRoot"], dtype=np.uint64)
    counts = np.asarray(req["candCount"], dtype=np.float64)
    query = np.uint64(int(req["queryRoot"]))
    if len(counts) != len(roots):
        raise ValueError(f"{len(roots)} candidates and {len(counts)} counts")

    frame = pd.DataFrame(
        {"root": roots, "q_root": np.full(len(roots), query, dtype=np.uint64)}
    )
    # One dict from the same arrays the frame is built from. The query root is its own entry:
    # `size_features` looks both columns up in the one mapping.
    l2_chunks = dict(zip(roots.tolist(), counts.tolist()))
    l2_chunks[int(query)] = float(req["queryCount"])
    sized = candidates.size_features(frame, l2_chunks)
    if report is not None:
        report(1.0)
    return {
        "l2c": np.ascontiguousarray(sized["l2c"].to_numpy(), dtype=np.float64),
        "l2x": np.ascontiguousarray(sized["l2x"].to_numpy(), dtype=np.float64),
    }
