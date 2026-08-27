# Dataset nodes and what arrives with them

The family table, the companion card, auto-wiring, and the starter graphs.

Moved verbatim out of `CLAUDE.md`.


## Dataset nodes

**One node per dataset, not one generic picker.** `Add ▶ Dataset ▶ MaleCNS` replaces choosing a
backend and then a dataset within it; the node arrives already pointed somewhere and asks only
for a version. The old `neuron.dataset` is still registered and `hidden`.

**The family list is static; everything that changes is live.** Node types must exist at module
load — the store resolves them the moment it deserialises the autosaved graph, so a type
registered after a listing resolved would make a saved graph visibly lose its nodes. A dataset
listing is a network call. Those cannot both be satisfied by generating nodes from the listing,
so `nodes/lib/datasetFamilies.ts` holds one static entry per family carrying _only_ presentation
(label, blurb, glyph), and versions, ROIs, schemas and counts are all read from the source. A
family Janelia adds later needs a line there; `Custom neuPrint` covers it meanwhile. Verified
against the live listing: the visible families are exactly fib19, hemibrain, male-cns, manc,
mushroombody and optic-lobe (banc and wasp3 are `hidden: True` server-side).

**An empty `version` means latest, resolved identically at infer and eval time** so the
provenance key cannot disagree with what ran. The dropdown's first option is labelled
`Latest (v1.2.3)` rather than `Latest` — an unnamed "latest" is a provenance question mark on
every shared graph. A _pinned_ version that the server no longer lists is kept, not silently
upgraded, and `validate` reports it.

`compareVersions` compares numeric segments, so `v1.2.3` > `v1.2.1` > `v1.0` and a future
`v1.10` > `v1.9`. A string sort gets today's data right by luck and that one wrong.

**"Server" means two different things and they are not interchangeable.**

|                             | means                                          | example                        |
| --------------------------- | ---------------------------------------------- | ------------------------------ |
| a dataset node's `Server`   | a neuPrint **deployment**                      | `https://neuprint.janelia.org` |
| Connections → `Base URL`    | an **override** of the URL the browser fetches | `/neuprint`                    |

`data/neuprint/servers.ts` maps a deployment to the routes worth trying. **An empty `Base URL`
is a real answer, not a synonym for the proxy**, and that distinction was a bug: the field used
to fall back to `/neuprint` when cleared, so "remove the proxy" silently meant "use the proxy"
and the field appeared to revert on its own. Empty now means work it out; naming a URL collapses
it to that one route with **no fallback**, because somebody who named a base has said where the
request goes and quietly trying elsewhere would report success for a wrong entry. The override
applies to the **default deployment only** — a Custom node names its own origin, and letting an
override capture it would send one deployment's queries to another's proxy.

A non-default deployment falls back to `/np/<encoded-deployment>/…`, served by the
`deploymentProxy` plugin in `vite.config.ts`. **That plugin refuses anything but https to a
public host** — a dev server that forwards wherever a page points it is an SSRF hole aimed at the
developer's own network. Note what that path costs in a static deploy, which is how this was
found: on GitHub Pages `/np/…` is served by nothing, so a Custom node pointed at a CORS-enabled
deployment used to fail with GitHub's own 404 without ever attempting the direct route that
would have worked.

`NeuPrintSource` takes a deployment in its constructor and every HTTP call goes through its
private `options()`. A call site that forgets the base URL does not fail; it quietly queries the
_default_ deployment and returns plausible data from the wrong server. `neuPrintSourceFor()`
registers one instance per deployment, lazily, from `inferOutputs` — synchronous and network-free,
which is what makes that safe.

### Two ⟳ on one card, and they mean different things

The card's own foot carries `⟳` beside the dataset id: that re-fetches the **listing** — versions,
labels, neuron counts — and bumps the `refresh` nonce so downstream re-runs. It is metadata,
kilobytes, and it is what makes a newly published version appear in the dropdown.

The node's foot below it carries `cached 3d ago ⟳`, which is about the **downloaded data**: the
neuron index behind Explore and Find Neurons, the region outlines, the roll-ups. Different size,
different lifetime, different button. `no cache` when none of it has been downloaded, which is the
state a dataset node sits in until something asks it for neurons. See
[core.md](core.md#the-dataset-card-asks-the-cache-instead-because-it-fetched-none-of-it) for why
that one has to peek at the cache rather than report what it fetched.

### One escape hatch per backend, and where somebody starts

**`Custom neuPrint`, `Custom CAVE` and `Custom CATMAID` are one kind of thing**, and
`CUSTOM_DATASET_NODES` in `datasetFamilies.ts` is the list of them. They are deliberately *not*
families — a family is a dataset Coda ships an entry for, and the whole point of these is the one
it does not — but three surfaces have to treat them alike: the New menu offers one under each
backend's heading, the canvas tints their cards through `backendForNodeType`, and a share
advisory names the credential a recipient will need. Each of those was a hand-written `if` per
backend before, and **CATMAID's was missing from all three**, which is what a missing menu item
looks like: a menu.

Nothing in that table is presentation. The label and the blurb come off the `NodeDefinition`,
which is where they already are and the only place they can stay in step with the card.

**`Custom CATMAID`'s Project is a dropdown rather than a text field**, which is the one place it
departs from its neuPrint twin, and the reason is what an id *is* on each backend. A neuPrint
dataset id is a name somebody reads off a paper (`hemibrain:v1.2.1`); a CATMAID project id is a
bare integer whose meaning is positional — `1` is FAFB on VFB and something else on a lab server —
so asking for one typed is asking somebody to go and read it out of the CATMAID web UI first.
`/projects/` is a plain GET a browser can make anonymously, so the list is simply available. It is
`Custom CAVE`'s Materialization dropdown arrived at from the same constraint, and it carries the
same two rules: **a stored value is kept as an option while the list is unknown** (per-instance,
so absent on *every* reload) — offered *plainly* there and only labelled `(not listed)` once the
server has actually answered without it, which is the looking-versus-not-here distinction
`uploadBody` records — and **the three empty states are said apart**: not listed yet, a server
that lists none, and nothing picked. There is deliberately no "Latest": a project has no
ordering, so empty means *unchosen* and `validate` says so rather than resolving one.

Its Annotations socket and edge-set params are read off `BACKENDS.catmaid` rather than written
out, so this node and the family node cannot part company about what a CATMAID dataset offers.
Both are absent today. `catmaidServerLabel` is its own two lines rather than `serverLabel`, which
is neuPrint's and normalises anything it cannot parse — an empty field included — to
`neuprint.janelia.org`: naming the wrong server in a message about a server is worse than naming
none.

**+3.08 kB raw / +1.02 kB gzipped on the main chunk**, measured against a build of `HEAD` in a
clean worktree.

**`DatasetFamily.starter` decides where somebody *begins*, and nothing else.** Absent means yes;
`starter: false` on Optic Lobe, FIB-19 and Mushroom Body keeps them out of the New menu and off
the start page's dataset rail. The node is registered either way, `Add ▸ Dataset` lists all of
them, and a saved graph holding one opens unchanged — this is not a judgement on the dataset but
on how long the first decision should be. One flag read by both surfaces rather than a filter in
each, because they build the *same* graph through `buildStarter`; a family offered in one and not
the other is a split that ends up depending on which file was edited last.

Both tests **name the three** rather than asserting `starter !== false`, which would be the menu
checked against the expression it is built from — an assertion that passes whatever the table
says.

**`hidden: true` keeps a superseded type loading without offering it.** Registration is what
makes a saved file load (an unregistered type renders as "Unknown node" and drops its params);
listing is a separate question. `listableNodeDefs()` is what the add surfaces read, `allNodeDefs()`
stays complete.

**Node bodies opt into expanding.** `NodeBodyEntry.expandable` is off by default: a dataset body
is a preview and two fields, so a fullscreen overlay of it is whitespace, and its button would sit
exactly where a viewer's does. Explore Dataset and the Description card set it; the dataset nodes do not.

The preview at the top of a dataset node is a **placeholder** — a specimen silhouette, not a
rendering of the data — but it occupies the space a real one will take. Six drawings cover every
dataset and a seventh is never required: the glyph is keyed to a coarse anatomical kind declared
in the family table, with `specimen` as the fallback, so a dataset added tomorrow is never blank.
Same rule as `NodeThumbnail`, same reason.

## A datasource is not a dataset

`Neuroglancer Source` (`dataset.ngsource`) sits in this directory and in the Dataset menu, and it
is not one of the things above. A dataset is a **connectome**: neurons with types and statuses,
connectivity, regions, a published viewer state, a version to pin. A **datasource** is a single
address holding a single kind of data — what a neuroglancer layer's `source` box names. Paste one
and `Meshes` can fetch from it, with `Input IDs` supplying the segment ids, because there is no
neuron table to pick them out of.

**It emits `Dataset` anyway, and the socket is labelled `Datasource`.** `Meshes`, `Skeletons` and
`ROI Meshes` all take a Dataset socket and resolve `dataset.sourceId` out of the registry, so a
datasource that emits one plugs into all three with no change to any of them. The distinction
lives in the socket's *label*, where somebody reading the canvas needs it, rather than in a second
type nothing could enforce anything with — a `datasource` kind assignable to `dataset` would let
exactly the same wires be made.

**`SourceCapabilities` is what keeps it honest.** `meshes`, `skeletons`, `neuronIndex` and
`roiMeshes` are gated from the same `info` — a segmentation names its mesh directory, its skeleton
directory and its segment properties in one document, so the probe learns all four at once and
each node refuses on its own card. Most segmentations name no skeleton directory at all, which is
the ordinary answer rather than an edge case. `roiMeshes` needs **both** a mesh directory and a
sidecar: without names the region picker would offer eighteen-digit segment ids.

**A source with segment properties stops needing Input IDs.** The sidecar is a neuron index, so
Explore can browse it and Find Neurons can query it — locally, through the same
`preparedRows`/`compileLabelMatch` helpers CAVE and CATMAID use, which is what stops three
backends disagreeing about whether `LC.*` matches `LPLC1`. Without one, the ids come from an Input
IDs node and the refusal says so, naming what the source publishes instead.

**Connectivity is the one thing left that refuses at Run rather than on the card.**
`fetchConnectivity` and `fetchAdjacency` are *required* members of `DataSource`, so
`PrecomputedSource` implements them by throwing — a message rather than an empty table, which
under a green node would read as a connectome with nothing connected. There is no capability for
`sourceSupports` to gate on, so the refusal lands late. The deeper fix is to make the pair
optional and add a `connectivity` capability, exactly as `fetchRoiCounts`/`roiCounts` were split
when the second backend arrived (see the account in `data/source.ts`). `findNeurons` used to be in
this paragraph and no longer is: it is answered from the sidecar, and gated by `neuronIndex`.

**The source is registered lazily, by URL.** `precomputedSourceFor` is `neuPrintSourceFor`
one-for-one: nodes resolve a source out of the global registry, so a node pointing at a bucket
needs a registered source for that bucket, and the only moment that can happen is when something
asks. Hence no entry in `builtins.ts` — there is no default bucket the way there is a default
neuPrint deployment. The key is the canonical spelling, so `precomputed://gs://b/p`, `gs://b/p/`
and `gs://b/p|neuroglancer-precomputed:` share one instance; two instances would re-probe the same
`info` and give two nodes different dataset ids for one directory, which downstream reads as two
datasets.

**It emits a second thing, and that is why it is worth one node rather than two.** The `Layers`
output is a neuroglancer layer object pointed at the same URL, for the Neuroglancer node's
`Extra layers` socket — a brain shell, a second dataset's segmentation, somebody's own annotation
source. One node because the two outputs answer the same question ("what is at this address") and
a second node would ask for the URL twice; the layer-only params are all `advanced`, so the card
stays the one field that has to be right.

**More than one layer chains.** An input port takes exactly one wire (`core/graph.ts`), so
`Datasource → Datasource → Neuroglancer` is how two layers reach one scene, in wiring order. That
is `Stack`'s answer to the same constraint rather than a new idiom, and it is why the node has a
`Layers` **input** as well as an output.

**The settings blob is merged last, so your keys win.** Anything neuroglancer accepts —
`objectAlpha`, `segmentDefaultColor`, a shader — is reachable without this node growing a control
for it, including the keys it generates itself. A field that could not override `name` would be an
arbitrary exception somebody has to discover. Bad JSON is reported on the card rather than at Run,
because it is the one field here whose mistake is a typo: a missing brace contributing nothing
silently looks exactly like a setting neuroglancer ignored.

**Segment ids stay text on the way out.** Invariant 8 does not stop at Coda's edge — an
eighteen-digit id put through `Number` selects a different neuron in somebody else's viewer, with
nothing to say so. The layer's `source` is the canonical `precomputed://gs://…` spelling too,
which is why `parseNgSource` keeps the location in its own scheme: a layer pointed at
`storage.googleapis.com` would work only where Coda's own proxy decisions do.

**Two dataset producers on a canvas means auto-wiring stops**, and that is the right answer rather
than a regression — see the section below for the rule and why counting nodes is what it counts.
With a connectome and a mesh bucket both on the canvas, which one a newly added `Meshes` node
should read is a real question, and the editor has no way to answer it.

**`cheap`, with the fetch memoised including its failures.** It resolves metadata and nothing
else, so switching a URL updates the downstream column pickers without waiting for a Run — but
the one thing anybody edits on it is a text field, which is invariant 6's hazard. `probe.ts` holds
one small `info` per URL and holds the failure too, so a URL that 404s is asked once rather than
once per edit-time peek. What remains is one request per committed edit, because each distinct URL
is its own key; that is the trade `Custom CAVE` already makes for a hand-typed datastack, held
down by the string param's debounce. `retry` is the way back from a *transient* failure and is
passed only from `evaluate`, which runs on an explicit Run.

**The capability default is optimistic and the override narrows it.** `capabilities.meshes` is
`true` on the source and `capabilitiesFor` answers `{ meshes: false }` once the probe says the URL
holds an image stack or a segmentation with no mesh directory. Backwards-looking at first glance,
and it is `capabilityOf`'s own rule: an unresolved source refuses nothing. A pessimistic default
would put "This data source has no meshes" on a perfectly good `Meshes` node for the first second
of every load. A probe that *failed* returns `undefined` rather than `false`, because "nobody could
read this" and "there are no meshes here" are different, and the node holding the URL is already
reporting the first.

## Attribution: the Description companion

Every published dataset node arrives with a `dataset.description` card wired to it. A connectome
is years of someone's reconstruction work published with a request for attribution, and a picker
labelled "MaleCNS" gives no hint of that — so the credit is **on the canvas by default and has to
be dismissed**, rather than being available somewhere and never looked for.

**The text is neuPrint's, not ours.** `/api/dbmeta/datasets` publishes a markdown blurb per
dataset — a summary, the project landing page, companion viewers, and the papers to cite — which
`DatasetInfo.description` has always carried and nothing rendered. Restating any of it in the
family table would be a second copy that goes stale the day a dataset adds a citation, and would
be simply absent for `Custom neuPrint`, which can point at a deployment this build has never
heard of.

**The card shows the blurb, and for CAVE one thing more.** No dataset id, no version, no neuron
counts: it sits directly under the node that feeds it, so every one of those would repeat
something an inch away, and the card is narrow. The three _absences_ are said apart, though —
"publishes no description" is a fact about the dataset, while "has not listed its datasets yet" is
a state the card is passing through, and one message for both makes a card that is about to fill
itself look like one that never will.

**The exception is CAVE, and it is an exception because CAVE is the backend whose configuration is
Coda's.** A datastack does not describe its own roles — `spec.ts` decides which table is the
neurons, which is the cell types, which the synapses — so those four bindings are an editorial
decision taken in a source file the user cannot see. Every other backend's roles are self-evident
from the data. Here they were visible nowhere in the app at all, and the question that exposed it
has no other answer: *why are there no cell types on BANC?* Because no annotation table is
configured for it.

So `CaveSource.codaReads` appends a short list — neurons, annotations, connectivity, synapses —
under a **Coda reads this datastack as:** heading. Three properties, each deliberate:

- **It is marked as Coda's**, because the paragraph above it is not. The card exists to carry the
  publisher's words and a reader has no other way to tell where the quotation stops.
- **An unbound role is a line, not an omission.** "Annotations — none configured; wire an
  annotation source for cell types" is the entire point; a list that silently skipped the role
  nobody configured would answer the easy question and not the one being asked.
- **It says which mechanism, not just which table.** `valid_connection_v2` is named as a view
  aggregated server-side, where a datastack without one reads "counted from `synapses_v3`" — which
  is why connectivity there is slower, following the same precedence `synapsesFor` applies.

Base markdown only, `**` and backticks. This text renders through the same path as a blurb from
whatever deployment a Custom node points at, and `parseMarkdown`'s extended kinds are opt-in for
the reason [gotchas.md](gotchas.md) records.

**`companion` is on the `NodeDefinition`, and `addNodeWithCompanion` is the only way in.** See
`core/companion.ts`. Three properties, each of which would be worse than having no card at all if
lost:

- **A suggestion, not a fixture.** Delete it and it stays deleted — nothing repairs the graph on
  a later edit. `Add ▶ Dataset ▶ Description` is how it comes back.
- **On add, never on load.** The store's `addNode` and `buildStarter` call it; deserialisation
  does not. A saved file that grew a node every time it opened would be unusable.
- **One undo step.** Both nodes and the edge go in through a single `commit`, and the selection
  stays on the node that was actually asked for.

**The synthetic families opt out** via `DatasetFamily.synthetic`. There is nobody to cite for a
connectome generated in the browser on load, and a credit card with no credit on it devalues the
ones that mean something. Note the knock-on in tests: a mock starter has one fewer node than a
neuPrint one, which is why `explore.test.tsx` still finds Explore Dataset's expand button first.

**No outputs, which is the one deliberate departure from the `out.*` viewers.** Those pass their
input through so they can be dropped mid-chain; this is an annotation hanging off a dataset node,
and an output socket would invite wiring a pipeline through the credits.

**`cheap`, and `evaluate` usually fetches nothing.** The body draws from `peekDataset`, so the
text appears as soon as the listing lands whether or not anything has run — that is what makes it
an annotation rather than a result. `evaluate` only calls `listDatasets` when the peek is empty,
because `listDatasets` re-fetches on every call and this node runs on the same cheap pass as the
dataset node that has just done it.

### Rendering someone else's markdown

`ui/markdown.ts` parses a subset to an AST; `MarkdownView.tsx` turns that into React elements.

**The AST is the security boundary, and it is why there is no markdown dependency.** Every
library in that shape emits an **HTML string**, so safety rests on a sanitiser being configured
correctly and staying that way. Here raw HTML in a blurb is a `text` node that React escapes, and
`safeHref` refuses any scheme outside http/https/mailto — so a hostile description cannot become
markup by construction rather than by configuration. `markdown.test.ts` covers the refusals;
`descriptionBody.test.tsx` covers that the _render_ path agrees.

Two parsing details that real data forced:

- **Link targets are scanned with paren depth, not to the first `)`.** DOIs and wiki URLs carry
  balanced parens, and truncating one yields a link that silently 404s.
- **`safeHref` strips whitespace and control characters before testing the scheme and returns the
  original.** `java\tscript:` is a scheme browsers accept and a naive test does not; stripping
  before rather than after errs towards refusing.

A refused link degrades to its label as plain text. Dropping it would hide that anything had been
written there.

## Auto-wiring the Dataset socket

A node added with a `Dataset` input arrives already wired to the dataset on the canvas, when
there is exactly one to wire it to. `core/autowire.ts`, applied in the store's `addNode` inside
the same `commit` as `addNodeWithCompanion` — so the node, its companion and the wire are one
undo step. Nearly every query node opens with the same question, and on a one-dataset canvas
that wire is a gesture with no decision in it.

**`dataset` sockets only, and that is the whole of it.** A dataset handle is a fact about the
_workspace_ — this graph is about hemibrain — where a table is a step in a pipeline. One table on
a canvas means a canvas half built, so guessing there would wire a new node to whatever happened
to be lying nearest, which is worse than an empty socket precisely because it looks deliberate.

**Counted over dataset _nodes_, never over resolved dataset ids.** Reading two nodes that both
resolve to `hemibrain:v1.2.1` as "one dataset" is tempting and unsafe: a node left on `Latest`
publishes no dataset id until the listing lands (invariant 2), so on a fresh tab two nodes
pointing at _different_ connectomes are indistinguishable — which is exactly the moment the wrong
guess would be made, and the moment nothing on screen could explain it. Two candidates means the
socket is left empty.

**On add, never on load and never as a repair.** Same rule and same reasoning as `companion.ts`:
a saved graph must reproduce itself exactly, and a socket somebody unplugged stays unplugged.
Deleting one of two datasets does not retro-wire what is left.

**`duplicateSelection` is deliberately not routed through it.** Duplicating already declines to
copy edges from outside the selection — a clone must not silently inherit inputs — and a clone
that arrives wired to something its original was not would be that same surprise by another
route.

The one visible interaction is with the palette's link-drag, which adds the node and then
connects it: the auto-wire lands first and `addEdge` evicts it if the drag was aimed at the same
socket, so the two agree by construction. A drag from a _table_ output onto, say, Connectivity
now fills both of its inputs at once.

## Starter graphs, and the one that is not the generic shape

`examples/starters.ts` — what `New ▸ <dataset>` and the start page's dataset rail both build,
through one `buildStarter(spec)`. The generic shape is four nodes: a Dataset, an Explore Dataset, and a
Table and a Neuroglancer view off `Selected`, plus the Description companion. Built from each
node's own defaults, exactly like the examples, so a starter cannot drift out of sync with a
node's param set.

**FlyWire FAFB opts out, and the reason is the backend rather than taste.** A neuPrint dataset
carries its cell typing as properties on the neuron, so "a Dataset and a browser" is a complete
first screen. A CAVE datastack does not — the labels live in a table — so the same four nodes
open on a list of eighteen-digit root ids and nothing else. No arrangement of the generic shape
fixes that, because what is missing is a *chain in front of the dataset*:

```text
Table from URL ▸ Combine Columns ▸ Update root IDs ──────────┐
                                                              ├─▸ Join ─▸ Dataset
CAVE table (neuron_information_v2) ▸ Group By (join text) ───┘        ▸ Annotations
```

Two sources answering two different questions about one neuron: structured fields along the top,
free-form community text along the bottom.

`BESPOKE` in that file is the dispatch — keyed by node type, since that is what a `StarterSpec`
carries, and a table rather than an `if` so the second could not become one. There are two.

**BANC is the second, and it opts out differently: `genericStarter` plus one node.** Same problem —
a CAVE datastack keeps its cell typing in a table, so the generic four open on root ids — and a
much smaller answer, because BANC's labels are already *in* the datastack where FlyWire's are a
published file that has to be fetched, coalesced and root-id-repaired first. So the whole chain is
one CAVE table node reading `codex_annotations`, wired to the dataset's `Annotations` socket and
back as a reference:

```text
CAVE table (codex_annotations) ─▸ Dataset ▸ Annotations
```

It is **composed** rather than written out — `bancStarter` calls `genericStarter` and adds to what
it returns — because everything downstream of the dataset genuinely is the generic shape, and a
copy of it would only ever *happen* to still agree. `examples.test.ts` compares the two edge sets
to keep that true.

**`Pivot on` is the whole configuration.** `codex_annotations` is long-format — one row per
(neuron, `classification_system`, `cell_type`) — so the distinct values of the kind column become
the columns: 1,994,371 rows across 32 kinds folding to 158,250 neurons. `cell_type` arrives
renamed to `type`, which is the name addressed by literal downstream.

**Why a starter and not a `DatastackSpec.annotations` entry.** That spec joins through the
datastack's own `neurons.table`, and `codex_annotations` is a reference table into
`cell_representative_point` — not BANC's `backbone_proofread`. It cannot be expressed there, which
is also why the Description card on a plain BANC dataset says "Annotations — none configured". The
starter is where the wiring lives, and the canvas is where it is visible.

Each step answers a question somebody would otherwise have to discover, and every one is pinned
by `examples.test.ts`:

- **`raw.githubusercontent.com`, not the `github.com/…/raw/…` address the repository's own UI
  hands you.** That one answers `302` with `access-control-allow-origin:` **present and empty**,
  and a browser CORS-checks every hop of a redirect chain — so it never reaches the host that
  answers `200` with `*`. Measured from a real page origin: the first throws
  `TypeError: Failed to fetch`, the second returns 31,718,491 characters.
- **Combine Columns**, because the type has to arrive in a column *called* `type` before anything
  reads it in words — the connectivity tables, Explore Dataset's chips, Neuron Profile's roll-ups all address it
  by literal name (`annotationColumn`). The coalesce is about **precedence**, not coverage, and
  the measurement is the reason to say so: on the published file `cell_type` covers 137,720 of
  139,248 neurons and `hemibrain_type` 33,271, but only **2** neurons have the second and not the
  first — so `[cell_type, hemibrain_type]` gains two rows and decides the nomenclature for the
  rest. Reaching for coverage means naming more columns: adding `supertype` and `cell_class` takes
  it to 139,166, with 82 carrying nothing at all.
- **Update root IDs**, because the published file is a snapshot and a root id is retired by any
  proofreading edit. Without it the rows whose ids have moved on join to nothing, and the dataset
  merely reads as under-annotated — which is the failure `data/cave/rootIds.ts` exists to
  announce.
- **Group By, folding `tag` with `join text`**, because `neuron_information_v2` is one row per
  (neuron, tag) and everything downstream wants one row per neuron. It is not a tidy-up:
  `joinTables` takes the **first** matching row for a repeated key — deliberately, so a
  many-to-many join cannot multiply the table being annotated — so without the fold a neuron
  carrying eight community tags shows exactly one of them, with nothing saying so. The
  aggregation is distinct and in first-appearance order, which is what a table two people have
  annotated the same way needs.
- **The Join rather than an annotation chain**, because a chain makes the later source **win** a
  collision rather than sit beside it. `left`, so a neuron nobody has tagged still comes through.
- **`Columns: pt_root_id, tag`** on the CAVE table. Everything else in `neuron_information_v2` is
  bookkeeping — a point, a supervoxel, a user id, a timestamp — that would otherwise arrive in
  every neuron table and in every column picker downstream. It has a second effect worth knowing:
  `peekColumns` answers a **wide** table's columns from the ref alone, so naming them is what lets
  `tag` be known at edit time with no fetch, where an empty `Columns` is `undefined` by design.
- **The Dataset is wired *back* into Update root IDs and into the CAVE table, and both are
  reference edges.** Two edges between one pair in opposite directions, twice; `topoSort` sees
  only the dataflow half of each. It is the placement `cave.updateRootIds` was given a reference
  port for, and the test asserts `cyclic` is empty so a regression there shows up as a starter
  rather than as a unit test nobody connected.

Two deliberate departures from the generic shape, both visible on the canvas. The **Table hangs
off `All` rather than `Selected`** — every other starter avoids that, because `Hits`/`All` with
an empty search is the whole dataset and teaches the wrong lesson about what to connect; here the
annotated neuron table *is* the thing worth looking at, and a Table showing nothing until a row
is ticked would hide it. Everything else **opens empty**: `selection` and `page` are both written
by the Explore Dataset *widget*, so a starter carrying either would ship whoever exported the graph's
browsing position, and the Neuroglancer panel would open on a neuron nobody chose.

**`Additional tags` is pointed at `join_tag`, and the name is derived rather than typed.**
`groupByTable` names an aggregate `<agg>_<column>`, so the starter reads it back through
`aggColumnName` — a literal would be that rule stated in a second place, and getting it wrong is
entirely silent, since a wrong `Additional tags` does not fail, it just draws no tag row. The
other half of the pairing is `JOIN_SEPARATOR`: the aggregation joins with it and `splitTags`
splits on it.

**The starter carries one warning on a cold session: `Column "join_tag" is gone` on Explore Dataset.** It is
the documented conflation in `annotationSchemaFrom`, which answers the same `undefined` for an
unwired socket and for a chain whose columns are not known yet — so `withAnnotations` falls back
to the *datastack's own* labels, and a chain replaces those, which makes the fallback a schema
that is known and known to be wrong. `join_tag` is not in it, so `validateColumnParams` reports
the drift it exists to report. The chain's schema arrives once `Table from URL` has run (its schema
is session-scoped and keyed by URL), so the badge clears on the first Run and returns on reload.

Worth stating why it has not been fixed here, because the obvious fix is not obviously an
improvement: making the neuron schema *unknown* under an unresolved chain would empty every
column picker on a CAVE dataset until the first Run, where today they offer the datastack's own
columns — which on this graph largely **are** the right names, since the published TSV and the
datastack agree on `cell_class`, `super_class` and the rest. Telling the two states apart needs
the dataset type to say "a chain is wired" separately from carrying its schema, which is a change
to a seam every CAVE graph reads. `examples.test.ts` pins the warning *exactly*, so a second
issue fails the test rather than hiding behind this one.

`examples/notes.ts` holds `dedent` and `noteNode`, shared with the bundled examples rather than
copied — both write notes as indented template literals in TypeScript source, and two copies of
`dedent` is two answers to what counts as a heading.

**Checked in a real browser** over CDP against `pnpm dev`, which is the only thing that could:
thirteen cards and thirteen wires in both themes, no overlaps at their measured sizes, the two
notes right-aligned against the pipeline's left edge, no console errors, no sideways body scroll, every one of the note's four links resolving (the DOI to
`doi.org` rather than to a university proxy), and neither note clipping its own text —
`scrollHeight` equal to `clientHeight` on both, light and dark. What is *not* checked anywhere is
a Run, which needs a CAVE token.
