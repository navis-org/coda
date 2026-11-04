"""
The reference semantics of the SEAM pack: how a point cloud is built, and how affinities
become labels.

Shared by `probe-affinity.py` (fidelity of the ONNX conversion) and, from Phase 2, by
`probe:affinity-parity`, which checks the pack's `pointCloud.ts` and `affinityOps.ts` against it.
Same arrangement as `biophys_neuron.py`, and for the same reason: a reference that lives inside
one probe becomes a second spelling the moment anything else needs it.

**numpy and scikit-learn only.** No torch, no onnxruntime, nothing that needs a 4.5 GB checkpoint
— so the parity probe can reach this in seconds. If an import here ever grows heavier than that,
the parity probe will quietly grow its own copy of these functions instead, and the claim in the
first paragraph stops being true.

Every constant these take is passed in, from the manifest. Nothing in this file knows which
connectome it is serving.
"""

from __future__ import annotations

import numpy as np
from scipy.stats import entropy
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import mutual_info_score

STEP_UM = 1.5


def random_neuron(rng: np.random.Generator, points: int) -> np.ndarray:
    """
    A branching random walk, in um: a trunk that sprouts children with a small turning bias.

    Not a neuron. It is elongated, branched and spatially coherent, which is the property the
    affinities need in order not to saturate -- random blobs put every pair at the same distance
    and the model answers with a constant.
    """
    nodes = [np.zeros(3)]
    directions = [rng.normal(size=3)]
    directions[0] /= np.linalg.norm(directions[0])
    while len(nodes) < points:
        i = rng.integers(0, len(nodes))
        heading = directions[i] + rng.normal(scale=0.35, size=3)
        heading /= np.linalg.norm(heading)
        run = min(int(rng.integers(5, 40)), points - len(nodes))
        here = nodes[i]
        for wobble in rng.normal(scale=0.12, size=(run, 3)):
            heading = heading + wobble
            heading /= np.linalg.norm(heading)
            here = here + heading * STEP_UM
            nodes.append(here)
            directions.append(heading)
    return np.asarray(nodes[:points], dtype=np.float32)


def prepare_cloud(points: np.ndarray, pre: dict) -> np.ndarray:
    """
    **The node's preprocessing**, and the one thing `pointCloud.ts` must reproduce exactly:
    centre the cloud on its centroid, then divide by `globalScale`.

    That is all. The jitter, the random translate and the random rotation in `merged_cloud`
    below are *training augmentations* -- they belong to how the benchmark's synthetic merges
    were built, not to how a real segment is fed to the model at inference. Conflating the two
    would have the node randomly rotating the reader's neuron before predicting on it.
    """
    centred = points - points.mean(axis=0)
    return (centred / pre["globalScale"]).astype(np.float32)


def random_rotation(rng: np.random.Generator, points: np.ndarray) -> np.ndarray:
    """One uniformly random rotation about a random axis, as `Transforms.RandomRotate` applies."""
    axis = rng.normal(size=3)
    axis /= np.linalg.norm(axis)
    angle = rng.uniform(0, 2 * np.pi)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    r = np.eye(3) + np.sin(angle) * k + (1 - np.cos(angle)) * (k @ k)
    return (points @ r.T).astype(np.float32)


def merged_cloud(rng: np.random.Generator, neurons: int, per_neuron: int, pre: dict):
    """
    **A fixture**, not the node's input path: the benchmark's synthetic merge, as
    `NeuronDataset.__getitem__` builds one. Centre each neuron on its own centroid, jitter it,
    offset it by a random vector of norm `translate`, concatenate, rotate the whole cloud, then
    divide by `globalScale`.

    The rotation is applied unconditionally upstream -- outside the `if self.train` guard -- so
    it is part of the evaluation distribution too, and omitting it here would have the probe
    measuring a distribution the checkpoint never saw.

    Note what this is *not*: two neurons in their true relative positions touching at one place,
    which is what a real merge looks like. Reproduced because it is the distribution the
    checkpoint was trained and evaluated on. See docs/seam-plan.md -- whether the model
    transfers to real merges is Phase 3's question and nothing here can answer it.
    """
    clouds, labels = [], []
    for k in range(neurons):
        pts = random_neuron(rng, per_neuron)
        pts = pts - pts.mean(axis=0)
        pts = pts + rng.normal(scale=pre["jitter"], size=pts.shape).astype(np.float32)
        offset = rng.normal(size=3)
        pts = pts + (offset / np.linalg.norm(offset) * pre["translate"]).astype(np.float32)
        clouds.append(pts)
        labels.append(np.full(per_neuron, k + 1, dtype=np.int64))
    pc = random_rotation(rng, np.concatenate(clouds))
    return (pc / pre["globalScale"]).astype(np.float32), np.concatenate(labels)


def cluster(affinity: np.ndarray, threshold: float, min_size: int, linkage: str) -> np.ndarray:
    """
    The paper's clustering: average linkage on 1 - A, then clusters under `min_size` to
    background (label 0).

    `threshold` is a **distance** threshold, not an affinity cut. `eval_affinity.py` computes
    `pred_dists = 1.0 - pred_aff` and hands t straight to AgglomerativeClustering, so the
    paper's t = 0.8 links points whose average affinity exceeds 0.2 -- far more permissive than
    reading "threshold 0.8" suggests. Getting this backwards silently produces a much more
    fragmented clustering and nothing about the output says so. It is the single most likely
    thing for a reimplementation to get wrong, which is why the parity probe exists.

    The model is **not** symmetric, so the matrix is symmetrised as (A + A')/2 rather than
    either triangle being taken as authoritative. Kept in float32 rather than letting
    `1.0 - affinity` promote to float64, which halves every temporary here -- at N = 4096 a
    full-size float32 array is 268 MB against float64's 536 MB. Note `distance += distance.T`
    still allocates one internally (NumPy resolves the self-overlap by copying), so this
    reduces the peak rather than removing it.
    """
    distance = np.float32(1.0) - affinity
    np.fill_diagonal(distance, np.float32(0.0))
    distance += distance.T
    distance *= np.float32(0.5)
    np.clip(distance, 0.0, None, out=distance)
    labels = AgglomerativeClustering(
        n_clusters=None, metric="precomputed", distance_threshold=threshold, linkage=linkage
    ).fit_predict(distance)
    sizes = np.bincount(labels)
    return np.where(sizes[labels] < min_size, 0, labels + 1)


def voi(truth: np.ndarray, proposed: np.ndarray) -> tuple[float, float]:
    """
    Split and merge halves of the variation of information, in nats, **in that order**.

    The argument order is load-bearing and the two halves are not interchangeable:

        VOI_split = H(proposed | truth)   over-segmentation: one true object cut into many
        VOI_merge = H(truth | proposed)   under-segmentation: several true objects run together

    So a proposal that merges two planted neurons into one cluster scores (0, ln 2), and one
    that cuts a single neuron in half scores (ln 2, 0). Returning these the wrong way round
    reports a merge error as a split error -- which, for a node whose entire job is finding
    merge errors, is the one mistake that inverts the headline. It is checked by the first
    doctest-shaped assertion anyone should write against this module.
    """
    _, ti = np.unique(truth, return_inverse=True)
    _, pi = np.unique(proposed, return_inverse=True)
    mi = mutual_info_score(ti, pi)
    h_truth = entropy(np.bincount(ti) / len(ti))
    h_proposed = entropy(np.bincount(pi) / len(pi))
    return float(h_proposed - mi), float(h_truth - mi)


def main() -> int:
    """
    Emit one reference cloud and its planted labels as JSON, for the parity probe to diff.

    Deliberately does not run the model: the cloud and the clustering rule are what a
    reimplementation gets wrong, and both are reachable without a checkpoint.
    """
    import argparse
    import json
    from pathlib import Path

    p = argparse.ArgumentParser(description=main.__doc__)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--neurons", type=int, default=2)
    p.add_argument("--points", type=int, default=96)
    args = p.parse_args()

    pre = json.loads(args.manifest.read_text())["preprocessing"]
    pc, labels = merged_cloud(np.random.default_rng(args.seed), args.neurons, args.points, pre)
    print(json.dumps({"points": pc.tolist(), "labels": labels.tolist()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
