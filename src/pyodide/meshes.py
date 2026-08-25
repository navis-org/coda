"""Mesh repair and simplification, as Coda asks for it.

The fifth capability on the bridge, and the same two packages again — everything here is in
the wheel Coda already pins, so on a runtime that has scored or resampled anything this costs
a `runPython` of one file.

Four operations, all optional, applied in this order:

1. **drop internals** — strip the invaginated surface an EM mesh keeps on its inside and cap
   what that opens. First, because it is the only one that reads the *original* geometry: it
   fires rays off every face and asks whether they escape, which a decimated or smoothed mesh
   answers differently. It is also by far the most expensive, which is the trade the node's
   card has to state rather than discover.
2. **fill holes** — cap whatever openings are left, including the ones the mesh arrived with.
   After (1) because that one already caps what it cuts; what is left here is a neurite
   truncated at the edge of the dataset, or a fragment that was never closed.
3. **downsample** — quadric decimation to a fraction of the faces.
4. **smooth** — Taubin, Laplacian or Humphrey. Last, and after the decimation rather than
   before it: smoothing moves vertices and changes neither the face count nor the vertex
   order, so running it on the decimated mesh costs a fraction of the work for the same
   result, and the face budget the user asked for is still what comes out.

## The argument order is not the same for all four

`drop_internals(vertices, faces)` and `openness(vertices, faces)` take the vertices first;
`simplify_mesh(faces, vertices)`, `smooth_mesh(faces, vertices)` and `boundary_halfedges(faces)`
take the faces first. Both are fastcore's own conventions and neither is going to change.
Swapped, `simplify_mesh` does not fail — it reads a `(V, 3)` float array as faces, and either
raises about a dtype it cannot cast or returns a mesh made of nothing. Worth naming here,
because every call below is one transposition away from a plausible wrong answer.

## Winding

`drop_internals` fires its rays into the hemisphere each face's normal points into, so a mesh
wound *inward* reads as entirely buried and comes back empty, and one wound *inconsistently*
fails quietly — the faces that disagree read as buried and are cut out of healthy membrane.
Coda's meshes arrive outward-wound from every source, and the one operation that would reverse
that (`mirrorGeometry`) reverses each triple straight back. Nothing here checks, because there
is nothing cheap to check *against*: an inconsistently wound mesh is not detectable from the
faces alone, only from a volume that comes out wrong.
"""

import numpy as np
import navis_fastcore as fc


def _fill_holes(vertices, faces):
    """Cap every boundary ring, returning the faces with the caps appended.

    Three fastcore calls, and they are separate functions rather than one because each is
    useful on its own — the boundary-edge count is how `drop_internals` knows a threshold has
    started outrunning its capping. Here they are always used together.

    A mesh with no boundary edges at all — a closed one — short-circuits, which is not just an
    optimisation: `trace_loops` on an empty half-edge array is a walk with nothing to walk.
    """
    halfedges = np.asarray(fc.boundary_halfedges(faces))
    if len(halfedges) == 0:
        return faces

    rings, offsets = fc.trace_loops(halfedges)
    rings = np.asarray(rings)
    if len(rings) == 0:
        return faces

    caps = np.asarray(fc.triangulate_rings(rings, offsets, vertices))
    if len(caps) == 0:
        return faces
    # The caps index the same vertices — `triangulate_rings` re-uses the ones already on the
    # boundary and mints none — so this is a face append and nothing else.
    return np.ascontiguousarray(np.vstack([faces, caps]), dtype=np.uint32)


def _clean_one(vertices, faces, opts):
    """One mesh through the pipeline. Vertices float64, faces uint32.

    Returns `(vertices, faces)`. Either may be empty: decimating a small disconnected
    fragment to a tight budget consumes it entirely, and `drop_internals` on an
    inward-wound mesh reads every face as buried. Both are handed back as they are — an
    empty mesh is an honest answer to what was asked, and the caller counts what it lost.
    """
    if opts["dropInternals"] and len(faces) > 0:
        vertices, faces, _keep, _passes = fc.drop_internals(
            vertices,
            faces,
            threshold=opts["openness"],
            n_rays=opts["rays"],
            iterations=opts["passes"],
        )
        vertices = np.ascontiguousarray(vertices, dtype=np.float64)
        faces = np.ascontiguousarray(faces, dtype=np.uint32)

    if opts["fillHoles"] and len(faces) > 0:
        faces = _fill_holes(vertices, faces)

    ratio = opts["ratio"]
    if ratio < 1.0 and len(faces) > 0:
        vertices, faces, _vertex_map = fc.simplify_mesh(faces, vertices, ratio=ratio)
        vertices = np.ascontiguousarray(vertices, dtype=np.float64)
        faces = np.ascontiguousarray(faces, dtype=np.uint32)

    if opts["smooth"] > 0 and len(faces) > 0:
        # `preserve_border=True` unconditionally. Without it an open mesh's rim rolls inwards
        # under any of these filters — a boundary vertex's one-ring lies entirely to one side
        # of it — and a neuron mesh cut at the edge of a dataset is open by construction. It
        # is also a no-op on a mesh that has no boundary, which is the case Fill holes leaves.
        vertices = np.ascontiguousarray(
            fc.smooth_mesh(
                faces,
                vertices,
                method=opts["method"],
                iterations=opts["smooth"],
                weights="cotangent",
                preserve_border=True,
                volume_correction=opts["volumeCorrection"],
            ),
            dtype=np.float64,
        )

    return vertices, faces


def coda_clean_meshes(request, report=None):
    """A whole set of meshes through the pipeline, in one crossing.

    Flat in and flat out, `skeletons.py`'s arrangement: every mesh's vertices after the last,
    every mesh's faces after the last, and two offset arrays saying where each begins. Face
    indices are **mesh-local** on both sides — `MeshGeometry.indices` indexes that item's own
    `positions` — so nothing is re-based here in either direction.

    Both counts change, which is why both offset arrays are rebuilt rather than reused.

    **The item count never changes**, for the reason `coda_clean_skeletons` records: a
    `MeshesValue` promises one attribute row per item in the same order, so a mesh that
    decimated away to nothing stays in the collection as an empty one rather than shifting
    every label after it onto the wrong neuron.
    """
    req = request.to_py()

    verts = np.frombuffer(req["positions"], dtype=np.float32).reshape(-1, 3).astype(np.float64)
    faces = np.frombuffer(req["indices"], dtype=np.uint32).reshape(-1, 3)
    voff = np.frombuffer(req["vertexOffsets"], dtype=np.int32)
    foff = np.frombuffer(req["faceOffsets"], dtype=np.int32)
    count = len(voff) - 1

    opts = {
        "dropInternals": bool(req["dropInternals"]),
        "openness": float(req["openness"]),
        "rays": int(req["rays"]),
        "passes": int(req["passes"]),
        "fillHoles": bool(req["fillHoles"]),
        "ratio": float(req["ratio"]),
        "smooth": int(req["smooth"]),
        "method": str(req["method"]),
        "volumeCorrection": bool(req["volumeCorrection"]),
    }

    out_verts = []
    out_faces = []
    vertex_offsets = [0]
    face_offsets = [0]
    v_at = 0
    f_at = 0

    for i in range(count):
        va, vb = int(voff[i]), int(voff[i + 1])
        fa, fb = int(foff[i]), int(foff[i + 1])
        if vb > va:
            v, f = _clean_one(
                np.ascontiguousarray(verts[va:vb]),
                np.ascontiguousarray(faces[fa:fb], dtype=np.uint32),
                opts,
            )
            out_verts.append(v)
            out_faces.append(f)
            v_at += len(v)
            f_at += len(f)
        vertex_offsets.append(v_at)
        face_offsets.append(f_at)
        if report is not None:
            report((i + 1) / max(1, count), f"{i + 1} of {count} meshes")

    def joined(parts, dtype):
        # Cast during the concatenate rather than after it — see `skeletons.py` for the size
        # of the temporary that saves.
        if not parts:
            return np.zeros(0, dtype=dtype)
        return np.concatenate(parts, dtype=dtype).ravel()

    return {
        # float32 vertices and uint32 faces, which is what the geometry buffers on the other
        # side already are. fastcore works in float64 throughout and the narrowing happens
        # here rather than doubling what crosses the bridge.
        "positions": joined(out_verts, np.float32),
        "indices": joined(out_faces, np.uint32),
        "vertexOffsets": np.ascontiguousarray(vertex_offsets, dtype=np.int32),
        "faceOffsets": np.ascontiguousarray(face_offsets, dtype=np.int32),
    }
