# Adapted from skeletor's wavefront skeletonization (skeletor.skeletonize.wave,
# https://github.com/navis-org/skeletor, GPL-3.0). Contributed to Coda under the
# MIT licence by its copyright holder, Philipp Schlegel.

"""Mesh to skeleton by wavefront, as Coda asks for it.

Another capability on the bridge, and the same two packages again. skeletor itself needs
trimesh, pandas, scipy, networkx, igraph and ncollpyde — about 22 MB on top of the runtime, and
ncollpyde has no wasm build at all. But with navis-fastcore installed, skeletor's wavefront path
calls fastcore for every step that matters, so this file is that path with everything else cut
away: numpy for the bookkeeping, fastcore for the graph work, and nothing to download beyond
what NBLAST already fetched.

## What the algorithm does

A wave is a breadth-first search across the mesh's edges from one seed vertex per connected
component. Vertices the wave reaches at the same hop count, *and* connected to each other, form
a ring; each ring collapses to its centroid, with a radius aggregated from each member's distance
to it. With several waves the per-vertex centres and radii are averaged. Vertices whose averaged
centres coincide become one skeleton node, the mesh's edges are contracted onto the nodes, and a
maximum spanning tree weighted by radius times local straightness (dotprops' alpha) breaks the
cycles — keeping the backbone and cutting at the thin, crooked side branches.

## It answers what skeletor answers

Same seeds (skeletor's `_pick_seeds`, the same RNG and seed, memoised on component size as there),
same fastcore calls in the same order, same tie-breaking. What changes is only what pandas and
trimesh did:

- `_grouped_agg` is numpy rather than a pandas groupby. pandas' mean is Kahan-summed, so a
  radius may differ in the last bit; the median and percentiles interpolate linearly, which is
  pandas' default.
- **Unreferenced vertices are dropped first.** skeletor keeps them, and each becomes a component
  of one and so a lone root node at its own position with a radius of 0. A decimated mesh
  routinely carries them. Dropping them keeps the relative order of the rest, so components,
  seeds and every other node are unchanged.
- **A skeleton with no positive weight does not raise.** skeletor's guard against non-positive
  MST weights takes the minimum of the positive ones, which is an error when there are none: a
  skeleton with no edges — a mesh whose rings all fall into one node, as a lone triangle does at
  a step size of 2 — or one whose edges all weigh 0, which fastcore's dotprops allows by giving
  a degenerate neighbourhood an alpha of 0. With no edges there is nothing to weigh; with no
  positive weight every edge weighs the same.

`scripts/probe-skeletonize.py` holds this against skeletor itself.

## Small fragments

A segmented mesh is often in pieces, and each piece becomes a tree of its own. `minFragment`
removes every piece with fewer vertices than that before anything else runs; 0 or 1 keeps all of
them, which is skeletor's answer. Removing them first rather than pruning their trees afterwards
is what keeps the rest identical to skeletor run on the mesh without them.

## Tidying up after: a shave and the radii

skeletor's answer is the wavefront's, and both navis and fafbseg clean it before handing it on.
`shave` is one of three, nested rather than combined: `bristles` is navis' `mesh2skeleton`
(remove every one-node twig hanging off a branch point), `thorough` is fafbseg's
`skeletonize_neuron` (remove short terminal segments, and ones holding an edge of `cutoff` or
more, until none are left, then the same bristle pass). `fix_zero_radii` is navis' separate fix
for the radius-0 nodes the wavefront leaves, mostly at leaves. All of it is applied after the
wavefront, so with `shave="off"`, the fix off and no soma the answer is still skeletor's. The
`scripts/probe-skeletonize.py` parity checks hold each against navis' own operations.

## The soma

Where the request carries a soma position for a mesh, the node nearest it within the soma radius,
on a tree reaching beyond that radius (`_nearest_row`), is the soma, and its tree is oriented from
it — `parents_from_edges(roots=)`, which roots only that component, so every other fragment is
still skeletor's. With `somaCleanup`, the soma is instead collapsed before nodes are formed
(`_soma_region`, `_wavefront_graph`'s `soma`), after the mesh pieces lying wholly inside the soma
radius are dropped (`_drop_soma_debris`), and the debris around it is shaved (`_tidy`). With no
position and `detectSoma`, the widest node stands in, labelled and rooted at but never collapsed
around. `docs/python-pyodide.md` holds the
measurements behind each of those rules.

## Node ids are row numbers

`parents_from_edges` roots each tree at its lowest node id and hands back the order nodes
settled in, a parent always before its children. Rows are renumbered in that order, so a parent
is a row number — `SkeletonGeometry.parents` — and every root precedes its subtree, which is
what SWC wants too.
"""

import numpy as np
import navis_fastcore as fc

#: The radius aggregations skeletor's `radius_agg` names, as quantiles where one is a quantile.
_QUANTILES = {"median": 0.5, "percentile75": 0.75, "percentile25": 0.25}

#: Neighbours dotprops fits each node's tangent from. skeletor's default.
_DOTPROPS_K = 20

#: skeletor re-seeds numpy's RNG with this before choosing every component's seeds.
_SEED = 1985


def _pick_seeds(size, waves):
    """Wave origins for one component of `size` vertices, as positions within it.

    skeletor's `_pick_seeds` without `origins`: `np.random.seed(1985)` followed by
    `np.random.choice`. A `RandomState` of our own draws the identical stream without reseeding
    the global generator under anything else running in the worker.
    """
    rng = np.random.RandomState(_SEED)
    return rng.choice(np.arange(size), size=min(waves, size), replace=False)


def _group_by_label(labels):
    """Item indices sorted by label (stably), and where each label's run starts and how long it is.

    Never handed an empty array: `_wavefront_graph` returns before anything here runs on a mesh
    with no vertices.
    """
    order = np.argsort(labels, kind="stable")
    srt = labels[order]
    starts = np.flatnonzero(np.r_[True, srt[1:] != srt[:-1]])
    return order, starts, np.diff(np.r_[starts, len(order)])


def _unique_rows(rows):
    """`np.unique(rows, return_inverse=True, axis=0)`, by `lexsort`.

    The same rows in the same order with the same inverse, about five times faster on a million
    rows: `unique` with an axis sorts the rows as a structured dtype through the generic compare.
    """
    order = np.lexsort(rows.T[::-1])
    srt = rows[order]
    first = np.r_[True, (srt[1:] != srt[:-1]).any(axis=1)]
    inverse = np.empty(len(rows), dtype=np.intp)
    inverse[order] = np.cumsum(first) - 1
    return srt[first], inverse


def _grouped_agg(values, ids, n_groups, how):
    """Aggregate `values` per group. `ids` are contiguous in `[0, n_groups)`, every one present.

    What `pd.Series(values).groupby(ids).<how>()` returned in skeletor. Nothing reaching here
    is NaN: every vertex of every component is reached by at least the first wave.
    """
    if how == "mean":
        return np.bincount(ids, weights=values, minlength=n_groups) / np.bincount(
            ids, minlength=n_groups
        )

    if how in ("min", "max"):
        order, starts, _ = _group_by_label(ids)
        reduce = np.minimum if how == "min" else np.maximum
        return reduce.reduceat(values[order], starts)

    # A quantile with linear interpolation between the two values either side of it: sort by
    # group and then by value, and read each group's run at `q * (size - 1)`.
    q = _QUANTILES[how]
    order = np.lexsort((values, ids))
    srt = values[order]
    sizes = np.bincount(ids, minlength=n_groups)
    starts = np.r_[0, np.cumsum(sizes)[:-1]]
    at = q * (sizes - 1)
    lo = np.floor(at).astype(np.int64)
    hi = np.ceil(at).astype(np.int64)
    frac = at - lo
    return srt[starts + lo] * (1 - frac) + srt[starts + hi] * frac


def _cast_waves(verts, edges, waves, step_size, radius_agg, seed_vertex=None):
    """Per-vertex ring centres and radii, averaged over `waves`.

    skeletor's `_cast_waves_fastcore`, its comments shortened. Two things in it are not
    obvious: every wave's distances come from **one** BFS from a virtual node joined to all of
    that wave's seeds (asking per component rebuilds the adjacency each time, which on a mesh
    shattered into thousands of specks is quadratic), and an unreached vertex stays at -1, which
    `level_set_components` reads as excluded rather than as a level of its own.

    `edges` are uint32, the dtype every fastcore graph call converts to — handed anything else,
    each of them copies the whole edge list first.

    `seed_vertex`, where given, is where the first wave starts in its own component — the soma,
    so the rings radiate out of it. Every other component and wave keeps skeletor's seeds.
    """
    n_verts = verts.shape[0]
    centers = np.full((n_verts, 3, waves), fill_value=np.nan)
    radii = np.full((n_verts, waves), fill_value=np.nan)

    comp = fc.connected_components_graph(edges, n_verts)
    srt, starts, sizes = _group_by_label(comp)

    # Seeds depend on nothing but a component's size, so a shattered mesh with tens of
    # thousands of components draws only once per distinct size.
    seeds_per_wave = [[] for _ in range(waves)]
    by_size = {}
    for start, size in zip(starts.tolist(), sizes.tolist()):
        if size not in by_size:
            by_size[size] = _pick_seeds(size, waves)
        for w, s in enumerate(by_size[size]):
            seeds_per_wave[w].append(start + s)

    if seed_vertex is not None:
        # Its position in the sorted members, and the component whose run holds that position.
        at = int(np.flatnonzero(srt == seed_vertex)[0])
        seeds_per_wave[0][int(np.searchsorted(starts, at, side="right")) - 1] = at

    # The edges with room for a spoke from the virtual node to every component's seed, written
    # once: each wave fills the tail with its own spokes and hands over a row slice, so the edge
    # list is not copied per wave.
    super_id = np.uint32(n_verts)
    n_edges = len(edges)
    graph = np.empty((n_edges + len(starts), 2), dtype=np.uint32)
    graph[:n_edges] = edges
    graph[n_edges:, 0] = super_id

    labels = np.full((waves, n_verts), fill_value=-1, dtype=np.int64)
    for w, seeds in enumerate(seeds_per_wave):
        if not seeds:
            continue
        graph[n_edges : n_edges + len(seeds), 1] = srt[seeds]
        d = fc.geodesic_matrix_graph(
            graph[: n_edges + len(seeds)], n_verts + 1, sources=np.array([super_id])
        )[0, :n_verts]
        reached = d >= 0
        labels[w, reached] = d[reached].astype(np.int64) - 1

    if step_size > 1:
        # `np.digitize(x, np.arange(0, mx, step_size))` for every component at once, where `mx`
        # is the furthest level over the component and all of its waves. In place, and with the
        # unreached put back to -1 afterwards, since the binning lifts them to 0.
        unreachable = labels < 0
        mx = np.maximum.reduceat(labels.max(axis=0)[srt], starts)
        cap = np.empty(n_verts, dtype=np.int64)
        cap[srt] = np.repeat(-(-mx // step_size), sizes)
        np.floor_divide(labels, step_size, out=labels)
        labels += 1
        np.minimum(labels, cap, out=labels)
        labels[unreachable] = -1

    for w in range(waves):
        ids, n_rings = fc.level_set_components(edges, n_verts, labels[w])

        ix = np.flatnonzero(ids >= 0)
        if not len(ix):
            continue
        ring = ids[ix]
        members = verts[ix]

        counts = np.bincount(ring, minlength=n_rings)
        ring_centers = np.empty((n_rings, 3))
        for k in range(3):
            ring_centers[:, k] = np.bincount(ring, weights=members[:, k], minlength=n_rings)
        ring_centers /= counts[:, None]

        member_centers = ring_centers[ring]
        # `np.linalg.norm(..., axis=1)` spelled out: the same reduction, without the conjugated
        # copy it makes of a real array.
        d = members - member_centers
        d *= d
        to_center = np.sqrt(np.add.reduce(d, axis=1))
        ring_radii = _grouped_agg(to_center, ring, n_rings, radius_agg)

        centers[ix, :, w] = member_centers
        radii[ix, w] = ring_radii[ring]

    return np.nanmean(centers, axis=2), np.nanmean(radii, axis=1)


def _compact(verts, faces):
    """Drop every vertex no face references, keeping the rest in their order.

    The remap wraps to 2**32 - 1 only for the vertices being dropped, which nothing indexes.
    """
    used = np.zeros(len(verts), dtype=bool)
    used[faces.ravel()] = True
    if used.all():
        return verts, faces
    remap = np.cumsum(used, dtype=np.uint32) - np.uint32(1)
    return verts[used], remap[faces]


def _drop_small_fragments(verts, faces, edges, min_vertices):
    """`(verts, faces, edges)` with every connected piece under `min_vertices` vertices removed.

    Through `_drop_pieces`, which keeps the rest in order — so every kept piece's seeds, rings and
    nodes are exactly what skeletor makes of a mesh holding only those pieces.
    """
    comp = fc.connected_components_graph(edges, len(verts))
    # Asked per piece first, which is far shorter than per vertex. A piece is labelled by its
    # lowest vertex, so the counts are zero at every other index and those are not pieces.
    sizes = np.bincount(comp)
    small_piece = (sizes > 0) & (sizes < min_vertices)
    if not small_piece.any():
        return verts, faces, edges
    return _drop_pieces(verts, faces, edges, small_piece[comp])


def _drop_pieces(verts, faces, edges, drop):
    """`(verts, faces, edges)` without the vertices in `drop`, which are whole pieces.

    A face and an edge each lie within one piece, so a first corner says whether it goes. What
    survives is renumbered in order — every kept vertex is still referenced, the input having been
    compacted — and the edges are filtered rather than rebuilt: `unique_edges` sorts them, and a
    renumbering in order keeps that order, so the rows are the ones a rebuild gives at a fraction
    of its cost (measured: 17 against 130 ms a million vertices).
    """
    keep = ~drop
    # Wraps to 2**32 - 1 only for the vertices dropped, which nothing indexes: `_compact`'s form.
    renumber = np.cumsum(keep, dtype=np.uint32) - np.uint32(1)
    return (
        verts[keep],
        renumber[faces[keep[faces[:, 0]]]],
        renumber[edges[keep[edges[:, 0]]]],
    )


def _drop_soma_debris(verts, faces, edges, at, radius):
    """`(verts, faces, edges)` without the pieces lying wholly within `radius` of the soma at `at`.

    What a soma's mesh keeps inside it that is not the cell: on FlyWire the nuclear envelope, as a
    closed shell of its own, and loose bits of internal membrane. Each becomes a tree of its own
    beside the soma, and the shell is where the vertex nearest a nucleus position lies — so with
    it gone the collapse seeds on the cell's surface. A piece reaching outside the radius stays: it
    may be a neurite. Which pieces count as debris is `_debris`' to say.
    """
    outside = ((verts - at) ** 2).sum(axis=1) > radius * radius
    # Nothing inside means nothing to drop, and no labelling is needed to say so.
    if outside.all():
        return verts, faces, edges
    debris = _debris(edges, outside)
    if not debris.any():
        return verts, faces, edges
    return _drop_pieces(verts, faces, edges, debris)


def _debris(edges, outside):
    """Per row, whether it is soma debris: on a piece of the graph with no row `outside`.

    The one rule, fallback included, for a piece of mesh in the clean-up (`_drop_soma_debris`) and
    a tree of the skeleton in the label (`_nearest_row`), so the two cannot disagree about what is
    debris. **Where nothing is outside, nothing is debris** — every piece is inside, there is no
    cell beside them to tell them from, and a neuron smaller than its soma radius is still a neuron.
    """
    if not outside.any():
        return np.zeros(len(outside), dtype=bool)
    comp = fc.connected_components_graph(edges, len(outside))
    reaches = np.zeros(len(outside), dtype=bool)
    reaches[comp[outside]] = True
    return ~reaches[comp]


def _soma_region(verts, edges, at, radius):
    """The mesh vertices that are the soma: `(seed, members)`, or `(None, None)` if none.

    Every vertex within `radius` of `at` **and connected to the vertex nearest `at` through
    vertices that are also within it**. The second half is what keeps a neurite that merely passes
    through the ball out of the soma — it touches the sphere without being joined to the cell body
    inside it — which a plain distance cut cannot tell apart. fafbseg's soma detector records the
    same wish as a TODO ("use along-the-mesh distances"); a component of the ball is the cheap form.
    """
    d = ((verts - at) ** 2).sum(axis=1)
    inside = d <= radius * radius
    if not inside.any():
        return None, None
    seed = int(np.argmin(d))
    ball = edges[inside[edges[:, 0]] & inside[edges[:, 1]]]
    comp = fc.connected_components_graph(ball, len(verts))
    members = np.flatnonzero(inside & (comp == comp[seed]))
    return seed, members


#: `_wavefront_graph` of a mesh with nothing in it.
_EMPTY_GRAPH = (np.zeros((0, 3)), np.zeros(0), np.zeros((0, 2), dtype=np.int64), -1)


def _empty():
    """An empty skeleton: no positions, radii or parents, and so no soma. Keeps its mesh's slot."""
    return np.zeros((0, 3)), np.zeros(0), np.zeros(0, dtype=np.int64), -1


def _skeletonize_one(verts, faces, waves, step_size, radius_agg, min_fragment=0):
    """One mesh to `(positions, radii, parents, soma)`, rows in parent-before-child order.

    `_wavefront_graph` oriented, with no soma: skeletor's answer, which is what the probes hold it
    against. The node goes through `_skeleton_with_soma`, which may pick a root before orienting.
    """
    centers, radii, edges, root = _wavefront_graph(
        verts, faces, waves, step_size, radius_agg, min_fragment
    )
    if not len(centers):
        return _empty()
    return _orient(centers, radii, edges, root)


def _wavefront_graph(
    verts, faces, waves, step_size, radius_agg, min_fragment=0, soma=None, soma_radius=0.0
):
    """One mesh to its skeleton before orientation: `(centres, radii, tree_edges, soma_node)`.

    `faces` are uint32; `verts` are widened to float64 here, after the unreferenced ones are gone.
    Pieces under `min_fragment` vertices are removed first; 0 keeps every piece.

    `soma`, an xyz in the mesh's units, collapses the soma before nodes are formed: pieces wholly
    within `soma_radius` of it are dropped (`_drop_soma_debris`), the first wave starts there,
    every vertex of `_soma_region` is given the one centre `soma` and the one radius, and the
    soma's tree is rooted at the node they make. The hairball a bad soma mesh turns into is never
    built, and every neurite leaving the soma is contracted onto that node.
    The returned `soma_node` is that node, or -1. With no `soma` this is skeletor's answer.
    """
    # Unreferenced vertices out, keeping the rest in their order — see the module docstring.
    verts, faces = _compact(verts, faces)
    if len(faces) == 0:
        return _EMPTY_GRAPH

    edges = fc.unique_edges(faces)
    if min_fragment > 1:
        verts, faces, edges = _drop_small_fragments(verts, faces, edges, min_fragment)
    verts = verts.astype(np.float64)

    # Every piece was under the threshold.
    if len(verts) == 0:
        return _EMPTY_GRAPH

    seed, members = None, None
    if soma is not None:
        soma = np.asarray(soma, dtype=np.float64)
        verts, faces, edges = _drop_soma_debris(verts, faces, edges, soma, soma_radius)
        seed, members = _soma_region(verts, edges, soma, soma_radius)

    centers, vert_radii = _cast_waves(verts, edges, waves, step_size, radius_agg, seed)
    if members is not None:
        centers[members] = soma
        vert_radii[members] = np.linalg.norm(verts[members] - soma, axis=1).mean()

    # Vertices whose averaged centres coincide are one node.
    node_centers, vertex_to_node = _unique_rows(centers)
    n_nodes = len(node_centers)

    node_radii = _grouped_agg(vert_radii, vertex_to_node, n_nodes, radius_agg)

    el = fc.contract_vertices(edges, vertex_to_node)

    if len(el):
        # Keep the heavy edges: wide and straight is backbone, thin and crooked is a twig.
        weights_rad = (node_radii[el[:, 0]] + node_radii[el[:, 1]]) / 2
        _vect, alpha = fc.dotprops(node_centers, k=_DOTPROPS_K)
        weights_alpha = (alpha[el[:, 0]] + alpha[el[:, 1]]) / 2
        weights = weights_rad * weights_alpha

        # The spanning tree wants every weight positive.
        positive = weights > 0
        if not positive.any():
            weights[:] = 1.0
        elif not positive.all():
            weights[~positive] = weights[positive].min() / 2

        el = el[fc.minimum_spanning_tree(el, n_nodes, weights=weights, maximize=True)]

    soma_node = int(vertex_to_node[seed]) if seed is not None else -1
    return node_centers, node_radii, el, soma_node


def _orient(positions, radii, edges, root=-1):
    """An edge list as a forest in parent-before-child rows: `(positions, radii, parents, root)`.

    Each tree is rooted at its lowest node, skeletor's rule, except the one holding `root`, which
    is rooted there; `root` comes back as its new row, or -1.
    """
    n = len(positions)
    parents, order = fc.parents_from_edges(edges, n, roots=None if root < 0 else np.array([root]))

    new_ids = np.empty(n, dtype=np.int64)
    new_ids[order] = np.arange(n)

    # Masked, because every root's parent is -1 and `new_ids[-1]` reads the last node instead
    # of raising.
    parent_ord = parents[order]
    parent_new = np.where(parent_ord >= 0, new_ids[parent_ord], -1)

    return positions[order], radii[order], parent_new, int(new_ids[root]) if root >= 0 else -1


def _nearest_row(positions, edges, at, tolerance):
    """The soma for a source position: the nearest node within `tolerance`, or -1 where none is.

    **Never on debris** (`_debris`): a soma's mesh keeps loose pieces inside it, each a little tree
    right at the nucleus and nearer it than the cell's own nodes. Where the only near nodes are on
    debris, the cell has no node within the radius and there is no soma to label.
    """
    d = ((positions - at) ** 2).sum(axis=1)
    near = d <= tolerance * tolerance
    pick = near & ~_debris(edges, ~near)
    if not pick.any():
        return -1
    return int(np.argmin(np.where(pick, d, np.inf)))


def _widest_row(radii, min_radius):
    """The detected soma: the widest node, where it is at least `min_radius` wide; else -1.

    Measured on six FlyWire neurons against their nuclei, the widest node lands 2–8 µm from the
    nucleus — beside the soma every time, in it only sometimes, inside the arbour as often as not.
    So detection is opt-in, a source's position always wins over it, and it is never collapsed
    around: a collapse there pulls the arbour into a star.
    """
    if not len(radii):
        return -1
    row = int(np.argmax(radii))
    return row if radii[row] >= min_radius else -1


#: fafbseg's thorough shave leaves alone any terminal segment this many nodes long or longer.
_SHAVE_MAX_NODES = 10

#: The shaves the card offers. `bristles` is navis' `mesh2skeleton(shave=True)`; `thorough` is
#: fafbseg's `skeletonize_neuron(shave_skeleton=True)`, which runs the same bristle pass last.
_SHAVES = ("off", "bristles", "thorough")


def _node_kinds(parents):
    """Which rows are leaves and which are branch points, in navis' sense of both.

    navis types a root as `root` whatever its children, so a root is never a branch point, and a
    lone node is a root rather than a leaf. Both shaves read these, and neither cuts at a root.
    """
    has_parent = parents >= 0
    children = np.bincount(parents[has_parent], minlength=len(parents))
    return (children == 0) & has_parent, (children > 1) & has_parent


def _keep_rows(keep, positions, radii, parents, *extra):
    """The rows in `keep`, in order, with parents renumbered.

    Only ever handed leaf-side cuts, so no kept row loses its parent, and order stays
    parent-before-child.
    """
    renumber = np.cumsum(keep) - 1
    kept_parents = parents[keep]
    kept_parents = np.where(kept_parents >= 0, renumber[np.maximum(kept_parents, 0)], -1)
    return (positions[keep], radii[keep], kept_parents, *(e[keep] for e in extra))


def _shave_bristles(positions, radii, parents):
    """navis' shave: one pass removing every leaf whose parent is a branch point."""
    leaf, branch = _node_kinds(parents)
    bristle = leaf.copy()
    bristle[leaf] = branch[parents[leaf]]
    if not bristle.any():
        return positions, radii, parents
    return _keep_rows(~bristle, positions, radii, parents)


def _shave_thorough(positions, radii, parents, cutoff, within=None):
    """fafbseg's shave: terminal segments that are short or hold a long edge, until none are left.

    A terminal segment runs from a leaf up to the first branch point or root, both ends counted.
    One goes when it is at most two nodes, or when any of its nodes sits `cutoff` or further from
    its parent — the end node included, as fafbseg checks the whole segment — but never when it
    is `_SHAVE_MAX_NODES` long or longer. Everything but its end node is removed, and the pass
    repeats on what is left, the distances being measured once since no node moves. fafbseg then
    ends with the bristle pass, which `_tidy` runs after this.

    Each leaf is walked at most `_SHAVE_MAX_NODES - 1` steps, all leaves at once: a segment that
    has not ended by then is too long to remove, so nothing further up is ever needed.

    `within`, a per-row mask, restricts the shave to segments that start and end at marked rows:
    the soma clean-up's form, which shaves the debris around a collapsed soma and nothing further.
    """
    if within is None:
        within = np.ones(len(parents), dtype=bool)
    has_parent = parents >= 0
    step = np.zeros(len(parents))
    step[has_parent] = np.linalg.norm(
        positions[has_parent] - positions[parents[has_parent]], axis=1
    )
    long = step >= cutoff

    while True:
        leaf, branch = _node_kinds(parents)
        start = np.flatnonzero(leaf)
        cur = start.copy()
        length = np.ones(len(start), dtype=np.int64)
        has_long = long[start]
        ended = np.zeros(len(start), dtype=bool)
        last = np.full(len(start), -1)
        walking = np.ones(len(start), dtype=bool)
        members = [start]
        for _ in range(_SHAVE_MAX_NODES - 1):
            at = np.flatnonzero(walking)
            if not len(at):
                break
            up = parents[cur[at]]
            length[at] += 1
            has_long[at] |= long[up]
            stop = (parents[up] < 0) | branch[up]
            ended[at[stop]] = True
            last[at[stop]] = up[stop]
            walking[at[stop]] = False
            on = at[~stop]
            middle = np.full(len(start), -1)
            middle[on] = up[~stop]
            members.append(middle)
            cur[on] = up[~stop]

        cut = ended & (length < _SHAVE_MAX_NODES) & ((length <= 2) | has_long)
        cut &= within[start] & within[np.maximum(last, 0)]
        rows = np.concatenate([m[cut] for m in members])
        rows = rows[rows >= 0]
        if not len(rows):
            break
        keep = np.ones(len(parents), dtype=bool)
        keep[rows] = False
        positions, radii, parents, long, within = _keep_rows(
            keep, positions, radii, parents, long, within
        )

    return positions, radii, parents


def _fix_zero_radii(radii, parents):
    """navis' fix: a non-root node of radius 0 takes half its parent's radius, as it was before."""
    zero = (radii == 0) & (parents >= 0)
    if not zero.any():
        return radii
    fixed = radii.copy()
    fixed[zero] = radii[parents[zero]] / 2
    return fixed


#: How far round a collapsed soma its clean-up reaches, in soma radii.
_SOMA_SHAVE_REACH = 3.0


def _tidy(
    positions, radii, parents, shave, cutoff, fix_zero_radii, soma=-1, soma_radius=0.0,
    collapsed=False,
):
    """The post-processing navis and fafbseg run on skeletor's result: a shave, then the radii.

    Returns `(positions, radii, parents, soma)`, the soma row found again after the cuts by its
    position — no shave moves a node, nodes are unique positions, and the soma is a root, which
    no shave removes. Where the soma was `collapsed`, the debris around it goes first: fafbseg's
    rule, restricted to twigs lying wholly within `_SOMA_SHAVE_REACH` soma radii, which is where a
    collapse leaves the hairball's pieces. Measured on FlyWire, restricting it to twigs ending *at*
    the soma left most of them.
    """
    at = positions[soma].copy() if soma >= 0 else None
    if collapsed and at is not None:
        reach = _SOMA_SHAVE_REACH * soma_radius
        near = ((positions - at) ** 2).sum(axis=1) <= reach * reach
        positions, radii, parents = _shave_thorough(positions, radii, parents, cutoff, near)
    if shave == "thorough":
        positions, radii, parents = _shave_thorough(positions, radii, parents, cutoff)
    if shave in ("bristles", "thorough"):
        positions, radii, parents = _shave_bristles(positions, radii, parents)
    if fix_zero_radii:
        radii = _fix_zero_radii(radii, parents)
    if at is not None:
        soma = int(np.flatnonzero((positions == at).all(axis=1))[0])
    return positions, radii, parents, soma


def _joined(parts, dtype):
    """Per-mesh arrays as one flat array of `dtype`, cast in the concatenate (`skeletons.py`)."""
    if not parts:
        return np.zeros(0, dtype=dtype)
    return np.concatenate(parts, dtype=dtype).ravel()


def _skeleton_with_soma(verts, faces, opts, at):
    """One mesh through the whole node: `(positions, radii, parents, soma)`.

    `at` is the source's soma position, or None. With a position and the collapse on, the mesh is
    skeletonized around it (`_wavefront_graph`'s `soma`); otherwise the soma is the node nearest
    the position, within the soma radius and on a tree reaching beyond it (`_nearest_row`). Where
    there is no position and detection is on, the widest node is — labelled and rooted at, never
    collapsed around (`_widest_row` says why). Whichever it is, its tree is oriented from it in
    the one pass.
    """
    collapse = opts["soma_cleanup"] and at is not None
    centers, radii, edges, root = _wavefront_graph(
        verts, faces, opts["waves"], opts["step_size"], opts["radius_agg"], opts["min_fragment"],
        at if collapse else None, opts["soma_radius"],
    )
    if not len(centers):
        return _empty()
    if root < 0:
        if at is not None:
            root = _nearest_row(centers, edges, at, opts["soma_radius"])
        elif opts["detect_soma"]:
            root = _widest_row(radii, opts["min_soma_radius"])

    points, radii, parents, soma = _orient(centers, radii, edges, root)
    return _tidy(
        points, radii, parents, opts["shave"], opts["shave_cutoff"], opts["fix_zero_radii"],
        soma, opts["soma_radius"], collapsed=collapse and soma >= 0,
    )


def coda_skeletonize_meshes(request, report=None):
    """A whole set of meshes to skeletons, in one crossing.

    Flat in the way `meshes.py` takes meshes — every mesh's vertices after the last, every
    mesh's faces after the last, face indices mesh-local — and flat out the way `skeletons.py`
    hands skeletons back: points, radii and parents one skeleton after the last, parents local
    to their skeleton, and one offset array.

    **The item count never changes**, `coda_clean_meshes`' rule: an empty mesh comes back as an
    empty skeleton in its place, so the attribute row after it still belongs to the next neuron.

    Vertices stay float32 until `_skeletonize_one` widens its own mesh, so what is held in
    float64 at any moment is one mesh rather than the whole set. A mesh with no faces comes back
    empty from there, having no referenced vertices.
    """
    req = request.to_py()

    verts = np.frombuffer(req["positions"], dtype=np.float32).reshape(-1, 3)
    faces = np.frombuffer(req["indices"], dtype=np.uint32).reshape(-1, 3)
    voff = np.frombuffer(req["vertexOffsets"], dtype=np.int32)
    foff = np.frombuffer(req["faceOffsets"], dtype=np.int32)
    count = len(voff) - 1

    # The request's keys in snake case, one for one.
    opts = {
        "waves": int(req["waves"]),
        "step_size": int(req["stepSize"]),
        "radius_agg": str(req["radiusAgg"]),
        "min_fragment": int(req["minFragment"]),
        "shave": str(req["shave"]),
        "shave_cutoff": float(req["shaveCutoff"]),
        "fix_zero_radii": bool(req["fixZeroRadii"]),
        "soma_cleanup": bool(req["somaCleanup"]),
        "soma_radius": float(req["somaRadius"]),
        "detect_soma": bool(req["detectSoma"]),
        "min_soma_radius": float(req["minSomaRadius"]),
    }
    if opts["waves"] < 1:
        raise ValueError(f"waves must be at least 1, got {opts['waves']}")
    if opts["step_size"] < 1:
        raise ValueError(f"stepSize must be at least 1, got {opts['step_size']}")
    if opts["radius_agg"] not in ("mean", "min", "max", *_QUANTILES):
        raise ValueError(f'Unknown radius aggregation "{opts["radius_agg"]}"')
    if opts["shave"] not in _SHAVES:
        raise ValueError(f'Unknown shave "{opts["shave"]}"')
    # One xyz per mesh, NaN where the source knows no soma.
    soma_at = np.frombuffer(req["somaPositions"], dtype=np.float32).reshape(-1, 3)
    soma_at = soma_at.astype(np.float64)

    out_points = []
    out_radii = []
    out_parents = []
    offsets = [0]
    somas = np.full(count, -1, dtype=np.int32)

    for i in range(count):
        at = soma_at[i] if np.isfinite(soma_at[i]).all() else None
        points, radii, parents, somas[i] = _skeleton_with_soma(
            verts[voff[i] : voff[i + 1]], faces[foff[i] : foff[i + 1]], opts, at
        )
        out_points.append(points)
        out_radii.append(radii)
        out_parents.append(parents)
        offsets.append(offsets[-1] + len(radii))
        # Every eighth mesh and the last, `skeletons.py`'s rule: each report is a crossing of the
        # bridge, which on a set shattered into thousands of small meshes costs as much as one.
        if report is not None and (i % 8 == 7 or i == count - 1):
            report((i + 1) / count, f"{i + 1} of {count} meshes")

    return {
        "points": _joined(out_points, np.float32),
        "radii": _joined(out_radii, np.float32),
        "parents": _joined(out_parents, np.int32),
        "offsets": np.asarray(offsets, dtype=np.int32),
        # Per mesh, the soma's row in its own skeleton or -1. Detected rather than placed exactly
        # where the request held no position for that mesh, a source's position always winning.
        "somas": somas,
    }
