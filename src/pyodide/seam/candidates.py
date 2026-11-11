"""Vendored from SEAM: `seam/candidates.py`, the pool's features and the geometric ranker that scores them.
**Not edited** — see `VENDORED.md` and `scripts/vendor-seam.mjs`, which re-cuts
this file and byte-compares.

A slice rather than a whole-file copy because that module also imports
`paths`, which reaches the filesystem. Everything below is numpy and pandas only.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd

TIE_SEEDS = 10
# The candidate pool around an open end: every object this close to Q (F: a
# median 0.03 µm), no size floor (on Aedes F is often a speck). Shared by the
# candidate search and Model B's hard negatives, so both see one population.
POOL_MAX_DIST_UM = 0.5
MOMENTS_UM = 3.0  # local shape from each object's voxels this close to the cutout's point (open end)


def touching(nb: pd.DataFrame) -> pd.Series:
    """Objects in a cutout summary (cutout.summarize_cutout) that touch Q:
    adjacent voxels, whatever the resolution or axis."""
    return nb["min_dist_um"] <= nb["voxel_diag_um"] + 1e-6


XYZ = ["x", "y", "z"]
# Features of a candidate relative to Q's open end, for the geometric ranker.
# Not end_dist_um: with a simulated open end F always sits ~sigma from it, and
# a ranker fitted on that distance learns sigma (recall@10 0.49 vs 0.24
# without it; 2026-10-24).
FEATURES = ["min_dist_um", "touching", "log_vol", "has_shape", "align", "caliber_ratio", "elongation", "ahead"]
NEUTRAL = {"align": 0.5, "caliber_ratio": 1.0, "elongation": 1.0}  # undefined local shape (too few voxels)


def summary_args(end_nm) -> dict:
    """The negatives.neighbours options a cutout around an open end needs for
    pool_features (one place for that contract)."""
    return {"centroids": True, "point_nm": np.asarray(end_nm, np.float64), "touch_um": POOL_MAX_DIST_UM,
            "moments_um": MOMENTS_UM}


def pool_features(nb: pd.DataFrame, q: int, end_nm) -> pd.DataFrame:
    """The pool with features (and `q_shape`: whether Q has a local shape)
    from a cutout summary around an open end (negatives.neighbours with
    summary_args(end_nm)). The pool is every object other than Q within
    POOL_MAX_DIST_UM of it.
    - end_dist_um: the open end to the object's nearest voxel touching Q;
    - touching: adjacent voxels (touching());
    - log_vol;
    - has_shape: the object and Q both have a local shape (else align,
      caliber_ratio and elongation are NEUTRAL);
    - align: |cos| of the two main axes;
    - caliber_ratio: |log| of the thickness ratio;
    - elongation;
    - ahead: cosine between Q's outward direction at the end (end minus Q's
      centroid in the cutout) and the direction to the object's centroid."""
    end_nm = np.asarray(end_nm, np.float64)
    qrow = nb[nb["root"] == q].iloc[0]
    c = nb[(nb["root"] != q) & (nb["min_dist_um"] <= POOL_MAX_DIST_UM)].copy()
    out = end_nm - qrow[[f"centroid_{a}_nm" for a in XYZ]].to_numpy(float)
    to = c[[f"centroid_{a}_nm" for a in XYZ]].to_numpy(float) - end_nm
    unit = lambda v: v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)  # noqa: E731
    q_axis = qrow[["axis_x", "axis_y", "axis_z"]].to_numpy(float)
    c_axis = c[["axis_x", "axis_y", "axis_z"]].to_numpy(float)
    q_shape = bool(np.isfinite(q_axis).all())  # Q too thin near the open end: no reference shape
    q_cal = float(qrow["caliber_um"]) if q_shape else np.nan
    c = c.assign(end_dist_um=c["point_dist_um"], touching=touching(c) * 1.0,
                 log_vol=np.log(c["vol_um3"].clip(lower=1e-5)),
                 has_shape=(np.isfinite(c_axis).all(1) & q_shape) * 1.0,
                 align=np.abs(c_axis @ q_axis),
                 caliber_ratio=np.abs(np.log(c["caliber_um"].clip(lower=1e-3) / max(q_cal, 1e-3)))
                 if q_shape else np.nan,
                 elongation=c["elongation"].clip(upper=20), ahead=unit(to) @ unit(out), q_shape=q_shape)
    c.loc[c["has_shape"] == 0, ["align", "caliber_ratio", "elongation"]] = np.nan
    for i, a in enumerate(XYZ):
        c[f"end_{a}_nm"] = end_nm[i]
    return c.fillna(NEUTRAL)


@dataclasses.dataclass
class GeometricRanker:
    """A logistic regression on FEATURES (standardised; fit_ranker), stored
    as JSON, so a candidate search can rank pools without the fitting data."""
    features: list
    mu: list
    sd: list
    w: list
    b: float
    fitted_on: str = ""

    def score(self, c: pd.DataFrame) -> np.ndarray:
        """Logit: higher is more likely the continuation."""
        z = (c[self.features].to_numpy(float) - np.asarray(self.mu)) / np.asarray(self.sd)
        return z @ np.asarray(self.w) + self.b

    def rank_key(self, c: pd.DataFrame) -> np.ndarray:
        """Lower is better (for sorting and candidates.recall)."""
        return -self.score(c)

    def coef(self) -> dict:
        return dict(zip(self.features, np.round(self.w, 2).tolist()))



# where the candidate search puts a simulated open end (scripts/pilots/candidate_search.py): `contact`, at the
# join (the gold set's offsets), or `ring`, sigma_um from the cut (the first runs, rv1's replay)
PLACEMENTS = ("contact", "ring")

