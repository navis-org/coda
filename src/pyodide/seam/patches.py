"""Cutting the assessor's input patches from box arrays (numpy-only,
invariant 11: the same code would run in a browser worker).

A patch follows flyCLR's input contract: 129³ voxels at PATCH_NM (32 nm,
flyCLR's) unless the build picks another (16 nm for tiny pieces, big-ideas
§15), axes (X, Y, Z), uint8 EM zeroed outside the object(s). The xy grid is
the box's own (its resolution is the patch's), centred on the voxel that
holds the centre point; Aedes sections are 45 nm, so z is resampled to the
same spacing: EM linearly, labels by nearest slice. The box labels come
from seam.service.box_labels, which labels supervoxels with label_box here.

The mask assessor (sa2_mask: no EM) needs only this file and a box of
supervoxels with each object's leaves: patch_box (the box), label_box (its
labels), pair_sides (the patch). Coda's browser scorer vendors it whole
(invariant 11); scripts/export_assessor.py checks the chain end to end.
"""
import numpy as np


PATCH = 129
PATCH_NM = 32.0  # the default patch resolution (flyCLR's); a build may choose another (segclr_build --patch_nm)
MARGIN_NM = 200.0  # a patch box's margin past the patch's half-width, each side (sites.plan_boxes)


def planes_nm(center_z_nm: float, res, size: int) -> np.ndarray:
    """The z (nm) of each of a patch's `size` resampled planes around `center_z_nm`, at the xy spacing res[0]."""
    return center_z_nm + (np.arange(size) - size // 2) * res[0]


def label_sections(planes: np.ndarray, res) -> np.ndarray:
    """The absolute section each plane at z `planes` (nm) takes its labels from: the one that holds it (the
    nearest section centre; a plane on the boundary takes the upper section). Absolute, so a patch is the same
    from any box that holds it, and a floor, so there is no tie for a port to break another way."""
    return np.floor(planes / res[2]).astype(np.int64)


def sample(em, lab, lo, res, center_nm, size: int = PATCH):
    """(EM float32, labels uint8), each (size, size, size): 129 for a pair
    patch, larger for a scene window (scene_window), around `center_nm`
    from box arrays `em` and `lab` whose voxel [0, 0, 0] is absolute voxel
    `lo` at resolution `res` (nm): xy on the box's grid, z resampled to the
    same spacing. None if the patch leaves the box. `em` None: labels only
    (the mask assessor reads no EM), returned as (None, labels)."""
    if res[0] != res[1]:
        raise ValueError(f"the box's xy resolution {res[:2]} is not square")
    x0 = int(np.floor(center_nm[0] / res[0])) - lo[0] - size // 2
    y0 = int(np.floor(center_nm[1] / res[1])) - lo[1] - size // 2
    planes = planes_nm(center_nm[2], res, size)
    zf = planes / res[2] - 0.5 - lo[2]  # in the box's sections (voxel centres)
    z0 = np.floor(zf).astype(np.int64)
    w = (zf - z0).astype(np.float32)
    zn = label_sections(planes, res) - lo[2]
    sx, sy, sz = lab.shape
    if x0 < 0 or y0 < 0 or z0[0] < 0 or x0 + size > sx or y0 + size > sy or z0[-1] + 1 >= sz:
        return None
    labs = lab[x0 : x0 + size, y0 : y0 + size][:, :, zn]
    if em is None:
        return None, labs
    sub = em[x0 : x0 + size, y0 : y0 + size]
    return sub[:, :, z0] * (1 - w) + sub[:, :, z0 + 1] * w, labs


def pair_patch(em, lab, lo, res, center_nm, kq, kc):
    """The assessor's input for objects kq (Q) and kc (C) of `lab`: EM
    masked by Q ∪ C (uint8) and labels 1 = Q, 2 = C, 0 = neither (uint8);
    None if the patch leaves the box."""
    got = sample(em, lab, lo, res, center_nm)
    if got is None:
        return None
    e, labs = got
    two = side_labels(labs, kq, [kc])
    return masked_em(e, two), two


def pair_sides(lab, lo, res, center_nm, kq, kc):
    """The mask assessor's input for objects kq (Q) and kc (C) of `lab`: pair_patch's labels exactly (1 = Q,
    2 = C, 0 = neither, uint8, axes X, Y, Z), without reading any EM; None if the patch leaves the box."""
    got = sample(None, lab, lo, res, center_nm)
    return None if got is None else side_labels(got[1], kq, [kc])


def patch_box(centres_nm, res, size: int = PATCH):
    """(lo, hi): the voxel box [lo, hi) at `res` (nm) that holds the patch of every centre in `centres_nm`
    ((N, 3) or (3,), nm), MARGIN_NM to spare. A patch is cut from absolute voxels, so any box that holds it
    gives the same patch: one box per patch (a browser, one tip at a time) or one per group (the cluster)."""
    c = np.atleast_2d(np.asarray(centres_nm, np.float64))
    pad = size * res[0] / 2 + MARGIN_NM  # the patch's half-width in nm (z resampled to the xy spacing)
    return np.floor((c.min(0) - pad) / res).astype(np.int64), np.ceil((c.max(0) + pad) / res).astype(np.int64)


def _renumber(sv):
    """(per-voxel index into `keys`, keys, each key's index): the box's distinct supervoxels as small integers,
    numpy only. service.box_labels passes fastremap's faster equivalent."""
    keys, small = np.unique(sv, return_inverse=True)
    return small.reshape(sv.shape), keys.astype(np.uint64), np.arange(len(keys))


def label_box(sv, leaves, every: bool = True, renumber=None):
    """Labels (uint8, sv's shape; 1-based index into `leaves`, 0 = none) of a box of supervoxels `sv`: each
    supervoxel labelled by the object whose leaves hold it. `leaves`: per object (Q first, then each C), its
    supervoxel IDs (uint64, e.g. get_leaves within the box). Raises if two objects share a supervoxel, or if an
    object shows no voxel in the box (a missing chunk reads as 0: the patch would lose an object without a
    word); with `every` False only an object whose leaves lie in the box but show no voxel raises (a scene
    window's absent candidates are counted by the caller). `renumber`: _renumber's contract (default numpy)."""
    if not len(leaves) or len(leaves) > 255:
        raise ValueError(f"{len(leaves)} objects in one box (labels are uint8, at least one object)")
    # a repeat within an object is no overlap; 0 is no supervoxel (fastremap always maps it, numpy only when the
    # box holds a 0: dropped, both renumberings give the same answer)
    leaves = [(u := np.unique(np.asarray(x, np.uint64)))[u != 0] for x in leaves]
    ids = np.concatenate(leaves)
    labs = np.repeat(np.arange(1, len(leaves) + 1, dtype=np.uint8), [len(x) for x in leaves])
    order = np.argsort(ids)
    ids, labs = ids[order], labs[order]
    if (ids[1:] == ids[:-1]).any():
        raise ValueError("a supervoxel belongs to two roots: the roots overlap")
    small, keys, new = (renumber or _renumber)(sv)
    lut = np.zeros(int(new.max()) + 1 if len(new) else 1, np.uint8)
    if len(ids):
        k = np.minimum(np.searchsorted(ids, keys), len(ids) - 1)
        lut[new] = np.where(ids[k] == keys, labs[k], 0)
    shown = set(lut[new].tolist()) - {0}
    missing = [i for i, x in enumerate(leaves, start=1) if i not in shown and (every or len(x))]
    if missing:
        raise ValueError(f"{len(missing)} of {len(leaves)} objects have no voxel in the box (a missing segmentation chunk?)")
    return lut[small]


def flip_draw(rng, permute: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """The training augmentation's random draw: (the axes to flip, each with probability 1/2; the new axis order,
    random when `permute`). data.augment (pair patches) and scenes.augment_window (windows) both draw it here."""
    return tuple(np.flatnonzero(rng.random(3) < 0.5)), (rng.permutation(3) if permute else np.arange(3))


def side_table(q: int, cands) -> np.ndarray:
    """The 256-entry uint8 table from label values to the assessor's sides: 1 for `q`, 2 for each of `cands`,
    0 for the rest (indexable by a numpy array or, as a tensor, by a torch one)."""
    lut = np.zeros(256, np.uint8)
    lut[q] = 1
    lut[np.asarray(cands, np.int64)] = 2
    return lut


def side_labels(lab, q: int, cands):
    """`lab` (uint8) as the assessor's sides (side_table): a pair patch's C, or a scene window's shown
    candidates."""
    return side_table(q, cands)[lab]


def masked_em(e, labels):
    """The resampled EM `e` (float) as uint8, zeroed where `labels` is 0 (outside the objects shown)."""
    return np.where(labels > 0, np.round(e), 0).astype(np.uint8)


def scene_window(em, lab, lo, res, center_nm, size: int):
    """A scene window (big-ideas §2, the one-pass scene scorer): the EM masked to every labelled object (uint8)
    and the labels themselves (uint8: 1 = Q, then one value per candidate), each (size, size, size) around
    `center_nm`, from box arrays as for sample(); None if the window leaves the box."""
    got = sample(em, lab, lo, res, center_nm, size)
    return None if got is None else (masked_em(got[0], got[1]), got[1])


def window_voxel(points_nm, center_nm, res, size: int):
    """(N, 3) int voxel indices of `points_nm` in the window sample() cuts around `center_nm` (from any box
    holding it), -1 rows for points outside it. xy: the grid at `res`. z: of the resampled planes whose label
    sample() takes from the section holding the point (label_sections), the one nearest it; a plane nearer the
    point can read the next section."""
    p, c = np.atleast_2d(np.asarray(points_nm, np.float64)), np.asarray(center_nm, np.float64)
    xy = np.floor(p[:, :2] / res[0]) - np.floor(c[:2] / res[0]) + size // 2
    planes = planes_nm(c[2], res, size)
    plane_sec = label_sections(planes, res)  # the section each plane's label comes from
    sec = np.floor(p[:, 2] / res[2])
    dist = np.where(plane_sec[None, :] == sec[:, None], np.abs(planes[None, :] - p[:, 2:3]), np.inf)
    k = np.where(np.isfinite(dist).any(axis=1), dist.argmin(axis=1), -1)
    v = np.c_[xy, k].astype(np.int64)
    v[~((v >= 0) & (v < size)).all(axis=1)] = -1
    return v
