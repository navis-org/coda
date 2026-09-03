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

## Align & distribute

Eight tools in a grid inside the node's right-click menu — align left / centre / right, align top
/ centre / bottom, distribute horizontally, distribute vertically — and the same grid on a group
frame's menu, pointed at its members. `ui/panels/AlignTools.tsx` draws it; `layout/align.ts` is
the arithmetic, headless and sized from `resolveSize` like everything else here.

**No new store action, and that is the design.** An alignment is a position somebody chose, so it
goes down the *drag* path — `moveNodes(moves, true)` — rather than `arrangeNodes`. It therefore
ends auto-layout (left on, the next structural edit would put every card straight back where ELK
wants it), becomes one undo step, and is refused by the lock, all without a fifth thing having to
remember any of that. The tools are dimmed with the reason on a locked canvas for the reason
every other surface is: a control that silently does nothing reads as an editor ignoring clicks.

**Both take measured sizes, including the two that could get away without them.** Only `left` and
`top` are size-free; aligning right edges against a *declared* 232 puts every wide card's edge
somewhere it is not, and having two of the six work differently is how the other four get written
wrong. The read is `ui/cardSizes.ts` — `measureCardSizes`, extracted out of `useArrange` so the
`offsetWidth` walk has one definition rather than two a couple of directories apart, which is the
hazard `fetchText` records. It runs at click time; a menu is not where a measurement is cached.

**Distribute evens the gaps, not the centres**, and on this canvas that is not a close call: cards
run from a 232-wide transform to a 560-wide Neuron Profile, and evenly spaced *centres* with
uneven widths is a recipe for drawing one card through its neighbour. The outermost pair is the
anchor, so the operation is idempotent and never grows the graph's footprint. Ordering is by
centre rather than by leading edge — a wide card whose left edge is furthest left is not
necessarily the leftmost card, and ordering by edge makes distribute swap two neighbours. Where
the cards are already wider than the span they sit in, the gap comes out negative and they stay
overlapped, evenly: nothing here can invent space, a guard rail warns rather than refuses, and ⌘Z
is one key away.

**Nothing is filtered out by node kind.** Mute, collapse and fold all go through `liveNodes`,
which drops annotations — a text note has no dataflow state to toggle. Alignment is purely
geometric, so a note lines up with the cards it labels like anything else on the canvas.

Two smaller decisions, both visible in `ui/panels/alignTools.test.tsx`. A press that changes no
position **does not reach the store at all**: `moveNodes` mints a fresh graph whatever it is
handed, so calling it would leave an undo step for a press that did nothing — and the second
press of any of these tools is exactly that press. And the menu **stays open** after a press,
unlike every other row in it: alignment is not a single decision, "align their left edges, then
even the vertical gaps" is one thought and two presses, and a menu that closed on the first would
make the second a fresh right-click on a card that had just moved.

Positions are rounded to whole flow units. A centre line lands on a half-pixel as often as not,
and a file people read and diff has no use for `412.5117`; two cards of the same width still get
identical coordinates, since each is `round(centre − width / 2)` of one shared centre.

## Hints on a card

A small dismissable box docked to a card's top or bottom border, carrying guidance somebody wrote
*about that card*: "search and tick neurons here". The document side is `NodeHint` on `GraphNode`
(`core/graph.ts`), the box is `ui/nodes/NodeHints.tsx`, and what has been read is `ui/hints.ts`.
The Workflow Wizard writes them (`docs/wizard.md`), and nothing in the app adds one by hand — see
below for why that is a decision rather than a gap.

**A hint is a field on the node, not a document-level list.** `GraphGroup` has to be a document
object because a frame spans several cards; a hint belongs to exactly one. Putting it on the node
is what makes duplicate, copy/paste, `subgraphOf` and delete carry it for free, and it is why
there is no alive/claimed pass on load of the kind `validGroups` needs.

**It draws as a sibling of the card, and that is inherited from the run ring.** `.coda-node` is
`overflow: hidden`, so anything drawn beyond its border from inside it is simply cut off —
`NodeRunRing` and `NodeResizer` are siblings for the same reason. React Flow's wrapper is the
positioned ancestor and is sized by the card alone, so `bottom: 100%` and `top: 100%` put a stack
immediately above and below it with **no measurement, no `ResizeObserver` and no
`ViewportPortal`**. A Table card that grows from 130px to 387px on its first Run takes its hint
down with it, and because the stack is absolutely positioned it contributes nothing to what the
library measures — a hint cannot move a wire or change what `layout/placeGuards.test.ts` checks.
Both halves were seen in Chrome; jsdom performs no layout, so the test can only assert that the
box is *outside* `.coda-node`, which is the relationship that would make it invisible if it broke.

**Width is the card's, `left: 0; right: 0`.** A box wider than the card it points at reaches into
the next column, where nothing knows about it. That sets the length of the copy — two sentences —
and `wizard.test.ts` holds the wizard's own hints to a ceiling for it.

**Dismissing is not an edit, and nothing about that is cosmetic.** A `dismissed` flag on the node
would take an undo step, mark a clean file dirty, and ride down a share link — so the colleague
being *shown* a workflow would open it with the guidance already put away by somebody else. What
has been read is a fact about the reader, so it lives in `localStorage`
(`coda.hintsDismissed.v1`, a list of digests). Two consequences worth knowing:

- **The key is the hint's text**, not a (document, node, hint) address. That is what makes "once
  ever" true: the wizard mints a fresh graph every time it is used, with the same sentence on the
  same kind of card, and an address-keyed dismissal would re-teach a returning reader in every
  workflow they generate. The trade is that two hints saying exactly the same words are one hint —
  right, since the reader has in fact read it, but it makes reworded copy come back for everybody.
- **Nothing is ever forgotten, so both ways back matter.** The node menu's **Show Hints** restores
  the clicked card's; the `?` menu's **Show Hints Again** restores the lot. Each row appears only
  when there is something to bring back. A box dismissed for good with no route back is the
  failure this feature is one deleted row away from at all times.

Both are live under the lock, and neither is an undo step — freezing the canvas changes nothing
about what a reader has read.

**Outside the card rather than inside it**, which is the distinction the design is defending. The
card already draws a band for what the *machine* has to say: `ui/nodes/nodeIssues.ts` ranks an
inference error over a run warning over a type warning and shows one at a time, inside the border.
A hint is what an *author* has to say. Sharing a band would make "the graph is broken" and "here is
where to start" the same kind of object, and a reader who cannot tell them apart acts on neither.

**The tone is a name off `HINT_TONES`, never a colour.** A `.coda.json` arrives from a gist, from
the Zoo, from a mailed file, and a tone spent into an inline `style` is a CSS injection — the same
reasoning `GROUP_COLORS` records, and `deserializeGraph` drops an unknown one rather than passing
it through. The vocabulary is `markdown.ts`'s `CalloutTone` deliberately (`note` / `tip` /
`warning`), because the help documents already draw admonitions in exactly those three and a
second three-word list is how "tip" comes to be blue in one place and green in another.

**Stated twice rather than imported, and the headless rule is only half of why.** It stops `core`
importing from `ui`; it says nothing about the reverse, which is allowed and used everywhere. What
stops the reverse is that `ui/markdown.ts` has **no imports at all** and feeds `help/registry.ts`,
the `nodes.html` entry — importing `core/graph.ts` there would drag the node registry and the
dashboard model into a page bundle `docs/pages.md` requires to stay out of the main chunk, to save
three words. So the lists are held together by a type-level assertion in
`ui/nodes/nodeHints.test.tsx`, which stops compiling the moment either gains a tone the other
lacks, and the stylesheet agrees by sharing `.markdown__callout`'s own `--cal` token and its tone
table rather than carrying a second one.

**There is no in-app way to write one, and that is the current scope.** A hint is authored by
whatever generated the document. Anything a user wants to say about their own graph is a Text
note, which is a card they position, keep, and edit — the two are different objects, and a
right-click "Add hint" would immediately raise the question of which one a sentence belongs in.

## Groups

One box around a set of cards, with an optional title above its top-left corner. Made from the
node menu, the frame's own menu, the command palette or ⌘G; taken apart with ⇧⌘G. The document
side is `GraphGroup` in `core/graph.ts` and the edits are `core/groups.ts`; the frame is drawn by
`ui/GroupLayer.tsx` and configured from `ui/panels/GroupContextMenu.tsx`.

**Membership is a list of node ids, and the box is derived from it.** Both halves of that were
choices, and both had an obvious alternative that is worse here:

- **Not React Flow's own group node.** Its `parentId` makes a child's `position` *relative to the
  parent*, and this document's positions are absolute everywhere — the exporters, the ELK pass,
  the splice hit test, `layout/place.ts`, every saved file. A frame is decoration; it has no
  business re-basing the meaning of a field five subsystems already read.
- **Not a stored rectangle.** Six things move a frame's contents — a card dragged, resized,
  collapsed, folded, added by an assistant plan, re-placed by an arrange — and a stored box would
  need every one of them to remember. `layout/groupBounds.ts` computes it instead, from the same
  `resolveSize` the layout uses, so a frame cannot go stale. It costs one pass over the members
  per render.

**A node belongs to at most one group and groups do not nest.** So "which box owns this card" has
an answer, which is what a future *collapse a group into one box* would need and what an
overlapping model could not give it. Grouping a card that is already framed **moves** it rather
than refusing — a refusal would have to be explained on a menu row, and "regroup these four" is
what somebody pressing ⌘G on four cards means. A frame emptied by that move is dropped; a frame
of one is legitimate, so the floor is one member, not two.

**Four ways a membership list can quietly stop describing the canvas**, which is what
`store/groups.test.ts` is mostly about: a member deleted, a card claimed by two frames, a file
naming nodes this build dropped as unknown types, and a duplicate copying half a frame. The first
is answered by `pruneGroups` inside `removeNodes` — not beside each caller, because deletion
arrives by four routes (the menu, the palette, React Flow's Delete key, an assistant plan) and a
membership naming a node nobody can see is invisible until the frame is dragged and moves fewer
cards than it drew around. The third is `validGroups` in `deserializeGraph`, silently, for the
reason that file is lenient everywhere else.

**The colour is stored as a name, never as a CSS value**, and that is a safety property as well
as a theming one: a `.coda.json` arrives from a gist, from the Zoo or from a mailed file, and the
frame's colour is spent straight into an inline `style`. `GROUP_COLORS` is the list; `theme.css`
and `editor.css` decide what each name looks like in each mode. The default grey is
`--group-line: #7d7b76` — the same value and the same measurement as `--note-border`, which was
chosen over `--text-muted` because that one is 2.99:1 on the *light canvas*, i.e. below the 3:1
non-text floor exactly where a frame lives. The title's ink is `--text-secondary` whatever colour
the frame is: the chip hues are validated as chips (a swatch with text on top), and the grey
clears the line floor while missing the 4.5:1 text one.

**Three properties of React Flow's viewport are load-bearing in the layer, and all three are
inherited rather than asked for.** `ViewportPortal` is the viewport's *last* child, so at the
default depth a frame paints over every card — `z-index: -1` puts it under the cards and the
wires, and the viewport is itself a stacking context, so the negative depth cannot escape and
land behind the canvas. `.react-flow__viewport` is `pointer-events: none` with the cards
switching it back on, and the frame does the same for exactly two things: an SVG rect with
`pointer-events: stroke` and an invisible band `GROUP_GRAB` wide over the outline, and the title.
**The interior stays click-through** — panning, box-select and clicking a card inside a frame all
behave as they do on bare canvas, which is why a bordered `<div>` would not do: it can take the
whole rectangle or none of it. And panning is d3-zoom's, bound to `.react-flow__pane` with a
*native* listener below React's root, so `stopPropagation` on a synthetic event cannot reach it —
the `nopan` class is what d3's own filter reads, and it is the only thing that stops the canvas
sliding out from under a frame being dragged.

The drag writes through `moveNodes`, the same action a card drag uses: one call per pointer move
with `commit: false`, one committing call at the end. That is what makes ⌘Z put the whole gesture
back rather than its last frame, what makes a drag switch auto-layout off, and what makes a
locked canvas refuse it — the guard is already in the action, and the layer only adds the notice
that says so. Deltas are applied to the positions captured at `pointerdown` rather than stacked
frame on frame, so a dropped move cannot make the group drift.

**An arrange does not know about frames.** ELK is handed the nodes and the wires, and nothing
tells it that six of them belong together — so auto-layout can place a group's cards apart, and
the frame, being derived, simply grows to contain wherever they landed. That is the honest
behaviour rather than a bug to work around at the frame's end: ELK Layered does support
hierarchy, and teaching `layout/elkGraph.ts` to emit a child graph per group is the fix if this
starts to matter. Nothing about the frame needs to change for it.

**The lock**: creating and removing a frame are refused (a frame decides what one drag moves,
which is graph structure the way a card's position is); naming and colouring one are not, like
`renameNode` and `setParam`. `store/lock.test.ts` classifies all four.

**The pointer half is not tested and cannot be**, same standing as the wire gestures below:
jsdom performs no layout and dispatches no real pointer sequences. What needs a real browser is
the outline being grabbable at a distance from the line, the interior still panning and
box-selecting, a frame dragged at a zoom other than 1.0 moving its cards by the right amount, the
frame painting *behind* the cards, and the title staying legible over the dot grid. **Those
checks have not been run against this implementation yet.** `ui/panels/groupMenu.test.tsx` covers
the DOM the frame draws, the menu, the keys and the palette rows.

## Copy, cut and paste

⌘C / ⌘X / ⌘V on the canvas, plus three rows on the node menu and three commands in the palette.
The selection leaves as text, and text is what comes back — which is the whole point, and the one
thing `duplicateSelection` (⌘D, and unchanged) cannot do: a fragment copied here pastes into
another tab, another window, a colleague's chat, or a text editor, where it is a readable
`.coda.json` fragment.

Three files. `core/clipboard.ts` is headless — the fragment, the read and the merge;
`ui/clipboard.ts` owns the browser's clipboard and the gestures; the store holds three thin
actions and one field.

**A fragment is a graph file plus a marker, and the marker is not what makes it readable.**
Everything that can go wrong with a pasted fragment — an unknown node type, an edge naming a
socket that is not there, a param that predates its control — is what `deserializeGraph` was
written to survive, and a second lenient reader is where those repairs quietly stop happening. So
`readFragment` *is* `deserializeGraph`, with one cheap gate in front (a `{` prefix, so a pasted
column of ten thousand ids is never parsed) and one question after (**nothing survived** reads the
same as "not ours", or a document from a build with other nodes would swallow the keystroke and
add nothing). It asks nothing in between: valid JSON, an object, `nodes` and `edges` arrays are
all things `deserializeGraph` already throws on, and asking first meant parsing the payload twice
to reach the same three answers. The marker only records which shape of document was copied — the
useful consequence being that a whole `.coda.json` somebody was sent pastes onto the canvas,
because there was never a separate format to refuse it.

**`duplicateSelection` is this, with the clipboard taken out of the middle.** ⌘D was written
first and longhand, and the paste then needed every one of its rules again — internal edges only,
whole frames only, `+28`. Restating them was the arrangement for about an hour, which is exactly
the shape `fetchText` and `canHaveCell` are in the docs to warn about, so the store's action is
now `subgraphOf` + `insertFragment` and the offset has one name (`PASTE_OFFSET`). What that buys
is one clone path: the next field on the document that references a node id has one place to be
handled rather than two that agree by restatement.

**Bound to the `copy`/`cut`/`paste` events, not to keydown.** A clipboard event carries a
`clipboardData` a page may read and write inside the browser's own gesture;
`navigator.clipboard.readText` is the other route and it is gated — a permission prompt in
Chrome, refused outright in Firefox — which is no basis for a keystroke that has to work every
time. Binding the events also means the shortcut is whatever that platform calls it. The cost is
that `ui/panels/shortcuts.test.tsx`'s `press()` cannot reach these three rows, so they get a test
of their own there that fabricates the event against the mounted app; jsdom implements neither
`ClipboardEvent` nor `DataTransfer`.

Three rules keep it out of the way of ordinary text, and each exists because its failure is
silent:

- **A paste that is not a graph is not touched.** Most of what is on a clipboard is prose, a URL
  or a column of neuron ids. `readFragment` runs *before* `preventDefault`, so text the canvas
  cannot use falls through to whatever else wanted it — including, on a locked canvas, without a
  lock notice, since nothing there was addressed to the canvas.
- **A live text selection wins.** With prose selected in a dialog, ⌘C is about that prose even
  though three cards are also selected behind it.
- **A field being typed in is exempt**, through the same `isTypingTarget` both keydown listeners
  share.

**Where a paste lands is a decision, and "wherever it was copied from" is the wrong one.** A
fragment carries absolute positions, so pasting into a graph it did not come from can put the
cards an entire screen from anything on view — a paste that worked, selected the new nodes, and
looks exactly like a paste that did nothing. So the canvas answers with a point, and that answer
is `anchorPoint` — the pointer when it is over the canvas, a point in the middle of it when the
pointer is on a toolbar or a panel — which the toolbar's insertions already ask for. The palette
has no viewport of its own, so `pastePoint` rides on `CommandContext` beside `fitView` and
`fitSelected`, which is what that context is for; the node menu takes the click instead, since by
the time a row is clicked the pointer is on the menu.

The second half of that: **a repeat of the same paste at the same point steps by `PASTE_OFFSET`.**
⌘D cascades for free because it offsets from the selection it just made; a paste is placed
absolutely, so ⌘V twice without moving the pointer put the second stack exactly over the first,
with the new selection covering it. The counter is keyed on the text and the point, lives in the
store's closure, and is neither in the document nor in history.

**Copy is live under the lock; cut and paste are not.** The asymmetry is deliberate and is the
one place the trio splits: copying takes nothing away and changes nothing, and a frozen canvas is
exactly the one somebody wants to lift a piece out of to use elsewhere. `store/lock.test.ts`
classifies all three and `ui/panels/lock.test.tsx` pins the visible half on both surfaces.

**Two clipboards, and neither can stand in for the other.** The system one is primary and is what
crosses to another tab. `store.clipboard` is this app's own memory of the last copy, and it is
what a *menu row* pastes from — a row cannot read the system clipboard to decide whether to grey
itself out without asking for the permission that would prompt on opening a menu. The click
itself still tries the system clipboard first (`pasteFromClipboard`), so a fragment copied in
another tab pastes even though the row could not know it was there.

Paste is on the **node** menu rather than a pane menu because there is no pane menu: a right-click
on empty canvas opens the add-node palette, and paste lands at the click, which is where that
palette would have put a node.

**The trio is canvas-only, deliberately.** The listeners are `Editor`'s, by `appShortcuts.ts`'s
own rule — copy and cut act on the canvas selection and paste needs a viewport point — so they are
dead on the dashboard, which unmounts `Editor`. That is the right answer there (no selection on
screen, nowhere visible to paste) rather than the bug `F`, `I` and `/` once had for the same
structural reason.

**Not checked in a real browser yet.** The event path is exercised in jsdom with fabricated
events, which is honest about the handlers and says nothing about how a real ⌘X behaves inside a
card's text, or about what Safari puts on the pasteboard.

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

### Hitting a socket

**A socket is an 11px disc and a 20px target, and the two numbers answer different halves of
the gesture.** `connectionRadius: 26` on `<ReactFlow>` decides where an in-flight link *snaps
to* — generous, and it always was. But *starting* a link needs a pointerdown on the handle
element itself, and nothing about the drop radius helps with that: the target was the disc, 8px
for a scalar dot, which is what people reported as fiddly. `.socket.react-flow__handle::before`
in `editor.css` is an invisible circle over each handle. It paints nothing and listens to
nothing — it widens what the handle catches, so React Flow's own pointer handling, the
`connectionindicator` class included, is untouched, and a handle that cannot accept the
in-flight link takes its enlarged area down with it when React Flow sets `pointer-events: none`.
Hover reaches through it deliberately: the ring lighting up a few pixels out is the only thing
on screen saying the target is bigger than the dot.

**A circle, because one of the shapes is rotated.** `[data-shape='diamond']` is a square under
`transform: rotate(45deg)`, and a rectangular hit box inherits that — arriving as a lozenge
whose corners reach ~15px into the row above and the row below. A circle centred on the disc is
rotation-invariant, so one rule covers all six shapes. Centred with margins rather than a
`translate` for the same reason: a transform there would compose with the rotation instead of
replacing it.

**20px is the port pitch, and that is the whole constraint.** `.port-row`'s `min-height` is
20px, so each target fills its own row and two neighbours abut without overlapping. Overlap is
the failure that matters and it is silent: stacked handles mean whichever one the DOM paints last
takes every pointer event, and aiming at a particular input stops working — the same thing the
fanned folded band above exists to avoid. Scanning `elementFromPoint` around a socket in Chrome
shows the two regions meeting on the pixel, with no gap either.

**Sideways it grows inwards only, and that is the card's clip rather than a choice.**
`.coda-node` clips with `overflow: hidden` — which is why an expanded card's discs render as
half circles, above — and hit-testing follows that clip exactly as the paint does, so the half
of the circle hanging over the canvas is simply cut off. Nothing is taken from the
`reconnectRadius: 14` anchors that pull a wire off its socket, which sit outside the card; those
were measured to be above the handles in the paint order anyway.

**The other half of the input target was the state bar.** `.coda-node::before` is 3px wide with
`z-index: 1`, and an input handle sits on it — so hit-testing gave the bar the left half of every
input disc, leaving 5px of catchable width. `pointer-events: none` on the bar separates the paint
from the hit: the strip still draws over the socket, which keeps it continuous down the card, and
a point on it with no socket under lands on the card itself, so dragging a card by its left edge
is unchanged.

**Measured in Chrome at zoom 1, per handle**: 5×11px catchable before, 12×20 for an input and
9×19 for an output after — 50px² of target to 233 and 148. And a pointer 9px above and 4px inside
an output socket's centre, dead space before, now starts a link: `.react-flow__connection-path`
in flight, anchored at the real socket rather than at the grab point.

**Folded, the enlargement is off** (`content: none`). The pitch there is 8px and the discs
already overlap by 3, so a 20px target would put every socket on the card under whichever one
paints last — losing the thing the fan was built to keep. A folded header keeps the hit area it
has always had, which is a cost of that state rather than a new one, alongside the port labels.

**A band sized by an arity param goes into tabs** (`NodeDefinition.paramGroups`, a param's
`group`). The fold below answers "this card is configured, get the rows out of the way"; this
answers a different question — a band that is *linear in a number the user sets*.
`compare.connectivity` is four settings per dataset, so four datasets is sixteen rows on a card
that has to sit beside the graph it is part of.

The bucketing is `bucketParams` in [paramGroups.ts](../src/ui/params/paramGroups.ts), shared with
the styling panel, which takes the same buckets and collapses composites into rows on top of them.
The card wants the buckets raw — it has no composite row to draw and has its own field markup —
but *which tab a param is in* is one answer in one place, because two implementations of it
disagree the moment one learns about a new kind of group.

Three things decided in the building. **A strip appears only past two tabs**, which is what keeps
this off cards nobody asked for: `out.viewer3d` draws no generic rows and `out.network` draws one
in one group, so neither grows one, while `out.scatter` does and there the shorter band goes to
the plot — the fold's own trade. **The shared tab is declared first**, because the first tab is
what a fresh card opens on and `datasetCount` is in it: behind `Dataset 3` the control that
creates the other tabs would be hidden by a tab it creates. **The selection is an id resolved
against the live buckets, not an index**, since turning the arity down takes tabs with it and a
card holding a dead id draws a strip with nothing selected and no rows under it. The per-dataset
group ids come from `repeatGroups`, beside the param and port suffixes in `repeatParams.ts`, for
that module's usual reason — a param naming a tab its node spells differently lands in the
trailing "Other" with nothing on screen to explain it.

**Param rows fold away** (`GraphNode.paramsCollapsed`, the `☰` in the card header). A card is
configured once and then read for the rest of the session, so the rows that set it up go on
spending its height on a decision already made — five of them on a bar chart, above the chart.

**Every card that draws a band, not only the viewers.** On a viewer the freed height goes to the
drawing, which is the case this was built for; elsewhere the card simply gets shorter, which is
worth having on its own — a settled pipeline is a row of decisions already made, and reading the
graph then means reading the titles and the wires.

**The button lives in the header, and that is what makes the fold safe on a card with nothing
under the rows.** It survives the band it hides, so there is always something to press — the same
rule the minimap's rail button and the overlay's Style button follow, and the reason the
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
  by Tab / ⇧A / the round **+** button in the canvas's bottom-right corner / the
  `Add ▶ Browse All Nodes…` command.
- `CommandPalette` — compact keyboard list, for people who know the name. Opened by Space
  (everything), by canvas double-click / pane right-click (prefilled `Add:`), and by
  dragging a link into empty canvas (filtered to compatible types, and it wires the pick up).

**Only one of the two has a button, and that is the split.** Both had one in the toolbar — a
`+ Add Tab` and a `Commands Space` — which spent two of the toolbar's widest slots saying what
the status bar's hint strip already says, and offered a beginner a choice between two doors into
the same room. The browser is the one worth pointing at, so it became the round **+** on the
canvas; the palette keeps Space, which is where it was always going to be reached from. The
status bar still advertises `Space commands`.

**The + asks for `canvasAnchor`, not the pointer.** Every other route in is a gesture *at* a
point — Tab and ⇧A use the pointer, a double-click uses the click, a dropped link uses where it
was dropped — and the card lands there. A button is not: the pointer is on the button. That is
the bug `anchorPoint` was written for when the button was in the toolbar (it falls back to the
canvas's upper-middle when the pointer is outside the pane), and moving the button *into* the
pane is the same bug with the inside-the-bounds test now passing — the card would land in the
bottom-right corner, half under the thing that made it. So `canvasAnchor` is split out and the
button asks for it directly.

`NodeThumbnail` derives everything from the `NodeDefinition` — header tint from category,
dots from real ports. The centre glyph is **one drawing per node type**, from `ui/glyphs.ts`;
see [glyphs](#the-glyph-table) below for the grammar and for why the table is data rather than
JSX. Never make a thumbnail *require* per-node artwork: the category fallback is what keeps a
future node from shipping a blank preview, and a test renders one for every registered node to
enforce it.

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

### The glyph table

One drawing per node type, in `src/ui/glyphs.ts`. **A base shape names the material and the
drawing on top names the operation** — Filter, Sort and Sample are all a table with something
happening inside it; Mirror, Transform and Clean Skeletons are all an arbour — which is what
makes a family legible before the label is read. Eleven base shapes cover 101 nodes. Colour is
not part of it: every shape inherits `currentColor`, because the category tint is already spent
on the header strip and the backend pip, and a second colour channel here would compete with
the socket palette's three-hue budget.

Four marks are shared across families and each is load-bearing. **The funnel** is filtering, on
`core.filterTable` and on `net.filter`; reusing it is what says the two nodes are the same verb
on different material. **A dashed outline** is a selection the user made, never an edge. **The
four-point spark** is "cleaned", on both Clean nodes. **Weight says role** in a node-link
drawing: the larger or filled disc is the node the question is about.

**It is data, not JSX, and that is about the third surface.** Three things draw these: the
browser thumbnail and the start page's tile art (React, via `glyphElements`), and `nodes.html`
(plain strings, via `glyphMarkup`) — a separate vite entry with no React in it, which is why it
carried a hand-kept transcription of the six category glyphs instead. Fine at six; 101 chances
to drift once every node had one of its own. So the shapes are primitives and each surface has
its own six-line renderer, which is the arrangement `markGeometry.ts` already arrived at for
GLSL. The page pays 8.6 kB gzipped for the table, measured, in a chunk it shares with the app —
that is its own content, since it draws 101 tiles.

Three failure modes, all silent:

- **A mistyped key still compiles and still lints.** It hands that node the category fallback,
  which looks like a node nobody drew rather than like a bug. `glyphs.test.ts` asserts every key
  is a registered type, and that the fallback is currently reachable but unused.
- **Scaling a silhouette scales its stroke.** The twelve published connectomes reuse the card's
  specimen art, authored in a `0 0 52 46` box, so `specimenShapes` wraps it in a group that
  scales it *and* puts the weight back — 1.6 would land at 0.74 and every dataset tile would
  draw faint, which reads as a paint bug rather than as arithmetic. Both numbers are derived
  from `GLYPH_STROKE_WIDTH`, never transcribed.
- **The two renderers can disagree about an attribute name.** `strokeWidth` against
  `stroke-width`: the app draws it correctly and `nodes.html` draws it at the wrong weight, and
  nobody sees that without opening both. `glyphMarkup` hyphenates in one place and the test
  pins it.

`dataset.fib19` is the only entry that draws a mark on top of a dataset silhouette — a crop
edge, because it is a partial reconstruction of the structure Optic Lobe covers whole and the
two are the same backend, so the header pip cannot separate them. An **addition**, not a
replacement, which is what keeps the "a dataset added tomorrow is never blank" rule intact. Do
not turn it into per-dataset artwork.

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
`core.filterTable` isolated publishes `T.table()` and only becomes `neurons` once something
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
