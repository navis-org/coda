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
a shared production Neo4j, so an unbounded `MATCH (n:Neuron)` on male-cns is a real hazard. A
neuPrint `:Neuron` is any body above a synapse threshold or carrying a name, not a proofread one —
hemibrain has 186,061 of them — which is what the **population checkboxes** on the dataset node
narrow. `populationCypher` compiles them to one parenthesised `OR` group ANDed onto the rest of
the `WHERE`, and an explicit `status` filter row removes the `traced` disjunct from it. See
[datasets.md](datasets.md#the-population-checkboxes-and-the-default-that-was-removed-once-already).
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

**`preparedRows` is the third thing in it, and it is what a local source runs a query with.** A
`FindNeuronsRequest` carries `rows` — `{field, operator, value}`, ANDed — and this compiles them
against the neuron index that will answer them, through `resolveRows` and `prepareFieldTerms`.
Both of those are shared with Explore's search box and the Table viewer's header cells, which is
the strongest form of the rule above: not two implementations that agree, one function.

**An unfilterable row throws rather than matching nothing**, and that is the decision worth
defending. `prepareFieldTerms` marks a column the table does not have as `unknown`, which matches
no row — right for the Table viewer, where an emptied table reads as a node that has broken and
can be seen. Here it would answer a *query* with nothing at all, indistinguishable from a dataset
that genuinely holds no such neurons.

That failure is what the row model retired, and it is worth recording what it replaced.
`refuseUnfilterable` used to take `minSize` and `roi` as named fields of the request, because the
card offered **Min size** and **In ROI** whatever was wired to it. `CaveSource` read
`index.data.size` — a column no CAVE index has — through `Number(undefined ?? 0)`, so any non-zero
**Min size** compared 0 against the threshold and dropped every row: a node reporting "0 neurons"
for a datastack full of them. `CatmaidSource` never read `req.roi` at all while publishing eighty
regions to pick from, so the answer came back too *large*. An empty result and an unnarrowed one
both look like answers, which is what makes a refusal the only one of the three that can be acted
on; it names the field as the card labels it.

Two of those three are now unreachable rather than caught. A row names a field of the dataset's
**own** neuron schema, so `size` on a CAVE datastack is not a filter that gets refused — it is a
field that was never in the dropdown, and the same goes for `status` on CATMAID. What is left is a
graph saved against one backend and repointed at another, which `resolveRows` reports on the card
before anything runs and `preparedRows` refuses at the seam if it gets that far.

**`refuseUnfilterableRoi` is all that survives, and a region is why.** It cannot become a row
because it is not a column in any schema: in neuPrint a neuron carries one boolean property per
ROI it innervates. So it stays a named axis, and the card gates it on `capabilities.roiFilter` —
whether the source can *answer* one — rather than on `DatasetInfo.rois` being non-empty. Those two
came apart on CATMAID and that is exactly the flag's reason for existing.

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

### The row cap is a per-deployment number, and counting is the only tell

The materialization engine truncates a result and says so in a `warning` header — which its
`Access-Control-Expose-Headers` does **not** list, so a browser cannot read it. Truncation is
therefore detected by counting, and refused rather than returned: a short index is not a visible
failure, it is a dataset that silently lacks neurons.

**What it counts *against* is the part that was wrong for a year.** The number is
`QUERY_LIMIT_SIZE`, the engine's own config, defaulting to 200,000 and set per deployment — not
a property of CAVE. Measured the same day with the same request shape:

```text
deployment              table                              rows back    warning header
prod.flywire-daf.com    hierarchical_neuron_annotations      500,000    201 - "Limited query to 500000 rows
cave.fanc-fly.com       codex_annotations                  1,994,371    (none)
```

So `CAVE_MAX_ROWS = 500_000` describes FlyWire's deployment and nothing else, and comparing row
counts against it did both halves of the wrong thing. It was written `rows >= CAVE_MAX_ROWS`,
which refused BANC's **complete** two-million-row `codex_annotations` for being *larger* than a
cap that server does not apply — reporting it to the user as CAVE having truncated the table. And
even spelled `===`, as this file and `limits.md` both described it, it waves through a genuinely
truncated read on any deployment configured below 500,000.

**The honest test is the server's own `COUNT` of the same query.** `countTable` posts the read's
filters to the single-table query endpoint under `?count=true`, and `refuseIfCapped` refuses when
fewer rows came back than the count. `queryTableCounted` issues the two **concurrently**, so the
check costs no wall clock: on every call site the count is the faster by an order of magnitude.
A count that fails is not a read that fails — it degrades to `undefined` and the old
exactly-the-cap tell, which is no worse than what it replaced.

**Only the filters go into a count body.** Columns and resolutions describe a shape a count does
not have, and a `limit` would make the count agree with a deliberately short read by
construction.

**Cheap only where the query is**, which is why nothing counts a view and every call site is
either filtered or reading a table the browser was going to download anyway. Measured:

```text
count query                                                   time
synapses_nt_v1 filtered to one root id                        0.6 s
codex_annotations, whole table (1,994,371 rows)               0.7 s
synapses_nt_v1, unfiltered (~130M rows)                     > 180 s   (times out)
valid_connection_v2 — an aggregating view                   > 300 s   (times out)
```

That last pair is the same finding `tables.ts` records for `limit` not pushing down into an
aggregating view, arrived at from the other direction.

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

**That was half the picture, and the other half turned up while writing `CAVE table info`: there
are two count endpoints and the one above is the wrong one to ask.** The materialization engine's
`materialize/api/v3/…/version/{v}/table/{t}/count` counts the frozen snapshot; the *annotation*
service keeps its own at `annotation/api/v2/aligned_volume/{av}/table/{t}/count`, and that one is
version-independent and counts the table as it stands. Probed against v783:

```text
table                            materialize   annotation   what a query yields
nuclei_v1                            143,140      143,140
proofread_neurons                    127,978      139,540    139,255 distinct root ids
hierarchical_neuron_annotations      377,699      512,957    500,000 — truncated
```

So the tell above was not "this endpoint counts something else" but "this is not the endpoint
that answers that question" — and *neither* of these two is either. A `count=true` query is a
third number, and the only one that predicts truncation: 512,957 and 139,255 for the two rows
above. That is what `refuseIfCapped` checks against, and reaching for the cheap precomputed
`materializedCount` instead would undercount every table and wave a truncated read straight
through.
caveclient spells the difference as two methods on two sub-clients — `materialize.
get_annotation_count` and `annotation.get_annotation_count` — which is the clearest statement of
it anyone has written down. Neither is wrong; showing one of them without saying which it is, is.
`tables.ts` reports both side by side and the card labels them, and the notebook exporter does the
same. Note this changes nothing about `neuronCount`: the annotation count is still not the count
of *neurons*, since `proofread_neurons` has 139,540 rows and 139,255 distinct root ids.

### A datastack does not describe itself

neuPrint's graph has a `:Neuron` label with properties on it. A CAVE datastack is a bag of
annotation tables with no privileged one — `flywire_fafb_public` publishes six, of which
`proofread_neurons` is the neuron set, `hierarchical_neuron_annotations` is the cell typing, and
`valid_connection_v2` is a **view** rather than a table. Nothing in the metadata says so; the
schema types (`representative_point`, `cell_type_reference`) describe the shape of a row, not
the role of the table.

### A reference table has no root id in it anywhere

`cell_type_reference` is the second table shape, and the difference is not cosmetic: such a table
annotates *another table* rather than the segmentation. Its rows carry `target_id` into the
target's `id`, and the root id lives over there. BANC's `codex_annotations` references
`cell_representative_point`; FlyWire's `hierarchical_neuron_annotations` references
`proofread_neurons`.

Reading one without the join is not merely incomplete — it is a **500**, because `select_columns`
is validated against the table's own model:

```text
POST .../table/codex_annotations/query   {"select_columns": ["pt_root_id", "cell_type"]}
  →  500  pt_root_id not in model or models for codex_annotations
```

So a reference read goes to the **join** endpoint, which is the same v3 path with no table name
in it and `tables` in the body. `CaveReference` on a `CaveQuery` is what switches it, and the
endpoint differs in three ways that are each a silent wrong answer rather than an error:

1. It takes `select_column_map` and **only** the map, where the single-table endpoint takes
   `select_columns` and only the list — each rejects the other outright. And naming one side of
   the map **drops the other side's columns entirely** rather than defaulting them, so a caller
   that cannot name its own columns has to ask for the whole join instead. That is why a wide
   read of a reference table samples the table's own column set with a `limit: 1` query first;
   without it, `id_ref`, `created_ref` and `pt_position_x` are offered to somebody as annotations.
2. `suffix_map` decides what collides, and a name only one side has arrives **bare** —
   `pt_root_id`, not `pt_root_id_ref` — which is what lets the same shaper read the row either
   way.
3. **`count=true` is not honoured on it**: it answers rows. `countTable` therefore counts the
   *base* table, which is exact because the join is many-to-one on a foreign key the annotation
   service maintains. Checked rather than assumed — all five BANC kinds probed returned join rows
   equal to the base count to the row, and `live.test.ts` is what would notice if that changed.

`caveclient` does the same thing under the name `merge_reference`, reading `reference_table` off
the metadata and switching to the join. That is why a table Coda refused answers fine in Python,
and the discrepancy is worth recognising: it is not a permissions or version difference.

`CaveSource` still writes its own join for the built-in path, and that is not duplication — but
not for the reason it first looks. The two do **not** join different tables: `flywire_fafb_public`
is the only spec with an `annotations` block, and there its `neurons.table` and
`hierarchical_neuron_annotations`' `reference_table` are the same table, `proofread_neurons`. What
keeps them apart is cost. `buildIndex` has already read the neuron rows for the population list,
so its `rootById` join is a Map over rows it is holding, where routing it through `CaveReference`
would buy a server-side join on each per-kind query to learn what is already in hand.

### A datastack still does not describe itself

So `spec.ts` holds one entry per datastack, static for the reason `datasetFamilies.ts` is
static, and it is a deliberately faithful port of the idea `connecto` arrived at in Python for
the same problem. **A datastack with no entry is not offered** — the info service lists thirteen
and most would fail on the first Run, and a dataset that appears in the picker and then fails is
worse than one that is absent.

**And the four bindings are shown to the user**, appended to the publisher's blurb on the
Description card as "Coda reads this datastack as:" — because a decision taken in this file is
otherwise visible nowhere in the app, and "why are there no cell types on BANC?" had no answer.
An unbound role gets a line saying so rather than being left out. See
[datasets.md](datasets.md#attribution-the-description-companion).

**`species` is on the spec too**, and used to be `'Drosophila melanogaster'` hardcoded in
`datasetInfoFor` — which was true while FlyWire was the only entry and made Dataset Summary
describe `minnie65_public`'s mouse visual cortex as a fly.

**Connectivity prefers that view and falls back to counting synapses**, which is `connecto`'s
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
**`refuseIfCapped` is the real bound**: a hub neuron or a large seed set can reach whatever the
deployment truncates at, where the view path is one row per pair and cannot.

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
- **`table/{t}/metadata` is v3 where `tables` is v2, and the two answer different names.** v2
  reports `table_name: "nuclei_v1__fly_v31"` — the materialized table — where v3 reports
  `nuclei_v1`, which is the name `tables` listed and the name a query takes. A card built from
  the v2 spelling shows somebody a name they cannot type back in.
- **`limit` works on the query endpoint, and does not push down into an aggregating view.** A
  one-row query against `proofread_neurons_view` answered in **0.77 s**; the same against
  `nt_summary_view` and `valid_connection_v2` had not answered after **45 s**. Those two are
  `GROUP BY` roll-ups, so the server builds the whole result and then takes one row off it —
  the same fact as "CAVE has no `GROUP BY` for us", seen from the other side.
- **A view has no metadata endpoint and no count.** `/table/{v}/metadata` 404s,
  `/table/{v}/count` answers a **500** wrapping a 404, and `/views/{v}/count` is not a route.
  The `views` listing is a *map* rather than a list of names, so a view's description arrives
  with the listing and costs nothing extra — which is the asymmetry `tables.ts` is built around.

### Discovery: what is in a datastack

`tables.ts`, and the two nodes over it — `List CAVE tables` and `CAVE table info`. It exists
because of the section above: a datastack does not describe itself, and until these the only way
to find out which table was the cell typing was to already know. `CAVE table`'s field has
`nuclei_v1` as its placeholder and answers a 404 at Run for anything else.

Two things in it are decisions rather than plumbing.

**The facts and the column sample are two memos, not one record.** The card peeks the facts —
metadata and the two counts, never a query — so an edit-time look at a view cannot start a request
that runs for minutes at a shared production server. Only `evaluate` samples columns, where there
is a `ctx.signal` to cancel with and a `ctx.warn` naming the wait before it starts. A rail warns
and does not refuse ([limits.md](limits.md)), and time is never a refusal.

**The facts peek is gated on the listing already knowing the name.** Without that gate, typing
`nuclei_v1` a character at a time would fire a metadata read and two counts for `n`, `nu`, `nuc`
and so on — nine sets of 404s for one table anybody wanted. The listing is one or two small
requests per datastack and everything else hangs off it.

### What it costs, and what it declines

**+16.4 kB raw / +5.2 kB gzipped on the main chunk** (1,010.02 → 1,026.39 kB), measured against
a build of the same tree with the feature stashed out. Far under this codebase's bar for a lazy
boundary.

`SourceCapabilities` does the rest, and every `false` is a node that declines at edit time rather
than failing at run time: no `paths` (it needs a hop aggregated server-side, which CAVE has no
endpoint for), no `rawQuery`, and none of the three ROI
flags — FlyWire's neuropil assignments are a reference table on *synapses*, so there is no
per-region completeness table to read, and a per-neuron breakdown would mean reading a neuron's
synapses and grouping them, which is the work the connection roll-up exists to avoid.
`neuronIndex`, `meshes`, `synapses` and `viewerScene` are true for the source; `skeletons` is
answered **per dataset** through `capabilitiesFor`, because a datastack has one only if it has a
level-2 cache or a flat bucket beside it — see **Skeletons** below.

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
statuses** — and since a filter row names a field of the datastack's own neuron schema, and the
region picker reads `capabilities.roiFilter`, neither is offered on the card at all. That is the
honest state rather than a control that would match nothing, and it is stronger than the state
before the row model, where both were offered and answered wrongly.

### Segment properties, and what they unlock

`segmentProperties.ts` reads the `neuroglancer_segment_properties` sidecar — one inline document
listing every segment a source names. It is what turns a bucket of eighteen-digit keys into
something a person can pick from, and it is the single dependency behind three answers that are
otherwise impossible here: region *names* for the ROI Meshes picker, a browsable index for
Explore, and a `findNeurons` filtered by anything the sidecar publishes.

**It is not read by the probe.** The probe runs from an edit-time peek on a `cheap` node, and this
is a much larger document — hemibrain's segmentation publishes 22,706 labelled ids against its ROI
source's 63 — so downloading it because somebody typed a URL is invariant 6's hazard. It loads on
first *ask*, and the peek that cannot answer starts it and fires `reportSourceLearned`, which is
how the region picker fills a moment later.

**Every route to it goes through `neuronIndex`**, i.e. through `loadCachedTable` like every other
source's index — so it persists across sessions, honours Explore's refresh and the node menu's
Clear Cache, and reports its age to the dataset card. It had a memo of its own, which got none of
that and meant the region picker read a copy the cached path could never invalidate.

**Every property becomes a column, and the type decides which.** `label` and `description` are
named by their *type* rather than their id — the id of a label property need not be `label`, and a
picker downstream expects one name on every source that publishes one. `tags` is an index list
into a shared vocabulary, folded to one cell with `JOIN_SEPARATOR` so Explore splits it back into
chips. A `number` without a recognised `data_type` is skipped rather than guessed at, and a
property whose `values` length does not match the id count is dropped whole — a short array shifts
every label onto the wrong segment, which is a table that looks well-formed and names the wrong
neurons.

**`findNeurons` is answered locally**, through the same `preparedRows`/`compileLabelMatch` helpers
`CaveSource` and `CatmaidSource` use, so `LC.*` means the same anchored thing on all three.
Checked live: `LC1[0-2]` over hemibrain's 22,706 returns exactly LC10, LC11 and LC12.

**Region shells default to every label, and `primary` is always true.** Both differ from neuPrint,
where the default is the subset that tiles the volume — because nothing in a sidecar says which of
its labels nest. `primary` is the licence to sum, and a source that cannot distinguish has no
grounds to withhold it from some rows and not others. `MeshGeometry.id` carries the *label*, not
the segment id, because that is what `ROI_MESH_SCHEMA` says a region is called.

**Unsharded multi-resolution meshes exist after all.** `readManifest` used to refuse them —
"no source in use here is built this way" — and hemibrain's region shells are built exactly that
way: `v1.2/rois/mesh` publishes `1` and `1.index` side by side. The manifest is the `.index`
object and the fragments are the plain one, so `dataStart` is **0** rather than
`manifestOffset - Σ sizes`: that subtraction exists because in a shard the fragments sit
immediately before the manifest in one file with no pointer to them, and here they are a separate
object starting at its first byte.

### The flat segmentation beside a materialization, which CAVE does not mention

A datastack's `segmentation_source` is `graphene://` and has to be: a root id is a *dynamic*
agglomeration of supervoxels, which is what the chunkedgraph exists to serve. The cost is that
**graphene has no level of detail** — a verified mesh manifest lists supervoxel fragments at full
resolution — so one FlyWire neuron is 492 range requests and ~1.2 MB, `decimateMesh` is what makes
a scene of them survivable, and there is nothing cheap enough to draw a list of thumbnails from.

A *released* materialization is frozen, though, and its publishers usually also flatten it into an
ordinary precomputed bucket with a pyramid in it. **Nothing in CAVE's metadata says so**, which is
why `DatastackSpec.flat` names them by hand, keyed by version:

```ts
flat: {
  630: 'precomputed://gs://flywire_v141_m630',
  783: 'precomputed://gs://flywire_v141_m783',
}
```

Measured over eight v783 proofread neurons, against the graphene route for the same ids:

| | graphene | `gs://flywire_v141_m783` |
| --- | --- | --- |
| requests per neuron | 492 | 2 |
| levels | 1 | 3–5 |
| coarsest level | — | one fragment, 73 kB – 1.44 MB |
| finest level | ~1.2 MB | 0.3 – 10.8 MB |
| `triangleBudget` honoured by | decimation, exactly | choosing a level, overshooting at the floor |

Four things this is, and each is a decision rather than a consequence.

**Keyed by version, sparsely, and an absent entry is the ordinary case.** A flat bucket holds the
root ids that were current when it was written, so v630's cannot answer for a v783 id. FlyWire
published one for each of its two; BANC published one for 888 and none for 626. Where there is no
entry the graphene route runs, and that route answers for any root id ever minted — which is why
the fallback is not a degradation.

**A pyramid, not a bucket, and BANC's is deliberately not listed.**
`gs://lee-lab_brain-and-nerve-cord-fly-connectome/neuron_meshes/meshes` publishes no `info`, which
by convention means `neuroglancer_legacy_mesh`: one level, full resolution. Measured on two v888
neurons, **28.4 MB and 60.8 MB** apiece — against ~200 kB of Draco for the same neuron through
graphene, whose meshing agglomerates across chunkedgraph layers 2–6 rather than serving leaves.
There is no level to draw a thumbnail from and the Meshes node would be worse off, so
`flatMeshDir` requires `multilod-draco` and falls back rather than reporting a better source than
it has.

**This is one of the two things that make `fetchCoarseGeometry` possible**, and CAVE was the
reason the Explore Dataset list showed a placeholder in every row. `fetchCoarseMesh` is shared
with neuPrint — `triangleBudget: 1`, which no level can meet, so `chooseLod` answers with the
coarsest, and `THUMBNAIL_MAX_BYTES` turns down a single pathological body off the manifest at no
download cost. The other route is the level-2 chunk graph, below, which is what a datastack with
no flat bucket draws from.

**Nanometres with no conversion, and that is measured on both halves rather than assumed.** The
mesh bounding box for `720575940633370649` is x 682,703–723,512 nm; the same neuron's published
skeleton is 682,704–723,568. The mesh `info`'s own `transform` is what does it, and
`fragmentTransform` already applies it. The live suite asserts the pair, because a missing
conversion here is a scene sitting a whole factor away from the neurons beside it with nothing
failing.

### A thumbnail from the chunk graph, where there is no mesh cheap enough to draw

A datastack with only its `graphene://` segmentation has **no cheap mesh at any level** — the
cheapest mesh is the only mesh — so a page of 25 rows would be tens of megabytes, which is exactly
what `DataSource.fetchCoarseGeometry` says to answer `undefined` for. That left BANC, MICrONS and
every other chunkedgraph datastack with a placeholder in every row.

The level-2 chunk graph is the way out, and it is already built: `readL2Skeletons` for one neuron,
two small requests, a few hundred chunks with a representative coordinate each. `l2SourceFor` is
the same gate the Skeletons node uses, so a datastack with no cache still answers `undefined`.

So `CoarseGeometry` is a **union** — `{ kind: 'mesh' }` or `{ kind: 'skeleton' } & SkeletonGeometry`
— rather than one shape both routes have to fit. Making a source fake the other one means meshing
a skeleton or decimating a mesh into a tree, which is work done to satisfy a type rather than to
draw a picture. The skeleton arm is `SkeletonGeometry` exactly, so the L2 reader's output needs no
conversion at all; `kind` is required on both arms, because a source that forgot it would be a
silent fall-through to the mesh branch and a blank tile. The rasteriser that consumes it is in
[widgets.md](widgets.md), including where `STROKE_FRACTION` comes from.

**What it costs is one neuron's worth of batching, knowingly.** `readL2Skeletons` pools chunk ids
across a whole request and reads their coordinates in a handful of calls, which is what makes a
hundred skeletons a hundred graph reads plus about three attribute reads rather than two hundred
round trips. `CoarseGeometryRequest` is one neuron, so a page of 25 gives that up: 25 chunk-graph
reads plus 25 attribute reads, instead of 25 plus about one. Widening the seam to a page would mean a batching protocol between the component and every
source, for a picture already gated at four concurrent and cached in IndexedDB after the first
look.

Measured on four BANC v888 neurons: 19, 310, 1,266 and 2,684 chunks, and 0.4–4.0 s apiece for the
graph read.

### `unsharded_mesh_dir`, or the neuron that arrives whole minus everything anyone edited

A verified graphene manifest mixes two kinds of fragment: the frozen ones, named
`~<layer>/<shard>-0.shard:<offset>:<length>` and read out of shard files under the mesh directory,
and plain objects covering the parts of the neuron somebody has edited since — which live under
`mesh_metadata.unsharded_mesh_dir`. One BANC neuron's manifest was **40 sharded and 21 not**.

Read from the mesh root every unsharded one 404s, and `mapWithConcurrency` turns each into a
dropped fragment rather than a failure — the rule that keeps one bad supervoxel out of 492 from
taking a neuron down. So the neuron arrives looking whole, minus every piece anyone has touched,
under a green node.

FlyWire's public segmentation is frozen and declares no such directory, which is why this went
unnoticed: **the datastack the mesh path was built against never exercises it**, and the one that
does is now the datastack that takes this route at all. `fragmentUrl` matches on `.shard:` rather
than on the leading `~<layer>/` — the layer prefix is part of the path to the shard file, and the
byte range is what makes a name a shard read.

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
minnie65 public, Aedes and zheng_ca3. **`flywire_fafb_public` does not.**

**Which is why there is a second route, and why both are peeked whatever the other says.**
`gs://flywire_v141_m783/skeletons_mip_1` is a `neuroglancer_skeletons` directory with `radius` and
`cross_sectional_area` on every vertex, published beside the materialization and mentioned nowhere
in CAVE's metadata — see *The flat segmentation* above. It is the only skeleton FlyWire has, and
until it was wired in `capabilitiesFor` settled on a confident `false` and the Skeletons node
declined for the whole datastack. `peekFlat` is called before `peekL2Cache` so that its read is
*started* even in the branch where L2 has already answered.

**Published beats built, and they are not the same product.** Measured over ten v783 neurons, a
published skeleton is 14,559 to 338,087 nodes and ~1.8 MB — roughly seventy times an L2 skeleton,
which is one node per chunk. The published one is a better reconstruction and one request per
neuron instead of two; what it costs is memory, which is what `FLAT_SKELETON_WARN` says. In
practice no datastack has both, and that is the same fact twice: FlyWire's skeletons exist
*because* it has no cache to build any from. The preference is written down anyway, because "they
never coexist" is a fact about today's spec table rather than about CAVE.

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

`L2_SKELETON_WARN` is 100 — far above `MESH_WARN_NEURONS`' 20, because a skeleton is one
chunk-graph read where a graphene mesh is several hundred requests, and far below what a source
publishing ready-made skeletons has anything to say about. It **warns and builds** rather than
refusing: every FlyWire question of any size arrives on this route, so refusing to pay its cost
was refusing the dataset. See [limits.md](limits.md).

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
  the filter and `partnerId` the other, so a Synapses node and a Connectivity node on one neuron
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

- **`MESH_WARN_NEURONS` is 20**, against the shared `MAX_NEURONS` of 10,000. Said by the
  *source* rather than by the node, because it is a fact about graphene: the same Meshes node
  against neuPrint has nothing to remark on. It reaches the card through
  `GeometryRequest.onWarn` — which is the per-source seam the old note here wanted, arrived at
  from the other direction. It was a refusal until it became clear that twenty is not a
  scientific quantity of neurons; the fetch now says what it will take and goes.
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

**`fetchCoarseGeometry` does not use this route, and that is the right answer rather than a gap.**
There is no cheap representation among these fragments to draw a thumbnail from, and the
interface's own docstring says an absent one beats quietly downloading full detail to fill a list.
The two routes it does use are the flat pyramid and the level-2 chunk graph, both above.

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
- **Connectivity types come from the index**, not from a second query. A connectivity table
  without them is readable by nothing, and by the time anyone runs Connectivity the index is
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
dataset node is `dataset.catmaid.fafb`, built from `DATASET_FAMILIES` exactly as the others are.

**Two instances ship preconfigured, and that is one source each.** VFB also publishes the
first-instar larval CNS at `l1em.catmaid.virtualflybrain.org` — `dataset.catmaid.l1`, registered
in `data/builtins.ts` beside the default and keyed `catmaid:https://l1em…` by `catmaidSourceId`.
The pair is the clearest statement of why this backend keys its sources on the server: **both
are project `1`**, and project 1 is a different connectome on each. Nothing else here has two
families on two sources; `spaceForDataset`'s `exactSource` field exists for exactly this and
binds FAFB14 to the FAFB instance alone. Everything else is shared — the same CATMAID build
(`2021.12.21.dev295+g30203a5f8` on both), the same CSRF wall, the same absent gzip, and one
`*.virtualflybrain.org` credential row covering both if anybody ever needs one.

Where they differ is what a neuron carries. FAFB meta-annotates `neuron name` and `Cell type`,
which is where its `type` column comes from; L1 uses neither — it has 449 meta-annotations and
those two are not among them — so `readVocabulary` finds no vocabulary at all. It has ~71
annotations per neuron against FAFB's handful, 8 MB of label text against 1.4 MB.

**So `type` falls back to the neuron's own name**, which is the one translation `annotations.ts`
performs rather than reads. A CATMAID neuron has exactly one name and any number of annotations;
`type` is Coda's cross-backend column, not CATMAID's field, and the question is which of the two
carries a row. An annotated instance answers with the annotation, because that is a controlled
vocabulary where the name is not — FAFB's skeleton 430 is *named* `La Grosse Cellule LGC 431 JS`
and *annotated* `DNp32_R`, and only the second joins to anything. An instance that meta-annotates
nothing has no such answer, and the fallback is what stops Explore — whose headline is `type`,
never `name` — drawing all 5,013 L1 rows as `untyped` with the label unused in the next column.

Two rules in it, both measured. `instance` stays **null** rather than repeating the name: an
instance is one individual *within* a type, which is exactly the distinction the `#` encodes and
exactly what an instance with no vocabulary has not drawn. And `typeFromLabel` is **not** applied
to a name — the `#` convention belongs to the controlled label. 53 of L1's 5,013 names contain a
`#` and none of them mean it: they are a tracer's cross-reference to another skeleton (`BC:
presynaptic -medial - paired with #3801211`), so splitting there truncates a sentence and calls
the remainder a cell type. The geometry runs the other way: 5,013 skeletons of 1,000–8,000 nodes,
57–450 kB each, against FAFB's 0.9–1.3 MB. `CATMAID_SKELETON_WARN` is a count rather than a byte
budget and stays honest on both, if conservative here.

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
and a large descending neuron 64,385, where a CAVE L2 skeleton is ~150. `CATMAID_SKELETON_WARN`
is 200 at `SKELETON_CONCURRENCY` 8, which is a *transfer* cost rather than a drawing one and the
warning says so, in minutes, before fetching the set anyway. It moves the day the deployment
turns on gzip.

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
- **A source that publishes no statuses used to have to *ignore* the parameter.**
  `DatasetInfo.statuses` is empty because CATMAID has none — but a node's stored `Traced` default
  survived into the request regardless, and filtering on it drops every row for a value nobody
  chose. This source ignored `statuses` outright and a test pinned it; the same failure was live
  on CAVE. It is unreachable now: a status is an ordinary filter row, CATMAID's schema has no
  `status` for one to name, and a fresh Find Neurons carries no rows at all.
- **A filter somebody *chose* is refused instead, and the difference is the default.** That
  distinction still holds for `In ROI`, the one filter that cannot be a row — see
  `refuseUnfilterableRoi`. CATMAID is the case that makes it visible: `volumeList` fills
  `DatasetInfo.rois` with eighty real neuropils so the ROI Viewer can draw them, which also used
  to populate Find Neurons' region picker, and `findNeurons` never read `req.roi` at all. A
  populated dropdown that narrows nothing, whose result is too *large* and looks correct. The
  picker now reads `capabilities.roiFilter`, which is the question that was actually being asked.
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

**Thumbnails it can do, and the skeleton is what makes that possible.** `fetchCoarseGeometry` was
absent here for the same reason `meshes` is false — there is no mesh at any level to take a coarse
rung off — so every row of an Explore Dataset list drew the placeholder glyph. `CoarseGeometry`'s
skeleton arm is what changes that: the same `compact-detail` call `fetchSkeletons` makes, for one
skeleton, through the same decoder.

**It is the most expensive thumbnail in the tree, and there is deliberately no ceiling on it.**
Measured against VFB's FAFB: skeleton 16 is **940 kB in 0.70 s**, skeleton 2333007 is **4.2 MB in
0.95 s** — uncompressed, since this deployment does not gzip. `with_tags=false` saves 0.9% and is
not the lever. A cold page of 25 rows is therefore tens of megabytes against the ~10 kB a
published mesh pyramid costs.

A `THUMBNAIL_MAX_BYTES`-style cut is the obvious answer and the wrong one, for the reason that
constant's own docstring records from its 128 kB days: on a source whose *typical* body is already
megabytes, a byte ceiling stops being a guard against a broken body and becomes a quality filter
that blanks exactly the densely traced neurons anyone is looking for. The size is knowable in
advance too — `skeletonSummaries` carries `num_nodes` and the index has already read it — so this
is a decision rather than an impossibility.

What makes it affordable is that a thumbnail is fetched **once per neuron ever**:
`NeuronThumbnail` stores the 23 kB mask in IndexedDB, so the megabytes are paid on first sight of
a row and never again. The session geometry cache is deliberately *not* written here — a
background list-fill pushing 50 MB through a 256 MB LRU would evict the geometry of the scene the
user is actually looking at.

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

## Precomputed

`src/data/precomputed/` reads neuroglancer precomputed meshes. It knows nothing about
neuPrint — FlyWire and CAVE were the obvious next consumers and both now use it — and
`src/data/neuprint/nglayers.ts` maps a *neuPrint dataset* to a bucket. Since the
`Neuroglancer Source` node it is also reachable directly: a URL somebody pastes becomes a
`PrecomputedSource`, which is a `DataSource` that answers geometry and refuses everything else.
See [datasets.md](datasets.md) for why that is a *datasource* rather than a dataset.

### One parser for the three spellings of a source

`data/neuroglancer/sourceUrl.ts`. Neuroglancer accepts a legacy scheme prefix
(`precomputed://gs://…`), the current pipe syntax (`gs://…|neuroglancer-precomputed:`) and, in
practice, whatever somebody copied out of a layer's Source box. All three name one directory, and
a reader has no reason to know which they got — so they collapse onto one canonical string, which
is also the registry key. Two spellings landing on two keys would re-probe the same `info` and
hand two nodes different dataset ids for one bucket.

**The location keeps its own scheme.** `gs://bucket/path` is not turned into an HTTP URL until
something asks for `url`, because the object-store form is what a layer's `source` field wants
back. `middleauth+` is stripped as part of normalising: it is an instruction to a viewer rather
than part of an address, and the two viewer flavours disagree about whether it belongs (see
`#middleauth+ is spelunker's, not neuroglancer's` above).

**`precomputedToHttp` is narrower than the parser on two axes and stays that way.** It is
`meshSourceFromState`'s candidate filter, and the preference order it feeds is measured rather
than derived — the paragraphs below record what preferring the wrong candidate cost. So it
requires the format to have been *stated* (a bare `gs://` is not enough, where the parser reads
one as precomputed) and the location to be a bucket. It moved here out of `nglayers.ts` when the
node arrived; leaving a copy behind would have made the "two functions of one name two directories
apart" warning in `fetchText.ts` true a second time.

### What is at the end of a URL, read once

`probe.ts` reads the same `info` documents `openMeshSource` does and keeps the whole answer rather
than the one branch a fetch needs. A **card** needs the rest: whether this is a segmentation or an
image stack, whether there are meshes at all, and whether they are multi-resolution or the flat
kind. It is memoised per URL, **failures included**, because the node above it is `cheap` — see
[datasets.md](datasets.md) for that trade and for the optimistic-capability rule that goes with it.

It also **opens** the mesh and skeleton directories, through `openMeshDir`/`openSkeletonSource`
rather than by re-reading `@type` itself — so the card's verdict and the fetch's cannot disagree
about one URL. Both are opened together rather than in sequence; they are independent reads and
this runs from an edit-time peek, where a wasted round trip is visible. The opened sources are
kept on the description, which is what makes the first Run cost **no requests of its own**.

**What comes back from that open is an optimisation, not a verdict**, and the distinction is
load-bearing. A transient failure is indistinguishable from an unreadable directory, and the probe
is then cached as a *success* — so `meshDir` keys its refusal on whether the source **names** a
mesh directory and re-opens when the cached copy is absent. Keying it on the opened copy meant one
CORS blip produced "publishes no meshes" for the rest of the session, on a source whose
`capabilitiesFor` still said it had them.

**`@type` is optional on a volume, and both readers ask `isVolumeInfo` rather than switching on
it.** This was a `switch (info['@type'])` with `undefined` falling to "legacy mesh directory",
which is right for a mesh directory and wrong for every flat segmentation published before the
field was conventional. `gs://flywire_v141_m783/info` declares `"type": "segmentation"`, eight
`scales`, `"mesh": "mesh_mip_1_err_40"`, `"skeletons": "skeletons_mip_1"` — and no `@type` at all.
Read as a mesh directory it opened as `legacy` **at the bucket root**, where no manifest exists; so
every request 404d, and because a missing mesh is an ordinary answer the whole thing surfaced as
"these neurons have no meshes" rather than as a bad URL. Two multi-resolution mesh sets and a
skeleton set were unreachable behind it. The volume markers decide it instead — `scales`, or a
named `mesh`/`skeletons` — and a mesh or skeleton directory's own `info` carries none of the
three, which is what makes the test a discrimination rather than a heuristic.

**`openMeshSource` resolves; `openMeshDir` opens, and only the second forgives a missing `info`.**
A legacy mesh directory commonly publishes none — banc's `neuron_meshes` names `meshes`, and
`meshes/info` 404s — so for a directory a volume already *named*, absent means legacy. Only a 404:
a CORS refusal or an unreachable host read the same way would turn one blip into a directory whose
every manifest request 404s, reported per neuron as a missing mesh. `openMeshSource`, which has to
decide what a URL *is*, stays strict, because a URL with nothing at it is a URL nobody can use.

**An abort is not remembered.** Cancelling a run says nothing about the bytes, and a memoised
"This operation was aborted" sat on a card with a perfectly good URL. It rejects rather than
resolving a verdict, which is also the scheduler's own rule for an aborted run.

**`fetchInfo` memoises `/info` by URL**, successes only. An `info` is the published description of
a released dataset and is immutable under a fixed URL, which is what makes the cache correct
rather than merely convenient — and without it one document was fetched three times for a pasted
segmentation: once by the probe, once by `openMeshSource`, and once more by `readMultiResInfo`
inside it. That last pair is pre-existing and every backend's mesh open paid it. Failures are not
held (they are usually transient, the same reason `remember` refuses to persist `unreachable`),
and in-flight requests are not deduplicated, because sharing one promise would let one caller's
`AbortSignal` reject for every other.

Checked against the live buckets (`live.test.ts`, `PRECOMPUTED_LIVE=1`):

    male-CNS v1.0     segmentation, mesh: multi-res-meshes (draco), skeletons: skeletons-malecns/…
    hemibrain v1.2    segmentation, mesh: mesh (draco), segment_properties: segment_properties
    male-CNS supervoxels   segmentation, no mesh directory at all
    male-CNS synapses      neuroglancer_annotations_v1

Two of those are the cases the classification exists for. **male-CNS's volume declares
`mesh: multi-res-meshes`** while the viewer state it publishes advertises
`meshes-malecns/single-res-meshes` — following the volume is the correct branch, and it is the
same finding the preference order below records from the other direction. And **a segmentation
with no mesh directory is a real, common thing**, so "is a segmentation" and "has geometry" have
to be separate questions or a Meshes node runs and fetches nothing.

### Skeletons

`skeletons.ts`, and the format is four lines: `uint32 numVertices`, `uint32 numEdges`,
`float32 positions[n][3]`, `uint32 edges[m][2]`, then one contiguous array per entry of
`info.vertex_attributes`. What makes it a module is the three things that are not in the bytes.

**The edges are a graph and `SkeletonGeometry` is a tree.** Nothing in the format says otherwise:
the edge list is undirected, unordered, and may hold cycles or disconnected components. The
conversion is `spanningForest` in `data/skeletonTree.ts` — breadth-first, one root per component,
points emitted in visit order so a parent always precedes its child. It moved there out of
`cave/l2.ts` when this became its second caller, and the reason to move rather than copy is that a
cycle surviving into `parents` makes every consumer that walks to a root loop forever. What stayed
in CAVE is the part that is about CAVE: dropping chunks with no cache entry *before* the walk, so
it routes around them instead of orphaning their children.

**`radius` is a convention in `vertex_attributes`, not a field**, and usually there is not one.
male-CNS publishes `{"@type": "neuroglancer_skeletons"}` and nothing else — no transform, no
attributes — so every radius is 0, the same answer `cave/l2.ts` gives a chunk with no distance
transform. Attributes are contiguous per-attribute arrays in declared order, so reaching a
`radius` behind another attribute means stepping over it by size; a lookup by name would read the
wrong bytes. Only a single-component `float32` is read, because a `uint8` radius is in a quantised
unit this has no scale for — a plausible number in the wrong units is worse than an honest zero.

**Coordinates are already nanometres.** Measured: male-CNS vertices come out around 3.6e5, in a
volume ~93,800 voxels of 8 nm across. A reader that scaled them by the voxel size would put every
skeleton 8× away from the mesh of the same neuron, with nothing failing, because both sets are
internally consistent — which is why `live.test.ts` fetches one body both ways and asserts the
boxes overlap. An `info` *may* carry a `transform`, and this applies the **full** 3×4 affine where
`fragmentTransform` uses only its diagonal. Not an inconsistency: the mesh transform runs per
vertex over millions of quantised vertices and every mesh source in reach is a pure scale, where a
skeleton is hundreds of points and the full matrix costs nothing.

**No manifest sweep, so it streams from the first arrival** — one request per body, at the same
bucket concurrency the mesh path uses, and `onProgress` gets the whole bar rather than the mesh
path's four-fifths.

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

**`Warn above` is about requests; `Detail` bounds weight; `maxBytesPerBody` bounds one neuron.**
Three different guard rails. Conflating the first two is how the mesh limit ended up at 25 — a
number from before levels of detail existed, which refused thirty neurons that would have
arrived as a few hundred kilobytes. All three morphology nodes now share `MAX_NEURONS`, at
10,000, and it is a warning threshold rather than a ceiling — the control was renamed from "Max
neurons" when it stopped refusing, since that is the one way it could lie about what it does.

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
