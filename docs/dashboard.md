# The dashboard

The same graph, seen as a grid instead of a canvas. Build the pipeline on the canvas as usual,
then assemble a wall of only the nodes worth looking at — no wires, no viewport, no cards.

Status: **prototype.** What is here works and is tested; the two questions it opened are settled
at the bottom, along with the smaller things not built.

---

## A cell is a reference, not a copy

The one decision everything else follows from. A cell holds a **node id** and nothing else:

```jsonc
"dashboard": {
  "columns": 3,
  "open": true,          // saved from the grid, so it opens back into the grid
  "cells": [
    { "nodeId": "view", "w": 2, "h": 2 },
    { "nodeId": "group" }
  ]
}
```

The graph stays the one source of truth. A cell shows whatever that node currently holds, a run
updates it, a param edit on the canvas is visible here on the next tick, and nothing in the model
can make the two views disagree about what a node *is*. What the dashboard owns is an editorial
decision — which nodes are worth looking at, and where they sit.

The model is `src/core/dashboard.ts`; the shape and the pruning live in `graph.ts` beside
`GraphGroup`'s, the same split `groups.ts` follows.

**At most one cell per node, and only nodes that can be drawn.** A cell is a *mount site*, and a
viewer is a renderer rather than a picture — the measurement `showPreview` already stands cards
down for is 3 contexts and 3 × 170 kB for one 21-neuron scene. Two cells of one neuroglancer node
is two applications fetching EM. An annotation gets none: a text note is never evaluated and has
no body registered for the full-size surfaces, so a cell for one draws a header over an empty box.

Both rules are enforced in `addCells` **and** in `validDashboard`, because a hand-edited file is
the other way each of them arrives and what they cause reads as a broken cell rather than a bad
file. The eligibility half started as a filter in each surface that offers the gesture, which was
three spellings of one rule with two live holes — the "add the selection" gestures both passed the
whole selection having checked only the *clicked* node, so a note caught by a rubber band got a
cell. `canHaveCell` is now the one answer, and `placeableIds` / `unplacedNodes` are what the
surfaces read so a row cannot count a node the model will refuse.

**Order is position.** There is no `x`/`y`: cells flow across `columns` tracks in list order, so a
reorder is a splice and CSS decides the geometry. Explicit coordinates would be a second thing to
keep valid when `columns` changes, and a hole nobody can see is how a layout starts lying about
itself. The cost is real and stated: flow is **not** `dense`, so a cell too wide for the room left
on a row moves to the next one and leaves a gap. Dense packing would silently reorder the list
somebody had just dragged into place.

**A span is clamped, never refused**, and a span of 1 is stored as *absence*. Both for `groups`'
reason: a graph nobody has put a node on — or has put nodes on but never resized — must round
trip byte-identically, or every file in the Zoo changes bytes on its next save for a feature it
does not use.

## The mode replaces the canvas

`App.tsx` renders `DashboardView` **or** `Editor` into the same grid area. React Flow unmounts,
and every card's live preview goes with it.

That is a memory decision before it is a layout one. A grid of live viewers *beside* a canvas of
live previews is two WebGL contexts and two copies of the geometry per node. Swapping the surfaces
trades contexts instead of adding them — which is why a cell needs no stand-down rule of its own
beyond the one it shares with a card: **not while the overlay owns this node.** A cell's `⤢` hands
the node to `ViewerOverlay` and the cell draws "Open in the full-size viewer" in the meantime.
Named rather than blank: an empty box among boxes reads as the cell having broken.

**The dock does not render while the grid is up**, and the pin is dropped on the way in. The dock
is its own grid column, so it would otherwise survive the view swap — and it is the one surface
that could hold a node live at the same time as a cell. Dropping the pin alone was not enough:
pinning *after* the grid opened put the node back in both, which is exactly the two contexts the
store refuses for the overlay. Not rendering it makes that structural rather than a third
hand-written copy of the rule inside the cell. The command palette's pin row is disabled with a
reason for the same reason: there is no canvas for a dock to sit beside.

**The layout is in the document, and so is which view it was saved from.** This is where the
feature departs from the dock, which deliberately does not store *which* node is pinned because a
node id means nothing in the next graph. That argument inverts for the layout: a dashboard is a
set of ids that only mean something in *this* graph, which is exactly why it belongs to it — and a
dashboard is the thing worth sending somebody, so it travels with the file, the share link and the
Zoo entry.

`DashboardLayout.open` carries the rest of it: **a graph saved while the grid was the view opens
back into the grid.** That is what makes a shared dashboard a dashboard rather than a canvas the
recipient has to be told to press `D` on. `graphStore.dashboardOpen` is the truth while running
and every setter writes the flag through; `loadGraph` reads it back, and it is the one entry on
that reset list that is *read* from the document rather than cleared by it.

It is deliberately a different promise from the lock's, which does not travel — see
`GraphState.locked`, "a graph somebody sends you never arrives frozen". A lock takes editing away
and says so only in a padlock; a dashboard takes nothing away. The graph is intact behind it, the
bar carries `← Canvas`, and `D` is one keypress. What a lock would inherit is a disability; what
this inherits is the author's answer to which of the two views the workflow is *for*.

Three rules keep it from being noticed by anybody who does not use it:

- **Written only when true.** Going back to the canvas removes the key rather than storing
  `false`, so a graph seen once as a grid and closed again round trips as it always did —
  `GraphGroup.filled`'s idiom.
- **A mode toggle cannot mint a layout.** `setViewOpen` answers by identity on a graph with no
  dashboard, so pressing `D` on an empty canvas writes nothing at all.
- **Not an undo step.** The write is `history: false`. Looking at the other view changes the
  document under this rule, but a ⌘Z that only put you back on the canvas would sit between
  somebody and the edit they actually meant to undo.

The layout mutators compose `setViewOpen` *around* their own change rather than calling it after,
so a graph gains its first cell and its view flag in one commit — adding the first cell is the
moment a layout comes into existence, and two commits would leave a state, briefly but reachable
by an autosave tick, where the dashboard exists and does not know it is being looked at.

## It is live under the lock

"Lock workspace" got to a dashboard by freezing the canvas. The grid is the same want with the
canvas removed, which is why every dashboard action is on the **live** side of
`lock.test.ts`'s partition — the one place that list holds something that writes to the document.

Refusing them would be backwards: a locked canvas is exactly the state somebody is in while
assembling a dashboard. The lock is about canvas geometry and graph structure, and a dashboard is
neither.

## What a cell draws

`ViewerSurface` under `variant="cell"` — the same component the overlay and the dock use. A cell
knows nothing about tables, networks or neuroglancer, which is what makes "any node off the graph"
possible rather than "any viewer": a Connectivity node's cell is a table, an Explore node's cell is
its browser, a Network Viewer's cell is the network with its legend and its export.

`controls` is the **one** thing a frame is allowed to say about the inside, and it names the
property rather than the caller: `auto` for whatever the node declares, `rail` / `hidden` for the
flat rail with the frame owning the disclosure. A cell may be a sixth of a window, where the 268px
styling sidebar is the panel and nothing else — so a cell keeps the flat rail for every node,
*including* the ones declaring `paramGroups` that would get the tabbed sidebar in the overlay. The
rail is one component either way, so a grouped node's presentational params are the same controls
in both places rather than a second spelling of them. It scrolls sideways rather than wrapping: a
third row of controls is a third of the view gone, and the cell is exactly the surface where the
view is the point. The Network Viewer's 22 presentational params are the case that tests this, and
`⤢` is the escape hatch when the rail is not enough.

The disclosure state is per cell, not `panels.style`. One flag for one surface is right for the
overlay; a grid sharing it would open every rail at once. Naming the property rather than the
caller is what lets a dock dragged to its 360px floor ask for the same treatment without a
`variant: 'dock-narrow'` being invented for it.

**Density is not on that list.** How tight a cell's header and rail are is CSS's, selected off
`.dash-cell__panel` — a frame wears `.viewer-surface` *and* a class of its own, which is exactly
the mechanism `editor.css` records for letting a frame restyle the inside without the shared
component knowing a caller by name.

**The interaction contract is look, restyle, run — never restructure.** `⚙` shows the rail, `▸`
runs this node, `⤢` opens it full size, `✕` takes the cell off the dashboard. Nothing here rewires,
deletes or moves a card. `✕` removes the *cell*, not the node, and the title says so — the two are
one keystroke apart on every other surface in the app, and confusing them here costs somebody a
subtree.

Presentational params only, so restyling from a cell re-renders instantly and stales nothing
(invariant 4). That is what makes the grid usable as an inspection surface rather than a thing you
are afraid to touch.

## A run that happens underneath the grid

The dashboard is the surface that made a mount-time read visible, and the bug is worth the space
because the mechanism is general and the symptom points nowhere near it.

A viewer draws from one of two places. Most draw their **own output** — a Table, a Heatmap, a
Network — which `ViewerSurface` selects through `runVersion` like every other scheduler-backed
read. A handful draw from their **inputs** instead, because their own `out` port is a pass-through
and keying the card on it would show the same table twice: Explore Dataset, Neuron Profile, Neuron
Topology, the 3D scene, the Neuroglancer cell, Graph Metrics, the dendrogram's annotations port.
Those read `nodeInputs(id)`.

That read was memoised on `[found, previewVersion]` — the graph object, and the streaming-preview
tick — which are the two things a *run* does not move. A run changes no node's position or params,
so `s.graph` is the same object; a table raises no preview. So the values were whatever the
component read on its first render, for the life of the mount.

Three surfaces share `ViewerSurface` and only one of them could show it:

- the **card** on the canvas is `CodaNodeView`, which reads `nodeInputs(id)` unmemoised during
  render and so has always been correct;
- the **overlay** and the **dock** are opened by hand, which in practice is after the run;
- a **cell** is on screen before the run, and `DashboardLayout.open` means a share link puts the
  whole grid up before the recipient has pressed anything.

So: open a shared workflow that saved itself from the grid, press Run, and the Explore cell says
*Connect a Dataset to browse its neurons* and the Topology cell *Connect a table of neurons to
measure them* — beside their own headers reporting `401 rows × 7 col · 37ms`. Leaving the mode and
coming back fixed it, which is the tell: it remounts the cells.

**The fix is not a better dep, and it is not a memo either.** Adding `runVersion` fixes this case
and buys back the same class of bug — a fourth tick nobody has thought of yet. So the read simply
happens every render, which is what `CodaNodeView` and `Inspector` have always done with the same
call.

Nothing replaced the memo, because there was nothing for it to save. It was written on the
reasoning that a fresh record per render re-reconciles the viewer inside every cell — but no
consumer of that prop is identity-sensitive: `ValuePreview` and every node body is a plain function
rather than `memo`, and the record appears in no dependency array anywhere in `src/ui`. What the
viewers key on is the individual `Value` inside it, and those are stable either way — a `Value` is
produced by an `evaluate` and replaced wholesale, never mutated, so the provenance cache hands back
the same object for a re-run that genuinely produced the same table. That is the contract
`networkRebuild.test.tsx` already states and tests, for the one viewer that *does* memoise on its
input: *"`nodeInputs` mints a fresh record on every store tick, and only the value inside it is
stable."*

The walk it costs is one `find` over the nodes plus one over the edges per input port, and viewer
nodes have a median of one input port (mean 1.53, max 4). Measured: 0.24 µs on a seven-node graph,
1.29 µs at sixty, 2.85 µs at two hundred — against a re-render three to four orders of magnitude
dearer. A twelve-cell dashboard on a sixty-node graph during a mesh stream (4 publishes a second)
spends about 66 µs per second on it.

One thing not to *undo* while here: `previewVersion` is subscribed ungated, where `CodaNodeView`
gates it on `isViewer`. Porting that gate would be wrong. `canHaveCell` refuses only annotations, so
a **non-viewer** node can hold a cell, and this component draws such a node as a full-size
`ValuePreview` of its own output — which for the nodes that publish previews, Skeletons and Meshes,
is the streaming value itself. `onPreview` bumps `previewVersion` alone and never `runVersion`, so
the gate would freeze exactly that cell mid-stream. On the canvas it is safe because a non-viewer
card shows a one-line summary.

**What this does not reach**, and it is a bound worth knowing rather than a loose end here: a
viewer only refreshes on a render something else schedules, and `runNode` on an *upstream* card
schedules none. `resolveScope` (`core/scheduler.ts`) takes the target plus its **ancestors** —
descendants are excluded — so a downstream viewer is not re-run, its `NodeRunInfo` and its own
output are untouched by identity, and every run-coupled selector in `ViewerSurface` returns what it
returned before. The full-graph Run in the test works because the viewer node is itself in scope.
This is not a property of the memo that was removed and not one of the read that replaced it: the
canvas card has it identically, since `CodaNodeView` also renders on its *own* node's state. It is
the scheduler's scope rule meeting a card that draws somebody else's value, and moving it belongs
with `resolveScope`, not here.

The regression test is in `dashboard.test.tsx`, and its shape is the point — every other test in
that file runs first and enters the grid second, which is the one order that cannot see this. It
loads a wizard graph with `dashboard: true`, renders, and runs *underneath* the mounted grid.

## The two gestures

Both are in `DashboardCellView`; the arithmetic is in `gridGeometry.ts`, headless, on
`networkDrag.ts`'s rule — jsdom performs no layout, so anything that consults a rect is untestable
where it is written, and in a real browser a half-track error is indistinguishable from a slip of
the hand.

**Reorder** is HTML5 drag and drop from a grip in the header. The grip is *in* the header rather
than floated over the cell, because the header is the one part reliably not an `<iframe>` or a
WebGL canvas. The drop **target** is a layer that exists only mid-drag and sits above everything:
an `iframe` eats every drag event that lands on it, so a cell whose body is a neuroglancer embed
would otherwise be the one cell nothing can be dropped onto — silently, and only for that node.
Mounted always, that layer would instead be a transparent sheet over every viewer in the grid: no
rotating a 3D scene, no sorting a table, and the blame would land on the viewer.

`dropIndex` does two conversions and each is a bug on its own. `moveCell` counts the target in the
list **after** the dragged cell is lifted out — counting before makes a one-place move a no-op.
And a pointer past the target's midpoint means *after* it — without that, the end of the list is
unreachable. A drop on the dragged cell resolves to where it already is, so `moveCell` returns the
graph unchanged by identity and no undo step is recorded.

**Resize** is a corner grip with pointer capture, the idiom `ViewerDock`'s width grip and
`GroupLayer` already use. `spanFromDrag` measures the unit from the cell's **own** starting rect
rather than from the grid's track list — every column is `1fr` and every row the same height, so
one cell of a known span measures the unit exactly, and nothing has to stay agreeing with the
stylesheet. The `+ gap` before rounding is the part worth knowing: a cell of *n* tracks is *n*
units plus *n − 1* gaps, so what repeats every `unit + gap` pixels is the cell **plus one trailing
gap**. Without it every span's halfway point sits a gap too far right and the grip reads as sticky.

Unlike the dock's grip, this **commits on every sample that changes a span** rather than on
release. The dock paints a CSS custom property because a store write there re-renders the surface
whose whole point is to stay untouched, sixty times a second; here the value is discrete — a whole
track — so a drag produces two or three writes, `commit` drops the ones that change nothing by
identity, and a tag folds what is left into one undo step. The gaps are read off the grid's
computed style, so the stylesheet stays the one place they are declared.

## Four heights, and a row measured rather than guessed

A cell is **a third, a half, two thirds or the whole** of the visible area. `ROW_SPANS` is the
list, the grid is divided into `ROW_TRACKS = 6` so those fractions can be expressed, and a resize
drag snaps to the nearest. Six is arithmetic, not a control — nobody chooses a track.

The row height is not `1fr` and not `vh`, and both exclusions were paid for.

**Not `1fr`:** with `1fr` rows the grid always fits the window, so making a cell taller *shortens
every row* and the cell ends the drag exactly the size it started. A resize handle that visibly
does nothing.

**Not `vh`:** the first version made a row `44vh`, and `vh` is the *window* rather than what is
left after the toolbar, this view's own bar, the status bar and the grid's padding — four numbers
no CSS length can see. So the tracks always came to a little more than their box: every dashboard
had a vertical scrollbar it had not earned, and the bottom row's resize corner sat behind the
status bar. It also meant only two rows ever fit, so the four heights were really two.

So `DashboardView` observes the grid's content box and publishes `--dash-row`; `rowHeight` divides
it so `n` tracks and `n − 1` gaps come to exactly the area. Measured on a 1600 × 1000 window: a
783px content box, a 122.1px track, the grid's bottom edge landing on the status bar's top edge to
the pixel, zero overshoot, every cell's resize grip reachable without scrolling. The four stops
come out at 32%, 49%, 66% and 100% of the area — a third is a little under a third because a cell
of two tracks spans one gap and not two, which is also why the test asserts that the stops **tile**
rather than that each is its nominal fraction.

The observer writes straight to the element rather than into state, `ViewerDock`'s drag-paint rule:
it fires on every window resize, and a `setState` per frame would re-render every cell in the grid
— including the WebGL ones, whose whole cost is the re-render. Nothing in React reads the number.

**Absence means a different number on each axis**, which is the one asymmetry in the model. A
width of 1 is a natural unit — one of however many columns you asked for. A row track is not,
because rows are a subdivision of the screen rather than something chosen, so `h` is absent when it
is `DEFAULT_ROW_SPAN` (half). Both axes still store only their default's absence, so a dashboard
nobody has resized round trips byte-identically.

Columns are `minmax(0, 1fr)` for the reason `.app` uses it for the canvas column: a table or a
scene reports a large intrinsic width, and a bare `1fr` lets it push its track wider than its share
instead of scrolling inside it.

## Getting in and out

Four ways in, one table describing the key:

| Surface | What it offers |
| --- | --- |
| Toolbar `▦` | Toggles the mode; `aria-pressed` says which way the click goes |
| `D` | Unqualified, like `f` and `i` — it is about the view, and `⌘D` is Duplicate |
| Node context menu | Add/Remove for the selection, live under the lock |
| Command palette | The mode toggle and the add/remove, as separate rows |
| The grid's own bar | `+ Add node`, the column slider, `← Canvas` |

`+ Add node` inside the grid is not redundant with the context menu. Without it the only route in
is a right-click on a card, so building a dashboard means leaving it — and the thing being judged
is how the grid looks with one more cell on it.

**The bindings split by what a key is about, not by which component is mounted.** `Editor.tsx`
owns every shortcut that needs the canvas, a selection or React Flow's own key handling; `f`, `i`,
`/` and `d` moved to `useAppShortcuts`, which `App` mounts.

That was forced by this feature and is the better arrangement anyway. `Editor` is not mounted while
the grid is up, so a key bound there is a key that silently stops working in half the app: `F` did
nothing on the dashboard, and so did `I` and `/`, which nobody had tried. `D` had been written
twice to work around it — one binding in two components, exactly the duplication `shortcuts.ts`
exists to prevent — and is one binding again. `TOUR_DECLINES` is shared between the two listeners
for the same reason, with `d` added to it: it does not move the spotlit card, it unmounts the whole
canvas the tour is pointing at.

**Escape is deliberately not bound.** It belongs to whatever is on top — an expanded viewer, a help
document, the add menu — and a mode that closed itself out from under one of those would be the
same failure `ViewerOverlay`'s capture-phase listener had to stand aside for.

## What was measured

Driven in real Chrome over CDP against the `partners` and `network` examples, because jsdom
performs no layout and has no WebGL:

- A 3-column grid with a 2 × 2 cell: `1050 × 813` against `520 × 402` singles, the fourth cell
  wrapping to the next row, no horizontal scroll on the page.
- The resize grip: `h` 1 → 2 took the cell 402 → 813px and stored `{ nodeId, h: 2 }`. Dragging
  narrower at `w: 1` correctly does nothing.
- The reorder: `[view, group, conn]` → `[conn, view, group]` dropping before the first cell; a
  drop that resolves to a cell's current place changes nothing and records no undo step; the drop
  layers exist during the drag (3) and not at rest (0).
- A Network Viewer in a cell draws the whole viewer — nodes, edges, legend, size and width keys,
  the `colours repeat` caption, Find, Download. WebGL needs `--use-angle=swiftshader` in headless
  Chrome; with `--disable-gpu` there is no context at all and the canvas mounts empty, which is not
  a finding about this feature.
- `⤢` from a cell: the cell drops to the standby line and its `<table>` goes; Escape brings it
  back. The overlay keeps its tabbed Style sidebar while the cell gets the flat rail.
- The grid fits its box exactly: `scrollHeight === clientHeight`, the page does not scroll, the
  grid's bottom edge and the status bar's top edge are both at y=885, and every cell's resize grip
  is above it — including the bottom row's, which used to be behind the status bar.
- All four heights are reachable in one continuous drag of the corner grip: 254px (32%), 386px
  (49%), 518px (66%), 783px (100%) on a 783px content box.
- `F`, `I` and `/` work on the dashboard as well as the canvas, and `F` toggles *both* ways in
  both (checked against `document.fullscreenElement`; headless Chrome has no window manager, so
  the call was also asserted directly).
- The eligibility rule end to end, on a graph carrying three text notes: the add menu offers only
  the three real nodes, and "add the selection" with everything selected produces no note cell.
- The saved view, over real page reloads: a layout with no flag opens on the canvas; the toolbar
  toggle writes `"open": true`; a reload lands in the grid; `← Canvas` removes the key rather than
  storing `false`; a reload lands on the canvas. With every cell removed, the toggle leaves no
  `dashboard` key at all.

## Where it is documented

Three surfaces, and each says a different thing about it:

- **The overview page** — a *Build your own dashboard* section after the editor thesis, with a
  figure of the composition the guide below ends on. See [pages.md](pages.md).
- **The Basics tour** — one stop on the toolbar's `▦`, between the inspector and Connections,
  because all three are about which surface you are looking through rather than about the graph.
  The button carries `data-tour="dashboard"`, and `tour.test.tsx` asserts it resolves.
- **"Build a Dashboard"** — a third guided tour (`ui/tour/dashboard.ts`). It builds three nodes,
  wires a table and a Neuroglancer scene off one Explore's `Selected` port, and arranges them
  two-up with the scene at full height.

That third one takes a decision "Learn to Build" argues against at length: it runs on **MaleCNS
over neuPrint**, which needs a token, where the build tour deliberately uses synthetic data so a
newcomer never hits a credentials wall. The reason is Neuroglancer — it is the one viewer with
nothing to draw from a mock source, and a tour about what a dashboard *looks like* cannot spend a
third of its grid on a blank rectangle.

The wall is answered rather than ignored, and the shape of that answer is worth keeping: a
neuPrint dataset node **peeks at the deployment the moment it is created**, so step 3 draws a 401
whatever the tour does, and the app answers a 401 by opening Connections over everything. So
`prepare` checks for a token and, when there is none, the first step's body *predicts the panel*
rather than merely mentioning where the token goes — seen in a browser, where the earlier copy left
the panel arriving unannounced and reading as the tour having broken. What the tour can avoid is
causing a **second** one, which is what `runIfPossible` is for.

`builder.ts` was extracted for this: the scaffolding "Learn to Build" owned privately — ensure,
wire, slot, reveal, span, params — is now a factory, so a second builder is a second call rather
than a second copy, and the module state that was a documented singleton is scoped to the tour
that owns it.

## Two decisions, since asked

**A graph saved from the dashboard opens into it.** Settled, and built — `DashboardLayout.open`
above. The rule is the author's act rather than a preference: *saved while looking at the grid*
is the condition, so nothing has to be configured and a graph that has never been looked at as a
dashboard is exactly the graph where the flag is absent.

**Text notes get no cell, and that is fine.** `note.text` is never evaluated and has no body
registered for the full-size surfaces, so a cell for one would draw a header over an empty box.
`DashboardView`'s candidate list excludes annotations. If a caption is wanted later, the change is
teaching `nodeBodies` about `NoteCard` — the canvas's side of the house, not this one.

Smaller things not built: no per-cell title override (the node's title is the cell's), no way to
drop a cell onto the *end* of the grid except via the last cell's right half, and the reorder is
mouse-only — the grip is focusable but arrow keys do not move a cell yet.
