# Backends: neuPrint

neuPrint: connections and their regions, totals, synapse sets, somas, and the DatasetGateway
sign-in. [backends.md](backends.md) holds what all of them share — the geometry cache and streaming.

## neuPrint

Lives entirely under `src/data/neuprint/`. Nodes see the same `DataSource` interface the
mock implements; nothing above `src/data` knows Cypher exists.

**Direct access depends on the deployment, so the route is discovered rather than declared.**
neuPrint used to send _no_ `Access-Control-*` headers on any response, with its `OPTIONS`
preflight returning 401 before CORS middleware would run — so a request carrying an
`Authorization` header was blocked by the browser before it was sent, and every call had to go
through a same-origin proxy. Janelia fixed that on `neuprint-test.janelia.org` first, and
the fix was checked end to end rather than taken on trust: 204 on the preflight,
`Allow-Headers: Authorization, Content-Type` (exactly what this app sends — `Accept` is
safelisted and needs no mention), no `Allow-Credentials`, and `Access-Control-Allow-Origin` on
**every** response including 401 and 404. That last one is the load-bearing part: the
`reportAuthFailure` channel works by reading a 401's status, which a browser only surfaces if
the response itself carries ACAO. All seven endpoints this app calls were verified, each path
prefix preflighted separately (nginx CORS config is per-location), and a 4 MB Explore-Dataset-shaped
index came back gzipped to 957 kB in 1.4 s.

**Every Janelia deployment has it now** — production since 2026-08-31, per Janelia. Re-probed
2026-09-10 against all five hosts the code
names — `neuprint`, `neuprint-test`, `neuprint-cns`, `neuprint-pre`, `neuprint-fish2` — from
`Origin: https://coda.science`: preflight 204 with the same allow-list and a one-hour max-age,
and ACAO `*` on a 401 (a tokenless `POST /api/custom/custom`) and on a 404 alike. So a static
deploy reaches every public neuPrint direct, with no proxy anywhere on the path. Production's
preflight re-checked 2026-09-21, unchanged.

`routesForServer` still offers two routes — the deployment itself, then the proxy path — and
`client.ts` still _tries_ them, because a neuPrint is software rather than a service: a lab's own
deployment may send no CORS headers at all, and a browser reports a CORS refusal as an opaque
`TypeError` indistinguishable from a dead host. The answer is remembered per deployment in `localStorage`,
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

The proxy is now for a deployment with no CORS headers, not for any Janelia host. It is
registered under **both `server.proxy` and `preview.proxy`** —
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
three different `Access-Control-Request-Headers`; still fixed on every deployment after the
CORS rollout, re-checked 2026-09-10). Adding one today would fail every cross-origin request
outright rather than merely going unnoticed. It is a line of nginx config on Janelia's side, in
the same file as the CORS headers they have already added.

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
(no cap), and raw Cypher is sent as typed. That is a deliberate call: these queries hit
a shared production Neo4j, so an unbounded `MATCH (n:Neuron)` on male-cns is a real hazard —
which is why the one thing that *is* refused there is not a rail at all but a semantic: a node
with no filters returns no neurons rather than the dataset, so an unconfigured card never sends
that query in the first place (see [nodes-connectivity.md](nodes-connectivity.md)). A
neuPrint `:Neuron` is any body above a synapse threshold or carrying a name, not a proofread one —
hemibrain has 186,061 of them — which is what the **population checkboxes** on the dataset node
narrow. `populationCypher` compiles them to one parenthesised `OR` group ANDed onto the rest of
the `WHERE`, and an explicit `status` filter row removes the `traced` disjunct from it. See
[datasets.md](datasets.md#the-population-checkboxes-and-the-default-that-was-removed-once-already).
Leave the decision where it is rather than re-litigating it.

**Five of the twelve datasets publish a second set of skeletons, and it is the same
reconstruction.** The segmentation volume's own `info` may name a `skeletons` directory, and
`volumeSourceFromState` is what finds it — the *volume*, not the mesh answer, because those come
apart: `optic-lobe:v1.1` keeps its meshes in a sibling directory of the volume, so following
`meshSourceFromState` would look for an `info` one level too deep and conclude the dataset
publishes none. What is there, probed across every dataset the deployment lists:

| dataset | skeleton directory |
| --- | --- |
| `male-cns:v0.9`, `male-cns:v1.0` | `skeletons-malecns/skeletons-precomputed` |
| `optic-lobe:v1.0.1` | `skeletons` — the male-CNS export; 5 of 20 sampled bodies present |
| `optic-lobe:v1.1` | `skeletons-precomputed` |
| `manc:v1.0` | `skeleton` |
| hemibrain, `manc:v1.2.x`, banc, fib19, mushroombody | none |

**The SWC leads because it carries radii and the bucket does not**, and the rest of the
comparison is why the published one is offered at all. Measured on `male-cns:v1.0` body 45882:
1,688 nodes down both routes, identical bounds in nanometres once the SWC's dataset voxels are
scaled by 8 — and the published copy needs no token and is about half the bytes. male-CNS's
directory declares no `vertex_attributes` at all, so every radius there is 0.

The trap is coverage. A body missing from the directory is a 404, which `readSkeleton` turns into
an absence rather than a failure — so `publishedSkeletons` warns with a count, or `optic-lobe`'s
answer is a scene quietly three quarters short. See *Three routes to a skeleton* under CAVE for
the seam both backends share.

**The token** lives in `localStorage` via `credentials.ts`, never in a saved graph — signed in
for (see "Signing in through DatasetGateway", below) or pasted. A 401
goes out on a separate channel (`reportAuthFailure`) rather than as an error message,
because errors cross the scheduler as strings and matching on message text rots silently;
`SourcesPanel` subscribes and opens itself.

**Tests use recorded fixtures** in `__fixtures__/`, all real trimmed responses. The
transport is not covered — it cannot be without a network — but it fails loudly.

### A connection's regions, and what a weight is a fraction of

Two facts about neuPrint's data that the Connectivity node's region and normalisation controls
are built on. Both were probed live against `neuprint.janelia.org` and both are pinned in
`live.test.ts`, because a fixture proves the decoder works and proves nothing about whether the
server's own arithmetic still holds. The design record is in
[nodes-connectivity.md](nodes-connectivity.md#normalizing-a-weight-two-ends-two-denominators-and-both-said-out-loud); what
belongs here is what the database does.

**`ConnectsTo` carries `roiInfo`.** A JSON blob per relationship — `{"LAL(L)": {"post": 112}, …}`
— present on every dataset the deployment lists (fib19's is `{}`, which splits into nothing and is
a dataset with no regions rather than a failure). The per-region number to read is **`post`**: it
counts postsynaptic densities, which is what `w.weight` counts for the connection as a whole, and
hemibrain writes a `pre` beside it that is a different measure. `apoc.convert.fromJsonMap` is
available in custom Cypher on every deployment checked — neuPrint's own cached
`/api/cached/roiconnectivity` endpoint is built on it — so the split and the restriction are done
in the query rather than by shipping every blob.

Summing `post` over the **primary** set reproduces `w.weight`: exactly on male-CNS (400 of 400
sampled edges, and 23,423 over all 11,287 out-edges of body 10005) and MANC, and to within a
percent on hemibrain and optic-lobe, where a few synapses sit in no primary region at all. The
per-dataset numbers are on `ConnectivityRequest.splitByRoi`. Summing over **all** keys double
counts, because regions nest.

**Every body is a `:Segment`; `:Neuron` is the subset above the synapse threshold**, and both
carry `pre`, `post`, `upstream` and `downstream`. `bodyId` is indexed on `:Segment` — 500 ids in
168 ms, 20,000 in 2.2 s — which is why `synapseTotalsCypher` matches that label on the queried
end: a fragment that turned up on the far end of somebody's edge still gets a denominator, where
`:Neuron` would return no row and read downstream as "no answer" rather than as "not a neuron".

The numbers that decide which property is which, on male-cns:v1.0 body 10005:

```
n.post = n.upstream ..... 31,981     Sigma in-weight, all partners ...... 31,981
n.downstream ............ 23,423     Sigma out-weight, all partners ..... 23,423
n.pre (T-bars) ..........  2,837     Sigma out-weight, :Neuron only .....  9,324
```

So the published total and the sum over every relationship are **the same number** in both
directions, and `n.pre` is not that number for the outgoing side — it is the T-bar count, eight
times smaller. `synapseTotalsCypher` therefore falls back `coalesce(n.upstream, n.post)` on the
incoming side, where the two are measured equal, and has deliberately **no** fallback on the
outgoing one.

### What else a connection carries, and how to find out

`ConnectsTo` carries more than `weight` and `roiInfo` on every dataset looked at — `weightHP`
everywhere, `weightHR` on most, and on fish2 the count split by the compartment at each end; the
table is in [nodes-connectivity.md](nodes-connectivity.md#edge-properties-what-a-connection-carries-beside-its-weight).
`Meta` declares none of it — it has `neuronProperties` and no relationship equivalent — so
`discoverEdges` samples it, on a promise of its own: `discover` starts it and does not wait, so
no neuron query is held behind it, and only a query that asked for a property does.

- `sampleEdgePropertiesCypher` reads one non-null value per key off 500 connections, which is
  enough for a dtype. Every dataset measured carried its properties on every edge.
- `sampleEdgeRegionKeysCypher` reads the keys inside `roiInfo`'s region entries off 500 connections
  of weight ≥ 10. A region entry **omits a zero**, so on the weight-1 edges an unfiltered sample
  lands on, a rarely non-zero key does not appear.

Both answered in about 0.4 s on male-CNS and on fish2, and both fail soft: no sample leaves the list
*unknown*, never empty. The listing merge carries the list across a re-list, as it does statuses and
the primary set.

**The exact answer exists and is too slow to use.** `CALL db.schema.relTypeProperties()` is allowed
through the custom endpoint and names every property with its Neo4j type — and walks every
relationship to do it: 52 s on fish2, 115 s on hemibrain, still running at 180 s on male-CNS.

A property is read with a string key, `w['weightAxonDendrite']`, rather than a back-quoted
identifier, so a name from the server goes through `escapeString` like every other value, and the
same spelling reads a region entry (`ri[r]['weightAxonDendrite']`).

### The same totals per group, for a type-collapsed traversal

`groupTotalsCypher` is that query summed over a population, and it exists because the Paths node
divides a **type-level** weight: a row's numerator is every LC4→PLP1 synapse, so its denominator
has to be everything every PLP1 neuron receives. `RETURN n.type, sum(coalesce(n.upstream, n.post))`
over `n.type IN [...]` answers it in one query, where asking per neuron would mean shipping the
type's whole membership out first — 401 ids for one number on the mock's DNp02, thousands on a
real hub type.

**The type arm matches `:Neuron` where `synapseTotalsCypher` matches `:Segment`**, and that is a
decision rather than an oversight. A denominator has to count the population its numerator came
from, and the numerator is `pathStepCypher`'s, which matches `(a:Neuron)` at both ends — so
summing every `:Segment` carrying the type would put synapses in the denominator that no hop of
that traversal could have contributed. The id arm keeps `:Segment` for the reason above: a lone
untyped neuron standing as its own group in a collapsed frontier is still a body.

The key comes back as **text** on both arms (`toString(n.bodyId)`), because that is the vocabulary
the traversal groups in — `coalesce(n.type, toString(n.bodyId))` one query over — and a key that
arrived as a number would miss every lookup while presenting as a dataset with no totals. The two
arms are two statements rather than a `UNION`, and in the ordinary collapsed case only the type
one is sent.

### A `SynapseSet` is per partner, so a T-bar comes back more than once

`(n:Neuron)-[:Contains]->(:SynapseSet)-[:Contains]->(s:Synapse)` is the only way to a neuron's
synapses, and a neuron holds one `SynapseSet` **per partner neuron**. A presynaptic site therefore
appears once per partner it drives. Postsynaptic densities belong to one connection each and are
unaffected. Measured live:

| dataset | pre rows | distinct pre synapses |
| --- | --- | --- |
| `male-cns:v1.0`, body 10001 | 4,491 | 1,015 |
| `hemibrain:v1.2.1` (200k-row sample) | 135,652 | 18,420 |
| `manc:v1.2.1` (200k-row sample) | 117,640 | 15,357 |
| `optic-lobe:v1.1` (200k-row sample) | 163,540 | 39,865 |

`WITH DISTINCT n, s` collapses them — `n` stays in the `WITH` because the `RETURN` reads
`n.bodyId` and `n.type`. It is neuprint-python's own fix, in `queries/synapses.py`, with the same
comment. Deduplicated, body 10001 returns 1,015 pre and 18,582 post, which is exactly `n.pre` and
`n.post` and exactly what Explore Dataset shows.

**Both forms are offered** rather than one being tidied away, because the row count of the
undeduplicated form is the connection count and `n.synweight` (23,073 on this neuron) is the sum of
the two. Which one a `PointsValue` holds is `SynapseRequest.unit`; neuPrint is the only source in
the tree that can answer either. See [nodes-morphology.md](nodes-morphology.md) for the control and
`data/synapseUnits.ts` for why `sites` is what Automatic takes.

**`s.confidence` is a fraction, 0..1, and the dataset has usually already cut on it.**
`Meta.postHighAccuracyThreshold` is 0.5 on male-CNS, which is why nothing in that cloud scores
below 0.5004 — and why presynaptic scores top out at 0.98 there, 0.99 on MANC, 0.986 on optic-lobe.
A `>= 1` threshold therefore returns no presynaptic site at all on three of the four datasets,
which is what the Synapses node's old `Min weight` default did.

### A skeleton's soma is `somaLocation`, snapped within 2 µm

Neither skeleton route labels a soma: the SWC endpoint is JSON with `rowId, x, y, z, radius, link`
and no structure code, and the published layer has none either. Without a label,
`resolveRoot('soma')` falls back to the largest fragment's root, which on a fragmented skeleton is
often arbour. Male-CNS 48122 has two roots: a 796-node fragment rooted ~200 µm from the cell body,
and a 38-node fragment of radius ~1.3 µm whose root is 1.15 µm from `somaLocation`. The dendrogram
drew its soma dot on the first.

So `fetchNeuronRows` also returns `n.somaLocation`, a neo4j point read by `somaPoint`.
`assembleSkeletons` scales it to nanometres and labels the nearest node `SWC_SOMA` through
`withSomaAt` (`data/soma.ts`). It does so only within `SOMA_SNAP_NM`, 2 µm: half of a 4 µm
soma, the largest a fly soma gets, and `somaLocation` is the soma's centre. A node further away
means a skeleton that does not reach the soma, and labelling one would root the arbour somewhere
arbitrary. A source's own soma label wins. The labelled copy is a new object, because
`cachedGeometry` shares the stored one.

### Signing in through DatasetGateway

`data/neuprint/signIn.ts` plus `ui/panels/neuprintSignIn.ts`, on the window machinery CAVE's
sign-in now shares (`ui/panels/popupSignIn.ts`). neuPrint moved its accounts to Janelia's
**DatasetGateway** (DSG) in August 2026, and every deployment — production, `-test`, `-cns`,
`-fish2` — validates against the one DSG at `dsg.janelia.org`. One token for all of them, which is
what `credentials.ts` already held.

**This used to be impossible, and the record of why is worth keeping.** DSG's browser auth was
middle_auth's shape without the part that matters: `REDIRECT_ALLOWED_DOMAIN = "janelia.org"`
silently rewrote any other return URL to `/`; there was no `postMessage` delivery, the token
arriving only as an `HttpOnly` `dsg_token` cookie on janelia.org; and neuPrint's `ACAO: *` with no
`Allow-Credentials` meant nothing could read that cookie cross-origin. Three independent closures,
so there was nothing to work around from the client. What opened it (September 2026) is the change
this section recorded as the only one that would: an **origin-allowlisted** `postMessage` delivery
on DSG itself, tightened rather than copied from middle_auth's `"*"`.

The contract, agreed with Janelia and checked against the live service:

  - **No discovery step.** The popup goes to
    `https://dsg.janelia.org/login?origin=<this page's origin>&token=api`, a constant. `token=api`
    asks for an API key rather than a browser session.
  - **The delivery page posts to the registered origin, not `"*"`**, and only to a registered one.
    Three are registered: `https://coda.science`, `https://navis-org.github.io` and
    `http://localhost:5173`. **The comparison is exact, and it bit once**: Janelia first registered
    `navis-org.github.io` alone, but the Pages site 301s to the `coda.science` custom domain, so that
    is the origin the deployed app actually runs on, and DSG answered it with `"badorigin"` until it
    was added (confirmed registered 2026-09-21). `127.0.0.1` is still a different origin from
    `localhost`, so a dev server opened that way cannot sign in.
  - **A message is taken only from `https://dsg.janelia.org` exactly.** `dataset-gateway.janelia.org`
    serves the same application from a different origin.
  - **`"badorigin"` is its own answer.** It is a bare string from a page that then closes itself;
    read as "not a token" it would reach the closed-window poll and tell somebody they had closed a
    window they never touched. `readDsgMessage` returns it, and `popupSignIn` settles as
    `refused` with a sentence naming the site.
  - **What comes back is a seven-day DSG API key.** It is refused by DSG's own token management,
    account page and SCIM, and never carries admin. Stored like the CAVE token, with a **label,
    not an expiry** (`SignInSession`, now in `data/signIn.ts` and shared); signed in again on a 401.
  - **Cancelling the consent page posts nothing** — the closed-window case. **"Don't ask again for
    this site"** makes later sign-ins deliver silently; the window opens and closes by itself,
    which is why the listener is installed before the popup is pointed anywhere even though there
    is no lookup to wait for. Grants are revoked at `dsg.janelia.org/web/my-account`.
  - **Who the token belongs to comes from neuPrint's `/profile`**, not DSG's `whoami`, which has no
    CORS. `ACAO: *` there on every deployment; the body is `{"Email", "AuthLevel", "ImageURL"}` —
    **capital `E`**, unlike CAVE's `/user/me`.
  - **A 403 with `tos_required: true` is a terms gate, not a bad token.** `client.ts` names the
    neuPrint site and does **not** fire `reportAuthFailure`: opening Connections would send
    somebody to sign in again, which cannot lift a terms gate — the lesson CAVE's `missing_tos`
    already taught (see "A refusal about a datastack nobody asked for", below).

The panel follows the CAVE tab: sign-in first, and it **commits** (the account and date shown
beside it); the paste field behind a disclosure, open by default only for somebody already using a
pasted token. A paste drops the label, so a Save cannot put the last sign-in's email under a token
that is not that account's.
