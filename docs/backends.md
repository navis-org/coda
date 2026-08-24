# The four backends

Everything under `src/data` that talks to somebody else's server.

Moved verbatim out of `CLAUDE.md`.

**Every _neuron_ skeleton and mesh fetch goes through `geometryCache.ts` first.** All three
backends compose their own key and hand it the ids they were asked for; it answers the ones it
holds and calls back with only the remainder, so a node re-running on a changed neuron set
downloads the difference rather than the set. The reasoning, the measurement behind it and what
belongs in a key are in [core.md](core.md#three-caches-and-the-two-controls-that-clear-them) —
read it before adding a fourth backend's geometry path, because getting the key wrong is silent in
both directions: too narrow and nothing ever hits, too broad and a body is served at a detail
level nobody asked for.

**Three of the four fan-outs also stream.** `cachedGeometry`'s `fetch` hands each body over
through `deliver` as it lands rather than returning a map at the end, so a source can build a
partial answer and pass it to `GeometryRequest.onPartial` — see **A partial result** in
[core.md](core.md). neuPrint skeletons, neuPrint meshes and CAVE meshes are all one independent
request per body and stream from the first arrival. Two do not:

- **Precomputed multi-resolution meshes** stream only their fragment sweep. `chooseLod` sums
  `totalBytes` across the whole batch, so no fragment can be requested until the last manifest
  has landed — and measured against hemibrain at 300 bodies, the manifest sweep is 1,913 ms of a
  2,381 ms cold run. A re-run with the manifests already cached streams from the start, because
  they get their own cache entry and are level-independent. Breaking the barrier properly means
  changing what `Detail` *means* — a per-body byte budget, or a level committed from a prefix of
  the manifests — which is a semantics decision, not plumbing.
- **CAVE level-2 skeletons cannot stream at all.** `readL2Skeletons` is not a per-neuron fan-out
  that happens to be batched: it reads every neuron's chunk graph, pools the chunk ids across the
  whole set, and reads their coordinates in as few requests as it takes. No skeleton exists until
  that pooled read lands. Making it streamable means reading attributes per neuron — more
  requests for a slower result, which is the opposite of the trade that made the batching worth
  writing.

A source that streams starts its **attribute** query alongside the geometry and hands the promise
to `cachedGeometry` as `readyBefore`; nothing publishes until it settles. A partial assembled
without those rows carries a null `type` for every body, so a scene set to colour by type fills
in grey and then restyles itself wholesale when the last body arrives — and awaiting them
*before* the fetch is worse, since on CAVE's cold path that is a 139,255-row index build standing
between the user and the first byte of geometry.

The rule is in the shared layer because all three sources need it and each had grown its own
spelling of "has it landed" — a boolean beside a nullable result, a shadow copy of the awaited
value, and a re-derivation of the condition that decided whether to fetch at all. Settled rather
than fulfilled: a source that could not label its bodies should still draw them.

**`fetchRoiMeshes` is the exception, and it is a gap rather than a decision.** Region shells are
the largest download in the app — 29 MB for hemibrain's primary set, 62 MB for male-CNS's — and
adding one region to the `ROI Meshes` picker re-fetches every other one, which is exactly the case
the cache was written for at ten times the bytes per item. It needs `refresh`/`onFetched` on
`RoiMeshRequest` (which `GeometryRequest` has and this does not), a per-region key in
`NeuPrintSource.fetchRoiMeshes`, and `dataCache: true` on the node. Note `roiOutlines.ts` caches
only the *derived 2D outlines*, under a UI-layer key, so the ROI Viewer and the node share
nothing today.


## neuPrint

Lives entirely under `src/data/neuprint/`. Nodes see the same `DataSource` interface the
mock implements; nothing above `src/data` knows Cypher exists.

**Direct access depends on the deployment, so the route is discovered rather than declared.**
neuPrint used to send _no_ `Access-Control-*` headers on any response, with its `OPTIONS`
preflight returning 401 before CORS middleware would run — so a request carrying an
`Authorization` header was blocked by the browser before it was sent, and every call had to go
through a same-origin proxy. Janelia has since fixed that on `neuprint-test.janelia.org`, and
the fix was checked end to end rather than taken on trust: 204 on the preflight,
`Allow-Headers: Authorization, Content-Type` (exactly what this app sends — `Accept` is
safelisted and needs no mention), no `Allow-Credentials`, and `Access-Control-Allow-Origin` on
**every** response including 401 and 404. That last one is the load-bearing part: the
`reportAuthFailure` channel works by reading a 401's status, which a browser only surfaces if
the response itself carries ACAO. All seven endpoints this app calls were verified, each path
prefix preflighted separately (nginx CORS config is per-location), and a 4 MB Explore-Dataset-shaped
index came back gzipped to 957 kB in 1.4 s. `neuprint.janelia.org` does **not** have it yet.

So `routesForServer` offers two routes — the deployment itself, then the proxy path — and
`client.ts` _tries_ them, because a browser reports a CORS refusal as an opaque `TypeError`
indistinguishable from a dead host. The answer is remembered per deployment in `localStorage`,
since without that every request in a proxy-only session pays a failed preflight first. Three
rules make that safe, and each is pinned by a mutation-checked test:

- **Only a thrown fetch moves on to the next route.** A response of any status means the
  request arrived, so a 404 is neuPrint saying 404. Retrying a _status_ would also send a
  second copy of a POST — and that endpoint runs Cypher. Same rule as `transport.ts`.
- **Only a 2xx is remembered.** A 404 is what a static host answers for a proxy path nobody
  serves; remembering it would pin a deployment to a route that can never work, and would
  outlive the day that deployment gains CORS.
- **An `AbortError` is never answered by trying elsewhere** — that would issue the request the
  cancellation was meant to stop.

The proxy still matters and is registered under **both `server.proxy` and `preview.proxy`** —
those are separate config keys, and a preview server without it 404s every request with an
empty body.

**A 404 on a same-origin base means "no proxy", not "neuPrint said no" — and it takes two
tells, not one.** neuPrint's own errors always carry a JSON body, so an _empty_ body is the
tell for a vite server with no matching rule. A static host is the other case and answers
differently: GitHub Pages serves its own 9 kB HTML 404 page. Checking only for the empty body
is how a Pages deploy came to report `neuPrint returned 404: <!DOCTYPE html>…`, blaming a
server that never saw the request and sending somebody to look at their token. `looksLikeHtml`
is the second tell. Do not collapse either back into a generic message — the first cost a
debugging round trip already, and the second cost one in the deployed app.

**The app introduces itself in a Cypher comment, because nothing else is available.** neuPrint
is a shared production Neo4j and an operator reading a slow-query log cannot otherwise tell which
client sent what. A browser cannot help the way neuprint-python does: `User-Agent` is a forbidden
header name in the Fetch spec, so it is silently ignored and Coda sends the browser's. A custom
header is the obvious substitute and is currently **worse than nothing** — it is not
CORS-safelisted, so it must appear in `Access-Control-Allow-Headers`, and neuPrint answers a
preflight with a **fixed** `Authorization, Content-Type` whatever is requested (checked with
three different `Access-Control-Request-Headers`). Adding one today would fail every
cross-origin request outright rather than merely going unnoticed. It is a line of nginx config
on Janelia's side; ask for it alongside the production CORS rollout, since it is the same file.

So `tagQuery` prefixes `// coda/<version>`, which reaches the query log and changes nothing that
executes. Three things about it:

- **It lives in `client.ts`'s `runCypher`, not in `cypher.ts`'s builders.** One place covers
  every query including the Raw Cypher node's, which no builder sees — and the builders are
  asserted against exact query text throughout `neuprint.test.ts`, so tagging there would thread
  a version through several dozen assertions that are about escaping and column order.
- **It costs no provenance.** A cache key is `hash(type, params, upstream keys)` and never the
  query text, so a version bump changes no key and invalidates nobody's results.
- **It was checked against the live deployment rather than assumed.** neuPrint validates that a
  query is read-only and a leading comment could plausibly have upset that; six shapes were run
  against `neuprint-test` — plain `MATCH`, `WHERE … IN`, a `WITH` pipeline, a bare `RETURN`, a
  `CALL`, and a query that already carries its own comment. All accepted, and neuPrint echoes
  the whole query back in a `debug` field, which is where it becomes visible.

**Per-dataset schemas.** `DataSource.schemasFor(datasetId)` is optional and synchronous;
`schemasFromType()` in `datasetParam.ts` is the single funnel every query node goes through,
so this is the only place that had to change. hemibrain has `cellBodyFiber` and `somaRadius`,
manc has `hemilineage`; one fixed schema would either lie or under-report. Discovery reads
`Meta.neuronProperties` where it exists (**hemibrain has none**) and otherwise samples whole
neurons with `RETURN n`, which yields names _and_ value types in one round trip. Two things
get subtracted: ROI names (a neuron carries a boolean per innervated ROI — 230 of them on
hemibrain, and `IB`/`INP` look nothing like ROIs) and non-scalar properties (manc declares
five as `point{srid:9157}`).

**Everything is inlined into the query string.** `/api/custom/custom` takes no parameter
map, so values must go through `escapeString` / `idList` / `escapeIdentifier` in
`cypher.ts`. Nothing else may build a literal.

**Column mapping is positional.** neuPrint names columns after the expression (`n.bodyId`),
so the decoder matches `RETURN` order against schema order and throws on a count mismatch.
If you add a column to one, add it to the other — the builder and its schema are written
together for this reason. It is also what lets Coda's column name differ from neuPrint's
property name without a lookup per row: `n.bodyId` lands in `neuronId` because it is first in
both lists. See `PROPERTY_NAMES` in `schema.ts` for the one place that mapping is stated.

**Don't percent-encode a dataset id in a path.** Every id contains a colon
(`hemibrain:v1.2.1`) and neuPrint's router matches the raw segment; `%3A` gets a 400. Use
`datasetSegment()`. This surfaced as _zero skeletons and no error_, because the concurrency
helper was swallowing every failure — it now rethrows when all items fail.

**Guard rails were considered and declined.** `Find Neurons` still defaults to `limit: 0`
(everything), and raw Cypher is sent as typed. That is a deliberate call: these queries hit
a shared production Neo4j, so an unbounded `MATCH (n:Neuron)` on male-cns is a real hazard.
Leave the decision where it is rather than re-litigating it.

**The token** lives in `localStorage` via `credentials.ts`, never in a saved graph. A 401
goes out on a separate channel (`reportAuthFailure`) rather than as an error message,
because errors cross the scheduler as strings and matching on message text rots silently;
`SourcesPanel` subscribes and opens itself.

**Tests use recorded fixtures** in `__fixtures__/`, all real trimmed responses. The
transport is not covered — it cannot be without a network — but it fails loudly.

## CAVE

`src/data/cave/`, and the second backend. FlyWire and everything else served by CAVE — the
info service that lists datastacks, a materialization engine that answers queries against a
frozen snapshot, and per-datastack annotation tables. Nothing above `src/data` knows it exists;
a CAVE dataset node is `dataset.flywire`, built from `DATASET_FAMILIES` exactly as the neuPrint
ones are.

**Everything below was probed live against `global.daf-apis.com` and `prod.flywire-daf.com`
rather than recalled**, and `live.test.ts` is that pass institutionalised — skipped without
`CAVE_TOKEN`, the standing `scripts/check-export.py` has when navis is absent.

### neuPrint is queried; CAVE is downloaded

The single decision the whole module follows from. neuPrint runs Cypher against a shared
production Neo4j, so `findNeurons` compiles a pattern into a query and every question is a round
trip. CAVE's query API has **no regex worth using, no `GROUP BY`, and a 500,000-row cap** — but
its annotations are a few tens of megabytes and are *already* what the Explore Dataset widget wants. So
`CaveSource` fetches the neuron index once per dataset through the machinery Explore Dataset already
has, pivots it, and answers `findNeurons` from memory: 139,255 neurons in **6.7 s**, then every
query after that is local. The cost is that the first one waits.

That is why `data/neuronFilter.ts` exists. Filtering locally means *Coda* decides what a pattern
means, and it has to decide the same thing the mock does and the same thing Neo4j's `=~` does —
`^(?:…)$`, so `LC.*` matches `LC4` and not `LPLC1` — or one graph pointed at two backends
quietly returns two answers. `compileRegex` and `compileLabelMatch` moved out of `MockSource`
when CAVE became their second consumer; a copy is how the two drift.

**`refuseUnfilterable` is the third thing in it, and it is about a filter a backend cannot answer
*at all*.** Both local sources met that and each got it wrong in a different direction, neither
visible from the result. `CaveSource` read `index.data.size` — a column no CAVE index has —
through `Number(undefined ?? 0)`, so any non-zero **Min size** compared 0 against the threshold and
dropped every row: a node reporting "0 neurons" for a datastack full of them. `CatmaidSource` never
read `req.roi` at all while publishing eighty regions to pick from, so the answer came back too
*large*. An empty result and an unnarrowed one both look like answers, which is what makes a
refusal the only one of the three that can be acted on; it names the control as the card labels it.

Note which filters this covers and why. `Min size` and `In ROI` reach a source **only when
somebody set them** — 0 and `Any` are dropped by the node — so a refusal fails a decision rather
than a default. `status` is deliberately excluded: its default is `Traced`, so refusing there would
fail a value nobody chose, and a source that cannot answer it ignores it instead. That is the split
`CatmaidSource` already documents, made checkable.

It is also deliberately **not** `compileLabelMatch`'s rule, whose absent value matches nothing on
purpose: that is neuPrint's `WHERE` semantics for a *property* a dataset may legitimately lack per
neuron, and every backend has to agree about it. These two are whole-query facts about the backend,
known before a single row is read.

### The 64-bit problem, at the other end of the seam

Invariant 8 was written for this. A FlyWire root id is eighteen digits, and **`JSON.parse`
rounds it**:

```text
raw text   "pt_root_id":720575940628857210
JSON.parse  720575940628857200   ✗ a different neuron, silently
json.ts    "720575940628857210"  ✓ matches the bytes on the wire
```

No reviver helps — a reviver is handed the value *after* parsing, so the digits are already
gone. The exact value exists only in the response text, so `json.ts` quotes every integer
literal too wide for a double before the parser sees it. Four things about it:

- **The scan matches a complete string literal first**, so it never looks inside one. The
  obvious `raw.replace(/:(\d{16,})/g, ':"$1"')` is wrong on real data: `neuron_information_v2`
  is free-text user annotation, so a tag reading `root:720575940628857210` gets quotes spliced
  into the middle of a string and the document stops parsing.
- **The decision is per match, by `Number.isSafeInteger`.** A 16-digit value that is genuinely
  exact stays a number; only what a double cannot hold becomes text.
- **The delimiter is part of the match** rather than a lookbehind, which is also what stops the
  fractional digits of `0.1234567890123456789` starting a match.
- **721 ms on the real 64 MB index response**, against 108 ms for a naive parse. Paid once per
  dataset behind the IndexedDB cache and against ~6 s of network — but worth knowing before
  anyone puts it on a hot path.

**The other leg is free, and that was checked rather than assumed: CAVE accepts a *quoted*
eighteen-digit id in `filter_in_dict`** and answers identically to an unquoted one. So ids go
out as text and come back as text, and no number is ever formed on either side. Had it not, the
request body would have needed the mirror image of the same rewrite.

### The 500,000-row cap, and why counting is the only tell

The materialization engine truncates a result at 500,000 rows and says so in a `warning`
header — which its `Access-Control-Expose-Headers` does **not** list, so a browser cannot read
it. Truncation is therefore detected by counting, and refused rather than returned: a short
index is not a visible failure, it is a dataset that silently lacks neurons.

**`hierarchical_neuron_annotations` is over the cap**, which is why the index reads it **one
`classification_system` at a time** — five queries of 17k to 139k rows instead of one that comes
back quietly short. The kinds come from discovery, which has already run, so the split costs no
extra round trip.

That was found by `live.test.ts` on its first run, and it is exactly the class of bug the fixture
suite cannot see. Note the tell that pointed the wrong way: the `table/{t}/count` endpoint reports
**377,699** for that table and **127,978** for `proofread_neurons`, while the tables themselves
yield over 500,000 rows and 139,255 distinct root ids. Whatever it counts, it is not the rows a
query returns — which is also why `DatasetInfo.neuronCount` is filled in from the index after the
fact rather than asked for at listing time.

### A datastack does not describe itself

neuPrint's graph has a `:Neuron` label with properties on it. A CAVE datastack is a bag of
annotation tables with no privileged one — `flywire_fafb_public` publishes six, of which
`proofread_neurons` is the neuron set, `hierarchical_neuron_annotations` is the cell typing, and
`valid_connection_v2` is a **view** rather than a table. Nothing in the metadata says so; the
schema types (`representative_point`, `cell_type_reference`) describe the shape of a row, not
the role of the table.

So `spec.ts` holds one entry per datastack, static for the reason `datasetFamilies.ts` is
static, and it is a deliberately faithful port of the idea `connecto` arrived at in Python for
the same problem. **A datastack with no entry is not offered** — the info service lists thirteen
and most would fail on the first Run, and a dataset that appears in the picker and then fails is
worse than one that is absent.

**Connectivity Graph prefers that view and falls back to counting synapses**, which is `connecto`'s
shape and arrived at for its reason. `valid_connection_v2` is the server having done the
aggregation once: one row per ordered (pre, post) pair with `n_syn`, filterable by root id *and*
by `n_syn`, so a minimum weight is applied before anything is sent — on one neuron's outputs,
4,818 rows / 410 kB unfiltered against 183 / 16 kB at `n_syn >= 5`.

Where there is no such view — **which is most datastacks; FlyWire's is the exception** — the
edge list is built by asking the synapse table for its two id columns and counting locally. The
query API has no `GROUP BY`, so neither the grouping nor the weight cut can be pushed down: every
synapse of every queried neuron is transferred, and `minWeight` is applied *after* counting.
That is still worth having by a long way, because the alternative is not a cheaper query but no
connectivity at all. Measured against Aedes, exactly that case: one neuron's 719 synapses arrive
in 1.1 s and 111 kB and collapse to 508 partners.

Two things about the synapse path were established live rather than assumed. **`select_columns`
sends more than it is asked for** — naming a `*_pt_root_id` returns the whole bound point, so the
supervoxel id rides along and the transfer is about twice what two columns suggest. And
**`refuseIfCapped` is the real bound**: a hub neuron or a large seed set can reach the 500,000-row
truncation, where the view path is one row per pair and cannot.

**Which synapse table is three answers in order, and the order matters.** A configured
`spec.synapses` wins, because it can name a curated table and the column that scores it —
FlyWire's `synapses_nt_v1` with `cleft_score`, on a datastack that declares
`synapse_table: null`. Otherwise the datastack's **own declaration**, which is what makes a
hand-named datastack work with no configuration at all: 7 of the 13 the info service lists set
it, `wclee_aedes_brain` among them. Its columns are `STANDARD_SYNAPSE_COLUMNS`, which is a
definition rather than a guess — a table whose registered schema is `synapse` has
`pre_pt_root_id`, `post_pt_root_id` and `ctr_pt_position` by `emannotationschemas`, checked
against both a declared and a configured table. `fetchSynapses` resolves the same way, so a
datastack that can answer connectivity by aggregation can also draw the synapses it aggregated;
`positionColumn` is a *stem* the API splits into `_x`/`_y`/`_z`, verified to behave identically
on both.

### Endpoint shapes that are not what a reasonable person would guess

Read off live responses and cross-checked against `caveclient` 8.0.1's own endpoint table:

- **`arrow_format=false` returns `application/json`**, which is what keeps Arrow, a WASM decoder
  and anything new in the main chunk out of this entirely. The cost is `json.ts`.
- **`tables` sits on a v2 path inside the v3 API.** caveclient's v3 map points it at `mat_v2_api`
  while everything around it moved; the v3 spelling 404s.
- **`select_columns` and `select_column_map` are not interchangeable, and each endpoint takes
  exactly one.** A single-table or view query rejects the map —
  `{"schema_errors":{"select_columns":["Not a valid list."]}}` — and a *join* accepts the list
  while warning that it "will attempt to select the first column it finds of this name in any
  table, but if there are more than one such column it will not select both", which is a
  silently wrong column rather than an error.
- **One `/metadata` call lists every materialization with its timestamps**, where `versions`
  returns bare integers and a per-version call turns a listing into a request per entry.
- **`unique_string_values` is the cheap half of discovery**: 52 kB and about a second, against
  tens of megabytes for the annotations. That is what lets discovery run from inference
  (invariant 2) while the index waits until something actually asks for neurons.

### What it costs, and what it declines

**+16.4 kB raw / +5.2 kB gzipped on the main chunk** (1,010.02 → 1,026.39 kB), measured against
a build of the same tree with the feature stashed out. Far under this codebase's bar for a lazy
boundary.

`SourceCapabilities` does the rest, and every `false` is a node that declines at edit time rather
than failing at run time: no skeletons, meshes or synapses (the next phase — FlyWire publishes
precomputed skeletons per materialization and Draco meshes in a CORS-open bucket, so this is
"not wired up" rather than "not available"), no `paths` (it needs a hop aggregated server-side,
which CAVE has no endpoint for), no `rawQuery`, no `viewerScene`, and none of the three ROI
flags — FlyWire's neuropil assignments are a reference table on *synapses*, so there is no
per-region completeness table to read, and a per-neuron breakdown would mean reading a neuron's
synapses and grouping them, which is the work the connection roll-up exists to avoid.
`neuronIndex`, `meshes`, `synapses` and `viewerScene` are true for the source; `skeletons` is
answered **per dataset** through `capabilitiesFor` — see **Skeletons** below.

**The scene is built rather than fetched, and that is the whole of `viewerScene` here.** neuPrint
publishes a curated state per dataset — EM, ROI shells, synapse layers, a framing — which
`buildScene` edits. CAVE publishes no such document, which is why this reported "publishes no
neuroglancer scene"; but its info record names every *part* of one, so `cave/scene.ts` assembles
two layers from it and stops. Anything beyond those two is curation, and inventing it would be
claiming the datastack said something it did not. `layout` and `showSlices` are left off, because
`buildScene` supplies them when absent and a second rule here is a second place for the two to
disagree.

Three things in it, and two of them disagree with `caveclient` on purpose:

- **The segmentation source is published plain**, `caveclient`'s `format_graphene`. It used to
  carry `graphene://middleauth+…` unconditionally, which is wrong and is written up under
  *`middleauth+` is spelunker's, not neuroglancer's* below. Worth keeping from the first pass: an
  *insertion* rather than the reparse the Python does, since `urlparse` reads
  `graphene://https://host/p` as `netloc='https:'` and rebuilding from the parts only happens to
  come out right.
- **The image source is passed through, where `caveclient` answers `None`.**
  `format_cave_explorer` routes a `precomputed://` scheme to `format_precomputed_neuroglancer`,
  which handles `gs://`, `http://` and `https://` and falls through to `None` for a URL that
  already carries its scheme — established by *running* it, not by reading it. Every datastack
  probed publishes exactly that form, so porting the formatter faithfully would ship no image
  layer at all.
- **`viewer_resolution_*` is nanometres and neuroglancer's dimensions are metres, divided rather
  than multiplied.** `45 * 1e-9` is `4.5000000000000006e-8` in float64 and that artefact would be
  serialised into the URL verbatim; `45 / 1e9` is exact. 16, 4, 40 and 8 are unaffected either
  way, which is why it survived the first reading — 45 and 50 are not.

**The `#!+` merge works in spelunker too**, which was the open question the moment a CAVE dataset
started opening there rather than in mainline neuroglancer — the merge form was established
against the deployed Google viewer. Confirmed by reading spelunker's own bundle: its
`updateFromUrlHash` branches on `#!+` *before* the `#!` case and calls `restoreState` with no
`reset()`, which is exactly the semantic the camera-preserving update depends on.

**`DatasetInfo.viewerSite` came with it**, and it is a fact about the dataset rather than a
preference: `out.neuroglancer`'s `Viewer` param defaults to *empty*, meaning the dataset's own
deployment and only then the built-in. A CAVE segmentation only loads in a viewer that
authenticates the way its source is written for, and which way that is depends on the deployment —
see below. Absent on every neuPrint dataset, whose states open anywhere.

#### `middleauth+` is spelunker's, not neuroglancer's

The prefix was applied to every CAVE segmentation source, on a note here claiming it "is what
makes the segmentation load at all". That is true of one flavour of viewer and **breaks the
other**, and the other is the one FlyWire publishes.

`caveclient` says so in a fork the first transcription read straight past. `output_map` in
`format_utils.py` routes `"neuroglancer"` to `format_graphene` — plain — and
`"cave-explorer"`/`"spelunker"` to `format_verbose_graphene`, which adds the prefix; and
`build_neuroglancer_url` sets `auth_text = ""` for `seunglab` against `"middleauth+"` for the
rest. Transcribing `format_verbose_graphene` alone was transcribing one of two branches.

**The failure is symmetric and neither half is loud.** A seunglab fork runs its own login and
refuses the prefixed source; a spelunker build without it shows the segmentation layer present
and empty. Both read as "the viewer is broken".

**It is decided at `sceneUrl`/`scenePatchUrl`, which is the only place a scene meets a viewer.**
`caveScene` runs inside `fetchViewerScene`, and a `DataSource` has no idea which deployment the
node will open — so the prefix was being chosen a whole layer before the fact it depends on
existed. Both URL builders funnel through one rewrite, which is what stops the navigation and the
merge disagreeing; `SCENE_PATCH_KEYS` is `['layers']`, so a patch carries the sources too and
would break the segmentation exactly as a navigation would. The rewrite **normalises** rather
than only adding, so a hand-written state or a datastack that names its source with the prefix
already on it comes out right either way.

**caveclient's own test is unavailable to a browser**, which is why this is a table rather than a
probe. It fetches `<viewer>/version.json` — 404 on a seunglab fork, 200 on the others — and
measured against both deployments **that endpoint sends no `Access-Control-*` headers at all**.
So `SEUNGLAB_HOSTS` in `neuroglancer/scene.ts` carries what was measured, and the measurement is
in the comment beside it:

```text
ngl.flywire.ai                404  seunglab   ← flywire_fafb_public's own viewer_site
neuroglancer.neuvue.io        404  seunglab   ← caveclient's own fallback_ngl_url
neuroglancer.bossdb.io        404  seunglab
spelunker.cave-explorer.org   200  spelunker
ngl.cave-explorer.org         200  spelunker
ngl.microns-explorer.org      200  spelunker
neuroglancer-demo.appspot.com 200  spelunker  ← DEFAULT_NEUROGLANCER_URL
```

`ngl.cave-explorer.org` is in that list because it was **guessed** into the seunglab set on the
strength of its name and is not one. The names do not tell you; probe before adding a row.

**Unknown reads as spelunker**, and `out.neuroglancer` grew a `Viewer type` param
(`auto`/`spelunker`/`seunglab`, advanced) as the escape hatch — because `Viewer` is free text, so
the table can never be complete, and a wrong answer is a scene with no segmentation in it and
nothing naming the cause.

#### The layer type is the other thing the two flavours disagree about

The Seung-lab fork has a layer type of its own for a chunked-graph source, and banners the
plain name:

```text
The layer specification for graphene://… is deprecated.
Key 'layerType' must be 'segmentation_with_graph'. Please reload this page.
```

That sits along the bottom of the frame and, as it says, **only a document reload clears it** —
which on an unexpanded node card is a real share of the drawing, indefinitely.

`nglui` is the reference and its rule is the **source scheme**, not the datastack:
`_smart_add_segmentation_layer` builds a `ChunkedgraphSegmentationLayer` — which is
`type="segmentation_with_graph"` — for a `graphene://` source and a plain `SegmentationLayer`
for `precomputed://`. Mainline knows no such type, and nglui 4.x, which targets spelunker only,
emits `segmentation` throughout. So it normalises **both** ways beside the prefix, in the same
`sceneForViewer` pass: a scene read back out of a seunglab URL and re-sent to a spelunker viewer
would otherwise carry a layer type that viewer cannot construct.

**The ordering is what keeps it safe, and it is worth knowing before touching either end.**
`segmentationLayerIndex` matches `type === 'segmentation'` exactly, and it runs inside
`buildScene` — on the scene `fetchViewerScene` published, which is always the plain form. The
rewrite happens later, at the URL. Do it earlier and the neuron layer stops being findable, so
the scene comes out with no selection in it. `spliceSegments` is unaffected either way, since
`ownedLayerName` finds the layer by its `segments` array rather than by its type. Both facts are
pinned by tests, one of which asserts the segments survive the rename.

**Not confirmed in a browser**, and that is a real gap rather than an oversight: `ngl.flywire.ai`
refuses to boot without a FlyWire session — headless it answers *"Oops! There was an error and
Neuroglancer…"* whichever type it is handed, so the warning cannot be observed appearing or
disappearing here. What is established is the rule (nglui, both versions) and the required value
(the warning names it outright).

#### Reloading the frame

There is no other way to clear a warning the viewer has already put up, and until now Coda had
no way to ask. `contentWindow.location.reload()` is blocked on a foreign-origin frame, and
re-assigning the same `src` is a **same-document fragment navigation** — the very property the
`#!+` merge depends on, working against us here. What is left is remounting the element, which
is a `key` on the `<iframe>` and a counter in the effect's dependency list.

Two refs are cleared with it and both are load-bearing:

- **`appliedRef`**, because the effect's first act is to return early for a URL already applied.
  Leave it set and the remount produces a permanently blank frame.
- **`loadedRef`**, because it decides merge-versus-replace. The reload's own navigation sets
  `appliedRef` again, so the *next* upstream edit is an ordinary merge — and if the new document
  has not booted yet, that patch lands on neuroglancer's defaults instead of the published
  scene. This is the same window the flag was added for, reached from the other side.

The second was **vacuously covered at first**: the obvious test clicks reload and asserts a full
navigation, which passes on `appliedRef` alone. It only bites when the URL changes *between* the
reload and the new document's `load`, which is what the test does now — confirmed by mutation,
where the first version did not.

The button is worth having beyond this warning: an embedded WebGL application can wedge for
reasons nothing here can see, and every other route out of that was reloading the whole of Coda.

**Ask `viewerKind` about a deployment, never about a proxy path.** `NeuroglancerViewer` rewrites
its base to the same-origin `/ng` prefix so it can read the live state back, and `/ng` is a path
on this origin that names no viewer at all — so that caller passes the kind of the base it
started from. An inverse lookup inside `viewerKind` was written first and removed: it was correct
and **unobservable**, since the only proxied deployment is the default and both it and the
unknown fallback are spelunker, so a test on it passed under mutation while defending nothing.

The existing test asserted the prefix unconditionally and passed, because the fixture's
`viewer_site` happens to be `spelunker.cave-explorer.org`. Two more of the new tests were vacuous
on the first pass for the same shape of reason — a plain source makes "no prefix" true whether or
not anything ran — and both now assert **both directions**. Four mutations confirmed: always-
spelunker, add-without-normalising, patch-not-rewritten, and the explicit kind ignored.

**`roiCounts` is new, and `fetchRoiCounts` became optional to make room for it.** It was the one
per-backend method on the seam that was required and ungated, and the cost of that showed up two
levels away rather than at the node: `out.profile` fetches its regions in a `Promise.all` beside
two connectivity queries, so a source that rejected there took all three down and **every tile on
the card reported an error** — on a neuron whose partners had loaded perfectly well. The regions
leg is now independently absent, which is the widget's own "a tile renders only when its data
exists" rule, and `neuron.roiCounts` gained the `sourceSupports` gate its two ROI siblings
already had.

Two absences show up as data rather than as flags. A CAVE dataset reports **no ROIs and no
statuses**, so Find Neurons' region and status pickers offer nothing to filter by — which is the
honest state rather than a control that would match nothing.

### Skeletons come from the level-2 cache, and the capability is per dataset

**A CAVE datastack's skeletons depend on its chunkedgraph, not on the backend**, so
`capabilities.skeletons` — which is per *source* — was telling every FlyWire-production user
something false. `DataSource.capabilitiesFor(datasetId)` is the seam that fixes it: synchronous,
`undefined` meaning "same as the source", read by `sourceSupports` ahead of the source's own
answer. Only CAVE implements it, and only for `skeletons`; the Skeletons node's refusal now says
"This **dataset** has no skeletons".

**The route is the level-2 chunk graph, which is `fafbseg.flywire.get_l2_skeleton()`'s method.**
Two requests per neuron: the graph of which level-2 chunks touch which, then the L2 cache's
`rep_coord_nm` and `max_dt_nm` per chunk. Measured on BANC: five neurons concurrently in 3.2 s —
which is one neuron's latency, since they overlap — and trees of 739, 69 and 2 nodes with radii.

**The skeleton *service* several datastacks also publish is not used, and that is measured
rather than assumed.** It generates from this same cache, so it covers no datastack the L2 route
does not: `flywire_fafb_public` declares a service and has no cache, which is exactly why its
skeleton cache was found empty in the phase before this. On one BANC neuron the service took
10–45 s to generate against 1.6 s here, and returned 74 vertices against 146 chunks. It is also
blind to `wclee_aedes_brain`, which has a populated cache and publishes no service at all.
`caveclient.l2cache.has_cache()`'s rule is the gate — the table mapping lists the chunkedgraph
tables the cache knows, and membership is the answer — verified against the live refusal
("Dataset flywire_public does not have an L2 Cache") rather than trusted.

Six of the thirteen datastacks have a cache: BANC, FANC production, FlyWire *production*,
minnie65 public, Aedes and zheng_ca3. **`flywire_fafb_public` does not**, so the node Coda ships
still declines — correctly, and now for the right reason.

Four things in the tree building, each a wrong picture if lost. **Chunks with no cache entry are
dropped, and dropped _before_ the walk** — after it they would orphan their children, where
excluding them lets the walk route around through whatever else they touched (`navis.remove_nodes`
reparents for the same reason; doing it up front needs no reparenting). **A breadth-first
spanning forest**, because the L2 graph is undirected and can hold cycles while a skeleton is a
tree — a cycle surviving into `parents` makes every consumer that walks to a root loop forever.
**Each component gets its own root**, so a neuron split by an edit is two trees rather than one
with a fabricated join. And **a single-chunk neuron answers `undefined` before the cache is
asked**, which is `readGrapheneMesh`'s answer to the same shape of question and saves a round
trip on a common case.

**The attributes call is batched across the whole request, and that is the shape of the fetch.**
It is keyed by *table*, not by root id, so the union of every neuron's chunks goes in a handful
of requests however many neurons were asked for — a hundred neurons is a hundred chunk-graph
reads plus about three attribute reads, rather than two hundred round trips. Measured: 1,177
chunks (twelve neurons' worth) answered in **one 1.64 s request**, against roughly that for each
of the twelve separately. The cost is that progress reports in two phases rather than per neuron.

**`L2_CONCURRENCY` is 16, and it is set by correctness rather than by the curve.** Measured
against BANC, 40 neurons: 14.5 s at 8, 4.6–6.0 s at 16, 3.9–4.9 s at 32, 5.2 s at 48 — three
times faster at 16 and flat after. But **past 16 the server starts dropping requests silently**:
two of three runs at 32 returned 38 and 39 skeletons of 40, and one at 48 returned 39, where
every run at 8 and 16 returned all 40. `mapWithConcurrency` turns a failed neuron into an
`undefined` indistinguishable from a neuron that genuinely has no skeleton, so the missing ones
do not announce themselves.

`MAX_L2_SKELETON_NEURONS` is 100 — far above `MAX_MESH_NEURONS`' 20, because a skeleton is one
chunk-graph read where a graphene mesh is several hundred requests, and far below the 500 a
source publishing ready-made skeletons allows.

**Points come out in visit order, so a parent always precedes its child.** That is the contract
`SkeletonGeometry.parents` states and that `neuprint/decode.ts` does real work to honour;
emitting in chunk-id order would satisfy the type and break every consumer that walks the array
once, the SWC writer included. The test for it uses edges whose *encounter* order differs from
their *visit* order, because on a chain listed front to back the two coincide and a test built on
one passes whichever the code emits.

**`capabilityOf(source, datasetId, key)` is how a capability is read**, never
`source.capabilities[key]` directly. The per-dataset override is useless to a reader that skips
it, and the two halves of a gate usually sit in different layers — `validate` refuses at edit
time and `evaluate` at run time — so a bypassing reader makes them disagree with nothing
type-checking the pair. Six readers did exactly that when the override was introduced; they all
go through the resolver now. `starters.ts` passes no dataset id and gets the source-level answer,
which is honest there: a starter is a node type and some params, and which dataset it resolves to
is not known until the node runs.

**The skeleton is coarse and the docstring says so.** One node per level-2 chunk is tens to a few
hundred for a whole neuron, where a traced skeleton is thousands. It is the right shape for
NBLAST, a 3D overview and cable length; it is not a morphometric reconstruction.

#### The earlier finding, kept because it explains the shape

**The skeleton service is the one thing CAVE publishes that Coda still cannot use, and the
blocker is the service rather than the format.** `skeleton_source` is a standard `neuroglancer_skeletons`
precomputed endpoint — its `/info` declares `radius` and `compartment`, which is exactly what
`SkeletonGeometry` wants, and it is CORS-open. But it is a **cache that generates on demand**,
and for `flywire_fafb_public` it is empty: 100 proofread root ids sampled from two places in the
table, across skeleton versions 0 through 4, came back `exists: false` for every one, and a
queued bulk generation had not landed after five minutes. So a fetch blocks on generation, per
neuron, against a node whose ceiling is 500. `capabilities.skeletons` is false and says so on
the flag; claiming it would make every Skeletons run hang instead of decline.

Two endpoint notes for whoever picks this up when the cache fills. `exists` answers as a **POST**
(`{skeleton_version, root_ids}`) — the GET form 502s — and it is what makes the whole thing
usable, because it turns "will this hang?" into a question you can ask first. And omitting the
skeleton version from a fetch URL routes to a generate rather than 404ing, which is why the first
probe here simply never returned.

**Synapses are the cheapest capability on this source and needed no new transport.** It is
`queryTable` with a root-id filter — the same call connectivity makes — over `synapses_nt_v1`.
Measured: 14,986 synapses for one neuron in 1.8 s.

- **`desired_resolution: [1, 1, 1]` is where the nanometres come from**, and it is passed
  explicitly rather than inherited. The table stores **4x4x40 nm voxels**, established by asking
  for both resolutions and watching the values divide by exactly 4, 4 and 40. The server's
  current default for this table happens to *be* nanometres, so omitting it looks perfectly fine
  and would put every synapse a factor out of the scene the day that default moved — with
  nothing failing, because the cloud is internally consistent either way. This is the CAVE-native
  answer to the rule `neuprint/units.ts` implements by scaling.
- **No polarity means two queries, not one.** CAVE has no either-end filter, and an `IN` on both
  columns of one query is an AND — which is the synapses a neuron makes onto *itself*.
- **The cloud is query-relative**, like `fetchConnectivity`: `neuronId` is the end that matched
  the filter and `partnerId` the other, so a Synapses node and a Connectivity Graph node on one neuron
  agree about which id is whose. `polarity` rides in the attribute table because a cloud fetched
  for both ends is two populations in one buffer.

**Meshes work, and cost requests rather than bytes.** A CAVE segmentation is `graphene://`, which
is not a bucket you can read by id: a root id is a dynamic agglomeration, so the fragment list has
to be asked for. `meshes.ts` asks the meshing API, then hands the fragments to
`src/data/precomputed` unchanged — `decodeDracoFragment` and `concatMeshes` needed no edit at all.

**A manifest failure is deliberately *not* swallowed**, which is the opposite of `readLegacyMesh`
beside it. That one reads a static bucket where a 404 genuinely means "this body has no mesh";
this calls an API whose 404 means the *table name* is wrong — the trap named just below. Letting
it throw is what lets `mapWithConcurrency` do its job: one bad neuron still becomes `undefined`
and costs the others nothing, but a systematically broken call fails every neuron and is
rethrown, rather than handing back an empty scene under a green node.

**The bucket mapping is `objectStoreUrl` in `precomputed/transport.ts`**, shared with
`neuprint/nglayers.ts`, which is where the second consumer put it. The first copy here mapped an
*unrecognised* scheme onto the GCS host — a confidently wrong URL rather than a refusal, and 404s
per fragment that read as neurons with no mesh. Not every CAVE datastack is on GCS.

Four things established live, each of which would otherwise be a plausible wrong picture:

- **`verify=True` is not optional.** Without it the manifest answers a single fragment named
  after the root id itself, which does not exist in the bucket — the unverified form is a promise
  about what *would* be meshed rather than a list of files. With it, one FlyWire neuron is **492
  fragments**.
- **The meshing API is keyed by the graphene *table*, not by the datastack**, and on FlyWire
  those are different strings: `flywire_public` against `flywire_fafb_public`. Taking the
  datastack name 404s, so the table is parsed out of the `segmentation_source` URL that named it.
- **Fragments decode straight to world nanometres.** Measured on a real one: x spans
  474,201–474,810. So none of `multires.ts`'s `fragmentOffset`/`fragmentTransform` machinery
  applies, and nothing scales anything — the decoder is called with an identity transform.
- **The bucket is CORS-open** (`storage.googleapis.com`, `access-control-allow-origin: *`), so
  this works from a static deploy with no proxy.

**What it costs, all measured on one neuron:** 492 requests, ~1.2 MB, **13.3 s**, and 1,276,736
triangles before decimation. There is no level of detail to trade against — a graphene manifest
lists supervoxel fragments at full resolution, where neuPrint's multi-resolution meshes answer in
a handful at a chosen LOD. Three constants follow from that, and each is a measurement rather
than a guess:

- **`MAX_MESH_NEURONS` is 20**, against the Skeletons node's shared 500. Enforced in the *source*
  rather than on the node, because it is a fact about graphene: the same Meshes node against
  neuPrint is fine at 500. (A per-source ceiling on the seam is the honest fix and is a later
  phase; the refusal names the number and the reason meanwhile.)
- **`FRAGMENT_CONCURRENCY` is 32.** The work is latency, not bytes — 492 fragments averaging
  2.4 kB — so this is the number that decides the wait: 18.9 s at 12, 13.3 s at 32, 11.3 s at 64.
  Past 32 the gain is small and it is a lot of parallel requests at one host. Measured from Node,
  where nothing caps connections, so a browser will do no better.
- **`MESH_DECIMATE_GRID` is 192**, through the same `decimateMesh` the ROI shells use. Much finer
  than their 32, because a neuron is a thin arbor inside a box the size of the brain and that
  grid would erase it: from 1,276,736 triangles, grid 96 gives 6,308, 192 gives 25,548, 256 gives
  44,091. A full set of 20 is then about half a million triangles, inside the 1.5M budget the
  Meshes node works to. It reduces memory and draw cost, not the wait — the requests are already
  paid by then.

**`fetchCoarseGeometry` stays unimplemented, and that is the right answer rather than a gap.**
There is no cheap representation to draw a thumbnail from, and the interface's own docstring says
an absent one beats quietly downloading full detail to fill a list. So Explore Dataset on a CAVE dataset
draws placeholders.

**The cross-check that ties it together** is in `live.test.ts`: a neuron's mesh has to enclose its
own presynaptic cloud. Neither is scaled by anything here — the fragments arrive in world
nanometres and the synapse query asks for them — so if either assumption were wrong the two boxes
would be a whole factor apart, and nothing else would fail, because each is internally consistent.
Measured: mesh 400,953–603,981 against synapses 402,596–602,328. Same shape as the neuPrint rule
that a mesh bbox must enclose its skeleton's.

**The morphology schema is narrowed rather than canonical.** `neuronId`, `type` and `points`, and
no `instance`, `status`, `size` or `cableLength` — a graphene mesh carries none of them, and a
column that arrives null on every row breaks every picker that believed it.

### Smaller decisions

- **`neuronId` is `str` on this source, and `type` is the only other renamed column.**
  `pt_root_id` → `neuronId` and the `cell_type` annotation kind → `type`; everything else keeps
  CAVE's own spelling (`super_class`, `cell_class`), the same call neuPrint's passthroughs make.
  What `str` costs is numeric sorting of ids and their appearance in numeric pickers, neither of
  which is a loss.
- **A failed discovery is asked for once, not once per keystroke.** `schemasFor` runs from
  edit-time inference and `runDiscovery` sets its schema only on success — so without a
  `discoveryRequested` flag every failure was retried on every graph mutation: one 52 kB request
  per keystroke, or one auth-failure popup per keystroke with no token. Exactly the rule
  `peekDatasets` already states for the listing beside it, and the reason neither flag is cleared
  on failure. Pressing Run still retries, because the index path calls `discover` regardless.
- **The index's two legs run together.** The annotation queries depend on nothing from the neuron
  table — only on the server and the discovered kinds — so awaiting it first cost a round trip
  plus 139,255 rows of transfer. Measured against live CAVE: 5.76 s to 4.04 s.
- **`typesOf` is memoised on the index's identity.** `fetchConnectivity` is called once per hop
  per direction, so `Hops: 3, Direction: both` built the same ~108,000-entry map six times in one
  Run, and Neuron Profile built two per page turn. A `WeakMap` on the `TableValue` is safe rather than
  merely likely to hit: `cacheGet` promotes a hit into `cache.ts`'s module map and hands back the
  same object. Same idiom as `searchIndexFor` and `statsFor`.
- **A dataset id is `datastack:materialization`** — `flywire_fafb_public:783` — following
  neuPrint's `family:version` convention exactly, which is what lets the existing version
  dropdown carry a materialization with **no new control**: `compareVersions` orders bare
  integers, so 783 sorts above 630 and a pinned 630 stays 630.
- **The index is deduplicated on the root id.** A CAVE neuron table is keyed by a *point* — a
  soma, a nucleus, a representative vertex — so one segment carrying two of them is two rows for
  one neuron, and a repeated row is double-counted by everything downstream that sums a weight.
- **Connectivity Graph types come from the index**, not from a second query. A connectivity table
  without them is readable by nothing, and by the time anyone runs Connectivity Graph the index is
  already in hand. A partner outside the annotated set has no type, which is honest rather than
  a gap.
- **There is no Base URL field**, unlike neuPrint's, and its absence is the finding: every CAVE
  service Coda calls answers a browser directly, **including on its 401s**, which is the part
  `reportAuthFailure` depends on. What the Connections tab does carry is a *global server*,
  which is a different thing — CAVE splits into one service that knows which datastacks exist
  and a per-datastack `local_server` that answers queries, and only the first is ever named.
- **A CAVE 401 opens the CAVE tab.** `reportAuthFailure` carries no source id, so the Connections
  panel used to declare one `authTab` per section, hardcoded to neuPrint. Harmless while neuPrint
  was the only credentialed backend and wrong the moment CAVE arrived; the *tab* is now named by
  whoever subscribes. The `section.authTab ? …` branch that chose whether to wrap a body was
  reading an auth detail to answer a layout question and is now an explicit `tabbed` flag.
- **Both exporters skip it, and the export is refused outright.** `dataset.flywire` is named in
  each `NO_EMITTER` with its reason — the notebooks are built on neuprint-python and neuprintr,
  and emitting neuPrint code against a dataset neuPrint has never heard of would produce a
  document that runs and answers nothing. The loops and `canExportNotebook` both read
  `DatasetFamily.notebook`; see the exporter section above for why that is one field rather than
  a test repeated at each site.

### What is not done

Skeletons, until the skeleton cache has anything in it (above). The annotation-source
abstraction that would let a FlyTable or a GitHub TSV join onto root ids, and the
materialization/annotation dropdowns and per-source morphology ceilings. Aedes needs the
annotation half before it is usable at all: its CAVE datastack publishes synapses and nuclei and
*no* annotations, so type, class and side live in FlyTable.

Not looked at in a browser yet — the module is headless and both suites are headless, so what has
not been seen is a FlyWire dataset node on a real canvas: the Explore Dataset widget over 139,255 neurons,
and twenty decimated meshes with their synapses in the 3D view. Same standing as the WebGL
viewers, and the mesh path is the half most worth looking at, since a decimation grid is a
judgement about a picture.

## CATMAID

`src/data/catmaid/`, and the third backend. The first target is Virtual Fly Brain's public FAFB
instance, `catmaid-fafb.virtualflybrain.org`. Nothing above `src/data` knows it exists; a CATMAID
dataset node is `dataset.fafb`, built from `DATASET_FAMILIES` exactly as the others are.

Everything below was probed live rather than recalled, and `live.test.ts` is that pass
institutionalised — skipped unless `CATMAID_LIVE=1`, because it is somebody's public server and
the suite runs on every commit.

### The access problem, which decides the module

**CORS is perfect and it does not help.** `Access-Control-Allow-Origin: *`, `X-Authorization` in
the allow-list, preflight 204 with a twenty-day max-age, and `can_browse: [1]` for the anonymous
user. Every `GET` Coda makes is answered cross-origin with no credential at all.

But **CATMAID's core query endpoints are POST-only** — checked against `/apis/`, not guessed:
`skeletons/connectivity`, `annotations/query-targets`, `skeleton/annotationlist`,
`skeleton/neuronnames`, `skeletons/review-status`. There is no GET alias for any of them. And an
anonymous POST is refused by Django's CSRF, whose two gates a browser cannot pass: `Referer` is a
[forbidden header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)
so `fetch` sends our own origin and the trusted-origins check rejects it, and the `csrftoken`
cookie is `SameSite=Lax` so it is never sent cross-site. Isolating them:

```
no Referer                     → CSRF Failed: Referer checking failed - no Referer
Origin only, no Referer        → the same         (so Origin is ignored: Django ≤3.2)
Origin + Referer, both foreign → does not match any trusted origins
Origin foreign, Referer=server → CSRF Failed: CSRF cookie not set     (two gates, sequential)
HTTP Basic, bogus              → still a CSRF error   (BasicAuthentication is not enabled)
Authorization: Token <bogus>   → Invalid token        ← the way through
```

**A token bypasses CSRF entirely**, because DRF's token class runs before its session class and
never reaches `enforce_csrf` — which is why a bogus token is answered `Invalid token` rather than
`CSRF Failed`. That is the whole of why a token matters here, and it is *not* what a token means
on the other two backends: it does not unlock private data, it is the only way a page can ask a
question whose answer is already public.

**And on this instance a token is not obtainable** — `/accounts/register` is 404. So the usual
answer (require one, like neuPrint and CAVE) would make the named target unusable, and the module
falls back to a same-origin `/cm/` relay that performs the handshake server-side. That works under
`pnpm dev` and 404s on a static deploy, exactly as `/st/` does for FlyTable.
`docs/catmaid_vfb.md` is the write-up and the upstream ask — which is **CATMAID's** rather than
VFB's, since every instance with anonymous browse has the same wall for the same reason.

**So the route is chosen rather than probed**, the deliberate departure from `neuprint/client.ts`
and `seaTable.ts`. Those cannot tell a CORS refusal from a dead host, so they try and remember.
Here the governing fact is known in advance: an anonymous POST *cannot* succeed direct, so
issuing one to find out spends a request confirming what the protocol already says. `routeMemory`
still earns its place for the case it was built for — a CATMAID sending no CORS headers at all,
which VFB's does not but a lab instance well might — and that case is still a thrown fetch.

**Verified from a real browser**, which is the only thing that could: direct `GET /projects/`
answers 200, the same POST direct answers 403, and through the relay it answers 200 with a real
neuron name. The browser produces a *third* CSRF variant — `Referer is insecure while host is
secure`, because the dev origin is `http` — which becomes the trusted-origins form on a published
`https` deploy. It does not change the outcome and it does change the message, which is worth
knowing before debugging one against the other.

### Credentials are a list, because CATMAID is software rather than a service

`Connections ▸ Data sources ▸ CATMAID` holds **rows**, not a token. Every other tab there holds
one, because neuPrint has a canonical deployment and CAVE has a global service that lists
datastacks. CATMAID has neither: VFB, an LMB instance, a lab server are unrelated installations
with unrelated accounts, and a token is per user **and** per instance. One field would not merely
be awkward — it would send whichever was saved last to all of them.

**`server` is a host pattern**, so one row covers a deployment answering on several hostnames:
`*.virtualflybrain.org` rather than a row per subdomain. `hostPattern` normalises whatever was
typed — a pasted address bar, a bare host, a port, a subpath — down to the host, because a
credential is a property of a host and the rest cannot vary independently of it.

Three rules in the matching, and the first is the one that would leak a token:

- **`*` requires the literal dot.** `*.virtualflybrain.org` covers `a.b.virtualflybrain.org` and
  does **not** cover `virtualflybrain.org`, `notvirtualflybrain.org`, or
  `virtualflybrain.org.evil.com`.
- **A pattern with no literal characters matches nothing.** `*` is an easy thing to type and would
  otherwise send a token to whatever host a graph happened to name.
- **Most specific wins**, exact over wildcard and longer wildcard over shorter — so a `*.lab.org`
  row plus one exact row for the machine inside it that needs a different account behaves the way
  it reads, rather than depending on list order.

**Two credentials per row, and they are not alternatives.** `token` goes on `X-Authorization`,
which is CATMAID's own header; `httpUser`/`httpPassword` go on `Authorization: Basic`, which is
the *web server's*. They coexist on one request rather than competing, and CATMAID's middleware
says why in as many words: it uses a non-standard header "to prevent conflicts with, e.g., HTTP
server basic authentication". An instance behind nginx auth needs both.

**Only the token bypasses CSRF.** Basic auth satisfies whatever sits in front and leaves Django
exactly where it was, so `routesFor`'s `hasToken` is specifically the CATMAID token — conflating
them would send an anonymous POST direct on any instance that happens to sit behind nginx auth,
and it would be refused every time. A test pins it.

The password is in `localStorage` in the clear, like every credential here, and the section's
privacy note now says so — the note also stopped claiming that *every* data-source request travels
through a same-origin relay, which stopped being true when CAVE arrived and is wronger with
CATMAID beside it.

**One pre-existing test was found by this and is worth knowing about**: `sources.test.tsx` asserted
no AI tab appears among the data sources with `/AI|assistant|Anthropic/i`, and an unanchored `AI`
matches "c**AT**M**AI**D". It had been passing for the right reason only by the accident that no
tab name contained those two letters. It is `\bAI\b` now.

### `type` is derived, because CATMAID has no such field

neuPrint carries cell typing as properties on the neuron and CAVE reads it from an annotation
table. CATMAID has neither: a neuron has a free-text **name** and a bag of **annotations**, with
nothing saying which of them mean what.

What makes it tractable is that **annotations can themselves be annotated**. Measured across all
5,601 skeletons of public FAFB:

```
meta-annotation      annotations   neurons   max per neuron
neuron name                 5601      5601                1
Cell type                    329      4244                1
Published                     26      5601                4
export: tags                  27      5601                4
publication_link: <doi>          1    1–1507              1     (×22, one per paper)
```

So the mechanism is **a meta-annotation names a field and the annotations carrying it are its
values**, discovered by asking rather than hardcoded — the lesson CAVE taught. `neuron name`
supplies `type` and `instance`, split at the `#`: `Uniglomerular mALT VA6 adPN#R1` yields both,
and `DNp32_R` is its own type. 960 distinct types on FAFB.

Three things about it are load-bearing:

- **The default is a convention, not an assumption.** `neuron name` is how the labs that traced
  FAFB annotate; CATMAID enforces nothing. So it is `DEFAULT_TYPE_META` and an instance without it
  degrades to a neuron table with names and no types rather than failing.
- **The instance keeps the whole label, so the `#` split is lossless.** That matters because the
  convention puts real distinctions on the right of it: `KC#12-a'b'` gives type `KC`, and the a'b'
  subtype survives only in `instance`. Coda is not the place to decide that `a'b'` is a type and
  `12` is not.
- **Everything below `Cell type` gets no column of its own.** `export: tags` and `Published` carry
  the same information by different routes, and `publication_link: <doi>` is the `key: value`
  annotation idiom — 22 of them, each naming one paper, none a field. A column per meta-annotation
  would put forty-odd in every picker downstream, most describing a *paper* rather than a neuron.
  They land in one `annotations` cell joined with `JOIN_SEPARATOR`, which is exactly the shape
  Explore Dataset's `Additional tags` control already splits back into chips.

**`JOIN_SEPARATOR` moved to `src/core/values.ts` for this**, from `tableOps.ts` where it began
beside the Group By aggregation that writes it. That was right while a node was the only thing
that could produce one; a *source* now does, and `src/data` may not import `src/nodes`
(invariant 1). Same reasoning and same destination as `ID_COLUMN_NAME`, and deliberately no
re-export from where it was.

**`neuronId` is the skeleton id, never the neuron id**, and the two genuinely differ —
`{'id': 27296, 'skeleton_ids': [27295]}`. Every endpoint takes the skeleton, so a table keyed on
the neuron would join to nothing with each id off by a value or two, which is the kind of wrong
that looks right.

### The numbers, which cut both ways

**The index is the cheapest here.** All 5,601 skeletons with names, annotations, node counts and
cable lengths: **3.2 MB and about 1.4 s** — the id list, then the annotation graph's three chunks
and the summary call all running together, which took it from 2.9 s, against neuPrint's 6.9 MB and CAVE's 139,255 rows. The
public FAFB instance is a curated published subset rather than a whole-brain segmentation, which
is what makes Explore Dataset over the whole of it immediate. And since `annotations/query-targets`
matches names by **substring** rather than regex — `^LC[0-9]+` matches nothing, `LC` matches 129 —
there is no server-side search worth pushing down, so filtering is local and `neuronFilter.ts`
gets its third consumer.

**Skeletons are the most expensive here.** 0.9–1.3 MB each, and **the server does not gzip** —
verified, byte-identical with and without `Accept-Encoding`. One antennal-lobe PN is 16,840 nodes
and a large descending neuron 64,385, where a CAVE L2 skeleton is ~150. `MAX_CATMAID_SKELETONS` is
200 at `SKELETON_CONCURRENCY` 8, which is a *transfer* ceiling rather than a drawing one and the
refusal says so. It moves the day the deployment turns on gzip.

**Coordinates are already nanometres**, and volumes share the frame with skeletons — verified by
bbox cross-check, and again in `live.test.ts` by the rule CAVE's mesh-encloses-synapses assertion
follows: a synapse cloud must sit inside its own skeleton's box, because neither is scaled by
anything here and a mistake in either would put the two a whole factor apart while each stayed
internally consistent. So nothing does what `neuprint/units.ts` has to.

**+16.25 kB raw / +5.03 kB gzipped on the main chunk**, measured against a build of the same tree
with the feature absent — comparable to CAVE's +16.4 / +5.2.

### Traps, each verified rather than assumed

- **The connectivity weight is the sum of a five-element confidence array, not its last element.**
  Almost everything sits in the last bucket, so taking that alone looks right and undercounts:
  3,039 against a true 3,070 on skeleton 16's outgoing partners, cross-checked against 3,069
  ground-truth links from the connector table. A one-percent error that no assertion on shape
  would catch.
- **`skeleton_ids[]` — the form `/apis/` documents — silently returns only the last id.** Not an
  error, a short answer. Confirmed on `skeletons/summary` and `skeletons/cable-length` over both
  verbs, so it is the view rather than the method. The indexed `skeleton_ids[0]=…&[1]=…` form works
  everywhere and the plain repeated form 400s on `review-status`, so `encodeParams` emits indexed
  and nothing may emit brackets.
- **CATMAID names a parent by node id, and a skeleton's nodes arrive in no particular order.** The
  tree is rebuilt through an id→index map; emitting ids would satisfy the type and break every
  consumer that walks the array once, the SWC writer included.
- **A radius of −1 means unset**, and a negative radius drawn as a tube is a spike.
- **`/volumes/` answers `{columns, data}`**, a column table rather than records — the obvious
  `VolumeRow[]` reading parses without error and yields `undefined` for every field.
- **The volume mesh is X3D**, `<IndexedTriangleSet>`, parsed by hand rather than through
  `DOMParser` so this layer stays usable without a DOM. An out-of-range index is refused rather
  than passed on, because it draws as one enormous spike across the scene rather than as an error.
- **A source that publishes no statuses must also *ignore* the parameter.** `DatasetInfo.statuses`
  is empty because CATMAID has none — but a node's stored `Traced` default survives into the
  request regardless, and filtering on it drops every row for a value nobody chose. That failure
  is live on CAVE today; `findNeurons` here ignores `statuses` outright and a test pins it.
- **A filter somebody *chose* is refused instead, and the difference is the default.** `In ROI` and
  `Min size` reach a source only when they were set, so ignoring one answers a different question
  than the card says — see `refuseUnfilterable` below. CATMAID is the case that makes it visible:
  `volumeList` fills `DatasetInfo.rois` with eighty real neuropils so the ROI Viewer can draw
  them, which also populates Find Neurons' region picker, and `findNeurons` never read `req.roi` at
  all. A populated dropdown that narrows nothing, whose result is too *large* and looks correct.
- **Cable length is measured, not fetched.** `core/values.ts`' `cableLength` is shared with the
  neuPrint decoder and the mock so the three cannot disagree, and CATMAID's points are already
  nanometres — so the Skeletons node computes it from the tree in hand rather than spending a
  round trip on a shared community server. Checked against the server's own figure on skeleton
  16: 4003103.2328612693 against 4003103.23286127. The *index* still fetches it, because there is
  no geometry there to measure.
- **`nodes` and `cableLength` are filled rather than declared-and-null.** One POST, 1.77 MB, 0.72 s
  for all 5,601 — which roughly doubles a download cached for a month. The alternative was the
  thing `CATMAID_NEURON_SCHEMA` refuses to do for `status`: an always-empty column is worse than an
  absent one, because every picker downstream offers it.

### What it cannot do, and what is not done

`paths` (no aggregated-hop endpoint), `roiSummary` and `roiCounts` (no completeness or
per-neuron-per-region table), `rawQuery`, `viewerScene`, and **`meshes`** — CATMAID stores
skeletons rather than a segmentation, so its `volumes` are neuropil shells and are `roiMeshes`,
which is a different question. Each declines at edit time rather than failing at run time.

`fetchSynapses` carries `connectorId` but **no `partnerId`**: the partner on the far side of a
connector belongs to a different skeleton, so naming it means a second POST per connector set, and
a cloud drawn in 3D or counted by region needs none of it.

Neither exporter emits it — both `NO_EMITTER` tables name `dataset.fafb`. pymaid is the obvious
Python route and the natverse's `catmaid` the R one, and both map cleanly, but no emitter has been
written so both languages refuse rather than producing a document of TODOs.

**Labels are derived once, into a `Map` on `LabelIndex`, and the raw response dropped.** Four call
sites wanted a neuron's type and one of them wanted it once per synapse *link* — tens of thousands
of times for a densely traced neuron, each allocating a `Set` and joining a string to read one
field. The same change lets the response be collected rather than held beside the neuron table
built from it, and it is what makes `typeLookup`'s old "memoised per project" docstring true by
deleting the function.

**Not looked at on a real canvas**: the dataset node's tint and tile pip, Explore Dataset over 5,601
neurons, and a hundred FAFB skeletons in the 3D view. The module and both suites are headless;
what *was* driven in a browser is the relay and the CORS behaviour, above.

## Precomputed meshes

`src/data/precomputed/` reads neuroglancer precomputed meshes. It knows nothing about
neuPrint — FlyWire and CAVE are the obvious next consumers — and `src/data/neuprint/nglayers.ts`
is the only thing that maps a dataset to a bucket.

**Meshes need no token and usually no proxy.** They come from public object stores, not from
neuPrintHTTP. `neuroglancer-janelia-flyem-hemibrain`, `manc-seg-v1p2` and `flyem-optic-lobe`
all send `Access-Control-Allow-Origin: *`, so they are fetched directly and work in a static
deploy even where the Cypher API cannot reach. `flyem-male-cns` sends no CORS headers at all,
so `transport.ts` retries it through the `/gcs` proxy and remembers which route worked. A
browser reports a CORS refusal as an opaque `TypeError`, so trying is the only way to find out —
which is why the answer is cached rather than probed each time.

**That answer is cached per _bucket_, and it used to be per host.** All four of those buckets are
`storage.googleapis.com`, but CORS is configured per bucket — so a host key meant one male-CNS
mesh recorded `storage.googleapis.com → proxy`, **persisted it to localStorage**, and from then
on routed every hemibrain, MANC and optic-lobe read through the proxy without ever retrying
direct. In later sessions too, for somebody who never opened male-CNS again.

Measured on a 300-body hemibrain fetch: **3.1 s direct, 30.5 s through the dev proxy**. The
requests are all issued either way — the browser reports 100 in flight — they just queue behind a
single-origin HTTP/1.1 hop. It was invisible while the concurrency was 6, because then both
routes were slow; raising it to 100 is what made the difference legible. Entries written by the
host-keyed version are dropped on load rather than migrated: a bare host stood for whichever
bucket happened to be read first, so it cannot be mapped onto one, and keeping it would leave
every affected profile poisoned across the upgrade.

**Find the source through `/api/npexplorer/nglayers/<dataset>.json`, not `Meta`.** The Meta
node is unreliable (hemibrain has `neuroglancerMeta`, manc:v1.2.3 has nothing); the nglayers
endpoint always names the segmentation. Ignore the `*_property` sidecars, of which male-CNS
has eight.

**Preference order is multi-res layer → segmentation volume → any other mesh-shaped layer,**
and the two ends pull against each other:

- optic-lobe's volume declares `mesh: single-res-meshes` (flat, full resolution) while a
  `multi-res-meshes` **sibling** exists and is what its state links. So a dedicated multi-res
  layer must beat the volume.
- male-CNS's state advertises `meshes-malecns/single-res-meshes` while its volume declares
  `mesh: multi-res-meshes`. So a _legacy_ dedicated layer must **not** beat the volume.

Preferring any hinted layer over the volume — which this originally did — got male-CNS wrong
with nothing failing: meshes still arrived, just at full resolution and several megabytes each.

**Two formats, detected from the mesh dir's `info`.** All four datasets in use publish sharded
`neuroglancer_multilod_draco` with four levels; the legacy `neuroglancer_legacy_mesh` path
exists because optic-lobe and male-CNS also publish single-resolution directories, and a
misresolution lands on one.

Four things about the sharded format that are easy to get wrong, all of them found the hard
way and all pinned by tests:

1. **Shard math.** `shifted = key >> preshift_bits`, then murmurhash3_x86_128 of its 8
   little-endian bytes, taking `(h2 << 32) | h1`; minishard is the low `minishard_bits`, shard
   the next `shard_bits`. Body 1158187240 must land in shard `0x151`, minishard 103.
2. **Fragment positions are three arrays, not interleaved triples** — every x, then every y,
   then every z. The wrong reading still yields valid coordinates and is _invisible at the
   coarsest level_, where hemibrain's `0,0,0,0,0,1,0,1,1` decodes identically either way. It
   showed up one level down as fragments scattered across the volume.
3. **`vertexOffsets` are not zero** (hemibrain: 1 at LOD 1, 4 at LOD 3). Dropping them shifts
   geometry by 16–64 nm, which reads as rounding.
4. **Fragment data sits immediately _before_ the manifest** in the shard. There is no pointer
   to it; `dataStart = manifestOffset - Σ every fragment size`.

**Everything is nanometres.** neuPrint returns skeletons and synapses in dataset voxels
(8 nm), precomputed meshes come out in nm — drawn together unconverted, the mesh sits 8× away
from the skeleton it should wrap. `neuprint/units.ts` scales the neuPrint side using
`Meta.voxelSize`, so `cableLength` is in nm and skeleton coordinates no longer match the raw
API response. That is the trade, and it is checked: a mesh bbox must enclose its skeleton's.

**`Max neurons` bounds requests; `Detail` bounds weight; `maxBytesPerBody` bounds one neuron.**
Three different guard rails. Conflating the first two is how the mesh limit ended up at 25 — a
number from before levels of detail existed, which refused thirty neurons that would have
arrived as a few hundred kilobytes. All three morphology nodes now share the `MAX_NEURONS`
ceiling.

The third exists for thumbnails, and it is needed because **even the coarsest level has a
2000× spread**. Sampled across hemibrain, the coarsest level is 264 bytes at the median, 14 kB
at p90 and 508 kB at the maximum (male-CNS: 7.3 kB / 23 kB / 169 kB). A budget averaged over a
batch cannot express "skip this one body"; the manifest carries the size, so the decision costs
no download.

**`THUMBNAIL_MAX_BYTES` is a guard rail, not a quality filter,** and the distinction is the
whole point of the number. It is 2 MB, above the largest coarsest level in any dataset here, so
every real neuron gets a thumbnail; 2 MB is what an entire hemibrain neuron costs at full
resolution (2 MB / 280 kB / 48 kB / 11 kB), so a body whose _coarsest_ level reaches it is an
unsplit blob rather than a large neuron. It was 128 kB, pitched just above p90 to keep a page
cheap — which blanked the giant fibres and big tracts, i.e. both the heaviest coarse meshes and
the bodies someone browsing is most likely to want. A page is priced by the median, not by the
ceiling, so raising it costs the typical page nothing.

**100 bodies in flight, which is neuroglancer's own number** (`data_management_context.ts`:
`download: { defaultItemLimit: 100 }`). It was 6, which had never been measured and cost about an
order of magnitude. Measured in a real browser against the hemibrain bucket with the HTTP cache
disabled, ids enumerated out of the bucket's own minishard indices so they spread across shard
files, best of two interleaved runs each:

| in flight | 96 bodies | of which manifests | 32 heavy bodies |
| --- | --- | --- | --- |
| 6 | 10,463 ms | 7,973 ms | 3,094 ms |
| 16 | 3,908 ms | 3,069 ms | — |
| 32 | 1,944 ms | 1,589 ms | 697 ms |
| 64 | 1,369 ms | 1,134 ms | 685 ms |
| 100 | 819 ms | 718 ms | 692 ms |

**The gain continues while the limit is under the batch size** — 32 bodies plateaus at 32, where
there is nothing left to overlap, while 96 is still improving at 100. So this is a latency budget,
not a bandwidth one, and the number to compare it against is how many neurons a scene holds.

**The manifest sweep is where the time goes**: ~87% of the wall clock at every setting. One small
request per body, and nothing can start until the last one lands, because `chooseLod` sums across
the batch. That is the barrier, and it is why manifests get a cache entry of their own — being
level-independent, they survive a change of detail that invalidates every fragment.

One measurement, one machine, one network; the shape is what matters rather than the milliseconds.
What it spends is the HTTP/2 stream budget on `storage.googleapis.com`, which many peers default to
~100 and which CAVE's fragment reads and Explore's thumbnails also draw on — overflow queues in
the browser rather than failing, and graph nodes execute one at a time.

**The other concurrency numbers are deliberately not this one.** `ROI_MESH_CONCURRENCY` is 4 and
neuPrint skeletons are 6 because those hit **neuPrintHTTP**, a shared production server, not a
bucket; CATMAID is 8 against somebody's tracing instance; CAVE's fragment budget is a measured 32
shared across neurons in flight. Only the object-store path gets the bucket number.

**Detail is chosen, not fixed.** `chooseLod` picks the finest level fitting a triangle budget
across the whole batch, using the manifest's compressed byte sizes as the pre-decode proxy at
~1.7 bytes/triangle. That ratio is dataset-dependent (optic-lobe overshot 2×), so the result
reports the triangles actually decoded and the viewer caption shows `mesh LOD n/m`.

**The Draco decoder must stay out of the main chunk.** `draco3d/draco_decoder_nodejs.js` is
misleadingly named — it is a universal Emscripten build whose `require("fs")` is behind a
Node-only guard — and the wasm is handed over explicitly via a `?url` import so Emscripten
never guesses at a path the bundler has hashed. Do not import three's `DRACOLoader` here:
it would pull three.js into `src/data`, which has to stay usable by a non-browser consumer.
