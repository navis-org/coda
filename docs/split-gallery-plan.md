# Split gallery: one key over a false merge, a choice of splits — plan

Status: **phases 0–4 built** (2026-11-23): the server questions settled, the candidates built and
tested (`src/packs/seam/splitGallery.ts`, `splitGalleryRun.ts`), the key opens a session whose
gallery shows them as 3D tiles (`src/ui/seam/splitSession.ts`, `splitKey.ts`, `SplitGalleryHost.tsx`,
`SplitTiles.tsx`), and Accept writes the split (`splitWrite.ts`, `splitAccept.ts`) — tested
against faked servers only; **no live split has been sent yet**. The algorithm is the tabled split-sites machinery
([split-sites-plan.md](split-sites-plan.md)); server facts are in
[backends-cave.md](backends-cave.md#the-supervoxel-graph-and-the-split-preview-subgraphts-measured-2026-11-22).
The second feature in Coda that writes to a segmentation, after [seam-merge-plan.md](seam-merge-plan.md),
and held to the same rules.

## The workflow

1. In the Neuroglancer card, the reader points at a false merge (on the mesh in 3D, or a slice)
   and presses a key.
2. Coda computes up to six candidate splits near that point and opens a gallery over the app.
3. Each tile is a small interactive 3D view of the neuron's mesh, coloured by the two parts that
   split would make.
4. Clicking a tile enlarges it; **Accept** sends that split to the chunkedgraph.
5. If none is right, the reader closes the gallery and uses CAVE's two-point split as before.

## Decisions (user, 2026-11-23)

| Question | Decision |
| --- | --- |
| Where | **Inside the Neuroglancer node**, no separate node to wire. |
| Trigger | **The pointer and a key**, as `J` takes a hand pick (`FrameHoverMessage` carries the point on the surface). |
| Accept | **Coda writes the split itself** (not handed to Neuroglancer's multicut), under the merge path's rules. |
| Thumbnails | **The mesh, coloured by side**; a vertex takes its nearest level-2 chunk's side (fragments stitched at layer ≥ 3 span both sides). |
| Speed | **Snappy or pointless**: a 20 s wait is no better than the two-point cut. |
| Thresholds | Small (a few chunks): readers split off side branches, not single supervoxels. Settled by using the UI, not by the test set. |

## What the experiments measured (2026-11-22/23, reads only)

Simulated clicks at, and 1–2 µm around, 13 past false merges (9 FANC, 4 Aedes), 169 clicks.
Graded strictly: right only where the cut leaves the same parts apart as the proofreader's cut
(≥ 95 % of level-2 chunks), or, on the Aedes soma pair, the two nuclei apart.

- Candidates: the plain agglomeration's joins in a box around the click (`weakJoins`), each cut
  as the constrained cut seeded from its two sides (`splitSites`).
- **Nearest join along the neuron, skipping cuts that take off fewer than 25 level-2 chunks:
  126 of 156 (81 %).** Weakest join instead: 111. Without the skip: 55 and 58. Either of the two
  skipping rules right: 137 (88 %).
- **The test set is biased to large merges** (soma pairs; FANC splits of 37–895 chunks). Random
  past splits are mostly small: of 58 per datastack, 45 (FANC) and 37 (Aedes) took off fewer
  than 10 chunks. A level-2 chunk is ~8.8 × 8.8 × 5.8 µm (FANC), 8.2 × 8.2 × 5.8 µm (Aedes), so
  25 chunks is ~150–200 µm of thin cable — too large a threshold for side branches.
- **A cut can be right in the box and still leave the neuron joined**: a supervoxel just outside
  the box touches both sides (`subgraph` returns only edges inside its box). Widening the box
  fixes it in principle, but FANC refused a ~250-chunk read with 503s (80 chunks read fine).
- Distance along the neuron was measured over the box's supervoxel graph with supervoxel centres
  from the segmentation; a test script took ~7 s per click, mostly reads.

## Phase 0 findings

### How a split reaches the server (pychunkedgraph source, `c75ace9`, 2026-10-21; read, not tried)

- `POST …/graph/split?mincut=false` sends `{"sources": [[id, x, y, z], …], "sinks": [[id, x, y, z], …]}`
  and removes **exactly** the edges `sources[i]–sinks[i]`, as pairs (`ChunkedGraph.remove_edges` →
  `SplitOperation`); unequal lengths are refused. With `mincut` left on, the same body is a
  min-cut between the two point sets instead (`MulticutOperation`).
- **A supervoxel id in place of the root skips the point lookup**: `get_atomic_ids_from_coords`
  returns the id itself for a layer-1 id, so the coordinates are only logged with the operation.
  Coda can therefore send its cut's edges as they are, each end with a point near it for the log.
- **The server does not check that the split separates anything.** `edits.remove_edges` rebuilds
  the affected level-2 nodes from whatever edges remain; if the neuron is still connected, it
  writes **one new root** with those edges missing — a silent edit, not a refusal. So Coda must
  establish separation itself, before sending, and treat a reply with one new root as a failure
  to report (and offer to undo).
- `split_preview` runs only the min-cut (`cutting.run_split_preview`); there is no dry run for
  `mincut=false`.
- Preconditions it does check: every id a supervoxel (an `assert`), no self-loop, all ends on one
  root at the operation's time. It does not check that the root is the one the reader saw:
  Coda's pre-flight (root still current) is the only guard against an edit in between.

### Checking separation soundly

The partition check reads the box's supervoxel graph and joins every chunk in the box that has a
link outside it to the outside wholesale. That over-joins, never under-joins, so a check that
says "separated" is right — the property a write needs. It can say "joined" wrongly where the
cut runs through a chunk at the box's edge; then the candidate is not offered.

The experiments' "joined just outside the box" failures were a cut made in one box and checked
in a wider one. Cutting again in the wider box (seeded with the two sides found in the inner one)
and checking there needs no second read.

### The lean pipeline, measured (2026-11-23, same 169 clicks; FANC 15489 ungradable)

Per neuron, before the key: the level-2 graph and every chunk's position, 0.8–3.4 s (larger
neurons slower; 2,836 chunks on FANC 14134). Per key: **one** `subgraph` read of the click's box
one chunk wider (FANC 4×4×5 chunks at ±4.5 µm) with its chunks' supervoxels, at once; then the
joins in the inner box, distance along the neuron from level-2 positions (no segmentation read),
each join cut in the inner box, recut in the wide box, checked, kept if it is a split not yet
shown. Trims (smaller side under 3 chunks) go last.

| | |
| --- | --- |
| Right split first | 73 / 156 (47 %) |
| … within the first 2 | 140 / 156 (90 %) |
| … within the first 4 | 151 / 156 (97 %) |
| … within the first 6 | 154 / 156 (99 %) |
| Box read after the key | median 2.3 s, 90th percentile 4.2 s, worst 9.7 s (FANC median 2.7 s) |
| Computing after the read | median 0.2 s, 90th percentile 0.8 s, worst 1.6 s |

Often fewer than six distinct splits exist near the click (two to five is common). The read is
most of the wait, so it is what phase 2 should hide: start it when the pointer rests on a
segment, not when the key is pressed. Mesh time is browser-side (Coda's earlier measurement:
~1.3 s per Aedes neuron, median of 25) and is per neuron, so it is prefetched too.

The test set is still the large-merge one; small side branches are untested and are what using
the UI will show.

## Phases

0. **Settle the unknowns, reads only.**
   - Whether pychunkedgraph's split can remove *exactly* given edges (`mincut=false`), and what it
     does when they do not separate the root — read from its source, not tried.
   - The lean pipeline, timed per step on both datastacks: per neuron before the key (level-2
     graph, positions, mesh), per key (one box `subgraph` + its chunks' supervoxels, together).
   - Distance along the neuron without the segmentation read (level-2 positions); does it pick
     the same joins?
   - The missing edges past the box: read only a ring of chunks around the box, not a bigger box.
1. **The candidates, pure and tested** — built. `splitCandidates` (a generator, so a caller can
   show each candidate as it comes and yield between them) and `splitOf` (the separation check on
   its own, for the pre-write check); `readSplitNeuron` / `readSplitBox` read for them, the box
   capped at `MAX_BOX_CELLS` (120) cells. Live on the 169 clicks it reproduced phase 0 exactly
   (right split within the first 4 on 151 of 156); box read median 2.4 s, 90th percentile 4.9 s;
   computing median 0.24 s, worst 2.1 s — on the main thread that wants yielding (the generator)
   or a worker.
2. **The key and the session** — built. **`K`** (user's choice, beside `J`; unbound in neuroglancer,
   Spelunker and Coda — `D`, the first choice, turned out to be Coda's Dashboard key), claimed in the frame and handed back like `J`; it goes to the card whose frame the
   pointer is in (`useSplitKey`, `pointerStay`), on a Neuroglancer node whose Dataset is CAVE
   (`split` prop). The session reads, then shows candidates as they come (a slice at a time,
   `SLICE_MS`). Reads are kept (4 neurons, 3 boxes); a chunkedgraph without affinities is refused
   at once after the first answer. **Reading ahead starts only once the key has been used** —
   somebody who never splits puts no load on the server — then a pointer resting `REST_MS`
   (500 ms, `segmentHover.ts`) on a segment reads its neuron, mesh and box — **one neuron at a time**, the latest rest waiting
   for the read in flight (a mesh is a full download at the whole fragment budget).
   The pointer reaches the session through `splitKey.ts` (`onPointerMove`), so the Neuroglancer
   viewer knows only which frame is its. **The key follows the SEAM pack's switch**
   (`useOfferedPack`): off, K does nothing and nothing reads ahead. A box's work that no click
   changes (its joins, each join's split) is kept with the box, so a second press in it pays only
   the distances. **Only the dataset's own layer**: the frame says which layer the hovered segment
   is from (`FrameHoverMessage.layer`), and the key takes it only from `selectionLayerName`'s
   layer — an extra segmentation layer's ids belong to another chunkedgraph. The key is bound in
   `splitKey.ts` while a card that can split is mounted, as the pick key is bound by the review card
   (`segmentHover.ts`), not in `Editor.tsx`. **A box read missing a chunk's supervoxels is
   refused**: `leaves_many` drops ids silently, and a chunk read as outside the box would let the
   separation check pass a cut that does not separate.
3. **The gallery** — built. One canvas, a drei `View` per tile tracking its element; every tile
   shares one geometry (positions, triangles, normals) with its own vertex colours. A vertex takes
   its nearest chunk's side (`splitColours.ts`, found once per neuron). Until the mesh lands a tile
   draws the chunk points. The mesh comes from the chunkedgraph's own mesh service
   (`readGrapheneMesh`, reduced to `TILE_TRIANGLES`), not the Dataset's — Aedes has no wiring in
   `spec.ts`, and the split needs only the chunkedgraph. Two browser-only traps found: drei's
   `TrackballControls` binds A/S/**D** on the window unless `keys` is blanked, and under
   `frameloop="demand"` a drag turns nothing unless the tile asks for a frame on pointer moves.
   Checked in Chrome (`tmp-gallery-probe.mjs`) on Aedes …268769: five tiles in 4.3 s, the right
   split first; drawing, enlarging and turning work. **A real mesh is unchecked**: on 2026-11-23
   the mesh service (`cave.fanc-fly.com`) refused every manifest ("command not allowed under OOM
   prevention"), so the mesh path was checked with a stand-in mesh through the same code.
   **Colouring, made exact at the cut (2026-11-23).** A split records, for each chunk it runs
   through, every supervoxel's side (`divided`), and a chunk is coloured by the side most of its
   supervoxels are on. Once a press has its candidates and its mesh, the session reads the
   segmentation (~32 nm) over each grid cell such a chunk is in and gives each vertex there the
   supervoxel under it (searching two voxels around, a surface vertex being as often just outside);
   those vertices take their supervoxel's side. Elsewhere a vertex takes the nearest chunk point
   **in its own grid cell** — a level-2 chunk lies in its cell, so the next cell's branch cannot
   claim it. Before this a chunk the cut ran through was drawn wholly on its first supervoxel's
   side, which drew a third "piece" (648518347570445672).
   **Minimum piece 10, 120 joins (2026-11-23).** `MIN_PIECE` 20 was set on FANC; Aedes
   supervoxels are larger, and on 648518347570445672 the false-merged piece was 17 — never a
   candidate, so the gallery offered the next joins out. At 10 it came first; but with more small
   joins the weakest 40 left out FANC 160610's (moderately strong) right join, so the walk now takes
   120. On the 156 gradable clicks: right split first 71 (was 73), in the first 2 148 (140), first 4
   153 (151), first 6 **156** (154). Computing after the read: median 177 ms, worst 1.5 s.
4. **The write**: `src/data/cave/edits.ts` only, behind the same guards as merges (pre-flight
   that the root is current and the reader may edit; never retried; tests never write; a live
   write on `fanc_sandbox` only, asked every time). `/simplify` then `/code-review` before use.

   **Built (2026-11-23).** One chain, held apart from the merge path's in `importGraph.test.ts`
   (`CHAINS`): `edits.ts` (`confirmSplit` → `splitSupervoxels`, `POST …/split?mincut=false` with
   `sources`/`sinks` paired, ids as text) ← `packs/seam/splitWrite.ts` (the checks) ←
   `ui/seam/splitAccept.ts` (the state) ← `SplitGalleryHost.tsx` (Accept, Undo).
   - **Before the send:** the cut checked again against the box (`splitOf`, shared numbering, so
     it costs one union-find copy) — which also orients every edge from side `a`; the permission
     (`editRefusal`, the merge plan's sentence); `is_latest_roots` on the root at the server's now.
     No fresh box read: a root id names one fixed graph, and the root is checked current.
   - **After:** one new root in the reply, or the two sides' ends read back under one root, is
     the server's silent edit — reported with **Undo**. Ends still under the old root is `unknown`
     (a graph that keeps nothing). A lost reply, or none within `SEND_TIMEOUT_MS`, is `unknown`
     and never resent; reads have `READ_TIMEOUT_MS` (`editWaits.ts`, shared with the merge batch).
   - **The gallery is held while a write is out** (`holdSplit`): Close does nothing and K says
     why, so the answer lands on the tiles it was chosen from. A send unanswered after
     `SEND_TIMEOUT_MS` is `unknown` and stays held (`out`) until it answers or ten minutes pass
     (`STILL_OUT_MS`, as Submit's); a late `done` is kept for Undo. Every wait is bounded, Undo's
     too, and a fault in the write still lets go.
   - **One write path at a time** (`editWaits.ts`' `registerWriteOut` / `otherWriteOut`): a merge
     Submit waits while a split is out, and Accept while merges are — two edits in flight to one
     neuron would apply one to a root the reader never saw.
   - After anything that may have written (an edit, or no answer that says), Accept is off for
     that press; K again reads the neuron afresh. Undo (`undoEdit`, which also undoes the merge
     probes' merges) is offered once per Accept where the gallery stays open — the writer forgets
     an edit as its undo is sent. A clean split closes the gallery, and with it the Undo (below).
   - Each cut end's side is its own supervoxel's (`splitOf(...).sideOf`), never its chunk's: an
     end on a third piece the cut also breaks off refuses the send.
   - **Live test on `fanc_sandbox` (2026-11-23, `scripts/probe-split-sandbox.mjs`): refused by a
     server bug.** Root 648518346491143527, split 2 (3 edges): every check passed, the send
     answered **500 "To change to a dtype of a different size, the last axis must be
     contiguous"**, and the roots read straight after and again later were unchanged. Cause, read
     off pychunkedgraph (`c75ace9` and `main`, 2026-11-23) and reproduced in numpy 2.4.6:
     `ChunkedGraph.remove_edges(mincut=False)` builds `np.array([source_ids, sink_ids]).transpose()`,
     which for **two or more edges** is not C-contiguous; `SplitOperation` and `edits.remove_edges`
     keep that layout (`np.concatenate([atomic_edges, atomic_edges[:, ::-1]])`), and
     `utils.general.in2d` then views it as `"u8,u8"`, which numpy refuses for a non-contiguous last
     axis. One edge is contiguous and passes. It fails inside `_apply`, before `_write`, so nothing
     is edited (an operation id and its log entries are spent). So the HTTP split with the
     min-cut off takes single-edge cuts only**; the fix is server-side (`np.ascontiguousarray`).
     The sandbox has no level-2 cache either ("Dataset mar2021_test does not have an L2 Cache"),
     so the script places chunks at their grid cells' centres; the write path is unchanged.
   - **A one-edge split, live on `fanc_sandbox` (2026-11-23): made and undone.** Root
     648518346484552781, split 2 (1 edge, 3 chunks off): operation 107194 made two roots (3 and
     293 L2; the gallery said 3 + 292, the cut's chunk now on both sides), read back apart, the
     kept root named; undo 107195 put every end back under one current root of 295 L2, as before.
   - **So a longer cut is sent as the server's own min-cut (user, 2026-11-23).** `SplitAsked` is
     one edge (`mincut=false`) or a min-cut between the cut's two sides as seeds (`mincut=true`),
     chosen once in `planSplit`. Before a min-cut is sent, its read-only preview
     (`graph/split_preview`, `splitPreview.ts` — the same box, subgraph and `run_multicut` the
     split runs) must not be one the server flags illegal, must keep every seed on its side, must
     hold no supervoxel outside the box Coda read, and **must cut exactly the tile's edges** (an
     edge of the box between two of the preview's pieces is one the server cut); else nothing is
     sent, in a sentence. Where the tile's cut is the minimum between its sides, the server's min-cut is that
     cut. The currency check runs after the preview, last before the send. The body is one
     (`splitBody`, `merge.ts`), so the preview is asked exactly what would be sent.
   - **A two-edge min-cut split, live on `fanc_sandbox` (2026-11-23): previewed, made, undone.**
     Root 648518346491143527, split 3 (2 edges, 19 chunks off): the preview cut exactly the tile's
     two edges; operation 107196 made two roots (189 and 20 L2; the gallery said 189 + 19, the
     cut's chunk on both sides), read back apart, the kept root named; undo 107197 put every end
     back under one current root of 208 L2, as before.
   - **Islands in cells two branches share (2026-11-23).** On 648518347493136877 near
     (16434, 15566, 4950) the reader still saw islands. Every candidate had grid cells holding
     chunks of both sides with no chunk cut there, so those vertices took the side of the nearest
     chunk point (one point per chunk) and could take the other side's. The exact placement now
     reads **every cell where some tile has both sides**, first tile first, three cells at a time
     (~1.3 s a cell at 32 nm on Aedes), recolouring after each. Chunks there outside the press's
     box have their supervoxels asked once (`leaves_many`), alongside the first reads; if that
     fails, the cells are read anyway. That case: 19 cells over 5 tiles, 18 of them the first
     tile's. The placement does not depend on the cuts on show, so it is kept for the press: a
     Regenerate reads only the cells its new cuts add, and the tiles keep what is placed.
   - **A clean split closes the gallery (user, 2026-11-23).** The answer stays on the status bar
     and the card shows the pieces. A refusal, one piece still (with Undo), or no answer leaves
     it open.
   - **Regenerate (2026-11-23).** Under the tiles, while none is enlarged and no split has been
     written from the press: the next set of splits near the same point — the same walk, nearest
     first, with every split offered for this press so far passed over
     (`SplitGalleryOptions.exclude`, by `sameSplit`), so trims held back from a full set come up
     in the next. Nothing is read again; the set on show stays until the new one is complete, and
     where nothing more is found it stays, marked as the last ("these are the last found"). The
     exact colouring reads only the cells the new cuts add, and a pass still running for the old
     ones stops taking cells. On the toy with thirteen splits: 6, 6, 1, then none.
   - **Escape steps back (user, 2026-11-24).** With a tile enlarged, Escape is Back to all (and,
     like Back, does nothing while a write is out); with all tiles shown it closes. The ✕ always
     closes.
   - **Meshes vanishing on a drag (2026-11-24).** A tile's geometry borrows the shared positions,
     normals and triangles; recolouring it (each exact cell, a Regenerate) rebuilt it and disposed
     the old one, and three's `dispose` frees the GPU buffer of every attribute the geometry holds.
     The other tiles went on binding the deleted buffers and drew nothing from the next frame — a
     drag, under the `demand` frameloop — while the point, its own geometry, stayed. A tile now
     detaches the shared attributes before disposing (`disposeOwn`, `splitTiles.test.ts`).
   - **The card shows the pieces (2026-11-23).** A press names the card it was over, by document
     and node (`SplitRequest.card`, from `ValuePreview` through `useSplitKey`); once a split is
     answered and read back (or answered late, or left one piece), `splitAccept.ts` reads that
     node's `selectionEdits` from the store **at answer time** and takes the old root out and the
     new roots in (`replaceSegments`, the double-click fold) — only while that document is on
     screen and holds the node, since node ids repeat across documents. Both pieces show; a
     double-click takes one away. An undo puts its root in their place. Where every end was read
     under the old root still, the card is left alone. Its own undo step (`setParamsMany`, a tag
     apart from a pick's, so a pick made just before is not taken back with it); written after
     the gallery's state, and caught, so a fault there never holds the gallery. An undo still out
     after `SEND_TIMEOUT_MS` holds the gallery as a split does, and sets the card right if it then
     answers that it was made; its pieces are only un-added, never noted as removed.
     Not done: other cards on the same datastack, and merges from the review card, do not update
     their roots (one datastack-wide "roots replaced" notice would serve both).
