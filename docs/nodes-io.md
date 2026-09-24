# Node semantics — input, output and ids

Nodes at the edges of a workflow: getting data in, getting it out, naming neurons, and the two
ZapBench seams. One section per node whose behaviour cost a decision. See also
[adding-a-node.md](adding-a-node.md) and [nodes.md](nodes.md) for the index.

## Text notes

`note.text`, added from `Add ▶ Utility ▶ Text`: a framed block of markdown on the canvas. It is
what a graph cannot say about itself — why this type pattern, why this threshold, what the chart
at the end is meant to show.

**It is a `GraphNode` with `annotation: true`, and both halves of that are deliberate.** A
separate `annotations` array on `CodaGraph` would have to re-implement position, selection,
undo, autosave, serialisation, the library, duplication and the minimap — every one of which a
node already has — for a feature whose entire content is a string. So it is stored as a node.
What makes it _not_ a node is the flag: no ports, never evaluated, no provenance key anyone
reads, and its own card.

`annotation` is read in exactly five places, and each one would be a visible lie without it:

- `Scheduler.refreshStates` gives it **no state at all**, not even `idle`. With no cache entry it
  can never be fresh, so a labelled note would sit permanently `stale` — counted by the toolbar
  badge, re-offered by every Run, for a paragraph of prose.
- `Scheduler.execute` skips it, so it lands in neither `executed` nor `deferred`.
- The store's `needsRun` returns false (the palette's stale count reads through it), and
  `toggleDisabled`/`toggleCollapsed` filter it out. Collapsing is the dangerous one: a note draws
  no header, so a collapsed one would have nothing left to press.
- The inspector drops its Ports and Result sections; the context menu drops Run, Invalidate, Mute
  and Collapse; the palette disables Run Selected and Expand. Params stay — for a note that is a
  full-width editor for the same string, which is the better place to write more than a sentence.
- `NodeThumbnail` draws a framed box of text lines rather than a card with a header strip, so the
  browser tile does not promise sockets the inserted thing does not have.

**Read mode drags, edit mode types.** The rendered view is draggable everywhere, which is what
makes a note a thing you push around; the cost is that its text cannot be selected with the
pointer, since that gesture moves the card. Double-click swaps in a `nodrag` textarea. Blender
and ComfyUI make the same trade and it is the right way round — notes are moved far more often
than they are re-read a phrase at a time.

**Escape reverts through a ref, and that is not incidental.** Unmounting a focused textarea can
fire blur on the way out, so leaving edit mode is not a way to express "cancel" — the blur
handler would commit the very edit being abandoned. Escape sets `reverting`, blurs, and the blur
handler reads the flag and skips the write.

**The frame is the object, and it is quiet.** The paper is 1.13:1 against the light canvas, so
the _border_ is what says "a different kind of thing". Achromatic, and one value for both
themes: `#7d7b76` is the grey that clears the 3:1 non-text floor on all four surfaces it can
meet — 3.98:1 and 3.52:1 on the light paper and canvas, 4.16:1 and 4.43:1 on the dark pair.
`--text-muted` would have served except on the light canvas, at 2.99:1, which is exactly where a
note dragged onto empty space lives. Otherwise the card takes the node's own shadow and a
slightly tighter radius: a note belongs to the same scene, and what separates it is what it
lacks — header, sockets, state bar, footer.

**`outline` is inspector-only, and off removes the whole frame** rather than only the stroke:
border, paper and shadow together, because a paper card with a shadow and no border is still a
card, which is the thing being turned off. Three details are load-bearing. The border stays as
`transparent` so toggling does not shift the text by 1.5px in each direction; a _selected_ note
keeps its accent ring, since a frameless note that also vanished when you tried to pick it up
would be unselectable except by accident; and the frame comes back while the textarea is open,
because an edit needs a visible target. Absent means on, so a note saved before the param existed
keeps the frame it was drawn with.

**The text goes through `ui/markdown.ts`**, the same subset the Description card renders, rather
than a second parser. That module exists because a blurb from a foreign deployment must not be
able to become markup, and text pasted into a graph that is then shared has exactly the same
property — raw HTML stays text by construction.

**Every generated workflow carries notes** (`wizard/build.ts`, and the bundled examples did the
same before it), an overview above the chain and one per stage under it. They are placed absolutely rather than through `place`,
because the node grid is a row of pipeline steps while a note spans several of them. Their source
runs through `dedent`: the markdown parser only recognises a heading at the start of a line, so a
`###` indented to match the surrounding code is a paragraph beginning with three hashes.

Two existing tests had to learn what an annotation is, and the change is the assertion rather
than an accommodation: `wizard.test.ts` now expects `executed` to match the _dataflow_ nodes
and `graph.nodes` to be strictly longer, and `App.smoke.test.tsx` counts Run buttons against the
same subset. Counting a note as work is counting the comments in a program as statements.

## Upload Table and Table from URL: somebody else's data

`core.uploadTable`, added from `Add ▸ Utility ▸ Upload Table`. A CSV of annotations, custom cell
types or an embedding, brought in from the user's own machine — the one node here with no inputs
and no data source behind it. `src/data/uploads.ts` is the module to read first; everything below
follows from the two decisions taken there.

**The rows never enter the `.coda.json`.** The node stores a `dataId` and the filename it came
from; the table itself lives in IndexedDB. Three constraints force it and each one alone would be
enough: `stableStringify` re-hashes a string param on **every** graph edit (CLAUDE.md already
flags a 110 kB Explore Dataset selection as a stutter risk, and a whole-dataset embedding is megabytes),
the autosave is `localStorage` at a ~5 MB origin budget with `saveAutosave` swallowing quota
failures by design, and a `ParamValue` is `number | string | boolean | string[]` — a table can
only ride in a graph as text.

**So a `.coda.json` sent to a colleague arrives without its rows, and that is the accepted cost.**
It is not hidden: the card says which file is missing and offers to pick it again, and `evaluate`
throws naming the file so everything downstream is `blocked` rather than quietly running on
nothing. The message names the _file_ and never the content hash, because a hash is not something
anyone can act on.

**Its own IndexedDB database, not `data/cache.ts`.** That module is a cache — expiry,
fingerprint-as-miss, and a `cacheClear` that drops everything. A table somebody uploaded is not
evictable; losing it to a cache clear is losing their data. Same call and same reasoning as
`store/library.ts`, and it cannot live beside that one because `src/store` imports `src/nodes`, so
a node reaching into the store would close a cycle. `src/data` is the layer nodes may import.

**Writes reject, reads resolve**, inherited from `library.ts`. Everywhere else here a storage
failure degrades silently, because failing to _remember_ is not failing to compute; an upload
inverts that, because there is nothing to recompute from once the `File` handle is gone. There is
deliberately no in-memory fallback: something that survives until the tab reloads is not somewhere
to put a file. The write waits for the transaction's `complete` rather than for its requests — a
quota failure lets the `put` succeed and _then_ aborts, so awaiting the request would report an
import that was rolled back.

**`dataId` is a content address, and that is what makes provenance work with no nonce.** It hashes
the schema and every cell, so re-picking a file you already imported produces identical params and
re-runs nothing, while a file differing in one value invalidates everything downstream. Two nodes
given the same file share one stored copy. Note the separator: the hash walks a joined string, and
without one a column holding `['ab', 'c']` and one holding `['a', 'bc']` both concatenate to
`abc`, so two genuinely different imports would share an id and the second would silently resolve
to the first one's rows. It is written as `'\u001f'` rather than typed, because a raw control
character in a source file is invisible to every reader and to `grep` — this cost a debugging
round trip when one arrived in the file by accident.

**`fileName` is `presentational`, which looks wrong on a param that is not a viewer knob.** It
cannot change a byte of what `evaluate` returns — `dataId` decides that, and two people importing
one file under two names hold identical rows. Leaving it in the provenance key means renaming a
file re-runs the node and stales everything after it for a reason nobody could see.

### The peek, and why `ID column` is an enum

The schema is not in the graph either, so `inferOutputs` — synchronous, and forbidden to fetch by
invariant 2 — reads `peekUploadSchema`, which answers from an in-memory mirror and, the first time
it cannot, starts the read that will fill it. Once per id, never once per peek, because inference
runs on every keystroke. When it lands, `reportUploadLearned` fires and `graphStore` re-infers
through the _same_ `afterSourceLearned` handler the dataset listings use: this is not a
data-changed event, must not schedule a run and must not autosave, all of which that handler
already gets right for exactly the same reasons.

So on a cold load the node publishes a bare `T.table()` for a moment — typed, so the wire still
connects — and fills its columns in a millisecond or two.

**That window is why `ID column` is an `enum` and not a `column` param.** An enum's stored value
reaches the provenance key verbatim; a column param's is _resolved_ against the available schema
first. Resolved against an empty schema and then against a full one, the node would key one way
before the peek landed and another way after — marking a node that had just run stale, and
invalidating everything downstream of it, on every single reload. `resolveColumn`'s rule 2 keeps a
chosen name and would have survived it; `resolveColumns` drops what it cannot find and would not.

**A miss is announced too.** Without that the card sits on "looking for the stored rows" forever,
and that is the one state that has to resolve into a sentence telling somebody to pick the file
again.

**The card's `useSyncExternalStore` snapshot is a revision counter, not the peeked value.** Both
"still looking" and "not in this browser" peek to `undefined`, so a snapshot of the value is
identical either side of the read landing and React never re-renders. Same idiom and same reason
as the store's `runVersion`. A test drives this; it is not otherwise observable.

### Reading the file

`data/csv.ts`, headless, the counterpart to `ui/export.ts`'s CSV writing. Everything is decided
from the text — delimiter, header, and each column's dtype — and there is **no options
argument**, deliberately. The settings a caller might pass are exactly the ones that would have to
be _stored_ to be honoured on a later run, which puts them in the provenance key and makes the
node's stored schema something that can drift from its stored rows. Detecting once at ingest and
keeping the finished table means the two cannot disagree; the cost is that a file whose shape is
undetectable has to be fixed rather than configured.

- **The delimiter is judged on consistency, not on count.** Counting occurrences picks the comma
  out of a tab-separated file whose text fields contain commas. A real delimited file splits every
  row into the same number of fields, so the candidate producing one field count across the sample
  wins. Semicolon and tab are not exotic: a spreadsheet saving "CSV" under a comma-decimal locale
  writes semicolons, and `to_csv(sep=)` writes tabs.
- **A header is text, and that is the whole rule.** The moment any field of row one parses as a
  number, that row is data. Both obvious extra conditions are wrong: _blank_ names cannot
  disqualify it, because `to_csv()` with an index writes `,a,b` and every such export would be read
  as headerless; _duplicated_ names cannot either, because `uniqueNames` already suffixes them and
  demoting the row instead puts the word "type" into the first row of the column it was naming. The
  remaining ambiguity — an all-text file with no header — resolves _towards_ a header, the same bias
  `pandas.read_csv` takes.
- **The suffixing is `uniqueName`, which now lives in `src/core/types.ts`.** It was hand-written
  here and again in `tableOps.ts`, and `src/data` may not import `src/nodes` (invariant 1), so the
  annotation providers were about to make it three — `ID_COLUMN_NAME`'s argument for `src/core`
  exactly. The two copies had already parted company on the case that matters: this one *counted
  occurrences*, which turns `a, a, a_2` into `a, a_2, a_2` — a collision produced by the very
  function that exists to prevent one. Probing for the first **free** name cannot do that.
- **A blank cell is null, never zero.** `Number('')` is 0, which draws a dense stripe of data
  nobody recorded along every axis downstream. Same trap `numeric()` in `encoding.ts` exists for.
- **A value that would not survive a round trip stays text.** `007` and `0012` are how a
  zero-padded code is written and reading them as 7 and 12 loses what made them identifiers; an id
  past `Number.MAX_SAFE_INTEGER` comes back a different number. The load-bearing half is that this
  vetoes the _numeric_ reading and not merely the integral one — without that `007` fails the
  integer test, passes the float test, and arrives as `7` anyway. Floats are exempt: `1.50` and
  `1.5` are the same measurement, where an integer's digits are identity.
- **One stray value keeps the whole column text.** A column that is 99% numeric with an `n/a` in
  it is a text column with a convention in it, and reading the rest as numbers drops that row's
  value silently.
- **`0`/`1` are integers, never booleans.** A synapse count of 1 is not `true`, and nothing in the
  text says which was meant.
- **Ragged rows are padded and reported, never dropped.** A trailing comma is routine in a
  hand-edited file, and losing the row silently is worse than a null in it. The count goes through
  the card's error channel once, at import, rather than becoming a permanent badge — it is a fact
  about the import, not about the node's configuration.

**Both size checks are made against `file.size` before a byte is read**, which is the same call
`pivotTable` makes when it checks label cardinalities rather than the array it is about to
allocate. By the time a table exists the tab has already stalled. Two tiers, because "large for a
spreadsheet" and "too large for a browser" turned out to be two orders of magnitude apart:
`UPLOAD_WARN_BYTES` (50 MB) says the parse will take a moment and reads the file, and
`MAX_UPLOAD_BYTES` (200 MB) is one of the few outright refusals left — see [limits.md](limits.md).

### The two controls

Both are applied _after_ parsing and both are lossless, which is what lets them cost no re-parse
and never disagree with the rows already stored. The pair lives in `tableOps.ts` as
`uploadShapeSchema`/`uploadShapeTable`, with `uploadIsNeurons` shared between them so the schema
half and the value half cannot disagree about the _kind_ either.

- **`ID column` renames the chosen column to `neuronId`**, and the output becomes Neurons. Nodes
  address columns by name — `out.profile` validates on it, Connectivity and Skeletons read it — so
  a file whose author wrote `root_id` cannot meet neuron data until it is renamed. A column that
  merely already held the name is suffixed (`neuronId_2`), the same call `joinedColumns` makes. Only
  `i64` and `str` columns are offered: a float is a measurement and a boolean is a flag, and
  offering either invites a Neurons table whose neuron ids are neither.
- **`Text columns` widens a column to `str`**, and never the reverse. Reading text as a number is
  where data is lost, and the parser's round-trip rule has already kept anything ambiguous as
  text — so this is for a column that is genuinely numeric and genuinely not a _quantity_, like a
  cluster label or a layer index, which has no business offering itself to a size encoding or being
  averaged. Null stays null: `String(null)` is the four-letter word "null", which would read as a
  value everywhere downstream.

`ColumnSchemaSource` grew a second argument for `Text columns` — see the Explore Dataset section, where it
came from. A column picker on a node with **no inputs at all** has nowhere to read a schema from
but the node's own params, which is what that argument supplies.

**`cheap`, despite reading a database.** `evaluate` is one IndexedDB read of an already-parsed
table and no parse at all, and there is no upstream, so it re-runs only when its own params change.
Same reasoning as `out.neuroglancer`.

**Known limit: nothing collects orphans.** Deleting the node leaves its rows in IndexedDB, because
nothing can tell whether another graph on the shelf still references them — and content addressing
means re-importing the same file reuses the entry rather than adding one. A "manage uploads"
surface is the answer when there is one; silently deleting somebody's data on a node delete is not.

### The URL variant

`core.tableFromUrl`, `Add ▸ Utility ▸ Table from URL`. The same CSV, fetched rather than picked.
It shares the parser and the shaping pair, so the two nodes cannot drift on what a delimiter, an
ID column or a text column means, and differs in exactly one property: **a URL is reproducible
and an upload is not.** So this one needs no storage at all — the graph carries the address, and
a colleague opening the file re-fetches it. What it gives up is working on a file that only
exists on somebody's disk, behind a login, or on a host sending no CORS headers. Neither node
supersedes the other, which is why both exist.

**`expensive`, which is invariant 6 in its plainest form.** The URL is a text field. Marked
`cheap` it would fire a request per keystroke, at whatever host was half-typed.

**`refresh` is not decoration.** A file at a URL can change under a fixed set of params, which is
exactly the hidden mutable state invariant 4 requires an explicit nonce for — the Dataset node's
own `refresh` is the precedent. Without it, re-running against an updated file hands back the old
table from cache with nothing to say so.

**The schema is remembered per URL, in a module map, rather than observed.** `observesOutputSchema`
is the obvious fit — the shape is decided by a remote server that inference may not call — and it
is _almost_ right. What rules it out is `Text columns`: a `columns` param finds its options
through `schemaFrom`, which is handed the node's inputs and params and deliberately **not**
`ctx.observed`. Widening it to see the observed schema would have inference resolving that param
against a schema the _scheduler_ cannot see when it computes the provenance key and resolves
`ctx.columns` — invariant 5's exact desynchronisation. A map keyed by URL is readable from all
four callers at once. Same lifetime as an observed schema (empty before the first run and after a
reload), same announcement idiom, and session-scoped on purpose: what a server returned is not a
fact about the document, and persisting it would let a saved graph claim columns nobody fetched.

**A cross-origin refusal and a dead host are the same `TypeError`**, because that is all a browser
gives — the constraint `data/precomputed/transport.ts` works around by trying and remembering.
So the message names _both_: the fix for one is nothing like the fix for the other, and saying
only "network error" sends somebody to check their wifi over a header their server never sent.
No proxy is offered, deliberately: `deploymentProxy` in `vite.config.ts` exists under a rule
refusing anything but https to a public host, and a general-purpose fetch proxy is an SSRF hole
aimed at whoever is running the dev server.

**`Content-Length` is checked before the body is read**, and the parsed length again after,
because a chunked response declares nothing. **A 200 that parses to no rows quotes what arrived** —
overwhelmingly a login redirect or a permissions page served as HTML, where "no rows" alone sends
somebody to inspect a file that is perfectly fine.

**`validate` warns about `http` rather than refusing it.** Whether it is actually blocked depends
on how this app is served, which is not knowable at edit time — the same call `Find Neurons` makes
about `limit: 0`. A scheme that cannot be fetched at all (`file:`, `javascript:`) is refused by one
rule rather than by a list of special cases.

### A redirect is a CORS hop, and it is the one that fails

The refusal names both a dead host and a cross-origin block because a browser reports them as one
opaque `TypeError`. The commonest cause is neither: **a redirect whose *first* hop carries no
usable CORS header**. `github.com/<org>/<repo>/raw/refs/heads/main/<path>` answers `302` with
`access-control-allow-origin:` **present and empty**, which matches neither the origin nor `*`;
a browser CORS-checks every hop of a chain, so it stops there and never reaches
`raw.githubusercontent.com`, which answers `200` with `access-control-allow-origin: *` and gzips.
Measured from a real page origin: the first throws `TypeError: Failed to fetch`, the second
returns 31,718,491 characters.

The other GitHub link is worse, because it does not fail at all. The address bar of a file page —
`github.com/<org>/<repo>/blob/<ref>/<path>` — answers **`200 text/html`**, so the parser reads the
page's markup and a person is left looking at a table that came back wrong rather than at an error.
Two ways to paste a link, two unrelated failures, and both links are ones GitHub's own UI hands you.

**So the node rewrites rather than refusing.** `rawFileUrl` (`src/data/rawFileUrl.ts`) turns both
spellings into `raw.githubusercontent.com/<org>/<repo>/<rest>`; its header holds the rules, and
the two worth knowing from out here are that **the param keeps the pasted text** — the rewrite
happens at each door that turns it into a request, so a shared workflow shows the link its author
typed — and that **both exporters call it too**, `pd.read_csv` and `read_csv` on a file page
succeeding and handing back a frame of HTML.

The door is `urlOf`, and the reason it is one function rather than four call sites is the schema
map: keyed by the pasted text instead of the fetched address, a node pointed at the page link and
one pointed at the raw address would learn the same table's shape separately, and the second would
look unfetched.

## Upload Mesh: somebody else's regions

`core.uploadMesh`, added from `Add ▸ Utility ▸ Upload Mesh`. `ROI Meshes`' local counterpart and
`Upload Table`'s sibling, and nearly every decision above carries over unchanged — the graph holds
a content-addressed `dataId` and nothing else, `fileName` is `presentational` for the same reason,
the geometry lives in the same IndexedDB database, the peek and the revision-counter snapshot are
the same machinery. What follows is only what differs.

**Why the node exists at all.** A dataset's neuropils are the ones its curators named, so a
glomerulus somebody segmented last week, a shell from another lab's template, or one hemisphere of
a structure a connectome lists whole had no route onto a wire: `ROI Meshes` can only ask a server
for what the server publishes. The `Volumes` socket accepted exactly one producer.

**The output is `ROI Meshes`' output.** `roi` and `primary` under those names, so `Points in
Volumes` reads `roi` with no configuration, the 3D View's `Volumes` socket colours by `primary`,
and `Download` writes OBJ — a custom region is not a second kind of thing. `primary` is true
throughout for the reason the precomputed and CATMAID sources give: it is the licence to sum, and
nothing in a pile of files says which shells nest. `ROI_MESH_SCHEMA` is deliberately **not**
imported — `data/source.ts` is the `DataSource` seam's vocabulary and an upload is not a source, so
what is shared is the column *names*, which is the only thing anything downstream reads. The third
column, `file`, is the one a fetch has no counterpart for: a region is named after its file's stem,
so two directories each holding `LO.obj` produce two regions called `LO` and nothing else says
which is which.

**Units are applied in `evaluate`, not at the upload.** The stored geometry is in the file's own
numbers and `UPLOAD_MESH_UNITS` scales on the way out, so a wrong setting costs a re-run rather
than another trip to the file picker — and the stored bytes remain what the file said, which is the
only form a second look at them can be checked against. It is an ordinary param in the provenance
key, which is what makes that re-run happen. The failure it exists to prevent is silent: everything
in Coda is nanometres, and a micron file drawn as nanometres is internally consistent and a
thousand times too small. Three units and not voxels — a voxel is not a unit without a dataset to
ask, and its factor differs per axis, which is a transform rather than a scale. One table with
three readers (the param's options, `evaluate`, both exporters), because written out three times a
corrected factor reaches the canvas and leaves two documents scaling by the old one.

**`uploadPeekSettled` starts the read it cannot answer**, and this node is what found that it did
not. `Upload Table`'s `inferOutputs` peeks its schema on every graph mutation, so by the time its
`validate` asks "has the read finished?" the answer is always already on its way; this node's output
shape is constant and peeks nothing, so the same question answered `false` forever — a graph whose
geometry is genuinely absent said nothing at all until somebody pressed Run. **The card would have
hidden it**, since `useUploadState` peeks too, which is what makes it worth a sentence: the bug is
invisible on a canvas and real everywhere else. It was first fixed by ordering two lines inside this
node's `validate`, which pins one caller and leaves the next one to rediscover it; the peek starting
its own read is CLAUDE.md's standing rule for `peekDatasets` and `schemasFor`, and putting it back
made the ordering here stop mattering.

**One mesh per file, and picking replaces.** The picker is `multiple` because a region set is a
directory; a file holding several objects merges to one mesh, which is `parseObj`'s standing rule
and right for a shell exported in pieces. Adding to an existing set would mean reading the stored
geometry back to re-hash it, and the gesture that does the same thing without that is picking the
files together.

**A file that is not a mesh is skipped and counted, not fatal** — `fetchRoiMeshSet`'s rule for a
region the server has no shape for, which is the same situation: a directory of shells with a
`README.txt` in it should import the shells and say what it left.

### Three formats, one shape

`data/meshFile.ts` dispatches on the extension, and on the bytes when there is none. `obj.ts` was
already here, written for a *fetch* — neuPrint serves its region meshes as OBJ — and STL and PLY
are new because those are what the tools that make a custom shell write. `parsedMesh.ts` holds the
shared type as a leaf so that no reader imports the module that imports it; declared in the
dispatcher it would close a cycle, which is safe only while nothing is read at module scope and is
the arrangement `precomputed/sorting.ts` records as having produced a silently `undefined` path.

- **The STL dialect is decided by arithmetic, never by `solid`.** A binary STL carries 80 bytes of
  free-text header that several exporters fill with the word `solid` and a name, which is exactly
  how an ASCII one begins. Read as ASCII such a file has no `vertex` lines in it and comes back
  empty, which reads as corruption. `isBinaryStl` asks whether the length is exactly
  `84 + 50 × triangles`, and the sniff and the parse share it so they cannot disagree about one
  file.
- **An STL is welded on read, exactly.** The format has no index list — a closed shell is N
  independent triangles, six times the vertices of an OBJ of the same shape. Left alone that costs
  the memory and it costs the *picture*: `Viewer3D` calls `computeVertexNormals`, which on unshared
  corners shades every face flat, so an uploaded shell looks faceted beside a fetched one. Exact,
  on the float32 values as written, never on a tolerance — a tolerance is a decimation, and this is
  somebody's own data rather than a display surface a server published. Paid once, at upload.
  **Keyed on the float32 bits and not on their text**: the obvious `${x},${y},${z}` key measured at
  610 ms and +262 MB for a 25 MB file against 48 ms and +18 MB, and at the 200 MB ceiling that is
  the difference between a freeze somebody was warned about and a tab that dies. The bit key is
  *stricter* than the string one in exactly one case, which has to be handled rather than inherited:
  `String(-0)` is `"0"`, so the text key merged negative and positive zero — `+ 0` normalises it and
  a test pins it.
- **A PLY's header is walked in full, including what is not read.** A PLY commonly carries normals,
  colours, confidences and whole extra elements, and in the binary arm a field that is skipped still
  has to be *stepped over* by its declared width. A reader that looked only for `x`/`y`/`z` and
  stepped by twelve bytes would read a colour byte as the next vertex's x and produce a mesh whose
  every coordinate is plausible and wrong. Both byte orders, because `DataView` takes the flag per
  read and a second reader would buy nothing.
- **The header offset is found in the raw bytes**, not by decoding the file as text: a binary body
  is not valid UTF-8, `TextDecoder` replaces what it cannot read, and that changes the length — so
  the body offset moves, silently, only for files with certain bytes in them.
- **Nothing hands back a `subarray`.** A typed-array view keeps its whole backing buffer alive, and
  — the half that makes it more than a heap note — the structured clone IndexedDB stores serialises
  the **entire** buffer rather than the view's range. An STL welds about 6:1, so a shell returned as
  a view wrote and re-read six times its own size, on disk, for the life of the upload: 17.9 MB held
  and stored where 3.0 MB was needed. `slice` costs 0.2 ms.
- **Both readers size their output from the header.** The vertex count and the face count are both
  declared, so `positions` and `indices` are allocated rather than grown — a `number[]` holds
  float32 values as 8-byte doubles, reallocates as it grows, and is then copied into the result
  beside itself. Measured over two million faces at 94 ms and 26 MB against 133 ms and 80 MB. A fan
  needs *more* than three indices per face, which is the one case that grows it.
- **The PLY body reads its scalars by number, not by name.** `Scalar` was a string union, so every
  value in the body cost two string-keyed width lookups and a string `switch` — 343 ms against
  **146 ms** on a 53 MB binary file, and the `read` closure alone 182 ms against 43. The trap it
  leaves is that `int8` is code **0**: every "is there a type here" test has to be `!== undefined`,
  or `property list char int vertex_indices` reads as a plain scalar and the file parses to no
  faces at all. A test pins it. Its row loop also hoists the two `element.name` comparisons, which
  were one string compare **per property per row** — twelve million of one constant question on a
  million-vertex file with normals and colours, and worth a further 25–29% of the whole parse.
- **The weld's table doubles rather than being sized from the corner count.** Corners weld about
  6:1, so `2 × corners` sizes for a mesh that cannot exist: 134 MB of `Int32Array` at the 200 MB
  ceiling, beside a 144 MB `positions` and a 144 MB `corners`, for a mesh that welds into 17 MB.
  Free at that size, 29% faster at a million triangles because the small table stays in cache, and
  slower only on a file with no shared corners at all — which is not a file a mesher produces.
- **None of the three throws.** `parseObj`'s rule: a file that is not a mesh parses to zero
  vertices and the caller words the refusal. `meshFileProblem` is that sentence for an upload and is
  deliberately not `objProblem`, which exists to recognise an HTML error page arriving over the wire
  with a 200 — a file off a disk is never that, and quoting its first eighty bytes at somebody who
  can see its name in a file picker helps nobody. It distinguishes a point cloud from a wrong file,
  those being different mistakes.

`meshFile.test.ts` holds one icosphere written five ways to the same 42 vertices and 80 triangles.
The shape is built in the test rather than checked in, so the encodings are provably one mesh; the
counts are `trimesh`'s, and all three readers were additionally run against real files that library
wrote, which is what says the hand-built ones are shaped like the ones people will pick.

### The exporters, where the two languages part

Python is one call for all three formats: `navis.read_mesh(path, output='volume')` reads OBJ, STL
and PLY through trimesh and **names each Volume after the file's stem**, which is exactly the `roi`
Coda writes. R needs three routes and each was checked by running it — `rgl::readOBJ` answers a
`mesh3d`; `rgl::readSTL(path, plot = FALSE)` answers a **matrix of triangle corners**, so `m$vb` on
it is "`$ operator is invalid for atomic vectors`", which reads as a corrupt file, and `tmesh3d` is
what turns it into a mesh; PLY has no reader in rgl at all and goes through `Rvcg::vcgImport`,
which nat only *suggests* — the same note `Points in Volumes` carries for `pointsinside`. No
`ctx.library` call: rgl is in nat's `Depends`, so it is attached already, and naming Rvcg in the
setup chunk would demand it of a reader whose files are all OBJ.

One difference the emitted R document states rather than leaves to be discovered: `readSTL` does
not weld, where Coda's reader does. The same sphere is 42 vertices on the canvas and 240 in the
document, with identical triangles and identical shape — so a vertex count taken from one will not
match the other.

`pnpm probe:upload-mesh` is the browser half, for the four properties jsdom cannot answer: a real
`FileList` on a real file input, where the component test defines the input's `files` itself;
the `accept` attribute, which jsdom never reads and which is extensions rather than media types
because none of the three formats has a registered one and a dialog handed a type it does not know
hides every file; geometry reaching a WebGL scene, where an index past the end or a bounds box that
does not contain it draws nothing while passing every count; and the units, where a thousandfold
error is internally consistent and only the scene's own bounds can show it. (It is *not* the only
cover for reading bytes — `installJsdomStubs` polyfills `Blob.prototype.arrayBuffer`, so the
component test exercises the real path.)

## Download: a side effect in a reactive graph

`out.download`, `Add ▸ Utility ▸ Download`. Write whatever arrives on the wire to a file. The one
node here whose _purpose_ is a side effect, and everything odd about it follows from that.

**`evaluate` does not download.** It passes its input through and nothing else. Two reasons, and
either alone would settle it: `src/nodes` is headless, so there is no `URL.createObjectURL` and no
anchor to click; and a cache hit means `evaluate` never runs, so a download performed there would
fire on the first Run and silently not on the second. `ui/useDownloads.ts` writes the file,
watching `lastRun.executed`.

**`expensive`, for a reason that has nothing to do with speed.** Nothing here is slow. But `cheap`
nodes re-run on the 180ms pass after every edit, and a node that writes a file per keystroke is
not one anybody can leave on a canvas. It also makes the signal reliable: only `runFull` records a
`RunSummary`, so the driver has something to watch.

**The signal is `executed`, never the output value.** A node that did not re-run is not in that
list, so a Run over an unchanged graph writes nothing — which is the whole of what bounds "on
every run". Watching the value would fire on a cache _restore_ too, writing a file for a graph
nobody re-ran.

**What it does not bound is auto-run.** With that on, every edit that changes the data upstream is
a full pass, and each writes a file. The card says so beside the checkbox, and that warning can
only live there: it depends on a **store** setting, which a node definition must never read, so
`validate` cannot express it.

**Every param is `presentational`, and that is the word used precisely.** `presentational` means
"cannot change what `evaluate` returns", and `evaluate` returns its input unchanged whatever the
filename, format or timestamp say — those decide what is _written_. Leaving them in the provenance
key made renaming a file re-run the node and invalidate the entire graph downstream of it, which
on an expensive pipeline is minutes of queries for a change to a string. The consequence, and it
is asserted rather than left implicit: **changing a setting and pressing Run writes nothing**,
because nothing re-executed. The card's button is what covers that, and is the reason it exists
beyond convenience.

**The driver is mounted in `Editor`, not in the node's card.** A collapsed card unmounts its body,
and a Download node that stopped writing when somebody tidied it away would be a bug nobody could
reproduce on purpose. It carries the mount-seeded guard `paletteRequest` uses, or a remount would
re-fire the last run's downloads — a file appearing because a panel was toggled.

### Pictures come from a viewer, not from the wire

A viewer is a **tap**: `out.scatter` passes its table on, never its picture, so nothing arriving on
this node's input could be an image. `svg`/`png` therefore read the rendered chart belonging to
whatever node _feeds_ this one, found from `graph.edges` rather than from a param — the wire
already names it.

**Reading the DOM would not work, and that is why `exportRegistry.ts` exists.** The heatmap and the
bar chart render a real `<svg>`, but the scatter draws to a canvas and the network to WebGL, and
both **synthesise** an SVG on demand (`scatterDraw`, `networkToSvg` over sigma's post-reducer
display data). Their picture has no element to query, so the viewer's own accessor is the only
route.

**The node id travels by context, not by prop**, which keeps this to two touch points instead of
sixteen: `ValuePreview` is the single place that dispatches to a viewer and already knows the node,
and `ViewerActions` is the single place every viewer converges on with its export source in hand.
`ValuePreview` is wrapped rather than having a provider at each `return` — it dispatches through
fourteen of them, and one missed would leave exactly one viewer unreachable with nothing failing to
say which.

The limit is real and the card states it: SVG and PNG work only while the upstream card is on
screen and not collapsed. Last registration wins, which is the useful way round — the overlay is
mounted last and largest, and is the one anybody asking for a PNG means.

### Formats

`ui/exportValue.ts`, and the rule is that **nothing is ever refused for want of a format**: a kind
with no natural text form falls back to JSON. An _explicit_ format the value cannot be written as
plans nothing and is reported, because silently falling back would hide that the choice did not
apply.

- **Table, Matrix, Points → CSV.** A point cloud keeps its positions with its attributes, since
  splitting them loses the row-for-row correspondence that makes it a point cloud.
- **Network Viewer → two CSVs**, nodes and links. One file cannot hold both without inventing a shape
  nothing reads; two is what the Network Viewer's own button gives and what Gephi imports.
- **Skeletons → SWC, Meshes → OBJ, one file per neuron.** A concatenated SWC has repeating ids and
  parses as one impossible tree. `MAX_MORPHOLOGY_FILES` caps the set at 50 and the plan _reports_
  the cap: a browser stops honouring downloads past roughly that many with no error, which reads
  as the export having half-worked.
- **Anything → JSON**, with typed arrays unpacked. `JSON.stringify` renders a `Float32Array` as an
  object keyed by index — valid, unreadable, several times larger — and every geometry value here
  is built out of them.

Two format details that produce a _valid file that is wrong_, which is why both have tests:

- **SWC ids are 1-based and a root's parent is `-1`.** Coda stores parents as array indices, so
  every one shifts. A 0-based file parses in every tool and hangs the first point off nothing. The
  structure identifier is written as `0` throughout rather than guessed — neuPrint publishes no
  soma/axon/dendrite labelling, and marking the root as soma would be a claim about anatomy the
  data does not support.
- **OBJ face indices are 1-based.** A 0-based file loads with one corrupt triangle and a stray
  vertex at the origin, which reads as a renderer bug rather than a bad export.

`downloadFiles` writes a multi-file set in a plain loop rather than staggered: browsers gate
multiple downloads from one gesture behind a permission prompt, and spacing them with timers loses
the gesture and gets them blocked outright instead of asked about once.

### One knock-on in the palette

An `any` **output** is excluded from the palette's backwards link-drag, and the asymmetry with the
input is the point. `any` on an input means "I accept whatever you have", which is a real answer to
"what could this feed?" — Download genuinely takes anything. `any` on an output means "whatever I
was given": a pass-through cannot _originate_ a Dataset, so offering it when dragging back from a
Dataset socket answers the question with a node that needs the same question asked again behind it.

## Copy IDs: the second side effect, and the one that cannot ride a run

`out.copyIds`, `Add ▸ Utility ▸ Copy IDs`. Takes **Neurons**, passes them straight through, and
puts their ids on the clipboard when the card's button is pressed. Download's shape, because the
constraints are Download's — `evaluate` does not copy (`src/nodes` is headless, and a cache hit
means it never runs at all), the write lives in the UI, and the card is a body rather than param
rows because the two things worth saying — *how many ids* and *whether a press would do anything*
— are decided from the **value**, which `validate` never sees.

Three places it departs from Download, each because the destination differs:

- **There is no `On run`, and the omission is the design.** A file can be written whenever the
  graph runs; a clipboard write cannot. Every engine but Chrome refuses `clipboard.writeText`
  outside a user gesture, so a run-triggered copy would work on one browser and fail on the
  others — and the failure is *silent in the worst direction*: the clipboard still holds whatever
  was there before, so the paste succeeds, with the wrong ids in it. The button is the only
  trigger.
- **`cheap`, where Download is `expensive`.** Download's cost is a safety property: it writes on
  run, and `cheap` would have it write a file per keystroke. Nothing here fires off a run at all,
  so the only thing cost decides is whether a node *downstream* of this tap gets its value without
  a Run — and a pass-through that made a chain need a Run it did not need before would be a tax
  charged for dropping a copy button onto it.
- **A `Neurons` port, not `any`.** Download takes anything because it writes the value; this node
  reads one column out of it. The question that settled it is the same one the `any`-output rule
  above asks: an `any` input here would advertise that a Network or a set of Skeletons could feed
  it, and neither has ids to copy.

The three settings — `Separator`, `Deduplicate`, `Quote ids` — are all `presentational` in the
strict sense invariant 4 requires: `evaluate` returns its input unchanged whatever they say, so
they decide the *text* and never the value. Leaving them in the provenance key would make changing
a comma re-run the node and invalidate everything below it, which on a chain fed by a connectome
query is minutes of refetching.

**The separator vocabulary and the joining rule are one table** (`nodes/lib/copyIds.ts`), and
**every reader comes through `copyIdsSettings`** — the node for its enum options, the card for its
button, and both exporters for the text they emit. That is `heatmapPaletteOf`'s arrangement, which
sits two imports away in the same emitter files: a headless `*Of(params)` resolver rather than a
table each surface indexes for itself. The failure it rules out is a separator the card offers and
a notebook does not honour; the two exporters are where that is silent, since their goldens compare
emitted text and would keep passing on either answer. It is keyed by a **name** rather than holding
the character, because the character is what the param would then store: `'\n'` in a saved graph
file, where a reader has to work out which control an escape belongs to. `joinIds` takes the ids
rather than the table, which is what lets the Network viewer's own **Copy ids** — a list in hand,
no table anywhere — use the same joiner. Two more rules live there and both are silent when wrong: deduplication keeps **first-seen
order** rather than sorting, since a Sort upstream is a decision; and `idColumn` is what reads the
column, so an 18-digit CAVE root id is copied exactly and a null — a left-joined `Neuron Set` row
— is dropped rather than pasted as a blank line.

**Both exporters emit a note, not a TODO**, which is the distinction `dataset.description` makes
for the opposite reason. `ctx.todo` means "no code came out of this" *and* "this step is missing":
the first is false, because withholding a tap's binding leaves every cell below a mid-chain Copy
IDs unbound, and the second is not the right reading either — the ids translate exactly. What a
notebook has no equivalent for is the *clipboard*, so the cell builds the same text, prints it,
and says why. It honours all three settings, because the emitted line is the one thing a reader
compares against the card.

## IDs from Label: the inverse query

`neuron.idsFromLabel`, added from `Add ▸ Query ▸ IDs from Label`. Every other query node
narrows a population; this resolves a **named set** — labels in, the neurons carrying them out.

**It is not `Find Neurons` with a different label, and the overlap is worth knowing so nobody
"simplifies" one into the other.** A `type is one of LC4, LC6` row in Find Neurons returns exactly
those two types, and does it through the same indexed `IN` list. That case is genuinely covered.
What is not is where the labels actually come from: the `preType` column of a Connectivity result,
a `groupBy` roll-up, a list pasted out of a paper. None of those can be typed into a regex field,
and the node that turned a column into an alternation would be this node with an extra step.

**Labels arrive from two places and they union.** A `Labels` text param and an optional `Labels`
table input with a column picker. Not one overriding the other: both are things somebody asked
for, and a node that silently dropped the text field the moment a wire arrived would look correct
— the result is a valid neuron table either way. `collectLabels` in `nodes/lib/labelLookup.ts`
owns the union, deduplicating with first-occurrence order kept, because that order is what the
unmatched report is printed in.

**`LabelMatch` is a member of `FindNeuronsRequest`, not a third pattern field.** The seam had
`typePattern` and `instancePattern`, hardcoded to the only two fields anyone had needed; a lookup
on `class` or `hemilineage` would have been that same edit twice more. So the request names the
**property**, which is what lets the field picker read the dataset's _discovered_ neuron schema.
That reasoning is the seed of the filter rows above — applied once more, to its conclusion — and
`LabelMatch` survives beside them because this node resolves a named set rather than narrowing a
population, which is a different question with a different empty state.
The literal form compiles to `n.\`type\` IN […]`, which neuPrint has indexed — the equivalent
regex alternation expresses the same set and forces a scan of every `:Neuron` in the dataset.

**Empty `values` matches nothing.** A source implementing `LabelMatch` must not read an empty
list as "no filter" — an unconfigured node firing an unbounded `MATCH (n:Neuron)` at a shared
production Neo4j is a hazard, not a default. This was written as an *inversion* of the field
beside it, because an empty `typePattern` on Find Neurons meant "do not narrow", i.e. everything.
That is no longer true: Find Neurons answers an unasked question with no neurons too, and the
argument it was brought to is the one made here first. The node
answers that case without a query at all, returning an empty table _of the right schema_ so
downstream column pickers populate before anyone has typed anything.

**Literal is the default; regex is opt-in.** A label is text somebody copied out of a result, and
`SMP001(a)` and `5-HT` carry regex metacharacters — reading those as syntax turns a lookup into a
different question with no error to say so. Under `regex`, each value is matched with the same
anchored whole-string semantics a `matches` row has, and `MockSource` wraps in `^(?:…)$` exactly as
`compileRegex` does, so the two sides of the seam agree.

**Each regex is matched on its own — `any(p IN […] WHERE n.f =~ p)`, never one alternation.**
`=~` anchors the _whole_ pattern, so folding `LPLC1|LPLC2` into a surrounding `^(?:…)$` splices
its alternation into the outer one and quietly matches a superset of what that entry means alone.
Per-pattern matching gives each entry exactly the semantics it would have in Find Neurons' Type
field, which is the only comparison a user can make.

**Null handling falls out rather than being coded.** A neuron with no value yields `null IN […]`
or `null =~ p`, both null, and Cypher's `WHERE` keeps only true; `toLower(null)` is null too, so
the case-insensitive form needs no guard. The mock reproduces it explicitly — a missing
`hemilineage` is not a match for the empty string.

**There is no `limit`, and its absence is load-bearing.** Every other query node has one. Here it
would make the card lie: the readout reports which labels matched nothing by reading the _result_
back, so a truncated result would name labels as missing that are in the dataset. A lookup of a
named set has a size the question already fixes.

**Status defaults to `Traced`**, as Find Neurons always has, so the same label does not return two
different counts in two nodes. Advanced, so changing it is a deliberate act.

### Reporting what matched nothing

A card readout (`ui/nodes/IdsFromLabelBody.tsx`), derived from the run — **not** a warning
reported by it.

**There is no run-time warning channel, and this deliberately did not add one.** `validate` runs
at edit time with types and no values, so it cannot know what matched. A `ctx.warn` would have to
be carried on `NodeRunInfo` _and_ on the `CacheEntry`, or it vanishes the moment a result is
restored rather than recomputed — a warning that disappears while its result stays is worse than
none. The miss is derivable from what the node already publishes, so it is derived: correct after
a reload, correct from cache, and with nothing new to keep in step. Same reasoning and same idiom
as `PathsBody`. If a second node ever needs this, the channel is the right answer then; one node
is not enough to justify it.

**`unmatchedLabels` refuses in two cases, and the refusals matter more than the arithmetic.** No
result table means the node has not run, so there is nothing to be missing from. A field the
result does not carry means silence — "nothing matched" over a table full of matches is a
specific and wrong claim, where saying nothing is merely unhelpful. (Every source returns the
property it was asked to match on, so the second should not arise.)

**The positive half is shown too**, `1,204 neurons · 18/20 labels`. A line that appears only when
something is wrong is a line nobody learns to look at.

**A custom body replaces the generic param rows outright**, so this one renders the same
non-advanced set the card would have, in declaration order, rather than a chosen few — a control
a body forgets is reachable only from the inspector, which on screen is indistinguishable from a
control that was never added. `idsFromLabelBody.test.tsx` asserts the list.

## Input IDs: the ids themselves

`neuron.inputIds`, `Add ▸ Query ▸ Input IDs`. Somebody has neuron ids from a paper, a spreadsheet
or a colleague. `IDs from Label` resolves a _named_ set; this takes the ids.

**The Dataset input is optional, and that is the whole design.** Unwired, the node emits the ids
as a one-column `Neurons` table and touches no network — already enough for most of what a list
of ids is _for_, since `Connectivity`, `Skeletons`, `Meshes`, `Synapses` and `ROI Counts` all
reach their ids through `idColumn(table, 'neuronId')` and read nothing else off the row. Wired, it
fetches the full neuron rows, which buys the columns every downstream picker wants and — the part
worth having — the ability to say **which ids the dataset has never heard of**, which is how a
mistyped id is caught and is otherwise uncatchable.

**`expensive` either way, because `cost` is a static property of the definition.** A node that
_can_ issue a query must not be `cheap`: the ids are a text field, and `cheap` would fire a query
per keystroke at a shared production Neo4j (invariant 6). So the unwired case pays a Run press it
does not strictly need. That is the right direction to err and cheaper than the only alternative,
which is two nodes doing one thing.

**No status filter, unlike every other query node here.** `Find Neurons` and `IDs from Label`
both default to `Traced` so one label does not return two different counts in two nodes. Here
that would be a quiet lie: an explicit list of ids is an explicit set, and dropping one for its
status would remove a neuron somebody named _and then report it as missing from the dataset_.
Filtering belongs downstream where it is visible.

**The advertised schema changes with the wiring**, one column without a Dataset and the dataset's
whole neuron schema with one. That is the visible cost of an optional input and it is the honest
shape — advertising a `type` column that nothing will ever fill breaks every picker downstream
that believed it. Both branches are exactly what `evaluate` returns.

**`tableFromRows` defaults to `kind: 'table'`, and this node's port says `neurons`.** Passing the
kind explicitly is not decoration: a value whose kind disagrees with its port's declared type is
a disagreement nothing type-checks, and `selectTable` — the one op in the tree that branches on
`table.kind` — would take the wrong branch on a table this node had called neurons.

### Parsing, and what it refuses

`nodes/lib/idList.ts`, the sibling of `labelLookup.ts` and mostly refusals, which is exactly the
difference between the two: a label is free text and anything is a valid one, where an id is a
number and a token that is not one is a mistake somebody just made.

**Separators are whitespace, comma, semicolon — plus brackets and quotes.** The list very often
arrives as `[123, 456]` or `"123","456"`, copied out of a Python session or a JSON blob, and
refusing that paste on a punctuation mark refuses the gesture rather than the content. They are
separators and not _stripped_ characters, which is what keeps `12a` one bad token rather than a
`12` with something quietly discarded after it.

**A bad token refuses the whole list.** Skipping was considered and declined: a list of ids is a
list of neurons somebody means to look at, and dropping one quietly answers a different question.
The cost is real and accepted — pasting a spreadsheet column brings its header — so the message
says _"If you pasted a column, delete its header line"_ when the first token is a word, and only
then. A hint offered where it cannot be true is noise on top of an error.

**A wide id is now kept exactly, and the ceiling describes the data rather than JavaScript.**
This file used to refuse anything past `Number.MAX_SAFE_INTEGER`, on the grounds that `CellValue`
is a JS number so an `i64` column is really a float64 — `720575940379279312` stored as a
_different_ integer, identifying a different neuron with nothing anywhere to say so. That was
right for exactly as long as an id had to become a number on its way to a query, and the day it
predicted has arrived: see invariant 8 above. Ids are now carried as decimal digits,
so there is nothing to lose, and the refusal is a nineteen-digit width — a signed 64-bit maximum,
which is what both Neo4j and CAVE actually store.

Note what did _not_ move, and then did. With **no Dataset wired** the ids are the node's own
output, and that table's `neuronId` was an `i64` column — so the width bit there and only there:
`validate` warned and named the id rather than rounding it, and said to wire the Dataset that was
almost certainly meant. `ID_ONLY_SCHEMA` is `str` now, along with every source's id column
([invariant 8](invariants.md)), so the unwired branch carries an 18-digit root id exactly and both
the edit-time issue and the run's warning are gone. The value half had to move with it — that
branch built its rows with `Number(neuronId)` — and nothing in the suite caught the mismatch,
`tableFromRows` validating no cell against the dtype its column declares.

**The wired column drops what it cannot use instead of refusing**, and the asymmetry is
deliberate. Typed text is _authored_ — a bad token is a mistake somebody just made and can fix, so
refusing helps. A wired column is _data_, and a node that refused to run because one upstream row
had a null id would be unusable, which is why `idColumn()` has always skipped them. The card
counts what was skipped so the number is visible rather than the rows merely being absent.

**Ids are deduplicated, first-occurrence order kept.** A neuron listed twice is one neuron, and a
repeated row is double-counted by everything downstream that sums a weight. The order is what the
unmatched report prints in, so a report and the list that produced it read against each other.

**The parse is a pure function returning a message rather than throwing**, which is what lets
`validate` run it at edit time — so a refused list is reported while it is being typed — and lets
`evaluate` raise the _same sentence_. A badge and an error describing one problem differently is
how somebody concludes there are two.

### `FindNeuronsRequest.neuronIds`

A new field at the source seam rather than a `LabelMatch` on `neuronId`, and the reason is not
stylistic: `labelClause` compiles to a list of **string** literals, and `123 IN ['123']` is false
in Cypher — an empty result, with no error anywhere to explain it. `neuronIds` goes through
`idList`, which emits the digits as an unquoted integer literal.

**Present-and-empty means no neurons, never "no filter".** Deliberately unlike the label clause
beside it, which drops itself when empty and so reads an empty set as no filter at all; that is
safe there only because the node guards it. Relying on a future caller's guard for a clause that
would otherwise return the entire dataset is not a trade worth repeating, so this one compiles to
`n.bodyId IN []`. `MockSource` reproduces the same rule, or a node would pass its tests against
the mock and return the whole dataset against the real source.

### The readout

`InputIdsBody` shares a stylesheet block with `IdsFromLabelBody` — `.list-body`, renamed from
`.labels-body` when the second one arrived. The two cards are the same object: a paste target,
the node's other fields, and a line underneath saying what the run did and did not find. Two
copies is how the pair drifts on what that line looks like.

Derived from the run rather than reported by it, same as its sibling and for the same reason:
there is no channel from `evaluate` to a node's badge that survives a result being restored from
cache rather than recomputed, so a warning raised at run time would vanish while its result stayed
on screen.

**The miss is only reported with a Dataset wired.** Unwired the node hands back exactly the ids it
was given, so every id matches by construction and a `0 not found` line would be a fact about
nothing.

## List CAVE tables and CAVE table info

`cave.tables` and `cave.tableInfo`, both under `Add ▸ Dataset`. They answer the question a CAVE
datastack does not answer about itself — *what is in here* — and the reason that question needs a
node is written up in [backends.md](backends.md#a-datastack-does-not-describe-itself). Before
them, the only way to learn that `hierarchical_neuron_annotations` was FlyWire's cell typing was
to already know: `CAVE table` has a text field with `nuclei_v1` as its placeholder, and anything
else got a 404 at Run.

The fetching is `data/cave/tables.ts` and is documented there and in
[backends.md](backends.md#discovery-what-is-in-a-datastack). What follows is what the *nodes*
decided.

### Two nodes, not one, and where the datastack comes from

Both arguments are stated where they are enforced rather than restated here — the module header of
[`src/nodes/dataset/caveTables.ts`](../src/nodes/dataset/caveTables.ts) for the split, and
[`src/nodes/lib/caveParams.ts`](../src/nodes/lib/caveParams.ts) for the reference port, the
wire-beats-field rule and the three refusals it shares with `CAVE table`. Restating them cost a
contradiction the day it was written: this file said a listing was "one or two requests" while the
module said "one".

### `kind` does not move with the Include views toggle

`List CAVE tables` publishes `table` and `kind`, and `kind` is there whether or not views are
included — reading `table` on every row when they are not. That is the whole argument for having
it: a schema that gained and lost a column when a checkbox moved would take every column picker
and every Filter downstream with it. A column saying something dull beats a column that was not
there.

**Views default on**, and the reason is FlyWire: `valid_connection_v2` is the pre-aggregated edge
list the entire CAVE connectivity path is built around, and it appears in no table listing at all.
A node faithful to `caveclient.get_tables` alone would omit the most useful object in the
datastack. Turning the toggle off is exactly `get_tables`, which is why it exists.

**Sorted, tables before views.** Not cosmetic: a node's result is cached by provenance
(invariant 4), so `evaluate` has to be deterministic for fixed params — and CAVE returns the
tables in query-planner order and the views as a JSON object, neither of which is a promise.

### The info goes on the card, the columns go on the wire

`CAVE table info` has one output socket carrying one row per column — name, dtype, and an example
value from the sampled row — and puts everything else on a custom body. Everything else is
*scalar*: a schema type, two row counts, a description. A property/value table would be a table
whose rows have nothing to do with each other, and the one thing worth reading at length is prose,
which does not survive being a cell.

The card fills from `peekTableFacts` without a Run, the way the Description card fills from
`peekDataset` — and it is `expandable` for the same reason and the same source of prose: FlyWire's
`nuclei_v1` publishes six paragraphs of provenance and a request for acknowledgement.

**The card shows two row counts and labels which is which.** They disagree by up to a third and
each answers a different question; [backends.md](backends.md#the-row-cap-is-a-per-deployment-number-and-counting-is-the-only-tell)
has the measured table and the round trip that showing one of them cost.

**The `type` column is a Coda `DType`** — `i64`, `f64`, `str`, `bool` — because those four are
already what the Upload card's column listing and the Table viewer's summary show. It is **blank**
where the one sampled row was null, which is a real hole (`superceded_id` on `nuclei_v1` is
exactly it) left as an admission rather than papered over with a guessed `str`.

And `pt_root_id` reports `str`, which is invariant 8 surfacing rather than a bug: an
eighteen-digit root id *is* text by the time anything in Coda can see it, and a listing claiming
`i64` would advertise a type no consumer will get. The notebook exporter's counterpart reports the
**pandas** dtype (`Int64` there) for the same reason from the other side — both are true of their
own runtime, and a notebook claiming Coda's answer would describe a frame the reader does not have.

## Neurons to ZapBench Traces: a join across two modalities of one specimen

`zapbench:neuronTraces` reads the released ZapBench calcium-imaging traces for whichever neurons in a
fish2 table carry a `zapbenchId`. The array facts, the cost model and the id measurement are in
[backends.md](backends.md#zapbench-a-released-zarr-array-not-a-server); what belongs here is what
the node decides.

### One output, and what removing the second one cost

`Matrix` only. The Heatmap is the only view for a trace population — there is no line chart in
the registry — and a matrix is what it takes.

There **was** a second port emitting the same values long (`label, zapbenchId, t, value`),
because `core.similarity` takes a table rather than a matrix and no matrix→table node exists. It
was removed because a trace matrix is **dense**: the long form is one row per neuron *per
timestep*, carrying the same numbers in four boxed `CellValue[]` columns against the matrix's one
`Float64Array`. Four times the memory, built on **every** run whether or not anything was wired
to it, and it was what set the node's refusal ceiling — `cells * 32` against the matrix's
`cells * 8`, so roughly 2,000 neurons over the whole recording rather than 8,000.

**That is a capability removed, not a tidy-up**, and the gap is worth stating precisely: nothing
downstream of a `Matrix` can currently compute a per-neuron statistic or a correlation.
`Normalize` and `Embed` take a matrix; `Linkage` takes one but reads it as *distances*, which a
trace matrix is not. Both belong one level up rather than in this node:

- **a reduction over a matrix's rows** — mean/max/min/sum/sd per row label — which is what
  "colour neurons by their activity" needs, and which is cheap on a dense matrix because it
  contracts rather than expands;
- **a matrix layout on `core.similarity`**, which for dense feature vectors is *cheaper* than
  either of its existing layouts rather than a relocation of the cost this removal saved.

Until one of those exists, a trace matrix is a dead end for everything that is not a picture.

### Row labels

`Label by` names each row of the matrix. It is **data, not decoration** — the opposite of
`out.dendrogram`'s `Annotations` pickers, and for the Heatmap's reason: what it writes is what the
Heatmap's Filter tab matches and what its Order tab sorts, so a presentational rename there would
show `LC4` while a filter typed `LC4` matched nothing.

A blank label falls back to the neuron's id, because blanks collide with each other on an axis
the Heatmap filters. A kept-but-unmatched neuron has no id to fall back to, so it falls back to
its **one-based row number in the input table**.

### Two ways to get the wrong neuron's trace, and both are silent

This is the whole reason the node has as much checking as it does.

**The id is off by one.** A `zapbenchId` is the 1-based segmentation label and the trace column is
one lower. Both readings are in range for every id but the two at the ends, so choosing wrongly
returns the *neighbouring cell's* trace — a real trace of a real neuron. `traceColumnOf` is the
one statement of the subtraction and `pnpm probe:zapbench` is the measurement behind it. There is
deliberately **no configuration flag**: a two-valued base was built first and the second value was
read by nothing, which is a setting pretending to be a measurement.

**The picker cannot be trusted, and that is `resolveColumn`'s rule 3.** A required picker still
holding its declared default falls back to *the first compatible column* when the schema lacks the
name. So on a table with no `zapbenchId` at all, `ZapBench ID` silently resolves to whatever comes
first and the node fetches traces at indices derived from body ids. Three things answer it, and
none of them alone is enough:

- `excludeIds` keeps `neuronId` out of the draw, which is the single likeliest substitution on a
  neuron table.
- `validate` says which column it is about to read whenever that is not `zapbenchId` — a
  **warning, not an error**, because a column holding these ids under another name is perfectly
  legitimate and nothing at edit time can tell that case from the substitution.
- `evaluate` refuses on an id set inconsistent with the configured base, naming both the observed
  range and the 71,721 columns the release has. This is the one that actually catches it: a fish2
  bodyId is around 10⁸, four orders of magnitude past the ceiling.

`traceColumnOf` answering `undefined` is where that last check lives, and `evaluate` **refuses**
on it rather than skipping the row: an id the release cannot place means the wrong column was
wired, not one bad row to drop. That is the one place this node refuses an id rather than counting
it, and the message names both the observed range and the 71,721 columns the release has.

### An unmatched neuron is kept or dropped, counted either way, never an error

"Some but not all" is the ordinary state of fish2: 62,178 of 235,057 neurons carry a match. So a
row with no id is left out, and the **count is warned about** — a matrix silently shorter than the
table it came from reads as a fetch that half worked. A row whose value is not a whole number is
counted separately, because that is a different thing from an absence: it says the column is not
what it looks like.

Only a table where *nothing* carries an id throws, and the message says that only some of fish2
does rather than implying the fetch failed.

**`Unmatched neurons` is which of the two you get**, and it exists because dropping silently
changes the row *order* as well as the count. That is right for a heatmap or a correlation — a
matrix of real measurements — and wrong the moment the result is joined back onto the table it
came from, or read as a colour channel, or clustered alongside it. Keeping holds position.

Three options rather than a boolean plus a fill picker: the two kept variants differ in one
value, and a second param meaning nothing under `drop` spends a row of the card being disabled
two thirds of the time.

**`NaN`, not `0`.** `NaN` is the house spelling for "no cell here" — `tableOps`' line totals write
it and `heatmapPlot` skips non-finite cells rather than reading them as zero — so a kept-but-
unmeasured neuron draws as a gap and aggregates as absent.

**Zeros are offered and are the dangerous one.** They are what some downstream code wants, and
they are a manufactured measurement among real ones — afterwards indistinguishable from a neuron
that was recorded and did nothing, which is `groupByTable`'s own argument for answering null over
an empty group. The warning says so in those words when that option is chosen.

(An earlier shape of this wrote `NaN` into the matrix and `null` into the long table, and that
asymmetry was argued at length: a `Float64Array` has no spelling for absence but a `CellValue[]`
does. The long table is gone, so there is one spelling and the argument with it.)

Two things the param deliberately does **not** reach. An **out-of-range integer still refuses** —
that means the wrong column was wired, not a missing match, and folding it in would turn a
`bodyId` into a silent matrix of nothing, which is the exact failure the range check exists for.
And a table where **nothing** matched still throws under every option, because a matrix of
nothing but gaps is not a result to hand on.

No `absentMeans`: a graph saved before this param dropped unmatched neurons, and `drop` is the
default, so absence and the default agree — the case `Min confidence` records as *not*
`absentMeans`'.

### `Condition` is not a convenience

Nine stimulus blocks, trimmed one timestep at each end exactly as zapbench's own
`get_condition_bounds` trims them (`[offset + 1, next - 1)`, inclusive-min/exclusive-max). The
axis carries **absolute timesteps of the full recording**, so a windowed read keeps its real
offsets and two windows are comparable.

It is the only control that reduces cost on the row-major copy, because neurons are on that
array's contiguous axis — [limits.md](limits.md) has the arithmetic. On the transposed copy the
node usually reads (see [backends.md](backends.md#two-layouts-and-why-the-reader-chooses-per-request))
a wide window is cheap and a narrow one over many neurons is what gets expensive, which is why
the *reader* chooses the layout and the node only reports what it chose. The default is still the whole recording: that is the
honest answer to "the traces for these neurons", and the cost is said out loud rather than
pre-empted by picking a stimulus condition on somebody's behalf.

### Why no `dataCache`

There is a session cache, but it is in memory rather than `loadCachedTable`'s IndexedDB layer —
`geometryCache.ts`' argument, plus its own: a structured clone of hundreds of megabytes of chunk
has a cost of its own, and the pain being solved is within-session iteration. So the node
deliberately does not declare `dataCache`, which would put a **Clear Cache** button on it naming a
persistent copy there is none of. `ctx.refresh` is still honoured.

The unit cached is one neuron's windowed trace (31.5 kB over the whole recording) rather than the
1 MiB chunk it arrived in, because that is the unit a *changed selection* hits on: adding a neuron
to a set of fifty reads one block and answers the other forty-nine from memory. Pinned by a test
that grows a selection and asserts which block was read.

## ZapBench Traces and ZapBench to Neurons: the way back from activity

`Neurons to ZapBench Traces` starts from neurons. These two go the other way: `zapbench:traces` draws the
recording, a Heatmap selection names a band of cells, and `zapbench:neurons` looks up the fish2
neurons carrying them — `ZapBench Traces → Heatmap ▸ Selected Rows → ZapBench to Neurons → Skeletons`,
with nothing to set on the last three. The array facts behind both are in
[backends.md](backends.md#the-pyramid-a-row-is-a-bin).

### A row is a cell, and at a reduced scale a row is several

`Every cell` reads the whole population over a window at a **Scale** — the release's own `s1` and
`s2`, which average 2 × 2 and 4 × 4 blocks of neighbouring cells *and* timesteps. `Cells I list`
reads typed ids at full resolution through `fetchTraces`, the reader `Neurons to ZapBench Traces` uses. Scale
is hidden for a list on purpose: a listed cell is cheap at full scale by the transposed route, and
at a reduced one it would come back averaged with neighbours nobody listed.

**The label carries the members** — `40211+40212+40213+40214` — which is `packs/zapbench/cells.ts`'
grammar, `cellLabel` writing it beside `cellIdsOf` reading it. That is what keeps a selection exact
without the second node knowing the scale that drew it. The rejected alternative was a `Scale` param
on `ZapBench to Neurons` expanding a row index: a second copy of a fact the first card decided, and
wrong the moment somebody changed one card and not the other. A label also survives the Heatmap's
Filter and Order tabs, which an index does not.

Rows are in **activity order** — the rastermap permutation — because that is the only order in
which 72,000 rows of calcium activity look like anything. A typed list keeps the order it was typed
in, because somebody chose it; the Heatmap's Order tab re-sorts either.

### The size is decided by params, so it is said on the card

Every cell at full scale over the whole recording is a **4.2 GB** matrix, and at half scale
**1.1 GB** — both past `CRASH_FLOOR_BYTES`. The shape depends on nothing but `Scale` and `Condition`,
so `validate` computes it and puts the sentence on the card before a Run, and `evaluate` refuses
with the same words. The default is **quarter scale over the whole recording**: 17,931 × 1,969,
about 144 MB read and 269 MB held. Full scale is fine over any single condition but the three long
ones (`dots`, `turning`, `open loop`).

Full scale reads the **row-major** copy even though the transposed one exists: every cell is every
block anyway, and row-major costs only the window's rows of each where the transposed copy bridges
nearly a whole chunk to reach them — 179 MB against 423 MB over `flash`. There is **no session
cache**, unlike `traces.ts`: that cache's unit is a neuron because a changed *selection* re-reads
one, and nothing here changes by one.

### The lookup is an integer lookup, and a string one matches nothing

neuPrint stores `zapbenchId` as an integer, and `n.zapbenchId IN ['5']` matches **nothing** with no
error. So neuPrint's `labelClause` writes number literals for any label lookup on a column the
**discovered schema** types `i64` or `f64` — asked of the schema rather than carried as a flag on
`LabelMatch`, which was the first version and made every caller remember how a server stores a
field. A local source needs nothing: it compares `String(cell)`, already an integer's canonical
text. The same seam was broken one clause over and is fixed the same way: a Find Neurons row
`size is 5` compiled to `n.size = '5'` and returned no neuron on neuPrint, while the identical row on
a local source compared as numbers and returned them. `rowClause` now reads the schema too, so
`is`/`is not` on a numeric column write a number literal and drop case folding — `cellMatches`'
rule, and resolved case-insensitively as `resolveRows` resolves the field.

Four more decisions on `ZapBench to Neurons`:

- **No population filter** — `datasetRequest`, not `neuronSetRequest`. A cell id names a body
  already, and narrowing a named set to Traced would report the narrowed bodies as *cells with no
  EM neuron*: a false claim about the release. `Input IDs`' reason, one layer over.
- **The picker takes `excludeIds` and is `optional`.** `excludeIds` filters `neuronId` alone (a
  first draft skipped it on the belief that the name rule `isIdentifierColumn` would hide
  `zapbenchId` too — it is not what `availableColumns` reads), and `optional` means rule 3 never
  substitutes a first compatible column for a missing `label`. A neuron id wired under another name
  meets the **range refusal** — out of range by four orders of magnitude, so the message says that
  is what they look like and names `Selected to Neurons`. The likeliest way there is a Heatmap fed
  by `Neurons to ZapBench Traces`, whose rows *are* neuron ids.
- **Unmatched cells are counted, never an error.** 62,178 of 71,721 cells carry a match, so a
  quarter-scale selection routinely names cells with none; a count is what tells that apart from a
  lookup that half failed. A dataset whose neurons carry no `zapbenchId` at all *is* refused, since
  every cell would otherwise be reported as unmatched.
- **Rows follow the cells' order**, and the lookup is **batched** at Influence's `FRONTIER_BATCH` and
  joined by `concatBatches` (now in `tableOps.ts`) — the measured `IN`-list size, borrowed rather
  than re-measured for this query.

Neither node has an exporter: `zapbench:traces` for `zapbench:neuronTraces`' reasons plus the
permutation a notebook would have to apply, and `zapbench:neurons` because its cells arrive from a
node that has none.

**Not verified against a live server:** the integer lookup against neuPrint fish2 (the Cypher is
pinned by `neuprint.test.ts`, and `probe:zapbench` already reads the property as a number), and the
Heatmap's behaviour at 17,931 × 1,969 in a real browser — drawing, zoom and a shift-drag selection.
