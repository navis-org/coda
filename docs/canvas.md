# The canvas

React Flow, layout, and every gesture that edits the graph by pointer.

Moved verbatim out of `CLAUDE.md`.


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

## Automatic layout

Four buttons in the canvas controls rail, after Zoom In / Zoom Out / Fit View / Fit Selected
(`ui/panels/LayoutControls.tsx`): **arrange**, **auto-layout**, and an **options** bubble.
ELK Layered via `elkjs`. The headless half is `src/layout/`; only the buttons and the pass
driver (`ui/useArrange.ts`) are React.

**`src/layout` is a top-level sibling of `core`/`data`/`nodes`, and that placement is load-bearing.**
The store holds the layout preferences, so `store/persistence.ts` needs `LayoutOptions` — and
putting the module under `src/ui` would make the store import the UI, which is both a new
dependency direction and a cycle, since the UI imports the store. Nothing in `src/layout`
touches React.

**Only the canvas knows how big a card is.** A node's height comes from its param rows, its port
count, its body widget and whether it is collapsed — none of which the document records. So
`resolveSize` prefers the canvas's measurement and falls back `node.size → defaultSize → 232×120`.
A zero measurement counts as no measurement: a card mounted but not yet laid out reports 0×0, and
taking that literally arranges a tidy grid of points.

**Sizes are read from `offsetWidth`/`offsetHeight`, and both plausible alternatives are wrong
here.** This cost a real bug — every card silently taking the 232×120 fallback, so ELK arranged a
row of identical boxes and packed each wide card's neighbours straight through it. Explore Dataset is 520
across, a dataset card 248, a Neuron Profile 560.

- `getNodes()` is `store.nodes.map((n) => ({ ...n }))` — a shallow copy of the array _the editor
  built_. In controlled mode `measured` on it is whatever we put there, which is nothing.
- `getInternalNode(id).measured` is the real measurement, and it is only as good as what
  `rfNodes` last handed back. `adoptUserNodes` carries it forward while the _user_ node object
  behind it is identity-equal and otherwise re-seeds it from `userNode.measured`; `rfNodes`
  rebuilds every node object on each store change, so before `measuredSizes` existed **every
  graph edit wiped every measurement**, and the ResizeObserver does not re-fire for a card whose
  size did not change. Observed live: 9 measured, then 0, then 0. They survive an edit now, but a
  card added _this_ tick still has none — which is the case auto-layout is asked about most.
- `offsetWidth`/`offsetHeight` are layout-space and ignore CSS transforms, so they are the card's
  size in flow units at any zoom. Verified at zoom 1.0, 0.833 and 0.694, where an Explore Dataset card's
  bounding rect reads 520, 433 and 361 while its offset size reads 520 throughout.

Zoom-independence is not a nicety: these numbers go into `structureKey`, and a size that drifted
with the viewport would have auto-layout re-arranging the graph every time somebody scrolled.

**`useNodesInitialized` is unreliable in this app, for the same reason, and nothing reads it any
more.** Its store flag is computed inside `adoptUserNodes` from the internal node's `measured`,
which the paragraph above wiped on every edit — and `updateNodeInternals`, the path the
ResizeObserver takes, never recomputes it. So it latched **false** once the first edit landed and
never recovered. Auto-layout was gated on it and consequently never ran at all; it asks the
readiness question of the sizes it is about to use instead, which is the more precise question
and is why the gate stays off now that `measuredSizes` would let the flag recover. Fit-on-load was gated on it too and
is written up under *Framing a graph that was just opened* — there the answer was different
again, because React Flow's own `fitView()` already waits.

**ELK numbers ports clockwise from the node's top-left.** With no north or south ports that walk
is every east port top to bottom, then every west port **bottom to top** — so an output's index
follows declaration order and an input's is the reverse of it, offset past the outputs
(`portIndices`). Backwards, this mirrors every card's sockets against the wires arriving at
them: nothing throws, nothing fails a type check, and the layout merely crosses more than it
needs to. `layout.test.ts` checks the convention against the real algorithm rather than against
the comment describing it.

**Port constraints depend on direction, and the number is measured.** Horizontal directions get
`FIXED_ORDER`; vertical ones get `FREE`. Under `DOWN`, pinning the sockets east and west makes
ELK reserve routing space for a wire leaving a card's right edge and re-entering the left edge of
the one below, and a four-node chain comes out as a **diagonal staircase**: x-spread 756 under
`FIXED_ORDER` or `FIXED_SIDE`, 39 under `FREE`, with the same 648 of vertical travel either way.
Nothing is lost by freeing them — ELK's port coordinates are discarded regardless and React Flow
draws each wire from the real socket.

**A wrong ELK option key is silent.** ELK ignores an option it does not recognise instead of
rejecting it, so a typo in one of those strings survives typecheck, lint and the eye. That is why
`layout.test.ts` runs the real algorithm and asserts on the _result_ — direction, spacing, port
order — rather than on the record being built.

**Edges reference port ids, not node ids** (`elkPortId`, `nodeId#portId`), which is what makes
`FIXED_ORDER` mean anything. Deliberately not `core/graph`'s `portKey`, which joins with a NUL
byte: fine as a Map key inside one process, a bad thing to send through `postMessage` into a
GWT-compiled Java port that builds strings out of it.

**elkjs never enters the main chunk.** Same doctrine as three.js and sigma. In the browser it
runs in a **worker** — auto-layout mode re-arranges on every structural edit, so the pass is not
something the canvas can afford to block on. Under vitest there is no `Worker`, so the bundled
build stands in, which is what lets the tests put the real algorithm behind the real mapping.
That fallback's specifier goes through a variable and `@vite-ignore`: written as a literal,
rollup resolves it and emits the whole 1.4 MB bundled build into `dist/` as a file no browser can
ever fetch. Verify with `pnpm build` — `elk-worker.min-*.js` should be its own chunk and
`elk.bundled-*.js` should not exist at all.

**The result is anchored, then dodged.** ELK lays out from the origin, so `anchorTo` puts the
block's top-left back where the arranged set's top-left already was — otherwise arranging a graph
on a canvas panned away from (0,0) teleports it off screen, which reads as having deleted it.
Then `dodge` shifts it clear of the text notes.

**Notes never move; the pipeline gives way.** A note is somebody's sentence about a particular
step. `dodge` resolves against each note _in turn_ rather than against one union rectangle: an
example with a note above the chain and another below has a union spanning the whole canvas, and
clearing that would fling the graph hundreds of units down past empty space it never touched.
Downwards only, because the flow is horizontal and the examples place their notes by column — a
sideways shift would slide every note out from over the step it describes.

Note the consequence, which was accepted rather than overlooked: arranging a bundled example
moves the pipeline but not its commentary, so a note written for one step can end up above a
different one. And `dataset.description` is **not** an annotation — it has a Dataset input and
takes an ordinary pipeline slot, which is the position `core/companion.ts` deliberately avoids
when it places one by hand.

**Auto mode watches `structureKey`, not the graph.** Node identity, type, collapse and _measured_
size, plus every edge's four endpoints. Positions are out, so a drag never asks for a new
arrangement. Params are out too — but a param edit that changes a card's height still triggers,
because it reaches the key through the measurement. That is "structural changes only" arrived at
through what is on screen rather than through a hand-kept list of which params are allowed to
matter.

**`arrangeNodes` exists so the layout does not switch itself off.** A committing `moveNodes`
frame clears `autoLayout` — a position somebody chose outranks one ELK computed, and a card that
springs back from where you just put it is not a setting working, it is the editor refusing to be
edited. Sent down that same path, an arrange would clear the flag every time it ran, so
auto-layout would work exactly once. Opening a graph clears it for the same reason: the positions
in a file are somebody's decision.

**Animation frames never reach the store.** `commit` re-runs `inferGraph` and `refreshStates` on
every call, and an eighteen-frame glide has no business paying for eighteen inference passes to
move some rectangles. The frames live in `EditorCanvas` state and override `position` inside the
existing `rfNodes` memo; one `arrangeNodes` lands at the end, so the whole arrangement is a single
undo step. The commit and the override-clear happen together, because clearing first flashes the
old positions for a frame. `prefers-reduced-motion` skips to the commit.

**The auto effect retries rather than giving up.** It runs when the graph commits, which for an
added node is before the browser has laid its card out — so the newcomer has no size yet and
would be arranged around a fallback box. Nothing else re-runs the effect: its deps are the graph
and the mode, and a card being laid out changes neither. So it re-checks on the next animation
frame, bounded, and then proceeds anyway.

The other half of that bug was cancelling the pending arrange at the top of the effect and
rescheduling below: the pass that re-ran after measurement found the key unchanged and returned,
having already cancelled the arrange the previous pass scheduled _and_ advanced `lastKey`, so
nothing ever rescheduled it. A node added with auto-layout on simply stayed where the palette
dropped it, on top of whatever was underneath. The early return must leave the timer alone.

**Both size bugs above were found in a real browser, not in the suite,** and that is the standing
lesson: jsdom reports one stubbed size for every element, so a layout built from measurements and
one built from the fallback both look plausible there. The suite now pins the difference —
`layoutControls.test.tsx` asserts that no two arranged cards overlap _at their measured size_,
which fails with 15 collisions against the old code — but the sizes themselves were only ever
distinguishable against a laid-out page.

The _worker wrapper_ remains uncovered: jsdom has no `Worker`, so tests take the bundled path.
What was checked by hand is that `elk-worker.min.js` guards both its entry branches with `typeof`
and calls no `importScripts`, so vite serving it as a module worker in dev is safe.

### Edge routing — wires that go around the cards

A fourth button on the controls rail, between auto-layout and the options bubble, toggling
**Curved ↔ Orthogonal** (`EdgeRouting` in `layout/options.ts`). Per-user in `localStorage` under
the layout key, never in the document — a file you were sent must not restyle itself to somebody
else's taste.

**ELK has been computing these routes all along and they were being thrown away.** `runLayout`
called `positionsFrom(laid)`, which reads `result.children`; the bend points are in
`result.edges[].sections[].bendPoints` and were never read. `elk.edgeRouting` is still **never
set** and should not be: layered produces orthogonal bend points regardless, and the two settings
that would change them move the *nodes* as well — `POLYLINE` shifts every position and yields
fractional x, `SPLINES` returns a variable-length control-point list that is a different
rendering problem. So the layout half of this feature costs one extra function, `routesFrom`.

**Sockets are pinned into ELK, and that is what makes a route usable.** A Coda card pairs input
*i* and output *i* into one `.port-row`, so opposite sockets share a height; ELK spreads ports by
its own `spacing.portPort` rule and has no constraint that can say otherwise. Handing it the
measured offsets (`MeasuredPorts`, `FIXED_POS`) settles it at the layout end rather than by
splicing real endpoints onto a computed middle. Measured: `FIXED_POS` honoured every offset
exactly, still bent the edges that had to clear a card, and left node placement unchanged in x
and *tidier* in y — row spread 0 against 9.5.

Three things about that measurement, each of which was wrong first:

- **Bounding rects, not `offsetTop`** — the reverse of the rule `measure()` follows for sizes,
  and principled: a handle is positioned `top: 50%` and centred by a `transform`, so the offset
  correction differs by side (`translate(-50%)` left against `translate(50%)` right) and the
  diamond sockets add a `rotate`. A rect has applied all three, and dividing the card-relative
  difference by the zoom cancels the camera exactly.
- **React Flow's `handleBounds` is not the source here.** `parseHandles` returns
  `!userNode.measured ? undefined : …`, so while nothing wrote `measured` back `adoptUserNodes`
  wiped handle bounds on **every graph edit** and React Flow re-measured asynchronously
  afterwards — the bounds were simply absent for a whole frame at exactly the moment a layout
  pass wanted them. `measuredSizes` ends the wipe, but the rects are still measured a beat after
  the card mounts, so the DOM read stays the source and this is one less thing that has to agree.
- **A card is pinned only when every one of its sockets was measured, and only under a
  horizontal direction.** `FIXED_POS` takes coordinates literally, so one unmeasured port lands
  at (0,0) — the card's corner, on the wrong side — and ELK routes confidently into it. And ELK
  honours explicit port positions under `FREE` too, so supplying them under `DOWN` reinstates
  exactly the constraint that direction had lifted: the diagonal staircase came back at x-spread
  319 against 39, with the option string still plainly reading `FREE`. Sockets that all resolve
  to *one point* are also rejected — a real card never stacks them, so exact agreement means the
  rects were not describing a card, which is what a jsdom stub produces.

**Routes take the same anchor and dodge the positions take**, read back through `anchorDelta` /
`dodgeDelta` rather than re-derived. ELK lays out from the origin, so a route left there is not
subtly wrong — it is a wire drawn the whole width of the graph away from the nodes it joins.
They are **not rounded**, unlike positions: a route is never serialised, and a socket sits at its
card's rounded position plus a *fractional* offset, so a rounded waypoint disagrees by that
fraction and the wire leaves at an angle. Measured at 0.39 units before the rounding came out.
A residual of up to half a unit survives because the nodes round independently at each end;
`CodaEdge` anchors the path on React Flow's sockets and lets only the middle be ELK's, so a wire
is attached whatever the waypoints say.

**Routes are held against `routeKey` and dropped the moment it stops matching.** That is
`structureKey` plus every node's position, and the difference is the point: positions are outside
`structureKey` on purpose, so a drag does not ask for a new arrangement — but a route is a path
through particular gaps, so one card moving leaves the waypoints describing a picture that is not
there. Nothing re-routes on a drag; that is an ELK pass per pointer move. Same idiom as
`ui/viewers/layoutMemo.ts`, and for the same reason: there is no single event meaning "the
arrangement is stale", only many that are.

**A third mode was built and removed, and that is the most useful thing recorded here.**
`routed` kept the bezier everywhere *except* on wires ELK had actually bent — a smaller change
that leaves the canvas in its own visual language and touches only the wires that needed it. It
reads well on paper. In the hand it did nothing: ELK produces bend points **only as a by-product
of laying a graph out**, so on a canvas nobody had arranged there were no routes and the mode was
byte-identical to `curved`. A button that does nothing until you press a *different* button
first, which is exactly how it was reported.

There is no fixing that inside ELK, and it was checked rather than assumed: `elk.fixed` honours
given positions and returns **zero** routes; `elk.fixed` plus `ORTHOGONAL` throws; and every
interactive layered strategy (`layering`, `crossingMinimization`, `cycleBreaking`,
`nodePlacement`) still moves every card. Routing wires around cards that are *already placed* is
an obstacle-routing problem ELK does not solve — it would be our own router, which is a real
project and a separate decision.

`orthogonal` has no such hole because it steps **every** wire: the ones ELK bent follow the gap it
reserved, and the rest take a plain step path. So the control always does something visible,
arranged or not. That is also the honest reading of the measurement — only 10 of 32 edges across
the bundled examples carry bend points at all, so a mode keyed *solely* to those was always going
to look like it had half worked.

Note what the routes are *worth*, measured in a browser across the five examples that shipped when
this was taken — the ROI-summary one has since gone, with the synthetic hemibrain it ran on, and the
measurement is left as recorded rather than reasoned forward. As the examples are hand-placed, 1–2
wires cross a card each; **arranging alone** clears every one of them in four of the five, because
ELK's placement already reserves the channels. Routing fixes the fifth. A modest win on a tidy graph
and a real one on a wide card or a long skip — which is the honest reason `orthogonal` is offered as
a *drawing style* rather than as a fix for crossings.

**`data-routed` on the path is for the tests, and it is not laziness.** Nothing about the path
shape distinguishes an ELK route from a computed step: measured, `getSmoothStepPath` emits between
0 and 4 corners depending only on where the sockets landed — no arrange gives `0,0,0,0,0,0,0`, an
arrange `2,4,2,0,0,0,0` and a drag `2,2,2,2,4,0,0`, a plain step path outscoring a routed one. The
only other discriminator is the punctuation the two generators happen to use, which would keep a
genuine regression green the day either changed a space. Both route tests in
`layoutControls.test.tsx` were verified by mutation — removing the staleness drop fails the drag
test, making it unconditional fails that one *and* the param one.

`CodaEdge` is the only registered `edgeTypes` entry and draws both. Registering it costs
nothing that was relied on: React Flow's `EdgeWrapper` renders the component *and*
`EdgeUpdateAnchors` as siblings inside a `<g>` carrying the click, right-click and focus
handlers, so the drag-off rewire, `reconnectRadius`, the edge menu, selection and Delete are
untouched — and `BaseEdge`'s `interactionWidth` copy follows the detour, so the hit target does
not stay on the straight line the wire no longer takes. Under `orthogonal` a wire with no route
falls to `getSmoothStepPath` rather than a fourth path builder, sharing `CORNER_RADIUS` so one
canvas has one kind of corner.

**No route reaches a wire under `curved`** — `Editor` withholds it rather than passing it with a
flag saying to ignore it. The mode is a fact about the canvas and the route a fact about one
wire; letting the component read both is how a wire ends up bent in the mode that says it is not.

Verified in a real browser as well as headlessly, because this is exactly the class jsdom cannot
see: both modes drawn, wires attaching to their sockets, corners filleting, a route going around
the card the curve went through, and no console errors. It is also how the retired mode's hole was
found — jsdom happily confirmed `routed` "worked", because every one of its tests arranged first.
What has **not** been looked at is a route under a non-default algorithm: `mrtree` bends every
edge, `force`/`stress` bend none and `radial` returns no `sections` at all, all of which read as
"no route" and are covered headlessly.

## Canvas interaction

Set explicitly on `<ReactFlow>` in `Editor.tsx`, and each one matters:

- `panOnDrag={[0,1,2]}` + `selectionOnDrag={false}` — left-drag **pans**. Panning is far
  more frequent than box-select, so it gets the bare gesture.
- `selectionKeyCode="Shift"` — Shift+drag box-selects. Because Shift is taken,
  `multiSelectionKeyCode` is `['Meta','Control']` only.
- `panActivationKeyCode={null}` — React Flow binds Space to pan-activation by default;
  it's disabled so Space can open the command palette.

**Viewer cards resize; nothing else does.** `NodeResizer` is rendered for
nodes in the `visualisation` category only (`isViewer`, read off the definition rather than a
second hand-kept list of the same type ids) — a transform node's height is decided by its fields, so a handle
there would promise a control that does nothing. Three things about it:

- **It is a sibling of `.coda-node`, like the run ring**, and for the same reason: the handles
  straddle the card's edge and the card clips with `overflow: hidden`. `nodeResize.test.tsx`
  asserts it, because moving it inside throws nothing and just clips half of every corner.
- **Size lives in `GraphNode.size`, and `NodeDefinition.defaultSize` is only a fallback**, read
  at render time rather than stamped at creation. That is why every path that makes a node —
  palette, browser, examples, starters, a loaded file — gets a sensible size without knowing
  the field exists, and why nothing lands in the saved file until someone drags a corner.
- **Only `setAttributes` dimension changes are persisted.** React Flow emits `dimensions` for
  its own measurements too, on every mount and content change; storing those would write a
  measured pixel size into the document on load and fill the undo stack with things nobody did.

### Measurements, and who keeps them

**Every measurement is kept — in the component, never in the document.** `measuredSizes` in
`Editor.tsx` is a `Map` of node id to the last size React Flow measured, fed from the same
`dimensions` changes the bullet above declines to persist, and handed straight back on the next
`rfNodes` rebuild as `measured`. Component state, because a measurement is not a decision: in the
document it would ride undo, autosave and the saved file, which is the bug the bullet above is
about.

**The minimap is what forced it, and the symptom named the cause badly.** The map drew _some_
cards and quietly skipped the rest, and the ones it skipped were the ones that cannot be resized.
`MiniMapNodes` reads `nodeHasDimensions(userNode)` — the **user** node, not the measurement — and
skips anything it has no size for. So the only cards on the map were those carrying a `node.size`
or a `defaultSize`, plus, since a collapsed card deliberately leaves its height to the content,
not even all of those. Four of eleven, in the `partners` example.

**Two things fall out of it, both good and neither the point.** `adoptUserNodes` now carries
handle bounds across an edit instead of wiping them (`parseHandles` returns them only when
`userNode.measured` is set), so the cards are no longer re-measured once per graph edit; and
`useNodesInitialized` would come good, though nothing reads it. The one thing to know is that the
per-edit wipe used to _heal_ a stale handle position for free. It cannot any more, so a layout
change that moves a socket without changing the card's box has to say so — which is what
`CodaNodeView`'s `updateNodeInternals` call already does for collapse and fold, the only two that
do it. Ports are declared on the definition and the port band sits directly under the header, so
nothing in the body can move them.

`panels.test.tsx` pins the count against the graph's. It stubs `offsetWidth`/`offsetHeight` for
`.react-flow__node` to get there: jsdom reports zero, and React Flow drops a zero-sized
measurement before it ever becomes a change, so without the stub the map is empty either way and
the test would pass on the broken code.

**A pointer gesture undoes to where it started.** `commit` takes a `gesture` tag, and the
uncommitted frames of a drag or resize stash the graph as it was when the gesture began. Before
that, history was recorded from the _last_ frame, so undoing a drag moved the node back one
frame — and since the final two frames of a drag are usually identical, undo after moving a
node appeared to do nothing at all.

**Two controls put a card's sockets on its header.** Collapse (`▾`) keeps nothing else; the
`☰` fold keeps the body and the footer, so a viewer's drawing gains both the param band and the
port band — which is the whole reason the fold exists. There is no ports-only state any more:
`collapsed` simply means more than it did. Wires converge near the title the way Blender's and
ComfyUI's do.

**The handles are moved, never removed, and that is the whole of it.** React Flow finds a node's
anchors with `nodeElement.querySelectorAll('.source' | '.target')` and returns `null` when there
are none, so unmounting the port rows leaves every wire on the card with nowhere to attach.
`display: none` is worse rather than safer: the element stays findable and reports a zero-size
rect, so each wire lands on the card's **top-left corner** looking deliberate. The band stays in
the DOM and the stylesheet lays it over the header.

**Over the header, not over the card.** `inset: 0` would be right only for a collapse, where the
card _is_ its header; under a `☰` fold there is a preview and a footer beneath, and centring the
sockets in those puts them halfway down a chart. So the band takes `--header-h`, declared on
`.coda-node` and applied to the header as a `min-height` so the two cannot drift — `min-` rather
than a fixed height because 28px is merely the header's natural size, and a control that grows
should grow the header rather than be clipped by it.

**Fanned, not overlapped, and three is the number that matters.** No node in the registry has
more than three ports on a side (Paths 3→3, Explore Dataset 1→3, Adjacency 3→1, Viewer3D 3→1), so a
`--port-pitch` of 8px puts three 11px discs down a ~28px header overlapping by 3. Every socket
keeps a hit target, which is what lets a dragged link still choose an input and keeps the
drag-off rewire anchors (`reconnectRadius: 14`) distinct. Exact overlap was the other option and
loses both: the topmost handle takes every pointer event.

**`pointer-events: none` on the band, never on the handles.** The band covers the header, which
owns the drag, the run button and the chevron. React Flow puts pointer events back on each handle
through its own `connectionindicator` class, so `none` costs the sockets nothing and omitting it
costs the header everything.

**This is the first thing in the app that moves a handle, which is why nothing needed
`updateNodeInternals` before.** The ports band sits directly under the header and everything
`collapsed` used to hide was _below_ it, so no collapse ever changed a socket's position. React
Flow re-measures on `dimensionChanged || !handleBounds || force`, and the height change does
trigger it — but that is the ResizeObserver's promise rather than ours, so the move is declared
explicitly, on either state changing. Behind a mount-seeded ref: `updateNodeInternals` writes to
React Flow's store, and firing it on mount would be one store write per card at load for
measurements it is about to take anyway.

**A collapsed card keeps its width and gives up its height.** `rfNodes` withholds `height` from a
collapsed node so the wrapper hugs the header, and `[data-sized]` was split — it now means "the
wrapper carries a width", with the box-filling half under `:not([data-collapsed])`. Both halves
matter, and this was a live bug before the change: a collapsed Scatter left a header floating in
the top-left of its 460×380 wrapper, with `.coda-node::before` inset against that _wrapper_, so
the state bar hung 330px below the card as a coloured line with nothing beside it — the same
failure `defaultSize` on a non-viewer causes. Measured after the fix: wrapper `width: 460px` and
no height, box 460×52. Keeping the width is what stops a 560px card becoming a 232px one on its
way to a title bar and moving every wire on it twice.

**What it costs is the port labels.** Socket types are distinguished by colour _plus_ shape _plus_
a visible label because only three chromatic families clear the all-pairs colourblind gate on this
surface — so a folded card is carrying one channel fewer, with the socket's `title` as the only
prose. A real trade, taken deliberately for a state somebody chooses and reverses.

**This one _was_ looked at in a browser**, unlike most of the canvas — playwright against the dev
server, folding and collapsing a Connectivity node and a boxed Scatter. Worth recording, because
it settled something the CSS alone could not: **folded sockets are not clipped and expanded ones
are.** Expanded, a handle's containing block is `.port-row` inside `.coda-node`'s
`overflow: hidden`, so the discs render as half-circles flush with the border; the folded band is
absolute against React Flow's wrapper, which is _outside_ that clip, so they come out whole. It
reads fine — arguably better — but the two states genuinely differ, and anyone matching one to
the other should know why. `collapsedPorts.test.tsx` still pins only the DOM and the
declarations, since jsdom performs no layout.

**Param rows fold away** (`GraphNode.paramsCollapsed`, the `☰` in the card header). A card is
configured once and then read for the rest of the session, so the rows that set it up go on
spending its height on a decision already made — five of them on a bar chart, above the chart.

**Every card that draws a band, not only the viewers.** On a viewer the freed height goes to the
drawing, which is the case this was built for; elsewhere the card simply gets shorter, which is
worth having on its own — a settled pipeline is a row of decisions already made, and reading the
graph then means reading the titles and the wires.

**The button lives in the header, and that is what makes the fold safe on a card with nothing
under the rows.** It survives the band it hides, so there is always something to press — the same
rule the minimap's corner button and the overlay's Style button follow, and the reason the
viewers-only restriction this shipped with was dropped rather than worked around. Its glyph does
not change with the state and does not need to: the rows are either on the card or they are not,
which says it louder than a pair of arrows. The pressed style carries that fact for a pointer that
has not moved yet, and `aria-pressed` for a reader who cannot see the card at all.

**Distinct from `collapsed`, which is the neighbouring control.** Collapse takes the port labels,
the footer's summary and any preview; a folded card still says what it is holding and what it is
wired to. That difference is what stops the pair being one control wearing two glyphs.

**It is in the document, like `collapsed` and `size`.** A workspace set up for reading has to
reopen that way; absent means shown, so every graph saved before the flag existed looks exactly as
it did. And it costs no run — not a param, not in the provenance key, committed with
`autoRun: false` — because a graph going stale when somebody tidies a card reads as a scheduler
bug. Same standing a resize has. `liveNodes` filters the selection for the same reason mute and
collapse use it: a text note draws its own card with no header and no band.

**No band, no button.** A node whose params are all `advanced` (`out.neuroglancer`, deliberately —
a row of pickers above a 400px embed is what `advanced` was for there) and every node with a body
of its own, which renders its own controls instead of the generic rows. The card computes this
from `visibleParams.length`, so it is one rule rather than a list.

**Where the space actually goes depends on `data-sized`.** A card with an explicit box — anything
resized, plus Scatter, Neuron Profile and Neuroglancer by their `defaultSize` — gives the freed height to
the preview, which is `flex: 1`. An untouched card with no `defaultSize` sizes to its content, so
folding makes the card shorter and leaves the preview at its 210px cap. Raising that cap on the
fold was declined: it is a second magic number for a case one drag of a corner already answers.

**A card says how much of itself is not on it** — `… 4 more (1 changed)`, right-aligned at the
end of the param band, opening the inspector on that node when clicked. `advanced` params never
reach the card and the inspector is closed by default, so a node with settings on it and one
without looked identical. `configurableParams`, `hiddenParams` and `changedParams`
in `core/node.ts` are the rule, headless.

**Two counts answering two different questions.** _How many are hidden_ is a fact about the node
type and never moves — it is the general indicator, and it is what tells someone there is
anything to look for. _How many were set_ is about this particular node, and it is the half worth
a step of ink, on the same reasoning `validateColumnParams` uses: a default was never a decision.
Hence one line with two clauses rather than two markers, and hence the changed clause simply
absent when nothing has been touched. (A first pass showed the marker **only** when something had
been changed. Across the five bundled examples that lands on 4 nodes of 29 against 16 — quieter,
and wrong for the question actually being asked, which is "what else is there".)

**"More" becomes "hidden" when the hidden ones are all there are.** `… 9 hidden` on Neuroglancer,
`… 1 hidden` on Skeletons — "more" is a claim about something else being on the card, and on
those there is nothing. The question is asked of `activeParams` rather than of the rows that were
drawn, because a node with a body of its own renders controls nothing here can enumerate:
Explore Dataset's search box is on the card, so its five advanced params stay `more`.

**Not gated on the band it sits at the end of.** The cards needing it most draw _no_ rows at all:
`neuron.skeletons` has exactly one param and it is advanced, so an empty body was the whole of
what the card said about itself. It does go away with a fold, which is the one case where
something else on the card — the `☰` in its pressed state — is already saying there is more here.

Three exclusions, each of which would otherwise be a false claim. **`visibleIf` first:** a param
the current values have switched off is inapplicable rather than hidden, or the number moves as
unrelated modes are chosen. **`ParamBase.internal` next:** a nonce or a pager is machinery a
widget writes, not a setting — without it a dataset card announced `… 1 more` about its `refresh`
counter, and turning a page in Neuron Profile had the card claim a parameter had been changed. It stays
a real param, saved and reachable in the inspector, because the escape hatch is sanctioned; the
flag only stops anything _advertising_ it. Note it is not a synonym for `advanced` — Explore Dataset's
`Rows per page` sits beside `page` and is inspector-only for space, but it is somebody's
preference and stays countable. **An absent value is not a change:** loading does not fill missing
params with defaults, so a graph saved before a param existed has no key for it, and comparing
that against the declared default reports a change on every older file.

Both sides of the "are the hidden ones all there is" comparison come from `configurableParams`,
or a node whose one other param were a nonce would say `more` while drawing nothing.
`hiddenParams.test.tsx` asserts that every `refresh` in the registry carries the flag, since the
next dataset-shaped node will grow one and nothing else would catch it.

`align-self: flex-end` puts it under the _fields_ rather than the labels, since it is about what
is missing from the right-hand column, and the tooltip **names** the params — marking the changed
ones — rather than printing their values, which an `ids` param holding four thousand neuron ids
would not survive. The click reads the store through `getState()` rather than subscribing, or
every card re-renders whenever the inspector is toggled from anywhere; and it checks
`panels.inspector` before flipping it, because `togglePanel` is the only setter there is and a
button meaning "show me" must not close an inspector that is already open.

There are **two** add-node surfaces, on purpose:

- `NodeBrowser` — big centred modal with thumbnails and category chips, for browsing. Opened
  by Tab / ⇧A / the + Add button / the `Add ▶ Browse All Nodes…` command.
- `CommandPalette` — compact keyboard list, for people who know the name. Opened by Space
  (everything), by canvas double-click / pane right-click (prefilled `Add:`), and by
  dragging a link into empty canvas (filtered to compatible types, and it wires the pick up).

`NodeThumbnail` derives everything from the `NodeDefinition` — header tint from category,
dots from real ports. The centre glyph is keyed to the **category** so six drawings cover
every node; `NODE_GLYPHS` overrides that only for the three viewers, whose identity is a
visual form. Never make thumbnails require per-node artwork: a future node would ship with a
blank preview. A test renders one for every registered node to enforce that.

In `NodeBrowser`, chips and search are mutually exclusive — typing clears the chip, a chip
clears the query. Don't "fix" this into chip-as-hard-filter: that reintroduces empty results
with no visible cause.

The palette's item list comes from `paletteItems.ts`, rebuilt on every store change so
`disabled` flags stay honest.

`PaletteItem.action` does double duty: it's the first breadcrumb segment _and_ the
`Action:` filter prefix (`PALETTE_ACTIONS` is the recognised set). Prefixes are a filter,
not a mode — `parsePaletteQuery` strips the prefix, the item list is narrowed by action,
and the remainder is fuzzy-matched, so deleting the prefix widens the search back out.
Rows render as `action ▶ group ▶ name ▶ description` with only `name` in primary ink; that
single contrast step is why the list needs no group headers.

The palette is keyed by `menu.seq` in `Editor.tsx` so reopening resets its search box to
the new prefill instead of keeping the previous query.

Both store-driven open signals (`paletteRequest`, `browserRequest`) are guarded by a ref
seeded at mount, because the store outlives the component: without it, any remount after an
earlier request re-fires it and the widget pops open unprompted.

Note `fuzzyMatch` tries every occurrence of the query's first character as an anchor rather
than scanning greedily once — without that, "res" ranks "Clear Results" below an item whose
_description_ starts with "Rescale", because greedy takes the `r` in "Clea**r**".

## Dropping a node onto a wire

Drag an **unconnected** node over an existing link and let go: `A → B` becomes `A → node → B`.
The wire highlights while the card is over it, so the drop is never a surprise. `core/splice.ts`
holds every decision, `ui/spliceHit.ts` the geometry, and the split is the usual one — jsdom
performs no layout, so a path has no length and the geometry half cannot be tested at all.

**Only an isolated node splices**, and that is not tidiness. A drag across a busy canvas passes
over many wires, so a node already wired — one somebody is *rearranging* — would rewire the graph
on any drop that happened to land on one. A node with no links has nothing to lose and is almost
always one just added.

**The downstream link is judged against a graph with the upstream one already applied**, which is
the decision the whole thing turns on. A node's output type routinely depends on its input:
`core.filter` isolated publishes `T.table()` and only becomes `neurons` once something
neurons-shaped reaches it — so checking both links against the *current* inference refuses a
Filter dropped on `Find Neurons → Skeletons`, which is the most obvious thing anybody would try.
One re-inference, then the first compatible output; a node whose *second* input would have worked
where its first did not is missed, which is the same "first compatible" simplification the
palette's link-drag already makes.

**The hit test walks the drawn path**, not a line between the sockets. `isPointInStroke` against
the card's centre was the obvious route — React Flow already draws a fat `interactionWidth` copy
of every edge — and it makes the target ±10 flow units around a hairline, which is a precise aim
for a whole card thrown across a canvas. Sampling the path and asking whether it enters the card's
rectangle is more forgiving and is what "drop it on the wire" means; walking the *rendered* path
also means an orthogonal step and an ELK route are judged where they are drawn, with no geometry
of our own. The card's size comes from `offsetWidth` for the reason `useArrange` records at
length.

**The move and the rewire are one `commit`, under the drag's own gesture tag**, so ⌘Z lands on the
graph as it was before the drag began. Two commits would be two undo steps, the first of which
leaves the graph rewired around a card in its new position — a state nobody was ever in. Unlike a
plain move it *does* re-run, because the dataflow changed.

**The ports are re-derived at the drop rather than carried from the drag.** The candidate was
computed on a pointer move; positions do not reach inference, so the answer is the same one the
highlight showed, and passing it would be a second copy of a decision that can only disagree.

One note on `spliceGraph`, because the comment there was wrong first and mutation testing caught
it: the original link is removed **explicitly**, but `addEdge` would evict it anyway — the
downstream link targets the same `(node, port)`, which is exactly its eviction rule. So the order
does not matter, and the removal stays because relying on that coincidence would hold only while
both links land on one input.

## Breaking and re-routing links

Two gestures, and the pair is the design: **right-click a wire** for a menu, or **drag either
end off its socket** to re-route it — drop on another socket to move it, on empty canvas to
unplug. A hover ✕ on the wire and a Blender-style cut-across-several drag were both considered
and declined; the first puts chrome over the canvas for a rare action, the second is a tool with
no visible affordance at all.

The Delete key on a selected wire has always worked — React Flow selects edges, `deleteKeyCode`
is set, and `onEdgesChange` handled `remove` long before any of this. It was simply the _only_
route, and nothing on screen said so. Treat it as a shortcut that exists, not as the answer.

**A rewire keeps the edge's id, and that is what makes it one undo step.** `reconnectEdge` in
`core/graph.ts` removes and re-adds under the same id rather than minting a new one. Two reasons,
both load-bearing: React Flow keys wires by id and the reconnect drag is _still in flight_ when
this runs, so a fresh id remounts the element being dragged; and a delete-plus-add is two history
entries, which means ⌘Z leaves the link unplugged halfway through a gesture that finished. Note
the ordering inside it — the removal comes first, because `addEdge` evicts whatever already
occupies the destination input, which is not necessarily the edge being moved, so adding first
would leave two edges sharing one id.

**`connectionState.toHandle` is the discriminator in `onReconnectEnd`, and it is the only honest
one.** React Flow sets it whenever the drop landed on a socket, valid or not. So:

| dropped on                        | `toHandle` | what happens     |
| --------------------------------- | ---------- | ---------------- |
| a socket that accepts it          | set        | rewired          |
| a socket that refuses it          | set        | snaps back, kept |
| empty canvas (or a card's middle) | null       | unplugged        |

The classic React Flow pattern — a `reconnectDone` ref, delete when no reconnect fired — cannot
express the middle row, and that row is the point: a mis-aimed drop onto an incompatible port is
a miss, and answering a miss by also cutting the link makes every failed re-route destructive.
`onReconnectEnd` runs _after_ `onReconnect` on a successful drop, which is the other reason "no
reconnect happened" is not a usable signal.

**The link being moved stays in the graph while the rewire is validated, and that is safe rather
than sloppy.** `createsCycle` walks _forward_ from the proposed target, and the edge being moved
points into its old target, so it can never appear on a path leading back to the source — for
either end of the grab. Excluding it would mean a second, near-identical validation path for a
case that cannot arise. A rewire is otherwise checked by exactly the `checkConnection` a fresh
drag runs, so a refusal reads in the same words.

**The menu carries a header naming both ends** — `Find Neurons ▸ Neurons → Filter ▸ Table` — because
wires overlap and on a dense graph the one under the pointer is often not the one you meant. A
menu whose only item is destructive has to say what it is about to cut. It is styled as a caption
rather than a disabled row, which would read as an action that is currently unavailable.

**`.react-flow__edge.updating` is the only thing advertising the drag-off gesture.** React Flow
puts an invisible circle just outside each socket, offset along the wire, and adds that class
while the pointer is over one; with no rule for it nothing on screen distinguishes "over the
wire" from "over the end you can pull off". The anchors sit outside the card rather than on the
socket, which is what keeps them clear of the socket's own "drag a new link out" gesture.
`reconnectRadius` is 14 against a default of 10 — the anchors swallow pointer events, so the
number is a tax on panning near a socket, and a bigger grab target costs canvas either side of
every node.

**No canvas-level test exists, and cannot.** React Flow draws no wires for nodes jsdom never
measured, and the anchors are SVG circles driven by pointer capture. `store/links.test.ts` pins
the semantics and `ui/panels/edgeMenu.test.tsx` the menu — but the gestures themselves have not
been driven by a real pointer over a real wire by anyone yet, same standing as the WebGL viewers.
