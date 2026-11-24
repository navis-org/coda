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
