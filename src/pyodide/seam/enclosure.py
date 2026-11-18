"""How enclosed each object in a supervoxel cutout is: the share of its surface facing its largest neighbour
(user, 2026-11-14: a cheap organelle flag for the candidate lists; big-ideas §12f measured the same idea on meshes).
An organelle (a mitochondrion, vesicles) sits wrapped in its cell, so nearly all of its surface faces one object (its
host); a continuation of Q meets Q at one end and other objects along its length.

Numpy only (invariant 11): it reads the cutout the candidate search already caches (negatives.neighbours: `inv`, the
per-voxel index into the supervoxels, and `roots_u`, their roots), so it costs no request.

Faces are counted with 6-connectivity, in voxels. Per object:
- `faces`: its surface faces inside the cutout plus those on the cutout's sides;
- `enclosed`: the share of `faces` facing its largest neighbour (0 = no segment, never a host);
- `host`: that neighbour's root;
- `cut`: the share on the cutout's sides (an object the box cuts may be more or less enclosed outside it);
- `unlabelled`: the share facing voxels with no segment (root 0);
- `enclosed_group`, `host_group`, `group_n` (2026-11-14, the eye check's misses were fragments of one mitochondrion
  touching each other): the same measure for the object's group, the small objects joined to it through touching
  small objects whose largest neighbour that is not small is the same object (pieces of one organelle in one cell),
  taken as one (faces between members do not count); `organelle_score` = max(enclosed, enclosed_group), so a group
  only adds. Small: at most `small_um3` inside the cutout and not cut by its sides (a cut object's size is unknown).
  For an object in no group, the group's values equal its own. Not used: the second eye check found 1 organelle in
  the 20 pieces the groups add (mito_check2.py, 2026-11-14); the pipeline's flag is `enclosed`.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

SMALL_UM3 = 0.2  # mitochondria in Aedes's lists reach ~0.16 um3 (the eye check's 95th percentile)


def _faces(lab: np.ndarray, k: int) -> tuple:
    """(own, nb, n): the faces between each ordered pair of labels, sorted by (own, nb); and each label's faces on the
    cutout's sides.

    Each face is keyed once, by its unordered pair, and the keys counted with a hash (pandas), not a sort: half the
    keys, and no k² array (a bincount over k² keys is 200 MB at k = 5,000, as in Aedes's search boxes). Then mirrored,
    so each face counts for both of its sides, and sorted, so `_best` breaks ties towards the smaller label as before.
    On ten rv2 search boxes (2.0-2.8M faces, k 3,500-8,100): 80 ms against 154 ms with np.unique over both sides."""
    keys = []
    side = np.zeros(k, np.int64)
    for ax in range(lab.ndim):
        v = np.moveaxis(lab, ax, 0)
        a, b = v[:-1].ravel(), v[1:].ravel()
        d = a != b
        a, b = a[d].astype(np.int64), b[d].astype(np.int64)
        keys.append(np.minimum(a, b) * k + np.maximum(a, b))
        for end in (0, -1):  # the cutout's two sides across this axis
            side += np.bincount(v[end].ravel(), minlength=k)
    counts = pd.Series(np.concatenate(keys)).value_counts(sort=False)
    key, n = counts.index.to_numpy(np.int64), counts.to_numpy(np.int64)
    lo, hi = key // k, key % k
    own, nb, n = np.concatenate([lo, hi]), np.concatenate([hi, lo]), np.concatenate([n, n])
    order = np.argsort(own * k + nb)
    return own[order], nb[order], n[order], side


def _groups(own, nb, join: np.ndarray, key: np.ndarray) -> np.ndarray:
    """Each label's group: the smallest label among those it is joined to through touching `join` labels of the same
    `key` (-1: never joined)."""
    g = np.arange(len(join))
    e = join[own] & join[nb] & (key[own] == key[nb]) & (key[own] >= 0)
    a, b = own[e], nb[e]
    while True:
        nxt = g.copy()
        np.minimum.at(nxt, a, g[b])
        nxt = nxt[nxt]  # pointer jumping
        if np.array_equal(nxt, g):
            return g
        g = nxt


def _best(owner, nb, n, k: int, hostable) -> tuple:
    """Per owner: the faces towards its largest hostable neighbour, and that neighbour."""
    best, host = np.zeros(k), np.full(k, -1, np.int64)
    o, m, c = owner[hostable], nb[hostable], n[hostable]
    if len(o):
        order = np.lexsort((-c, o))
        first = np.unique(o[order], return_index=True)[1]
        best[o[order][first]] = c[order][first]
        host[o[order][first]] = m[order][first]
    return best, host


def enclosure(inv: np.ndarray, roots_u: np.ndarray, roots=None, res=None, small_um3: float = SMALL_UM3) -> pd.DataFrame:
    """Per root of the cutout (or only `roots`): faces, enclosed, host, cut, unlabelled, and the group's
    enclosed_group, host_group, group_n (see the module docstring). `res`: the voxel size in nm. Without it nothing is
    small, so every object is its own group: the group step is skipped and the group's columns copy the object's own
    (Coda's call, which reads only `enclosed`; the step was ~13% of the call there)."""
    ids, lab_u = np.unique(roots_u, return_inverse=True)  # roots compacted; 0 (no segment) is one of them if present
    lab = lab_u[inv].astype(np.int32 if len(ids) < 2**31 else np.int64)
    k = len(ids)
    own, nb, n, side = _faces(lab, k)
    faces = np.bincount(own, weights=n, minlength=k) + side
    zero = np.flatnonzero(ids == 0)
    z = zero[0] if len(zero) else -1
    to_zero = np.bincount(own[nb == z], weights=n[nb == z], minlength=k)
    best, host = _best(own, nb, n, k, nb != z)
    safe = np.maximum(faces, 1)
    if res is None:  # nothing small: each object its own group
        enclosed_group, host_group, group_n = best / safe, host, np.ones(k, np.int64)
    else:
        vox_um3 = float(np.prod(res)) / 1e9
        small = (np.bincount(lab.ravel(), minlength=k) * vox_um3 <= small_um3) & (side == 0) & (ids != 0)
        big_host = _best(own, nb, n, k, (nb != z) & ~small[nb])[1]  # each label's largest neighbour that is not small
        g = _groups(own, nb, small, big_host)
        outer = g[own] != g[nb]  # faces leaving the group
        g_faces = np.bincount(g[own][outer], weights=n[outer], minlength=k) + np.bincount(g, weights=side, minlength=k)
        keep = outer & (nb != z)  # each member's faces towards one outside object, summed per group
        gk, gn = np.unique(g[own][keep] * k + nb[keep], return_inverse=True)
        g_best, g_host = _best(gk // k, gk % k, np.bincount(gn, weights=n[keep]), k, np.ones(len(gk), bool))
        enclosed_group, host_group = g_best[g] / np.maximum(g_faces[g], 1), g_host[g]
        group_n = np.bincount(g, minlength=k)[g]
    out = pd.DataFrame({"root": ids, "faces": faces.astype(np.int64), "enclosed": best / safe,
                        "host": np.where(host >= 0, ids[np.maximum(host, 0)], 0), "cut": side / safe,
                        "unlabelled": to_zero / safe, "enclosed_group": enclosed_group,
                        "host_group": np.where(host_group >= 0, ids[np.maximum(host_group, 0)], 0),
                        "group_n": group_n})
    out["organelle_score"] = np.maximum(out.enclosed, out.enclosed_group)
    out = out[out.root != 0]
    if roots is not None:
        out = out[out.root.isin(np.asarray(roots, np.int64))]
    return out.reset_index(drop=True)
