# The canvas

React Flow, layout, and every gesture that edits the graph by pointer.

Framing, fitting and the lock are below; the rest is split by topic:

## [canvas-layout.md](canvas-layout.md) — automatic layout, align and distribute

- [Automatic layout](canvas-layout.md#automatic-layout)
  - [A companion is placed with its host, not after it](canvas-layout.md#a-companion-is-placed-with-its-host-not-after-it)
  - [A chain caption is carried the same way, and it is the one note that moves](canvas-layout.md#a-chain-caption-is-carried-the-same-way-and-it-is-the-one-note-that-moves)
  - [A reference edge is not a layering constraint](canvas-layout.md#a-reference-edge-is-not-a-layering-constraint)
  - [Packing columns into the shape of the canvas](canvas-layout.md#packing-columns-into-the-shape-of-the-canvas)
  - [Edge routing — wires that go around the cards](canvas-layout.md#edge-routing--wires-that-go-around-the-cards)
- [Align & distribute](canvas-layout.md#align--distribute)

## [canvas-editing.md](canvas-editing.md) — hints, groups, folding, copy and paste

- [Hints on a card](canvas-editing.md#hints-on-a-card)
- [Groups](canvas-editing.md#groups)
- [Folding a group](canvas-editing.md#folding-a-group)
  - [The controls a folded group carries](canvas-editing.md#the-controls-a-folded-group-carries)
  - [What a folded frame says about the run inside it](canvas-editing.md#what-a-folded-frame-says-about-the-run-inside-it)
  - [Looking inside without unfolding](canvas-editing.md#looking-inside-without-unfolding)
  - [The rest](canvas-editing.md#the-rest)
- [Copy, cut and paste](canvas-editing.md#copy-cut-and-paste)

## [canvas-interaction.md](canvas-interaction.md) — measurements, sockets, the + menu, glyphs

- [Canvas interaction](canvas-interaction.md#canvas-interaction)
  - [Measurements, and who keeps them](canvas-interaction.md#measurements-and-who-keeps-them)
  - [The static pages carry the vocabulary too, and their figures are hand-drawn](canvas-interaction.md#the-static-pages-carry-the-vocabulary-too-and-their-figures-are-hand-drawn)
  - [Six socket families, and the gate that says there may be three](canvas-interaction.md#six-socket-families-and-the-gate-that-says-there-may-be-three)
  - [Geometries: a seventh row on the socket table that cost no seventh hue](canvas-interaction.md#geometries-a-seventh-row-on-the-socket-table-that-cost-no-seventh-hue)
  - [A socket's hue is written down twice](canvas-interaction.md#a-sockets-hue-is-written-down-twice)
  - [The in-flight wire is its origin's colour](canvas-interaction.md#the-in-flight-wire-is-its-origins-colour)
  - [Letting a socket out](canvas-interaction.md#letting-a-socket-out)
  - [The header is the category colour, not a tint of it](canvas-interaction.md#the-header-is-the-category-colour-not-a-tint-of-it)
  - [Hitting a socket](canvas-interaction.md#hitting-a-socket)
  - [The **+** menu](canvas-interaction.md#the--menu)
  - [The glyph table](canvas-interaction.md#the-glyph-table)

## [canvas-wiring.md](canvas-wiring.md) — dropping and re-routing wires, previewing a port

- [Dropping a wire on empty canvas](canvas-wiring.md#dropping-a-wire-on-empty-canvas)
- [Dropping a node onto a wire](canvas-wiring.md#dropping-a-node-onto-a-wire)
- [Breaking and re-routing links](canvas-wiring.md#breaking-and-re-routing-links)
- [Previewing an output port](canvas-wiring.md#previewing-an-output-port)


## Framing a graph that was just opened

`loadGraph` bumps `fitRequest`; the canvas catches it and calls `fitView`. Everything that opens
a graph — the toolbar's Open and New, the start page, the palette — routes through `loadGraph`,
so one signal covers all of them. It crosses as a counter with a mount-seeded guard because the
viewport belongs to React Flow and every trigger sits outside its provider, same idiom as
`paletteRequest` and `browserRequest`.

**The fit is asked for unconditionally, and waiting for the cards to be measured is React Flow's
job rather than ours.** `fitView()` does not fit: it sets `fitViewQueued`, pushes a no-op onto the
node queue, and returns a promise. The fit resolves either at the next `setNodes` where every node
has a measurement or, failing that, inside `updateNodeInternals` when the ResizeObserver delivers
one. So a graph committed this render — whose cards have no size yet — is framed a beat later
against real measurements. That is worth knowing before writing a gate for it, because the
obvious gate is what broke it.

**It was gated on `useNodesInitialized`, and that flag read false here forever.**
`adoptUserNodes` carries a measurement forward only while the **user** node object behind it is
identity-equal and otherwise re-seeds `measured` from `userNode.measured`; `rfNodes` mints fresh
objects on every store change, and nothing put a measurement back on them, so that field was
permanently undefined. `updateNodeInternals` never recomputes the flag, so nothing brought it
back. `measuredSizes` (see *Measurements, and who keeps them*) changes the premise — the flag
would recover now — but the gate stays gone, because the consumer already waits. See the
auto-layout section, which met the same flag from the other side.

**What that cost is the useful half, because it read as intermittent rather than broken.** The
**first** open of a session framed correctly and every one after it did not — and that first fit is
React Flow's own `fitView` prop, queued at mount and resolved once the opened graph's cards were
measured, with nothing to do with this effect at all. Measured in a browser, opening a second graph
left the viewport transform byte-identical and put the new graph's top row at y = −109 against a
pane starting at y = 42. A control that works once per session is the hardest kind to report.

**A graph with no nodes raises no request at all.** A request nothing can satisfy would sit
pending and be spent on whatever the user added next — a viewport that lurches minutes later,
nowhere near its cause. That is why `newGraph` does not ask and `loadGraph` checks first.

jsdom does no layout, so the framing itself is not asserted anywhere and was checked in a browser:
five consecutive opens — a dataset starter, three examples and a re-open of the same graph — each
landing wholly inside the pane at its own zoom, with no console errors. `store/fitOnLoad.test.ts`
covers which loads ask; `ui/fitOnLoad.test.tsx` covers that the request is spent, by pinning
`useNodesInitialized` to the `false` it really returns and asserting `fitView` is called anyway.

## Fitting the selection

`ui/fitView.ts` holds `FIT_VIEW_OPTIONS` — the framing React Flow's initial fit, a load's fit and
Fit Selected all share — and `useFitSelected`, which the three surfaces that offer it all call:
the rail button (`ui/panels/ViewControls.tsx`), the `§` key, and the `View ▸ Fit Selected`
palette command.

**One key, two fits.** `§` frames the selection when there is one and the whole graph when there
is not — "show me what I mean" is the same intent at both scales, and a shortcut that is inert
exactly when nothing is selected is one people stop reaching for. The rail keeps them as two
buttons, where each can say which it is; the palette moves the `§` badge between its two rows so
what it advertises is what the key would do right now.

**An unmeasurable selection is checked for before the call rather than left to React Flow.**
`fitView({ nodes })` intersects the ids with the nodes it has measured; finding none, it fits a
zero-sized box — bounds degrade to `{0, 0, 0, 0}`, the zoom clamps to `maxZoom` and the camera
lands on the flow origin, with the graph nowhere on screen. So an empty set does nothing at all,
the button is disabled with nothing selected, and the key press is a no-op. A selected card is a
rendered card, so this is the pathological case (a stale id, a hidden node), not the daily one.

The key is matched by **position** as well as by what it prints — `event.code === 'Backquote'`
alongside `event.key === '§'` — because the physical key at the top left prints `§` on an ISO Mac
layout, `` ` `` on a US one and `^` on a German one. Nothing else in the app wants it, and every
bare letter near the canvas is either taken (`f`, `i`, `m`, `h`) or one shift away from something
else.

The button is disabled rather than hidden, so the rail does not change height under the pointer.
Its icon takes `.rail-icon`, which is `.layout-icon`'s fill reset under a name that does not claim
to be about layout; React Flow's own disabled styling is `fill-opacity`, which does nothing to a
stroked line drawing, so `editor.css` dims the whole button instead. `ui/panels/fitSelected.test.tsx`
pins which ids each surface asks for, and that the empty case asks for nothing.

## The lock

One toggle in the rail (`ui/panels/LockControl.tsx`) freezes three things: the **viewport**, the
cards' **geometry** and the graph's **structure**. What it deliberately leaves alone is everything
that is not the canvas — selecting a card, editing its params, muting, collapsing, expanding a
result, running, exporting, and opening another graph. `GraphState.locked` carries the full list.

**Session-only, and not in the document.** Not in the `.coda.json`, not in a share link, not in
`localStorage`: a graph somebody sends you never arrives frozen, and a lock left on by yesterday
is not something to rediscover by finding the canvas dead. Every reload starts unlocked.

It is enforced in three places, and all three are needed:

- **React Flow's props**, for the gestures the library owns outright and no handler of ours would
  see — `panOnDrag`, `zoomOnScroll`, `zoomOnPinch`, `nodesDraggable`, `nodesConnectable`,
  `edgesReconnectable`, `deleteKeyCode`. Box-select is *not* among them: selecting changes
  nothing, and the inspector, the help overlay and every viewer are reached through it.
- **The store**, as a silent backstop on every action that moves or restructures anything —
  including `undo`/`redo`, since with add and delete refused a live ⌘Z would be the one way left
  to restructure a frozen graph. `applyAssistantPlan` is the one guard that answers back, because
  a model cannot see the rail and the panel needs something to show.
- **Every surface**, visibly. This is the half that decides whether the feature reads as a lock or
  as an editor that has started ignoring clicks: each rail button, toolbar button, context-menu
  item and palette row it covers is disabled and says "the canvas is locked" in its tooltip or
  hint, and the keyboard and the two pane gestures raise a notice instead of doing nothing. The
  assistant's composer stands down too — the store refuses a plan, but finding out *there* costs
  a model round trip for an answer the panel already had. The wording lives in `ui/lockCopy.ts`:
  written out per site it drifted into three phrasings inside one change, and that sentence is
  the entire user-visible explanation of the feature.

Two consequences worth knowing before changing it. **A resize needs its own answer**: `NodeResizer`
runs its own pointer gesture and never consults `nodesDraggable`, so the handles are removed
(`CodaNodeView`'s `resizable`, `NoteCard`'s `isVisible`) rather than left to be refused after the
card has already been drawn stretched. And **a load still fits**: opening a graph reframes the
viewport even while locked, because the alternative — a freshly opened graph parked off-screen
with every way of bringing it into view disabled — is the worse failure. The lock survives the
open; it is about how you are working, not about the document.

The rail's zoom and fit buttons are **ours** for this reason: React Flow disables its own at the
zoom limits and nowhere else, so a locked canvas would still have three live buttons that move the
viewport. See `ui/panels/ViewControls.tsx`.

The store's guards are **fail-open** — one `if (frozen()) return` per action, with nothing to
remind the author of the next structural action that the lock exists. What makes that safe is a
partition test: `store/lock.test.ts` classifies every action on `GraphState` as canvas-editing or
not, and a new one that is neither fails the suite until somebody decides which it is.

`store/lock.test.ts` pins what the store refuses and what it deliberately still does;
`ui/panels/lock.test.tsx` pins that every surface says so. **The gestures at the props are not
covered anywhere**, and cannot be: jsdom dispatches no real pointer sequences and has no wheel or
pinch. Wheel, trackpad pinch, pane drag, card drag, resize handle, socket drag and wire rewire
each need checking by hand in a browser — inert with the lock on, working again after unlocking —
and that check has not been run against this implementation yet.
