"""Skeleton repair and resampling, as Coda asks for it.

The fourth capability on the bridge and, like `warp.py`, nearly free: it declares the same
two packages NBLAST does, so on a runtime that has already scored anything it costs a
`runPython` of these definitions and nothing else.

Four operations in one call, applied in the order below and each of them optional. They are
one call rather than four nodes because the *order* is the part that is easy to get wrong,
and because every extra crossing of the bridge re-marshals every point:

1. **heal** — reconnect the fragments a reconstruction arrived in. First, because everything
   after it walks the tree, and a forest is a different tree.
2. **smooth** — take the tracing jitter out. After healing, so a fresh bridge is smoothed
   along with everything else; before resampling, because a Gaussian whose kernel is a
   distance gives the same answer at any node density and would otherwise be undone.
3. **resample** *or* **downsample** — the two are alternatives rather than a sequence. One
   lays nodes down at a fixed spacing, the other keeps every Nth of the ones already there;
   running both means resampling to a spacing and then throwing away three quarters of it.

**Distances here are in the units of `coords`**, which is what fastcore's own arguments mean.
Coda's skeletons are nanometres and its cards ask for micrometres, and the conversion happens
on the JavaScript side in `cleanOps.ts` — the same split `nblastOps.ts` makes, and for the
same reason: the side that still knows what the numbers are is the side that should convert.

## Node ids are row numbers, and come back as row numbers

Every function here is handed `np.arange(n)` as its node ids, so a parent id *is* an index
into `positions` — which is what `SkeletonGeometry.parents` already means. Two of the four
operations break that: `resample_skeleton` mints fresh ids counting from `max + 1`, and
`downsample_skeleton` returns the surviving ids in the original numbering with gaps. Both
therefore go through `_reindex`, which is the one thing in this file that would fail silently
if it were skipped — parents pointing at ids nobody re-based still *draw*, as a neuron whose
branches have been shuffled.

## The second entry point

`coda_simplify_skeletons` is Simplify Skeletons: prune twigs, then thin. Both keep a subset of
the nodes and move none, so it returns *which rows survived* rather than geometry, and the
JavaScript gathers everything per node through that list (`simplifyOps.ts`).
"""

import numpy as np
import navis_fastcore as fc


def _reindex(node_ids, parent_ids):
    """Parent *ids* as parent *row numbers*, which is what Coda's `parents` array holds.

    Vectorised through a scatter table rather than a dict: a resampled skeleton is routinely a
    hundred thousand nodes, and the Python-level loop this replaces was the whole cost of the
    call on anything but a toy.
    """
    node_ids = np.asarray(node_ids, dtype=np.int64)
    parent_ids = np.asarray(parent_ids, dtype=np.int64)

    if len(node_ids) == 0:
        return np.zeros(0, dtype=np.int32)

    highest = int(node_ids.max())
    if len(parent_ids) and int(parent_ids.max()) > highest:
        highest = int(parent_ids.max())
    lookup = np.full(highest + 2, -1, dtype=np.int32)
    lookup[node_ids] = np.arange(len(node_ids), dtype=np.int32)

    # `np.maximum(..., 0)` keeps the gather in bounds for the roots; `np.where` then throws
    # away whatever it read for them. Cheaper than masking, and there is no row -1 to hit.
    return np.where(parent_ids >= 0, lookup[np.maximum(parent_ids, 0)], -1).astype(np.int32)


def _reroot_at(ids, parents, soma):
    """`parents` rerooted at `soma`, or as they are where it is -1 or already the root.

    `topology.py` holds the same three lines for the split: each module runs in a namespace of its
    own (`runtime.ts`), so neither can call the other's.
    """
    if soma < 0 or parents[soma] < 0:
        return parents
    return np.asarray(fc.reroot(ids, parents, [soma]), dtype=parents.dtype)


def _clean_one(coords, parents, radii, labels, opts, soma):
    """One neuron through the whole pipeline. Coordinates float64, radii float64, labels uint8.

    Returns `(coords, parents, radii, labels)` with parents already re-based onto row numbers.
    `labels` are SWC compartment codes and ride every step on the radii's index map — except
    that a resampled node takes its *nearer* end's code rather than a blend, a code being a
    category.

    **Nothing here guards a case fastcore handles**, on `coda_dotprops`' rule — but three
    genuinely have no answer rather than a cheap one, and those are guarded: a skeleton with
    no edges has nothing to smooth along, nothing to resample and nothing to thin.
    """
    n = len(coords)
    ids = np.arange(n, dtype=np.int64)
    parents = np.asarray(parents, dtype=np.int64)

    if opts["heal"] and n > 1:
        max_dist = opts["healMaxDist"]
        parents = np.asarray(
            fc.heal_skeleton(
                ids,
                parents,
                coords,
                method=opts["healMethod"],
                max_dist=None if max_dist <= 0 else max_dist,
            ),
            dtype=np.int64,
        )
        # `heal_skeleton` keeps the largest fragment's root; the soma takes it back.
        parents = _reroot_at(ids, parents, soma)

    if opts["smooth"] > 0 and n > 2:
        # Coordinates only. `values=` would let a radius ride along in the same pass, and
        # deliberately does not: smoothing a radius is a separate claim about the data, and
        # this node's card offers no way to say whether it was wanted.
        coords = np.ascontiguousarray(
            fc.smooth_skeleton_gaussian(ids, parents, coords, opts["smooth"]),
            dtype=np.float64,
        )

    method = opts["method"]

    if method == "resample" and opts["spacing"] > 0 and n > 1:
        new_ids, new_parents, new_coords, source, alpha, _map = fc.resample_skeleton(
            ids, parents, coords, opts["spacing"]
        )
        source = np.asarray(source)
        alpha = np.asarray(alpha, dtype=np.float64)
        # The interpolation fastcore's own docstring prescribes for a per-node column: column
        # 0 of `source` is the child end of the edge the new node sits on, column 1 the parent
        # end, and `alpha` how far along it lies. A node carried over unchanged has its own
        # index in both columns and an alpha of 0, so this is the identity for those.
        new_radii = radii[source[:, 0]] * (1.0 - alpha) + radii[source[:, 1]] * alpha
        new_labels = np.where(alpha < 0.5, labels[source[:, 0]], labels[source[:, 1]])
        return (
            np.ascontiguousarray(new_coords, dtype=np.float64),
            _reindex(new_ids, new_parents),
            np.ascontiguousarray(new_radii, dtype=np.float64),
            np.ascontiguousarray(new_labels, dtype=np.uint8),
        )

    if method == "downsample" and opts["factor"] > 1 and n > 1:
        # No `weights`. They would change the returned chain lengths and the `node_map`
        # tie-break, neither of which is read here — *which* nodes survive is decided by
        # counting hops from each segment's distal end either way.
        keep, new_parents, _w, _map = fc.downsample_skeleton(ids, parents, opts["factor"])
        keep = np.asarray(keep, dtype=np.int64)
        return (
            np.ascontiguousarray(coords[keep], dtype=np.float64),
            _reindex(keep, new_parents),
            np.ascontiguousarray(radii[keep], dtype=np.float64),
            np.ascontiguousarray(labels[keep], dtype=np.uint8),
        )

    # No `_reindex` here, and that is provable rather than an oversight: `ids` is `arange(n)`
    # on every path that reaches this line — heal and smooth both return parents in the same
    # numbering they were given — so the lookup table would be the identity and the whole call
    # reduces to this cast. Only resampling and downsampling renumber, and both re-index above.
    return coords, np.ascontiguousarray(parents, dtype=np.int32), radii, labels


def _joined(parts, dtype):
    """Per-neuron arrays as one flat array of `dtype`, cast during the concatenate.

    `dtype=` on the concatenate rather than a narrowing `ascontiguousarray` after it. fastcore
    works in float64 throughout, so the obvious spelling materialises the whole result in float64
    and then copies it down — 120 MB of transient at the five-million node ceiling
    `checkResampleSize` warns at, to deliver 60 MB. Casting during the concatenate allocates once.
    `np.concatenate` has taken `dtype` since numpy 1.20.
    """
    if not parts:
        return np.zeros(0, dtype=dtype)
    return np.concatenate(parts, dtype=dtype).ravel()


def coda_clean_skeletons(request, report=None):
    """A whole set of skeletons through the pipeline, in one crossing.

    The set arrives flat — every neuron's points after the last, with `offsets` saying where
    each begins — because a hundred skeletons is a hundred thousand points and an array of
    objects would be a hundred thousand clones at the `postMessage` boundary. It leaves the
    same way, and the offsets are rebuilt rather than reused: resampling and downsampling both
    change the node count, which is the entire reason the caller cannot keep its own copy.

    **The item count never changes.** A neuron with one node stays a neuron with one node, and
    an empty one stays empty. `SkeletonsValue` promises one attribute row per item in the same
    order, so dropping a degenerate skeleton here would put every label after it on the wrong
    neuron — `dotpropSetFrom`'s finding, and the same answer.
    """
    req = request.to_py()

    xyz = np.frombuffer(req["points"], dtype=np.float32).reshape(-1, 3).astype(np.float64)
    par = np.frombuffer(req["parents"], dtype=np.int32)
    rad = np.frombuffer(req["radii"], dtype=np.float32).astype(np.float64)
    lab = np.frombuffer(req["compartments"], dtype=np.uint8)
    off = np.frombuffer(req["offsets"], dtype=np.int32)
    somas = np.frombuffer(req["somas"], dtype=np.int32)
    count = len(off) - 1

    opts = {
        "heal": bool(req["heal"]),
        "healMethod": str(req["healMethod"]),
        "healMaxDist": float(req["healMaxDist"]),
        "smooth": float(req["smooth"]),
        "method": str(req["method"]),
        "spacing": float(req["spacing"]),
        "factor": int(req["factor"]),
    }

    out_coords = []
    out_parents = []
    out_radii = []
    out_labels = []
    offsets = [0]
    at = 0

    for i in range(count):
        a, b = int(off[i]), int(off[i + 1])
        if b > a:
            coords, parents, radii, labels = _clean_one(
                np.ascontiguousarray(xyz[a:b]), par[a:b], rad[a:b], lab[a:b], opts, int(somas[i])
            )
            out_coords.append(coords)
            out_parents.append(parents)
            out_radii.append(radii)
            out_labels.append(labels)
            at += len(coords)
        offsets.append(at)
        if report is not None and (i % 8 == 7 or i == count - 1):
            report((i + 1) / max(1, count), f"{i + 1} of {count} neurons")

    return {
        # float32 out, matching the geometry buffers on the other side. fastcore works in
        # float64 and the narrowing happens here, on the wasm heap, rather than doubling what
        # crosses the bridge to deliver precision `Float32Array` cannot hold.
        "points": _joined(out_coords, np.float32),
        "parents": _joined(out_parents, np.int32),
        "radii": _joined(out_radii, np.float32),
        "compartments": _joined(out_labels, np.uint8),
        "offsets": np.ascontiguousarray(offsets, dtype=np.int32),
    }


# ---------------------------------------------------------------------------
# Simplify: prune twigs, then thin
# ---------------------------------------------------------------------------
#
# Both operations *keep a subset* of the nodes and move none of them, which is the whole
# difference from the cleaning pipeline above and the reason this returns no coordinates at
# all: what comes back is, per neuron, which of its original rows survive (`keep`) and their
# parents as rows of the survivors. The JavaScript side gathers positions, radii, labels, a
# computed split and per-node values through `keep`, exactly — nothing is interpolated, so
# nothing has to cross twice.


def _edge_lengths(coords, parents):
    """Each node's distance to its parent, 0 for a root — `prune_twigs`' `weights`.

    Without them fastcore counts an edge as 1, so a threshold would be a number of *nodes* and
    mean something different on every reconstruction.
    """
    has_parent = parents >= 0
    lengths = np.zeros(len(parents), dtype=np.float32)
    delta = coords[has_parent] - coords[parents[has_parent]]
    lengths[has_parent] = np.sqrt((delta * delta).sum(axis=1))
    return lengths


def _unbranched(parents):
    """Per node, whether its whole fragment (connected component) has no branch point.

    fastcore labels a component by its root's id, and the ids are row numbers, so a component
    label indexes a table of length `n` directly.
    """
    n = len(parents)
    component = np.asarray(fc.connected_components(np.arange(n), parents))
    branched = np.zeros(n, dtype=bool)
    branched[component[np.bincount(parents[parents >= 0], minlength=n) >= 2]] = True
    return ~branched[component]


def _prune(parents, lengths, soma, threshold, repeat):
    """Rows (into the neuron) that survive pruning twigs shorter than `threshold`, and their
    parents as rows of the survivors.

    **fastcore's `mask` is per node and `True` means *may be pruned*** — its docstring reads the
    other way round, and the probe pins which. A twig is eaten from its tip towards its branch
    point and the walk stops at the first node that may not go. Two things are protected:

    - **The soma.** Where it is a twig's tip — the usual place when it is not the root — that
      twig is kept whole; where it sits part way along one, the walk stops at it.
    - **A fragment with no branch point**, all of it. fastcore never treats a root as a twig
      tip, but a cable with no branch point is nothing *but* twig, so an unbranched neuron
      shorter than the threshold would come back empty. This removes twigs from trees; joining
      or dropping fragments is not its question. Recomputed every pass, because pruning a
      tree's last short side branch leaves it unbranched.

    `repeat` is navis' `recursive=True`: removing a twig can leave the branch it hung from as a
    new, short twig, and one pass does not see it. Each pass removes nodes or ends the loop.
    """
    alive = np.arange(len(parents))
    current = parents
    while True:
        # In `current`'s dtype: `_reindex` hands back int32, and fastcore re-casts both arrays
        # whenever ids and parents disagree.
        ids = np.arange(len(alive), dtype=current.dtype)
        prunable = ~_unbranched(current)
        prunable[alive == soma] = False
        kept = np.asarray(
            fc.prune_twigs(ids, current, threshold, weights=lengths[alive], mask=prunable),
            dtype=np.int64,
        )
        if len(kept) == len(alive):
            return alive, current
        # A twig goes from its tip back to a branch point, so every survivor's parent survived
        # too, and the sub-tree's parents re-index onto the survivors without a dangling one.
        current = _reindex(kept, current[kept])
        alive = alive[kept]
        if not repeat:
            return alive, current


def _simplify_one(coords, parents, opts, soma):
    """`(keep, parents)` for one neuron: surviving rows in their original order, and their
    parents as rows of `keep`."""
    n = len(parents)
    parents = np.asarray(parents, dtype=np.int64)
    alive = np.arange(n)
    current = parents

    if opts["prune"] > 0 and n > 1:
        alive, current = _prune(
            parents, _edge_lengths(coords, parents), soma, opts["prune"], opts["repeat"]
        )

    # `none` wherever the card's settings remove nothing: `simplifyOps.thins` decides, once.
    method = opts["method"]
    if method == "none" or len(alive) < 2:
        return alive, current
    ids = np.arange(len(alive), dtype=current.dtype)
    # Roots, branch points and leaves survive all three on fastcore's own rule; the soma is the
    # one more node that must, and it is usually a mid-cable node of none of those kinds.
    where = np.flatnonzero(alive == soma)
    preserve = where if len(where) else None
    if method == "every":
        kept, new_parents, _w, _map = fc.downsample_skeleton(
            ids, current, opts["factor"], preserve=preserve
        )
    else:
        thin = fc.simplify_rdp if method == "rdp" else fc.simplify_vw
        threshold = opts["tolerance"] if method == "rdp" else opts["area"]
        # No copy of the neuron when pruning removed nothing.
        points = coords if len(alive) == n else coords[alive]
        kept, new_parents, _w, _map = thin(ids, current, points, threshold, preserve=preserve)
    # All three return parents as *ids* of the survivors with gaps in the numbering, the
    # failure `_reindex` exists for.
    return alive[kept], _reindex(kept, new_parents)


def coda_simplify_skeletons(request, report=None):
    """A whole set through prune-then-thin, in one crossing.

    Pruning goes first because it measures twigs along the cable as traced; thinning first
    would cut the corners off every twig and make each one shorter than it is. The item count
    never changes, `coda_clean_skeletons`' rule and reason.
    """
    req = request.to_py()

    xyz = np.frombuffer(req["points"], dtype=np.float32).reshape(-1, 3).astype(np.float64)
    par = np.frombuffer(req["parents"], dtype=np.int32)
    off = np.frombuffer(req["offsets"], dtype=np.int32)
    somas = np.frombuffer(req["somas"], dtype=np.int32)
    count = len(off) - 1

    opts = {
        "prune": float(req["prune"]),
        "repeat": bool(req["repeat"]),
        "method": str(req["method"]),
        "factor": int(req["factor"]),
        "tolerance": float(req["tolerance"]),
        "area": float(req["area"]),
    }

    out_keep = []
    out_parents = []
    offsets = [0]
    at = 0

    for i in range(count):
        a, b = int(off[i]), int(off[i + 1])
        if b > a:
            keep, parents = _simplify_one(
                np.ascontiguousarray(xyz[a:b]), par[a:b], opts, int(somas[i])
            )
            out_keep.append(keep)
            out_parents.append(parents)
            at += len(keep)
        offsets.append(at)
        if report is not None and (i % 8 == 7 or i == count - 1):
            report((i + 1) / max(1, count), f"{i + 1} of {count} neurons")

    return {
        "keep": _joined(out_keep, np.int32),
        "parents": _joined(out_parents, np.int32),
        "offsets": np.ascontiguousarray(offsets, dtype=np.int32),
    }
