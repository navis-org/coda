# Limits

Every guard rail in Coda, what tier it is on, and why it is where it is. Read this before
adding a number that stops somebody doing something.

The short version: **a limit warns; it does not refuse.** The exception is an allocation the
tab cannot survive, and there are seven of those.

## Why this changed

Coda's guard rails were written early, when the worst thing that could happen was a locked tab
and the datasets on hand were the mock connectomes. They were all refusals, and the numbers
were what a prototype could demonstrate rather than what the science needs: 100 neurons for
NBLAST, 25 for meshes, 20 for a CAVE mesh batch, 500 for skeletons, 2,000 observations for a
clustering, 10,000 for a "select all".

What that adds up to is a build that decides which questions are askable, and decides it in a
voice that sounds like the answer does not exist. "600 x 600 is 360,000 pairs, over this node's
ceiling of 250,000" is a sentence about a seventeen-second measurement taken on one laptop,
delivered as if a cell type against its own hemisphere were a category error.

So the verdicts changed and most of the numbers stayed. A threshold that was worth naming is
still worth naming — it is just that naming it is now the whole of what happens.

## The three tiers

Which tier a limit is on is a question about **consequences**, never about size.

| Tier       | What it is                                                                                                  | How it speaks                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Silent** | The work is bounded, the result is not affected — a batch size, a concurrency cap, a page size.             | Nothing.                                                                                              |
| **Warn**   | The work goes ahead and costs something: minutes, hundreds of megabytes, a picture with no readable labels. | `ctx.warn` on a node, `onWarn` on a data source, the status bar for a click, a caption for a drawing. |
| **Refuse** | Proceeding allocates more than a tab survives, so there is no result on the other side to warn about.       | `refuseIfOverCrashFloor`, which makes the comparison itself and never suggests raising anything.      |

`src/core/limits.ts` holds the tier definitions, the house phrasing (`warnOverThreshold`), the
duration estimator, `SILENT` for a caller with nobody to tell, and `CRASH_FLOOR_BYTES`.

**The floor has one name.** `refuseIfOverCrashFloor` makes the comparison itself rather than
taking a caller that has already made it, because while it only threw, three call sites each
minted a local alias — `NBLAST_PAIRS_FLOOR`, `MAX_PIVOT_CELLS`, `MAX_HEATMAP_CELLS` — to restate
the same constant in their own units. A second spelling is how a symbol drifts from itself
(invariant 8), and one of those three had already drifted: the linkage floor was rounded to
11,000 while the thing that actually refused did not fire until 11,586.

**Time is never a refusal.** A wait is the user's to spend, and Cancel is an inch from the
warning. Only bytes refuse.

## The warning channel

`EvalContext.warn(message)` — added for this, because `evaluate` could previously only return or
throw, and `validate`'s warnings are edit-time and cannot see a row count.

Three properties, each pinned in `core/scheduler.test.ts`:

- **Raised at the top of `evaluate`,** before the expensive part. A warning that arrives after
  the wait is a description of something that already happened; one that arrives before it sits
  next to a live Cancel button. The scheduler keeps it in `liveWarnings` so the card can paint
  it while the node is still running.
- **Kept in the scheduler's cache entry,** exactly as `reportFetched`'s age is. A result
  restored from cache never runs `evaluate` again, and a caveat that expired on the next
  unrelated run would leave the caveated result on screen with nothing beside it.
- **Deduped,** so a warning raised inside a per-item loop says its piece once.

It surfaces on the card as one line and in the inspector as a list, both ranked by
`ui/nodes/nodeIssues.ts`: run error, then type error, then run warning, then type warning. That
ranking is one function because it was briefly two — the card put a run warning below a type
error and the inspector put it above one, so the same node's first line said different things
depending on where you read it. `ui/nodes/runWarning.test.tsx` pins the ranking and both
surfaces.

Across the `DataSource` seam the same thing is `GeometryRequest.onWarn`, wired to `ctx.warn` by
the morphology nodes. It exists because the cost is a fact about the _backend_: a hundred
neurons is one query against neuPrint's ready-made skeletons and about fifty thousand requests
against graphene meshes, and the node cannot know that.

## Every limit

### Neuron counts

`MAX_NEURONS` (`nodes/query/morphology.ts`) is **10,000**, and it is the default _and_ the
maximum of every neuron-count control: Skeletons, Meshes, Synapses, NBLAST, NBLAST kNN. The
control is called **Warn above** — it was called "Max neurons" while it refused, and kept the
name for a while afterwards, which is the one way a control can lie about what it does.

Ten thousand is where every backend in the tree is into tens of minutes, which is worth a
sentence whatever anybody set.

### Per-node thresholds

| Where                          | Threshold                       | What it says                                                                                                                                                                      |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nblastOps.checkNblastSize`    | 250,000 pairs                   | The pair total and what it comes to in minutes, at a measured 15,000 pairs/second. Was a refusal.                                                                                 |
| `synblastOps.checkSynblastSize` | 500,000 synapses (both sides)   | syNBLAST's cost is not NBLAST's: there is no tangent-vector fit, so the work scales with the *connector* count rather than the neuron count, and a hundred neurons is anywhere between two thousand and two hundred thousand synapses. Kept **beside** `checkNblastSize` rather than replacing it, because a user who wired in a whole dataset and one who wired in twelve enormous neurons need different sentences. |
| `cleanOps.checkResampleSize`    | 5,000,000 nodes                 | Total cable over the spacing — the shape [gotchas.md](gotchas.md) records for an output sized by two independently-resolved things, since the spacing is on the card and the cable arrived from a fetch several nodes up. Names both node counts. Set inside the crash floor (25.6 M nodes) rather than at it, or the warning would only ever fire in the last fifth before a refusal. |
| `cleanOps.checkDropInternalsSize` | 2e8 ray casts                 | Triangles × rays × passes. Stripping internal membrane fires a ray off every face and asks whether it escapes, so a set of forty full-resolution neurons is tens of millions of casts, single-threaded. Names Rays, Passes, *and* the Detail param upstream that moves it most. |
| `matchOps.checkMatchSize`       | (no threshold — a clamp)        | Not a size warning at all: `n` above what the matrix can offer is cut down and said so, because fastcore raises there and the user set "top 20" on a card that cannot see how wide the matrix is until it runs. |
| `linkageOps.checkLinkageInput` | 2,000 observations              | Linkage is single-threaded and quadratic, and a dendrogram of that many leaves has no labels. Points at Cut Tree, which hands the same clustering back as a table. Was a refusal. |
| `tableOps.pivotTable`          | 2,000 columns / 2,000,000 cells | Which axis is the small one, and what the matrix weighs. Was two refusals.                                                                                                        |
| `describeOps.DESCRIBE_CELLS_WARN` | 2,000,000 cells               | That every cell is read once and every numeric column sorted for its quartiles. Pivot's number, deliberately: the same shape of cost — one pass over every cell — and a second threshold half an order of magnitude away would be a claim about a difference that does not exist. Never a refusal; the output is one row per *column*, so nothing here allocates with the input's row count. |
| `similarityOps.similarityMatrix` | 500,000,000 pair contributions | The wait, at a measured **300 million contributions per second** — the slow end of sixteen timings (four shapes × four metrics) rather than the middle, so the estimate is never shorter than the wait. The number warned on is `Σ_f \|column f\|(\|column f\|−1)/2`, computed exactly before the matrix is allocated, because what drives the cost is how many observations share their *busiest feature* and not how many observations there are. The `−1` is the diagonal, which the pass skips: a feature only one observation carries produces no pair, and on connectivity keyed by partner id that is most of the columns. The message names the driver, since filtering hub partners upstream cuts it faster than dropping neurons does. |
| `similarityOps.similarityMatrix` | (no threshold — an admission) | How many rows repeated an observation/feature pair and were summed, and how many observations turned out to have no features at all. Neither is a size: they are things the input turned out to be, said after the fact, because an ungrouped table and a table of zeroes both produce a perfectly ordinary matrix that means something else. |
| `partnerVectors.partnerVectorTable` | (no threshold — attributions) | Four admissions, alongside the one ceiling listed under The refusals below: edges past the first hop that the `direction` column cannot attribute, untyped partners standing in for themselves, untyped partners dropped, and rows with no usable weight. Each changes what the vectors *mean* rather than what they cost — the second one especially, since a shared "untyped" bucket is the one grouping that makes strangers look alike. |
| `typeMapping.COMPONENT_NODE_CAP` | 5,000 nodes in one component  | Not a wait and not an allocation — a **coarser answer**. Trimming a component to its cross-dataset paths is all-pairs shortest paths inside it and splitting it is an agglomeration over it, so both are quadratic; cocoa parallelises with `joblib` and a browser cannot. Past the cap the component is matched *whole*, which is a real result with less granular shared labels rather than a stalled tab. The message names the likely cause instead of the wait, because a type component of thousands is never a size problem: it means one generic label (`unknown`, an empty string that survived a trim) is joining everything, and the fix is the ignored-labels param rather than fewer neurons. |
| `transformOps.checkWarpSize`   | 1e10 point-landmark products    | The wait, at a measured 8.9e8/second. Was a refusal.                                                                                                                              |
| `roiMeshes`                    | 60 regions                      | That an empty picker asks the source for its primary set — which the old refusal at 60 forbade naming by hand while allowing by omission. Now an edit-time `validate` warning.    |
| `neuroglancer`                 | 10,000 segments                 | The link length and neuroglancer's own drawing. Was a refusal, on a number nobody had measured against every deployment in use.                                                   |
| `paths`                        | `MAX_PATH_STEPS`, 5,000,000     | That the ranking is "the strongest found" rather than "the strongest". Always degraded rather than refused; the warning is new, and the budget is 10× what it was.                |
| `explore` select-all           | 25,000 neurons                  | That every id lands in every downstream cache key. Was a disabled button at 10,000.                                                                                               |
| `uploads`                      | 50 MB                           | That the parse will take a moment. Was the refusal; the refusal moved to 200 MB.                                                                                                  |
| `caveTables` view sample       | (no threshold — a kind)         | Not a size at all: a *view* is being sampled, and CAVE does not push a row limit into an aggregating one. Measured against v783, `proofread_neurons_view` answered a one-row query in 0.77 s while `valid_connection_v2` and `nt_summary_view` had not after 45. The rail cannot be a number because nothing on the card can see which kind of view it is, so it names the wait and says Cancel is there. Time is never a refusal. |
| `caveTables` empty sample      | 0 rows                          | That CAVE publishes a column set only inside a result, so a table with no rows describes itself as having no columns. Fires after the fact rather than before, because it is an admission about the answer rather than a warning about the wait. |

### Per-source thresholds

Enforced by the backend because the cost is the backend's, and reported through `onWarn`.

| Where                                | Threshold | Why that number                                                                                                                          |
| ------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cave/meshes.ts` `MESH_WARN_NEURONS` | 20        | A graphene mesh has no level of detail. The estimate is FlyWire's — 492 fragments, ~1.2 MB, ~4 s a neuron — and is deliberately the slow end rather than a mean: how far off it is elsewhere depends on how the datastack's meshing agglomerates, and BANC answers one neuron in 61 fragments because it serves chunkedgraph layers 2–6 rather than leaves. An estimate that is never shorter than the wait is the right kind of wrong here. Only reached where the materialization has no flat segmentation. Was a refusal — and twenty was never a scientific quantity of neurons. |
| `cave/l2.ts` `L2_SKELETON_WARN`      | 100       | Two chunkedgraph reads apiece. Every FlyWire question of any size arrives here, so refusing this was refusing the dataset.               |
| `cave/flat.ts` `FLAT_SKELETON_WARN`  | 100       | The same number as the row above and a different sentence, which is why it is its own constant. A published mip-1 skeleton is ~70× an L2 one — measured over ten FlyWire v783 neurons: 14,559 to 338,087 nodes, mean 1.8 MB, all ten in 2.0 s at concurrency 8. So a hundred is ~180 MB and ~20 s and what the message has to carry is the **memory**, not the wait. Not a `refuseIfOverCrashFloor`: the per-neuron size varies twentyfold, and a refusal computed from a mean is a guess wearing a floor's authority. |
| `catmaid` `CATMAID_SKELETON_WARN`    | 200       | ~1 MB each, uncompressed, on somebody's community server. Moves the day the deployment turns on gzip.                                    |

### Drawings

A viewer's job when the data is too big for a picture is a _worse picture plus a caption_, not
an empty card. The caption is the viewer's version of `ctx.warn`.

| Viewer     | Caption above                     | No drawing above                                                                                                                        |
| ---------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Heatmap    | 4,000,000 cells — `large matrix`  | `CRASH_FLOOR_CELLS`. Paint tracks the **grid**, not the matrix, so the fold is the only thing that scales.                              |
| Network    | 20,000 nodes — `layout unsettled` | 100,000 nodes. `settleDuration` is a wall-clock budget on a worker, so a big graph gets a _less settled_ arrangement, not a frozen tab. |
| Dendrogram | 3,000 leaves — `structure only`   | 20,000 leaves, which is 40,000 SVG paths.                                                                                               |

### The refusals

Everything below is an allocation, sized against `CRASH_FLOOR_BYTES` (512 MB — roughly where a
desktop tab starts failing allocations rather than swapping, with the inputs, the GPU upload and
the undo stack alongside it).

- The pivot's cell floor — `CRASH_FLOOR_CELLS`, read straight — and `MAX_PIVOT_COLUMNS`, which
  is separate because a wide pivot costs one JS array _per column_ in `matrixToTable`
  whatever the cell count says. The accumulators are single allocations sized by
  the product of two independently-resolved column pickers. This is the shape of the 9 GB
  incident in [gotchas.md](gotchas.md), and note that the _fix_ for that was `resolveColumn`
  keeping a chosen column, not this check.
- `NBLAST_PAIRS_FLOOR` — the score matrix is one flat `Float64Array` of `rows * cols`.
- `MAX_LINKAGE_OBSERVATIONS` (~11,585) — the condensed distance vector is `n(n-1)/2` float64s,
  so this is `sqrt(2 · CRASH_FLOOR_CELLS)` rather than a number anybody chose.
- The heatmap's grid (`CRASH_FLOOR_CELLS` again), `MAX_NODES` and `MAX_LEAVES_DRAWN` — a grid, a
  graph and an SVG that cannot be built.
- `MAX_UPLOAD_BYTES` (200 MB) — checked against `file.size` before a byte is read, because by
  the time a table exists the tab has already stalled.
- `checkResampleSize`'s node budget — a resampled skeleton is 20 bytes a node (three float32
  coordinates, a float32 radius, an int32 parent), so a metre of cable at a spacing somebody
  typed in nanometres by mistake is gigabytes. The estimate is exact rather than a heuristic:
  `resample_skeleton` divides each segment into `round(length / spacing)` parts.
- `matchOps.MAX_MATCHES` — `matches_above` is the one mode whose output size nothing on the card
  bounds; a threshold of zero on a similarity matrix returns every cell. fastcore takes
  `max_matches` and raises rather than allocating, which is the right half of the answer; this is
  the other half, `CRASH_FLOOR_CELLS / 4` because a match is four cells.
- `similarityOps.similarityMatrix`'s `n²` — the per-pair accumulator is one flat `Float64Array`
  over the observations, so this is `CRASH_FLOOR_CELLS` read straight, at about 8,100
  observations. It is raised **after** the sparse side is built, which is the honest place: that
  side is `nnz` rather than `n²` and does not itself approach the floor.
- `partnerVectors.partnerVectorTable`'s edge ceiling — the one bound in this file that is a
  ceiling on the **input shape** rather than on the output, and it says so. An edge produces at
  most one row per side, and the aggregation only ever brings that down — usually by orders of
  magnitude, since the point of grouping partners by type is that many partners share one. So it
  refuses an input that could not fit rather than an output that will not, which is the only
  claim available before the pass runs. `SIDES × OUTPUT_COLUMNS` cells per edge, against
  `CRASH_FLOOR_CELLS`; it also understates, since a `ColumnData` slot is a tagged `CellValue`
  and not a float64.

## Numbers that are not guard rails

Left alone deliberately, so a sweep like this one does not come back for them:

- **Presentational knobs** — `Rows per list`, `Top cell types`, `Explode`, layout `Iterations`,
  point size, line width. These bound a _drawing choice_, not the work.
- **Algorithmic conventions** — NBLAST's `Tangent neighbours` (5 is the convention), Paths'
  `Max hops` (8 is already past what a connectome question means).
- **Concurrency and batch sizes** — `MESH_CONCURRENCY`, `L2_CONCURRENCY`, `CHUNK`,
  `SKELETON_CONCURRENCY`. Silent tier: they change how the work is spread, not what comes back.
- **Palette and layout caps** — `MAX_SERIES` and friends. See the chart-colour note in
  [CLAUDE.md](../CLAUDE.md); these are a _validated_ limit, not a performance one.
- **`MAX_MORPHOLOGY_FILES` (50)** — kept, and worth stating why, since it looks exactly like the
  ones that moved. The constraint is the _browser's_: a page that starts six hundred downloads
  has them silently dropped somewhere in the middle, which reads as the export half-working.
  Raising it would not deliver more files. The export already reports what it truncated. The
  real fix is an archive, and that is a feature rather than a number.
- **`MAX_ROOTS_CHECKED` (250,000)** — a backstop on somebody else's service that already reports
  `checked` against `total`, so it is on the warn tier by construction.
- **Correctness refusals.** Not limits at all, and they must never become warnings: mismatched
  NBLAST units (`checkNblastUnits`), a distance control applied to voxel coordinates
  (`cleanOps.checkCleanUnits` — and note it refuses *only* where a distance is actually in play,
  since keeping every Nth node counts hops and means the same thing in either unit), a self-skip
  asked of a rectangular matrix (`matchOps.checkSkipSelf` — fastcore's `skip_self` is the
  diagonal, which a rectangle has none of), a non-square or cross-population matrix into clustering,
  wrong coordinate spaces, an id that would lose precision (invariant 8), and CAVE's reads
  refusing when a query comes back **short of the count the server gives for the same query** —
  the server says it truncated in a `warning` header its CORS policy does not expose, so counting
  is the only tell a browser has, and a short index is not a visible failure but a dataset that
  quietly lacks neurons. Note what that used to be and why it was wrong: `rows >= CAVE_MAX_ROWS`,
  a constant that is really one deployment's `QUERY_LIMIT_SIZE`. It refused BANC's *complete*
  1,994,371-row `codex_annotations` for exceeding a cap that server does not apply — a refusal
  claiming truncation of a whole answer, which is the worst shape a correctness check can take.
  A guard rail derived from a constant somebody else configures is not a correctness check;
  `countTable` asks. Each of
  these produces a _confident wrong answer_ rather than a slow one, which is the whole
  distinction this file is built on.

## The shape of a check

Three conventions, each of which existed in two or three spellings before this file did:

- **The threshold takes a `Warner`, never an optional one.** `ctx?: Warner` reads as "the check
  is optional" when what is meant is "there is no card to put this on", and it forces the
  audience and the threshold into one condition — `if (ctx && count > threshold)` — where a
  missing warner silently disables the check. Pass `SILENT` instead.
- **The control gets a `Warn above` param through `nodes/lib/limitParams.ts`.** Six nodes carry
  one. They converged on a single default when the guard rails became warnings, which left six
  copies of a block whose only real variation is a floor and a cost sentence.
- **The floor is derived, not written down.** `refuseIfOverCrashFloor` does the comparison; a
  constant that needs to name the boundary computes it (`MAX_LINKAGE_OBSERVATIONS` is
  `sqrt(2 · CRASH_FLOOR_CELLS)`), because a rounded copy is a copy that can be wrong.

## Adding one

1. Work out which tier it is on: does proceeding produce a bad result (correctness → refuse), a
   slow one (warn), or the same one (silent)?
2. If it warns, say the cost in the units the reader is spending — minutes, megabytes,
   requests — and say that the work is going ahead. `warnOverThreshold` is the house phrasing.
3. If it refuses, derive it from `CRASH_FLOOR_BYTES` rather than picking a round number, and
   say what would have been allocated.
4. Measure. Every number above came from a measurement recorded next to it; the ones that had
   to move were the ones where the measurement was real and the _verdict_ was invented.
