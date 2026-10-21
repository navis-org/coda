# Backends: CATMAID

CATMAID: the access problem, credentials, derived types, and its traps. [backends.md](backends.md)
holds what all of them share — the geometry cache and streaming.

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

**A token used to be unobtainable on this instance** — `/accounts/register` is 404 — so the usual
answer (require one, like neuPrint and CAVE) would have made the named target unusable, and the
module fell back to a same-origin `/cm/` relay performing the handshake server-side. On
2026-08-29 VFB published an anonymous-user token for each of their eight instances at
`https://virtualflybrain.org/data/EM/catmaid.json`, which is the zero-code ask in
`docs/catmaid_vfb.md` granted. `publicTokens.ts` carries them: a committed snapshot that answers
synchronously and offline, refreshed from that manifest in the background so a rotation does not
need a Coda release. The relay stays for what it was always for — a lab CATMAID that publishes
no token — and is no longer on the path for VFB.

**A published token is not a credential, and the difference is enforced in three places.** It
authenticates as `AnonymousUser` with `can_browse` and nothing else, so it grants exactly the read
access the server already gives everyone over `GET`; what it buys is the *verb*. So it **loses to
a user's own token** (a real VFB account has more than `can_browse`, and substituting would hide
their data silently); a **401 drops it and retries**, because the request loop stops at the first
response and a rotated token would otherwise fail where an anonymous `GET` used to work — while a
token the *user* typed is never dropped, since that 401 is genuinely about their credential; and
the manifest is fetched **`cache: 'no-cache'`**, because it is served `immutable` with a one-year
max-age and the refresh would otherwise run once per browser, forever.

**One preflight finding worth keeping**, because it rules out doing the CSRF handshake in the
page. The server answers a preflight `204` with a *static* allow-list that does not contain
`X-CSRFToken`; it never inspects the requested headers, so it looks like a pass and the browser
is what refuses. Beside that, `credentials: 'include'` is rejected outright (`ACAO: *` is invalid
with credentials), `Set-Cookie` is a forbidden response header so the cookie cannot be read off
the response, and `document.cookie` cannot see another origin's — the double-submit has nothing
to submit. `X-Authorization` *is* in the allow-list, which is why the token needed no change at
their end.

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
internally consistent. So nothing does what `data/units.ts` has to.

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
- **A presynaptic connector link is already one row per site, which is the opposite of neuPrint's
  problem.** `connectors/links/?relation_type=presynaptic_to` answers one row per (skeleton,
  connector), and a connector *is* a T-bar — measured on FAFB skeleton 16 as 1,709 rows and 1,709
  distinct connectors. So this source declares `synapseUnits = ['sites']` and refuses a pinned
  `links`: producing it would mean asking `connector/skeletons` for each connector's postsynaptic
  partner count, which is the same real fetch `CATMAID_SYNAPSE_SCHEMA` declines to pay for
  `partnerId`. Its `confidence` is a **tracer's 1..5**, nothing like neuPrint's 0..1 fraction, and
  the endpoint has no confidence parameter — so `minConfidence` is applied client-side, cutting
  rows and not bandwidth.
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
  `status` for one to name, and a fresh Find Neurons carries no rows at all — which now also means
  it sends no query.
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
