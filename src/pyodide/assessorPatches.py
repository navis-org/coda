"""The assessor's input patches, cut from a box of supervoxels.

Stage 6 of SEAM's pipeline, the half that happens before any model runs. For each candidate on
an open end's list it cuts the 129³ patch the mask assessor was trained on: labels only, no EM,
`1` where the query neuron is, `2` where that candidate is, `0` elsewhere.

The capability on the bridge whose working code Coda did not write, in its third form.
`seam/patches.py` is a **byte-identical copy** of SEAM's own file — its docstring says so from
the other side ("Coda's browser scorer vendors it whole") — and `scripts/vendor-seam.mjs`
byte-compares it. A patch cut half a voxel over, or on the wrong axis order, still scores: the
network answers a confident number about a window of somewhere else. That is the whole reason
this is a copy and not a port, and it is why `pnpm probe:assessor-patch` compares against SEAM's
own published patches byte for byte rather than against anything computed here.

## What this file adds

Marshalling, and nothing else. The vendored code wants a labelled box — one small integer per
voxel naming which object it belongs to — plus the box's corner and resolution. Coda's
`precomputed/volume.ts` produces the box already factored into distinct supervoxels and an index
per voxel, and `cavePostBinary` says which root each supervoxel belonged to at the snapshot. So
what happens here is: turn roots into `label_box`'s per-object leaf lists, hand it Coda's
factorisation instead of making it compute its own, and hand the patches back.

**Nothing here cuts a patch or decides a label.** Both are `seam.patches`.

**It does not fetch.** The cutout is a public bucket read and the roots are an authenticated
chunkedgraph call at a timestamp; neither belongs on this side of the worker.

## Two calls, because a patch is 2.1 MB

A tip's list is up to a hundred candidates and each patch is 129³ bytes, so answering a whole
list in one call would be 215 MB crossing at once — in a wasm heap that is never given back,
and to feed a graph that takes **one patch per run** anyway (the matmul export pins its batch
axis to 1; see `docs/seam-assessor-speed.md`). So the box is labelled once and held, and
patches are asked for in groups the caller sizes.

`seamWindows.py` holds one `Scan` the same way and for the same reason, with the same rule:
**one, not a dictionary of them.** A second held box is not a cache, it is a leak with a lookup.

## One box for the whole list, and what that rests on

Every patch of a tip is cut from one shared box, which is only correct because `sample` places a
label plane by `label_sections` — a `floor` of the **absolute** position. Until SEAM `dbfef4c`
it rounded a position measured from the box's own corner, so a plane landing exactly on a
section boundary was resolved by that corner's parity: a patch then depended on which *other*
candidates shared its box, because they move the corner. The same candidate would have scored
differently in two lists while Coda's provenance keys (invariant 4) called the two the same
work. [docs/seam-patch-sampling.md](../../docs/seam-patch-sampling.md) is the report, and this
file carried a per-candidate re-cornering until the fix landed.

So **if this ever goes back to a `patches.py` older than `dbfef4c`, one shared box is wrong** —
and wrong silently, in three planes of 129. `VENDORED.md` pins the version.

## The box is dropped as soon as it is labelled

A real 66-candidate tip's box — 172 × 214 × 164 voxels at 32 nm, which `pnpm
probe:assessor-patch --end 1014` reads — is 6.0 M voxels: 24 MB as the `uint32` index that
arrives, 12 MB as the narrowed copy the labelling reads, 6 MB as the `uint8` labels it produces.
Only the last is needed afterwards, and letting the arriving one go takes 24 MB off the
high-water mark of every tip after the first.

(The box is not a cube in voxels: z is 45 nm against 32 in xy, so the same reach in nanometres
is fewer voxels along it.)
"""

import sys
import time
import types

import numpy as np


#: The vendored module, installed under this name so its own imports work.
VENDORED = ("seam.patches",)

#: At most this many candidates in one labelled box.
#:
#: `label_box` writes `uint8` labels and reserves `0` for "no object", so a box holds 255
#: objects — the query and 254 candidates. SEAM's search keeps 100 and the own-tip rule only
#: takes rows away, so a real list never reaches this; the caller groups rather than this file
#: refusing, because a tip that happened to exceed it would otherwise be a tip nothing can score.
MAX_CANDIDATES = 254


def _install(name: str, source: str, parent):
    """Execute one vendored source as a module, the way `cutoutSummary.py` does."""
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
    if sys.modules.get("seam.patches") is not None:
        return sys.modules["seam.patches"]
    package = sys.modules.get("seam")
    if package is None:
        package = types.ModuleType("seam")
        package.__path__ = []
        sys.modules["seam"] = package
    for name in VENDORED:
        _install(name, vendored[name], package)
    return sys.modules["seam.patches"]


#: How many boxes this worker has opened, which is the id of the one it holds.
#:
#: **The bridge holds one box, and nothing in a request said which.** Two overlapping
#: `useAssessorBox` calls — a cancelled tip whose close has not landed, a caller that forgot to
#: await — would have B's open replace A's box and A's next cut would answer from it: patches of
#: the right shape, for the wrong neuron. The wrapper's promise that this is unrepresentable was
#: about leaks only. A counter is enough: `open` returns it, `patches` and `close` refuse any
#: other, and a stale caller is told rather than served.
_OPENED = 0

#: The one labelled box kept between calls, or None.
#:
#: `{"lab", "lo", "res", "centres", "present"}` — the labels, the box's corner and resolution,
#: every candidate's contact point, and which candidates the labelling could answer for.
#:
#: Module state, which `docs/python-pyodide.md` warns about and which is right here for the
#: reason the header gives — the alternative is 215 MB in one message. It is replaced whole by
#: every `coda_assessor_open`, so there is never a second one to pick the wrong one of.
_HELD = None


def _labelled(req, patches):
    """Coda's factorisation as `label_box`'s `renumber` contract, and the leaves per object.

    **The factorisation is handed over, not recomputed.** `label_box`'s default renumbering is
    `np.unique(sv, return_inverse=True)` over every voxel — a sort of 11 million uint64s for an
    answer `readLabelBox` already produced on the way in. SEAM put the hook there for exactly
    this (its own service passes fastremap's); `_renumber`'s contract is
    `(per-voxel index into keys, keys, each key's index)`, which is `index`, `labels`,
    `arange` — Coda's three arrays, unchanged.

    **The leaves come from the box's own roots, so nothing is fetched.** `label_box` wants, per
    object, the supervoxel ids belonging to it. The caller already has the root of every
    supervoxel *in this box* at the snapshot, and a supervoxel outside the box cannot label a
    voxel inside it — so the leaves within the box are exactly what a `get_leaves` call would
    answer, filtered to the box. That is the difference between one chunkedgraph request per tip
    and one per candidate (SEAM's invariant 8: the servers are shared and public).

    **`int32`, not `uint32`, on the wide branch.** Pyodide is wasm32, so `np.intp` is four bytes
    and numpy's `safe` casting rule will not take a `uint32` where an index is wanted.
    `cutoutSummary.py` carries the same cast for the same reason.

    **`transpose(2, 1, 0)` is the layout crossing.** `readLabelBox` writes x fastest, which numpy
    reads as the *last* axis, while `seam.patches` indexes (X, Y, Z) throughout. A transposed box
    labels perfectly happily and cuts every patch from somewhere else.
    """
    labels = np.asarray(req["labels"], dtype=np.uint64)
    # **No dtype here: the width that arrives is the width the box was read at.** `readLabelBox`
    # sends `uint16` wherever its table fits in sixteen bits, which a real box's does, and
    # naming `uint32` would widen it straight back out -- a 24 MB copy to undo a saving, in a
    # heap that is never given back.
    #
    # `[::-1]` because `readLabelBox` writes x fastest, which numpy reads as the last axis.
    index = np.asarray(req["index"]).reshape(tuple(req["size"][::-1]))
    # **The one check on the crossing.** A table too big for the width it arrived in is not a
    # failure anything downstream can see: every index past the width has already wrapped to a
    # different supervoxel, so the patch cuts a plausible neuron that is the wrong one. One
    # comparison, against the rule `VoxelIndex` states on the TypeScript side.
    if index.dtype.kind in "ui" and len(labels) > int(np.iinfo(index.dtype).max) + 1:
        raise ValueError(
            f"assessor patches: {len(labels)} supervoxels cannot be named by a "
            f"{index.dtype} index, which holds {int(np.iinfo(index.dtype).max) + 1}"
        )
    # **As narrow as the label table allows**, because the transpose copies either way. Every
    # entry is an index into `labels` -- a real box holds thousands -- so sixteen bits hold it
    # and halve the copy: 12 MB instead of 24 for the 6 M voxel box measured below, and
    # `label_box`'s `lut[small]` streams half as much for the same lookups. Where the box
    # already arrived narrow this is a no-op on the dtype and only the transpose's copy is paid.
    #
    # **`uint16`, not `int16`: the same bytes and twice the range.** The signedness rule that
    # forces the fallback below is about *32* bits -- Pyodide is wasm32, so `np.intp` is four
    # bytes and numpy's `safe` rule will not take `uint32` where an index is wanted. `uint16`
    # widens to `int32` safely, so it is accepted everywhere `small` is used. Choosing `int16`
    # would push every box of 32,768 to 65,535 supervoxels onto the 32-bit branch and give back
    # the whole saving at a threshold nothing reports.
    # Derived from the dtype, never restated: the check above already asks numpy how many
    # labels a width can name, and a `65536` written here as well could disagree with it
    # inside one function. `<=`, never `<`: a table of exactly 65,536 ends at slot 65,535.
    narrow = np.uint16 if len(labels) <= int(np.iinfo(np.uint16).max) + 1 else np.int32
    index = np.ascontiguousarray(index.transpose(2, 1, 0), dtype=narrow)
    # The box is in `index` now; dropping the request's own reference takes the arriving copy
    # off the peak -- 12 MB for the box measured in the header, 24 before it was sent narrow.
    req["index"] = None

    roots = np.asarray(req["roots"], dtype=np.uint64)
    if len(roots) != len(labels):
        raise ValueError(
            f"{len(labels)} supervoxels and {len(roots)} roots: one root per supervoxel, in order"
        )
    query = np.uint64(req["queryRoot"])
    if query == 0:
        # Refused, because the answer would look fine: `0` is the id for "no object" in `roots`,
        # so a zero query labels background as the neuron and every patch comes back full of it.
        raise ValueError(
            "assessor patches: the query root is 0, which is the id for 'no object' — the box "
            "has no neuron to cut a patch around"
        )
    cands = np.asarray(req["candRoots"], dtype=np.uint64)
    # Refused here, naming the list. `label_box` would refuse too — its "a supervoxel belongs to
    # two roots: the roots overlap" — but that sentence is about the *agglomeration*, and sends
    # a reader to look for a chunkedgraph fault when what happened is that a caller passed the
    # same candidate twice, or passed the query among its own candidates.
    if len(np.unique(cands)) != len(cands):
        raise ValueError(
            "assessor patches: the candidate list repeats a root. Each patch is one candidate, "
            "so a repeat would label the same voxels twice."
        )
    if query in cands:
        raise ValueError(
            f"assessor patches: candidate root {int(query)} is the query neuron itself. "
            "A patch has two sides, and this one would be both."
        )
    if len(cands) > MAX_CANDIDATES:
        raise ValueError(
            f"{len(cands)} candidates in one box, and labels are uint8: at most "
            f"{MAX_CANDIDATES} beside the query. Ask in groups."
        )

    # **Grouped once, not scanned per candidate.** `labels[roots == r]` walks the whole root
    # array and allocates a boolean temporary each time; with a hundred candidates over twenty
    # thousand supervoxels that is a hundred full passes for an answer one sort already has.
    order = np.argsort(roots, kind="stable")
    ordered = roots[order]

    def leaves_of(root):
        first = np.searchsorted(ordered, root, side="left")
        last = np.searchsorted(ordered, root, side="right")
        return labels[order[first:last]]

    leaves = [leaves_of(query)]
    if not len(leaves[0]):
        raise ValueError(
            "assessor patches: the query neuron has no voxel in the box — the box is somewhere "
            "else, or the roots are from another instant"
        )
    # A candidate with no voxel here gets no label and no patch. Counted rather than refused:
    # the patch box is cut around the *contacts*, and a candidate reaching the search's wider
    # box only at its rim is an ordinary thing. `label_box` would raise on an empty object.
    present = []
    absent = []
    for at, root in enumerate(cands):
        mine = leaves_of(root)
        if len(mine):
            present.append(at)
            leaves.append(mine)
        else:
            absent.append(at)

    def renumber(_sv):
        return index, labels, np.arange(len(labels))

    lab = patches.label_box(index, leaves, renumber=renumber)
    return lab, present, absent


def _held(req, what):
    """The held box, if the caller named the one that is open.

    **`box` is required, not merely checked when present.** A call that omits it would otherwise
    be served whatever is open — which is exactly the overlap this id exists to catch, arriving
    through the check: a late close with no box would drop the live tip's labels.
    """
    if _HELD is None:
        raise ValueError("assessor patches: no box is open — call coda_assessor_open first")
    asked = req.get("box")
    if asked is None:
        raise ValueError(
            f"assessor patches: say which box this {what} — `coda_assessor_open` returns its id, "
            "and the bridge holds one box at a time."
        )
    if int(asked) != _HELD["id"]:
        raise ValueError(
            f"assessor patches: this {what} box {int(asked)}, and box {_HELD['id']} is the one "
            "open. Another tip replaced it, so these patches would be the wrong neuron's."
        )
    return _HELD


def coda_assessor_open(request, report=None):
    """Label one box and hold it, saying which candidates it can answer for.

    The box arrives as `readLabelBox` leaves it — distinct supervoxels, one index per voxel, x
    fastest — plus the root of each supervoxel at the snapshot, the query neuron's root, and one
    candidate root per patch wanted. **The arrays are transferred, not copied** (`callPython`'s
    rule), so a caller that means to keep its box must copy first.
    """
    global _HELD, _OPENED
    started = time.monotonic()
    # **Dropped before the next one is built, not after.** Assigning only on success left the
    # previous tip's labels held through a failed re-open, and doubled the peak through a
    # successful one — 6 MB of the old box alive while `label_box` allocates the new. Both are
    # invisible: the first is memory a failed run forgot, the second a high-water mark in a heap
    # that never gives any of it back.
    _HELD = None
    patches = _seam(globals()["__vendored__"])
    # The request crosses as a `JsProxy` of a plain object, which has neither `__getitem__` nor
    # `.get` — so subscripting one raises rather than reading the key. Every entry point on this
    # bridge converts first, and `cutoutSummary.py` records why in one sentence: that is exactly
    # how a module ships unable to read its own request. Unconditional, not `hasattr`-guarded.
    req = request.to_py()
    lab, present, absent = _labelled(req, patches)
    _OPENED += 1
    _HELD = {
        "id": _OPENED,
        "lab": lab,
        "lo": np.asarray(req["loVoxels"], dtype=np.int64),
        "res": np.asarray(req["resolutionNm"], dtype=np.float64),
        "centres": np.asarray(req["centresNm"], dtype=np.float64).reshape(-1, 3),
        # `label_box` numbers objects from 1 in the order they were given, so candidate
        # `present[k]` is object `k + 2` — the query is 1.
        "present": present,
    }
    return {
        # The caller hands this back on every later call, so a box another tip replaced is
        # refused rather than cut from.
        "box": _OPENED,
        "present": np.asarray(present, dtype=np.int32),
        "absent": np.asarray(absent, dtype=np.int32),
        "patchSize": int(patches.PATCH),
        "patchNm": float(patches.PATCH_NM),
        "boxVoxels": int(lab.size),
        "ms": (time.monotonic() - started) * 1000,
    }


def coda_assessor_patches(request, report=None):
    """Cut `count` patches from the held box, starting at `from` of the *present* candidates.

    Returns them packed end to end as one `uint8` array — `count` × 129³, (X, Y, Z) per patch,
    which is the order the exported graph's `lab` input is indexed in. A candidate whose patch
    would leave the box is reported in `outside` and contributes no bytes, so `given` names which
    rows the array actually holds.
    """
    started = time.monotonic()
    patches = sys.modules["seam.patches"]
    req = request.to_py()  # a JsProxy has no `.get`; see `coda_assessor_open`
    held = _held(req, "cut asks for")
    present = held["present"]
    first = int(req.get("from") or 0)
    # **Required, and the module header is why.** A whole list in one message is 215 MB, which
    # is the thing these three calls exist to avoid — so "the rest of them" is not a default a
    # caller should get by saying nothing. The one caller that does want every patch (the
    # byte-comparison probe) asks for them by number.
    if req.get("count") is None:
        raise ValueError(
            "assessor patches: say how many patches to cut. A list is up to a hundred 2.1 MB "
            "patches and the caller sizes the group; there is no sensible default."
        )
    want = present[first : first + int(req["count"])]

    # From the vendored module, not from the held dict: `coda_assessor_open` reports
    # `patches.PATCH` to the caller, so reading the same place makes the two agree by
    # construction rather than by a key somebody has to keep in step.
    size = int(patches.PATCH)
    out = np.empty((len(want), size, size, size), dtype=np.uint8)
    given = []
    outside = []
    for k, candidate in enumerate(want, start=first):
        # Object `k + 2`: `label_box` numbered the query 1 and the present candidates from 2.
        centre = held["centres"][candidate]
        cut = patches.pair_sides(held["lab"], held["lo"], held["res"], centre, 1, k + 2)
        if cut is None:
            outside.append(candidate)
            continue
        # The row *is* how many have been given, so there is no second counter to keep in step —
        # a `continue` between the two would otherwise pack a patch at the wrong row in silence.
        out[len(given)] = cut
        given.append(candidate)
    return {
        "patches": out[: len(given)].reshape(-1),
        "given": np.asarray(given, dtype=np.int32),
        "outside": np.asarray(outside, dtype=np.int32),
        "ms": (time.monotonic() - started) * 1000,
    }


def coda_assessor_close(request, report=None):
    """Drop the held box.

    Worth a call of its own: the labels are a byte a voxel — 6 MB for the box measured in the
    header — and a caller that has finished a tip would otherwise hold them until the next
    `open` replaces them.
    """
    global _HELD
    # Through the same check, so closing a box another tip has already replaced is refused
    # rather than dropping *its* box — which is how a Cancel could take the live tip's labels.
    open_now = _HELD is not None
    if open_now:
        _held(request.to_py(), "close names")
    _HELD = None
    return {"dropped": open_now}
