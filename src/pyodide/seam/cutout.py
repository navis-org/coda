"""Vendored from SEAM: `seam/negatives.py`, the two functions that summarise a supervoxel cutout.
**Not edited** — see `VENDORED.md` and `scripts/vendor-seam-cutout.mjs`, which re-cuts
this file and byte-compares.

A slice rather than a whole-file copy because that module also imports
`cave`, `paths` and `pre_edit`, which reach the network. Everything below is numpy, scipy and pandas only.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

MIN_LOCAL_VOXELS = 20  # local shape needs at least this many voxels near the point

def summarize_cutout(uniq, inv, roots_u, query_root: int, res, lo, centroids: bool = False,
                     point_nm=None, touch_um: float | None = 0.5, moments_um: float | None = None) -> pd.DataFrame | None:
    """Per root in a supervoxel cutout: `n_vox`, `vol_um3`, `min_dist_um` (to
    the query object, by EDT), `rep_svid` (the supervoxel of its voxel closest
    to the query) and the contact point (`contact_{x,y,z}_nm`, absolute nm).
    Optional, for the candidate search:
    - `centroids`: the in-cutout centroid (`centroid_{x,y,z}_nm`; the query's
      own row gives its centroid);
    - `point_nm`: `point_dist_um`, the distance from that point to the
      root's nearest voxel within `touch_um` of the query (inf if none). For
      a candidate touching the query along a length, the contact point is an
      arbitrary voxel of that stretch; this is the distance that matters
      from an open end. `touch_um=None` skips it (a slice-by-slice pass)
      when only the local shape is wanted;
    - `moments_um` (with `point_nm`): local shape of each root from its
      voxels within that radius of the point: `n_local`, the main axis
      (`axis_{x,y,z}`, unit, sign arbitrary), `caliber_um` (twice the root of
      the mean minor variance: a cylinder's radius) and `elongation` (major /
      middle standard deviation); NaN with fewer than MIN_LOCAL_VOXELS;
    - always `voxel_diag_um`: the voxel diagonal (µm), the largest
      centre-to-centre distance of adjacent voxels (corner contact), so
      "touching" can mean adjacent voxels whatever the resolution or axis.

    `uniq`: the cutout's distinct supervoxels; `inv`: per-voxel index into
    `uniq` (cutout shape); `roots_u`: root of each supervoxel (0 = none).
    Reduces per supervoxel, then per root, so no per-voxel table is built
    (a 4.7M-voxel Aedes cutout would otherwise cost ~300-450 MB per thread)."""
    from scipy import ndimage

    q = (roots_u == query_root)[inv]
    if not q.any():
        return None
    dist, nearest = ndimage.distance_transform_edt(~q, sampling=res, return_indices=True)
    d = dist.ravel() / 1000.0  # µm
    flat = inv.ravel()
    # per supervoxel: voxel count, min distance, and the voxel attaining it
    n_sv = np.bincount(flat, minlength=len(uniq))
    min_sv = np.full(len(uniq), np.inf)
    np.minimum.at(min_sv, flat, d)
    hit = np.flatnonzero(d == min_sv[flat])
    sv_hit, first = np.unique(flat[hit], return_index=True)
    vox_sv = np.zeros(len(uniq), dtype=np.int64)
    vox_sv[sv_hit] = hit[first]
    # per root: sum the counts, keep the supervoxel closest to the query
    valid = np.flatnonzero(roots_u != 0)
    roots, rinv = np.unique(roots_u[valid], return_inverse=True)
    n_vox = np.bincount(rinv, weights=n_sv[valid]).astype(np.int64)
    order = np.lexsort((min_sv[valid], rinv))
    best = valid[order[np.r_[0, np.flatnonzero(np.diff(rinv[order])) + 1]]]
    out = pd.DataFrame({"root": roots, "n_vox": n_vox, "min_dist_um": min_sv[best], "rep_svid": uniq[best]})
    out["vol_um3"] = out["n_vox"] * np.prod(res) / 1e9
    out["voxel_diag_um"] = float(np.linalg.norm(res)) / 1000  # farthest adjacent voxel centres (corner contact)
    # Contact point: midpoint between the candidate's voxel closest to Q and
    # that nearest Q voxel. Negative windows are centred here, as positives
    # are centred on the merge point, where F touches Q. Without this,
    # "candidate at the window centre" separated positives from negatives
    # with AUC 0.96-1.0 (pilot, 2026-10-21).
    cv = np.stack(np.unravel_index(vox_sv[best], inv.shape), axis=1)
    qv = nearest[:, cv[:, 0], cv[:, 1], cv[:, 2]].T
    contact = ((cv + qv) / 2 + 0.5 + np.asarray(lo)) * np.asarray(res)  # voxel centres, absolute nm
    out["contact_x_nm"], out["contact_y_nm"], out["contact_z_nm"] = contact[:, 0], contact[:, 1], contact[:, 2]
    if point_nm is not None and touch_um is not None:  # per-voxel distance to the point, one slice at a time
        p_vox = (np.asarray(point_nm, np.float64) / res) - 0.5 - np.asarray(lo)
        best_sv = np.full(len(uniq), np.inf)
        dist3 = dist.reshape(inv.shape)
        yy, zz = np.meshgrid(np.arange(inv.shape[1]), np.arange(inv.shape[2]), indexing="ij")
        for i in range(inv.shape[0]):
            dd = np.sqrt(((i - p_vox[0]) * res[0]) ** 2 + ((yy - p_vox[1]) * res[1]) ** 2
                         + ((zz - p_vox[2]) * res[2]) ** 2) / 1000.0
            touching = dist3[i] / 1000.0 <= touch_um
            np.minimum.at(best_sv, inv[i][touching], dd[touching])
        out["point_dist_um"] = pd.Series(best_sv[valid]).groupby(rinv).min().to_numpy()
    if moments_um is not None and point_nm is not None:
        sv_to_root = np.full(len(uniq), -1, np.int64)
        sv_to_root[valid] = rinv
        out = out.join(_local_moments(inv, sv_to_root, len(roots), res, lo, point_nm, moments_um), how="left")
    # centroid: per-supervoxel coordinate sums, one slice at a time (no per-voxel table)
    for ax, name in enumerate("xyz" if centroids else ""):
        s_sv = np.zeros(len(uniq))
        for i in range(inv.shape[ax]):
            s_sv += np.bincount(np.take(inv, i, axis=ax).ravel(), minlength=len(uniq)) * i
        s_root = np.bincount(rinv, weights=s_sv[valid])
        out[f"centroid_{name}_nm"] = (s_root / n_vox + 0.5 + lo[ax]) * res[ax]
    return out


def _local_moments(inv, sv_to_root, n_roots: int, res, lo, point_nm, radius_um: float) -> pd.DataFrame:
    """Per root: first and second moments of its voxels within `radius_um`
    of `point_nm` (nm), slice by slice, then the principal axes."""
    p_vox = np.asarray(point_nm, np.float64) / res - 0.5 - np.asarray(lo)
    S = np.zeros((n_roots, 10))  # n, x, y, z, xx, yy, zz, xy, xz, yz (µm)
    yy, zz = np.meshgrid(np.arange(inv.shape[1]), np.arange(inv.shape[2]), indexing="ij")
    Y, Z = (yy - p_vox[1]) * res[1] / 1000, (zz - p_vox[2]) * res[2] / 1000
    for i in range(inv.shape[0]):
        X = np.full(Y.shape, (i - p_vox[0]) * res[0] / 1000)
        keep = (X ** 2 + Y ** 2 + Z ** 2 <= radius_um ** 2)
        r = sv_to_root[inv[i][keep]]
        ok = r >= 0
        r, x, y, z = r[ok], X[keep][ok], Y[keep][ok], Z[keep][ok]
        for j, w in enumerate((None, x, y, z, x * x, y * y, z * z, x * y, x * z, y * z)):
            S[:, j] += np.bincount(r, weights=w, minlength=n_roots)
    n = S[:, 0]
    m = S[:, 1:4] / np.maximum(n, 1)[:, None]
    cov = np.zeros((n_roots, 3, 3))
    for (a, b), j in zip([(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)], range(4, 10)):
        cov[:, a, b] = cov[:, b, a] = S[:, j] / np.maximum(n, 1) - m[:, a] * m[:, b]
    w, v = np.linalg.eigh(cov)  # ascending
    w = np.clip(w, 0, None)
    out = pd.DataFrame({"n_local": n.astype(np.int64), "axis_x": v[:, 0, 2], "axis_y": v[:, 1, 2],
                        "axis_z": v[:, 2, 2], "caliber_um": 2 * np.sqrt((w[:, 0] + w[:, 1]) / 2),
                        "elongation": np.sqrt(w[:, 2] / np.maximum(w[:, 1], 1e-12))})
    # too few voxels for a shape (an empty covariance gives the grid's z axis,
    # a handful the grid's anisotropy): undefined, not an artefact
    out.loc[n < MIN_LOCAL_VOXELS, ["axis_x", "axis_y", "axis_z", "caliber_um", "elongation"]] = np.nan
    return out

