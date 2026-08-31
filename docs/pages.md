# The three published pages

The overview, tutorial and node guide — extra vite entries that ship beside the app.

Moved verbatim out of `CLAUDE.md`.


## The overview page

A **fourth** vite entry — `overview.html` at the root, `src/overview/{main.ts,overview.css}` —
and the front door of the three documents that ship beside the app. The pair it completes reads
in one order: this one is what Coda *is*, the field guide is how it works, the node guide is what
each node does. Somebody deciding whether to open the editor at all reads this and nothing else.

Same construction as the other two: plain TypeScript, no React and no store import, importing
nothing from `src/ui` but `theme.css`. Verify with `pnpm build` — `overview-*.js` is **0.8 kB
raw / 0.46 kB gzipped**, its CSS is 25 kB (nearly all of it `theme.css`), and
`dist/overview.html` must reference no `main-*` chunk. If it ever does, something reached into
`src/ui` past the stylesheet.

The **dashboard** section sits directly after the editor thesis, because it is the same claim
turned round: having said the canvas is the document, it says you do not have to look at it. Its
figure is the arrangement the "Build a Dashboard" tour ends on — Explore top left, the selection
as a table below, Neuroglancer down the right at full height — so the page and the tour show one
composition rather than two. The figure is hand-placed with `grid-template` rather than the app's
auto-flow: it is a picture of a layout, and one that had to be reasoned about to draw would be the
wrong kind of copy of the thing it illustrates. Its neuroglancer panel takes the same literal
black the tutorial's does, and its viewBox is **landscape**, because the cell it fills is — a
portrait one under `slice` crops the arbours off at the top, which reads as a mistake rather than
as a close-up.

**Its script is a scroll reveal and a theme read, and that is the whole of it.** The page has no
camera and no pinned canvas — the field guide already owns that idiom, and repeating it here
would make the front door the longest of the three to get through. Every figure is static markup
in the app's own vocabulary: node cards with typed sockets, the Connections panel, a scatter
feeding a neuroglancer frame, two exported code cells, the assistant's plan, a share link.

**The sections are peers, so they are not numbered.** The field guide numbers its chapters
because it is a sequence read front to back; an overview's highlights are a set, and `01 / 02 /
03` down the side of one would be a structural device encoding something untrue. What they carry
instead is an **icon**, and three of the seven are `<use>`d straight out of the shapes in
`src/ui/Icons.tsx` — Connections' branch, the assistant's robot head, Share's box-with-an-arrow
— so the page and the toolbar draw the same glyph. They are **achromatic** on the same rule
`CodaMark` follows: every hue on this page already means a socket type, and a coloured section
icon would read as a typed port rather than as chrome.

The icon sits *before* the heading with `align-items: flex-start`, not `center`. Two of the
titles wrap to three lines at the default width, and a centred icon on one of those floats
halfway down the block beside nothing in particular.

### What the page claims, and what checks it

`overview.test.ts` exists because a static document is not a route: nothing in the app fails when
it goes stale, and this one had **already drifted before it shipped** — the mock-up it was built
from listed CAVE as "in progress" and CATMAID as "planned", months after both had landed. So two
claims are asserted against the registry rather than against a snapshot:

- **Every backend with a name, and every non-synthetic dataset family, must appear in the text.**
  A fourth backend or a seventh neuPrint dataset is then a failing test rather than a page that
  quietly under-reports what Coda reads. Both were confirmed by mutation.
- **The node count is a floor** (`60+ nodes`), compared against `listableNodeDefs().length`.
  A floor rather than an exact count, so adding a node does not fail a test that is about the
  page being *wrong*.

The test flattens the markup before matching, because the typography and the prose disagree about
how to spell a hyphen — `FIB-19` in the dataset card and `FIB&#8209;19` in the sentence beside it
are the same dataset to a reader and two strings to `toContain`.

**What is deliberately not asserted is the layout.** jsdom performs no layout, so the geometry,
the reveal and the mock widgets have the standing the tutorial's do: driven by hand.

### Two things the theme forced

**The wires in the canvas figure take their colour from CSS, never a `stroke` attribute.** A
presentation attribute does not resolve `var()`, so `stroke="var(--socket-dataset)"` comes out
black with nothing failing — the trap `tutorial/main.ts` records hitting from the other
direction. The paths carry `data-fam` and the stylesheet colours them.

**The syntax palette in the two code figures is per-mode, and it had to be.** Those are 11.5px
glyphs, so the floor is 4.5:1 rather than the 3:1 a mark gets, and the socket hues fail exactly
where a light-theme reader reads them: `--socket-dataset` is **2.67:1** on the light panel.
Measured against `--surface-1` in each mode — light `#0a7a52` 5.08, `#1f63b4` 5.69, `#4a3aa7`
8.12, `#6d6b66` 5.05; dark `#199e70` 5.27, `#3987e5` 4.93, `#9085e9` 5.74, `#898781` 4.99. Same
reasoning and the same three-block shape as theme.css's own `--status-warn`.

The neuroglancer figure's blacks and EM greys are the one place a literal is right: neuroglancer
renders on black whatever theme Coda is in, which is also why `out.neuroglancer` resolves its
segment colours in dark mode regardless. The orange in it is that dark-mode Matrix hue, so the
lassoed points and the segments they became are the same colour on screen.

Three entry points, all through `import.meta.env.BASE_URL`: the toolbar's `? ▾` (first of the
three, ahead of both guides), the start page's credits row, and the README.
`startPage.test.tsx` covers the two in-app ones.

## The tutorial page

A second vite entry — `tutorial.html` at the root, `src/tutorial/{main.ts,tutorial.css}` — built
into `dist/` alongside the app and published to GitHub Pages with it. Ten chapters. The first six
share one pinned canvas that builds a real pipeline as you read — `Hemibrain → Find Neurons →
Connectivity → Filter → Group By → Bar Chart` — then Explore Dataset/Neuron Profile, neuPrint, the keyboard and
saving get their own set-pieces.

**It imports nothing from the app but `theme.css`, and that one import is the whole design.** The
page draws node cards, sockets, wires and a run ring in plain CSS rather than mounting React Flow —
so a tutorial about what a Dataset socket looks like cannot disagree with the editor about it, while
costing none of React, sigma or three. Verify with `pnpm build`: `tutorial-*.js` should stay around
4 kB and `dist/tutorial.html` should reference no `main-*` chunk. If it ever does, something reached
into `src/ui` beyond the stylesheet.

**Naming both entries in `build.rollupOptions.input` is what keeps it.** Vite otherwise treats
`index.html` as the only root and drops the second page silently — it builds green and 404s in
production.

**The palette is used semantically, never decoratively.** Green means Dataset, blue means
Table/Neurons, orange means Matrix/Network, on the page exactly as on the canvas — including inline
in running text (`.ty--dataset` and friends). That is the entire chromatic vocabulary; everything
else is the warm neutral the canvas already is. Chips go through `--chip-1..8` rather than literal
hex, so they re-resolve on a theme switch like the real ones.

**Hidden-until-scrolled states are gated on a `js` class the script claims on `<html>`, and the
script is wrapped in a try/catch that gives it back.** Found by running the page under jsdom, which
has no `matchMedia`: the script threw on line one, and because `.rise` carried `opacity: 0`
unconditionally, _every section of the page stayed invisible_. A static page is a fine failure; a
blank one is not.

**Chapter 3 is the one the camera cannot serve.** It is about the _execution model_, and Run,
Auto-run and the per-node ▶ are toolbar and header chrome rather than things in the world the
camera pans over. So that chapter dims the canvas and draws the toolbar cluster and a card header
large over it, with a pulsing ring on the two controls. The frame is deliberately identical to
chapter 2's, so the canvas does not move under the overlay.

**The camera is given a box to fit, never a zoom level.** `FRAMES` names a world rectangle per
chapter and `camera()` solves for scale, so the framing holds at any viewport instead of being
tuned against one. `FRAMES_NARROW` is a genuinely different composition rather than the same one
smaller — a phone stage is about a third of a desktop one, and the desktop frames put the card text
under legibility there, so the narrow set holds fewer cards each and the anatomy callouts stand
down. Chapter 6's wide shot is deliberately illegible: the cards are texture and the point is the
shape of the chain.

**Wire colours go through `style.stroke`, not `setAttribute('stroke', …)`.** A presentation
attribute does not resolve `var()`, so the wires come out black with nothing failing.

**Socket positions are walked through `offsetParent`, not measured.** The world carries a
`scale()`, so a bounding rect would be in screen pixels and would change with the camera;
`offsetLeft`/`offsetTop` stay in world units. Same distinction as the auto-layout note above, for
the same reason.

**The run ring is sized explicitly.** `inset: -6px` on an `<svg>` is over-constrained, so
`right`/`bottom` are dropped and it renders at its 300×150 intrinsic size — the same trap
`NodeRunRing.tsx` documents, hit again here.

**Sticky becomes block flow under 980px.** A sticky grid item can only stick within its own row, so
the stacked mobile layout would scroll the canvas away the moment the prose began.

Three entry points, all through `import.meta.env.BASE_URL` since `base` is `'./'`: the start page's
credits row, the toolbar's `? ▾`, and the README. Its outro links on to the node guide, which is the
reference half of the pair. **`Docs` on the welcome screen is this page**, not
the repository's `docs/` folder — that folder is written for someone extending Coda, and the link is
read by someone who has just opened it. `startPage.test.tsx` covers both in-app ones; a second vite
entry has no route for anything else to catch going missing.

The page itself has no test. jsdom does no layout, so the camera, the pinned stage and the wires
are exactly the class of thing it cannot see; what was checked by hand is that it runs clean under
jsdom across five viewport widths with every chapter resolving. Same standing as the WebGL viewers.

## The node guide

A **third** vite entry — `nodes.html` at the root, `src/nodeguide/{main.ts,data.ts,nodeguide.css}`
— and the reference half of a pair whose other half is the field guide. That one is read once,
front to back, and teaches the model; this one is come back to with a node in mind. Same
construction: plain TypeScript, no React, importing nothing from `src/ui` but `theme.css`.

A grid of every listable node grouped by where it sits in a pipeline, a search that dims
everything it does not match, and a detail pane that renders the node's paragraph, its sockets,
its settings and **the card it draws on the canvas**, built the way the editor builds one.

**Nothing on the page names a node.** Tiles, preview cards, socket shapes, settings, defaults,
category counts and the examples cross-reference are all read off the real `NodeDefinition`s. A
node added next month gets a correct entry without anybody opening `src/nodeguide`. The two
strings that are not derived are `description` and the new **`guide`** — two or three sentences,
required, and `nodeGuide.test.ts` fails a node that ships without one or whose `guide` merely
repeats its `description`.

### How a static page reads the registry, and why not the two obvious ways

**Importing `src/nodes` into the page costs 660 kB (211 kB gzipped)**, plus elkjs and the Draco
decoder, on a page whose whole point is that it is 5 kB. Measured, not estimated — the registry
drags in `src/core`, `src/data` and, through the neuroglancer node, a corner of `src/ui`.

**Committing a generated JSON** with a golden test to catch staleness — the idiom
`src/export/__fixtures__` already uses — works, and pays for a file in the repo that has to be
regenerated by hand and reviewed in every diff that touches a node definition.

So `vite/nodeGuideData.ts` loads it **at build time**: `ssrLoadModule('/src/nodeguide/data.ts')`
runs the extraction in Node through Vite's own TypeScript pipeline, and the result is inlined as
`virtual:node-guide-data`. ~250 ms, once per build. Nothing is committed and nothing can drift.

Dev and build take different servers, and that is not an oversight: `configureServer` hands over
the running one, so editing a node definition updates the guide on reload; a production build has
none, so one is created for the length of the call with `configFile: false` — loading this config
from inside itself would recurse. Nothing in `src/nodes` uses the `@` alias, which is checked and
is why `data.ts` imports by relative path. `handleHotUpdate` invalidates the virtual module on any
change under `src/nodes`, `src/core` or `src/examples`, or dev would keep serving whatever the
registry said when the page first loaded — the one failure that would make this worse than a
committed file.

Verify with `pnpm build`: `nodes-*.js` is **198.8 kB (49.2 kB gzipped)**, almost all of it the
inlined registry, so the page's own logic is a few kB of that; `dist/nodes.html` must reference no
`main-*` chunk. (An earlier figure here said ~86 kB; the registry has roughly doubled since, and
the number was re-measured rather than reasoned forward.)

### The static index at the foot of the page

Everything above is drawn *after load*, and what the tiles carry is a **label** — a node's
paragraph enters the DOM only when somebody clicks its tile. So the page's actual substance was in
the shipped file nowhere, which is invisible to every crawler that does not run scripts.
`src/nodeguide/appendix.ts` renders it as static markup, spliced into `nodes.html` at build time in
place of a `<!--@node-appendix-->` marker, through the same SSR server `nodeGuideData` already runs
the registry dump on. It is deliberately **visible** content rather than something hidden for a
crawler, and `SECTIONS`/`CAT_LABEL` moved to `src/nodeguide/sections.ts` so the grid and the index
cannot disagree about which section a node is in. Cost: `dist/nodes.html` 5.4 kB → 87.8 kB raw,
2.1 kB → 22.2 kB gzipped, with `nodes-*.js` unchanged — which is the number to re-check after any
edit here, since importing `appendix.ts` from `main.ts` would land the whole registry in the page.
See [seo.md](seo.md).

### Smaller decisions, each of which was wrong first

- **`virtual.d.ts` types the module `unknown` and `main.ts` asserts.** A top-level `import type`
  makes that file a _module_, at which point `declare module` is read as an augmentation of a
  module that does not exist; an `import type` inside the block, and an inline
  `import('./data').GuideData`, leave the export `any` or trip `consistent-type-imports`. Nothing
  is lost, because `nodeGuide.test.ts` calls `guideData()` directly and checks the shape there.
- **Filtering dims in place and never removes a tile.** The grid is a map of the whole registry,
  so a search that reflowed it would throw away the one thing worth looking at — where in a
  pipeline the answer sits.
- **Example names are not in the search haystack, and that was measured.** One bundled example is
  called `Build an adjacency matrix from two searches`, so including them had a search for `matrix`
  light every node in that graph — the dataset, both Find Neurons, the heatmap — beside the five
  that genuinely carry one. A graph lends its title to every node in it. (The example has been
  renamed since the measurement; it still carries `matrix`, so the finding is untouched.)
- **An enum's default prints its option's _label_.** The app's picker says `downstream (outputs)`
  where the stored value is `outputs`, and a guide naming the other one describes a control that
  is not on screen. Where `options` is a _function_ of the resolved input types (Filter's operator
  list is dtype-aware) there is no answer without a graph, so it says `depends on the input`
  rather than printing whichever option happens to be first.
- **`internal` params are dropped and `advanced` ones are kept.** A nonce or a pager is machinery
  a widget writes — the same exclusion the card's `… N more` counter makes. An advanced param is a
  real setting that happens to live in the inspector, and a guide is exactly where somebody finds
  out it exists. The preview card reproduces that split, so ROI Viewer and Neuroglancer correctly draw
  with no param band at all and a `… 8 more` line.
- **Help text is a disclosure, not a second line.** Printing every `help` inline reads well on
  Filter and turns the Network Viewer's pane into a wall of 33 settings. The dotted underline is
  what stops a row with help looking identical to one without.
- **The page does _not_ pin `data-theme="dark"`, unlike the field guide.** A reference kept open
  beside the editor is the wrong half of the pair to be stubborn about, so it follows
  `prefers-colour-scheme` exactly as the app does.
- **The preview's sockets are clipped, and that is faithful.** An expanded card on the real canvas
  clips its handles into half-discs against `.coda-node`'s `overflow: hidden`; only a _folded_ one
  shows them whole. The legend beside the pane draws whole pips, which is where the shapes are
  learned.

Four entry points, all through `import.meta.env.BASE_URL`: the toolbar's `? ▾` beside Field Guide,
the start page's credits row, the **node browser's footer** — the one surface where somebody is
already choosing a node and may not know what it does — and the README plus a link from the field
guide's outro. `startPage.test.tsx` and `nodeBrowser.test.tsx` cover the three in-app ones; a
third vite entry has no route for anything else to catch going missing.

The page itself has no test, on the tutorial's standing and for the same reason. What _was_ driven,
by playwright against the dev server: both themes at 1440px and a 420px phone stage, no console
errors, no sideways body scroll, the preview card correct for a 33-setting node and for a text
note, the help disclosure opening, and a search dimming 44 of 49 tiles without moving one.

### The inspector shows a table as text, not as a table

`.inspector__viewer` is **320 × 300** — the smallest surface a viewer is drawn on, smaller than a
card. It drew whatever the node's `pageSize` said, which on an annotation table is 100 rows across
60 columns: six thousand cells laid out per change of selection, of which about forty are visible,
behind a sideways scrollbar.

`ValuePreview.summary` replaces that with `TableSummary` — **one line per column, carrying its
name, its type and the first row's value**. The same information turned ninety degrees, and the
whole schema fits where three columns did. It is a *schema readout with an example* rather than a
sample of the data: what somebody selecting a node mid-pipeline wants to know is which columns
arrived and what a value looks like, and reading the table itself is the Table node's job and the
overlay's.

Deliberately **no `<table>`**: no intrinsic-width pass over every cell, no sticky header per
column, no horizontal scroll container — ordinary block layout in a narrow column, which is what a
narrow column is for.

Two intermediate versions are worth recording, because each was a smaller idea than the one that
worked. First a **row cap sized to the box** (25 rows, from 300px at ~19px a row). Then **one
row** — better, because the box was never the constraint, the panel's *job* was. Both were still a
table: the one-row version was reported back as *"the table still reads 1–1 of 58,340"*, which is
the point — a table shrunk is a table, and the panel was never the place for one.

Only the fallback table branch honours `summary`. A node with a viewer of its own — a scatter, a
heatmap, a profile — keeps it, since those already draw something sized to their box.

### The freeze was React's dev instrumentation, not the table

**React 19's dev build serialises changed props into Chrome's performance timeline, and does it
with `JSON.stringify` on primitive arrays with no length cap.** `logComponentRender` fires on every
render whose props differ from the previous one, deep-diffs old against new
(`addObjectDiffToProperties`), and for each changed key calls `addValueToProperties` **twice** —
once for the removed value and once for the added one. A Coda `TableValue` is an object of one
array per column, so handing one to a component costs a full JSON serialisation of the whole
table, twice, whenever its identity changes.

Measured on a real annotation base — 58,340 rows over 60 columns — that is **five seconds of CPU
and 1.5 GB of transient allocation** per selection, reclaimed over the following fifteen seconds.
It reads as the tab freezing. `addValueToProperties` (72.5%) and `logComponentRender` (21.8%) were
94% of a heap profile of it.

Three things about it are worth keeping, because each one sent the search somewhere else first:

- **It fires only where props *changed* on a component that stayed mounted.** Alternating between
  two nodes holding big tables triggers it; alternating between a Text note and a table node does
  not, because the result section unmounts and there is no previous props object to diff against.
  That asymmetry looks like a fact about tables and is a fact about React's reconciler.
- **Shrinking what was *drawn* could never have helped**, which is why capping the inspector to 25
  rows, then to one row, then replacing the table with `TableSummary` all changed nothing: the
  cost is in *passing* the table as a prop, and `<TableSummary table={table} />` passes exactly the
  same object. Three fixes aimed at rendering, and rendering was never it.
- **jsdom has no `console.timeStamp`**, so `supportsUserTiming` is false and none of this
  machinery runs under vitest. Four rounds of harness — settled heap, peak heap, realistic
  distinct strings, whole-app render — measured 4 ms and a flat heap while a browser was spending
  five seconds and a gigabyte. A headless measurement that cannot reach the code path is not a
  negative result.

`reactTracksOff()` in `vite.config.ts` switches it off by making that gate false, injected
`head-prepend` so it runs before `react-dom` initialises. **Dev server only** — the production
build of `react-dom` contains none of this machinery, so the deployed app never had the problem.
What it costs is React's own track in a performance recording; `localStorage['coda.reactTracks']
= '1'` and a reload gets it back.

The deeper reading is that **megabyte-scale values as React props are a hazard in this app**, not
because React re-renders on them but because its dev tooling reads them. Nothing here does that
today beyond the viewers, which need the data they draw; a component that wants only a *fact*
about a table should take the fact.
