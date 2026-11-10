# SEAM's merge candidates in Coda — plan

A plan, not a record of what is built. The pack's other plan is
[seam-plan.md](seam-plan.md); SEAM's side of this one is
`~/Github/SEAM/docs/handoffs/coda-merge-candidates.md`, and everything below takes its numbers
from there rather than restating its reasoning.

## The direction of the error, because it is easy to get backwards

The two nodes already in this pack — `seam:findMerges`, `seam:affinityClusters`, both retired —
look for **false merges**: one segment that is really two neurons, and the fix is a split. This
plan is the other direction. SEAM finds **false splits**: a neuron that stops at a tip when a
separate piece of segmentation nearby is very likely its continuation, and the fix is a merge.

So "Find Merges" finds false merges and "Merge Suggestions" suggests merges. That sentence is the
trap, and it is why the nodes below get unambiguous **labels** even though they keep the type ids
SEAM reserved.

**Read-only, as always.** SEAM suggests; the proofreader makes the merge with the `m` tool in
Coda's own neuroglancer frame, with their own CAVE token. Nothing here writes to a chunkedgraph
(SEAM invariant 7, Coda's standing rule).

## Decisions taken (2026-11-09, user)

- **Carry on on `pack/proofread`.** The pack, its glyphs, See-also and help scaffolding are here,
  and the retired nodes are what a reviewer wants to see beside the new ones.
- **The fixture is hosted**, beside the Model A manifest, and read by URL. A trimmed copy is
  committed for tests. This is what keeps the node's input the same shape when a real API replaces
  the files.
- **A card reads a *directory* of sets, not one file** (2026-11-09, after the first one landed).
  A server-side pipeline deposits each run into a hosted directory; the node takes that
  directory's index and a `Set` picker chooses one. **A browser cannot list an HTTP directory** —
  there is no portable way, and Coda's only bucket listing is GCS-specific — so the directory has
  to advertise itself with an index the pipeline writes, as a precomputed volume has `info`.
  One field takes either an index or a single set's manifest, told apart by what the document is.
- **One set per card, pinned by name.** Several at once is a merge downstream, where the
  provenance is visible. The card stores the set's id, so a newer run appearing in the directory
  shows in the dropdown and changes nothing until somebody picks it — which is what keeps
  invariant 4 honest, since the provenance key cannot see a file that changed under it.
- **This hosted path is a second leg, not the destination** (user, 2026-11-09): local inference in
  the browser stays preferable, and this exists for specific large-scale proofreading projects.
  Phases 5–8 are still the goal rather than a stretch.
- **The source node lands alone** before any review UI rests on its shape.
- **Verdicts go into the workflow**, as a presentational param on the review node, exported
  through `out.download` in the columns `verdicts.parquet` already has. There is no SEAM API to
  POST to yet, and a verdict that survives a reload is worth more than one that needs a service.

## Model E's shape (decided 2026-11-10, user)

Asked once the model was hosted and the skeleton port was done, because both answers change what
gets built rather than how.

- **Windows are cut per tip, not over the whole neuron.** SEAM scans everything — 60,668 cells on
  `648518347558097460` — but `e_tip` reads only the best cell **within 1 µm of the tip**, so every
  window that covers no tip is work whose answer is never asked for. Scoring a tip's own
  neighbourhood is what makes "ready in seconds" plausible at all, and it is the difference
  between a node that streams and a node with one long wait at the front.

  **And it costs nothing in accuracy**, which was not obvious and is the reason to write the
  argument down rather than the tolerance I first assumed. `Scan` draws its centres once from the
  whole surface (`default_rng(seed)`) and builds window `i` from its own stream
  (`default_rng([seed, i])`), so a window is the same window whether or not its neighbours are
  evaluated — selecting a subset is selecting, not re-sampling. And a window's points all lie
  within the 15 µm crop of its centre, so a point within `E_TIP_UM` (1 µm) of a tip can only come
  from a window whose centre is within 16 µm of that tip. Take every centre inside 16 µm and the
  pooled maximum over that subset **is** the whole-neuron maximum for every cell the tip reads.
  `e_tip` is exact, not approximate.

  The probe therefore does both and checks that claim rather than asserting it: the whole-neuron
  scan against `e_cells/<neuron>.npz` to show the port is faithful, and then `e_tip` computed
  from the 16 µm subset against `e_tip` computed from the whole neuron, on the fixture's own
  tips, where the expected difference is **zero**.

- **The streaming node is built now, with its later stages empty.** Model E goes in as the first
  live stage of the node that will eventually run stages 1–9, rather than landing as a node of its
  own that would have to be retired when the search arrives. What it can publish today is a
  neuron's open ends ranked by `e_tip`; `ctx.publish` grows that list as tips are scored, and the
  stages below it fill in behind the same output.


## The in-browser pipeline (decided 2026-11-09)

The destination is **one node** that finds merge candidates for a neuron on demand, and streams:
Model E scores the neuron's tips, a tip is picked by score, full inference runs on that tip, its
candidates go onto the wire, repeat. `ctx.publish` is exactly that mechanism — "the value on the
wire growing", read by a downstream card through `inputValues` with nothing re-running — and
`ReviewBody` already reads its queue from `inputValues`, so the review card fills live. It
publishes the same `Tips`/`Candidates` shape `seam:suggestions` does, so `seam:review` takes
either.

**Tips come from a skeleton, not from Model E's peaks** (user, 2026-11-09). My worry that this
was unportable was wrong on both counts, and worth writing down so nobody re-derives it:

- **navis-fastcore has a Pyodide wheel** (`cp39-abi3-pyemscripten_2026_0_wasm32`), and Coda
  already ships one — `sources.json`'s `fastcoreWheel`, pinned at 0.13.0.
- **skeletor's wavefront path is pure Python** and needs numpy, pandas, scipy, tqdm, networkx —
  every one of them in Pyodide — plus `trimesh`, which is pure Python but *not* in Pyodide and so
  needs a wheel, as `dotmotifPackages` does. `igraph` and `ncollpyde` are in skeletor's
  requirements but not on this path.

So the skeleton is `skeletor` plus the clean-up steps navis adds around it, rather than navis
itself. What that buys is the calibration: `p_tip`, the cutoff and `r` were fitted with `e_tip`
read at a *skeleton* tip, and tips defined another way would need SEAM to refit all three.

**Model E goes straight into that node** rather than landing as one of its own (user). Its parity
against `e_cells/*.npz` is checked by a probe *before* anything is wired to it — the one thing
Find Merges did out of order.

**Exact parity is available and should be taken.** The cells depend on two seeded draws,
`default_rng(0)` for the window centres and `default_rng([0, i])` for each window's points, and
Coda's vendored `scan.py` is byte-identical to SEAM's — so the same PCG64 stream gives the same
windows, and the comparison is cell for cell rather than within a tolerance.

**What a tip is picked by, until the assessors land**, is `e_tip`: `p_tip` needs `segclr`, which
is the assessors' best ref logit, which is the expensive stage being deferred.

## Model E, measured (2026-11-10, `pnpm probe:seam-e-cells`)

On `648518347558097460`, 417 windows, against `e_cells/648518347558097460.npz`.

| | Coda's CAVE mesh | SEAM's own cached mesh |
| --- | --- | --- |
| cells | 31,853 (ref 31,865) | **31,865, every one shared** |
| logit mean / max error | 0.29 / 4.52 | **1.3e-4** / 1.13 |
| `e_tip` mean error | 0.29 | **0.008** |
| tips off by > 0.1 (of 548) | 387 | **11** |

**The port is exact; the mesh is not.** Given the surface SEAM scored, Coda's windows, Model E and
the pooling reproduce SEAM's cells one for one at 1.3e-4 — which is the GPU's arithmetic and
nothing else, the same order `probe:seam-model` measures against PyTorch. Given Coda's own mesh,
`e_tip` moves by 0.29 on average, which at p_tip's E weight of 0.959 moves p_tip's logit by about
as much, on two tips in three.

**And the meshes are the same surface.** Both have 3,707,915 faces and the *same 1,850,570
distinct coordinates*; sorted canonically they are the same multiset of triangles. What differs is
the **order** — fragments assembled in a different sequence, and vertices numbered to match (SEAM
1,859,893, Coda 1,874,042, both holding boundary duplicates, just different ones). `sample_surface`
draws faces against an rng, so a reordering sends the same random numbers to different triangles:
the same surface, sampled at different points, scored differently. Nothing about it is visible in
a vertex count, a bounding box or a cell count, which is why this needed a probe rather than a
reading.

So **SEAM's calibration is tied to cloudvolume's face order**, and that is the thing to fix rather
than to work around. The robust answer is a canonical face order inside `canonical.py` before the
draw — one sort, and then any fetcher gives the same answer — but those files are vendored
byte-identical, so it is SEAM's to make, not Coda's. Until then a Coda-fetched mesh and a
SEAM-fetched one are different inputs to the same model.

**The other measurement: the tiling was paid per call, and now is not.** `Scan` builds its face
grid and its seeded surface draw in its constructor, and `coda_seam_windows` used to construct one
every time — so scoring a single tip's 10–13 windows took 5.4 s, of which 4.9 s was re-tiling a
3.7 M-face mesh that had not changed, and the whole neuron took 126 s of which 69 s was fourteen
re-tilings, against 3.5 s of inference.

`SeamWindowRequest.meshKey` keeps one tiling between calls (one, not a dictionary: it holds the
mesh as float64, ~134 MB on this neuron, in a heap that never gives memory back), and the mesh
itself stops crossing after the first call. Re-measured, same neuron, same windows:

| | before | with the tiling kept |
| --- | --- | --- |
| one tip | 5,446 ms | **423 ms** |
| whole neuron | 126 s | **63 s** (tiling 69 s → 5.6 s) |

The answer is unchanged — the same 31,865 cells at the same 1.3e-4 — which is the property the
probe asserts rather than the speed.

**The selection claim holds exactly.** `e_tip` from the 16 µm selection equalled `e_tip` from the
whole neuron on every tip tested, as the geometry says it must.

### What was decided about it (2026-11-10, user)

**Accept the drift for now.** The node is built on Coda's own meshes and SEAM's cutoff and `r`
are treated as approximate until the face order is settled, which means the shown set a reader
sees here is not tip-for-tip the one SEAM's pages show. Written down because it is the kind of
difference that later reads as a model disagreement: it is not: it is the same model on the same
surface sampled in a different order, and the number above — `e_tip` off by 0.29 on two tips in
three — is how big it is. The probe is what re-measures it after any fix, and `--mesh` is what
isolates it.

**The `Scan` is cached before the node is built**, since 4.9 s of a tip's 5.4 s is re-tiling a
mesh that has not changed.


## `seam:openEnds` — Find Open Ends, measured (2026-11-10, `pnpm probe:seam-open-ends`)

The node that will run stages 1–9, with stage 3 live. Meshes in; the fixture's `Tips` table out,
built from `TIP_FIELDS` so `seam:review` takes it without knowing which node made it, with every
column a later stage will fill present and null.

On `648518347558097460`, through the node's own `evaluate`:

| | first run | with the skeleton healed and the sweep reordered |
| --- | --- | --- |
| open ends | 4,418 | **1,214** (SEAM: 548) |
| first rows | 45 s into a 75 s run (60%) | **21 s into 73 s (29%)**, 31 rows |
| publishes | 9 | 14, each at least as long as the last |
| SEAM's tips found again | 80% | 75% |
| median \|Δe_tip\| on those | 0.200 | 0.198 |

**Two things the first run found, both of them silent.**

*The skeleton has to be healed.* A wavefront skeleton of a segmentation comes back as many
disconnected fragments, and a forest and a tree are the same parent array with more `-1`s in it —
so every fragment contributed two ends that are nothing but where the reconstruction was cut into
pieces. `LEAFS` with a 1 µm cap, SEAM's own choice, takes 4,418 to 1,214. Nothing about the
original number looked wrong: they were ordinary tips with ordinary scores. It is a card setting
(`Heal fragments`) applied to a **wired** skeleton too, for the reason the prune is: a wired
wavefront skeleton is fragmented in exactly the same way, and a node that healed only what it
made itself would answer a different question depending on which port was used.

*The order of the sweep decides when a row can appear.* A window is built from its own seeded
stream, so the order is free — and the tiling's own order is a grid walk with nothing to do with
where the tips are. Visiting each tip's neighbourhood in turn (`sweepOrder`) moves the first rows
from 60% of the way through to 29%, and drops the centres no tip can read, which are work whose
answer is never asked for.

**What the remaining 1,214 against 548 is**, as far as it has been measured rather than guessed:

- **The soma mask was inert on this dataset, and now is not.** `MeshGeometry.soma` is null for
  this neuron (checked), so the 10 µm mask never ran, where SEAM masks with
  `build.nucleus_xyz_at`. The card now takes a `Nucleus table` and a Dataset reference and reads
  the somata itself: **1,214 ends → 853**, with all 410 of SEAM's matched tips still found, so it
  removed cell-body ends and nothing else. The Aedes table is `nuclei_v1_aedes`.

  **It reads the table rather than taking one from a wired CAVE table node**, which was the
  first shape considered. A plain CAVE query answers in the table's own voxels — `spec.ts`
  records establishing that by asking for both and watching the values divide by 4, 4 and 40 —
  while `somataFor` asks at `[1, 1, 1]`. A soma a factor out either masks nothing or masks the
  whole neuron, and nothing fails either way. `annotation.caveTable` gained a `Position units`
  field in the same change, so a reader who *does* want a table's positions as geometry can ask
  for nanometres there.
- **`drop_internals` is not run by this node, and does not need to be.** SEAM's skeleton stage
  strips internal membrane first; Coda has the same pass on **Clean Meshes**, which is
  `fc.drop_internals` — navis-fastcore, compiled, with Coda's card defaults (threshold 0.05,
  16 rays, 3 passes) matching navis' own. So `Meshes → Clean Meshes → Find Open Ends` runs it
  today, and the scheduler caches it per neuron rather than per run.

  **Measured in Pyodide on this neuron** (3.7 M faces): **98 s**, keeping 84% of the faces. The
  earlier note here said "178 M ray casts, minutes in wasm against seconds on SEAM's cluster" —
  that was arithmetic off a code comment, not a measurement, and it is replaced by this one.

  What it does to the ends, with the soma mask already on: **853 → 394**, against SEAM's 548. So
  it is not the missing piece that closes the gap — it crosses it. 381 of SEAM's 548 tips are
  still found (70%, from 75%), so it takes about 29 real ones with it. A first run at the card's
  *maximum* threshold of 0.5 gave 383 and lost 46, which is the card's own help being right that
  "above about 0.1, real membrane starts being removed".

  Where the remaining difference is has not been measured. Coda and SEAM run the same
  `drop_internals` on the same surface, so it is somewhere later — the skeletonization, the heal
  (SEAM's own header says a 5 µm cap where its constant is 1 µm), or the tip rule.

The `|Δe_tip|` of 0.198 is the **mesh-order difference** measured above, not this stage: the node
reads a CAVE mesh whose faces are the same triangles in a different order.

### Kinks, and a correction to every number above (2026-11-10)

**SEAM's candidates are tips *and* kinks**, and at the time of this reading the node made only
the first (the section below builds them). A kink is a sharp turn inside an unbranched run,
where a side branch swallowed the real end (`tip_kinks.py`: a node with one parent and one child
whose path turns by more than 60° over 1 µm each way, thinned greedily so none lies within 2 µm
of a kept kink or of a tip).

That matters for reading every comparison written above, because they were against the whole
candidate list. On `648518347558097460` SEAM's **548 is 382 tips plus 166 kinks**, so a third of
the target was something the node is not trying to produce. Measured again, split:

| | ends published | SEAM's 382 tips found | SEAM's 166 kinks |
| --- | --- | --- | --- |
| meshes as fetched | 853 | **366 (96%)** | 44 (27%, incidental) |
| + Clean Meshes `drop_internals` | 394 | **380 (99%)** | 1 |

So the earlier readings were wrong in the same direction twice. "853 against 548" was not an
overshoot of 1.6x but of 2.2x against the real target — and "394 against 548, crossing the gap
and losing 29 real tips" was exactly backwards: at 394 ends the node finds **99%** of SEAM's
tips, and the apparent loss was kinks it never had. `drop_internals` removes 459 spurious ends
and *gains* 14 real ones; it is clearly worth its 98 s, and it is already available by wiring
Clean Meshes upstream, cached per neuron.

**What kinks would be worth.** Across the fixture's five neurons they are 610 of 2,708
candidates (23%) — but only **2 of them are `shown`**, against 118 of 2,098 tips. So for the set
a proofreader actually works through they are about 1.7% of it. They are not worthless when
looked at: of the candidates the user judged, a kink's first candidate was right 19 times in 38
against a tip's 216 in 359 — about the same hit rate. They simply rarely clear the cutoff.

### Kinks built, and measured (2026-11-10)

`Also look for kinks` on `seam:openEnds`, off by default. `tips.ts` grew `kinkNodes` (the walk
and the turn) and `thinKinks` (greedy, sharpest first), and `tipsOf` runs them in
`tip_candidates.py`'s order, which is the detail worth writing down: the thinning excludes a kink
near a tip and reads the tips at their **skeleton** positions, *before* anything is snapped or
soma-masked — then both lists go through one snap and one mask. `tip_kinks.py`'s own `main` thins
against snapped, masked tips instead, so the two SEAM scripts disagree with each other; the
production candidate builder is the one that made the fixture, so it is the one followed.

Measured on `648518347558097460` (`--kinks`, same nucleus table, same run):

| | ends | SEAM's 382 tips | SEAM's 166 kinks |
| --- | --- | --- | --- |
| meshes as fetched | 964 (111 kinks) | 368 (96%) | **124 (75%)** |
| + `drop_internals` | 557 | **380 (99%)** | **153 (92%)** |

The second row is the honest one: 557 candidates against SEAM's 548, 99% of the tips and 92% of
the kinks. **The kinks are what is sensitive to the mesh**, which follows from what a kink is — a
turn in the *skeleton*, so a wavefront run over a surface full of internal faces smooths corners
that SEAM's run keeps. The tips barely move (96% → 99%).

Why it is off by default, which is the measurement above and not a preference: **111 of 964**
candidates are kinks, so about an eighth more run, and only 2 of the fixture's 610 are `shown`.
(An earlier draft of this section and of the help said "a fifth" and "a quarter" — both were
guessed off the fixture's 23% rather than read off the run, and 111/964 is 11.5%.)

One change outside the pack came out of the cleanup pass: **`parentDistances` and `skeletonTree`
disagreed about an out-of-range parent** (`topologyOps.ts`). `skeletonTree` read one as a root and
said why; `parentDistances` guarded only `parent < 0`, so it indexed past the end and returned
`NaN` for that node. Every caller pairs the two. A `NaN` length is the bad kind of wrong — it
fails every comparison it is put in, so a walk accumulating one never decides it has gone far
enough — and the kink walk is exactly such a walk. Widened to `skeletonTree`'s rule, with a test.

`kinkNodes` keeps its own child counts rather than calling `skeletonTree`, and that is now
measured rather than assumed: on a 200,000-node skeleton, which is an ordinary wavefront one,
`skeletonTree`'s array-per-node shape is **13.5 ms against 0.5 ms** for two typed arrays, per
neuron and on the main thread.

The review pass over the kink code found one bug that was not the kink code's: **the model
session was opened before `nucleiFor` and closed only in a `finally` that started after it**. A
datastack without the named table answers 500 — which is how a mistyped table name arrives, and
it happened twice while this was being built — so the likeliest throw in the node left a WebGPU
session and a 71 MB model in a heap nothing gives back. Everything that can throw now sits
inside the `finally`. Not unit-testable here: `evaluate` needs WebGPU, a real `Worker` and the
weights, which is why `openEnds.test.ts` covers only what holds without them.

### What the review chain found (2026-11-10)

Three things the probes could not have, because each is a *number* rather than a failure.

- **`reachNm` was short by a face.** The streaming argument says a cell within 1 µm of a tip can
  only come from a centre within 16 µm. But `canonical.crop_faces` keeps faces by **centroid** and
  then keeps all three of their vertices, so a sampled point can lie outside the crop radius.
  Measured on the Aedes mesh: 55 nm median, 128 nm at p99, **455 nm worst**. Half a micrometre of
  slop (`CROP_SLOP_UM`) covers all of it. Without it a tip could settle one page before a centre
  that would have raised its score.
- **Pooling page by page is not pooling once.** `reduce_max` keeps the best *point* per 0.5 µm
  box, so a box scored on two pages comes back with two representatives at two positions. A tip
  reads "the best cell within a micrometre" measured from the representative's position, so a box
  whose true representative sits outside the micrometre but whose page-local one sits inside would
  count — always too high, never an error, and invisible to `probe:seam-e-cells`, which re-reduces
  cumulatively and so measured a pipeline the node was not running. The node now keeps a pool
  keyed by box and reads a tip's score **at the moment it settles**, which is exactly the
  whole-neuron answer: every point that can land in a box the tip reads comes from a centre in
  that tip's own reach set.
- **A checkpoint without a `scan` block downloaded its weights before being refused**, and leaked
  the GPU session, the throw landing between `openModel` and the node's own `try`. The check is
  now a callback `openWindowModel` runs before it fetches anything.

None of the three changed the measured answer on `648518347558097460` — 1,214 ends, 410 of SEAM's
548 matched within 1 µm, median |Δe_tip| 0.198 — which is what makes them worth recording: the
run that was wrong and the run that is right look the same from outside.

## Why this order, and what it is answering for

The two retired nodes were built end to end against a checkpoint nobody had measured on the task,
and the measurement that retired them was available on day one — a neuron with a merge somebody
had already found. **This pipeline arrives with that measurement already made**: 377 judged tips,
360 judged first candidates, 217 right and 143 wrong, and a cutoff calibrated on them. So every
phase below can be checked against real verdicts before the next one is built, and the first three
phases need no model, no WebGPU and no export at all.

That is the whole reason the UI comes first. It is not the easy half; it is the half that can be
judged.

## What Coda already has

Named here because the plan's cost depends on it, and because "we will need X" where X exists is
how a second X gets written.

| Needed | In Coda today |
| --- | --- |
| Read a remote parquet by byte range | `bytesOf` → `openParquet` → `readRows` (`src/data/files/`). Range-ignoring servers refused, codecs checked, footer fingerprinted |
| A file rewritten under a running graph | `footerFingerprint` / `requireFingerprint`, and Link Table's ⟳ |
| IDs that stay text | invariant 8, `core/ids.ts`; the parquet reader's own int64 rule (`columns.ts`) |
| Local annotation layers over the EM | `src/packs/seam/scene.ts`, already building `local://annotations` with per-point colour |
| Segments set in the frame without a reload | `coda:ng-set-segments`, with the `FRAME_UPDATE_KEY` echo |
| Review shortcuts while focus is in the frame | `coda:ng-keys` / `coda:ng-key`, the claim-and-forward pair |
| A root that changed under a saved suggestion | `staleRoots` (`src/data/cave/rootIds.ts`), `cave.updateRootIds` |
| A tap node that writes on a gesture, never from `evaluate` | `annotation:editor` + `AnnotateBody`, the stated model |

## What it does not have

- **`coda:ng-set-annotations` and `coda:ng-edit`.** The handoff calls them planned; they are.
  (`coda:ng-set-view` is built — see the review card below.) `src/ngframe/main.ts` is 271 lines with one inbound message switch, so the
  shape is established and the work is bounded — but it is shared code the Neuroglancer card
  already depends on, which is why it lands on its own.
- **Nested parquet columns.** `readableColumns` (`parquet.ts:174`) skips any column with
  children, so `verdicts.parquet`'s `belongs[]` / `not_belongs[]` would be dropped **silently** by
  the generic path. See "What to ask SEAM for".
- **Any service.** No API, no Connections tab, nothing to POST a verdict to.

## The two nodes

Type ids are SEAM's reserved ones (`coda-pack.md`), because a type id is persisted in every file
that uses it and is expensive to change later. The **labels** are not, so they say the direction.

### `seam:suggestions` — "Merge Suggestions"

An `expensive` source node. `Suggestions` is the address of a directory's index — or of one set's
manifest — and `Set` picks which of the directory's sets to read.

**The manifest is `fixture.json`.** It already carries the snapshot, the datastack, the neurons,
every frozen fit and the counts — exactly what `src/ml/manifest.ts` does for a model. The node
takes that one URL and resolves the parquet files against it, so the day a service answers instead
of a directory, the node's input is unchanged. The fits ride along for Phase 4.

Outputs:

| Output | Grain | Contents |
| --- | --- | --- |
| `Tips` | 2,708 rows | the queue: neuron, end_uid, kind, x/y/z, e_tip, segclr, p_tip, the first candidate and its contact, q, **shown**, r |
| `Candidates` | 103,375 rows | the ranked lists kept by the own-tip rule: end_uid, cand_root, contact, vol_um3, geo_rank, the three assessor scores, logit, p_cand, rank, conf |
| `Points` | one per tip | the tips at their nanometre positions, carrying the `Tips` columns as attributes |
| `Neurons` | 5 rows | the root ids, so `Meshes` can be wired straight on |
| `Layers` | — | a local annotation layer of each shown tip and its contact point |

**No filtering params.** `shown` is SEAM's absolute cutoff (invariant 14) and `r` is on every row;
anything narrower is a `Filter Table` downstream, where the cut is visible as something somebody
did. This is the lesson from `Score cutoff`: a cut baked into an expensive node is a re-run per
look, and a cut hidden inside one is indistinguishable from a model's verdict.

`candidates_all.parquet` (270,700 rows, the pre-own-tip-rule search output) is **not** read. It
exists to check Phase 6 and nothing before then needs it.

### `seam:review` — "Review Suggestions"

A `cheap` pass-through tap in `annotation:editor`'s style: tips in, tips out unchanged, so it sits
mid-chain and its `Layers` feed `out.neuroglancer`. Every param presentational; nothing it does
can change what `evaluate` returns.

Its card body holds the queue, the current item, and the verdict buttons. The unit of review is
**a tip with its first candidate**, as the user's own review pages had it — the rest of the list
is context, not further suggestions, because the cutoff was calibrated on firsts only.

The verdict vocabulary is SEAM's, so the output can feed the next calibration without a
translation nobody checks: per candidate *belongs* / *not it*; per tip *nothing missing here*,
*piece not listed*, *unsure*.

Moving to an item posts `coda:ng-set-view` and `coda:ng-set-annotations` to the frame: the camera
on the contact, the neuron and the candidate as segments in two colours, the tip and contact as
points. Shortcuts go through `coda:ng-keys`, avoiding neuroglancer's single letters — `m`, `c` and
`f` are live graphene edits in that frame and must stay the proofreader's.

## Phases

**Phase 1 — `seam:suggestions`. Built.** The node above, against the hosted fixture. Done when it
reproduces the fixture's own counts from a real fetch: 2,708 tips, 97 shown, 103,375 candidates,
5 neurons, and 711 tips at r ≥ 0.5. A probe reads it through the real path, as
`probe-seam-merge.mjs` does for Model A. Nothing else depends on its shape until this lands.

**Deferred, with a decision attached: filters on the node or on the review tap?** (user,
2026-11-09). The existing Twig Capture panel filters a neuron's candidate list by `p ≥`, by
mitochondrion flag, by review state, and sorts by probability — and that is the idiom a
proofreader already has. Coda should offer the same. **The likely shape is that `seam:suggestions`
loads everything and `seam:review` filters**, which keeps the expensive node free of cuts (the
`Score cutoff` lesson) and puts every filter on a presentational param where moving it costs
nothing. Not decided; it waits until the review tap's shape is known.

**The review card's own viewer is a stopgap** (user, 2026-11-09). It let the queue be built
without touching a core node, and it is not the destination. The destination is a **`Control`
input on `out.neuroglancer`**, wired from `seam:review`, so the review card drives the full-size
Neuroglancer node instead of carrying a second viewer with a second WebGL context and a second
copy of the scene. It may reasonably work **only with the embedded viewer** (Coda's own,
same-origin): a cross-origin frame has no channel for an in-place camera move, and a port that
silently does nothing on some viewers is worse than one that says which it needs.

Half of what that needs already exists, built for the stopgap: `coda:ng-set-view` is a real
message, `NeuroglancerViewer` takes a `focus` beside the scene, and the segments path was already
in place. What is left is the port, and the decision about what travels along it — a position and
a segment pair, or something more like "here is the item, show it".

**A sparkline of a tip's confidences, in the row** (user, 2026-11-09). The shape of a tip's list
is itself a reason to look or not: a first candidate at 0.9 with a second at 0.05 is a decision
already made, while 0.4 and 0.35 is two pieces nobody has told apart. Both read the same today —
one number and a rank. `conf` is per candidate and already published, so this is a drawing rather
than a measurement: a few dozen pixels of bars in the row, falling left to right, with the
current candidate marked. Worth doing only if it fits without pushing the row to three lines.

**Phase 2 — the three frame messages.** `coda:ng-set-view` and `coda:ng-set-annotations` first;
`coda:ng-edit` with them if the frame's edit hooks allow, else after. They land usable by the
existing Neuroglancer card, reviewable on their own, before anything in this pack depends on
them. Shared code gets its own commit.

**Phase 3 — `seam:review`.** The queue, the card, the verdicts, the viewer jumps. At the end of
this a proofreader can work through rv2 in Coda and the result is comparable, tip for tip, with
the verdicts the user already recorded on their own pages — which is the only honest test of the
UI and the reason the fixture carries them.

**Phase 4 — stages 7–9 in the browser.** `logit_k`, `p_cand`, `segclr`, `p_tip`, `q`, `shown`, `r`
recomputed from the stored assessor scores and `e_tip`, using the fits in the manifest. Cheap, no
model, and SEAM states the bar exactly: it must reproduce the pipeline's numbers and its shown set,
the Python check having matched to 2e-16. This is what makes the cutoff live in the UI instead of
being a column somebody shipped.

**Phase 5 — Model E**, once SEAM exports it. Same `SeamModel` class as Model A, so Phase C's
window code and `src/ml` apply. Checked as `e_tip` against the fixture.

**Phase 6 — the search** (stages 4–5): the 6 µm cube, the roots at T − 1 ms, the eight geometric
features, the logistic ranker, the own-tip rule. Checked against `candidates_all` and
`candidates`. This is where CAVE politeness matters — SEAM keeps to 4 concurrent Aedes streams,
and `get_leaves_many` per box rather than per supervoxel is a 0.6 s against 14 s difference.

**Phase 7 — the assessors**, once exported. 3D ResNet, 129³ at 32 nm, masks only. Two unknowns
SEAM names: 3D convolutions on onnxruntime-web WebGPU are untested, and the cost is far past what
a browser does up front — about 20,000 patches a neuron through three networks, 18 GPU-minutes for
five neurons on the cluster. So this is scored **per tip on demand**, which is a UI shape, not an
optimisation, and it is the reason Phase 3 comes first.

**Phase 8 — skeleton and tips** (stages 1–2). navis `mesh2skeleton` and its compiled core, in
Pyodide or reimplemented. The hardest port and the last one that matters, since every phase above
can take tips from the fixture.

## Phase 6, the search — measured before building (2026-11-10)

Chosen as the next phase (user, 2026-11-10). It is the only large piece not waiting on SEAM, and
it is what makes the node's name true: today `seam:openEnds` ranks a neuron's ends and never says
what any of them should join to.

**The whole search spec already ships in `fixture.json`**, which was not obvious and is worth
saying plainly — nothing here has to be asked for:

```
search:  cutout_half_width_um 3.0, cutout_xy_nm 64, roots_at "snapshot - 1 ms",
         pool_max_dist_um 0.5, top_k 100, geometric_ranker { features[8], mu, sd, w, b }
own_tip: own_um 2.0, "keep a candidate only if its contact is within own_um of the tip and no
         other tip of the neuron is nearer; geo_rank renumbered in the kept list"
```

The ranker is a standardised logistic regression on eight features — a dot product, fitted on
`flywire_v783 oe1 val n=200 … 124 merges`. It is not the work. The work is getting it its inputs.

### What one cutout costs, measured on a real tip

Tip `250173, 313173, 276480` nm (the fixture's first, neuron `648518347622603652`), against the
live Aedes store:

| | |
| --- | --- |
| supervoxel store | `storage.googleapis.com/fanc-fly_segmentation/wclee_aedes_brain` |
| auth | **none — public, `access-control-allow-origin: *`** |
| scale used | `32_32_45` (the coarsest; `TARGET_XY_NM` 64 asks for the nearest) |
| encoding | `compressed_segmentation`, block `8×8×8`, **unsharded**, `uint64` |
| grid | chunk `256×256×64`, `voxel_offset` `[1024, 1536, 0]` |
| the box | `188×188×134` = **4.74 M voxels**, spanning **8 chunks** |
| on the wire | **24.6 MB**, 7.5 s sequential (≈1 s at 8-way) |
| decoded | **14,423 distinct supervoxels**, 97% of voxels non-zero |

**The bucket being CORS-open is the finding that decides the phase.** A browser can read Aedes
supervoxels directly, with no token and no proxy; had it been closed, Phase 6 would have needed a
server and would not be a Coda phase at all. Checked with a preflight, not assumed.

**24.6 MB and ~1 s per tip is why the search is per tip, on demand** — the shape the pipeline was
already heading for because of the assessors, now with a second reason. A 557-end neuron is 13 GB
if the search is run over every end, so it never is: Model E ranks the ends, and the search runs
down that ranking as far as a reader cares to look.

### What Coda has to build, and what it already has

**Already there, and more than expected.** `cavePostBinary` is `roots_binary` — literally what
`caveclient.chunkedgraph.get_roots` calls — so the 14,423 supervoxels go out as a
`BigUint64Array` and come back as one, with no id ever becoming a double (invariant 8). It needs a
`timestamp` parameter added for `roots_at`; that is the whole gap on the CAVE side. The sharded
reader (`locate`, `readShardedObject`) is in place for stores that are sharded, though Aedes' is
not.

**The new capability is a volume cutout reader**, and Coda genuinely has none: `isVolumeInfo`
exists only to route past a volume to the mesh directory inside it. It needs the `scales` parsed,
chunk addressing against `voxel_offset`, and a `compressed_segmentation` decoder. One design note
worth fixing before it is written: the format is **block-wise (8×8×8)**, so a reader decodes only
the blocks the box touches — 4.7 M voxels of the 33.5 M fetched, about an eighth. A decoder that
inflates whole chunks first does eight times the work for the same answer. This belongs in
`src/data/precomputed/`, not in the pack: a segmentation cutout is a Coda capability that happens
to have a SEAM caller first.

**The features are vendored, not reimplemented.** `negatives.summarize_cutout` takes
`(uniq, inv, roots_u, res, lo)` and is numpy + `scipy.ndimage` only — the same seam `canonical.py`
and `scan.py` have, and the reason SEAM invariant 11 exists. Coda fetches the box and the roots,
hands those five arrays to Pyodide, and gets the feature frame back. `candidates.py`'s `FEATURES`,
`NEUTRAL` and `POOL_MAX_DIST_UM` come with it. Nothing about an EDT, a caliber or an elongation
should be written in TypeScript here; a feature computed slightly differently still ranks.

So the order is: the volume reader (with its own tests and a probe, useful on its own), the
timestamp on the root lookup, the vendored summariser, then the ranker and the own-tip rule — the
last two being a dot product and a nearest-tip test, checked against `candidates_all`'s
`geo_score`/`geo_rank` and `candidates`.

### The EDT in Pyodide, measured (2026-11-10)

The one step of the search with no fallback, measured before anything was built around it.
**SEAM uses `scipy.ndimage.distance_transform_edt`** with `sampling=res` and
`return_indices=True` — the indices are what give the contact point, and they allocate three more
full-size arrays.

It works, and the margin is far better than feared. At a real cutout's size (188×188×134):

| | CPython | Pyodide |
| --- | --- | --- |
| EDT with indices | 166 ms | **190 ms** (1.15×) |

And the whole vendored `summarize_cutout`, run unmodified in Pyodide on a box with the real
14,424 supervoxels over 900 roots, returning all 19 columns:

| | |
| --- | --- |
| EDT and the per-root reduction | 314 ms |
| + `point_dist_um` (the slice-by-slice pass) | 445 ms |
| + local moments and centroids, **first call in the process** | 1,207 ms |
| the same call **warm** (`pnpm probe:cutout-summary`) | **~560 ms** |

The warm number is the one to price a search with, and it corrects a first reading of this: the
1.2 s figure was a cold call carrying scipy's and pandas' own warm-up, which a search pays once
and not per end. So the features cost about **half** what the cutout costs to fetch (~1.2 s),
not the same again. The synthetic `inv` is uniformly random, which is the pessimistic case for the
`point_dist` pass (a real query root is one connected neuron, so far fewer voxels are within
`touch_um`); the moments loop is fixed geometry and costs the same either way.

**The real price is the payload, not the time.** `scipy` is a **14 MB** wheel and
`summarize_cutout` returns a DataFrame, so `pandas` (4.2 MB) and its two dependencies come with
it — about **19 MB** on top of the numpy Coda already loads, fetched once and cached. For
comparison, Model E's weights are 71 MB. It is a real cost and it belongs to the node that opts
into it, the way `runtime.ts` already makes every capability declare its own packages.

Not worth reconsidering: the EDT *could* be written in JavaScript (a separable exact transform is
about forty lines), but the rest of `summarize_cutout` cannot, and porting it is exactly the
drift SEAM's invariant 11 and `src/pyodide/seam/VENDORED.md` exist to prevent. Four of the
ranker's eight features come from the moments pass, so the 1.2 s is not optional either.

### What is still unknown

- **The Pyodide heap.** After two cutouts the probe reports **537 MB** of wasm heap, which the
  runtime grows and does not give back — `return_indices=True` alone is 95 MB of arrays per
  call (a float64 distance and three int32 index planes). Whether that is survivable over a
  search of many ends, beside a 71 MB model and the meshes, is not measured against Coda's own
  memory meter. This is now the open risk the EDT's speed was expected to be.
- **Politeness.** SEAM keeps to 4 concurrent Aedes streams and batches the root lookup per box
  (0.6 s against 14 s per supervoxel). The 8-chunk fetch is a different server (GCS) from the root
  lookup (CAVE), so the two budgets are separate; invariant 8 says cache both.
- **Other datastacks.** FlyWire's store is sharded and may need a token. Nothing here assumes
  Aedes, but nothing here has been tried anywhere else either.

## What to ask SEAM for

- **`belongs` / `not_belongs` as delimited strings**, not LIST columns, in a regenerated
  `verdicts.parquet` (and in `tips.parquet`, which carries the same two). Coda's parquet reader
  drops nested columns and says so only in a `skipped` list nobody downstream reads. SEAM owns
  `scripts/pilots/coda_fixture.py`, so this is a one-line change there rather than a bespoke
  reader here.
- **A version on the manifest.** `fixture.json` carries a `commit`; the node needs something it
  can show beside a result and compare after a re-fetch, so a stale suggestion set is a sentence
  rather than a silent mismatch. The footer fingerprint covers the parquet files; the manifest
  itself is the gap, and it is the same hazard the affinity model's unpinned manifest URL has.
- **A fixed `filled` value.** A candidate whose patch failed takes its seed's lowest score *over
  the batch*; a browser scoring one tip at a time has no batch. Needed before Phase 7, not before.
- **Model E and the assessors exported**, with input/output fixtures and a parity rule stated as
  rank and top-1 agreement on real lists — not raw error. SEAM already says this; it is repeated
  here because Model A's parity was checked at 4e-6 and that told us nothing about whether the
  model was right.
- **`summarize_cutout` and `_local_moments` in a module of their own.** They are already
  numpy/scipy/pandas only, but they live in `negatives.py`, which imports `cave`, `paths` and
  `pre_edit` — so Coda cannot take a whole-file copy the way it does `canonical.py` and
  `scan.py`. It takes a **slice** instead, re-cut and byte-compared by
  `pnpm vendor:seam-cutout`, which is a working arrangement and not the right one: the script
  exists only because the module boundary is in the wrong place. Moving the two functions into
  (say) `seam/cutout.py` upstream would let the slice become an ordinary hash-pinned copy and
  the script go.
- **Numpy-only, vendorable code** for the patch masks, as `canonical.py` and `scan.py` were for
  Model A (SEAM invariant 11). Needed before Phase 7, not before.

## What this plan does not do

- **It does not reimplement any model's maths from the handoff.** SEAM's own instruction, and the
  right one: the fits are shipped as numbers and the models as exported graphs.
- **It does not invent a cut.** `shown` is SEAM's absolute cutoff and is read from the data. A
  reader may browse below it by `r`, and `r` is labelled an estimate — it is untested below
  q 0.003, where its steps rest on 11 tips.
- **It does not write to a segmentation**, in any phase.
- **It does not filter.** See the deferred decision above. `shown` and `r` are columns; a cut is
  a `Filter Table`, until the review tap has somewhere better to put one.
- **It does not try to keep suggestions fresh.** They are tied to a snapshot; after a merge the
  neuron's root changes and the rest of that neuron's suggestions are at a stale root. The UI says
  so and offers a rerun. `staleRoots` is how it knows.

## What has already bitten

**A float root id, for the third time — found, reported, fixed (2026-11-09).**
`tips.parquet`'s `top_cand_root`, its copy of the first candidate's root id, had been through a
float64 before being written as text, so it named a different segment on **2,661 of its 2,691
rows**. The 30 that survived were exactly the ids that are multiples of 128.

Three things about it are worth keeping.

It was a *string* column of *rounded* ids. "Every id is a string column" — the rule both sides
already follow, and the thing SEAM changed after losing a day to this twice — does not catch a
value that was a float **before** the cast. The cause was `Series.map` over a nullable `Int64`
column, which pandas hands floats, and the column was nullable because a tip may have no list.

The row it pointed at was right. `p_top` and `top_geo_rank` matched `candidates.parquet` to the
bit, so the pipeline had picked the right candidate and only the printed id was damaged — which
is why nothing downstream could have noticed.

It was found by **cross-checking two tables that hold the same fact**, not by inspection. That is
now the standing defence on both sides: SEAM's exporter refuses float id columns and checks both
properties before writing (`bccb484`, `fixture.json`'s `checks_ids`), and the loader checks them
again on read — the only place a *reader* can see it, and the next set will come from a pipeline
nobody here runs.

So `candidateId` is joined from `candidates.parquet` where it is authoritative, the tips file's
copy is read as a `check` field and never published, and `__fixtures__/damaged/` keeps the
incident as a regression fixture.

**One honest exception the loader allows.** SEAM's check is per tip; the loader's is per neuron,
because two of rv2's 965 judged ids sit on a *sibling* tip's list (tips 12 and 15 of one neuron).
That is a reviewer using their eyes, not a corrupted id — a rounded id names nothing anywhere,
which is what the weaker check still catches. It also says something about the review UI: a
verdict may name a piece outside the tip's own list.

## The EM at speed (2026-11-09, measured)

Reported from the card: clicking through candidates, the EM sometimes does not fill in — all of
it, part of it, or only coarsely — and only reloading the frame fixes it, at the place it was
reloaded. Going quickly makes it likelier.

**Reproduced, with a number.** `pnpm probe:ng-chunks` drives the published Aedes scene through ten
real shown suggestions, sending the two messages the card sends per click, and keeps a screenshot
of each. `scripts/lib/detail.py` measures how much local variation a section panel holds — real
EM at 5 nm a pixel is full of membrane, a coarse mip is flat grey blocks.

| a click every | detail, per step | after 15 s still |
| --- | --- | --- |
| 2,500 ms | 8.3 – 10.6 | 10.4 |
| 300 ms | **0.43 – 0.96** | 10.4 |

At 300 ms the sections never get past the coarsest mip — one flat block per chunk, boundaries
visible, no structure at all — and recover only once the clicking stops. At 2,500 ms every step
is fully loaded. So the speed is the cause, and it is about what the viewer can fetch rather than
about anything being wrong with the camera: the volume is **sharded**, so one tile is a shard
index, then a minishard index, then data, and consecutive suggestions are far enough apart to
share no shards. The download queue holds 100 items and the meshes of two changing segments are
in it too.

**A network log of a real failing case settled the mechanism** (user, 2026-11-09; 1.6 s, 250
entries, filtered to the volume and CAVE). It is not that the fine tiles fail or are slow. They
are **cancelled**, and never asked for again:

| scale | requests | completed | cancelled |
| --- | --- | --- | --- |
| 8×8×45 (finest) | 56 | 22 | **34** |
| 16×16×45 | 21 | 10 | **11** |
| 32×32×45 and coarser | 149 | 146 | 3 |

Every cancellation is `status 0` at `0 ms` — aborted before it started — and **57 distinct URLs
were cancelled, of which 0 were later re-requested**. Coarse levels complete at 98%. So the
camera move aborts the fine-mip reads in flight, the queue drops them, and nothing re-queues
them: the coarse mip is what is left, and only a reload — a fresh chunk manager — asks again.

The bandwidth makes it worse rather than explaining it away: in those 1.6 seconds the coarse
levels pulled **12.8 MB** against the fine levels' **2.1 MB**, so most of a hundred-item download
queue was spent on pyramid levels nobody is looking at.

**The one lever on Coda's side is when the camera moves**, not how. A burst of clicks is a burst
of cancellations; coalescing a burst into one move would leave one load to complete rather than
five to abort. The other lever is `chunkQueueManager.capacities` — the 1 GB GPU and 2 GB system
budgets, and the hundred concurrent downloads — which Coda's frame could raise. Neither is a fix
for a queue that does not re-request what it cancelled.

**Two false measurements worth remembering**, since both read as findings. A scene assembled by
hand from the same source URL fetched its `info` and then requested nothing — a layer is more
than its address. And the page's network domain counted *zero* requests while the EM was visibly
loading: neuroglancer fetches chunks in a **worker**, which that domain cannot see.

## What will bite

- **A float root id is a different neuron**, and SEAM lost a day to it twice. Every id column in
  the fixture is already `str`; the risk is on Coda's side the moment anything reads one through
  a path that does not know (`Number`, a nullable join, an int64 column).
- **`end_uid` is an `int64` and is not an id.** It is a row key. Nothing should "fix" it into text
  under invariant 8, and nothing should read it as a neuron.
- **The frame's single letters are the proofreader's.** `m`, `c` and `f` are live graphene edits.
  A review shortcut that takes one of those is a merge somebody did not mean to make.
- **Everything is at the snapshot** (2026-11-04 16:45 UTC), and its neurons have been edited since,
  so live CAVE data will not match the fixture. A probe that compares the two will disagree
  correctly.
- **Neuron 648518347622603652** holds most of the hard cases — 505 tips, 35% of firsts right
  against 76–78% elsewhere, mitochondria in its lists. It is the stress case for the UI, and a
  review card that only ever saw an easy neuron has not been tested.
- **The cutoff and `r` are refitted whenever a stage changes.** Read them from the shipped fits.
  Hard-coding 0.2084 would be a number that is right today and silently wrong after SEAM's next
  run.
