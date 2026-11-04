#!/usr/bin/env python3
"""
The second half of `pnpm probe:affinity-parity`: recompute what the pack computed, from the
reference, and compare.

`probe-affinity-parity.ts` writes what `src/packs/seam` produced. This reads it, runs
`affinity_reference.py` over the *same* inputs, and checks the two agree — the point cloud
transform to floating-point tolerance, the labels exactly up to renaming.

**Labels are compared as a partition, not as numbers.** Two clusterings that split the points
identically but number the clusters differently are the same answer; comparing the integers would
fail on an implementation detail. What must match is which points are together, and which fell to
background -- background being label 0 on both sides, that one *is* compared by value.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from affinity_reference import cluster, prepare_cloud  # noqa: E402


def partition(labels: np.ndarray) -> set[frozenset[int]]:
    """A clustering as the set of its groups, so cluster numbering cannot matter."""
    groups: dict[int, set[int]] = {}
    for index, label in enumerate(labels):
        if label == 0:
            continue
        groups.setdefault(int(label), set()).add(index)
    return {frozenset(members) for members in groups.values()}


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/coda-affinity-parity.json")
    got = json.loads(path.read_text())
    n = got["points"]
    failures = []

    # 1. The transform. Same drawn points in, so any difference is centring or scaling. The
    #    preprocessing block is the one the pack parsed, not a literal repeated on this side.
    pre = got["preprocessing"]
    drawn = np.asarray(got["drawnNm"], dtype=np.float32).reshape(n, 3)
    # The reference works in um; the pack is handed nanometres and converts, which is the step
    # most likely to be wrong by a factor of a thousand.
    expected = prepare_cloud(drawn / 1000.0, pre)
    actual = np.asarray(got["positions"], dtype=np.float32).reshape(n, 3)
    worst = float(np.max(np.abs(expected - actual)))
    print(f"point cloud: worst coordinate difference {worst:.3e}")
    if worst > 1e-6:
        failures.append(f"point cloud differs by {worst:.3e}")

    # 2. Every drawn index is a real node, and duplicates are expected rather than a defect.
    source = np.asarray(got["sourceIndex"], dtype=np.int64)
    if source.min() < 0 or source.max() >= got["nodes"]:
        failures.append("a drawn index is outside the skeleton")
    duplicates = n - len(set(source.tolist()))
    print(f"draw: {duplicates} duplicate indices of {n} (expected: sampling is with replacement)")

    # 3. The clustering, over the identical affinity matrix, at every cut the pack ran. The cuts
    #    straddle the threshold on purpose: well-separated blocks agree under any implementation.
    affinity = np.asarray(got["affinity"], dtype=np.float32).reshape(n, n)
    for run in got["runs"]:
        reference = cluster(affinity, run["threshold"], run["minClusterSize"], got["linkage"])
        mine = np.asarray(run["labels"], dtype=np.int64)
        ref_background = set(np.flatnonzero(reference == 0).tolist())
        my_background = set(np.flatnonzero(mine == 0).tolist())
        # Hoisted, so the line printed and the assertion made are provably the same object.
        ref_groups, my_groups = partition(reference), partition(mine)
        same = ref_groups == my_groups
        print(
            f"cut t={run['threshold']} min={run['minClusterSize']}: "
            f"reference {len(ref_groups)} clusters / {len(ref_background)} background, "
            f"pack {run['clusters']} / {run['background']} -> {'same' if same else 'DIFFER'}"
        )
        if not same:
            failures.append(f"t={run['threshold']}: the two clusterings group the points differently")
        if ref_background != my_background:
            failures.append(
                f"t={run['threshold']}: background differs on "
                f"{len(ref_background ^ my_background)} points"
            )

        # 4. Confidence is the pack's own, but it must be a probability where it is a number,
        #    and null exactly on the background.
        confidence = [c for c in run["confidence"] if c is not None]
        if confidence and (min(confidence) < 0 or max(confidence) > 1):
            failures.append(f"t={run['threshold']}: a confidence is outside [0, 1]")
        # Null on every background point -- but *not* only there: a placed singleton cluster has
        # no other member to be confident against, so `clusterConfidence` returns null for it
        # too. Asserting the exact complement fails on any run with minClusterSize 1.
        placed_with_null = [
            i for i, c in enumerate(run["confidence"]) if c is None and i not in my_background
        ]
        if any(c is not None for i, c in enumerate(run["confidence"]) if i in my_background):
            failures.append(f"t={run['threshold']}: a background point has a confidence")
        singletons = {
            label
            for label in set(mine.tolist())
            if label != 0 and int((mine == label).sum()) == 1
        }
        unexplained = [i for i in placed_with_null if int(mine[i]) not in singletons]
        if unexplained:
            failures.append(
                f"t={run['threshold']}: {len(unexplained)} placed points have no confidence "
                f"and are not singletons"
            )

    for failure in failures:
        print(f"FAIL: {failure}")
    print("parity ok" if not failures else f"{len(failures)} difference(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
