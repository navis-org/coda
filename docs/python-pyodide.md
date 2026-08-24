# Python in the tab: NBLAST and clustering

The Pyodide bridge and the two capabilities built on it.

Moved verbatim out of `CLAUDE.md`.


## NBLAST, and Python in the tab

`neuron.nblast`, `Add ▸ Analysis ▸ NBLAST`. Skeletons in, a score matrix out — which is a
`MatrixValue`, so the Heatmap draws it, Normalize rescales it and Download writes the CSV,
none of which had to learn anything. The comparison is **navis-fastcore**, the Rust
implementation navis itself uses, running in the page as a Pyodide worker (`src/pyodide/`).

**This is a spike, and what it is spiking is the hosting cost rather than the algorithm.**
Every number below was measured rather than estimated — in Node against the wheel, and in
headless Chrome against `pnpm dev`.

### What it costs

| first use | raw | over the wire |
| --- | --- | --- |
| `pyodide.asm.wasm` | 9.6 MB | 3.44 MB |
| `python_stdlib.zip` | 2.5 MB | 2.5 MB |
| numpy | 2.92 MB | 2.92 MB |
| **navis-fastcore** | **1.10 MB** | **1.10 MB** |

About ten megabytes, **of which the algorithm is one** — nine tenths of that download is
CPython and numpy. That is the number to have in mind before adding a *second* Python-backed
node, and equally the reason the second one is nearly free. Measured in a browser: 2.3 s from
cold to a scored matrix, 536 ms for a 100 x 100 all-by-all once booted, 8 ms for eight neurons.

**Nothing enters the bundle.** Pyodide is not an npm dependency; the worker imports it from a
CDN at run time. `main` grew 6.3 kB — the node, its ops and the engine — and the worker is its
own 5.9 kB chunk carrying `nblast.py` inlined. Verify with `pnpm build`: `worker-*.js` should
contain `coda_dotprops`, and `main-*.js` should not match `jsdelivr` at all.

### The trap, which produces no error

**Coda's skeletons are nanometres; NBLAST's scoring matrix is micrometres.** The FCWB matrix
fastcore embeds runs out at a 40 um distance bin and past it every cell is about -10 — so a set
handed over in nm scores every pair as if no two neurons had ever been near each other,
uniformly, with nothing anywhere to say why. `NM_PER_UM` in `nodes/lib/nblastOps.ts` is the
whole of the fix and `nblast.test.ts` pins it. The related limit is that NBLAST **across**
datasets means nothing without a template-space registration, which Coda has no route to yet;
within one dataset it is exactly the usual analysis.

**So geometry now carries its units, and the conversion is checked rather than assumed.**
`GeometryUnits` (`core/values.ts`) rides on `SkeletonsValue`, `MeshesValue` and `PointsValue`,
`describeValue` prints it in the node footer — `12 skeletons · 43,210 pts · nm` — and
`checkNblastUnits` refuses anything that is not `nm` before a byte is marshalled.

Three things about it are load-bearing:

- **`voxelScale` answers `undefined` where it used to answer the identity**, and that is the
  change that made the rest possible. neuPrint returns voxels; the conversion needs
  `Meta.voxelSize` *and* a unit string the table recognises, and where either is missing the old
  code fell back to a 1:1 scale — which is indistinguishable from a dataset that genuinely
  publishes 1 nm voxels. So the failure was silent and, worse, unrecoverable downstream. Now the
  absence is the information: `geometryUnitsFor` sits beside `voxelScale` and turns it into
  `nm` or `voxels`, the two kept together on invariant 3's reasoning.
- **`voxels` is a real answer, not a failure**, and absent is a third thing again. The
  coordinates in that state genuinely are voxels — nobody here knows how big one is. Absent
  means unknown, which no source produces today, so NBLAST lets it through rather than refusing
  on a fact nobody stated. Same distinction as `columnSchemaFor`'s missing-versus-empty.
- **The units print even when they are the expected ones.** A line that shows up only when
  something is wrong is a line nobody learns to look at — the same reasoning that keeps the
  matched half of `unmatchedLabels` on screen.

Note what this does *not* catch, because it is a units check rather than a scale one: the mock
connectome is honestly `nm` and merely small, an 18 um brain against a real hemibrain's 250. The
bounds sanity check that would catch that is still unwritten.

### The k-NN sibling

`neuron.nblastKnn`, `Add ▸ Analysis ▸ NBLAST k-NN`. A different *question* rather than a faster
answer to the same one: a matrix asks how alike every pair is, this asks what one neuron is most
like — which is what a similarity search, a k-NN graph and an embedding all actually want.
fastcore shortlists candidates from a coarse voxel signature and scores only those, so the cost
is `n × nCandidates` rather than `n²`. **Every score returned is an exact NBLAST value**; only
which pairs were considered is approximate. fastcore's measurement, on 163,976 neurons: recall
of the true top 20 is 0.911 at 50 candidates, 0.969 at 100, 0.990 at the default 200, 0.996 at
400, having scored 0.16% of the pairs.

**It emits a long table** — `queryId`, `targetId`, `rank`, `score`, plus a label per side when
the picker is set — because that is the shape Filter, Sort, Download and `net.build` already
take. Building the graph here would be this node deciding merge rules `net.build` owns.

- **`queryId`/`targetId`, not navis's `query`/`target`.** `isIdentifierColumn` reads a name's
  last word to decide whether a number is an identifier or a quantity, so a column called
  `query` prints body 527536 as "527,536". The Python emitter renames navis's frame to match,
  or every downstream cell would address columns that are not there.
- **`idx` is cast to int32 in Python.** fastcore returns int64, and an int64 numpy array crosses
  to JavaScript as a `BigInt64Array` — which converts without complaint and then compares equal
  to nothing. `int32From` names that case in its error.
- **Padding is dropped and counted.** A row with fewer than `k` candidates comes back filled
  with `-1` / `-inf` to keep the arrays rectangular. Carried through, that is a neighbour called
  -1 with a score of negative infinity in somebody's chart.
- **A neuron present in both sets matches itself at 1.0**, which is fastcore's behaviour with an
  explicit target and is kept rather than corrected — so "top 5" is four others for such a
  neuron. Without a target, every neuron is excluded from its own row. The guide says so.
- **`symmetry` is applied before the top-k cut**, which is why it matters more here than on a
  matrix: once only k neighbours per row survive there is no transpose left to symmetrise
  against.
- **Two different things are called `k`.** fastcore's k-NN `k` is how many matches come back;
  its dotprops `k` fits the tangent vectors. On the card they are `Matches per neuron` and
  `Tangent neighbours`, in both nodes, because two controls called k is a card nobody can use.
- **`nat.nblast` has no equivalent**, so the R emitter is a TODO that says why: the honest
  translation is `nblast_allbyall()` plus a per-row top-k, which is the n² this node exists to
  avoid.

**What it does not yet buy is scale.** The Skeletons node refuses above 500 neurons and at 500
the full matrix is about seventeen seconds, so today this earns its place on the neighbour table
and the graph rather than on speed. It is the node that is ready when the fetch ceiling moves —
which is a decision about 5,000 HTTP requests against a shared production Neo4j, not about this.

### The bridge is about calling a function, not about NBLAST

`src/pyodide/` hosts **one** Pyodide instance — a module-level singleton in `engine.ts` — and the
protocol is `callPython({ module, fn, args })`. A capability is three things and no more: a
`.py` registered in `runtime.ts`'s `MODULES`, its request and result types, and a wrapper that
calls the bridge and reads the answer by name. `nblast.ts` is the first and the one to copy;
nothing in `engine.ts`, `worker.ts` or `types.ts` changes when a second arrives.

That shape was chosen over a message type per operation because the second capability is likely
(`linkage` for a Dendrogram is the named candidate) and the alternative grows a union without
bound. **The cost it avoids is not a protocol tidy-up but a second 10 MB runtime**, which is
what a separate engine would mean.

**A capability declares its own packages**, in `MODULES`, and they are installed the first time
something calls into it. Loading numpy and the 1.1 MB fastcore wheel from `boot()` instead
would be right only for as long as every capability wanted exactly those — the next one needing
scipy would edit the boot, and one needing neither would pay for the wheel. They go in as one
`loadPackage` call rather than two awaits: numpy comes from jsDelivr and the wheel from PyPI,
so serialised the second request's DNS, TLS and slow-start all wait on the first transfer. Worth
about 285 ms of a 2.1 s cold start, measured in a browser.

Four conventions carry it, each established against the runtime rather than assumed —
`scripts/probe-nblast.mjs` exercises all of them:

- **Arguments go over as they are.** A JS object arrives in Python as a dict through `.to_py()`,
  and a typed array nested inside one arrives as a buffer `np.frombuffer` reads directly. So a
  call passes one request object, the buffers are still transferred rather than cloned, and
  there is no marshalling layer to keep in step.
- **Results are a flat dict**: scalars and **one-dimensional** arrays, with any shape carried as
  its own entry. This is the one that bites. A 2-D numpy array does not fail to convert on the
  way out — it converts to a nested plain `Array`, which for a 400 x 400 matrix is 160,000 boxed
  numbers and nothing to say it went wrong. Hence `.ravel()` and explicit `rows`/`cols`, and
  `float64From` naming that case in its error.
- **`report` is the last positional argument** of every callable, `report=None` where there is
  nothing to say. A keyword would read better and would rest on `callKwargs`, which is more of
  Pyodide's surface to depend on for no gain.
- **A type crossing the bridge is a `type`, not an `interface`.** TypeScript gives a type alias
  an implicit index signature and an interface none, so an interface is not assignable to
  `PyArg` and the call fails to compile with a message about `undefined`. Not obvious from the
  error; worth knowing before writing the second wrapper.

`toJs` **copies** out of the wasm heap, checked rather than assumed — so a result outlives the
proxy it came from, while every proxy taken is still destroyed where it was taken.

### Decisions worth keeping

- **`nblast.py` is a real `.py` file**, loaded with `?raw`, not a template literal. It is
  readable and diffable, and `scripts/probe-nblast.mjs` (`pnpm probe:nblast`) runs *that file*
  against *that wheel* through *the same entry point the worker calls*. vitest has no Pyodide
  and jsdom has no `Worker`, so nothing in `pnpm test` executes a line of it — which is why
  `.github/workflows/pyodide.yml` does, path-filtered to `src/pyodide/**` and pinned to the
  Pyodide version `sources.json` names. Pinned rather than `latest` so a bump is a deliberate
  change with its own diff instead of an unrelated PR going red. The probe asserts the
  *contract* and not the scores — square result, flat float64, one finite score per pair, a
  self-match of exactly 1, progress actually reported. fastcore owns the numbers; this owns
  the marshalling.
- **The square case is one `nblast_allbyall` call, so no progress is reported from inside the
  blast.** Chunking the rows to drive a bar was measured at 1.8x (50-row chunks) to 5.1x
  (10-row) the run it would be reporting on, for byte-identical scores.
- **Cancel terminates the worker rather than interrupting Python.** Interrupting needs
  `setInterruptBuffer`, which needs a `SharedArrayBuffer`, which needs COOP/COEP headers, which
  GitHub Pages cannot set and which this app has no service worker to fake. Measured: abort
  lands in 153 ms, and the next run re-boots in 1.4 s because the ten megabytes are cached by
  then. The same missing headers are why it is **single-threaded** — `get_num_threads()` is 1 —
  so fastcore's headline multi-core speed is not available here whatever the backend.
- **Nothing is guarded that fastcore already handles.** Checked against the wheel rather than
  assumed: it clamps `k` to the point count, resamples a multi-rooted fragment with both roots
  surviving, and accepts a one-point neuron. So `dotpropSetFrom` drops nothing — a filtered set
  would put every label after the dropped neuron on the wrong row.
- **The score matrix says it is a similarity.** `MatrixValue.measure` (`'similarity' |
  'distance' | 'count'`) is the machine-readable half of `valueLabel`, and it exists because
  clustering needs *distances*: somebody has to know to invert, and in the consumer that is a
  special case per producer. Optional, and absent means unknown — Pivot genuinely cannot say,
  since its cells are whatever aggregation was picked — so a consumer asks and carries on when
  nobody answered. Only NBLAST sets it today.
- **No param is presentational**, which is unusual enough here to be worth saying. Every one
  changes the scores, `Label by` included: the labels are part of the matrix that leaves the
  port, not a way of drawing it.
- **The wheel tag is not Pyodide-specific.** `pyemscripten_2026_0_wasm32` is the emscripten ABI
  tag and Pyodide 314.x's lock declares `abi_version: 2026_0`. `sources.json` pins both, because
  a Pyodide bump that moves the ABI needs a wheel built against it.
- **CORS was checked with an `Origin` header, and that mattered.** `files.pythonhosted.org`
  sends no CORS headers at all to a bare `curl -I` and `access-control-allow-origin: *` to a
  request carrying `Origin` — so the wheel loads in a browser, which the obvious check says it
  does not. Same shape as the `/api/roimeshes` HEAD-vs-GET finding. jsdelivr is open either way.

### What is not settled

The CDN is a third-party runtime dependency this app otherwise does not have; the wheel is
1.1 MB and could sit in `public/` while the runtime is still borrowed. And the honest way to
price the whole thing is not "ten megabytes for NBLAST" but "ten megabytes for a numerical
backend" — `linkage` (the Dendrogram TODO), the CMTK/Elastix/TPS transforms (the template-space
TODO), geodesic distances and Strahler for morphometrics, and "custom nodes using Python" all
come out of the same download. Judged as one node it is disproportionate; judged as a backend it
is cheap. That is the decision the spike exists to inform.

**The second capability has now landed and the prediction held.** Clustering (below) is
`linkage.py` plus a wrapper plus a line in `MODULES`, and it costs **2 ms** on a runtime that
has already run NBLAST — measured, against 366 ms for the first module, which is almost
entirely its `import numpy` / `import navis_fastcore`. Its packages cost **0 ms**, being the
same two. So the honest price of the *third* Python-backed node is a few kilobytes of source,
and the ten megabytes stays a one-off for the backend rather than a tax per capability.

## Clustering: Linkage, Cut Tree, Dendrogram

`cluster.linkage`, `cluster.cut` (both `Add ▸ Analysis`) and `out.dendrogram`
(`Add ▸ Visualisation`). NBLAST answers how alike every pair is; these answer what the
*groups* are. `NBLAST → Linkage → Cut Tree → Dendrogram` is the chain, and each arrow is a
separate act rather than a step of one: the tree is computed once and expensively, the cut is
somebody trying a number and looking at the picture, and the picture is free.

The comparison is **navis-fastcore** again — `fc.linkage`, `fc.leaf_order` — through the same
Pyodide bridge, as the second capability on it.

### The value kind, and why not a table

`LinkageValue` (`core/values.ts`) carries SciPy's `Z` ravelled, the labels, the leaf order and
optionally a cut. It is its own `CodaType`, on **`LayoutValue`'s exact argument**: a linkage is
not data about neurons, it is a tree computed *for* one particular set of them. As a table of
`[a, b, height, size]` it would accept any four numeric columns, need four pickers to
configure, and be silently destroyed by a Sort upstream of whatever drew it — none of which a
reader would connect to the wrong picture they got.

The socket takes the matrix hue and the one shape that family had left (`ring`). A sixth
chromatic family would fail the all-pairs colourblind gate; see `colors.ts`.

**`clusters` is optional on the value, and absent means _not cut_ rather than _one cluster_** —
the distinction `MatrixValue.measure` draws. `cluster.cut` sets it, which is what lets a
Dendrogram wired *after* a Cut colour its branches by group with no second input and no column
picker.

### Verified against the reference rather than assumed

Four findings, each of which was a wrong answer before it was checked. All were established
against scipy 1.15.3, R 4.4.1 and the real fastcore wheel, not recalled.

- **fastcore's linkage _is_ SciPy's.** Merge order identical on every one of 60 trials across
  the five methods, heights agreeing to 1.3e-15, and `fc.leaf_order` identical to
  `scipy.cluster.hierarchy.leaves_list` on 20/20 random matrices. That is what makes the
  notebook export a translation rather than a second implementation to keep in step, and it is
  worth knowing before anyone reaches for a hand-rolled clustering here.
- **`centroid` and `median` produce non-monotonic trees, and are not offered.** Measured on
  random NBLAST-shaped matrices, 25 observations, 40 trials: `centroid` inverted in **39 of
  40** and `median` in **40 of 40**, where `ward`, `average`, `complete`, `single` and
  `weighted` inverted in none. A merge below its own child cannot be drawn honestly — and both
  are defined on *squared Euclidean* distances, which `1 - NBLAST score` is not, so they were
  offering a wrong answer as well as an undrawable one. Their absence is also what makes the
  cut below sound: on a monotonic tree, row order *is* ascending height order.
- **`fcluster(..., 'maxclust')` is the wrong function for "give me k groups".** It finds the
  lowest height leaving *at most* k clusters, so on six observations in three tied pairs it
  answers three clusters for k = 2, 4 and 5 alike. `cut_tree(Z, n_clusters=k)` undoes the last
  k − 1 merges and returns exactly k, which is what `cutByCount` does — and the two agreed on
  every one of 300 comparisons across the five methods offered, against 45 disagreements in 120
  across the two that are not. A spinner marked "Clusters: 4" that yields 3 with nothing saying
  why is the silent surprise this codebase exists to avoid.
- **R's `hclust` mapping, all five, through both implementations on one matrix**:
  `ward`→`ward.D2`, `average`, `complete`, `single`, `weighted`→`mcquitty`, reproducing the
  merge heights and the leaf order exactly. `ward.D` is the older variant of Ward's criterion,
  disagrees on the same data, and errors nowhere.

### Cluster numbers are ours; the partition is SciPy's

**Clusters are numbered left to right as the dendrogram draws them**, so cluster 1 is the
leftmost group and the column reads against the picture. That is a deliberate divergence, and
it costs nothing: SciPy's own two cut functions do not agree with *each other* on numbering, so
there was never a convention to match — only a partition, which does match exactly. Both
exporters renumber (three lines of pandas, one of R) so the notebook and the canvas agree.

### Two bugs a browser found, and jsdom could not

Both were invisible to a green suite of 2,498 tests, and both are the class this codebase keeps
being caught by. They are recorded at length because the *symptom* points nowhere near the
cause in either case.

- **A matrix of counts becomes negative distances, and the tree draws off the card.** `auto`
  reads a matrix that says nothing as similarities, so an Adjacency of raw synapse counts gives
  `1 - 77 = -76`. fastcore clusters negative distances without complaint; the viewer then
  normalises against a maximum it is nowhere near, and the brackets project to **x = 42,423 on
  a 550-pixel card**. Nothing throws, nothing logs, the node goes green, and the caption's
  counts are all correct — the drawing is simply not there. The comment that used to sit on
  `transformFor` predicted the opposite symptom ("it comes out inverted rather than subtly
  off"), which is exactly why the guess is now *checked*: `checkLinkageDistances` scans the
  cells before anything is marshalled and names the two fixes, which are opposite — counts want
  a Normalize upstream, un-normalised NBLAST scores want the switch back on at the NBLAST node.
- **A selection held as labels lit two thirds of the tree.** Leaf labels are whatever named the
  matrix, and `NBLAST → Label by: type` makes them repeat — fourteen neurons, five distinct
  names. A branch was drawn as selected when *every leaf under it* was in the selected set, so
  picking one three-leaf clade lit every branch that happened to share a name with it. The
  caption said "3 selected" throughout, which is why no assertion on it would have caught this.
  The selection now holds **observation indices**, which are unique by construction; the cost
  is `core.selectOne`'s trade, that a position is not an identity — and it is forced rather
  than chosen, since a tree offers no stabler handle for a leaf, only a less honest one.

### The traps

- **The matrix is copied before it crosses the bridge**, and this is the one that would have
  been a live bug. `callPython` *transfers* every typed array in a call's arguments — right for
  the point buffers NBLAST builds and drops — and this one is the upstream node's own cached
  result. Transferred, it is detached: the Heatmap an inch away redraws empty, the scheduler's
  cache holds a zero-length array, and nothing connects either to the node that ran. 500 × 500
  is 2 MB, which is what the copy costs.
- **A square matrix is not necessarily over one population.** NBLAST with a Target set of equal
  size is perfectly square, and clustering it would treat row 3 and column 3 as one observation
  because they share an index. `checkLinkageInput` compares the row and column labels and
  refuses, naming that case — the only check in the module that is about meaning rather than
  arithmetic.
- **`as.dist` reads the _lower_ triangle where `squareform` reads the upper.** Identical on a
  symmetric matrix and the transpose of each other on one that is not, which is exactly the
  `Symmetry: none` case. The R emitter says so rather than quietly disagreeing with the
  notebook.
- **SciPy's `dendrogram(orientation=)` is named for where the _root_ goes, not the leaves**, so
  Coda's "leaves on the right" is `'left'`. R's `horiz` was measured rather than read: reading
  `par("usr")` back, `horiz = TRUE` runs the height axis from 0.568 down to −0.022, i.e. root at
  the left and leaves on the right, so both map with no flip. Getting either backwards produces
  a mirrored picture that looks perfectly reasonable.

### The second output is most of a clustermap

`Linkage` emits `Ordered` as well as `Tree`: the input matrix with rows and columns permuted
into leaf order. Wired to the **existing** Heatmap that is the block-diagonal picture, with no
new drawing, no second colour scale to keep in step, and one permutation of a `Float64Array` to
pay for it. It is the *scores* reordered rather than the distances the tree was built from —
what somebody wants to look at is the matrix they have, arranged so its structure shows.

### The drawing

`DendrogramViewer` is **SVG rather than canvas**, which is the opposite of `ScatterViewer`'s
call and for the opposite reason: a scatter is fed by an embedding of a whole dataset, where
this is bounded by `MAX_LINKAGE_OBSERVATIONS` and by what a reader can take in. What SVG buys
is the whole export path free (`ViewerActions` clones the live `<svg>`), hit testing on every
branch with no quadtree, and labels the browser lays out.

- **Clicking a bracket selects the leaves under it**, which is the gesture the drawing exists
  for — a clade is exactly the thing somebody wants to pull out and look at in 3D, and it is the
  one selection a table cannot express because it is a fact about the tree. The range is exact
  rather than approximate: the leaf order is a depth-first walk, so every subtree is a
  *contiguous run* of it and a click is `order.slice(first, last + 1)` however many thousand
  leaves hang off it. **What is stored is positions, not names** — see the browser findings
  above — so both exporters map indices back to labels, and R's do it one-based.
- **A branch selects; it does not cut.** The cut lives one node upstream where it is a stored
  number everything downstream can see. A viewer that also cut would be a second answer to the
  same question with nothing saying which won.
- **Colours cycle past the eighth cluster, and the caption says `colours repeat`.** Everywhere
  else here a ninth category takes the achromatic Other colour, because in a legend a repeated
  hue claims two series are the same thing. A dendrogram is the case that rule does not fit:
  clusters sit in leaf order along one axis, so two sharing a hue are visibly far apart and the
  number in the table is the identity — where greying everything past eight leaves a
  twenty-cluster cut with no picture at all. Admitted rather than hidden, on the `labels
  thinned` idiom, which the same caption also carries.
- **Geometry is in unit space** (`dendrogramLayout.ts`, headless), so orientation is a
  projection at the end rather than two layouts that can disagree.

### Newick, because a `Z` matrix is not a file anyone can open

A linkage exports as **Newick** by default — read by iTOL, FigTree, ete3, ape, dendropy and
Biopython — with the linkage matrix itself offered as CSV for going back into SciPy or R.

**Branch lengths are differences, not heights**, and that is the trap: a Newick branch is the
edge *below* a node, so it is the parent's merge height minus this node's. Writing the absolute
height instead produces a file that parses, draws, and is wrong in a way only a scale bar
reveals. Verified with biopython rather than by eye — it reads the output back ultrametric,
every root-to-leaf distance equal to the top merge, and each pair's path distance exactly twice
its merge height. Labels carrying `(`, `)`, `,`, `:`, `;` or a space are quoted with an internal
quote doubled, since `SMP001(a)` would otherwise close a clade mid-name.

### Getting back to neurons: the two bridges

`cluster.selectedToNeurons` and `cluster.clustersToNeurons`, both `Add ▸ Transform`. A
`LinkageValue` knows its leaves only by **label**, because that is all a `MatrixValue` axis
carries — so a Dendrogram's `Selected` and a Cut Tree's `Clusters` are tables of *names*, and
everything that draws neurons wants `T.neurons()`. These cross that gap.

**Two registrations over one operation** (`lib/labelsToNeurons.ts`), which is unusual enough
here to say out loud. They take the same inputs, run the same function and emit the same shape;
what differs is the name, what the input socket says, and one edit-time warning. The case for
two is discoverability — somebody holding a Cut Tree looks for a node named after what they
have — and the cost is paid once rather than as two implementations that drift.

**Matched locally, never queried.** The neurons come from a table already on the canvas, so a
clade of three cell types resolves to the neurons that were *clustered* rather than to every
neuron of those types in the connectome. That is a different question and `IDs from Label` is
the node that asks it. With no Neurons wired the labels are read as neuron ids, which is what
they are unless NBLAST was told to label by something else.

Four things in it that each produce a plausible wrong table:

- **Matched as text**, the `String(cell)` rule `joinTables` follows. An NBLAST labelled by body
  id produces the *string* `"722817260"` against an `i64` column, so comparing by value fails on
  the default wiring rather than on an exotic one. Both exporters cast into a scratch key for
  the same reason — a plain `left_on`/`right_on` merges nothing at all there, with no error.
- **The neuron table drives order and count.** One label naming six neurons gives six rows,
  which is the point when the labels are types; a repeated label takes the first row rather than
  the cross product, which `drop_duplicates` and `distinct` reproduce.
- **Every column survives**, with a collision suffixed as `Join` does. Visible on a real graph:
  a neuron table's own `size` puts the Clusters table's `size` through as `size_c`.
- **A wrong `Match on` is otherwise silent** — an empty table with every count correct. The card
  says `4 labels · 0 neurons · ⚠ 4 matched nothing`, derived from the run for the reason
  `unmatchedLabels` is: there is no channel from `evaluate` to a badge that survives a result
  being restored from cache.

**Known gap: `Skeletons` does not carry extra columns.** It fetches from the dataset, so a
`cluster`/`color` put on a neuron table does not survive `Clusters to Neurons → Skeletons → 3D
View` — the picker there reads `color (missing)`. Neuroglancer takes the neuron table directly
and is unaffected. Closing it means joining the input table's extra columns onto the fetched
attributes, which is a change to a fetch node every graph uses and has not been made.

### `literal`: colours somebody else already chose

A fifth `ColorMode`, opt-in per node via `colorParams({ allowLiteral: true })`, offered today by
Neuroglancer, the 3D view, the Network Viewer and the Scatter. The cells **are** the colours.

**It exists because `categorical` cannot reproduce a dendrogram.** `resolveColor` ranks values
by frequency so the commonest takes the leading slot, then folds everything past eight into one
achromatic bucket. `clusterColor` assigns `(cluster - 1) % 8`, by number, cycling — so the two
agree only by luck, and "colour Neuroglancer by cluster" hands the biggest group the hue the
first group was drawn in. Hence `out.dendrogram`'s `Selected` carries a **`color`** column
beside its `cluster`, and something has to be able to honour it.

- **`clusterColor` is shared** between the viewer and the node. Two copies is a tree whose
  branches disagree with the neurons it sent to a 3D view; the node reaches into `src/ui` for
  it, which is the licence `out.neuroglancer` already takes for `resolveColor`.
- **The emitted hex is the _dark_ palette, pinned.** `evaluate` must be deterministic
  (invariant 4) and a cache key does not change when somebody flips the theme, so resolving from
  `currentMode()` would go stale with nothing to invalidate it. Dark because that is where the
  colours are going — neuroglancer renders on black. The cost, stated: on a light canvas the
  tree's own branches take the light ramp, a shade off the hex in the column.
- **`cluster` and `color` are always present**, 0 and the achromatic ink where nothing has cut
  the tree. A schema that gained and lost them as a Cut Tree came and went would silently empty
  every picker pointing at them — `neuron.connectivity`'s rule for its own `hop` and `direction`.
- **A cell that is not a colour goes grey rather than being coerced.** `#rgb`, `#rrggbb` and
  `#rrggbbaa` only; a column of cell types under this mode is a mistake, and hashing the text
  into a hue would produce a picture that looks deliberate.
- **No legend.** A hex is not a name, so every swatch would be labelled with the colour beside
  it.
- Both exporters carry a third companion (`<tree>_clusters`, `NULL`/`None` from Linkage and the
  cut from Cut Tree), since neither SciPy's `Z` nor R's `hclust` has anywhere to put a cut. The
  palette is read off `clusterColor` rather than transcribed — an emitter may reach `src/ui`,
  which is half of why the emitter registry is separate from the node definitions.

### What it costs, and what is not verified

**+18.6 kB raw / +6.1 kB gzipped on the main chunk**, measured against a build of the same tree
with the feature absent (976.00 → 994.59 kB). The Pyodide worker grew 9.5 → 13.1 kB, carrying
both `.py` files inlined; `main-*.js` still matches `jsdelivr` nowhere. Well under this
codebase's bar for a lazy boundary (the exporters, at 17.6 kB gzipped).

Clustering is **free next to the comparison it follows**: measured in Node against the real
wheel, 400 observations in 2–4 ms and 2,000 in 33 ms, against roughly seventeen seconds to score
500 neurons in the first place. `scripts/probe-linkage.mjs` (`pnpm probe:linkage`) runs
`linkage.py` against that wheel through the same entry point the worker calls and asserts the
*contract* — one merge fewer than observations, flat float64, `order` as int32 rather than the
int64 numpy holds it in, heights ascending, no merge referencing a later cluster — plus one
structural check on a planted two-block matrix, which is the cheapest thing that would catch a
matrix handed over transposed or as similarities where distances were meant.

### What was checked in a real browser

Headless Chrome over CDP against `pnpm dev`, driving a shared-link graph of
`Mock hemibrain → Find Neurons → Skeletons → NBLAST → Linkage → Cut Tree → Dendrogram` with the
ordered matrix going to a Heatmap. That is also the only place the **worker runs two Python
modules in one session**, which nothing in the suite covers: NBLAST boots the runtime and
clustering arrives into it, both landing inside two seconds.

Verified: fourteen leaves and thirteen brackets, merge heights to scale, both orientations
(labels rotated under `down`, all fourteen inside the plot in both), the three clusters coloured
with the branches *above* the cut in neutral grey, the caption, the styling rail in the overlay,
a click lighting exactly the clade under it and nothing else, and no console errors. Both bugs
above came out of this pass.

The **light theme** was driven too, and comes out of the palette rather than out of a literal:
surface `#fcfcfb`, the three cluster hues from the light categorical ramp, `#898781` above the
cut and `#52514e` on the labels — all through `currentMode()`, `CHART_INK` and `seriesColor`,
which is the only reason a viewer computing hex in JS survives a theme switch at all.

What has **not** been looked at is a tree at the few-hundred-leaf end, where the label thinning
actually bites, and the `Ordered` matrix beside a Heatmap at a size where the blocks matter.
