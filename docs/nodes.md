# Node semantics

One section per node whose behaviour cost a decision. See also `adding-a-node.md`.

Moved verbatim out of `CLAUDE.md`.


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

**Every example carries notes** (`placeNote` in `examples/index.ts`), an overview above the chain
and two or three step notes under it. They are placed absolutely rather than through `place`,
because the node grid is a row of pipeline steps while a note spans several of them. Their source
runs through `dedent`: the markdown parser only recognises a heading at the start of a line, so a
`###` indented to match the surrounding code is a paragraph beginning with three hashes.

Two existing tests had to learn what an annotation is, and the change is the assertion rather
than an accommodation: `examples.test.ts` now expects `executed` to match the _dataflow_ nodes
and `graph.nodes` to be strictly longer, and `App.smoke.test.tsx` counts Run buttons against the
same subset. Counting a note as work is counting the comments in a program as statements.

## Pivot: a matrix and a wide table

`core.pivot` emits **both** shapes of one pivot. `Matrix` is what the heatmap and `Normalize`
take and is a dead end for every ordinary table op, since a matrix carries no schema; `Table`
is the same pivot wide — the row labels in a column named after the Rows field, then one
numeric column per column label — which is what makes a pivot sortable, filterable, joinable
and exportable as the CSV somebody wanted, with no second node in between.

**The table is reshaped from the matrix, not pivoted a second time.** `matrixToTable` in
`tableOps.ts` takes the finished `MatrixValue`, so the two outputs cannot disagree about the
aggregation, the labels or their order, and the data is walked once. It also means an absent
pair reads as `0` in both, rather than as a null the table half invented.

**The wide schema is observed, not derived, and this is the second legitimate use of
`observesOutputSchema`** after Raw Cypher. Its columns _are_ the distinct values of the
Columns field, so nothing short of reading the data can name them and `inferOutputs` may not
fetch (invariant 2). The lifetime is the same as Cypher's: unknown-shaped until the first run
and again after a reload, which reads downstream as "columns unknown" rather than as a table
with none. Note what that costs — the label column's name comes from a param and _is_ known,
but publishing it alone would be a schema that is half fresh and half stale, which is worse
than uniformly stale.

Consequently pivot is the one op in `tableOps.ts` with no `*Schema` half, and invariant 3 is
satisfied a different way: `pivot.test.ts` asserts the two outputs against each other, and
that removing the observation empties the picker on the node downstream.

**`Matrix` stays the first output**, so every saved graph keeps its socket positions, a link
dragged off the node starts there, and the footer — which summarises the first output — still
says `N × M`.

Two small things fall out of a matrix axis being labels rather than data. The label column is
`str` even when pivoted from `neuronId`, which still joins back against the numeric column it
came from because `joinTables` keys on `String(cell)`. And a column label colliding with the
row field's name is suffixed (`type`, `type_2`) rather than dropped, the same call
`joinedColumns` makes.

## Deduplicate

`core.dedupe`, `Add ▸ Transform ▸ Deduplicate`. `pandas.drop_duplicates`: name the columns to
compare on, and `Keep` decides which row of a repeated set survives — `first`, `last`, or `none`.

**It exists because the providers stopped deciding.** Measured against FlyTable's `main.info`:
58,340 rows, 56,309 distinct root ids, 1,089 neurons with more than one row, and one segment
appearing 104 times with its `side` reading left, center and center among them. That used to be
collapsed silently inside `shapeRows`; now it reaches the canvas, and this is the node that
decides what to do about it in a place somebody can see.

**`none` is a different question, not a third flavour.** `first`/`last` answer "one row per
neuron" and differ only in which row a Sort upstream put where; `none` answers "only the rows
nobody disagrees about", which is the conservative read when a repeat is a *conflict* rather than
a copy. That is `keep=False`, and it is the mode worth knowing about.

**Empty compares whole rows**, which is `drop_duplicates()`'s own default and `Select`'s reading
of an empty picker — so an unconfigured node answers "this file has exact duplicates in it" with
nothing set. A column that is *named* but absent is refused rather than dropped, `groupByTable`'s
rule: comparing on fewer columns than were asked for silently keeps **more** rows, which on a
table whose upstream schema moved reads as a dedupe that did not work.

**Row order is the input's in all three modes.** A row kept because it was *last* stays where it
was rather than moving to the end — pandas does the same, and a dedupe that also reordered would
be two operations wearing one name. Note the trap in the implementation: `lastAt.values()` is in
*first*-occurrence order, so the second pass walks the rows again rather than reading the Map.

**`rowKey` is shared with `groupByTable`** rather than written twice — the second-consumer rule,
and the two characters in it are the whole of its correctness. `\u0001` separates columns, so
`["ab","c"]` and `["a","bc"]` are different rows (the collision `uploads.ts` records for its own
content address); `\u0000` stands for a missing value, so a null is not the four-letter string
`"null"`, which a `str` column of somebody's annotation base very plausibly contains. Both are
mutation-checked, because both fail as a *plausible wrong table* rather than as an error.

**Not Group By**, which is the neighbouring control and collapses rows into an aggregate. This
keeps whole rows, so every column comes through with the value it had; that difference is what
stops the two being one node with a mode.

The R emitter is the one place in that file that leaves dplyr, and it says why: `distinct()` keeps
the **first** row and has no argument for the other two, where `duplicated(..., fromLast = TRUE)`
is exactly `last` and OR-ing both directions is exactly `none` — one idiom covering all three,
preserving row order, and needing no library. Python is `drop_duplicates`, with `subset` **omitted**
rather than passed empty: `subset=[]` compares on no columns, which makes every row a duplicate of
the first.

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
  address columns by name — `out.profile` validates on it, Connectivity Graph and Skeletons read it — so
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
returns 31,718,491 characters. The fix is to paste the redirect *target*, and it is worth
knowing because the URL that fails is the one GitHub's own UI hands you.

Nothing in the code changed for this; it is recorded because "is it the format or is it CORS" is
the first question anybody asks, and the header evidence answers it in one look.

## Type column, and combining several into one

Two names are Coda's rather than a backend's — `neuronId` and `type` (`annotationColumn` in
`data/annotations/types.ts`, and `TYPE_COLUMN_NAME` beside it). Every provider renamed onto the
first from the start; **the two import nodes now rename onto the second too**, which is the same
rule stopping being half-applied.

**They are a pair rather than a symmetry.** An id makes the table *Neurons* — the kind, the
socket, `uploadIsNeurons`. A type makes it *legible*, and missing it is entirely silent:
`typesOf` reads `type` by literal name, so a chain publishing `cell_type` leaves
`neuronType`/`partnerType` null on every connectivity row **while the schema still declares
them**, Explore Dataset's `PRIMARY = ['type', 'instance']` falls through to a guess, and Neuron Profile's type
roll-ups empty. Reachable on the case the feature exists for: FlyWire's published annotation TSV
names the column `cell_type`.

`renamedColumns` takes `[from, to]` pairs now and applies both in one pass, so a column cannot be
the source of one rename and the collision victim of the other. The first pair naming a source
wins, so the same column picked twice is the id — and both nodes' pickers withhold the id from
the type list, with `validate` catching the case a saved graph can still carry.

**Every column is offered as the type, unlike the id.** A rename is lossless whatever the dtype
and nothing downstream requires a type to be text, where offering a float as an *id* would invite
a Neurons table whose neuron ids are neither.

**The rename is not injective, and the annotation providers had to learn that.** `cell_type` and
`celltype` both become `type`, so a base carrying two of those spellings — or one whose own column
is literally called `neuronId` — maps two columns onto one name. Each shaper built its schema from
`annotationColumn`, seeded `data` from `schema.columns` so the second entry overwrote the first,
and pointed both targets at the surviving array: every row pushed into it twice and `makeTable`
threw `ragged columns — "neuronId"`, naming the one column that was fine, on a fetch somebody had
waited twenty seconds for.

`annotationColumns` is the rule for all **five** sites — `shapeRows`, `wideRows`, `pivotRows` and
both `peekColumns`, the last two because invariant 3 says the schema half and the value half must
agree and a collision resolved in one and not the other leaves a picker offering a column no table
has. It takes the id column's name first, then hands out the rest through `uniqueName`.

Note it needs **no `SHAPE_FORMAT` bump**, against that constant's own instruction, and the reason
is worth stating rather than assuming: the rule there is "the same reply would now produce a
different table". Every input whose shape changed here previously *threw*, so it was never cached;
every input that could be cached is byte-identical. Bumping would cost a 79 MB re-download to
invalidate entries that are provably unchanged.

### Combine Columns, and why it is a node

`core.combineColumns`, `Add ▸ Transform ▸ Combine Columns`. `dplyr::coalesce`, SQL's `COALESCE`:
the columns are tried in the order they were picked and the first holding a value wins. It exists
because an annotation dump routinely spreads one fact over several columns — FlyWire's carries
`cell_type`, `hemibrain_type`, `supertype` and `cell_class`, and a neuron missing the first very
often has one of the others.

**A multi-select on `Type column` was the alternative and is worse in three ways**, each of which
is about reach rather than taste:

- It would put the ability on **two** nodes, and want to exist on **four** — `annotation.caveTable`
  and `annotation.flyTable`/`seaTable` have exactly the same problem, and a SeaTable base with its
  type split across two columns would have no route to it at all.
- Coalescing is not a fact about types. `soma_side`/`side`, two id columns, two name columns: the
  same act, none of them reachable from a control called `Type column`.
- It is a large semantic act with an invisible result. On the canvas a Table beside it shows what
  came out; buried in an inspector multi-select, the precedence order is a thing you have to
  believe rather than read.

That is the annotation chain's own premise carried through — the socket takes an ordinary table
*so ordinary table ops can stand in it* — so `Type column` stays singular, mirroring `ID column`
exactly, and the general job is a general node.

**The picker already expresses priority**: `ColumnsField` appends in pick order and renders the
chips in that order, so the list reads left to right as "try this, then this" with no new UI.

Five rules, each of which produces a plausible wrong table rather than an error:

- **Null and blank are one absence.** `datasetStats.ts`' call, for its reason: a base publishes
  both for one thing depending on how it was edited. This is also exactly where the obvious
  spelling in each language goes wrong — `df[cols].bfill(axis=1)` and `dplyr::coalesce()` both
  read `''` as a value and stop the search, and FlyWire's TSV writes an unset `cell_type` as a
  blank field rather than as nothing. Whitespace is deliberately *not* trimmed: `" "` is odd data
  rather than absent data.
- **A result named after one of the picked columns replaces it in place**, which is the backfill
  case and the common one — `[cell_type, hemibrain_type] → cell_type` leaves the table with the
  columns it arrived with. Any other name appends, and a column merely already holding it is
  suffixed rather than overwritten, which is `renamedColumns`' rule and `joinedColumns`' before it.
- **Mixed dtypes widen to `str` rather than refusing**, which is the opposite of `stackColumns`
  and the difference is real: a stack meeting two dtypes under one name has found two different
  columns wearing it, where this picker *is* somebody saying these hold one fact. `i64` with `f64`
  is the one pair that reconciles without leaving numbers. A number reaching a text column is
  converted, or the dtype is a lie.
- **A column the schema lacks is skipped, not refused.** `groupByTable` refuses the same case
  because grouping on fewer columns silently keeps *more* rows; here it keeps fewer values, which
  the result column shows.
- **It warns and passes through when unconfigured**, never refuses — invariant 5's corollary, and
  the gap that let `out.barChart` carry a wrong refusal unnoticed for months for want of a
  node-level test.

`Source column` is optional and off by default, naming which input each value came from —
`core.stack`'s companion, and on a real chain it is how you find out that `hemibrain_type`
contributed two rows out of 139,248.

### Verified by running it, in both languages

`scripts/probe-cave-helpers.py` became **`scripts/probe-py-helpers.py`** (`pnpm probe:helpers`),
because a prefix naming one of two consumers is a claim that goes stale — the call
`.profile__tile` → `.tile` and `.labels-body` → `.list-body` already record. It now reads two
generated cells: the CAVE helpers out of `cave.ipynb`, and the general cell out of
`everything.ipynb` for `coda_combine`. It does not claim to cover the rest of that cell, and says
so.

Both languages were **run against the golden text**, not read: ten checks each — priority order,
blank-as-absent, null-as-absent, nothing-anywhere, a missing column, the source column, and the
widening — agreeing on all ten, R included, where R's widening happens by coercion
(`out[fill] <- col[fill]` on a logical `NA` vector) rather than by a rule anybody wrote. The
blank-as-absent mutation was confirmed to fail the probe.

And on the real file, through the real functions: the published FlyWire TSV parses as tab
(31 columns, 139,248 rows), `root_id` survives as `str` — the round-trip rule vetoing a *numeric*
reading of anything past `MAX_SAFE_INTEGER`, so an eighteen-digit id meets CAVE's string ids with
no conversion anywhere — and `[cell_type, hemibrain_type, supertype, cell_class]` takes 137,720
typed neurons to **139,166 of 139,248**, with 82 carrying nothing at all.

**+5.12 kB raw / +1.25 kB gzipped on the main chunk** (1,088.17 → 1,093.29 kB), measured against
a build of the same tree with the feature stashed out. Both emitters are in the lazily-loaded
`exporter-*.js` pair as ever.

**Not looked at in a browser**: the `Type column` dropdown and the chip order on a real card.
Both are existing components, so the standing of the WebGL viewers applies.

## Rename Columns

`core.rename`, `Add ▸ Transform ▸ Rename Columns`. Give one or more columns a different name,
leaving their values, dtypes and units alone.

**It is the general form of the two import nodes' `ID column`**, and that is the case it exists
for. Coda addresses exactly two columns by literal name — `neuronId` and `type` — so somebody
else's table, whose id is `root_id` and whose cell typing is `cell_type`, meets a Neurons socket,
a `typesOf` lookup or a Neuron Profile roll-up and quietly answers nothing. Upload Table and Table from
URL fix that at the point of import; nothing could fix it for a table that was **fetched** or
**joined**, which is what this is. `Table from URL → Rename Columns → Skeletons` is the chain.

**Renaming onto `neuronId` promotes to Neurons; renaming it away demotes.** The demotion has to
happen — the column is gone, so every downstream `idColumn()` would fail at run time on a kind
that is no longer true — and the promotion is what makes the node worth more than a cosmetic
tidy-up. What it will *not* do is promote a table it did not touch: `core.stack` states the rule
this respects, that a `neurons` kind is a **claim** the ids are neurons of a dataset and a plain
table which happens to carry a `neuronId` never made it. So the promotion needs an *applied*
rename naming the column, which is why the kind is read off `renamePlan`'s `applied` map rather
than off the pairs — a row naming a column an upstream edit removed has renamed nothing at all.

**`renamePlan` is the one analysis all four readers share** — the schema half, the value half,
the node's `validate` and its card. Computed separately it was the same walk two and three
times over per keystroke, and worse, the card and the badge answered "which columns are
missing" from two expressions free to drift apart. `resolveFilters` one node over has the same
shape for the same reason.

### The rows are a list, not a pair of params

A `columns` picker plus a matching list of new names needs no widget and is wrong in the way
that is hardest to see: the two lists are positional, so deleting the second of three columns
silently shifts every name after it onto the wrong column. A row carrying both halves cannot
come apart.

Stored the way `out.table` stores its filter clauses — an opaque `string[]` of JSON pairs
(`nodes/lib/renames.ts`), legible in a `.coda.json` — and for the same reason: a column name is
not a safe left-hand side for a delimited encoding, since a wide pivot names its columns after
label values and an uploaded CSV's header can hold anything at all.

**A blank row is component state, never a param.** `+ Add` draws a row and writes nothing:
`renames` is in the provenance key, so a row that renames nothing would mark the node stale and
everything downstream with it, for a control nobody has used yet. What the store holds is what
the run will do. A half-filled row — a column picked, no name yet — *is* stored, because that one
is a row mid-edit and dropping it would delete it from under the cursor on the next round trip.

**The column picker follows `ParamField`'s three-state rule and shares its widgets to do so.**
Unknown is not missing, and this node sits directly behind the node that makes that distinction
matter: `Table from URL` keeps its schema per URL in a session-scoped map, so a fresh session
publishes none. The always-present `column…` placeholder is what keeps the select out of
`SelectField`'s no-options branch, which renders *disabled* — the failure `columnField.test.tsx`
records, reached here from a second widget — and it doubles as the way back to unset.

### Nothing refuses; four things warn

Invariant 5's corollary: a node passing a whole table through has no business blocking every node
downstream over a half-typed row. So a missing source column, a blank target, two rows aiming at
one name, and the Neurons demotion are all warnings, and the run happens regardless.

**Two rows aiming at one name suffix the second**, which is `renamedColumns`' collision rule.
That function had to be generalised for this: the mapping **is not injective** and a widget lets
somebody express that in two keystrokes, where the import nodes' two renames have fixed and
distinct targets and could never reach it. Taking both literally emits two columns of one name —
`makeTable`'s ragged throw at best, a silently overwritten column at worst. It now allocates
every output name through one `uniqueName` set in two passes: renamed columns claim their names
first, so a column that only *happens* to hold a target name is the one that gets suffixed rather
than the one somebody chose.

### Both emitters, and the R trap

`df.rename(columns=…)` and `rename(any_of(c(new = "old")))`. Two facts behind those, each
verified against the real library:

- **`any_of` rather than a bare `rename`**, because bare `rename` **errors** on a column the
  frame does not carry (`Can't rename columns that don't exist`) where Coda's rule is that such a
  row renames nothing. `any_of` is the tidyselect form with pandas' tolerance.
- **R does not take a trailing comma in `c()`.** `c(a = 1,)` is `argument 2 is empty` — a
  parse-time error in a document knitr aborts on, not a stylistic wart. Python takes one in a
  dict, so the same shape one file over is perfectly legal, which is exactly how it got written.
  Caught by running the generated chunk.

**The mapping is resolved against the incoming schema before it is written out** (`renameMapping`),
so a collision comes out as the suffix Coda applies rather than as two columns of one name in
pandas or `rename`'s "Names must be unique" in R. With no schema — a Pivot upstream, a first run
— it falls back to the pairs as typed, which is the same answer whenever nothing collides and is
the honest limit of what can be known at export time.

### What it costs, and what was seen

**+6.70 kB raw / +2.19 kB gzipped on the main chunk** (1,163.87 → 1,170.57), measured against a
build of `HEAD` in a clean worktree — that covers the Join changes as well. Both exporter chunks
carry the emitters and `main` carries neither `renameMapping` nor the join scratch key.

Driven in a real browser over CDP against `pnpm dev`, since a four-column grid in a 320px card is
exactly what jsdom cannot see: both themes, two rows laid out at 130/9/130/18 with nothing
overflowing the card, `+ Add` growing it to 234px, the unwired card saying `Connect a table.`,
and no console errors. The one thing it showed that the tests could not is that
`cellBodyFiber (missing)` **truncates** in a 130px select — the marker is cut mid-word — so the
select carries its full value in a `title`, and the badge and the foot line both name the column
anyway.

## Select One: stepping through a collection

`core.selectOne`, `Add ▸ Transform ▸ Select One`. Forward and back through a table's rows, a
skeleton set or a mesh set, emitting the element you are looking at. The manual counterpart to
the `For each` in the TODO list — that would apply a sub-workflow to every element and collect
the results; this walks the same collection by hand. `Explore Dataset → Select One → Skeletons → 3D` is
the shape it exists for: one neuron of a result at a time, without editing a filter for each.

**Two indices, because browsing and deciding are different acts.** `index` is what the card is
showing and is presentational; `selected` is what the port carries and is not. That is Neuron Profile's
pager/pin split exactly, and it is here for the same reason: on a chain with an expensive node in
it, an arrow button that fires a full pass per press — and with auto-run on, fires it
_automatically_ — is not a browsing surface, it is a way to spend ten minutes of queries on a
gesture.

**`Live` is the opt-out, and it is presentational too.** Off, the arrows move `index` alone and
`Use this` commits. On, they move both, so the output follows the arrows — which is what anybody
wants on a cheap chain and exactly what they do not want on a costly one. The flag changes
nothing about what `evaluate` returns: `evaluate` reads `selected` and has no opinion on how it
got there. So it stays out of the provenance key, and toggling the mode invalidates nothing —
the same call `Download` makes about every one of its params. `selectOne.test.ts` asserts all
three flags through the scheduler _and_ on the params, because dropping one fails no type check
and the symptom (a graph going stale whenever somebody browses) reads as a scheduler bug.

**The choice is a position, not an identity, and that is a trade rather than an oversight.** An
index works on everything — a `groupBy` roll-up with no id column, an uploaded CSV of embeddings,
a mesh set — where the id-keyed selection `rowIds.ts` provides (Scatter's and Neuron Profile's) survives
an upstream re-sort but needs a column naming each element. What it costs is that reordering
upstream re-points the output. What it must not cost is a _silent_ wrong answer, which is why an
index past the end emits the **empty collection** rather than clamping to the last element: an
upstream filter that shrank the collection has not moved the choice, it has removed it, and
clamping would answer with a different neuron under the same number. Emptiness is a state every
downstream node already handles; a different neuron wearing the same index is not. The card says
so in words, naming the position and the length — "emitting nothing" alone reads as a broken node.

**`any` in, `any` out.** The type system cannot say "a table, skeletons or meshes", so the port
says `any` and the refusal is a validation question — the same call `out.profile` makes about
needing a `neuronId`. The output type is the input type untouched, so one row of a Neurons table is
still Neurons with the same columns and nothing downstream loses a column picker.

### What an iterable is

`nodes/lib/iterables.ts`, headless. Three value kinds are collections of independently meaningful
things: a table is rows, a `SkeletonsValue` is neurons, a `MeshesValue` is neurons.

**A `PointsValue` is deliberately not one.** It is the same shape — positions plus one attribute
row each — and stepping through it one synapse at a time is not a gesture anybody makes. That is
a judgement about the data rather than about the type, which is why the exclusion is a named list
rather than something falling out of a structural test.

**Taking one element preserves the kind and the schema**, which is what lets `inferOutputs` be a
pass-through. Only the counts change. The one thing that must **not** pass through is `bounds`:
they are a roll-up over the geometry, exactly as `degreeIn`/`degreeOut` are roll-ups over a
network's links, and a single skeleton still claiming the box of the twenty it came from frames a
3D viewer on empty space around it — which reads as a broken renderer rather than as a selection.
Same rule and same reason as `filterNetwork` recomputing its degrees. `detail` _is_ carried
through, because the level of detail is a fact about the fetch and taking one neuron out does not
re-fetch it.

`isIterableKind` is exported and used by both the node's `validate` and the card's foot line —
one list rather than one per caller, because two copies is how a node starts refusing a kind its
own card still offers to step through. `any` counts as steppable there: unknown is not a refusal,
the same distinction `columnSchemaFor` draws between an absent schema and an empty one.

### The card, and two things jsdom could not see

`SelectOneBody` is the pager, the commit button and the node's one non-advanced param. The foot
line is the whole of the design's honesty: with `Live` off, what is on screen and what is on the
port are two different elements for as long as somebody is browsing, so it always states which
element is being emitted.

Both of the following were found by pointing a real browser at it, and both are now pinned by
`selectOneBody.test.tsx` — which is the point, since neither throws:

- **"Connect a table" appeared on a card that was plainly wired.** Whether something is
  _connected_ is a fact about the graph and comes off the inferred **type**, which exists the
  moment the link is drawn; what is _on the wire_ is a fact about the last run and is absent
  until there has been one. Reading the second for the first sends somebody to fix a link that is
  already there — the same failure the exporter's unwired/blocked split exists to avoid. It now
  says `Not run yet.`
- **The Live checkbox was labelled twice.** `ParamField`'s checkbox draws its own label under the
  default `node` variant, and the generic card suppresses the row's label in **CSS**
  (`.param--wide .param__label { display: none }`) — so a body rendering both got "Live Live".
  The fix is `variant="inspector"`, which is what `ParamRows` already does and documents;
  borrowing the CSS half instead would drop the one boolean row out of the label column every
  other field in these bodies shares. jsdom applies no CSS, so the label **count** has to be
  asserted rather than looked at.

**One pre-existing bug came with it.** `.list-body` carried no padding, so all three cards using
it had their first few pixels painted over by `.coda-node::before`, the state bar down the card's
left edge — "ID column" read as "D column" on Input IDs and had done since it was written. It now
takes the same `calc(8px + var(--state-bar))` inset `.coda-node__params` does: a custom body
replaces the param band, so it has to replace its padding too.

**The Python emitter slices, never indexes.** `df.iloc[[i]]` and `nl[i]` both raise past the end
and both hand back a Series / a single neuron rather than a collection of one — where Coda emits
an empty collection of the same kind, and emits a collection either way. `[i:i+1]` is the one
spelling reproducing both, in pandas and in navis alike; the emitter branches on `ctx.inputType`
because a `NeuronList` takes it directly where a frame needs `.iloc`. The fixture carries **two**
Select One nodes for exactly that reason, or the golden file records only the half that happens
to be a DataFrame.

## Join: four directions, and one key column

`core.join`, `Add ▸ Transform ▸ Join`. Annotate the left table with matching rows from the
right. `Type` offers **left**, **inner**, **outer** and **right** — the complete set, and
`right` is not redundant with swapping the wires, because the output's columns stay in
left-then-right order either way, so nothing downstream has to be repointed to try the other
one.

**A duplicated key annotates; it never multiplies.** The side being *matched into* is
deduplicated first — the right for `left`/`inner`/`outer`, the left for `right` — first
occurrence winning. Which side that is flips with the direction, and getting it wrong costs a
row count rather than an error, which is why both emitters compute it rather than hardcoding
the right.

The consequence for `outer` is worth stating, because the obvious reading is the other one: a
**second** right row carrying a key the left also carries is *not* an unmatched row. It lost the
dedupe, and resurrecting it in the outer tail would reinstate exactly the multiplication the
rule prevents — drawn, worse, as a left-null row for a key that plainly matched. So "unmatched"
means *no left row carries this key*, never "this particular right row was not the one picked".

### The key column is one column, filled from whichever side had the row

The right key is dropped as redundant with the left's — it always has been — so a row arriving
from the right alone would otherwise have no key at all, which is the single most useful column
on it. It is filled from the right instead. That is exactly `dplyr::full_join(by = join_by(a ==
b))`; pandas keeps **both** key columns, and the notebook emitter rebuilds Coda's shape rather
than inheriting that. The alternative — keeping both, only under `outer`/`right` — was declined
because an output schema that changes shape with the join direction empties a downstream picker
every time somebody tries a different one.

**Where the two key dtypes differ, that column is reconciled by `mergedDType`.** Only `outer` and `right` can
put a right-hand key value into the left-hand key column, and only then do the dtypes have to
reconcile. Matching is by text already, so a `str` root id meeting an `i64` neuron id joins
perfectly well — but writing that string into a column *declared* `i64` breaks invariant 3, and
every picker, sort and formatter downstream believes the declaration. `mergedDType` is this
file's one statement of "can these two reconcile, and into what", so `i64` meeting `f64` stays a
number here exactly as it does in `stackColumns` and `combineColumns`, and only a genuine
disagreement goes to `str` — coercing to the left's dtype would silently round a wide id
(invariant 8). A left or inner join is untouched by it, which keeps the common case's numeric
sorting exactly as it was. `validate` names the resulting dtype on the card, because a column
changing dtype under every picker downstream is not something to discover after a run.

**Row order.** `left`/`inner`/`outer` keep the left's order, with the outer tail after it in the
right's. `right` keeps the right's throughout, which is what makes it the mirror of `left`.

### What was measured rather than assumed

The emitted code was **run against pandas 2.3 and dplyr 1.2 and compared row-for-row with
`joinTables`**, over all four directions and both key-naming cases. Three findings, each of
which was a plausible wrong answer before it was checked:

- **`drop(columns=[rightKey])` deletes the wrong column.** pandas suffixes the right key when
  its name collides with a left column (`postType_r`) and leaves it alone when it does not — so
  one spelling is right in one case and destroys the left table's own column in the other, with
  no error. The emitter renames the right key to a scratch name before the merge instead, which
  makes the drop knowable without needing the schema at export time. Same scratch-key idiom the
  label joins already use.
- **`left_on` and `right_on` naming the *same* column already produce one coalesced key column**
  in pandas, under `outer` and `right` alike — so the common case needs neither the fill nor the
  drop, and gets neither.
- **dplyr's `right_join` returns a different row *order*.** Coda emits one row per right-table
  row in the right's order; dplyr 1.2 puts matched rows in the left's order and unmatched right
  rows after them. The rows themselves are identical, so the chunk says so in a `NOTE` rather
  than contorting itself — reproducing the order needs a row-number column added, arranged on
  and dropped, in every right join.

**One pre-existing divergence was fixed on the way.** Coda has always dropped the right key
column; the Python emitter never did, so any join whose keys were named differently produced a
notebook with an extra column the canvas did not have. It was invisible because the fixture's
only Join used the same name on both sides — which is why the fixture now carries three.

## Stack Tables: the vertical Join

`core.stack`, `Add ▸ Transform ▸ Stack Tables`. `Join` widens a table with columns from another;
this lengthens one with rows from another. Two connectivity results from different seeds, a
hand-curated list added to a query result, the same analysis run on two datasets.

**Every column survives, and a gap is a null.** A column only one side carries is filled with null
for the other's rows — which is what null already means here: not recorded. The tidier
alternative, keeping only the columns both have, silently discards data that was wired in, and on
two neuron tables from different datasets that can be most of the columns with nothing on screen
saying so. Same call `Join` makes when it suffixes a colliding name rather than dropping it.

**A dtype clash is refused, not reconciled.** `neuronId` as a number above and text below is two
different columns wearing one name. Widening both to text keeps every value and removes the column
from every numeric picker downstream; coercing text to a number loses values outright
(`Number('n/a')`). Neither is a decision this node has grounds to make, so it names the column,
both readings, and stops. `i64` and `f64` are the exception and merge to `f64` silently: those are
the same kind of thing, and a count stacked onto a ratio is still a number.

The clash is **returned rather than thrown** by `stackColumns`, because both halves need it and
neither may throw — `inferOutputs` must not (invariant 2) and `validate` returns strings. Only
`stackTables` refuses, on exactly that list.

**A unit rides along only while both sides agree on it.** Nanometres stacked onto voxels is a
column with no single unit, and carrying one of them would label the other's rows wrongly.

**Rows keep input order and duplicates are kept** — `UNION ALL`, not `UNION`. Which of two
identical rows to keep is a real question with its own answer, and it belongs in the node that
asks it.

**Unknown until _both_ sides are known.** The result's column set depends on both, so publishing
the top's schema alone would advertise a table missing every column the bottom contributes, and a
picker downstream would be configured against a shape that never arrives. A dtype clash still
publishes the union using the top's reading — nothing is built from it, since `evaluate` refuses
on the same list, and it keeps the other columns pickable while somebody fixes the one that
clashes.

**Neurons only when both inputs are.** A `neurons` kind is a claim that the ids are neurons of a
dataset; a plain table that happens to carry a `neuronId` never made it. The type half and the value
half decide it the same way.

**Two inputs, chained for more**, exactly `Join`'s shape. Note the consequence for the source
column: it distinguishes the two inputs of the stack that _added_ it, so three tables want either
a distinct name per level or the labels set at each one.

**The source column is off by default and refused on a collision.** Empty adds none; a name adds a
`str` column holding `Top`/`Bottom`, or whatever the two labels say. Appended **last** rather than
first — it is this node's annotation, not part of either table, and pushing every real column one
place right on every stack reads as the data having moved. A name either input already uses is
refused rather than suffixed: the point of the column is to say where a row came from, and quietly
writing that into somebody's existing column is worse than untidy. The labels are `visibleIf` the
column is named, so naming the inputs of a stack that is not labelling anything cannot stale it.

Worth knowing that a genuine clash is reachable with nothing but built-in nodes, which is what
`stack.test.ts` uses: `core.pivot`'s wide table types its label column `str` even when pivoted
from an `i64`, so a pivot on `preId` stacked onto the connectivity table it came from disagrees
about exactly that column. Note also that the pivot publishes no schema until it has run, so
`validate` cannot see that clash at edit time and does not pretend to.

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

## Connectivity Graph: hops and direction

`Direction` offers `both`, and `Hops` traverses further than one synapse. Both changed what the
node _emits_, which is the part to read before touching it.

**The output is an edge list, not a partner list.** Columns are `preId`/`preType` →
`postId`/`postType`, plus `hop` and `direction`. Every row is oriented the way the synapse
points, always, so `Build Network` with source `preId` and target `postId` is correct for every
combination of params with nothing to think about. The old query-relative shape
(`neuronId` = the neuron you asked about, whichever way the arrow went) cannot survive either
addition: a `both` result mixes in-edges and out-edges, so half a network's arrows come out
backwards, and past one hop "the neuron you asked about" is not a thing a row can name — it is
whatever the previous hop reached.

**The `DataSource` seam did not change, and that is deliberate.** `fetchConnectivity` still
answers query-relative, because the Neuron Profile widget reads it directly through
`profileStats.ts` — "these are my upstream partners" is the right shape there and the wrong
shape here. The reorientation lives in `nodes/lib/connectivityOps.ts`, i.e. in the node.

**`hop` and `direction` are always present**, even at one hop downstream where they are constant.
A schema that gained and lost columns as Hops moved between 1 and 2 would silently clear every
downstream column picker pointing at them.

The rename is a breaking change and was taken as one: both bundled examples group by
`preType`/`postType` now, and a graph saved before this loses its column params on those two
names. Nothing repairs it — `validateColumnParams` reports the drift and the picker is re-chosen.

**`both` expands both ways at _every_ hop — the undirected ball, not two cones.** That is what
finds the neurons sharing input with a seed (up then down) and its co-inputs (down then up),
which is usually why anyone asks for two hops in both directions. The cost is that the frontier
grows by in-degree × out-degree per round.

**Edges are deduplicated on (pre, post), and that is not tidiness.** With `both`, an edge inside
the frontier comes back from each end, and `Build Network` sums the weight of every row joining a
pair — so a duplicate row is a doubled synapse count in the picture. `direction` is `both` when an
edge was reached from each end **at the same hop**, which on a seed set is exactly the set of
edges internal to it. An edge re-found at a later hop keeps the direction and the hop it was first
given; otherwise the label would drift with traversal order rather than saying anything about the
graph.

**Neurons are expanded at most once.** Connectomes are full of recurrent loops, so a BFS that
re-expanded a visited neuron would not terminate. The _edge_ back into a seed is still reported;
only the neuron is not re-queued.

**`minWeight` is the only throttle, and it prunes rather than filters.** It is applied by the
source, so an edge below it is never returned — which means it is neither a row nor a reason to
expand. Three hops at weight 1 is a genuinely large question and is asked as one; `validate` says
so above three hops as a **warning**, never a refusal, the same call `Find Neurons` makes about
`limit: 0`.

**Iterative frontier queries, not a variable-length Cypher path.** `-[:ConnectsTo*1..N]->` is one
round trip and was declined: it hands the whole expansion to a shared production Neo4j with no
chance to prune between hops, it would put a `hops` field in `ConnectivityRequest` for a concern
no source should own, and `MockSource` would need its own BFS regardless. Looping
`fetchConnectivity` instead means no source changed at all, the mock works for free, the BFS is
testable against a fake graph with no network, and progress can report per round.

**Known limit: the frontier is inlined into the query.** `idList` puts every id in an `IN`
list, so a hop-2 frontier of tens of thousands of neurons builds a very large Cypher string. Not
chunked, because chunking is only worth writing once a real query has actually failed on it — but
it is the first thing to suspect if a deep traversal errors at the transport rather than timing out.

## Paths: how does this reach that?

`neuron.paths`, added from `Add ▸ Query ▸ Paths`. `Connectivity Graph` answers "what is wired to
this?"; this answers "how does this reach that?", which is a different query with a different
result. Three outputs: a **Network** already pruned to the feed-forward connections on a route,
the **Layout** for it, and a **Paths** table of one row per route.

**The traversal runs on the collapsed graph, not on the neuron graph it was collapsed from.**
This is the decision everything else follows from. With `Collapse types` on (the default), `LC4`
is one node, a hop expands _every_ LC4 neuron, and the result is aggregated back to types before
anything is pruned or expanded again. So `LC4 → PLP1 → DNp01` is found even when no single PLP1
neuron both receives from an LC4 and projects to a DNp01 — which is usually the circuit somebody
means, and is **not** recoverable by collapsing a neuron-level result afterwards, because the
neuron-level search would never have returned either edge.

The knock-on is that **`Min synapses` is a threshold on type-level traffic**, a much larger
number than any one connection carries, and it is applied _after_ the `sum` rather than before.
Cutting each synapse group first would discard the many weak connections that are exactly what
adds up to a strong pathway.

**So the aggregation has to happen in the backend**, which is what `DataSource.fetchPathStep`
and `PATH_STEP_SCHEMA` are for. A type-level hop on male-CNS touches every neuron of every
frontier type and collapses to a few hundred rows; doing that client-side would mean
downloading the former to compute the latter, per hop. `pathStepCypher` does it in one `WITH`.

**The frontier is two lists, not one.** A neuron with no type stands as its own node — there is
nothing to collapse it into — so a frontier is a mix of type names and neuron ids, and
`sourceId`/`targetId` are null exactly when the key names a type. Both halves of the `WHERE`
are then index-backed, where a `coalesce(n.type, toString(n.bodyId)) IN [...]` would express the
same set and force a label scan of every `:Neuron` in the dataset.

**Both ends of a path step are `:Neuron`, unlike a connectivity fetch.** `connectivityCypher`
deliberately matches the far end as a bare node so a `Segment` below the neuron threshold still
counts towards a total. A route _through_ an unnamed fragment is not a circuit anyone traced,
and the fragment would be expanded at the next hop. Reporting a total and tracing a route want
different sets.

**The search is bidirectional, and that is what makes four hops askable.** Forward `⌈h/2⌉` hops
from the sources, backward `⌊h/2⌋` from the targets. Every edge of every route within the budget
is still covered — the edge at position p is reached forwards when `p ≤ ⌈h/2⌉` and backwards
otherwise, since then `L − p ≤ ⌊h/2⌋`. Each hop multiplies the frontier by the average partner
count, so halving the depth square-roots the work.

**A route's strength is its bottleneck**, the weakest link along it, and `N strongest` keeps
whole _routes_ by that measure. Summing was considered and is wrong for the same reason it is
wrong in `BuildNetwork`: it prefers a long chain of large numbers with a 2-synapse step in the
middle to a short one where nothing is weaker than 40. A bottleneck is also comparable between
routes of different lengths, which a sum is not — and the ranking deliberately spans lengths, so
a strong 3-hop route beats a weak 2-hop one.

**neuprint-python's `fetch_shortest_paths` was considered and declined**, and it is worth
knowing why, because it is the reference implementation and it _is_ the more efficient shape
for the question it asks:

```cypher
MATCH (src:Neuron {bodyId: X}), (dest:Neuron {bodyId: Y}),
      p = allShortestPaths((src)-[:ConnectsTo*]->(dest))
WHERE ALL (x IN relationships(p) WHERE x.weight >= $min)
RETURN [n IN nodes(p) | [n.bodyId, n.type]], [x IN relationships(p) | x.weight]
```

One round trip, and — the real win — no frontier inlined into the query, which is this node's
one known weakness at neuron level. It fails on two counts here, both of them semantic rather
than technical. `allShortestPaths` returns **only** shortest routes, so it discards the strong
3-hop route the moment any weak 2-hop route exists, which is the ranking's whole point. And it
walks `:Neuron` nodes, so it cannot run the _default_ mode at all: collapse-first needs the
traversal on the type graph, and Cypher cannot walk a derived graph without GDS. Its 5s default
timeout is also an admission that the query can run long. Do not swap the per-hop loop for it
without changing both of those decisions first.

**Ranking is depth-first with branch-and-bound, not enumeration.** The number of simple routes
is exponential in the hop budget. Bottlenecks only ever fall, so once the shortlist is full any
partial route already no better than its weakest member is abandoned whole; neighbours are
visited strongest-first so the bound bites from the first branch. `toTarget`, computed during
pruning, kills anything that cannot reach a target in the hops that remain.

**`topN: 0` means "as many as are worth listing", not literally all of them,** and that was got
wrong first. Eight layers of nine nodes is five million routes, each an array. Worse, with no
shortlist there is no _bound_, so the search degenerates into the full enumeration the
branch-and-bound exists to avoid — the first version of this hung the test run rather than
returning slowly. `MAX_PATHS_KEPT` (50,000) caps it and `truncated` says so — on the card as well now, through
`ctx.warn`, since a truncated ranking is "the strongest found" wearing the label "the
strongest" and a progress note is gone by the next repaint. The shortlist is a heap
keyed by the same comparator the final sort uses, because it is consulted on every branch: a
sorted array re-sorted per insertion is what made the `topN: 0` case quadratic.

**Pruning is what makes the network feed-forward, and it is an inequality rather than a rule.**
A node survives when `fromSource + toTarget ≤ maxHops`, an edge when
`fromSource[u] + 1 + toTarget[v] ≤ maxHops`. An edge running against the flow, or between two
nodes at the same depth with no way onward, fails it. Both distances are measured on the
_collected_ graph and that is exact rather than approximate here, precisely because of the
bidirectional coverage above.

**The network spans the kept routes, not the pruned graph.** A node reachable within the budget
but not on any route that survived the ranking is not in the picture — otherwise `N strongest`
would silently mean "N routes listed, everything drawn". `paths` on each node and edge counts
how many kept routes run through it, which is the nearest thing to a betweenness available for
free and reads well as a size encoding.

**No route is an answer, not an error.** "These two are not connected within N hops at this
threshold" is a real finding; throwing would block everything downstream from ever drawing the
empty result that says so.

**Known limit, same as Connectivity Graph's:** at neuron level the frontier is inlined into each
query, so a deep neuron-level traversal builds a very large Cypher string. `validate` warns
above three hops and warns again when `Collapse types` is off there. A warning, never a refusal
— the same call `Find Neurons` makes about `limit: 0`.

### The Layout output, and `T.layout()`

A new value kind: `{ kind: 'layout', positions: Record<id, {x, y}> }`, with a matching optional
**`Layout` input on `out.network`**. Fixed ELK layered, left to right, in `src/layout/network.ts`.

**A type rather than a table of `id`/`x`/`y`.** A layout is not data about neurons — it is an
arrangement computed _for_ a particular node set. A table would accept any two numeric columns
and fail at run time with a column picker to configure first.

**An input rather than another entry in the `Layout` enum.** Whether positions arrived is a fact
about the wiring, not a choice made in the styling panel: as a mode, the enum would silently
change under someone the moment they connected a wire, and stay changed when they pulled it.
Connected, it wins over the param, and the caption says `layout from input` — a control that
quietly stops doing anything is worse than one visibly overridden.

**It reaches `evaluate` never, and the drawing always.** `out.network` ignores the socket
entirely, so wiring one up invalidates nothing downstream. That is the same standing every
presentational param here has, arrived at by the value never reaching the output rather than by
a flag.

**Given positions are not normalised, unlike every computed layout in the viewer**, and nodes
they do not name fall through to the chosen algorithm rather than stacking on the origin — so a
layout that outlives an upstream filter degrades instead of collapsing. A layout matching
_nothing_ falls back entirely.

**`useStablePositions`, not `useStable`.** The structure effect is the most expensive dependency
list in `NetworkViewer` (`networkRebuild.test.tsx` is the guard), and `nodeInputs` mints a fresh
record on every store tick. `useStable` would `JSON.stringify` two floats per node on every
render; the fingerprint is one pass and no allocation.

**The layout is fixed rather than configurable, and that is the trade.** It is an _output value_,
so a spacing slider would take part in the provenance key and stale everything downstream when
nudged. Restyling is what the Network Viewer's presentational params are for.

**`src/layout/network.ts` is a sibling of `elkGraph.ts` and shares only the engine.** That module
maps editor cards — measured sizes, one ELK port per socket, a fixed port order so wires arrive
in the right handle. A network node is a disc drawn from its centre with no sockets at all, and
its size is whatever the encoding says at render time. So: a nominal box, node-to-node edges,
and **centres rather than ELK's top-left corners**, since sigma places a node at its centre and
corners put the whole picture half a box out. A dangling endpoint is dropped rather than
allowed to make ELK reject the entire graph.

`runElk` is exported from `engine.ts` for this. Both callers get one lazily-loaded engine, and
elkjs still never enters the main chunk — verify with `pnpm build`.

### The caption

`PathsBody` reads the node's own `paths` output and shows `N routes · min H hops · W syn
bottleneck`. A body rather than an entry in `describeValue`, because the footer summary is keyed
to the _first_ output — where "24 nodes · 31 links" is the right thing to say — and because a
body can say "not run yet" in its own words. Not `expandable`: there is nothing here that
benefits from room, and the routes themselves are a table.

## IDs from Label: the inverse query

`neuron.idsFromLabel`, added from `Add ▸ Query ▸ IDs from Label`. Every other query node
narrows a population; this resolves a **named set** — labels in, the neurons carrying them out.

**It is not `Find Neurons` with a different label, and the overlap is worth knowing so nobody
"simplifies" one into the other.** neuPrint's `=~` anchors at both ends, so `LC4|LC6` typed into
Find Neurons' Type field already returns exactly those two types. That case is genuinely covered.
What is not is where the labels actually come from: the `preType` column of a Connectivity Graph result,
a `groupBy` roll-up, a list pasted out of a paper. None of those can be typed into a regex field,
and the node that turned a column into an alternation would be this node with an extra step.

**Labels arrive from two places and they union.** A `Labels` text param and an optional `Labels`
table input with a column picker. Not one overriding the other: both are things somebody asked
for, and a node that silently dropped the text field the moment a wire arrived would look correct
— the result is a valid neuron table either way. `collectLabels` in `nodes/lib/labelLookup.ts`
owns the union, deduplicating with first-occurrence order kept, because that order is what the
unmatched report is printed in.

**`LabelMatch` is a new member of `FindNeuronsRequest`, not a third pattern field.** The seam had
`typePattern` and `instancePattern`, hardcoded to the only two fields anyone had needed; a lookup
on `class` or `hemilineage` would have been that same edit twice more. So the request names the
**property**, which is what lets the field picker read the dataset's _discovered_ neuron schema.
The literal form compiles to `n.\`type\` IN […]`, which neuPrint has indexed — the equivalent
regex alternation expresses the same set and forces a scan of every `:Neuron` in the dataset.

**Empty `values` matches nothing, which inverts the field beside it.** An empty `typePattern`
means "do not narrow", i.e. everything. A lookup of nothing is nothing. A source implementing
`LabelMatch` must not read an empty list as "no filter" — an unconfigured node firing an
unbounded `MATCH (n:Neuron)` at a shared production Neo4j is a hazard, not a default. The node
answers that case without a query at all, returning an empty table _of the right schema_ so
downstream column pickers populate before anyone has typed anything.

**Literal is the default; regex is opt-in.** A label is text somebody copied out of a result, and
`SMP001(a)` and `5-HT` carry regex metacharacters — reading those as syntax turns a lookup into a
different question with no error to say so. Under `regex`, each value is matched with the same
anchored whole-string semantics `typePattern` has, and `MockSource` wraps in `^(?:…)$` exactly as
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
of ids is _for_, since `Connectivity Graph`, `Skeletons`, `Meshes`, `Synapses` and `ROI Counts` all
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

Note what did _not_ move. With **no Dataset wired** the ids are the node's own output, and that
table's `neuronId` is an `i64` column, so the width still bites there — `validate` warns and names
the id rather than rounding it, and says to wire the Dataset that was almost certainly meant.

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
