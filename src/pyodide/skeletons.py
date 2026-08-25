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


def _clean_one(coords, parents, radii, opts):
    """One neuron through the whole pipeline. Coordinates float64, radii float64.

    Returns `(coords, parents, radii)` with parents already re-based onto row numbers.

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
                method="ALL",
                max_dist=None if max_dist <= 0 else max_dist,
            ),
            dtype=np.int64,
        )

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
        return (
            np.ascontiguousarray(new_coords, dtype=np.float64),
            _reindex(new_ids, new_parents),
            np.ascontiguousarray(new_radii, dtype=np.float64),
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
        )

    # No `_reindex` here, and that is provable rather than an oversight: `ids` is `arange(n)`
    # on every path that reaches this line — heal and smooth both return parents in the same
    # numbering they were given — so the lookup table would be the identity and the whole call
    # reduces to this cast. Only resampling and downsampling renumber, and both re-index above.
    return coords, np.ascontiguousarray(parents, dtype=np.int32), radii


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
    off = np.frombuffer(req["offsets"], dtype=np.int32)
    count = len(off) - 1

    opts = {
        "heal": bool(req["heal"]),
        "healMaxDist": float(req["healMaxDist"]),
        "smooth": float(req["smooth"]),
        "method": str(req["method"]),
        "spacing": float(req["spacing"]),
        "factor": int(req["factor"]),
    }

    out_coords = []
    out_parents = []
    out_radii = []
    offsets = [0]
    at = 0

    for i in range(count):
        a, b = int(off[i]), int(off[i + 1])
        if b > a:
            coords, parents, radii = _clean_one(
                np.ascontiguousarray(xyz[a:b]), par[a:b], rad[a:b], opts
            )
            out_coords.append(coords)
            out_parents.append(parents)
            out_radii.append(radii)
            at += len(coords)
        offsets.append(at)
        if report is not None and (i % 8 == 7 or i == count - 1):
            report((i + 1) / max(1, count), f"{i + 1} of {count} neurons")

    def joined(parts, dtype):
        # `dtype=` on the concatenate rather than a narrowing `ascontiguousarray` after it.
        # fastcore works in float64 throughout, so the obvious spelling materialises the whole
        # result in float64 and then copies it down — 120 MB of transient at the five-million
        # node ceiling `checkResampleSize` warns at, to deliver 60 MB. Casting during the
        # concatenate allocates once. `np.concatenate` has taken `dtype` since numpy 1.20.
        if not parts:
            return np.zeros(0, dtype=dtype)
        return np.concatenate(parts, dtype=dtype).ravel()

    return {
        # float32 out, matching the geometry buffers on the other side. fastcore works in
        # float64 and the narrowing happens here, on the wasm heap, rather than doubling what
        # crosses the bridge to deliver precision `Float32Array` cannot hold.
        "points": joined(out_coords, np.float32),
        "parents": joined(out_parents, np.int32),
        "radii": joined(out_radii, np.float32),
        "offsets": np.ascontiguousarray(offsets, dtype=np.int32),
    }
