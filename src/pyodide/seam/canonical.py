"""The canonical model input: mesh-surface points in a fixed physical window.

numpy only (docs/invariants.md rule 11): this module must run unchanged in
CPython for training and in Coda's Pyodide worker for in-browser inference.
Everything that fetches lives elsewhere (seam.geometry).

Units: inputs in nm (as meshes come from CloudVolume), outputs in µm relative
to the window centre.
"""

from __future__ import annotations

import numpy as np

NM_PER_UM = 1000.0

# Spacing must be coarser than the coarsest mesh we ingest: median mesh edge
# length is 136 nm on FlyWire public and 65 nm on Aedes (docs/data.md). The
# value itself is a P2 sweep parameter.
DEFAULT_SPACING_UM = 0.2

# Model input (shared by training and inference, docs/invariants.md rule 3):
# coordinates divided by SCALE_UM (split_learning's mesh-checkpoint scale, so
# its encoder can initialise ours; docs/models.md), a fixed number of points,
# and every piece of the window represented.
SCALE_UM = 50.2864
MIN_PER_PART = 16


def random_rotations(rng: np.random.Generator, n: int) -> np.ndarray:
    """`n` uniform random rotation matrices (n, 3, 3), from unit quaternions.
    The augmentation of every model that rotates its windows (Model A/B/E
    training, MoGen completion)."""
    q = rng.normal(size=(n, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    w, x, y, z = q.T
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
                     np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
                     np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1)], 1)


def crop_faces(vertices: np.ndarray, faces: np.ndarray, center_nm, radius_nm: float):
    """Keep the faces whose centroid lies within `radius_nm` of the centre
    (a sphere: rotation-invariant, unlike a box). Returns (vertices, faces)
    with unused vertices dropped."""
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(f) == 0:
        return v[:0], f
    cen = v[f].mean(axis=1)
    keep = np.sum((cen - np.asarray(center_nm, dtype=np.float64)) ** 2, axis=1) <= radius_nm**2
    f = f[keep]
    # compact the vertices with an O(n) remap (np.unique would sort 3F indices)
    used = np.zeros(len(v), dtype=bool)
    used[f.ravel()] = True
    remap = np.cumsum(used) - 1
    return v[used], remap[f]


def face_areas_normals(vertices: np.ndarray, faces: np.ndarray):
    tri = vertices[faces]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    norm = np.linalg.norm(cross, axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        normals = np.where(norm[:, None] > 0, cross / norm[:, None], 0.0)
    return 0.5 * norm, normals


def sample_surface(vertices: np.ndarray, faces: np.ndarray, spacing_um: float = DEFAULT_SPACING_UM,
                   rng: np.random.Generator | None = None):
    """Area-uniform random points on the mesh surface, about one per
    `spacing_um`² of area, so density is a physical constant whatever the
    mesh resolution. Returns (points_nm, normals, face_index)."""
    rng = np.random.default_rng() if rng is None else rng
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(f) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0, dtype=np.int64)
    area, normals = face_areas_normals(v, f)
    total = area.sum()
    n = int(rng.poisson(total / (spacing_um * NM_PER_UM) ** 2)) if total > 0 else 0
    if n == 0:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0, dtype=np.int64)
    fi = rng.choice(len(f), size=n, p=area / total)
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    w = np.stack([1 - s, s * (1 - r2), s * r2], axis=1)
    pts = np.einsum("ij,ijk->ik", w, v[f[fi]])
    return pts, normals[fi], fi


def to_window_frame(points_nm: np.ndarray, center_nm) -> np.ndarray:
    """nm, absolute -> µm relative to the window centre (no absolute pose)."""
    return ((np.asarray(points_nm) - np.asarray(center_nm, dtype=np.float64)) / NM_PER_UM).astype(np.float32)


def subsample(part: np.ndarray, n: int, rng: np.random.Generator, min_per_part: int = MIN_PER_PART) -> np.ndarray:
    """Indices of exactly `n` points of a window whose points belong to
    pieces `part`. Each piece keeps min(its size, min_per_part) points, so a
    small fragment cannot vanish from the input while the window keeps its
    label; the rest are drawn uniformly without replacement. Windows with
    fewer than `n` points keep every point once and repeat random ones."""
    N = len(part)
    if N <= n:
        return np.concatenate([np.arange(N), rng.choice(N, n - N)]) if N else np.zeros(0, np.int64)
    must = np.concatenate([rng.choice(idx, min(len(idx), min_per_part), replace=False)
                           for idx in (np.flatnonzero(part == p) for p in np.unique(part))])
    if len(must) >= n:  # tiny n (tests): the guaranteed points alone fill it
        return rng.choice(must, n, replace=False)
    free = np.ones(N, bool)
    free[must] = False
    return rng.permutation(np.concatenate([must, rng.choice(np.flatnonzero(free), n - len(must), replace=False)]))


def model_input(points_um: np.ndarray, normals: np.ndarray | None, sel: np.ndarray):
    """(points, features) as the model takes them: the selected window
    points divided by SCALE_UM, and their normals (zeros if None)."""
    pts = np.asarray(points_um)[sel].astype(np.float32) / np.float32(SCALE_UM)
    nrm = np.zeros_like(pts) if normals is None else np.asarray(normals)[sel].astype(np.float32)
    return pts, nrm


def sample_parts(meshes, center_nm, spacing_um: float, rng: np.random.Generator):
    """A window's stored form, as builds save it: each (vertices_nm, faces)
    of `meshes` (already cropped to the window) sampled as surface points
    in order from one `rng`, labelled by its index. Returns (points µm in
    the window frame, normals float16, part int8). The one sampler of
    training builds (windows.sample_window) and scans (scan.window)."""
    pts, nrm, part = [], [], []
    for i, (v, f) in enumerate(meshes):
        p, n, _ = sample_surface(v, f, spacing_um, rng)
        pts.append(to_window_frame(p, center_nm))
        nrm.append(n.astype(np.float16))
        part.append(np.full(len(p), i, dtype=np.int8))
    return np.concatenate(pts), np.concatenate(nrm), np.concatenate(part)


def first_occurrence(sel: np.ndarray) -> np.ndarray:
    """(n,) int64: for each selected point, the position of its first
    occurrence in `sel` (its own position unless it repeats an earlier
    point: the padding of a window with fewer than n points). The model's
    k-NN features use it to count each window point once."""
    _, first, inv = np.unique(sel, return_index=True, return_inverse=True)
    return first[inv.ravel()].astype(np.int64)


def window_input(points_um: np.ndarray, normals: np.ndarray | None, part: np.ndarray, n: int,
                 rng: np.random.Generator):
    """(points, features, sel): a stored window as the model takes it,
    subsampled to `n` points (subsample) then scaled (model_input). The one
    path from a stored window to model input, for training
    (data.Windows) and scans (scan.window); augmentation is added on top."""
    sel = subsample(part, n, rng)
    return (*model_input(points_um, normals, sel), sel)
