"""Check Coda's wavefront skeletonization against skeletor, node for node.

`pnpm probe:skeletonize-parity`. Needs `skeletor` and `navis-fastcore` installed locally; a probe rather
than a test for `probe-split.py`'s reason — vitest has no Python, and a fixture would pin whatever
this file happened to produce rather than what skeletor produces.

`src/pyodide/skeletonize.py` is skeletor's fastcore path with pandas and trimesh cut out, so the
two should agree on every node: positions exactly, parents exactly, radii to the last bit or so
(pandas' groupby mean is Kahan-summed, numpy's bincount is not). `fastremap` is blocked before
skeletor is imported, because Pyodide has none and skeletor otherwise merges vertices into nodes
with its `unique` rather than numpy's.

Run against skeletor 1.3.x / navis-fastcore 0.13.0, on skeletor's bundled example mesh.
"""

import importlib.util
import json
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd
import scipy.sparse
import scipy.sparse.csgraph

sys.modules["fastremap"] = None  # as in Pyodide: skeletor falls back to numpy

import navis_fastcore as fc

try:
    import skeletor as sk
except ImportError:  # pragma: no cover - the probe is opt-in
    sys.exit("skeletor is not installed; `pip install skeletor` to run this probe")

spec = importlib.util.spec_from_file_location("coda_skeletonize", "src/pyodide/skeletonize.py")
coda = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coda)

# The defaults first, then a row per knob the node exposes — a knob nobody checks against the
# reference agrees with it only at its default.
SETTINGS = [
    dict(waves=1, step_size=1, radius_agg="mean"),
    dict(waves=3, step_size=1, radius_agg="mean"),
    dict(waves=1, step_size=2, radius_agg="mean"),
    dict(waves=2, step_size=3, radius_agg="median"),
    dict(waves=1, step_size=1, radius_agg="max"),
    dict(waves=1, step_size=1, radius_agg="min"),
    dict(waves=2, step_size=1, radius_agg="percentile75"),
]


def flat_request(meshes, waves, step_size, radius_agg):
    """`coda_skeletonize_meshes`' request, built the way `meshes.ts` flattens a set."""
    vertex_offsets, face_offsets = [0], [0]
    for v, f in meshes:
        vertex_offsets.append(vertex_offsets[-1] + len(v))
        face_offsets.append(face_offsets[-1] + len(f))
    # What `request` is on the worker: a proxy whose `to_py()` gives the dict.
    return SimpleNamespace(
        to_py=lambda: {
            "positions": np.concatenate([v for v, _ in meshes]).astype(np.float32).tobytes(),
            "indices": np.concatenate([f for _, f in meshes]).astype(np.uint32).tobytes(),
            "vertexOffsets": np.asarray(vertex_offsets, dtype=np.int32).tobytes(),
            "faceOffsets": np.asarray(face_offsets, dtype=np.int32).tobytes(),
            "waves": waves,
            "stepSize": step_size,
            "radiusAgg": radius_agg,
            "minFragment": 0,
            "shave": "off",
            "shaveCutoff": 1000.0,
            "fixZeroRadii": False,
            "somaPositions": np.full(len(meshes) * 3, np.nan, dtype=np.float32).tobytes(),
            "somaCleanup": False,
            "somaRadius": 3000.0,
            "detectSoma": False,
            "minSomaRadius": 1000.0,
        }
    )


mesh = sk.example_mesh()
# Through float32, which is what crosses the bridge, so both sides start from the same numbers.
verts = np.asarray(mesh.vertices, dtype=np.float32).astype(np.float64)
faces = np.asarray(mesh.faces, dtype=np.uint32)
print(f"example mesh: {len(verts):,} vertices, {len(faces):,} faces")

failed = False
results = []
for opts in SETTINGS:
    ref = sk.skeletonize.by_wavefront((verts, faces), progress=False, **opts).swc
    ref_xyz = ref[["x", "y", "z"]].to_numpy()
    ref_r = ref["radius"].to_numpy()
    ref_p = ref["parent_id"].to_numpy()

    xyz, r, p, _ = coda._skeletonize_one(verts, faces, **opts)

    problems = []
    if len(xyz) != len(ref_xyz):
        problems.append(f"{len(xyz)} nodes against skeletor's {len(ref_xyz)}")
    else:
        if not np.array_equal(p, ref_p):
            problems.append(f"{int((p != ref_p).sum())} parents differ")
        if not np.array_equal(xyz, ref_xyz):
            problems.append(f"positions differ by up to {np.abs(xyz - ref_xyz).max():.3g}")
        if not np.allclose(r, ref_r, rtol=1e-12, atol=0):
            problems.append(f"radii differ by up to {np.abs(r - ref_r).max():.3g}")

    results.append((xyz, r, p))

    label = ", ".join(f"{k}={v}" for k, v in opts.items())
    if problems:
        failed = True
        print(f"FAIL  {label}: {'; '.join(problems)}")
    else:
        print(f"ok    {label}: {len(xyz):,} nodes, {int((p < 0).sum())} roots")

# The entry point the worker calls, over a set: two copies of the mesh and an empty one between
# them. The empty one must keep its slot, and both copies must come back as the same skeleton.
empty = (np.zeros((0, 3)), np.zeros((0, 3), dtype=np.uint32))
out = coda.coda_skeletonize_meshes(flat_request([(verts, faces), empty, (verts, faces)], **SETTINGS[0]))
offsets = out["offsets"]
default = results[0]
n = len(default[1])
expected = [0, n, n, 2 * n]
if offsets.tolist() != expected:
    failed = True
    print(f"FAIL  entry point: offsets {offsets.tolist()}, expected {expected}")
elif not np.array_equal(out["parents"][:n], out["parents"][n:]):
    failed = True
    print("FAIL  entry point: the two copies came back with different trees")
else:
    print(f"ok    entry point: 3 items in, offsets {offsets.tolist()}, dtypes "
          f"{out['points'].dtype}/{out['radii'].dtype}/{out['parents'].dtype}")


# The two places this departs from skeletor, which the example mesh reaches neither of.
#
# Unreferenced vertices, spliced in before and among the referenced ones: dropping them has to
# leave every component, seed and node exactly as skeletor makes them for the mesh without them.
stray = np.array([[0.0, 0.0, 0.0], [1e6, 1e6, 1e6]])
cut = len(verts) // 2
spliced = np.vstack([stray[:1], verts[:cut], stray[1:], verts[cut:]])
shifted = np.where(faces >= cut, faces + 2, faces + 1).astype(np.uint32)
got = coda._skeletonize_one(spliced, shifted, **SETTINGS[0])[:3]
if all(np.array_equal(a, b) for a, b in zip(got, default)):
    print("ok    unreferenced vertices: dropped, every other node unchanged")
else:
    failed = True
    print("FAIL  unreferenced vertices changed the skeleton")

# A lone triangle at a step size of 2: both of its levels fall in one bin, so the whole mesh is
# one node with no edge to weigh, and skeletor's weight guard raises on the empty array. Here it
# has to come back as a single root.
tri_v = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
tri_f = np.array([[0, 1, 2]], dtype=np.uint32)
try:
    sk.skeletonize.by_wavefront((tri_v, tri_f), step_size=2, progress=False)
    reference = "skeletor did not raise"
except Exception as error:
    reference = f"skeletor raises {type(error).__name__}"
p = coda._skeletonize_one(tri_v, tri_f, 1, 2, "mean")[2]
if p.tolist() == [-1]:
    print(f"ok    one node, no edges: a single root ({reference})")
else:
    failed = True
    print(f"FAIL  one node, no edges: parents {p.tolist()}")

# `minFragment`: every piece below the threshold is removed first, so what is left has to be
# skeletor's answer for the mesh holding only the larger pieces. That mesh is built here with
# scipy rather than fastcore, so the reference does not share the code it checks.
MIN_FRAGMENT = 50
adjacency = scipy.sparse.coo_matrix(
    (np.ones(len(faces) * 3), (faces.ravel(), np.roll(faces, 1, axis=1).ravel())),
    shape=(len(verts), len(verts)),
)
_, labels = scipy.sparse.csgraph.connected_components(adjacency, directed=False)
piece_sizes = np.bincount(labels)
keep_faces = faces[piece_sizes[labels[faces[:, 0]]] >= MIN_FRAGMENT]
kept_vertices = np.unique(keep_faces)
renumber = np.full(len(verts), -1)
renumber[kept_vertices] = np.arange(len(kept_vertices))
ref = sk.skeletonize.by_wavefront(
    (verts[kept_vertices], renumber[keep_faces]), progress=False
).swc
xyz, r, p, _ = coda._skeletonize_one(verts, faces, 1, 1, "mean", MIN_FRAGMENT)
kept_pieces = int((piece_sizes >= MIN_FRAGMENT).sum())
if (
    int((p < 0).sum()) == kept_pieces
    and np.array_equal(p, ref["parent_id"].to_numpy())
    and np.array_equal(xyz, ref[["x", "y", "z"]].to_numpy())
):
    print(
        f"ok    minFragment={MIN_FRAGMENT}: {kept_pieces} of {len(piece_sizes)} pieces kept, "
        f"{len(p):,} nodes, as skeletor on the rest"
    )
else:
    failed = True
    print(f"FAIL  minFragment={MIN_FRAGMENT}: {int((p < 0).sum())} roots for {kept_pieces} pieces kept")

# The notebook's half of the same promise. The exported cell calls skeletor after
# `coda_mesh_pieces`, which restates the clean-up above in the notebook's own code; it is read out
# of the committed golden, so this runs the text a reader actually gets.
cells = json.load(open("src/export/python/__fixtures__/everything.ipynb"))["cells"]
source = next("".join(c["source"]) for c in cells if "def coda_mesh_pieces" in "".join(c["source"]))
start = source.index("def coda_mesh_pieces")
helpers = {"np": np, "fastcore": fc}
exec(source[start : source.index("\n\n\n", source.index("def _coda_compact"))], helpers)
for threshold in (0, MIN_FRAGMENT):
    ref = sk.skeletonize.by_wavefront(
        helpers["coda_mesh_pieces"](verts, faces, min_vertices=threshold), progress=False
    ).swc
    xyz, r, p, _ = coda._skeletonize_one(verts, faces, 1, 1, "mean", threshold)
    if np.array_equal(p, ref["parent_id"].to_numpy()) and np.array_equal(
        xyz, ref[["x", "y", "z"]].to_numpy()
    ):
        print(f"ok    notebook cell, min_vertices={threshold}: skeletor after coda_mesh_pieces agrees")
    else:
        failed = True
        print(f"FAIL  notebook cell, min_vertices={threshold}: skeletor after coda_mesh_pieces differs")

# The notebook's half of the tidy-up: `coda_tidy_skeleton`, read out of the committed golden like
# `coda_mesh_pieces` above, against the module's `_tidy` on the same wavefront — every shave, at a
# cutoff where the thorough rules bite, and on the empty skeleton a mesh with nothing left gives.
start = source.index("def coda_tidy_skeleton")
end = source.index("\n\n\ndef ", source.index("def _coda_shave_thorough"))
tidy_helpers = {"np": np, "pd": pd}
exec(source[start:end], tidy_helpers)
xyz, r, p, _ = coda._skeletonize_one(verts, faces, 1, 1, "mean")
skeleton = pd.DataFrame(
    {"node_id": np.arange(len(p)), "parent_id": p, "x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2], "radius": r}
)
for shave in ("off", "bristles", "thorough"):
    out = tidy_helpers["coda_tidy_skeleton"](skeleton, shave=shave, cutoff=200.0, fix_zero_radii=True)
    want = coda._tidy(xyz, r, p, shave, 200.0, True)[:3]
    if (
        np.array_equal(out[["x", "y", "z"]].to_numpy(), want[0])
        and np.array_equal(out["radius"].to_numpy(), want[1])
        and np.array_equal(out["parent_id"].to_numpy(), want[2])
    ):
        print(f"ok    notebook cell, shave={shave}: coda_tidy_skeleton agrees, {len(out):,} nodes")
    else:
        failed = True
        print(f"FAIL  notebook cell, shave={shave}: coda_tidy_skeleton differs from the module")
empty = pd.DataFrame(columns=["node_id", "parent_id", "x", "y", "z", "radius"])
if len(tidy_helpers["coda_tidy_skeleton"](empty, shave="thorough")) == 0:
    print("ok    notebook cell: an empty skeleton tidies to an empty one")
else:
    failed = True
    print("FAIL  notebook cell: an empty skeleton did not stay empty")

# The tidy-up after the wavefront, each held against the code it was taken from rather than against
# a description of it. Compared as sets of (position, radius, parent position): navis renumbers and
# reorders nodes when it subsets, so rows are not comparable, and these three values are everything
# a skeleton is.
import navis


def node_set(xyz, radii, parents):
    xyz = np.asarray(xyz, dtype=float)
    parent_xyz = np.where(parents[:, None] >= 0, xyz[np.maximum(parents, 0)], np.nan)
    return {
        (tuple(a), round(float(r), 6), tuple(np.nan_to_num(b, nan=-1.0)))
        for a, r, b in zip(xyz, radii, parent_xyz)
    }


def navis_set(neuron):
    nodes = neuron.nodes
    row = {nid: i for i, nid in enumerate(nodes.node_id)}
    parents = np.array([row.get(p, -1) for p in nodes.parent_id])
    return node_set(nodes[["x", "y", "z"]].to_numpy(), nodes.radius.to_numpy(), parents)


mesh_neuron = navis.MeshNeuron((verts, faces), units="1 nm")
for shave, label in ((False, "off"), (True, "bristles")):
    # mesh2skeleton calls skeletor's wavefront, then its shave if asked, then always its radius fix.
    ref = navis_set(navis.conversion.mesh2skeleton(mesh_neuron, shave=shave))
    xyz, r, p, _ = coda._skeletonize_one(verts, faces, 1, 1, "mean")
    got = node_set(*coda._tidy(xyz, r, p, label, 1000.0, True)[:3])
    if got == ref:
        print(f"ok    shave={label} + zero radii: navis mesh2skeleton(shave={shave}), {len(got):,} nodes")
    else:
        failed = True
        print(f"FAIL  shave={label} + zero radii: {len(got ^ ref)} nodes differ from navis")


def fafbseg_shave(tn, cutoff):
    """fafbseg's `skeletonize_neuron(shave_skeleton=True)` block, as written there but for `cutoff`."""
    d = navis.morpho.mmetrics.parent_dist(tn, root_dist=0)
    long = tn.nodes[d >= cutoff].node_id.values
    while True:
        leaf_segs = [seg for seg in tn.small_segments if seg[0] in tn.leafs.node_id.values]
        to_remove = [seg for seg in leaf_segs if any(np.isin(seg, long)) or (len(seg) <= 2)]
        to_remove = [seg for seg in to_remove if len(seg) < 10]
        to_remove = [n for l in to_remove for n in l[:-1]]
        if not len(to_remove):
            break
        navis.subset_neuron(tn, ~tn.nodes.node_id.isin(to_remove), inplace=True)
    bp = tn.nodes.loc[tn.nodes.type == "branch", "node_id"].values
    is_end = tn.nodes.type == "end"
    parent_is_bp = tn.nodes.parent_id.isin(bp)
    twigs = tn.nodes.loc[is_end & parent_is_bp, "node_id"].values
    tn._nodes = tn.nodes.loc[~tn.nodes.node_id.isin(twigs)].copy()
    tn._clear_temp_attr()
    return tn


# fafbseg's own 1 µm, and two cutoffs at which, on this mesh, both the long-edge rule and the
# ten-node cap change the answer — at 1 µm neither does, so it alone would not test them.
swc = sk.skeletonize.by_wavefront((verts, faces), progress=False).swc
xyz, r, p, _ = coda._skeletonize_one(verts, faces, 1, 1, "mean")
for cutoff in (1000.0, 200.0, 150.0):
    ref = navis_set(fafbseg_shave(navis.TreeNeuron(swc.copy(), units="1 nm", soma=None), cutoff))
    got = node_set(*coda._tidy(xyz, r, p, "thorough", cutoff, False)[:3])
    if got == ref:
        print(f"ok    shave=thorough at {cutoff:g} nm: fafbseg's shave loop, {len(got):,} nodes")
    else:
        failed = True
        print(f"FAIL  shave=thorough at {cutoff:g} nm: {len(got ^ ref)} nodes differ from fafbseg's loop")

sys.exit(1 if failed else 0)
