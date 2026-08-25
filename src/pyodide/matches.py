"""Pulling the matches out of a score matrix, as Coda asks for it.

The sixth capability on the bridge, and the cheapest of the lot: the same two packages again,
and a matrix that has almost always just come off the NBLAST node — so the runtime is booted,
the wheel is installed, and this is a `runPython` of one file plus one call.

Three questions rather than three implementations of one, which is why the mode is a
parameter here and not three entry points. They differ in what comes back:

- **top** is rectangular — `n` matches per group, padded — so it crosses as two `(groups, n)`
  arrays with the shape beside them.
- **above** is ragged, so it crosses CSR-style: an `offsets` array plus one flat `indices`
  and one flat `values`.
- **count** is one number per group and crosses as one array.

**Why this is on the bridge at all** is worth stating, because at Coda's matrix sizes it does
not have to be. A 500 x 500 partial sort is microseconds of JavaScript, and fastcore's version
exists for the tens-of-gigabyte matrices a browser will never hold. What it buys instead is
*parity*: `percentage` means "within X% of this group's own best", not "the top X%", and
`skip_self` means the diagonal rather than a name comparison. Both are decisions somebody
would otherwise re-make slightly differently here, and a match table that disagrees with navis
by a rule nobody wrote down is worse than one that is a few milliseconds slower.

## Padding, and the two shapes it takes

`top_matches` fills a short row with `-1` in the indices and NaN in the values, exactly as
`nblast_knn` fills one with `-1` and `-inf`. It is left in place and dropped on the JavaScript
side for the same reason: dropping it here would lose the rectangular shape that makes the two
arrays readable, and carrying it through would put a match called -1 in front of somebody.
`matches_above` has no padding — a group with nothing above the cutoff is simply an empty
slice — which is the whole point of the CSR form.
"""

import numpy as np
import navis_fastcore as fc


def _cutoff(req):
    """The one of `threshold` / `percentage` this request names, as kwargs.

    `matches_above` and `count_matches` both want **exactly one** of the two and raise on
    neither or both, so the choice is made here rather than by passing both and hoping.
    """
    if str(req["cutoff"]) == "percentage":
        return {"percentage": float(req["percentage"])}
    return {"threshold": float(req["threshold"])}


def coda_matches_run(request, report=None):
    """Extract matches from a square or rectangular score matrix.

    The matrix arrives as a buffer and is read with `np.frombuffer`, which yields a
    **read-only** array. All three fastcore calls here take it without copying and none of
    them writes to it — checked rather than assumed, on `coda_linkage_run`'s finding about
    `linkage` versus `symmetrize`.
    """
    req = request.to_py()
    rows = int(req["rows"])
    cols = int(req["cols"])
    scores = np.frombuffer(req["scores"], dtype=np.float64).reshape(rows, cols)

    mode = str(req["mode"])
    axis = int(req["axis"])
    common = {
        "axis": axis,
        "distances": bool(req["distances"]),
        # `True` means the diagonal and needs a square matrix; the caller has already refused
        # the rectangular case, since "no self-match" on a query-versus-target comparison is a
        # question about names that a matrix cannot answer.
        "skip_self": bool(req["skipSelf"]),
    }
    groups = rows if axis == 0 else cols

    if report is not None:
        report(0.1, f"{rows} x {cols} matrix")

    if mode == "count":
        counts = np.asarray(fc.count_matches(scores, **_cutoff(req), **common))
        if report is not None:
            report(1.0, f"{groups} groups")
        return {
            "mode": "count",
            # int32 for the reason `coda_nblast_knn_run` casts its `idx`: fastcore counts in
            # int64 and an int64 numpy array crosses to JavaScript as a `BigInt64Array`, which
            # converts without complaint and then compares equal to nothing.
            "counts": np.ascontiguousarray(counts, dtype=np.int32),
            "groups": groups,
        }

    if mode == "top":
        idx, values = fc.top_matches(scores, int(req["n"]), **common)
        # Only `idx` is coerced here, and only because `idx.shape` is read below;
        # `ascontiguousarray` in the return dict accepts whatever `asarray` would have made of
        # the rest, so a second pass over them would allocate for nothing.
        idx = np.asarray(idx)
        if report is not None:
            report(1.0, f"{groups} x {idx.shape[1]} matches")
        return {
            "mode": "top",
            "idx": np.ascontiguousarray(idx, dtype=np.int32).ravel(),
            "values": np.ascontiguousarray(values, dtype=np.float64).ravel(),
            "groups": int(idx.shape[0]),
            "n": int(idx.shape[1]),
        }

    offsets, idx, values = fc.matches_above(
        scores,
        **_cutoff(req),
        max_matches=int(req["maxMatches"]),
        **common,
    )
    if report is not None:
        report(1.0, f"{len(idx)} matches")
    return {
        "mode": "above",
        "offsets": np.ascontiguousarray(offsets, dtype=np.int32),
        "idx": np.ascontiguousarray(idx, dtype=np.int32).ravel(),
        "values": np.ascontiguousarray(values, dtype=np.float64).ravel(),
        "groups": groups,
    }
