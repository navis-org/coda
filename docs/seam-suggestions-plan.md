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

`candidates_all.parquet` (270,700 rows, the pre-own-tip-rule search output) is **not** read by
the loader. It exists to check Phase 6, which is what `make_search.py` cuts the search's two
goldens out of.

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

**Phase 6 — the search** (stages 4–5). **Built** — see the dated sections below. The 6 µm cube,
the roots at T − 1 ms, the eight geometric features, the logistic ranker, the own-tip rule.
Checked against `candidates_all` (the ranking) and `candidates` (the own-tip rule). This is
where CAVE politeness matters — SEAM keeps to 4 concurrent Aedes streams,
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
| decoded | **14,424 distinct supervoxels**, 97% of voxels non-zero |

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
ranker's eight features come from the moments pass — and its centroids feed the eighth,
`ahead` — so none of the ~560 ms is optional either.

### What is still unknown

- **How fast the Pyodide heap grows per call.** The probe reports **547 MB** of wasm heap after
  four summaries, and wasm never returns heap to the OS. One call peaks near 180 MB: 95 MB for
  `return_indices=True` (a float64 distance and three int32 index planes) plus another 38 MB for
  the ravel inside the vendored code. *Visibility and remedy are not the open part* — the memory
  dialog already reports this figure and **Stop** terminates the worker, which is the only
  reclaim ([ui-shell.md](ui-shell.md)). What is unmeasured is the growth per call over a search
  of many ends, beside a 71 MB model and the meshes. This is now the open risk the EDT's speed
  was expected to be.
- **Politeness.** SEAM keeps to 4 concurrent Aedes streams and batches the root lookup per box
  (0.6 s against 14 s per supervoxel). The 8-chunk fetch is a different server (GCS) from the root
  lookup (CAVE), so the two budgets are separate; invariant 8 says cache both.
- **Other datastacks.** FlyWire's store is sharded and may need a token. Nothing here assumes
  Aedes, but nothing here has been tried anywhere else either.

### The search ranks, and it ranks SEAM's way (2026-11-10)

Stages 4 and 5 run. `coda_candidate_search` is one crossing over three vendored steps — the
cutout summary, `pool_features`' eight features, and `GeometricRanker`'s logistic score — and it
was checked against SEAM's own answer for a real open end rather than against itself:

| | |
| --- | --- |
| the end | `648518347622603652` at `250173, 313173, 276480` nm (`end_uid` 0) |
| the box | 188×188×134, 8 chunks, **14,424 supervoxels**, roots at `snapshot − 1 ms` |
| the result | **100 candidates, the top 20 in SEAM's exact order**, every `geo_score` to 1e-4 |
| the cost | **~0.6 s warm** in Pyodide, beside ~1.2 s to fetch the box — so **~1.75 s an end** |
| warm-up | ~1.8 s more on the first call in a worker: scipy's and pandas' first imports |

The warm figure is the one to design with, and it corrects a first reading. `started` is taken
before the vendored modules are `exec`'d and before `summarize_cutout`'s own
`from scipy import ndimage`, so the first call carries both inside its clock — ~2.4 s. That is
paid once per worker, not per open end, which also says what a caller should do: **keep the
worker alive across one neuron's ends** and every end after the first is the warm number.

**`geo_score` is a rank key — lower is better**, which `seam/build.py` says in passing and
nothing else does. There are two distinct ways to get it wrong and the probe's negative control
corrected a first account of them:

- **Publishing the raw logit and sorting *that* descending** — the mistake actually made here —
  does **not** reverse anything. The two orderings are identical, so every rank comes out right
  and every published `geo_score` carries the wrong sign. The score comparison catches it; the
  order comparison cannot.
- **Sorting the rank key the wrong way** reverses the list outright, every number still
  plausible. The order comparison catches that one.

The probe makes both comparisons and runs the second as an assertion rather than describing it,
which is how the first bullet came to be stated correctly.

**The ranker's weights ride in the request**, from the suggestion set's own `fixture.json`, never
from this repository. A ranker is fitted against one definition of the eight features; a copy
here would be a second place for them to live, where being wrong still ranks.

`candidates.py` is vendored for the same reason `negatives.py` is, and the slice script now
carries both ([VENDORED.md](../src/pyodide/seam/VENDORED.md)).

**The check for what comes next already exists.** `candidates.parquet` holds the own-tip rule's
answer for this same end — 14 of the 100 kept, `geo_rank` renumbered, diverging from the
pre-rule list at rank 5 — so the remaining work can be checked the same way the search was,
against SEAM's own answer rather than against itself.

## The own-tip rule (2026-11-10)

`ownTip.ts`, which closes Phase 6. A candidate stays on a list only if its **contact** is within
`own_um` (2.0) of the end the list belongs to *and* no other tip of the neuron is nearer that
contact; `geo_rank` is then renumbered `1..n` in the search's own order. Without it a neurite
lying between two ends of the same neuron is on both lists, and would be cut out, patched and
assessed twice, with two scores for one piece and no rule saying which to believe.

**It is a per-neuron pass, which is why it is in the pack and not in the bridge.** Everything
else in stages 4 and 5 happens inside one cutout and is vendored into `src/pyodide/seam/`. This
one reads *every* tip of the neuron — including ends no list was ever searched for. rv2 has one
such end — 1967, on neuron 648518347669157986 — and it takes 42 candidates off three of its
neighbours' lists, so a caller that passed only the searched ends would keep all 42 with nothing
downstream able to tell. `ownTip.test.ts` asserts that difference rather than describing it,
though on a constructed case: the fixture's neuron has no unsearched end of its own, so the test
narrows it to the six tips its lists belong to and shows that more survives.

**TypeScript rather than a third vendored slice**, which [VENDORED.md](../src/pyodide/seam/VENDORED.md)
would otherwise argue for — the rule is fifteen lines of numpy in one contiguous run, so slicing
it is possible. A slice would make the whole per-neuron pass a Pyodide crossing carrying every
tip of the neuron, to run a nearest-neighbour query the editor already has an index for.
`tips.ts` made the same call for the same reason. The cost of both is that a drift here is
invisible to SEAM, which is what the golden below stands in for.

**Checked against SEAM's own kept set**, not against a hand-written expectation, because every
way of getting it slightly wrong leaves a plausible list: dropping the second test keeps a few
extra candidates, measuring to the end's unsnapped position moves a handful across the limit,
renumbering the other way gives the same set with the ranks shuffled. `ownTipNeuron.json` holds
one neuron's 505 ends and six of its lists — the ones that make the rule do something, including
two that keep nothing and one that gives nine tenths of what was near enough to a nearer end.
Both of the first two mistakes were put into the code to confirm the test fails on them.

**The kept set is read from `candidates.parquet`, not recomputed**, and that distinction was the
second review pass's finding. The generator does run the rule in numpy — `tooFar` and
`anothersTip` are counts SEAM publishes neither of — but writing *that* answer into the golden
would have made it a second implementation written from the same reading as `ownTip.ts`, so a
shared misreading would agree with itself. The two are required to agree and the generator
refuses to write a golden if they do not. They did agree, on all six lists, which is why no
golden value moved when this changed.

**Two tips at one place is the one case that needed deciding.** The tip rule snaps every end
onto the nearest mesh vertex, so a short spur's two ends can land on one. The k-d tree keeps the
first strictly-nearer point its traversal meets, while SEAM asks `cKDTree.query`, which answers
the lowest index — so left alone the two disagree, and quietly: one of the pair loses *every*
candidate it shares with the other, which reads as an end with nothing near it. Coda decides it
the same way SEAM does, with a map from each tip to the lowest-numbered tip at its position,
built once per neuron rather than scanned per candidate. rv2 contains no such pair and none of
its 141,980 near-enough contacts is equidistant from two tips, so the golden cannot exercise
this; `ownTip.test.ts` builds the case, and needed seventeen tips to do it — over three the tree
answers the lower index by luck and the first draft of that test passed whether the tie was
handled or not.

**The two reasons a candidate is dropped are counted apart** (`tooFar`, `anothersTip`), because
they are two different sentences about an end: nothing near it at all, or plenty near it that
belongs to a neighbour. A reader asking why a tip has no candidates wants to be told which.

**`searchEnd.json` and `ownTipNeuron.json` are now generated**, by
`src/packs/seam/__fixtures__/make_search.py`, from the **same published directory `make.py`
takes** — `candidates_all.parquet` for the lists and `tips.parquet` for the ends. The two
scripts are apart only in what they read: `make.py` trims the parquet files the loader reads,
this one writes JSON goldens out of the one published file the loader never touches.

That the published set is enough was not the first answer. The goldens were first cut from
SEAM's own `builds/rv2/manifest.parquet` and `replay/rv2/open_ends.parquet` on the belief that
neither was published, and an ask to publish them was written down here. It was wrong on both
counts: `candidates_all.parquet` **is** `manifest.parquet` with `operation_id` renamed and the
ids already cast to text, and `tips.parquet` carries every open end with positions agreeing to
0.0 nm. Reading the published set instead regenerates both goldens to the same numbers, drops a
float-id guard that only existed because the build file's ids are `int64`, lets `own_um` be
read from the manifest rather than copied, and stamps both files with the set's own `version`.
(To the same *numbers*: `searchEnd.json` also lost a six-decimal rounding and gained the contact
point in the same change.)

The stamp is worth a line. `version` is a content hash over the published files, so it carries;
`commit` is `…-dirty` and names no tree. The pack's own `fixture.json` is from an *older* run of
`make.py` and has no `version` at all — survivable only because the test compares `own_um`
across both files rather than trusting either, so a refit upstream is caught wherever it lands
first.

## The fixtures were cut again (2026-11-10)

`make.py` re-run against the current published set, which has SEAM's split stage in it. The
pack's copy had been from before that stage and was quietly behind: the full set counts 120 tips
shown and 298 at `r >= 0.5` where the old one counted 97 and 711.

What moved, and what each cost:

- **The `shown` cutoff, 0.2084 to 0.1532.** `suggestionSet.test.ts` had it as a literal, in a
  test whose own comment warned that "a hard-coded 0.2084 would be right today and quietly wrong
  after the next run". It now pins the **path** — that `cutoff` is `pipeline.show.cutoff` and
  not one of the manifest's other numbers — which is what the test was for; the literal only
  ever tested the fixture.
- **`expectedRight` per neuron**, which three implementations compute (the node, the pandas
  emitter, the R chunk). All three were re-run against the new files before the list was
  changed, rather than the node's new answer being pasted over the old: pandas and R both give
  `1.7464, 1.8409, 1.7464, 1.7464, 1.7464`. Four are identical because `r` is a step function
  and only two of its steps (0.8732, 0.9677) appear among ten shown tips — small-fixture
  coincidence, not a fold that stopped telling neurons apart.
- **1,141 candidates to 1,219**, and `fixture.json` gained `version`, `files` and `made`.

Nothing else in the suite moved, which is the useful part: 11,651 tests pass against a set that
reaches the browser through the same reader.

## Phase 7, measured before building (2026-11-10)

**A handoff for SEAM is split out**: [seam-assessor-speed.md](seam-assessor-speed.md) holds the
same findings written for whoever ports the convolution rewrite into `export_assessor.py`, with
the dead ends and the upstream bug report. What follows is the narrative.

SEAM exported the assessors the same day the own-tip rule landed, so the two unknowns it had
named could be settled before any of Phase 7 was designed. Two probes, and the answers are not
the ones the shape of the question suggested.

**WebGPU runs the graph, all of it.** `pnpm probe:assessor-ops` runs SEAM's `probe.onnx` — the
same network at widths 8-64 with random weights, every op, kernel, stride and 'SAME' pad of the
real one on the same 129³ input, 2.2 MB instead of 133 MB. ORT's own placement log says **all 90
nodes on `WebGpuExecutionProvider`**, and **46 `Conv3D` WGSL programs** are compiled, which is a
3D convolution really becoming a GPU kernel. Both logits match PyTorch to 1.2e-7.

**The trap that probe is built around** is that a node WebGPU cannot run falls back to the CPU,
answers correctly, and says nothing — so a probe checking only the logits would pass on a graph
running entirely on WASM and quote a "WebGPU" timing that is really a CPU one. Hence two
detectors, and a **negative control**: the same two, pointed at the WASM session, must come back
negative. They did not on the first run — a search for `CPUExecutionProvider` matches
`TransposeOptimizer_CPUExecutionProvider`, which is a graph *transformer* that runs on every
session whatever the backend, and `Node placements` is a bare header whose verdict is on the next
line. Both were reporting the opposite of the truth.

**The real model agrees with PyTorch better than onnxruntime's own CPU build does.**
`pnpm probe:assessor-parity` runs `sa2_mask_s0.onnx` itself on real patches from SEAM's parity
fixture: **2.7e-5** on three patches, **1.05e-4** on eighteen, against the 8e-4 onnxruntime CPU
manages on the same lists. Candidates rank in PyTorch's order. Compared with `torch_s<k>`, never
with `candidates.parquet`'s `score_s<k>` — those are the cluster's bf16 numbers and an exact
browser misses them by about a logit while being right.

**The cost is the problem, and it is not the one that was expected.** Per patch, warm, on an
M3 Max:

| | ms a patch | an average tip (114 patches) |
|---|---|---|
| WebGPU | 1,133-1,145 | ~130 s |
| WASM | 1,973 | ~225 s |
| onnxruntime native CPU, 14 threads | 200 | ~23 s |

So WebGPU is only **1.7x** faster than WASM and **5.7x slower than the same machine's CPU
natively** — on a graph where the op probe had WebGPU 10x ahead of WASM. Batch size does not
move it (1,145 ms a patch at batch 18, 1,133 at batch 3), so it is a steady per-patch cost
rather than an overhead. Widening the uint8 labels to float32 costs 1 ms a patch, outside the
graph — which was this probe's own wrong first guess at where the time went, made while the
cast sat inside the timed region.

**fp16 is 1.6x faster and gives the wrong answer — and the fault is WebGPU's, not the
conversion's.** The same converted file, two backends, one list of 18 real patches:

| | ms a patch | error against PyTorch | ranks |
|---|---|---|---|
| fp32 WebGPU | 1,145 | 1.05e-4 | right |
| fp32 WASM | 1,973 | 2.15e-5 | right |
| fp16 WebGPU | **701** | **3.64** | **wrong** |
| fp16 WASM | 2,176 | 1.96e-2 | right |

An error of 3.64 logits is against a rule that cares about 0.05, and bf16's median 0.6-1.8
already breaks it. That the *same file* is sound on WASM and broken on WebGPU places the fault
in onnxruntime-web's **WebGPU fp16 kernels** rather than in the conversion — which is SEAM's own
second fp16 finding, reproduced here on a different model and a different graph. So fp16 buys
nothing today: broken where it is fast, and slower than fp32 where it is right.

Worth recording for whoever tries again: use **`onnxruntime.transformers.float16`**, not
`onnxconverter_common.float16`. The latter converts this graph in seconds without a block list
and produces a model ORT refuses to load (the in-graph label encoding ends up with a `Conv`
bound to two types); adding `op_block_list` to fix that makes it do per-node graph surgery with
repeated shape inference, and it ran **47 minutes on the 133 MB model and over 10 on the 2.2 MB
probe** without finishing — the cost is per node, so model size never was the problem.
onnxruntime's own converter does the same job in **0.4 s**.

**There is no parallelism left to take.** `pnpm probe:assessor-parity -- --shapes` asks the
device whether it has room, two ways:

| | ms a patch |
|---|---|
| one patch a run | 1,147 |
| four a run | 1,149 |
| eighteen a run | 1,143 |
| two sessions at once | **ORT crashes** |

The per-patch cost is **flat from a batch of one to a batch of eighteen** — so there is no
per-submission overhead for a batch to amortise, and the GPU is already full while scoring a
single patch. Batching is not a lever here; a caller is free to use it for convenience, and it
buys nothing. Running two sessions of the same model concurrently does not merely fail to help:
it fails, in ORT's own WebGPU buffer manager (`buffer_manager.cc:669`, "Failed to download data
from buffer" on `map_async`). Worth reporting upstream, and worth knowing before anyone designs
a worker pool around it.

So the only levers on cost are less work — fewer candidates a tip, fewer seeds — or a faster
kernel path. Neither is Coda's to pull.

**It is the browser, not the laptop — by a factor of about 25.** The browser figure alone
cannot tell "this machine is bad at 3D convolutions" from "onnxruntime-web's WebGPU kernels are
slow", so both were measured on the same machine
(`scripts/lib/seam_assessor.py native` and `conv`, run from SEAM's virtualenv):

| | achieved | note |
|---|---|---|
| onnxruntime Python, CPU | 195 ms a patch = **0.45 TFLOP/s** | all 90 nodes on the CPU; error 1.0e-4 |
| onnxruntime Python, CoreML | 331 ms a patch | **25 of 90 nodes** taken — a hybrid, slower than plain CPU |
| PyTorch, CPU, one 3x3x3 conv | **0.93 TFLOP/s** | |
| PyTorch, **Metal**, one 3x3x3 conv | **6.47 TFLOP/s** | a 7x speedup over its own CPU |
| onnxruntime-web, WebGPU, whole graph | 1,145 ms a patch = **0.076 TFLOP/s** | |

The CoreML number is the same fallback trap the browser probe is built around, caught the same
way: it was reported as a GPU result until the placement was read, and ORT writes that log from
C++ to **file descriptor 2**, so a Python-level `redirect_stderr` captures none of it.

**The hardware is fine.** Metal does 6.47 TFLOP/s on the 3x3x3 convolution that is most of the
graph. The stem is a different story — 64x2x7³ has two input channels, so it is memory-bound and
gets *no* GPU speedup even in PyTorch (0.87 against 0.81) — and blending the two at SEAM's
two-thirds split gives roughly 2 TFLOP/s as what a well-implemented backend should reach on this
graph, or about **43 ms a patch, ~5 s a tip**. onnxruntime-web gets 0.076 TFLOP/s. That is ~25x
off what this machine demonstrably does, and the gap is far too large for the stem to explain.

So the ~10 s/tip target is not out of reach of the hardware; it is out of reach of this
backend. Which is worth knowing before cutting corners on the pipeline to buy time the kernels
are wasting — and worth re-measuring on each onnxruntime-web release, since nothing in Coda has
to change for that number to move.

**It is one kernel, and `pnpm probe:ort-kernels` is the proof.** Three one-node graphs, same
GPU, same session, so a timing is a kernel's and nothing else's:

| graph | TFLOP/s |
|---|---|
| `MatMul` 2048³ | **1.3-1.6** |
| `Conv` 3x3x3, 64→64 on 65³ | 0.08 |
| `Conv` 1x1x1, 64→64 on 65³ | 0.06 |

The third row is the load-bearing one. A 1x1x1 convolution **is** a matrix multiply — no sliding
window, no neighbourhood — and it is just as slow as the 3x3x3. So the cost is not the third
dimension and not the kernel size: it is onnxruntime-web's `Conv` path over 5-D tensors,
whatever is in it. The same arithmetic written as a `MatMul` node runs about 21x faster on the
same device in the same session, and one isolated `Conv` reproduces the whole model's 0.076
TFLOP/s exactly.

**What that rules out.** `onnxsim` and `onnx-optimizer` look like the right tool and are not:
ORT's own optimiser already folds this model from **444 nodes to 90** (every `Constant`,
`Reshape`, `Slice` and `ConstantOfShape` gone, 16 convolutions fused), and a one-node graph with
nothing left to remove still shows the whole gap. What survives its optimiser — 22 `Pad` and 16
unfused `BatchNormalization` — is memory traffic worth a few per cent, not 20x. WebNN is closed
too: Chrome exposes it (GPU, NPU and CPU contexts all open), but the spec has `conv2d` and no 3D
convolution, so every `Conv` falls back and all three device types time identically at ~1,920 ms
a patch. And Metal through Pyodide is not a thing — Pyodide is WebAssembly, and WebAssembly's
only routes to a GPU are WebGPU and WebNN.

**So the graph stops using that kernel — and that was built and measured, not estimated.**
`scripts/lib/rewrite_assessor_convs.py` turns each stride-1 3x3x3 convolution into 27 shifted
matrix multiplies: slice the (already padded) input at each of the 27 one-voxel offsets, flatten
to (channels, voxels), multiply by that offset's (out, in) weight matrix, sum. Arithmetically
identical.

| | ms a patch | |
|---|---|---|
| `sa2_mask_s0` as exported | 1,131 | |
| 13 stride-1 3x3x3 convolutions as MatMuls | 251 | 4.5x |
| all 16, strided ones included (`Slice` takes a step) | 181 | 6.2x |
| the 7x7x7 stem too, by grouped im2col | **136** | **8.3x** |

**8.3x on the real model, with the same answer.** Over the whole 18-candidate list, every logit
is within 1.7e-5 of the unmodified graph and the ranking is identical; against PyTorch both are
1.01e-4, i.e. the rewrite is no further from PyTorch than the original is.

**A tip falls from ~130 s to ~15.5 s at three seeds, ~5.2 s at one** — past the 10 s target
from the browser side alone.

**4.5x was the first stop, not the answer** — and 251 ms a patch is now within touching
distance of this machine's native CPU (195). A tip falls from ~130 s to **~29 s**; at one seed
instead of three it is **~9.6 s**, which is the target.

Three things that had to be measured because guessing them would have gone the other way:

- **Grouping the offsets is worse, not better.** The ungrouped 27 run at 6.8x the ORT kernel;
  nine groups of three manage 5.6x and three groups of nine 4.8x. The `Concat` that builds each
  group costs more than the passes it saves. The textbook single im2col is out of reach anyway —
  its intermediate is gigabytes.
- **A 1x1x1 convolution gains almost nothing** (1.3x), because at K=64 it is memory-bound, not
  kernel-bound: ~140 MB of traffic for 2.25 GFLOP puts the floor near the 30 ms both forms hit.
  Only the 3x3x3, with 27x the arithmetic for the same traffic, has room.
- **The model-level gain is 4.5x, not the isolated 6.8x**, and the gap is accounted for: 13 of
  the 16 convolutions qualify, and the 7x7x7 stem — 28% of a patch — keeps ORT's kernel. The
  stem would not gain much anyway; with two input channels it is memory-bound, and PyTorch's
  Metal backend gets only 0.87 TFLOP/s on it against 6.47 on a 3x3x3.

**Three things the sweep settled, each the opposite of a reasonable guess.** Grouping taps for
the 3x3x3 convolutions is *worse* than not grouping (6.8x ungrouped, 5.6x in nines, 4.8x in
threes): the `Concat` that builds a group costs more than the passes it saves. Folding the 26
accumulating `Add`s into the multiplies with `Gemm`'s `C` input is *worse* again (4.1x). And for
the stem, where the 27-term form would be 343 terms at K=2 and slower than the kernel it
replaces, grouped im2col is right — with a flat optimum at 49 taps a group (166 / 142 / **136** /
141 / 165 ms at 7 / 21 / 49 / 98 / 343).

**fp16 is now marginal and unproven.** On the rewritten graph it gives about 1.1x, with the
logit 8.5e-3 from PyTorch — ordinary fp16 error, but against a parity rule that bounds q at 0.01
it is not obviously safe, and it has had no parity check. So fp16 is not taken up, and the
rewrite alone is the answer.

**And the bug it looked like is not one.** On the *unmodified* graph fp16 was 3.64 logits out
with the ranks scrambled, which was read here as a fault in the WebGPU `Conv` kernels
specifically. Writing the minimal repro for the report is what undid it: two isolated fp16
`Conv3D` graphs — a 4-channel 16³ 3x3x3, and the stem's own 2-channel 129³ 7x7x7 stride-2 shape
— are both *correct* on WebGPU to about 1e-3. The whole-model gap has a benign reading that fits
the timings: fp16 on WASM is **slower** than fp32 (2,176 ms against 1,973) while on WebGPU it is
much faster (701 against 1,145), which is what it looks like when the WASM kernels upcast and
WebGPU genuinely computes in fp16 — so the two are not the same arithmetic, and a few units of
drift through 21 convolutions is ordinary. Nothing was filed. A model-level A/B localises
nothing on its own; the claim stood for hours only because it was never reduced to one node.

**Why the micro-benchmarks could not settle any of this.** Two attempts to measure the matmul
shapes in isolation were both I/O-bound rather than compute-bound, in opposite directions: with
the wide operand as a graph *input* it is re-uploaded from JavaScript every run (70-1,898 MB),
and with it as an *initializer* the 70 MB output is downloaded to JavaScript every run, which
pins every K at ~15 ms and looks like throughput rising with K. Only whole-model timings, whose
output is one logit, mean anything here.

**Where the earlier 253 ms sat.** Measured by isolating the piece that rewrite did not touch:

| | ms a patch | GFLOP | TFLOP/s |
|---|---|---|---|
| the 7x7x7 stem, still on ORT's `Conv` | **108** | 24.1 | 0.22 |
| everything else (13 rewritten convolutions, pads, norms) | 145 | 62.7 | 0.43 |
| *for scale:* this backend's isolated `MatMul` | — | — | 1.5 |
| *for scale:* PyTorch Metal on a 3x3x3 | — | — | 6.5 |

So the stem is now the single biggest item — 43% of the time for 28% of the arithmetic — and
the obvious next target. The honest ceiling for this backend is 86.8 GFLOP at its own MatMul
rate, about **58 ms a patch**; the 13 ms Metal implies is not reachable from a browser.

Both of those were then done, which is what took the model to 136 ms. What is left is the
backend's own floor rather than anything in the graph.

**Caveats, since this is a prototype.** It is verified on one seed and one list — 18 real
candidates — against PyTorch and against the unmodified graph; SEAM's parity rule (shown
decisions, ref's first candidate, q within 0.01) has **not** been run on it, and should be
before it ships. It is batch-1 only, which costs nothing since batch size does not change
throughput here, and the rewritten file carries the replaced weights, which is why it is larger
than it needs to be. Both are easy to finish; neither affects the measurement.

**All of that was settled the same day.** SEAM ported the rewrite into `export_assessor.py`
(`export --kernels matmul`, SEAM `c9b9a08`) and published `sa2_mask_mm_s{0,1,2}.onnx` beside the
originals — 17 convolutions rewritten, 4 left as `Conv`, the stem at 49 taps a group, the same
numbers the sweep here landed on. **SEAM's parity rule passes on all three seeds**: 40 lists,
1,387 candidates, the shown set the same on every tip, ref's first the same on every list,
largest q difference 5.4e-6. And the real models in a browser, both run the same hour on the
same machine, give **1,122 → 133 ms a patch, 8.4x** — against the 8.3x the hand rewrite
predicted, so nothing was lost in the port. A tip is **15 s** at three seeds. The thing worth
remembering: **the browser is now faster than this machine's native onnxruntime CPU build**
(200 ms a patch), where as exported it was five and a half times slower.

One shape this imposes on a caller: the matmul graph pins its batch axis to 1, as it must —
flattening `(N,C,X,Y,Z)` to `(C, voxels)` is only the same tensor at N=1 — so scoring a tip is
one `session.run` per patch per seed. `probe-assessor-parity.mjs` now asks
`session.inputMetadata[0].shape[0]` instead of assuming a list goes in whole; a list fed whole
is refused outright, which is at least a loud failure rather than a quiet one.

**It belongs in SEAM's exporter, not here.** `scripts/lib/rewrite_assessor_convs.py` is a
post-hoc pass over a published `.onnx` so that the idea could be measured; emitting the graph in
this form from `export_assessor.py` would let it go through SEAM's own parity check like any
other export, and would drop the traced-shapes step this needs because the pads are computed
in-graph.

The probe **asserts** the gap rather than describing it, so the onnxruntime-web release that
fixes the kernel announces itself by failing this check.

**Where the time goes, as far as this has been taken.** Per-node attribution is not reachable
from here: `timestamp-query` *is* available behind `--enable-dawn-features=allow_unsafe_apis`,
but ORT 1.31 moved WebGPU from JSEP to a native execution provider and the
`ort.env.webgpu.profiling` hook no longer emits anything. What the two probes do say is that the
op probe runs at **4.25 ms/GFLOP** and the real model at **13 ms/GFLOP** — so the wide layers are
three times *less* efficient per unit of arithmetic than the narrow ones, which is backwards
from the usual expectation and points at the kernel path rather than at the FLOP count.

**What that leaves.** Two minutes a tip was on-demand-per-tip territory and nothing else: a
neuron's ~20,000 candidates are ~5 PFLOP, and the rewrite does not change that — a whole neuron
is still out of reach, and this stays a per-tip surface. What it does change is the per-tip cost:
**15 s at three seeds, ~5 s at one**, so SEAM's two ways of cutting it further (fewer candidates
per tip, or one seed instead of three, each needing a refit) are now improvements rather than
requirements. The choice is the user's.

**And 15 s is still only the graph.** Cutting the patches — the volume read, the CAVE leaves,
`label_box`, `pair_sides` — has not been measured at all, so the end-to-end number for a tip is
unknown and is certainly larger. That measurement is the next thing Phase 7 needs, and it is
now the bigger half.

~~**Still open, and SEAM's to decide:** every fit was made on bf16 scores, so an exact fp32
browser will not reproduce rv2's shown set — 4 of 40 first candidates and 1 of 40 shown
decisions differ.~~ **Done, 2026-11-11** (SEAM `84cb4d2`, the `za` refit): the calibration
builds and rv2 were rescored in fp32 and every fit redone, so the cluster's own scores now pass
SEAM's parity rule (`cluster_fp32`, q within 3.5e-4) where they used to miss it by about a
logit. See "The `za` refit lands" below.

## What to ask SEAM for

- **`belongs` / `not_belongs` as delimited strings**, not LIST columns, in a regenerated
  `verdicts.parquet` (and in `tips.parquet`, which carries the same two). Coda's parquet reader
  drops nested columns and says so only in a `skipped` list nobody downstream reads. SEAM owns
  `scripts/pilots/coda_fixture.py`, so this is a one-line change there rather than a bespoke
  reader here.
- ~~**A version on the manifest.**~~ **Delivered** — found while repointing the fixture
  generator. The published manifest carries a `"version"` — `rv2-0d62bc912a89` since the `za`
  refit — a hash over the
  file hashes and the manifest body, and the two goldens are now stamped with it. What is left
  is Coda's half: the node still has to show it beside a result and compare it after a re-fetch,
  so a stale suggestion set is a sentence rather than a silent mismatch. The pack's own
  `fixture.json` predates it and has none.
- **A fixed `filled` value.** A candidate whose patch failed takes its seed's lowest score *over
  the batch*; a browser scoring one tip at a time has no batch. Needed before Phase 7, not before.
- **`ph_a5`, the EM-texture head, exported as a model** — or a decision that it stays data-only.
  It is the single reason `stages.ts` has two shapes rather than one: `head_s<k>` is published as
  a *column*, so a tip read from a set reaches `q` and `shown` while a tip searched live stops at
  `q_ref` with no verdict at all. Everything else in the pipeline is either arithmetic Coda now
  does or a model Coda can fetch. Analysed at length in "What stages 7–9 can reach without an EM
  head" and never actually asked for, which is why it is here.
- **`ref.columns` and `split.columns` as lists**, the way `p_tip.columns` already is. Coda checks
  `p_tip`'s column list and refuses a refit on other features; ref's and split's column *order* is
  read out of a prose `design` string. A refit that **reorders** rather than widens would pass
  every width check, and every logit would still be a logit.
- **Which design `ref.score_clip` applies to.** It is stated under `ref`, and Coda applies it to
  split's third column too, since `split.design` names "assessor score of seed k". That is a
  reading, and no published set can exercise it — `stages.test.ts` pins Coda's reading so the two
  halves cannot drift, but only SEAM can say whether it is right.
- **`show.cutoff_ref` as a number.** `show.q_ref` states `q_ref`'s cutoff in prose ("its cutoff
  was 0.208"), and prose is not something to parse. A tip scored live in the browser cannot reach
  `q` at all — split's head is published as data, not as a model — so `q_ref` is the only quantity
  it has, and without a published cutoff for it Coda gives the number and withholds the verdict
  (`stages.ts`). One field closes it. The isotonic steps for `r` are fitted against `q`, so those
  would be a second ask and a larger one; the verdict matters more.
- **Model E and the assessors exported**, with input/output fixtures and a parity rule stated as
  rank and top-1 agreement on real lists — not raw error. SEAM already says this; it is repeated
  here because Model A's parity was checked at 4e-6 and that told us nothing about whether the
  model was right.
- ~~**`summarize_cutout` and `_local_moments` in a module of their own.**~~ **Delivered**
  (2026-11-10, SEAM `seam/cutout.py`) — and found by the check rather than announced:
  `pnpm vendor:seam` refused by name because the markers bounding the run had gone. It is now
  an ordinary hash-pinned whole-file copy.
  **The same still applies to `candidates.py`**, which `pool_features` and `GeometricRanker`
  are cut out of for the same reason — it imports `paths`. One run left in the slice table, and
  the script retires when it moves.
- **A patch that does not depend on the box it was cut from.** `patches.patch_box` promises one
  — *"any box that holds it gives the same patch"* — and `sample` does not keep it. See the
  section below; this is the one ask that blocks exact parity.
- ~~**Numpy-only, vendorable code** for the patch masks~~ **Delivered** —
  `seam/segclr/patches.py`, numpy alone, and its docstring names Coda's copy from the other
  side. Vendored whole at `c9b9a08`.

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

## Phase 7, the patches — built and measured (2026-11-10)

Stage 6, the half that happens before any model runs: for each candidate on a tip's list, the
129³ window of labels the mask assessor reads — `1` where the query neuron is, `2` where that
candidate is, `0` elsewhere.

**The code is SEAM's, whole.** `seam/segclr/patches.py` is numpy alone and its docstring names
this copy from the other side ("Coda's browser scorer vendors it whole"), so it is a
hash-pinned byte-identical file rather than a slice or a port. `pnpm vendor:seam` — renamed
from `vendor:seam-cutout`, because it now checks every vendored file and not just the two runs
— byte-compares it, and the sha256 table in `VENDORED.md` is checked against the files on disk
instead of by the `shasum` the doc used to prescribe and nobody ran.

That check earned its keep on its first run: it refused `cutout.py` by name, because SEAM had
moved `summarize_cutout` out of `negatives.py` into a module of its own **the same day** — the
ask recorded above, delivered. Only docstrings changed, so the search is unaffected.

### What Coda adds

Marshalling, and the box. `assessorPatches.py` turns Coda's factored cutout into `label_box`'s
leaf lists and hands the patches back; `patchBox.ts` says how big a box to read, before Pyodide
is reached. Three things are worth stating:

- **No leaf lookup is needed.** `label_box` wants each object's supervoxel ids. The caller
  already holds the root of every supervoxel *in the box* at the snapshot, and a supervoxel
  outside the box cannot label a voxel inside it — so the box's own roots **are** the leaves,
  filtered. That is one chunkedgraph request a tip instead of one a candidate (invariant 8).
- **The factorisation is handed over, not recomputed.** `label_box`'s default renumbering is
  `np.unique` over every voxel; SEAM put a `renumber` hook there for exactly this, and Coda's
  `labels`/`index` already satisfy its contract.
- **One box for the list, not one per candidate.** The contacts sit within the own-tip rule's
  2 µm of the tip, so they share a box — `boxAroundAll` in `precomputed/volume.ts`, which
  `boxAround` is now a one-centre call to. Forty overlapping boxes would fetch the same chunks
  forty times.

### What a tip costs — the half that had never been measured

`pnpm probe:assessor-patch --end 1014`, a real 66-candidate list against the live Aedes store:

| | |
| --- | --- |
| the box | 172×214×164 voxels at 32 nm = **6.0 M voxels** |
| reading it | **2.7 s** (20,243 distinct supervoxels) |
| their roots at the snapshot | **2.3 s**, one request |
| labelling the box | **77 ms** |
| cutting 66 patches | **642 ms** — 10 ms each |
| **a tip, patches only** | **~5.7 s** |

So the whole of stage 6 is about **5.7 s a tip**, of which 88% is two network reads and 12% is
arithmetic. With the assessor at 133 ms a patch (the matmul export, one seed), a 66-candidate
tip is **~14.5 s** end to end and the average 38-candidate tip is **~10 s** — which is the
target, reached, at one seed. Three seeds adds 8.8 s a tip and nothing else: the patches are cut
once.

The read and the roots are both per-tip and both cacheable, and the search reads a 6 µm box of
the same volume at the same scale an instant earlier. **One read serving both is the obvious
next economy** and is not done: the search's features are measured inside *its* box, so the
boxes cannot simply be merged — what would work is one read with the search handed a sub-box.

### The one that blocks exact parity: a patch is not independent of its box

`pnpm probe:assessor-patch` compares against SEAM's **own published patches** —
`patches/<end>.npz` beside the parity fixture, the exact arrays its scores were computed from.
Byte for byte, which is the only honest test of a patch: a transposed box, a half-voxel offset
or a swapped pair all produce a perfectly plausible window of somewhere else.

58 of end 1014's 66 patches match exactly. The other 8 differ on **three planes of 129**, and
the three are predictable from arithmetic alone.

`sample` resamples z with `np.round(zf)` where `zf` is measured **from the box's own corner**.
Where a plane lands exactly between two sections — which happens when the contact's z is a whole
number of sections, about an eighth of real contacts — numpy's round-half-to-even resolves it by
the parity of `lo[2]`. Shift the corner one voxel and those three planes come from the
neighbouring section. Proved rather than inferred: re-cutting end 20's patches with `lo_z + 1`
makes all three match SEAM **byte for byte**.

`patch_box`'s docstring promises the opposite — *"A patch is cut from absolute voxels, so any
box that holds it gives the same patch."* For x and y that is true. For z it is not.

**And it is not cosmetic.** The eight patches, scored on `sa2_mask_s0`:

| | |
| --- | --- |
| patches affected | 8 of 66 (12%) |
| voxels differing | 70–153 of 2,146,689 |
| logit shift, median | **0.17** |
| logit shift, worst | **1.46** |

SEAM's own parity rule calls 0.05 enough to decide first place and bounds q at 0.01. A median
of 0.17 is three times the first and a worst case of 1.46 is thirty times the second.

**What Coda does meanwhile.** Each patch is cut from the corner `patch_box` gives for *that
centre alone* — the mode SEAM's docstring names for a browser ("one box per patch"), taken from
the vendored function so there is no Coda-side convention to drift. Without it a candidate's
patch would depend on **which other candidates shared its list**, since they move the shared
corner, and the same candidate would score differently in two lists — with provenance keys
(invariant 4) saying the two were the same work.

That makes Coda deterministic. It does **not** reproduce SEAM's published patches, which came
from shard-sized boxes whose corners are not published, and nothing can: the ambiguity has to
be removed upstream. The fix is one line — round the absolute position and subtract the corner
afterwards — and it makes the docstring's sentence true. It changes which section some tied
planes come from, so it is a re-export and, for anything fitted on the old scores, a refit.

The probe does not paper over this: it checks that every differing voxel lies on a plane the
resample ties on, and fails on any that does not. So the difference is bounded and understood
rather than tolerated, and the day `sample` is fixed the check tightens to byte-for-byte on its
own. **It did, on 2026-11-11**, and the allowance is gone — see below.

## Phase 7, the model — packaged, and what stages 7–9 can actually reach (2026-11-10)

SEAM took the sampling report and fixed it the same day (`dbfef4c`): `sample` now places a label
plane with `label_sections`, a **`floor` of the absolute position** — the section that *holds*
the plane — rather than rounding a position measured from the box's corner. Better than the fix
this repository proposed, because a floor has no tie to break at all.

So the vendored copy moved to `dbfef4c` and **the per-candidate re-cornering came out of
`assessorPatches.py`**: one shared box per tip is now correct by construction. That is recorded
in the module header rather than only here, because going back to an older `patches.py` would
make the shared box wrong again, silently, in three planes of 129.

**SEAM's published fixture predated the fix** (`manifest.json` at `167477c`), so
`pnpm probe:assessor-patch` allowed differences on tied planes for a day — and the set that
differed was the *exact complement* of the set that had differed before, within the 18 tied
candidates of end 1014. That is the two rules differing at ties and nowhere else, which is the
cleanest confirmation available that nothing else moved. The allowance was dated and
self-announcing, and it is now deleted (next section).

### Packaging the checkpoint

`scripts/make-assessor-manifest.py` turns SEAM's exported directory into a directory Coda
uploads whole — the graph, copied byte for byte and hash-verified before it is copied, plus a
manifest in `src/ml`'s schema. It converts nothing; SEAM's own manifest is the source of every
number, and the `config` blob is SEAM's own text, so the patch contract a browser cuts against
and the one the checkpoint was trained on cannot drift apart.

Three choices it makes, each with a reason that is not obvious:

- **One seed per manifest.** `parts` means graphs that must all run, in order; three seeds are
  alternatives. A seed is a row in `models.ts`, as a second affinity checkpoint would be.
- **The matmul form only.** `src/ml` is WebGPU or nothing, and there that form is 8.4x the
  convolution one. On a CPU the ranking reverses — which is why SEAM exports both and why Coda
  hosts one.
- **No dynamic axes**, because the matmul graph pins its batch to 1 and that is the truth.

`__fixtures__/assessorManifest.json` is the converter's **real output** with the 133 MB graph
left behind, and `assessorModel.test.ts` runs `src/ml`'s own `checkManifest` over it. A
converter and a parser on two sides of an upload are exactly the pair that drift, and neither
side's other tests can see it.

`openWindowModel` became `openSeamModel`, with the config parser as an argument — the file's own
header already argued that a fourth copy of those forty lines is what drifts. The three window
cards call an unchanged wrapper.

### What stages 7–9 can reach without an EM head

The decision was "all the way to q and shown, marked provisional". Checking what that needs:

| stage | needs | reachable live |
| --- | --- | --- |
| `ref` logit | geo_rank, log vol, the assessor's score | **yes** (per-seed fits are published) |
| `p_cand` | a softmax within the list | **yes** |
| `segclr`, `p_tip` | the list's best logit, and `e_tip` | **yes** — Model E is hosted |
| `q_ref` | `p_tip` × ref's share | **yes**, cutoff 0.208 |
| `p_split`, `q`, `shown`, `r` | `head_s<k>` | **no** |

`split` is the trained EM-texture head (`ph_a5`, on frozen a5-ft1 embeddings of each
candidate's EM views), adopted 2026-11-09. Its scores reach the pipeline as
`candidates.parquet`'s `head_s0..2` — **published as data, not as a model.** `data/onnx/` holds
`A_d256_e80` and `sa2_mask` and nothing else, so a browser cannot compute a head score for a tip
it just searched.

So for a **live** tip the pipeline stops at `q_ref`, which is SEAM's own pre-split quantity with
its own fitted cutoff — published "for the record" precisely because it is the pipeline without
the confidence model. For a tip read out of a **published set**, the head scores are in the file
and the full `q` and `shown` are computable from them.

That is one shape, not two: the stages compute as far as their inputs allow, and say which
cutoff the answer is against. It is also a third thing the refit should decide — a single-seed
`q_ref` against a three-seed cutoff is provisional twice over.

### Follow-ups the review pipeline recorded rather than did (2026-11-10)

Four findings whose fix is right but reaches well outside the change under review. Written down
so they are decisions rather than oversights.

- **One `configFields.ts` for the pack.** `windowConfig.ts`, `affinityConfig.ts`,
  `suggestionSet.ts` and `assessorModel.ts` each carry their own `block`/`number`/`text`, and
  they have **already diverged**: only the assessor's refuses an *array*, which `typeof` calls
  an object. Unifying them changes the sentences three working features refuse with, and those
  sentences are pinned by their own tests. Whoever does it should keep the array check.
- **`runtime.ts` should install vendored modules, and a Coda-owned `labelBox.py` should hold the
  box.** `_install`/`_seam` is copied verbatim into `seamWindows.py`, `cutoutSummary.py` and
  `assessorPatches.py`, and the three have drifted in ways nothing tests (one sets `__package__`,
  the others `__name__`). `runtime.ts` already owns `spec.vendored` and seeds `__vendored__`;
  generalising it to a `modules` record it installs itself — with `vendored` as the hash-pinned
  subset `scripts/vendor-seam.mjs` checks — would delete the pair from all three and let each
  bridge open with a plain import. `assessorPatches.py`'s `_labelled` likewise repeats
  `cutoutSummary.py`'s `_box`, and **2026-11-11 added a third shared block to that pair**: the
  dtype-width refusal, which is now written out twice. The right home is one `labelBox.py`
  holding the `[::-1]` reshape, the width refusal, the transpose and the `req["index"] = None`
  drop. Two notes for whoever does it: `installBridge` in `scripts/lib/pyodideProbe.mjs` mirrors
  the `__vendored__` convention and has to move in the same change, and the refusal stays in
  Python — `readLabelBox` makes it true by construction, but the probes hand-build the pair and
  are exactly who it is for.
- ~~**Narrow the voxel index on the JavaScript side.**~~ **Done, 2026-11-11.** `readLabelBox`
  now allocates a `Uint16Array` and widens only if the table passes `NARROW_INDEX_LABELS`
  (65,536), carrying across what is already pasted — so the saving is the whole read's, not just
  the hand-off's, and the common box never allocates the wide form at all. `LabelBoxRequest.index`
  is `VoxelIndex`, `PyArg` gained `Uint16Array`, and both Python entry points read the width that
  arrives rather than asking for one. Measured on end 1014 (6.0 M voxels, 20,243 supervoxels):
  the worker's peak fell from **220 MB to 201 MB**, and the patches are still byte for byte
  SEAM's. One correction to what was written here: the transpose copies either way, so the
  Python side is not "a pure view" — what is saved is the arriving copy, which is the half that
  is permanent.
- **`rewrite_assessor_convs.py`'s 27-term path is `im2col_conv` at one tap per group**, and
  `make_kernel_graphs.py` repeats the same model tail four times. Both are finished measurement
  tooling whose output SEAM has already ported, so the duplication has no future reader to
  mislead; recorded only so a third copy is not written.

## The `za` refit lands, and the probe tightens (2026-11-11)

SEAM rebuilt its patch sets under `label_sections`, rescored them in fp32 and redid every fit
(`84cb4d2`; the reply is §11 of [seam-patch-sampling.md](seam-patch-sampling.md)). Two numbers
moved that this pack holds: the shown cutoff went from **0.153 to 0.146**, and rv2 now shows
**127 tips rather than 120** — 116 of them the same ones. Precision where it is judged did not
move (80/89 on the calibration neurons, the rv3 gate still 20/21), which is the point: the fix
was to the input, not to the model, and the models saw both versions of every tied plane during
training because the training boxes' corners fell either way at random.

**`patches.py` did not change.** The vendored copy is byte-identical at `dbfef4c`, `84cb4d2` and
`ef7f030`; the refit moved the data, not the sampler. So re-vendoring was a check that passed,
not a copy.

**What was regenerated here**, all of it from SEAM's own files rather than edited:

- `__fixtures__/tips.parquet`, `candidates.parquet`, `fixture.json` and `damaged/`
  (`make.py`), now set `rv2-0d62bc912a89`;
- `__fixtures__/searchEnd.json` and `ownTipNeuron.json` (`make_search.py`);
- `__fixtures__/assessorManifest.json` (`make-assessor-manifest.py` over SEAM's new export).
  Two fields moved: the upstream commit, and `missingPatchScore` from **−62.336 to −58.722**,
  which is the fp32 rescoring of seed 0's floor and nothing else — the ONNX graphs are
  unchanged, sha256 for sha256.

**The tied-plane allowance is deleted.** `pnpm probe:assessor-patch` now demands a patch be
SEAM's byte for byte, and it is: end 20 (3 candidates) and end 1014 (66) both pass with nothing
tolerated. End 1014 is the one that carried 456 differing voxels on exactly 3 of 129 planes, so
the check that found the defect is the check that now finds nothing.

**`index.json` and `mismatched.json` are generated too, as of this round.** They were
hand-kept, and the recut caught them stale — the index still said 1,141 candidates where the
trimmed set has 1,178. `make.py` now derives both from the real manifest, with the mismatched
one's single deliberate disagreement (`tips: 9999`) spelled out in the script. A fixture whose
whole job is to disagree in one stated way cannot be a hand-written copy of a file that moves.

**The three implementations of the per-neuron fold were re-run, not re-pinned.** The expected
`r` sum moved to 1.8199, 1.8199, 1.7648, 1.8199, 1.7648; the pandas cell and the R chunk were
both executed against the new fixtures over a local server and agree with the node to four
decimals, with the same joined `candidateId`. The R emitter's header had been left behind by
the 2026-11-10 recut and was still quoting the numbers before that — which is what a header
stating numbers nobody re-ran looks like after one cycle, and why this is written down.

**Still open upstream** (SEAM's §11.7): `pool_features` and `GeometricRanker` remain inside
`candidates.py`, so `scripts/vendor-seam.mjs` still keeps one slice. And the exported manifest's
`config.input.patch.z` still reads "labels by nearest section", which is the old rule's sentence
— worth fixing at the next export, since the `config` blob is deliberately SEAM's own text and
this pack copies it unread.

## Phase 4, stages 7–9 — built and checked (2026-11-11)

`stages.ts` and `parsePipelineFits`. A tip's candidates in, a ranked list and a decision out:
`logit` per seed and their mean, `p_cand`, `rank`, `segclr`, `p_tip`, `p_top`, `p_split`,
`conf`, `q_ref`, `q`, `shown` and `r`. No model, no fetch, no worker — a few multiplications a
row on the path a card redraws from.

**TypeScript, not vendored Python, and the reason is particular to this stage.** Everything else
Coda borrows from SEAM is copied byte for byte because the drift is invisible: a window built
slightly differently still scores. Here SEAM publishes the answers — `tips.parquet` and
`candidates.parquet` carry every one of those quantities for every row — so the drift is visible,
and `stages.test.ts` recomputes all of them from the stored inputs and compares. That is a
stronger check than a byte comparison of source: it checks the numbers, on real data, at every
stage. **Worst difference over 25 tips and 1,178 candidates: 3.6e-15**, on `conf_logit`, which
sums fifteen fits; every other stage is at or below 9e-16, and `segclr` and `r` are exact. SEAM's
own replay records 2.2e-16 (`checks_largest_difference`), so this is summation order and nothing
else.

### Every number is read, and one of them did not exist yet

The fits, the floors, the cutoff and the isotonic steps all come from the set's own manifest.
That is not fastidiousness: the cutoff moved 0.208 → 0.153 → 0.146 inside a week, and each time a
constant in this file would have been right on the day it was written.

Two the manifest states in ways a reader has to notice:

- **`ref.score_clip` is optional, and this set has none.** SEAM added the clip (±20) after a raw
  logit of 22,652 flattened a seed's weight, and the current `coda_fixture.py` writes the field —
  but `rv2-0d62bc912a89` predates it and **its published logits are unclipped**, which was checked
  rather than assumed: with the clip applied the recomputation misses `logit_s0` by 16.2. So the
  clip is applied only where the set declares one.
- **`q_ref` has no published cutoff.** `show.q_ref` says "its cutoff was 0.208" in prose, and prose
  is not something to parse. So a tip that can only reach `q_ref` gets the number and **no
  verdict** — `TipDecision.against` is `undefined`, drawn as "no decision", never as a rejection.
  `r` is withheld with it, because the steps were fitted against `q`. One field (`show.cutoff_ref`)
  would close this; it is in "What to ask SEAM for".

### The two shapes, which are one shape

`q` is `p_tip × p_split` and `p_split` comes from the EM-texture head, which SEAM publishes as
data and not as a model. So:

| | a tip from a published set | a tip searched live |
| --- | --- | --- |
| ref's half (`logit`, `p_cand`, `rank`, `p_top`, `segclr`, `p_tip`, `q_ref`) | yes | yes |
| split's half (`conf_logit`, `p_conf`, `p_split`, `q`, `shown`, `r`) | yes | **no** |

`scoreList` computes split's half when the head scores are there and leaves it `undefined` when
they are not; `decideTip` names the quantity it decided on. A reader is never shown a number that
looks like `q` and is not. The live arm is tested by handing the same list with `head: undefined`
and requiring ref's half to come out **identical** — the head must not reach back into it.

### What it refuses, and why each is silent otherwise

- **A fold listed out of order.** A seed is addressed by position, so a manifest numbering them
  `[1, 0, 2]` would score each seed against another seed's weights. Every logit stays a logit.
- **A fit of the wrong width.** `((x − mu) / sd) · w` walks the row, so a short `w` drops the last
  feature — ref without the assessor's own score, ranking on geometry and size alone.
- **`p_tip` refitted on other columns.** The fit names its columns; applying three weights to two
  features gives a probability for every tip and the right one for none.
- **A list whose seeds do not match the set's fit**, which would be a mean over the wrong number
  of scores.

A set that fails any of these is still **readable**: the fits are parsed by `parsePipelineFits`
when something recomputes, not by `parseSuggestionSet` when the set loads, because Phase 1 reads
`q`, `shown` and `r` as columns and needs no fit at all.

### What the review round changed (same day)

Four cleanup agents over the new code. Beyond the ordinary tidying, five that were worth the
pass:

- **The design row was rebuilt per fit.** Ref asks three fits a candidate and split fifteen, and
  each allocated a fresh array and took `Math.log(vol)` again — eighteen logarithms of every
  volume, 1.8 M short-lived arrays for a published set. One reused row, same loop order:
  **54.6 ms → 20.7 ms on the logits, worst difference between old and new exactly 0** (2,700
  tips × 37 candidates, median of nine passes). The whole of `scoreList` over that set is
  52.2 ms, which is 19 µs for the one list a live tip actually scores — so the remaining cost,
  nearly all of it the comparator sort, was measured and left alone.
- **A head column shorter than its list** read `undefined` into the fit, so every confidence came
  back `NaN` rather than refusing. **A split fold with no seeds** divided by zero fits for the
  same result; that check now lives inside `seedFits`, which both `ref` and every fold go
  through.
- **`r` was a number where `0` meant three things** — an empty list, a quantity the steps were
  never fitted for, and a genuine measured zero. It moved onto `DecisionBasis`'s `q` arm, where
  it cannot be read off a tip nothing decided.
- **`shown` was a boolean under an optional**, so `against?.shown` was falsy for a withheld tip
  *and* for an undecided one — the two states the shape exists to keep apart. It is now
  `verdict: 'shown' | 'withheld'`.
- **`e_tip_floor` was parsed, carried, documented and never applied.** `decideTip` now takes
  `number | undefined` and substitutes it, the way `scoreList` already did for `segclrFloor`.

And two gaps in the check itself: `shown` was compared as a **total** rather than per tip (two
tips swapping sides leaves the count right), and the `score_clip` branch was exercised by
nothing, since this set declares none. Both are closed — the clip by two arithmetic identities
over the set that does exist, since no fixture can carry a field SEAM has not published yet.

### A second review round, and what it declined

Four more agents over the same files. Besides the ordinary tidying it found three things in the
first round's own work: a **false sentence** in `stages.ts`' header (it claimed to meet SEAM's
`checks_largest_difference` bar of 2e-16, but that record holds nine quantities and `conf_logit`
— the one at 3.6e-15 — is not among them, so there is no published bar for it); a **half-measure**
in the empty-seed fix (moving it into `seedFits` shares it with every fold, but a fold's seed
*roster* is a property of the set and was still checked nowhere — a short fold reads another
seed's column and weighs less than its neighbours in a flat average); and `REF_WIDTH`/`SPLIT_WIDTH`
**stated twice**, as literals in the parser and constants in the stages, so widening one and not
the other would drop a feature from every logit through the very check meant to prevent it.

Also: `orderByScores` (`nodes/lib/matrixShape.ts`) replaced a hand-written comparator — it is the
repo's one statement of "descending, stable, non-finite last", and the hand-written form put a
`NaN` logit at rank 1, since `logit[b] − logit[a]` is `NaN` and `NaN || a − b` falls through to
the index. `parsePipelineFits` now takes the `SuggestionSet` rather than a block and a URL, so a
block cannot be paired with another set's file in a refusal. And the clip's own parse path got
cases, since the derived ones in `stages.test.ts` patch a `PipelineFits` and never read
`score_clip` out of a manifest at all.

**Declined, with the measurement:** a gated insertion sort for small lists (a few ms over a whole
set, at the price of two statements of the tie rule); narrowing `cutoutSummary.py`'s box to
`uint16` rather than casting to `int32` (9.5 MB of a ~180 MB EDT peak, and it changes the dtype
handed to vendored code on the strength of one box shape); and a row-wise `into.set(...)` in
`pasteBox` (7.7 → 4.8 ms per box read, and immune to a megamorphic cliff this change's second
element kind brings nearer — but a box read is three seconds of network, so it is 0.1%). The
last two are worth revisiting if either file is opened again for its own reasons.

### Two code-review rounds, and the three that were real

The reviews after the cleanup found five findings each. Three were defects rather than tidying,
and two of those were introduced by the cleanup itself:

- **The held patch box had no identity.** `assessorPatches.py` holds one labelled box, and
  nothing in a cut or a close said which — so two overlapping tips (a cancelled one whose close
  has not landed, a caller that forgot to await) would have the second `open` replace the first's
  labels, and the first's next cut would answer from it: patches of the right shape, for the
  wrong neuron. `AssessorBox.id` is now carried on every later call and a stale one is refused by
  name, which `probe:assessor-patch` drives, since the refusal is Python's. The same check
  covers `close`, where a late one would otherwise drop the *live* tip's labels — and `box` is
  required rather than checked-when-present, because an absent one would be served whatever is
  open, which is the failure arriving through the check.
- **`probe-seam-merge.mjs` called `windowRun.probability`,** which the cleanup had moved to
  `core/stats.ts` as `logistic`. The probe loads modules by path from inside a template literal,
  so neither typecheck nor lint sees the call — only a run, after the download and the GPU work.
  (Writing the fix's comment then hit this repo's recorded backtick trap: a backtick inside that
  literal ends it. Twice now, so the comment says so in place.)
- **The widening was not priced where it allocates.** `readLabelBox` checks four bytes a voxel up
  front, but during the 16→32-bit swap both arrays are live — six. A box just under the floor
  would have failed inside the chunk loop with nothing naming it. It is now asked again at the
  swap, at six, rather than pricing six at the top: that would refuse boxes that never widen,
  which is nearly all of them.

Two more were prose that had gone wrong: `canonicalLabels` claimed that "sorting can only lower
an index", which is false (`[0, 10, 5]` raises slot 1 to index 2 — what actually holds is the
`labels.length` bound), and the unbounded default group size, where "no `count` means the rest"
contradicted the three-call design that exists because a whole list is 215 MB in one message.
`count` is now required.

### Not done here

- **Nothing is wired to a node.** `stages.ts` is headless and driven only by its test, the way
  `cutoutSummary.ts` was before the search.
- **The node does not publish `head_s<k>`**, so recomputing split's half from the node's own
  tables is not currently possible — only from the parquet. That is a column decision for whoever
  builds the card, not a gap in the stages.
