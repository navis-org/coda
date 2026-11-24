# Find path with affinities — plan

A find-path tool in the Neuroglancer card that shows where the route between two points runs
through weak contacts. **Coda takes over F** (user, 2026-11-24), where its find path is on, rather than changing
neuroglancer's own tool: that tool draws its route as one polyline annotation, one colour, so
showing affinity per step would mean replacing its drawing — a patch carried through every
Spelunker upgrade. F comes from Spelunker's keybindings, which Coda injects itself
(`src/ngframe/keybinds.ts`), so it can be dropped there and claimed by the frame as J and K are
(`src/ngframe/main.ts`); the Graph tab's **Find Path** button is the one other way in.

## What it costs (measured 2026-11-24, Aedes, reads only, `scripts/tmp-path-cost.mjs`)

The ends of a longest shortest path by hops ("across"), and a pair 40 hops apart ("near").
`subgraph` four requests at a time, in `boxesAlong`'s boxes.

| root | L2 chunks | graph read | path | `find_path` | `subgraph` along it | `leaves_many` |
| --- | --- | --- | --- | --- | --- | --- |
| 648518347493136877 | 345 | 0.9 s | 41 / 45 | 0.8 / 1.0 s | 2.9 / 2.2 s (9 / 10 boxes) | 0.1 s |
| 648518347570445672 | 352 | 0.2 s | 41 / 45 | 0.5 / 0.8 s | 1.7 / 2.1 s (9 / 10) | 0.1 s |
| 648518347672268769 | 804 | 0.3 s | 41 / 76 | 0.8 / 0.9 s | 1.4 / 2.6 s (9 / 15) | 0.1 s |
| 648518347622603652 | 564 | 0.4 s | 41 / 64 | 0.7 / 0.8 s | 1.4 / 2.7 s (7 / 13) | 0.1 s |
| 648518347558097460 | 1009 | 0.3 s | 41 / 99 | 0.9 s / **500** | 1.5 / 3.5 s (10 / 22) | 0.1–0.2 s |
| 648518347585551219 | 1066 | 1.3 s | 41 / 115 | 0.9 / 0.6 s | 1.8 / 3.7 s (8 / 25) | 0.1 s |

- **The shortest route with each step's affinity: 2–5 s** — the level-2 graph, `subgraph` along
  the path, and each path chunk's supervoxels (to say which two chunks an edge joins).
- **Coda's own breadth-first path matched `find_path`'s step count every time**, from the
  level-2 graph it reads anyway; the server's `find_path` adds a request and a position lookup,
  and answered one route with a 500 (`'NoneType' object is not iterable`).
- **A band one chunk wide around the path: 3–8 s** (18–28 boxes for "across"), and **a box holding
  none of the neuron's edges is a 500 at the server** (`index 0 is out of bounds for axis 0 with
  size 0`), not an empty answer: 3 of 28 and 3 of 18 boxes. `readSubgraphBoxes` stops at the first
  failure, so a band read needs to tolerate that answer.
- **The whole neuron: 16 s (345 chunks, 140 boxes) and 42 s (1,066 chunks, 380 boxes)** with
  `probe-scan-neuron`'s tiling — what a strongest route over the whole neuron needs. Too slow for
  a key press; FANC's 2,800-chunk neurons would be minutes.

## What the colours can say

From `split-sites-plan.md`: on Aedes, false merges are often moderate-to-strong contacts (mean
affinity 0.37–0.89), and real weak contacts (one at 0.12) look like false merges. A weak step is a
place to look, not a verdict.

## Built (2026-11-24)

- **The key.** `F` (`isFindPathKey`) is claimed by the frame as `J` and `K` are and handed back;
  Spelunker's `keyf` binding is dropped (`ngframe/keybinds.ts`), and the Graph tab's **Find Path**
  button is hidden by CSS in `neuroglancer.html`. In Coda's document, bare `F` is fullscreen: the
  card keys are taken on the window's capture phase (`splitKey.ts`), so over a card that finds
  paths the path takes it and fullscreen stands down (`defaultPrevented`); off every card it is
  fullscreen still. SEAM pack only, as `K`.
- **The press.** F over a neuron marks the start (a white point); F over the same neuron in the
  same card draws the route; anywhere else starts again (`findPathSession.ts`). Reads are the
  split gallery's cached `graphOf` / `neuronOf`, so F and K on one neuron read it once.
- **The drawing is the frame's own layer** (`FrameLayerMessage`, `find path`), never in the card's
  scene: adding a layer to the scene is a navigation that rebuilds every layer and reloads every
  mesh. The frame adds it with neuroglancer's `makeLayer` / `addManagedLayer`, sets its annotations
  in place after that, and removes it on `null`; the card's fold reads only the dataset's layer, so
  it is never saved, and a navigation clears it. Checked in Chrome (`scripts/tmp-path-frame.mjs`):
  added, set in place on the same layer object, removed, F handed back, only Find Path hidden.
- **Each step is the weakest join of the strongest supervoxel path, not chunk to chunk.** The first
  build summed the contacts between neighbouring chunks, and on 648518347493136877 all 36 steps came
  back as one supervoxel's halves (infinite affinity): supervoxels are cut at every chunk border,
  so neighbouring chunks are joined that way, and the joins between supervoxels sit inside chunks.
  Now the route's own supervoxels are searched for the path whose weakest join is strongest
  (`strongestPath`, a widest path on `splitSites`' `MaxHeap`); each join goes to the step it is on
  (one inside a chunk to the step reaching it), and each step shows its weakest. Live: that neuron's
  route has 35 contact steps, the weakest at mean 0.27; 648518347585551219 (SEAM-merged) has two
  proofreader merges and contacts at 0.00–0.02.
- **Colours** are the validated sequential red ramp by weakness (1 − mean), brightest weakest on
  neuroglancer's black; a proofreader's merge the first categorical colour, an unread step muted
  ink. Each line's description names its step and mean, which neuroglancer shows on hover.
- **After the first use (user, 2026-11-24):** the end point is drawn on the second press, before
  the route is read; a new start or route makes the layer visible again if the reader hid or
  archived it (`setVisible(true)` in the frame, which un-archives too — checked in Chrome); hover
  shows numbers, not a colour: the layer's properties are `step`, `kind` (a `float32` with enum
  labels — contact, one supervoxel, proofreader merge, not read, end point) and `affinity` (−1
  where there is no contact: JSON has no NaN), and the shader colours from them, its ramp sampled
  from `sequentialColor` and the rest `stepColor` (`pathShader`); and **dismissing find path's own
  notice clears the route** (or a start waiting for its end), while a notice that merely replaces
  it leaves the route drawn.

## Thickness as a second measure (measured 2026-11-24, `scripts/tmp-neck-eval.mjs`, reads only)

Past splits sampled at random (`operation_details`, 40 graded per datastack), the root before each,
a point ~15 µm from the cut on each root it made (`splitCase`), the find-path route between them on
the old root, and the steps touching a chunk the cut ran through as the truth. Each step ranked by
the weakest join's mean affinity (the strongest supervoxel path, as F draws it), the chunks'
`max_dt_nm`, the cross-section where the route crosses the chunk border (`chunk_intersect_count`
on the shared face), and each of those two as a neck (against the thickest within three steps on
each side). Top 1 / top 3, against a random order:

| | FANC (40) | Aedes (40) | Aedes, pieces of 10+ chunks (20) |
| --- | --- | --- | --- |
| chance | 13.5 / 31.0 | 10.6 / 25.9 | 4.2 / 10.7 |
| **affinity** | **18 / 35** | **19 / 29** | **9 / 14** |
| radius (`max_dt_nm`) | 7 / 26 | 9 / 25 | 3 / 8 |
| radius neck | 13 / 32 | 10 / 24 | 3 / 8 |
| border cross-section | 16 / 33 | 14 / 28 | 7 / 12 |
| cross-section neck | 15 / 35 | 11 / 31 | 3 / 13 |

- **The weakest join of the strongest path is the best single measure on both datastacks**, about
  twice chance at top 1 on the larger Aedes pieces. Better than `split-sites-plan.md`'s Aedes
  results suggested — those ranked cuts by their mean affinity, not a route's weakest join.
- **Thickness at chunk resolution is at chance or below**, the neck versions included. A level-2
  chunk is ~8 × 8 × 6 µm on both, and a `max_dt_nm` is the thickest point anywhere in it, so a
  neck a micrometre long is invisible; the routes are also short (median 6–7 steps). The border
  cross-section does a little better than the radius, not better than affinity.
- So no thickness colour from the L2 cache. A thickness worth showing needs a finer measure — the
  mesh cut across the route every ~100 nm (the surface path's cross-sections) — and would need
  this same test before it is drawn. Where it is read, it is only where the datastack has an L2
  cache or a mesh: `peekL2Cache` (`data/cave/datastack.ts`, caveclient's `has_cache` rule) is the
  gate, and today K and F themselves need the cache for chunk positions.

## Datastacks with no L2 cache (2026-11-24)

K and F placed every level-2 chunk from the L2 cache, and on a datastack without one (the FANC
sandbox; `flywire_fafb_public`) they stopped with the server's "does not have an L2 Cache". The
chunkedgraph read now asks `l2SourceFor` (caveclient's `has_cache` rule: the table mapping lists the
table) beside `findSupervoxels`; where it answers none, `readSplitNeuron` places each chunk at its
grid cell's centre (`cellCentreNm`) and says so (`SplitNeuron.placed: 'cells'`). A failed lookup
is still thrown, never read as "no cache". The level-2 graph, the route, the supervoxel reads and
the affinities need no cache, so they are the same; what is rougher is where things are drawn —
F's notice says so — and, in the split gallery, the order of splits by distance and each vertex's
nearest chunk until the exact labels arrive. Live on `fanc_sandbox` (root 648518346498386160, 208
chunks): placed by cells, a 33-step route read in 1.9 s. `probe-split-sandbox.mjs` uses the same
fallback now instead of its own copy.

## The route along the mesh (2026-11-24, `packs/seam/surfacePath.ts`)

The straight lines between chunk points are drawn as soon as the steps are read; once the neuron's
reduced mesh is in — the split gallery's, cached, so a neuron K was pressed on costs nothing — the
route is redrawn along its surface: Dijkstra over the mesh's edges between the vertices nearest
the two points, thinned to a point every 250 nm, each piece on the step its chunk belongs to.
Kept to the route: only vertices in the route's cells, and a vertex whose nearest chunk is off
the route costs four times its length. Where the mesh holds no path, the straight lines stay.

- **A graphene mesh has no shared vertices between its pieces.** It is one piece per chunk
  fragment, meshed and reduced apart: 648518347493136877's is 507 pieces with not one position in
  common, so a walk along edges never leaves the first. Bridges join them — each vertex to its
  nearest three of other pieces within a width tried in turn, 300, 600, then 1,200 nm (the gaps
  differ by neuron: two of four joined at 300, one at 600, one at 1,200). The pieces are closed
  where they meet, so bridging only from open edges joined one of four. 2,400 nm took 7.9 s and no
  neuron needed it.
- **Off-route chunks are a cost, not a wall.** Forbidding vertices whose nearest chunk is off the
  route cut the corridor apart on every neuron (4,222 vertices reachable of 37,815): near a chunk
  border a vertex is often nearest another branch's chunk point.
- **Live, four Aedes neurons:** mesh read 1.8–2.9 s, beside the steps read, and the surface
  searched while the steps are still being read; path 0.09–0.51 s on the main thread, the longest
  single width 0.32 s, a width that cannot join the ends ruled out in under 0.1 s (the browser let
  in between widths), 527–647 points over 178–231 µm, never more than 5.6 µm from a chunk point. The per-vertex
  work is done once per route (`prepareSurface`), only the bridges and an A* search per width.
  Cells and grid squares are number keys from `topologyOps`' `cellKey`, which is guarded against a
  double's precision: a first copy packed 2^20 an axis, a double rounded the low axis away, keys
  collided, and the search ran fivefold slower on wrongly merged squares. Each bridge width first
  asks whether its bridges join the ends at all, and searches only where they do.
  A web worker is the next step if the pause is felt.

## After review (2026-11-24)

- **The strongest path is a maximum spanning tree's**, with a start joined to every first-chunk
  supervoxel and an end to every last-chunk one: strongest along every stretch, not only overall. A
  best-first search maximising the overall weakest join kept whichever later joins it met first, so
  a step after the weakest could show a weak contact where one supervoxel ran through.
- **Only the server's 500 for an empty box is tolerated**, and the steps no answered box holds are
  `unread` — never a weaker way round them. A refused sign-in, a rate limit or a cancel is said.
- **A chunkedgraph with no affinities (FlyWire) draws the route unweighed**, every step `unread`,
  and says why — neuroglancer's own find path is gone from the frame, so F must still give a route.
- **A key handed back carries `key`** (`FrameKeyMessage.key`, `frameKeyInit`, dispatched at the
  page so a card key on the window's capture phase comes first). With the SEAM pack off, F is
  neuroglancer's own find path (below); K still says what to switch on.
- **A press cancels the last one's reads** (an `AbortController` per press), and dismissing the
  notice does too. Notices carry their own dismissal (`noticeDismiss.ts`' `showNotice`).
- **The frame owns its layer by object**: a scene or reader layer named "find path" is never
  touched, never hidden from the reports; own layers a navigation threw away are forgotten.

## F with the SEAM pack off (user, 2026-11-24)

Neuroglancer's own find path, never Coda's fullscreen. Spelunker's `keyf` binding is kept; the card
tells its frame whether F is Coda's there (`FrameKeysMessage.findPath`: the SEAM pack offered and
a CAVE dataset), and only then does the frame claim F and hide the Graph tab's Find Path button
(`data-coda-find-path` on the frame's root, `neuroglancer.html`). Off, F in the frame is
neuroglancer's tool, and F pressed in Coda's document over the card is pressed into the frame
(`FramePressMessage`: keydown and keyup on the viewer's element, where its key bindings listen).
Off every card, F is fullscreen. Checked in Chrome: off, F is left to neuroglancer and the button
shown; on, claimed and hidden; a press passed in fires neuroglancer's `action:tool-grapheneFindPath`.

## Colour by thickness (user, 2026-11-24)

A "Colour by" choice on the route's notice (`NoticeChoice`, `noticeDismiss.ts`; drawn by
`StatusNotice`): **affinity** (the red weakness ramp, as before) or **thickness** — each step the
`max_dt_nm` of the chunk it reaches, on the blue ramp over the route's own thinnest to thickest,
thinnest brightest, so thick → thin → thick reads as dark → bright → dark. No extra request: the
neuron read already asked the L2 cache for `max_dt_nm` beside each point (`readL2Points`,
`SplitNeuron.radii`). Hover shows each step's radius in nm whatever the colour. Without an L2
cache there are no radii, and thickness is offered greyed out with why; the choice is kept for the
next route. The measurement above (thickness at chance on past splits) is why affinity stays the
default; if the chunk-level radius proves too coarse, the mesh cut across the route is the next step.
- **Superseded: the chunks' `max_dt_nm` is gone** (user, 2026-11-24). It read the false merge's
  neck as 136 nm and a thick neurite as 55, so it is no longer drawn even while the skeleton is
  measured: affinity stays drawn with "Measuring…" until the skeleton's thickness is in, and
  `readL2Points` / `SplitNeuron.radii` were removed. Thickness is offered on every route. See
  "Thickness from the mesh" below.
- **The hover value is the first property.** Neuroglancer's layer bar shows one value for the
  annotation under the pointer: its *first* property (`transformPickedValue`). With `step` first, a
  reader colouring by thickness read step numbers (1, 3, 7, 12) as radii, and two backbone points
  of ~equal radius (175 and 132 nm in the L2 cache) as "2" and "11" (user, 2026-11-24). The layer
  now lists the measure the colour shows first — `radius` or `affinity` — the rest after, in the
  full hover.

## Thickness from the mesh (2026-11-24, `packs/seam/skeletonThickness.ts`)

`max_dt_nm` was too coarse, as feared: on 648518347578335589 the false merge's thin neck read 136 nm
(its chunk also holds thick stretches) and a thick neurite 55 nm (its chunk held only a sliver of
it), so the merge did not stand out (user, 2026-11-24). Tried on the mesh, in order:

- **Rays cast inward** (the shape diameter): the published mesh is coarse — median edge 71 nm, 10%
  over 123 nm, ~494 k triangles for this neuron at full resolution, and nothing finer is published
  — and thick neurites read 90–145 nm where they are ~200. Dropped.
- **A wavefront skeleton** (skeletor's, Coda's Pyodide port): at the nodes, 185–225 nm at three
  thick points and 47–73 nm at the merge's bridge — the signal is there. But a route piece's
  *nearest node* is often a short twig's near the surface (0–20 nm) or a blob's (700–900 nm), and
  routes read wildly.
- **Each vertex's own wavefront ring** (`coda_vertex_ring_radii`: the waves a skeleton is cast with,
  stopped before the rings collapse to nodes), on the **full** mesh (`fullMeshOf`; the tiles'
  grid reduction would merge a neck's walls): each route piece the median over its vertices of the
  nearest full-mesh vertex's ring radius, then a running median over three pieces. Along three
  routes from the merge: thick ends 195–210 nm, most of the rest 250–420, a wide stretch 700–830;
  the merge's first pieces 108–117 nm on two routes — their thinnest stretch — and 141–158 on the
  third, where a mid-route dip reads 117. Better, not yet the < 100 nm the mesh shows by eye: at a
  contact, a ring wraps both neurites. Routing along the skeleton itself, through the bridge's
  nodes, is the next thing to try.

The ring radii were built, then replaced by the skeleton route below; `coda_vertex_ring_radii` is
gone with them.

### Along the skeleton itself (measured 2026-11-24, `scripts/tmp-skeleton-walk.mjs`, reads only)

The full mesh's wavefront skeleton (`shave: 'off'`, one wave, step 1): 11,068 nodes in 127 pieces
(one per mesh fragment that is not joined to another), 2.3 s after a 2.8 s full-mesh read. Pieces
joined by bridges between nodes of different pieces within 600 nm, costed ×4; shortest path between
the nodes nearest each point (Dijkstra, ≤ 0.01 s). Routes of 35–59 µm, two bridges each.

- **THIN → thick1 and THIN → thick4** leave the same way. Nodes 200–500 nm from the point read
  **47–70 nm**, then 105–119 nm for 1.3 µm, a second dip to 77–94 at 1.4–1.6 µm, then 195–235.
  The thinnest 500 nm window (median of its nodes) is the merge, **70 nm**; the next thinnest on
  either route is 103 nm (2.2 µm along, 38428,15175,2533 in voxels), then 116, 122, 129.
- **THIN → thick2** leaves the other way and never passes the neck: 102–157 nm for its first 1.4 µm.
  Its thinnest window is 76 nm, 15.5 µm along (38986,15351,2373) — unchecked whether that is a real
  thin stretch.
- The node nearest a clicked point can be a twig's tip: thick1 and thick2's read 94 and 97 nm with
  ~200 nm a node further in. A route's last node says little.

So routing on the skeleton reads the neck where the ring radii could not (70 against 108–117 nm),
by about 30% under anything else on the route — but only where the route passes through it.

### Built: thickness down the skeleton (2026-11-24, `packs/seam/skeletonThickness.ts`)

When thickness is the colour, the session builds the neuron's wavefront skeleton from its full mesh
(`shave: 'twigs'`, last two neurons kept) and finds the route again along it: the **same search as
the surface's** (`prepareSurface` with `RouteMesh.lines`, the skeleton's parent links as segments;
nodes placed by `nearestChunksOf`), so the same corridor, off-route cost and bridge widths. Each
250 nm piece takes the median radius of its nodes. Drawn in place of the surface route, in either
colour, once in. It does not wait for the surface route, and it needs no L2 cache, so thickness is
always offered.

**Mesh pieces under 100 vertices are dropped before skeletonizing** (`PATH_SKELETONIZE`, SEAM's
settings with `minFragment: 100`): the route on thick1 crossed a two-node skeleton piece (8 and
20 nm, a tiny mesh fragment skeletonized alone) inside a ~400 nm neurite, and that was the route's
thinnest. Dropping pieces under 50, 150 or 500 vertices took the skeleton from 127 pieces to 34, 21,
16, removed that piece, and left all three routes' pieces and readings otherwise unchanged; it also
cut the skeleton's time from 2.4 s to 0.3 s. (Filtering the radii of small skeleton pieces afterwards
was tried first and dropped in review: the piece still shaped the route.) The full mesh is not
kept — the skeleton is — and the skeleton is started at the press when thickness is the colour.
**Every skeleton node is kept** (no 250 nm thinning along a skeleton, `PreparedSurface.keepNm`),
each piece one node to the next and read as its two nodes' mean: in review, a neck under half a
250 nm piece vanished in its median. Measured through the functions as built, on
648518347578335589 (2.3 s skeleton with Pyodide's first load, ≤ 0.013 s search, 300 nm bridges
sufficed):

| route | pieces | thinnest | where | next | median |
|---|---|---|---|---|---|
| THIN → thick1 | 422 | 54 nm | pieces 2–3 (54, 54; then 66, 77): the merge | 85 nm, ~2 µm on (38423,15146,2522) | 251 |
| THIN → thick4 | 545 | 54 nm | the same | the same | 225 |
| THIN → thick2 | 314 | 107 nm | pieces 12–13, near the start | 109 | 243 |

THIN → thick2 does not pass through the neck, as before. Ends read 195–224 nm.
