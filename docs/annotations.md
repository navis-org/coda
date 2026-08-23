# Annotations, and telling backends apart

Where a neuron's labels come from when they do not come from the connectome.

Moved verbatim out of `CLAUDE.md`.


## Annotations, and telling backends apart

Two things landed together because the second is what the first made necessary: neuron labels
can now come from somewhere other than the connectome, and a dataset node now says which backend
serves it.

### Where a neuron's labels come from

`src/data/annotations/`. A **CAVE dataset node has an Annotations socket**, and what is wired to
it *replaces* the datastack's own labels. Sources **chain** — each has its own optional
Annotations input — so `CAVEtable → FlyTable → Dataset` is one socket on the dataset and a
visible sequence on the canvas, with a later source winning a name collision. What travels is an
ordinary neuron table, so a Filter, a Sort or a Select can stand anywhere in that chain and a
Table node beside it shows what actually arrived; see **the Annotations socket** below for why
that is not a bespoke type.

**neuPrint has no such socket**, and that is `DatasetBackend.acceptsAnnotations` rather than a
type check: neuPrint carries its cell typing as properties on the neuron, so there is nothing for
a source to replace and the control would change nothing. A CAVE datastack takes its labels from
a table — which is exactly what an annotation source *is* — and for several datastacks there is
no such table at all. Aedes publishes synapses and nuclei and no annotations whatsoever.

**Four nodes over three providers**, which is `labelsToNeurons`' call again: `FlyTable` and
`SeaTable` are the *same API at two hosts*, so they share a client and differ in the host they
default to and the name somebody looks for. `Google Sheet` is the third provider and the one that
needs no credential at all — see *Google Sheets, and the provider with no credential* below.

**Two column names are Coda's, and a chain has to land on both.** `neuronId` was obvious — an id
column is whatever the base calls it and every provider renamed onto it from the start. `type` was
not, and missing it is entirely silent: `typesOf` reads `index.data.type` by literal name, so a
chain publishing `cell_type` leaves `neuronType`/`partnerType` null on **every** connectivity row
while the schema still declares them, Explore's `PRIMARY = ['type', 'instance']` falls through to
a guess, and Profile's type roll-ups empty. `annotationColumn` in `annotations/types.ts` is the
rule, applied by both providers — the same statement `data/cave/schema.ts` makes for the
datastack's own table (`{ pt_root_id: neuronId, cell_type: 'type' }`), since an annotation chain
is just the other route to the same neuron table. Deliberately only those two: everything else is
a passthrough only a column picker ever names, which is what neuPrint's `PROPERTY_NAMES` does for
`cellBodyFiber` and `somaSide`.

**What a chain does to a schema is one function, `withAnnotations`**, and it lives in `src/data`
because both halves of the seam need it: the edit-time half runs in `src/nodes` (`schemasFromType`,
so a picker knows what to offer) and the run-time half in `CaveSource` (so the table it builds
matches), and `src/data` may not import `src/nodes`. Written twice they had already drifted — one
took the id column off the source's own schema and the other hardcoded `str`, agreeing only
because every CAVE schema happens to declare `str` today. Invariant 3 in the direction nothing
type-checks. `chainSchema` and `joinAnnotations` are the same pairing one level up, and share
`joinedSchema` for the same reason.

**The chain reaches the source, not the graph.** Every request that names a dataset carries it —
find, index, connectivity, adjacency, geometry — because a `DataSource` has no view of the graph
and the chain is a fact about the wiring. `datasetRequest(dataset)` returns the **id and the
annotations together**, so a call site cannot supply one without the other.

That pairing is the fix for a real failure rather than a precaution. The first pass threaded the
chain into the *type* and only partly into the values: `findNeurons` never forwarded it at all,
`schemasForDataset` did not substitute where `schemasFromType` did, and the morphology attribute
table was built from the datastack's schema. So three query nodes advertised the chain's columns
and returned the backend's, both morphology nodes did the same, and a second complete 139,255-row
index was built and cached under the unannotated key. Invariant 3 across a seam, silent, and only
findable by reading every caller — which is why the id and the labels now travel as one thing.

**A chain wired but not yet run means the widget waits, rather than loading.** The *type* says a
chain is there the moment the wire is drawn; only the value carries its table. Loading anyway
downloads the whole index under the unannotated key and again under the annotated one the instant
a Run lands — on FlyWire, 139,255 rows and about seven seconds thrown away, both retained for the
life of the tab since the shared entry map is never evicted — and the list it shows meanwhile
carries the backend's labels, which is the gap the chain was wired to close. Read off the type,
which also retired a match on the *text* of `CaveSource`'s refusal: that coupled the empty state
to a sentence in `src/data` and recognised only CAVE's phrasing.

**The Explore widget reads the chain off the _value_, one run later than the ports do.** A
dataset *type* carries the chain's schema; only a `DatasetValue` carries its table, because that
table is a fetch somebody's Run paid for. So `NodeBodyProps` gained `inputValues` — the same
thing `ValuePreview` is handed, from the `nodeInputs(id)` the card already computed — and
`useNeuronIndex` takes the chain and keys its shared entry on it, for `neuronIndexKey`'s reason.

That is a real departure from "this widget loads independently of any run", and it was forced
rather than chosen. It began as a labelling gap — an annotated CAVE dataset listed the backend's
`type` while the wire carried the chain's columns — and became a **hard failure** the moment
`DatastackSpec.neurons` was allowed to be absent: on a datastack that publishes no neuron table
the chain *is* the list, so the widget had nothing to list and the source refused. Aedes is
exactly that datastack, and it is the case the whole feature exists for.

The departure is bounded to what cannot be had otherwise: with nothing wired, or before a run,
the widget behaves exactly as it always did. And the pre-run state is drawn as an instruction —
`Press Run to load this dataset's neurons` — rather than as the source's own sentence, which
would send somebody to look at the dataset when the fix is a keypress. That recognition matches
on the refusal's *text*, which is the thing `reportAuthFailure` exists to avoid; it is
deliberately narrow (it only softens wording, and a real refusal still shows through) and the
honest fix is the per-dataset capability that is still unwritten.

**The Profile widget looked like the same gap and was not**, which is worth the sentence: it
fetches per neuron rather than loading an index, and `ValuePreview` hands it a whole
`DatasetValue` and then peeled two strings off it. So the chain now rides along, and the profile
cache key carries it for `neuronIndexKey`'s reason — two graphs on one datastack with different
annotations hold different answers, and without it the first one looked at is served to the other
for the session. It matters on precisely this card because it is the one surface that prints a
partner's *type* in words beside ports carrying the chain's.

**A repeated root id is kept by the providers, and collapsed only where it has to be.** Both
`shapeRows` and the CAVE table reader used to drop a repeat, on the stated grounds that it "would
put that neuron in the index twice" — which was already answered downstream and always had been:
`dedupedIds` fixes the row order and `annotationIndex` fixes the cells, both first-occurrence-wins,
and `joinAnnotations` does the same per side. So collapsing it at the provider changed nothing a
Dataset ever saw. What it did was hide, from the only person who could act on it, that their base
disagrees with itself.

Measured against FlyTable's `main.info`: **58,340 rows over 56,309 distinct ids, 1,089 neurons
carrying more than one, and one segment appearing 104 times** with its `side` reading left, center
and center among them — a proofreading merge pulling many old annotations onto one root id. "First
wins" was picking one of those 104 by arrival order, silently. Now the repeats reach a Table node,
and a Sort ahead of the Dataset decides which row wins instead of the order the API happened to
return. `cave.test.ts` pins the downstream collapse, since that is what the providers now lean on.

**And the change did not appear to ship, because the cached table outlived it.** An annotation
table is kept for a month and the fingerprint was the ref key alone — which says what was *asked
for* and nothing about how the answer was built, so no change to the shaping rules invalidated a
single stored entry. A session that had read `main.info` before went on reporting 56,309 rows,
with `Refresh` on the node the only way through. `SHAPE_FORMAT` in `annotations/registry.ts` is
now part of the fingerprint. Same trap and same fix as `MASK_FORMAT` on the thumbnail cache — an
entry that outlived the policy that produced it because nothing in it recorded which policy that
was. In the fingerprint rather than the key, because a fingerprint mismatch is a miss that
*overwrites*, and there is only ever one current shape.

**"Shaping" is a precise thing, and the rule is: bump when the same reply would now produce a
different table.** Which rows survive, what the columns are called, what dtype each gets, how a
cell is narrowed, whether a long table is folded. *Not* how the fetch was made — paging, routes,
retries and credentials all leave the same table behind, and none of them belong in the
fingerprint.

**And it is coupled rather than remembered.** `shapeRows`, `wideRows` and `pivotRows` each have
their decisions asserted in `annotations.test.ts` — those blocks *are* the operative definition —
and one test in the same file asserts `SHAPE_FORMAT` itself. So changing shaping fails a test,
and bumping the constant alone fails a different one that points back at the blocks. Both
directions were confirmed by mutation. Without that pairing the constant is a comment, and a
version somebody has to remember to bump makes the cache look guarded when it is not. It is also
what made `pivotRows` and `wideRows` worth exporting: `shapeRows` already was, and a shaping rule
nobody can call is a shaping rule nobody can pin.

Note the asymmetry those tests record. `wideRows` keeps a repeated root id; `pivotRows` cannot,
because many rows per neuron is its *input* shape — one row per (neuron, kind, value) is what
`pivotOn` exists to fold, so the Map keyed by id is the operation rather than a dedup on top of
it.

**`CaveSource` left-joins the chain onto its own neuron list**, and the direction matters: every
neuron the segmentation knows about comes out, annotated or not. The other way round would let an
annotation base decide which neurons *exist*, and those bases routinely carry rows for ids that
have since been edited away — putting neurons in the index the connectome cannot answer a single
query about. The index cache key carries the chain, or two datasets differing only in their
annotations would share one cached table and the first one fetched would win for the session.

**Where a datastack publishes no neuron table at all, the chain _is_ the list** — which is not
that decision reversed but the case it does not cover. `DatastackSpec.neurons` is optional, and
Aedes is the example: synapses and nuclei and nothing that enumerates neurons. With no
segmentation list there is nothing to left-join onto, so `idsFromChain` takes the order from the
chain's own `neuronId` column, deduplicated for `orderOf`'s reason — an annotation base is
somebody's spreadsheet and can hold two rows for one neuron. Combining populations is then two
annotation nodes chained rather than a setting, because `joinAnnotations` is a full outer join:
`CAVE table (proofread_neurons) → FlyTable (info)` is the union of both id sets.

**What that table is actually for is worth stating, because it is narrower than it looks.**
Nothing queries *through* it. It is read for exactly two columns — the root id, which becomes the
index, and the annotation table's own primary key, which is how `spec.annotations.refColumn`
joins back — so `spec.annotations` depends on it and a datastack with neither is coherent.
Connectivity reads the roll-up view by root id, and Skeletons, Meshes and Synapses take ids off a
table, so `Input IDs → Connectivity` needs no neuron table whatsoever. What its absence costs is
enumeration: Find Neurons, Explore, and the type names `typesOf` puts on every connectivity row.
Hence the refusal names the wire to make rather than answering with an empty table, which would
read as a datastack with no neurons in it.

The node follows: `Neuron table` is no longer required, its help says any table with one row per
neuron carrying a root id will do, and `validate` asks for **a table or a wire** rather than for
the table. `registerCustomCaveSpec` registers the spec either way — withholding it for want of a
neuron table would break the id-driven nodes, which never touch it.

**The CAVE table node's Dataset input is optional, and that is not a convenience.** It was
required, which made the wiring the node's own guide describes — a datastack's table handed back
to that datastack as its labels — a **cycle**: `Dataset → CAVE table → Dataset` is two edges
between one pair in opposite directions, so `topoSort` returns both nodes in `cyclic` and the pair
goes dark with no result and nothing naming the cause. So the datastack is a param
(`flywire_fafb_public:783`, the `datasetIdFor` grammar) and the socket is the *override*: wired, it
names a different datastack to read the table out of, which is the cross-datastack case and the
only one the wire was ever needed for. Found by writing the node's first test, which is exactly
the gap invariant 5's corollary records about `out.barChart`.

### SeaTable, verified rather than read

Everything here was probed live against FlyTable. Four calls, and the auth scheme is **`Token`**,
not `Bearer`, on every one — a Bearer JWT gets `403 invalid token`, which blames the credential
rather than the scheme.

```text
GET  {host}/api/v2.1/workspaces/                                → bases, by workspace
GET  {host}/api/v2.1/workspace/{ws}/dtable/{base}/access-token/ → JWT + uuid + dtable_server
GET  {server}/api/v1/dtables/{uuid}/metadata/                   → tables and their columns
GET  {server}/api/v1/dtables/{uuid}/rows/?table_name=…&limit=…  → the rows
```

- **An account token, not a base API token**, and the distinction cost four failed probes. The
  documented "app access token" exchange takes a token minted *for one base*; an account token
  answers `Permission denied` there and works everywhere else. It is also the better credential
  to ask for: one reaches every base the account can see. The message says so, because the
  server's does not.
- **The rows endpoint has no column selection, and the one that does cannot be reached from a
  browser.** `/dtable-db/api/v1/query/` takes SQL and answers 200 — with no ACAO header. So a
  whole-table read is every column: FlyWire's `main.info` is 58,340 rows over 60 columns at
  **~79 MB**, in six pages of 10,000, and **SeaTable does not gzip**. The node's `Columns` param
  changes what is *kept*, not what is transferred. Cached in IndexedDB, so it is paid once per
  base; measured end to end at **19.8 s**.
- **Ids are already text.** `root_id` comes back as `"720575940621522189"`, so it round-trips
  exactly and meets CAVE's string ids with no conversion. That is the half of invariant 8 that
  was free, and it is why these two backends join at all — the live test asserts most of a
  sample is genuinely beyond double precision, because an id merely *ending* in zeroes proves
  nothing.
- **Pages are sequential, not concurrent.** `start` is an offset into a base that is being edited
  while you read it; firing six at once is how a page gets read twice and another missed.
- **The workspace is worked out, not asked for.** A base is addressed by workspace *and* name,
  which is the API's bookkeeping rather than anybody's question — measured on the real FlyTable
  account, **46 bases across 13 workspaces and not one duplicated name**, so the field was never
  once needed there. Empty now resolves from the listing and only genuine ambiguity is refused,
  naming the workspaces rather than picking one. Exact match first, then case-insensitively,
  because a base name is something people retype; the ambiguity rule guards both passes, so the
  second cannot quietly choose between two bases.

  `discovery` is keyed on `host|base` and deliberately **not** on the workspace as typed: the peek
  runs on the typed config and the run on the *resolved* one, so with the workspace usually empty
  the two never met and inference paid its own access-token-plus-metadata round trip per base for
  an entry the run had already filled. A base name that is ambiguous is refused rather than
  resolved, so the name alone identifies whatever was successfully opened.

  Three things about it. The **resolution happens before the cache key is taken**, so `main` and
  `5 / main` are one entry — `main.info` is ~79 MB, so keying on what somebody typed rather than
  on what it means is a second twenty-second download and a second copy in IndexedDB. A ref that
  *names* its workspace **never lists at all**, which is a round trip saved and an account whose
  `/workspaces/` is slow or forbidden still able to open a base it has the id for. And
  `peekBases` — which `validate` reads — is the one peek here that **starts no fetch**: it runs on
  every graph mutation and would otherwise issue a listing, and with no token an auth-failure
  popup, for a node somebody is still typing into. In practice it is loaded by the time it
  matters, because `peekColumns` resolves the same base.

  It also fixes a card refusing over something it does not draw: `workspace` is `advanced`, so
  the old requirement was a badge pointing at an inspector-only field.

**FlyTable cannot be read from a browser at all, and the live test could not see it.**
`live.test.ts` runs in Node, where `fetch` does no CORS enforcement — so "probed live" covered
every endpoint shape and none of the browser's actual constraint. Measured against the
deployment: **zero `Access-Control-*` headers on any response**, and the `OPTIONS` preflight
reaching Django and answering `403 Authentication credentials were not provided` before any CORS
middleware could run. Not an allowlist — four different `Origin` values produce the same nothing.
`cloud.seatable.io`, the same software hosted, answers the preflight 204 with
`Access-Control-Allow-Origin: *`, so the two deployments differ entirely in this and the code
cannot assume either.

So `request` **tries and remembers**. That machinery is now **one module**, `data/routeMemory.ts`
— it was written by hand three times (neuPrint's client, this one, and `transport.ts`'s in-memory
variant), which is three statements of rules whose violation is invisible. What is shared is the
memory and the preference ordering; the *loop* stays with each caller, because what a status
means, which errors travel on the auth channel and what a failure should say are per-backend. The
three rules: only a *thrown* fetch moves on (a
response of any status means the request arrived), only a **2xx** is remembered (a 404 is what a
static host answers for a relay path nobody serves, and pinning that would outlive the day the
deployment gains CORS), and an `AbortError` is never answered by trying elsewhere. Direct is
first, because the hosted service needs no relay and asking for one would fail on a static
deploy. The relay is `/st/<encoded-origin>/<path>`, served by the **same** `vite.config.ts`
plugin `/np/` uses — one handler, because the SSRF guard is the part that must not be copied.

**The relay is a development answer, not a fix.** A static deploy serves nothing at that path,
so the published build cannot reach FlyTable until the deployment sends the headers.
`docs/flytable-cors.md` is the nginx config, and the four things in it each fail silently on
their own — the preflight answered before authentication (a browser sends `OPTIONS` with no
`Authorization`, which is why it reaches Django and 403s), `Authorization` in the allow list,
`always` so the headers survive a 401 (without which `reportAuthFailure` cannot read the status
and a rejected token reads as an unreachable host), and per-`location` repetition, since
`add_header` does not inherit into a block that has one of its own.

**Two things about that config were got wrong first, and both are worth knowing before touching
another deployment.** `/dtable-server/` and `/dtable-db/` **already send their own CORS
headers**, so adding a second is not belt-and-braces — two `Access-Control-Allow-Origin` headers
on one response make a browser reject it, which would break the half that works. And the
endpoint SeaTable's own documentation points a browser at, `/api/v2.1/dtable/app-access-token/`,
is not the one Coda calls: it takes a token minted **for one base** and answers an account token
`403 Permission denied`. So the two locations that need opening are `= /api/v2.1/workspaces/`
and an anchored regex for `/api/v2.1/workspace/{ws}/dtable/{base}/access-token/` — pinned rather
than a `/api/` prefix, which would expose the whole of seahub's v2.1 API.

**The `*` is load-bearing and must not become an echoed origin.** These endpoints also accept a
Django session cookie, and a literal `*` makes a browser refuse to attach cookies at all — so
the cookie path is structurally unavailable rather than merely unused, and only the
`Authorization: Token …` flow works. An echoed origin plus `Allow-Credentials` would let any
permitted origin mint tokens for a logged-in user, and `SameSite=Lax` is no backstop on this
host: `ac.uk` is a public suffix, so every `*.cam.ac.uk` server counts as same-site.

Verified in a real browser over CDP against `pnpm dev`, which is the only thing that could:
direct throws `TypeError: Failed to fetch`, the relay returns the data, `cloud.seatable.io`
direct answers without one, and the full client path — `listBases` 46 bases and `readMetadata`
through the `/dtable-server/` prefix — works with the route remembered as `proxy`.

### The CAVE table provider, and where its line falls

It reads a table carrying a root id **directly**, wide or long — `pivotOn` turns a
one-row-per-(neuron, kind, value) table into columns, reusing the per-kind split `CaveSource`
already needed for the 500,000-row cap. FlyWire's `hierarchical_neuron_annotations` is *not* such
a table: it is keyed by `target_id` into `proofread_neurons`, so reading it needs a join only the
datastack's own spec knows how to write. That stays in `CaveSource` as the built-in, which is
what a dataset uses when nothing is wired — and keeping it there is what lets this provider be
about *tables* rather than about FlyWire.

**`peekColumns` is synchronous and answers `undefined` until it knows**, the same contract
`schemasFor` has and for the same reason. A wide table answers immediately from the ref; a long
one has to ask the server what its kinds are, and does it once per ref through the 52 kB
`unique_string_values` call. `reportAnnotationsLearned` is the third thing wired to
`afterSourceLearned` — dataset listings, upload schemas, and now these: three asynchronous facts
that inference reads synchronously, one handler.

### Google Sheets, and the provider with no credential

`annotation.googleSheet`, `Add ▸ Dataset ▸ Google Sheet`. A sheet shared as **"anyone with the
link can view"** read through its plain CSV export URL — `src/data/annotations/googleSheet.ts`.
The third provider and the first that authenticates nothing: there is no token to store, no
auth-failure channel and nothing for the Connections panel to offer, which is most of why it
earns a node rather than being left to `Table from URL` pointed at a hand-built address. A lab's
cell typing lives in a Google Sheet at least as often as it lives in a SeaTable base.

Everything below was probed live rather than read off documentation.

**Both hops of the redirect carry CORS, which is the finding the whole thing rests on.**
`docs.google.com/…/export` answers `307` with `access-control-allow-origin` echoing the
requesting origin, and the `doc-XX-XX-sheets.googleusercontent.com` target it names answers `200`
with `*`. A browser CORS-checks *every* hop, so one link missing a usable header would block the
fetch before it reached the data — which is exactly the trap `core.tableFromUrl`'s guide records
about GitHub's `/raw/refs/heads/` redirect, whose first hop sends an **empty** ACAO. Here both are
open, so there is no relay, no `/gs` proxy prefix and no `routeMemory`: the one route that exists
is known to work. **Confirmed from a real page origin over CDP**, which is the only thing that
could — Node's `fetch` does no CORS enforcement, which is precisely the gap `docs/flytable-cors.md`
records having been caught by.

**The tab is chosen by `gid`, and that is not a preference.** Measured on one sheet:

```text
export?format=csv&gid=999999    → 400        loud
export?format=csv&sheet=Nope    → 200 …      the FIRST tab, silently
gviz/tq?tqx=out:json&sheet=Nope → status ok  the FIRST tab, silently
```

A tab name typed wrong does not fail, it hands back different data under a green node. A `gid`
typed wrong is a 400. Nobody has to type one either: it is in the URL people copy out of the
address bar, so `parseSheetLocation` lifts it from the fragment or the query and the Tab field is
only ever an override.

**`gviz/tq?tqx=out:csv` is not used, for a second reason:** it pads every row out to the sheet's
full column range — a six-column table came back as twenty-two, sixteen of them `""` — so a table
read from it carries sixteen blank columns in every picker downstream. `export?format=csv` returns
the used range and nothing else.

**A publish-to-web link is refused by name rather than mangled.** `/spreadsheets/d/e/2PACX-…/pub`
is a *different* id space that only `…/pub?output=csv` serves; `/export` does not know those ids
at all, and the `/d/` in it means a naive match reads the id as the literal `e` — a 404 blaming
the sheet. The message names the link to use instead, which is one somebody already has.

**A missing document and a Restricted one are two different failures, and telling them apart
cost the message being wrong first.** A **Restricted** sheet — the sharing default, and the thing
people hit before anything else — does not answer a status a page can read: `docs.google.com`
`302`s to `accounts.google.com/ServiceLogin`, which sends **no `Access-Control-*` at all**, and a
browser CORS-checks every hop. So the fetch dies as an opaque `TypeError` with
`corsError: MissingAllowOriginHeader`, and the first version of this node reported *"the export
URL is readable cross-origin, so this is a network failure"* — confidently wrong, and it sends
somebody to check their wifi over a share setting.

**`curl` answers this endpoint differently from a browser, which is what produced that bug.** The
same request from curl comes back a bare `401` **with** CORS headers and no redirect, so the code
was written against a response no browser ever sees. Probing with curl alone was not enough here;
what settled it was Chrome's own `Network.loadingFailed`. Treat that as the standing lesson —
this is the second time a Google/CORS fact has only been visible from inside a browser.

**So the two causes are told apart with one extra request, on the failure path only.**
`explainFailure` re-issues the read with **`redirect: 'manual'`**, which does not follow — and
therefore does not CORS-check — the second hop, so a sheet Google wants a login for comes back as
an **opaque redirect** rather than throwing. That is decisive precisely *because* the ordinary
path already threw: a public sheet also redirects, but it redirects somewhere readable and never
reaches this function. A probe that throws too means the host is genuinely unreachable, and there
is no third possibility, since this provider talks to one host and that host demonstrably sends
CORS headers. Verified in a browser against a real Restricted sheet.

A document that does not exist still answers a readable **`404`**, so that message names the
**id** rather than offering both causes. There is deliberately **no `reportAuthFailure`** on any
of it: that channel opens the Connections panel so somebody can fix a credential, and this
provider has none. The fix is in Google's own share dialog, so the message names the setting.

**The cache is keyed on the *tab*, and the shaping happens after it** — the one place this
departs from its two siblings, which cache the finished annotation table. The two halves have
completely different costs here: the download is the whole expense and the shaping is a
projection, and unlike a SeaTable or CAVE ref there is nothing about `columns`/`idColumn` that
changes what the *server* sends. Keyed per ref, editing the ID column would re-download a
spreadsheet to rename a column already in hand. `SHAPE_FORMAT` still guards what is stored and
still means what it says, because the parse *is* the shaping at that layer.

**`peekColumns` starts the read, and the read is the download.** There is no metadata endpoint —
a sheet publishes its shape only by handing over its contents — which would make this expensive
if it were paid twice. It is not: the peek goes through `cachedAnnotationTable`, so it fills
IndexedDB and the first Run finds it there.

**What is cached and what is guarded are both the *tab*, and getting the second wrong cost a full
re-shape per keystroke.** `discovery` was keyed on the whole config, so every distinct value of
the free-text `ID column` and `Columns` fields ran the entire pipeline and read `.schema` off the
result — an O(rows × columns) walk allocating a second copy of the table, discarded, twice per
graph mutation. Worse, `loadCachedTable` does not retain failures, so an unshared sheet was
*re-fetched* per keystroke, which is the opposite of the once-per-ref guard the method exists to
be. `sheetSchema` is now the schema half split out of `shapeSheet` — the peek derives it
synchronously from the parsed tab's schema and touches no row, and `shapeSheet` calls it rather
than restating it, so invariant 3 holds by construction. `seaTable.ts`'s `baseKey` records the
same class of mistake from the other side. Measured in a browser on a real sheet: the card read
`8ms · cached 25s ago ⟳` after Run, and the output socket already said
`Annotations: Neurons{neuronId, Gender, Major}` *before* anything had been run. The bytes move
earlier rather than being spent again. Once per ref and never retried, invariant 2's corollary —
which is also why `ID_PATTERN` has a 20-character floor: without one, every prefix of an id
somebody is typing would be a ref and a request that 404s.

**A named column the tab does not have is dropped rather than emitted as nulls**, which is where
this parts company with `wideRows` and `shapeRows` — those cannot see the server's column list
without a round trip and this one has already parsed it. A column of nulls is the quiet wrong
answer; `validate` names the missing one out loud instead, as a *warning*, because the other
columns are still worth having. The **id** column is the one that refuses, naming what the tab
does have, since without it there is nothing to join.

**Dtypes come from `parseDelimited`**, so invariant 8 is free here: `inferDType` refuses a numeric
reading of any value that would not survive a round trip through a double, which keeps an
eighteen-digit root id as text. The id is `String`-ed and declared `str` on top of that, because a
sheet of nine-digit neuPrint ids parses as `i64` and every consumer keys on `neuronId` as a string.

**One resolution, three consumers.** `sheetConfigFrom` in `googleSheet.ts` turns a node's params
into a `GoogleSheetConfig`, and the node and both emitters call it. Sharing `parseSheetLocation`
and `sheetExportUrl` and then re-deriving their *arguments* per consumer leaves the failure the
sharing was for still reachable — the Tab field overrides the pasted link, and that precedence is
precisely what decides which tab a generated notebook reads. It also collapses the double parse
`validate` and `evaluate` were each doing on every keystroke.

**The fetch-read-parse-refuse body is `readDelimitedResponse` in `data/csv.ts`,** shared with
`core.tableFromUrl`, which this was written as a copy of — comments included. What was duplicated
is not boilerplate: it is the `MAX_UPLOAD_BYTES` ceiling stated twice and the rule that a 200
parsing to nothing must quote what arrived. The *fetch* is deliberately not shared, because what
a thrown fetch means differs completely between the two — see below.

**Both exporters emit it, and it is the only annotation source that does.** That is not a gap in
the other two: FlyTable is `sea-serpent`, which has no natverse counterpart, and a CAVE table is
caveclient, which R refuses the whole graph over. This one needs no client, so `pd.read_csv` and
`readr::read_csv` reach it directly — which is also why it sits in `everythingGraph` rather than
in `caveGraph`, chained onto the Upload node so the join branch is recorded rather than only the
bare cell.

Each language has one trap and it is the same trap from opposite directions, and **each was caught
by running the generated helper rather than by reading it**. pandas types a column of
eighteen-digit ids as `int64` — exact — and as `float64` the moment one row is blank, at which
point `720575940628857210` comes back as `720575940628857216`: a different neuron, and two
adjacent ids collapsing onto one. R has no 64-bit integer at all, so readr guessing gives a double
and the same value. Both force the id column to text at the read — `dtype={id_column: 'string'}`
and a `readr::cols` spec — and dropping either fails two checks in the probes and nothing else in
the tree.

**`scripts/probe-r-helpers.R` (`pnpm probe:r-helpers`) is new**, and it is `probe-py-helpers.py`
one language over for that reason: `check-export.R` parses the chunks and resolves function names
and stops there, so before this **nothing executed a line of generated R**. It reads the helper
chunk out of the golden `.Rmd` rather than a transcription, needs no token and no network, and
runs in `export.yml` beside its Python twin, where readr and dplyr are already installed. Coming
with it are R's first `coda_annotation_columns` and `coda_join_annotations`, ported from
`annotationColumn` and `joinAnnotations` — the second because a chain that silently ignored its
upstream would be the control that quietly does nothing.

**+7.82 kB raw / +1.95 kB gzipped on the main chunk** (1,154,422 → 1,162,245), measured against a
build of `HEAD` in a clean worktree. Both exporter chunks carry `coda_google_sheet` and `main`
carries none of it.

**A live test, gated on `GOOGLE_SHEET_LIVE=1`** rather than on a credential, since there is none
to withhold — `catmaid/live.test.ts`' idiom. It reads Google's own published `Class Data` sample
and asserts the CORS header on the final hop, which is the thing that would notice the export
endpoint changing and which every recorded-reply test in the tree would sail past.

### Backends, told apart

`BACKENDS` in `datasetFamilies.ts` — a table, because "which backend" is now three things a
reader needs and a fourth backend should be one entry rather than four edits.

- **The backend is in the name**: `MaleCNS (neuPrint)`, `FlyWire FAFB (CAVE)`. Not decoration —
  one dataset can be published on more than one backend, and without the suffix two nodes in the
  Add menu would read identically and behave differently. A backend with an empty label adds
  nothing, which is what keeps `Hemibrain (mini)` from becoming `Hemibrain (mini) (Mock)`. **The
  node type ids are untouched**: that is what a saved graph carries.
- **The card is tinted by backend**, through `--cat-dataset-<id>`. A *lightness* step within the
  one green, not a second hue: deuteranopia and protanopia collapse red-green hue differences and
  leave lightness intact, so two greens a stop apart separate for every reader while a green and
  a teal separate for only some — and the category palette was validated as a set, so a genuinely
  new hue would mean re-running the validator against the sockets too. The step is deliberately
  large; a small one reads as a rendering artefact.
- **The browser tile carries a pip**, which is the non-colour channel. A grid shows dozens of
  tiles at once and two greens are a weaker signal at that size than on a card. One lit pip in a
  fixed slot, so it is positional rather than a count to read.
- **`Custom CAVE`** joins `Custom neuPrint`, and needs more than it: a datastack has no
  privileged table, so the node names its neuron table and registers a spec through
  `registerDatastackSpec` — synchronously and with no network, `neuPrintSourceFor`'s rule.
  (`Custom CATMAID` completes the set; the three are listed in `CUSTOM_DATASET_NODES` — see
  *One escape hatch per backend* under **Dataset nodes**.)

  **Its Materialization is a dropdown fed by a per-datastack peek**, not by the listing. That is
  forced rather than chosen: `listDatasets` lists only datastacks with a spec in the *static*
  table, so a datastack somebody has just typed is not in it and never will be.
  `peekMaterializations` is `schemasFor`'s contract again — synchronous, `undefined` until it
  knows, starts the fetch once per datastack and re-infers through `reportSourceLearned` — with
  `materializationsFor` as its awaited half, which `evaluate` uses. One memo behind both, so the
  materialization the dropdown *shows* and the one a run *uses* cannot disagree.

  Three things about it, each of which is a state somebody actually sees. **The empty select is
  said in words**: `Name a datastack first` before one is typed, because a dropdown with nothing
  in it reads as a broken control. **A pinned value is kept as an option while the list is
  unknown** — the family nodes need no such thing, since their listing is one call every dataset
  node shares, where this one is per-datastack and so absent on *every* reload; without it a
  pinned materialization blanks for a second and reads as forgotten. And **`evaluate` resolves
  "latest" by fetching rather than by peeking**, or an unpinned node fails on the first press and
  works on the second — the runs-twice-answers-differently signature this codebase keeps being
  caught by. `dataset.test.ts` pins all three, and the last two were confirmed by mutation.

  The `validate` order matters too: the shipped-datastack collision is checked **first**, because
  `specFor` prefers the static table, so every other setting on the card is inert for a datastack
  that already has a node — and asking for a neuron table first answers a question that does not
  matter.

**The Annotations socket takes an ordinary table, and used to be its own type.** It had the
dataset hue and the `diamond` shape and described the contract exactly — and that is what made it
wrong. An annotation base is somebody's spreadsheet: it routinely wants a row dropped or sixty
columns narrowed to four *before* a connectome is labelled by it, and a bespoke socket type meant
no table op could touch one. `FlyTable → Filter → Sort → Dataset` is now an ordinary wire, and so
is `Upload Table → Dataset` for a lab's own cell typing, which was impossible outright. The socket
takes the table hue, which is honest.

**`T.table()` and not `T.neurons()`, though every source does guarantee a `neuronId`.** Filter,
Sort, Sample, Stack and `out.table` all *preserve* neurons-ness — checked, and each says so — so
the stricter socket accepts every op somebody names first and then refuses `core.select`, which
publishes a plain `table` because a selection *may* drop the id. Narrowing sixty columns to four
is as ordinary a clean-up as dropping a row, so that is the case the type has to admit. "Has this
column" is not a question assignability answers here; `types.ts` says so outright, and the
requirement moved to `validate`, where it can name the column. `annotations.test.ts` pins the
Select case specifically, because the Filter case passes under *either* socket type — a test
built on it would have looked like it was defending the choice while defending nothing.

**And `validate` only warns, so `annotationsFrom` refuses at run time as well.** The two things a
run could do instead are both silent: ignoring the wire is the control that quietly does nothing,
and carrying it on leaves `withAnnotations` merging a schema with no id column, so every neuron
comes back unlabelled with the connectome to blame. One funnel, so the two dataset nodes cannot
disagree about which.

**What identifies an annotation table is now provenance, not the refs that fetched it.**
`AnnotationsValue` was `{kind, sources, table}` and is now `DatasetAnnotations` — `{key, table}`,
a field of `DatasetValue` rather than a member of the `Value` union. `sources` was the chain's
`refKey`s, and the moment a Filter is allowed to stand in the chain those stop describing the
table: two graphs filtering one base differently would share a cached neuron index, and the first
one fetched would win for the session — precisely the failure the chain key was added to prevent.
So the dataset node pairs the table with **`ctx.inputKey('annotations')`**, the scheduler's own
`hash(type, params, upstream)` for whatever arrived on that port. It keys the CAVE neuron index,
the Explore widget's shared entry and the profile cache, exactly as `chainKey` did.

**`ctx.inputKey(portId)` is new on `EvalContext`**, and the scheduler was already computing it —
`desiredKeys` builds `${key}:${handle}` per port to fold into the hash, and `upstreamKey` is now
that one spelling shared by both. Deliberately *per port* rather than the node's own key, which
would fold in params of this node that say nothing about the value on that port.

It also closed a latent bug rather than only enabling the feature. `refKey` is `provider:config`
and `refresh` is in neither `seaRef` nor `caveRef`, so bumping an annotation node's Refresh
re-downloaded the base and re-ran the dataset — and then `neuronIndex` hit the same `chainKey`
with the same column fingerprint and served the stale index. Traced rather than reproduced;
provenance keying makes it structurally impossible.

**Connections gained a fourth section rather than two more source tabs.** The top level there is
*what kind of connection*, and an annotation base is somebody's spreadsheet of labels joined onto
a connectome — filing FlyTable under Data sources would say it was a fourth backend you could
query for neurons. Same split, same reasoning, as the AI key.

### Root ids drift, and the dataset says so

A CAVE root id is retired by any proofreading edit that touches its segment, so an annotation
base — somebody's spreadsheet, edited on its own schedule — drifts out of step with a **pinned**
materialization on its own. Nothing fails when it does: the labels stop matching, those rows join
to nothing, and the dataset reads as under-annotated. `data/cave/rootIds.ts` is the heads-up.

`caveclient.chunkedgraph.is_latest_roots`, read off caveclient 8.2.1 rather than recalled:
`POST {cg}/segmentation/api/v1/table/{table}/is_latest_roots?timestamp=<epoch seconds>` with
`{"node_ids": […]}` → `{"is_latest": […]}`. The timestamp is the materialization's own
`time_stamp`, which `versionsMetadata` already returns and `datastack.ts` was throwing away — so
it costs no extra round trip.

**And CAVE writes that instant with no zone on it and means UTC, which `Date.parse` does not.**
`"2023-08-29T00:00:00.000000"` is a date-*time* string with no offset, and ECMA-262 reads one of
those as **local** time — so `Date.parse` turned the same reply into a different instant on every
machine: an hour out in London for half the year, seven in `America/Los_Angeles`. That it is UTC
is not a guess; caveclient parses the same field with
`datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%f").replace(tzinfo=timezone.utc)`.

The damage is silent and is not confined to a display. This instant is what `is_latest_roots` and
`roots_binary` are asked *at*, **and** it is folded into the permanent cache key beside them — so a
skewed one asks the chunkedgraph about a moment the materialization was never frozen at and then
keeps the wrong answer forever. On a proofread datastack that makes `Update root IDs` write root
ids that do not exist in the pinned materialization, which is the exact drift it exists to repair.

`parseCaveTimestamp` is the rule and `versionFrozenAt` answers the **instant** rather than the
string, which is what stops it being got wrong twice: nothing outside `datastack.ts` sees the raw
field except `datasetInfoFor`, which only slices a date out of it for prose. An offset already on
the string is honoured, so a deployment that starts sending one is not shifted twice.

**The test could not have caught it, and that is the part worth carrying.** It asserted
`timestamp=${Date.parse(STAMP) / 1000}` — the same expression the code used — so it agreed with
whatever that expression produced. A value a test derives the way the code derives it is not an
assertion. It is written out as a literal now, with the three spellings of one instant asserted
to agree.

**It is fired and forgotten.** `evaluate` starts it and returns; the answer lands on
`subscribeRootCheck`, the **fourth** thing wired to `afterSourceLearned`, and `validate` reads it.
So a run is never delayed by it and never fails because of it, which is right for an advisory
about data the node did not fetch — and it is a *warning*, since an id that moved on is a fact
about somebody's base rather than a mistake in this graph.

**Four things keep it off the service**, which matters because this is a shared production
chunkedgraph at roughly 50–100 µs a root:

- **Once per (dataset, chain).** The ids arrive on every run, so re-asking per run is the
  hammering to avoid — and never re-asking at all leaves the answer describing a wiring that is no
  longer on the canvas, which is the bug below.
- **Cached per (segmentation, frozen timestamp), permanently.** Whether a root was current at a
  past instant *never changes*, so the answer is good forever — no expiry is passed to `cacheGet`
  at all. Keyed on the segmentation and the instant rather than on the dataset or the id list, so
  two datastack nodes share it and a base that gained rows costs only the rows it gained.
- **Only ids nobody has asked about**, which is what that key buys.
- **Deduplicated, and sequential in chunks of 10,000.** An annotation base repeats ids — 1,089 of
  them on FlyTable's `main.info`, one 104 times — and firing every chunk at once is the same
  hammering by another route.

**The body is written as text**, because `node_ids` is a list of integers on the wire and an
eighteen-digit root id through `JSON.stringify` of a `number` is a different neuron (invariant 8)
— while *quoting* them is a type this endpoint was never promised to accept. `cavePostRaw` exists
for that one case; every other CAVE POST goes through `cavePost`. The query endpoint's own
tolerance of quoted ids was established live and does **not** transfer to this one.

**And it answers to the wiring, which it did not at first.** The report was keyed on the dataset
id alone and taken *once per session*, so the check was never re-asked: dropping an `Update root
IDs` into the chain left the warning up, and pulling one back out never raised it. Both directions
reported, and each reads as the opposite feature being broken — the repair not working, or the
advisory not noticing.

The fix is that a report records **which chain it is about**, and the chain's name is
`ctx.inputKey('annotations')` — the same provenance key the dataset node already pairs with the
table, which changes exactly when the table would (invariant 4). Four rules fall out, and each was
mutation-checked because every one of them fails as a *plausible* warning rather than as an error:

- **A new key drops the old answer immediately**, before the replacement lands. It was about a
  chain that is no longer there, and a warning that outlives the repair it asked for is the
  original bug wearing a shorter timeout.
- **The drop is announced on `subscribeRootCheck`.** A run does not re-infer, so nothing else
  would re-run `validate` — the warning would sit on the card until an unrelated edit, which is
  precisely what "it didn't work" looked like.
- **Nothing wired is a real key**, not a reason to keep the last one. Otherwise unplugging the
  annotations leaves a warning naming ids the graph no longer holds.
- **A late lander does not overwrite a newer chain.** The repaired ids are the ones the permanent
  cache already knows, so the *replacement* check routinely finishes first and the superseded one
  arrives after it — restoring the warning somebody just cleared, permanently.

A failure releases the claim so the next run asks again, where a settled "nothing to say" — no
chunkedgraph, no timestamp — keeps it: a dropped connection is not an answer, and a datastack with
no chunkedgraph will never have one.

The known limit, stated on `rootDriftIssues`: the report is keyed on the **dataset id**, which is
all `validate` can see (an `InferContext` carries params, types and nothing else), so two dataset
nodes on one datastack and materialization with different annotation chains share one entry and
whichever ran last owns it. Uncommon, and the message says what was checked rather than whose it
was.

### Update root IDs: the repair

`cave.updateRootIds`, `Add ▸ Transform ▸ Update root IDs`. The drift check above says an
annotation base has fallen behind a materialization; this brings it forward, and the warning names
it so somebody reading one arrives at the other.

**A supervoxel is what makes a repair possible at all.** It is the atom of the segmentation —
proofreading regroups supervoxels, it does not split them — so a supervoxel id is the stable
handle a root id is not, and `get_roots(sv, timestamp)` answers which segment it belonged to at
any past instant. A row without one is left alone: there is nothing to recover from, and a stale
id is a better answer than a null or a dropped row.

**The staleness check runs first, and that is the whole cost control.** Only rows whose root is
*not* current are looked up, so an unedited base costs one `is_latest_roots` pass and **no**
`get_roots` at all. Both answers are cached permanently and keyed on (segmentation, frozen
timestamp), for the reason the advisory's are: what a root or a supervoxel was at a *past* instant
never changes.

**`roots_binary` is the one CAVE endpoint here that is not JSON**, and for once that makes
invariant 8 easy: raw `uint64` in and out, so a `BigUint64Array` carries an eighteen-digit id
exactly with nothing parsed, rounded or quoted. `cavePostBinary` exists for it — its own function
rather than an option on `request`, which parses JSON unconditionally.

**The id column keeps its storage, read off the schema rather than off row zero.** A CAVE id
column is `str` and stays text; a table holding them as numbers keeps doing so rather than changing
dtype under every picker downstream, and `idText` refuses a number too wide to be exact so nothing
silently rounds. It asked `typeof ids[0] === 'number'`, which decides a whole column from one
value — so a table whose first row has no id, which an annotation base routinely has, wrote strings
into an `i64` column: invariant 3 broken by the node whose whole job is repair, and silent until
something downstream sorted or compared them.

The guard in the rewrite loop — only touch a row whose id was *stale* — reads as redundant, since
only stale rows are ever asked about. It stops being redundant the moment the cache is warm: the
supervoxel map is permanent and shared across runs and datasets, so a later run can hold a root
for a row that did not move, and without the guard that row is silently rewritten. Pinned by a
test that seeds the cache, after a mutation showed the obvious test could not see it.

Its Dataset input is a **reference** — see the reference-edges section — which is what lets it sit
between an annotation source and the dataset it feeds. That wiring was a cycle until references
existed, and it is the placement the node is for.

Not exported: named in both `NO_EMITTER`s, since it is caveclient's chunkedgraph and only ever
sits on a CAVE dataset, whose own node is excused for the same reason.

### What is not done

The **R** exporter emits almost none of it — `dataset.flywire`, `dataset.cave` and the CAVE and
SeaTable annotation nodes are named in its `NO_EMITTER`, and a CAVE graph is refused outright
there. `Google Sheet` is the exception and emits in both languages, because it needs no client:
see its own section. Python emits all six; see *The CAVE half of the notebook exporter* below for
what it does and does not reach.

A node body for the annotation sources — a base and table picker fed by `listBases`/`readMetadata`
rather than two text fields — is the obvious next thing; the client methods it needs already exist
and are what the Connections tab's Test button uses.

Not looked at in a browser: the tints, the tile pips and the chain on a real canvas. Same
standing as the WebGL viewers.
