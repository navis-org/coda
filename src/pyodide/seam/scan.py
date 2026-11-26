"""Scanning a whole neuron with a per-point model: window centres that tile
its surface, each window's model input, and the open ends in the pooled
scores (docs/evaluation.md, "Replay"). numpy-only (docs/invariants.md rule
11): the same code runs in a batch job and in the browser.

Scan owns the sequence and the seeds (rule 3: a browser scan must not
re-implement them): centres from a coarse sample seeded by `seed`, window i
from rng [seed, i]. Windows are built as in training: crop by face centroid
(canonical.crop_faces), area-uniform surface sample, normals rounded through
float16 as stored in training windows, then canonical.subsample and
canonical.model_input. Faces are found through a grid on their centroids
(cell = window radius), so a window looks at 27 cells, not the whole mesh.
Per-window scores are pooled with reduce_max, then open_ends picks peaks.
"""

from __future__ import annotations

import numpy as np

from . import canonical

TILE_SAMPLE_UM = 1.0  # coarse surface sample the tiling is drawn from
# One centre per occupied cell: two points of a cell are at most spacing *
# sqrt(3) apart, so spacing <= radius / sqrt(3) puts every surface point in
# some window. The tiling spacing is this fraction of the window radius
# (8 µm for 15 µm windows: every point within 13.9 µm of a centre).
TILE_FRACTION = 8 / 15
REDUCE_UM = 0.5  # pooled scores keep their best point per cell of this size
SUPPORT_RADIUS_UM = 2.0  # an open end's support: above-threshold points this close to its peak
NMS_RADIUS_UM = 5.0  # open ends closer than this to a stronger one are dropped


def params() -> dict:
    """The scan's constants, for the record (invariant 9)."""
    return {"tile_sample_um": TILE_SAMPLE_UM, "tile_fraction": TILE_FRACTION, "reduce_um": REDUCE_UM,
            "support_radius_um": SUPPORT_RADIUS_UM, "nms_radius_um": NMS_RADIUS_UM}


def _cell_ids(cells: np.ndarray) -> np.ndarray:
    """One int64 per integer grid cell (rows of `cells`), for grouping
    without np.unique(axis=0), which sorts rows and is ~3x slower."""
    c = cells - cells.min(axis=0)
    return np.ravel_multi_index(c.T, c.max(axis=0) + 1)


def _best_per_cell(cells: np.ndarray, key: np.ndarray) -> np.ndarray:
    """Indices of the row with the lowest `key` in each grid cell."""
    _, inv = np.unique(_cell_ids(cells), return_inverse=True)
    order = np.lexsort((key, inv))
    return order[np.r_[True, np.diff(inv[order]) != 0]]


def tile_centres(points_um: np.ndarray, spacing_um: float) -> np.ndarray:
    """Indices of surface points to centre windows on: one per occupied
    `spacing_um` grid cell, the point nearest that cell's centre. Every
    point lies within spacing * sqrt(3) of its cell's centre point."""
    p = np.asarray(points_um, np.float64)
    if not len(p):
        return np.zeros(0, np.int64)
    cell = np.floor(p / spacing_um).astype(np.int64)
    return np.sort(_best_per_cell(cell, np.linalg.norm(p - (cell + 0.5) * spacing_um, axis=1)))


class FaceGrid:
    """Faces of a mesh binned by centroid (cell = `cell_nm`), to find a
    window's faces without scanning the whole mesh."""

    def __init__(self, v_nm: np.ndarray, f: np.ndarray, cell_nm: float):
        self.v, self.f, self.cell = np.asarray(v_nm, np.float64), np.asarray(f, np.int64), float(cell_nm)
        key = np.floor(self.v[self.f].mean(axis=1) / self.cell).astype(np.int64)
        keys, inv = np.unique(key, axis=0, return_inverse=True)
        inv = inv.ravel()
        self.order = np.argsort(inv, kind="stable")
        self.start = np.searchsorted(inv[self.order], np.arange(len(keys) + 1))
        self.lookup = {tuple(k): i for i, k in enumerate(keys)}

    def crop(self, centre_nm, radius_nm: float):
        """canonical.crop_faces of the whole mesh, at the cost of the window:
        only the 27 cells' faces and their vertices are looked at (same
        result: vertices keep their relative order)."""
        u, inv = np.unique(self.near(centre_nm), return_inverse=True)
        return canonical.crop_faces(self.v[u], inv.reshape(-1, 3), centre_nm, radius_nm)

    def near(self, centre_nm) -> np.ndarray:
        """Faces whose centroid lies in the 27 cells around the centre (a
        superset of those within one cell of it), in mesh order."""
        c = np.floor(np.asarray(centre_nm, np.float64) / self.cell).astype(np.int64)
        idx = [self.order[self.start[i]:self.start[i + 1]]
               for o in np.ndindex(3, 3, 3) if (i := self.lookup.get(tuple(c + np.array(o) - 1))) is not None]
        # in mesh order, so a crop of them equals crop_faces of the whole mesh, face order included
        return self.f[np.sort(np.concatenate(idx))] if idx else np.zeros((0, 3), np.int64)


def centres(v_nm: np.ndarray, f: np.ndarray, radius_um: float, rng: np.random.Generator) -> np.ndarray:
    """Window centres (nm) tiling a mesh's surface for windows of `radius_um`."""
    surf = canonical.sample_surface(v_nm, f, TILE_SAMPLE_UM, rng)[0]
    return surf[tile_centres(surf / 1000.0, radius_um * TILE_FRACTION)]


class Scan:
    """The windows tiling one mesh, as a sequence: scan[i] is window i
    (window(); None if empty), from its own rng stream [seed, i], so the
    windows do not depend on batching or worker order. A map-style dataset
    for a torch DataLoader as is."""

    def __init__(self, v_nm, f, radius_um: float, spacing_um: float, n_points: int, use_normals: bool, seed: int):
        self.grid = FaceGrid(v_nm, f, radius_um * 1000)
        self.centres = centres(self.grid.v, self.grid.f, radius_um, np.random.default_rng(seed))
        self.args, self.seed = (radius_um, spacing_um, n_points, use_normals), seed

    def __len__(self):
        return len(self.centres)

    def __getitem__(self, i):
        return window(self.grid, self.centres[i], *self.args, np.random.default_rng([self.seed, i]))


def window(grid: FaceGrid, centre_nm, radius_um: float, spacing_um: float, n_points: int, use_normals: bool,
           rng: np.random.Generator):
    """(points, feats, absolute nm of the selected points) of one window, as
    the model takes them; None if the window holds no surface."""
    if grid.cell < radius_um * 1000:  # FaceGrid.crop sees one cell around the centre: it would miss faces
        raise ValueError(f"FaceGrid cell {grid.cell} nm is smaller than the window radius {radius_um} µm")
    p, n, part =canonical.sample_parts([grid.crop(centre_nm, radius_um * 1000)], centre_nm, spacing_um, rng)
    if not len(p):
        return None
    pts, feats, sel = canonical.window_input(p, n if use_normals else None, part, n_points, rng)
    return pts, feats, p[sel].astype(np.float64) * 1000 + np.asarray(centre_nm, np.float64)


def reduce_max(points_nm: np.ndarray, scores: np.ndarray, cell_um: float = REDUCE_UM):
    """(points, scores): the best-scoring point per `cell_um` cell. Pooled
    scores from overlapping windows shrink about 100x before peak picking."""
    p, s = np.asarray(points_nm, np.float64), np.asarray(scores, np.float64)
    if not len(p):
        return p.reshape(0, 3), s
    best = _best_per_cell(np.floor(p / (cell_um * 1000)).astype(np.int64), -s)
    return p[best], s[best]


def open_ends(points_nm: np.ndarray, scores: np.ndarray, threshold: float = -np.inf, top: int = 20,
              support_um: float = SUPPORT_RADIUS_UM, nms_um: float = NMS_RADIUS_UM) -> dict:
    """Open ends by greedy peak picking over pooled per-point logits: the
    best remaining point above `threshold` is an open end, points within
    `nms_um` of it drop out, repeat until `top`. Peaks, not connected
    regions: above-threshold points form large patches that would merge
    distinct open ends. Returns arrays: points_nm (k x 3), score, n_points
    (above-threshold points within `support_um` of the peak)."""
    p, s = np.asarray(points_nm, np.float64) / 1000.0, np.asarray(scores, np.float64)
    keep = s > threshold
    order = np.argsort(-s[keep], kind="stable")
    p, s = p[keep][order], s[keep][order]
    alive = np.ones(len(p), bool)
    peaks, best, support, i = [], [], [], 0
    while len(peaks) < top:
        while i < len(p) and not alive[i]:
            i += 1
        if i == len(p):
            break
        d = np.linalg.norm(p - p[i], axis=1)
        peaks.append(p[i] * 1000.0)
        best.append(s[i])
        support.append(int((d <= support_um).sum()))
        alive &= d > nms_um
    return {"points_nm": np.reshape(peaks, (-1, 3)), "score": np.asarray(best),
            "n_points": np.asarray(support, np.int64)}
