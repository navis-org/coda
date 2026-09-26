# Node packs

A node pack is a set of nodes that register together and can be switched off together — usually a
directory under `src/packs/`, its types carrying the pack's id as a prefix: `zapbench:traces`.
Packs are **in the tree**: reviewed, bundled and registered in every build. What a pack is *for* is
letting a reader choose what is offered — in the **Plugins** dialog, or by following a shortcut
such as `/cortex` — without a file that uses a hidden node ever failing to open.

ZapBench was the first pack, and it was moved rather than written, so that every seam was built for
a pack that already had to work. Connectome and its three parts followed, moved rather than written
too, and are the exception to both halves of the first sentence: they keep built-in ids, and some
of their nodes are built outside the directory (below).

## What a pack is

```
src/packs/
  index.ts              PACKS — the one list, registered in order
  shortcuts.ts          SHORTCUTS — the ways in that switch packs on
  zapbench/
    index.ts            the PackDefinition: id and nodes
    traces.ts …         the node modules, each exporting a packNode(...)
    cells.ts            anything the nodes share
    glyphs.ts           default export: type → drawing, merged into NODE_GLYPHS
    seeAlso.ts          default export: See also groups, merged by help/seeAlso.ts
    wizard.ts           default export: Workflow Wizard answers, merged by wizard/contribute.ts
    help/traces.md      the document for zapbench:traces
  connectome/           twelve node modules and a manifest; keeps built-in ids
  neuprint/ cave/ catmaid/
    index.ts            a part of Connectome: its backend's dataset nodes and tools
```

**Two kinds of seam, and which is which is not taste.** The nodes are *registered*:
`registerPack` takes the manifest and registers each node, and `src/packs/index.ts` lists every
pack explicitly, for the reason `nodes/index.ts` gives — an analysable bundle and a deterministic
order. Everything else is *found by file*: `ui/glyphs.ts`, `help/seeAlso.ts`,
`help/registry.ts` and `wizard/contribute.ts` each glob the one file they need out of every pack
directory. The split is
forced by `nodes.html`, which draws the glyph table and holds **no node definitions at all** — a
glyph table that imported the manifest would pull every pack's nodes, and their data layers, in
behind a static page. The help registry already worked this way (a document exists because its
file does), so the glob is the existing rule extended rather than a second one.

A help document's filename cannot carry the colon, so `packs/<id>/help/<name>.md` is read as
`<id>:<name>` (`typeOfPath`). A pack's help cannot carry images yet: the image glob covers
`help/images` only. The glyph and See also files are under a lint rule of their own, for the same
`nodes.html` reason: **type imports only, and nothing from the pack**. A value import of `./traces`
to reuse a type string passes every test and puts the node, and its data layer, in the static page's
bundle — probed, the rule refuses `'.'`, `'./traces'` and `'../../nodes/…'` and lets `import type`
through. A pack glyph that names a type the built-in table already draws throws at module load
(`NODE_GLYPHS`), since whichever table was spread last would otherwise win in silence — possible
only for a pack keeping built-in ids.

**A pack's type registers only through its pack.** Both entry points reach one private
`register(def, pack)`: `registerNode` passes no pack and so refuses any `pack:` type, and
`registerPack` passes its own id and so refuses a built-in type or another pack's. A parameter
rather than a flag set around the loop, so nothing reached during a pack's registration can be
judged against the wrong pack. That is the line the switches draw: every node of a pack is known
to be its. `packNode` exists only to type a definition the way
`registerNode` would without registering it.

**No two live types may share a `typeKey`** — the id with each run of punctuation folded to `-`,
which is exactly what the node guide's anchors are made of (`nodeAnchor` calls it). A first version
refused a pack named like a built-in *family*, which caught `neuron:findNeurons` beside
`neuron.findNeurons` and missed a hyphenated pack: `dataset-catmaid:fafb` folds onto
`dataset.catmaid.fafb` just the same. The rule is on the key itself, so it holds whichever side
registers first. Former ids stay out of it, which is what keeps a renamed type on its old anchor.

`packs.test.ts` holds the set together by the same globs the surfaces use: every directory with an
`index.ts` is in `PACKS` under its directory name, every node belongs to its pack, a pack's
drawings name only its own registered nodes, and each See also group it brings contains one of its
own nodes. It also sweeps what nothing else would catch: **every dataset family and custom dataset
node has a registered node** — one whose backend no pack lists would be offered in New, on the start
page and in the wizard while its type did not exist. `sources.test.tsx` switches each backend off in
turn, since a Connections tab whose `pack` is misspelt shows for good.

A pack id is checked at `registerPack` (`packIdProblem`): lower case and digits, single hyphens
between. **Treat it as permanent** — it is in every reader's stored switches, in every placeholder's
message and in each type's prefix, and nothing maps an old pack id to a new one.

## Seams are built when a pack needs them

The first plan was to turn every static table a node touches into a registration point up front:
card bodies, glyphs, help, See also, dataset families, wizard options, toolbar descriptors,
shortcuts, Screen Map spots. ZapBench touches four of those (nodes, glyphs, See also, help), and
most of the rest would have had no consumer until a light-level pack existed — so their shape would
have been a guess. Shortcuts arrived with the Plugins dialog, and the parts reached the family table
through the node types (below). The rest arrive with the pack that needs them.

**Where a pack's other code lives today.** A card body is still registered in
`ui/nodes/nodeBodies.ts`, and an emitter in `export/python` and `export/r`, keyed by the type like
everything else — `pack:name` there too. Neither is in the pack's directory: `src/packs/**` is
imported by the MCP build, which must stay headless, and a card body "beside its node" would reach
it. Moving either into a pack is a new seam, and it wants the checklist below.

**Adding a file-found seam** takes four things, each of which ZapBench's three needed: the glob in
the surface that reads it (never an import of the manifest); a lint rule keeping the file light if a
static page reads it; an ownership check in `packs.test.ts` that every key the file names belongs to
that pack; and a line in the tree above.

What deliberately stayed put: **`src/data/zapbench`**. A transport is a fact about a backend rather
than about which pack draws on it, and moving it would have tested no seam.

## The type id, and renaming one

The grammar is `core/nodeType.ts`: `family.name` for a built-in type, `pack:name` (optionally
dotted further) for a pack's. The pack is the family, so a pack's local part needs no dot; the
colon is what keeps a pack's types from colliding with anybody else's, and what lets a placeholder
for a missing node say which pack it needs ([persistence.md](persistence.md)). `typeStem` gives the
readable part (`traces`) for things like a demo's node id; `packOf` gives the pack.

Moving ZapBench renamed its three types, `zapbench.traces` → `zapbench:traces` and so on, and a
rename loses every saved file unless something reads the old id. **`NodeDefinition.formerTypes`**
is that declaration — the type-level twin of `PortGroupDef.formerIds` and `ParamBase.formerId`, and
read the same way: `currentType` answers a stored id with its live one **only after the live id has
missed**. The readers of an id somebody *wrote* ask it — the loader, a `demo://` link, a Zoo digest,
and through `liveType` a plan's `add` and the MCP `nodeEntry`/`nodeHelp`, so a model carrying an id
from before the rename gets the node rather than "no such type". `getNodeDef` answers live ids
alone. `registerNode` refuses the ambiguous cases: a former id that is some type's live id, one
already claimed, and a live id some earlier type claimed as former. Former ids are not held to the
grammar — they are what files already say.

In `deserializeGraph` the order is load-bearing: a stored placeholder is restored to its original
*first*, then renamed, so a placeholder of a since-renamed type lands as the renamed node.

Three things the rename could have broken and did not, each for a reason worth knowing:

- **The node guide's anchors are unchanged.** `nodeAnchor` is `typeKey`, which folds every run of
  non-alphanumerics to `-`, so `zapbench.traces` and `zapbench:traces` are both
  `node-zapbench-traces`. A rename that changed the *letters* would break every external link to
  that entry.
- **The Zoo index keeps the old ids** in its layout digests, being written at deposit time. The
  thumbnail resolves each through `currentType`, so a renamed type still draws as itself; the
  index itself is regenerated rather than migrated. (No entry holds a ZapBench node today.)
- **Two parsers split on `:`**, and both had to learn that a type may contain one: the `coda-graph`
  node line and the `coda-params` header. Both now *find* the type with `NODE_TYPE_PATTERN`, built
  from the same pieces as `nodeTypeProblem`, rather than a character class of their own — the first
  patch widened `[\w.]+` to `[\w.:]+` and still refused a hyphenated pack id the registry accepts.
  `demo://` links check their type against the same grammar instead of a copy of the regex.

## Connectome: built-in nodes moved into a pack, keeping their ids

Connectome is the connectivity nodes that were built in: Connectivity, Paths, Influence, Adjacency,
ROI Connectivity, Synapses, Synapses Between, Synapses to Edges, syNBLAST, Partner Vectors, Match
Cell Types and Compare Connectivity — and, as its three parts, the connectome datasets (below). It
is on by default, and it is what a later pack builds on: Cortex will require the CAVE part, which
brings Connectome as its parent.

**The line was measured, not drawn.** Twelve nodes are unambiguously about synaptic connectivity;
a ring of thirteen more (the network builders and metrics, the Network Viewer, Flow Chart, Sankey,
the ROI widgets, Neuron Profile, Topology, Raw Cypher) is not. Of the twenty `nodes/lib` helpers the
twelve import, three are theirs alone and seventeen are shared — a pack may import the base, so
shared helpers stay put. Only **three imports ran from the base into the twelve**, each fixed by
moving a small thing to `nodes/lib`: `morphology.ts` held Synapses beside Skeletons and Meshes (the
two synapse nodes are `packs/connectome/synapses.ts` now, and the ceiling and id reading all four
share are `nodes/lib/limitParams.ts` — a pack importing a module that registers nodes is harmless
only while the import order happens to allow it), and
the wizard and the export plans read Compare Connectivity's dataset names (`edgeComparison.ts`
now). The ring was left built in: its graph and chart tools serve data that is not a connectome,
and take more shared viewer code with them.

**Its nodes keep their ids** (`keepsBuiltInIds`). Renaming twelve nodes to `connectome:*` would have
touched some four hundred references — source, tests, about seventy in help documents, the
assistant's catalogue — to change nothing a reader sees; ZapBench's three were worth renaming, these
were not. It is a declared exception to the grammar, never taken by a new pack's nodes, and it
costs two things: which pack a node is from is asked of the registry (`packOfType`) rather than read
off the id, and a placeholder for one cannot name its pack. Because the ids did not move, nor did
anything keyed by them: the glyphs stay in `ui/glyphs.ts`, the help documents in `help/nodes/`, the
emitters in `export/`, the See also groups where they were — only the node modules live in the
pack. `packs.test.ts` asserts the registry names each pack as the owner of each of its nodes.
**A new Connectome node takes a `connectome:` id**: the exception covers the twelve that moved,
and a new node carrying it would put its help in `help/nodes/` and its glyph in the built-in table
for no reason but precedent.

The moved nodes register at the `../packs` position in `nodes/index.ts`, not where each module was
imported, so they list later in `listableNodeDefs()` and the MCP `nodeTypeIds()` than they did.
Every surface a reader sees sorts by label; `wizard/demo.ts`' `producers()` breaks ties by insertion
order and measured identical.

Moving the modules changed no test: the suite imports `../nodes`, which registers the packs.

## Parts of a pack: neuPrint, CAVE and CATMAID within Connectome

The connectome datasets are in the Connectome pack too, as three **parts** — neuPrint, CAVE and
CATMAID, each holding its backend's published datasets, its custom node, and the tools that only
make sense against it (Raw Cypher; the CAVE table and root-id nodes). `PackDefinition.parent` is the
declaration. Demo Data stays built in (the tour, the default graph and offline use depend on it),
as do the Description card, Neuroglancer Source and the generic annotation nodes.

**A part is not a requirement, and points the other way.** Switching a pack off that something
*requires* is refused; switching a *parent* off takes every part with it. Each part keeps its own
switch while its parent is off — the dialog shows it greyed out with "Off while Connectome is off"
— so the parent coming back restores what the reader had. A part is offered only while it and its
parent are both on; a shortcut naming a part switches the parent on too; one level only, which
`registerPack` enforces with the parent registered first. Where the two rules meet, the
requirement wins: a pack needing CAVE holds CAVE on *and Connectome with it*, which is why
`effectiveOff` settles by repeating rather than in one pass. **Holding the parent on brings its
other parts back too** — Connectome held on for CAVE is Connectome on, so neuPrint and CATMAID are
offered again unless their own switches say otherwise. That is the rule applied rather than an
accident of it: a part is off because its switch is or its parent is, and neither is true. The
opposite case is refused *not* to hold: **a parent's own parts needing each other are no reason to
keep the parent on**, since they go off with it (`packsNeeding` skips them). `packDependencies` is
the one walk of both relations, following a requirement's parent's own requirements too.

**The dataset nodes are built where they always were.** One builder in `nodes/dataset` makes every
family's node from the family table, Demo Data included, so it now returns definitions rather than
registering them: Demo Data registers built in, and each part lists its backend's
(`datasetNodesFor(backend)`). A pack's node code may live in the base when the base's own builder
makes it; the pack is the list, not the directory.

**Two surfaces that do not read node lists.** New, the start page's dataset cards and the wizard's
first question read the *family table*, so a switched-off neuPrint had to reach them separately —
`offeredFamilies`, keyed on the family's node type (`dataset.<key>`). A family therefore belongs to
whichever part registers its backend's nodes; **a pack cannot yet own a family of its own**, which
is the question the Cortex pack has to settle. And the Connections dialog's neuPrint, CAVE and
CATMAID tabs hide with their pack — each tab *declares* its `pack` rather than being matched by name
— under the same offered rule (`offeredPack`): **a tab stays while the open workflow uses that
backend**, so somebody opening a hemibrain link with neuPrint off can still sign in. And **a tab
somebody asked for always shows** (`askedTab`) — an auth failure naming it, or whoever opened the
dialog with `openSources(tab)`: the dashboard tour's sign-in step asks for neuPrint by name, since
it comes before the tour has built anything that would keep the tab offered. A request with no way
to answer it is worse than a tab the switches would have hidden, and one mechanism for both was
the fix after a first version skipped the tour's step instead — losing the one step that fills its
cells. The data sources themselves stay registered, as every node does.

## A pack that needs another

`PackDefinition.requires` names the packs one builds on, and one rule governs them: **a required
pack is on whenever anything needing it is on.** The rule is headless (`core/packs.ts`:
`effectiveOff`, `packDependencies`, `packsNeeding`, `offeredPack`), so any reader of a switched-off
set applies it the way the dialog does; `ui/packSwitches.ts` only stores the switches and asks it.

- **Switching a pack on switches on what it needs**, transitively; a shortcut's notice names them
  too.
- **Switching off a pack something still needs is refused** — the switch is disabled, and its row
  says "Needed by …, so it stays on". Switching dependants off quietly was the alternative, and it
  turns off a thing the reader never touched.
- **The rule is in the derived set, not only in the gestures.** Stored switches can disagree — a
  requirement written off by an older build beneath a dependant written on — so `effectiveOff`
  holds a requirement on while its dependant is. The switch the reader sees cannot say one thing while the
  add surfaces do another.
- **A pack is registered after what it needs**, which `registerPack` enforces and `PACKS` is ordered
  for.

## Switching a pack off

A reader switches packs in the **Plugins** dialog — the puzzle-piece icon beside Connections, and a
link in the node browser's footer. "Plugins" on screen and "packs" in the code: the reader's word
for a thing added to an app, the code's for what one is made of; and a dialog of its own rather than
a section of the node browser, where it began, because a pack may one day bring more than nodes and
a footnote in the node browser was not visible enough. Switching one off **hides, and never
unregisters**: every pack stays registered in every build, so a workflow using a
switched-off pack opens, runs, saves and exports exactly as before. Unregistering would bring back
the broken-link problem the in-tree design exists to avoid, inside one deployment.

What is hidden is what is *offered* for new work: the node browser, the canvas **+** menu, the
command palette's node rows, the Workflow Wizard, and — for a backend's part — New's dataset rows,
the start page's dataset cards and the Connections tab. **A new surface offering nodes must read
`useOfferedNodeDefsByCategory` (or `useOfferedForNewWork` where it builds a new workflow)**: calling
the registry directly passes every test and ignores the switches. The assistant's catalogue, See
also links, the static node guide, recipes and the guided tours are deliberately left whole — a
recipe or a tour inserts exactly what it was written with, which a hidden node still is.

Four decisions, each with its reason:

- **One environment, per reader, in `localStorage`** (`ui/packSwitches.ts`, `hints.ts`' shape): a
  preference about the reader rather than any document, so a share link never arrives with somebody
  else's packs hidden. Each pack starts at **its own default** (`PackDefinition.defaultOn`, absent
  meaning on) and a switch wins. What is stored is only the switches actually **flipped**
  (`coda.packChoices.v1`, `{ packId: on }`) — by the reader, or by a shortcut on their behalf — and
  the switched-off set is derived, so a pack a later build adds still arrives at its own default.
  Storing the refusals alone, the first version, cannot record switching *on* a pack that starts
  off, which is exactly what a shortcut does. **One environment across tabs too**: a `storage` event
  from another tab drops the cache (`watchPackChoices`) — without it, a tab open since before another
  flipped ZapBench off would write its stale copy back over that choice on its next flip. Re-reading
  storage inside every flip as well was tried and dropped: the watcher already keeps the copy current.
- **A switched-off pack stays offered while the open workflow uses it.** Somebody extending a
  ZapBench workflow wants the ZapBench nodes whatever they chose for everything else. It is
  *derived* from the graph's node types (`packsIn`, per graph rather than per store publish), never
  switched on for them, so following a link changes no preference; the pack's row carries a
  **used here** badge (its tooltip saying the nodes stay offered while the workflow is open) so a
  switch that seems to do nothing is not a mystery.
- **One rule, `core/packs.ts`' `offeredType`**, handed to the registry's listings as a predicate on
  the *type* — so the registry never learns where switches are kept — and **undefined while nothing
  is off**, which every caller reads as "no filter": the common case costs nothing. **One seam in
  the UI**, `useOfferedNodeDefsByCategory`: every add surface reads its groups from that hook rather
  than calling the registry with an optional argument a new surface could forget.
- **The packs in use are one selector, cached on the graph's identity** (`usePacksInUse`), returning
  a joined string. The canvas **+** menu is memoised precisely to stay out of a node drag, which
  mints a graph per frame; subscribing it to the graph put it back in. A string compared by value
  re-renders nothing unless the set of packs changes, the walk runs once per graph however many
  surfaces ask, and while nothing is switched off it does not walk at all. The dialog's badge reads
  `useWorkflowPacks`, the same cache with the walk forced — it states a fact whatever is switched,
  and with every pack on the filter's own walk is skipped, which is where the badge was once lost.
- **The wizard's gate is built, not declared.** An answer is a chain, and nothing declares which
  node types a chain holds — the analyses are branches of `bodyOf`'s switch. `offeredCombinations`
  builds every combination `everyCombination` walks and keeps those whose every node is offered; each
  question then keeps the options some surviving combination agrees with (`canReach`, headless, so
  `wizard.test.ts` reaches it without the dialog). Measured at 0.04 ms a build, so
  66 combinations cost under 3 ms, and none is built while nothing is off. The wizard asks with
  *no* workflow — it mints a new one — so only the switches count there. `wizard.test.ts` pins it
  on the real case: Connectome off, the connectivity analyses go and the table-only ones stay.

**A list that has shrunk says why.** Switching Connectome off takes every connectome dataset out of
New and the wizard's first question, leaving Demo Data alone there — which reads as a broken build to
somebody who flipped the switch weeks ago. So both carry a note naming the plugin and opening the
dialog (`HiddenDatasetsNote`, `useDatasetsHiddenBy`). Each surface hands the hook the dataset
types *its* list filters, so the note cannot name a plugin for datasets that list never showed. It
names the switch the reader would flip:
`core/packs.ts`' `packsHiding` maps a hidden dataset to its pack, **or to that pack's parent when the
parent is off too**, since a part switched on beneath an off parent is not the switch that matters.
It reads the same switches-only filter the two lists do, so the note and the list cannot disagree.
The note is about datasets alone; a hidden *node* already has the Plugins link in the node
browser's footer. **Multiple datasets is not offered below two offered datasets** — Connectome off
leaves one, and Continue would refuse every answer the next question had. Opened from the wizard, the Plugins dialog is **portalled**, because two overlays at
one z-index stack in document order and the toolbar's copy drew underneath the wizard that opened it.
Checked in a browser: Connectome off, the wizard offers Demo Data and Multiple datasets and the note;
Open Plugins draws on top; switching back on and pressing Escape returns to the wizard with ten
options and no note.

Checked in a real browser, before the Connectome move: 119 nodes in the browser, ZapBench switched
off, 116 — the Query chip 20 → 17 — with the switch stored and the document no wider than the viewport. The Plugins button
sits between Connections and the Assistant, folds into `⋯` with them, and at 721px (one above the
fold) leaves the document no wider than the viewport.

## Shortcuts

A **shortcut** is a way in that makes sure some packs are switched on — `coda.science/cortex`, for
somebody told "go and try the cortex tools" (`packs/shortcuts.ts`). There is **one environment**: a
shortcut is not a separate app. It flips the same switches the Plugins dialog does, the packs stay
on afterwards wherever Coda is opened, and it only ever *adds* — it switches nothing off, narrows no
dataset list and changes nothing a workflow means.

- **`applyShortcut` says what it did**, in the status bar: "Switched on for you: …", naming only
  the packs it actually switched on, so a returning reader whose packs are already on is told
  nothing. The notice **takes itself away** after eight seconds — only if it is still the notice
  showing, so it never clears somebody else's — and keeps its ×. Every other notice still waits for
  its ×; auto-dismissal is this notice's, not a new rule for the channel.
- **A pack most readers do not need starts off** (`defaultOn: false`), and the shortcut is how the
  readers who do need it get it — which is the whole reason the two exist together.
- **A module list, with a sweep.** `SHORTCUTS` is listed the way `PACKS` is, so `packs.test.ts`
  refuses a shortcut naming an unregistered pack or an id a path cannot carry. The first is
  `cortex`.
- **How `/cortex` is served: a redirect page, then a query parameter.** A second HTML entry was
  ruled out — it brings its own sitemap page, canonical, noscript hero, meta description, analytics
  path and manifest scope, and would be a main-chunk entry, which `docs/pages.md` says an extra
  entry must not be. The plan was a path check in the main entry, and **that alone cannot work on
  this host**: GitHub Pages answers a path it has no file for with `public/404.html`, so the main
  entry never runs at `/cortex`. So each shortcut has a tiny page at `<id>/index.html`, **emitted by the
  build from `SHORTCUTS`** (`vite/shortcutPages.ts`, build only; no bundle, `noindex`) — a
  hand-copied page in `public/` was a second list, a shortcut without one falling silently through
  to the 404 — that `location.replace`s to `../?shortcut=<id>` — relative, so it works from a subpath, and **carrying the fragment**, so a
  `#!` link sent through the shortcut still opens. The main entry follows the parameter before the
  first render (`ui/shortcutRoute.ts`) and takes it back out with `replaceState`, keeping the rest
  of the address. Checked on a static server over `dist/`, which resolves `/cortex` the way Pages
  does (Vite's dev server has a fallback of its own, so it is not the test): `/cortex` lands on `/`
  with "Switched on for you: Cortex", and `/cortex/#hello` on `/#hello`.
- **A shortcut's switches outlive the pack that asked for them.** Following `/cortex` switches CAVE
  and Connectome on as the reader's own choices, so switching Cortex off later leaves them on.
- **What this replaced.** The first version was *profiles*: per-entry-point curation of the datasets
  New and the wizard offer, pack defaults per profile, switches stored per profile, and an active
  profile that had to be set before anything read it. That made `/cortex` a second app, which is
  exactly what it should not be — so all of it went, and what a shortcut needs is one list and one
  function.

## Cortex: the first pack off by default

`packs/cortex` — the Cortex Gallery and the cortical frames it draws with ([cortex.md](cortex.md)).
`defaultOn: false` and `requires: ['cave']`, so switching it on (or following `/cortex`) brings
CAVE and, as CAVE's parent, Connectome. Being the first pack that starts off, it is
what showed that **a reader's switched-off set starts from `packsOffByDefault()`**: three tests had
built one by hand from nothing, and read Cortex as on. Its card body is registered in
`ui/nodes/nodeBodies.ts` like any other, the pack directory being imported by the headless MCP
build.

## Wizard answers

A pack adds to the Workflow Wizard through `wizard.ts`: ways to choose neurons, single-dataset
analyses with the viewers they end on, and the dialog rows for its own viewers. Cortex was the first
— the gallery as a start, the laminar synapse profile as an analysis ([cortex.md](cortex.md)). The
rules a pack author meets are stated once, in the header of `wizard/contribute.ts`, and refused at
load; why they are those, and what a pack cannot add yet, is in
[wizard.md](wizard.md#a-pack-adds-answers).

## What a pack does not do yet

- **No card bodies, emitters, dataset families of its own or toolbar entries** from a pack.
  Wizard answers it has — see *Wizard answers*, above.
- **No extension points** on existing nodes, and so no slot conflicts to refuse — both wait for a
  pack that needs one.
- **No revival** of placeholders when a pack's node appears mid-session — see
  [persistence.md](persistence.md).
- **No clean-up of stored switches** for a pack no build registers: harmless while pack ids are
  permanent, which is the rule.
- **A help figure naming a pack node needs an `as` alias** to be wired: `zapbench:traces -> hm`
  parses as node `zapbench`, port `traces`. Every current figure uses one.
