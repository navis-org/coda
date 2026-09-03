# The shell around the canvas

Panels, fullscreen, the run indicator, the `?` menu, the keyboard-shortcut table and the
start page.

Moved verbatim out of `CLAUDE.md`.


## Two shortcut listeners, split by what a key is about

`shortcuts.ts` is the one *description* of every binding — that has not changed, and neither has
the reason for it. What changed is that there are now two listeners, and which one owns a key is
decided by what the key needs:

- **`Editor.tsx`** — everything that needs the canvas, a selection or React Flow's own key
  handling: mute, collapse, pin, group, duplicate, delete, fit, run, undo, the palette, the browser.
- **`useAppShortcuts`** (`ui/appShortcuts.ts`, mounted by `App`) — `f` fullscreen, `i` inspector,
  `/` assistant, `d` dashboard. The window and two panels `App` renders, plus which view is up.

The split was forced by the dashboard, which replaces the canvas rather than covering it: `Editor`
is not mounted while the grid is up, so a key bound there silently stops working in half the app.
`F` doing nothing on the dashboard was the reported bug; `I` and `/` were the same bug nobody had
tried yet. `D` had been written twice to work around it, which is the duplication `shortcuts.ts`
exists to prevent.

`TOUR_DECLINES` and the typing-target test live in `appShortcuts.ts` and are imported by
`Editor.tsx`, rather than being copied — a key added to either listener is declined by name in one
place, and the next field kind that has to be exempt is exempt in both.

## Collapsible panels

The inspector and the minimap are both **closed by default** and remembered in `localStorage`
(`persistence.ts`, `coda.panels.v1`). The canvas is the thing; an inspector that opens by default
takes 320px before anything is even selected, which is when it has nothing to show.

Read the state as `s.panels.inspector`, never `s.panels` — invariant 7. `togglePanel` mints a
fresh object, so a selector returning the whole thing changes identity on every unrelated tick.

**Closed means not rendered, not zero-width.** A collapsed-but-present panel still catches clicks
along the right edge of the canvas, which reads as a dead strip.

Each panel has an affordance where you would look for it: the inspector has a toolbar toggle
(the lens icon; and `I`, unqualified — unlike `m`/`h` it is worth pressing with nothing selected)
plus a chevron in its own header; the minimap has `MinimapControl` in the **canvas controls rail**,
with the view buttons.

**The map and its toggle are both bottom-left now, and the toggle moved first.** It began in the
bottom-right corner beside the map, rendered outside `<ReactFlow>` so it kept that corner whether
or not the map was mounted, and stepping up over the map's top edge when open — a toggle that
disappears when used cannot be undone, so it had to survive the thing it shows. In the rail it
still does, and it costs neither a second copy of the map's height in CSS nor a lone icon in the
corner opposite every other canvas control. Two consequences: it reads as **view** rather than
layout, so it sits directly under Fit Selected and above the layout group; and it is the **one
button in the rail that stays live under the lock**, because opening a map moves nothing and
restructures nothing — the map it opens is `pannable`/`zoomable` only while the canvas is
unlocked, which is where the lock means something. `LockControl`'s "the whole rail dims except
this one" is now "except these two".

**The map then followed it, and the clearance is one number.** Both are `<Panel position=
"bottom-left">`, and React Flow gives every panel `margin: 15px` — so left to itself the map
would open *on top of* the rail. `.react-flow__minimap.left` takes a `margin-left` of the panel
margin plus the rail's width plus an 8px gap, which puts the map at x=49 against the rail's
15..41 (measured in a browser, since jsdom lays nothing out). `--rail-width` is declared on
**`.react-flow`**, not on `.react-flow__controls`: the rail and the map are *siblings*, so a
property on the rail would silently fall through to `var()`'s fallback and read as shared when it
is not. Both panels are `.bottom`, so the two are bottom-aligned with no arithmetic about the
map's height. What this buys is that the right of the canvas is clear — which is the side the
pinned viewer dock opens on.

**The minimap's size goes through its `style` prop, not CSS.** React Flow reads
`style.width`/`style.height` to compute the map's viewBox, so sizing it in the stylesheet leaves
it drawing a 200×150 projection into whatever box CSS produced: it renders, and is silently
wrong. `MINIMAP_SIZE` in `Editor.tsx` is the single constant.

**The map draws from React Flow's node lookup, and skips any card it has no size for** — the
size on the _user_ node, which in a controlled flow is whatever the app put there. That is why
`Editor.tsx` keeps `measuredSizes` and hands React Flow's own measurements back to it; without
it the map showed only the cards with a `node.size` or a `defaultSize` and silently omitted
everything that cannot be resized. The mechanism is written up under *Measurements, and who
keeps them* in [canvas.md](canvas.md).

`installStorageStub()` in `test/jsdomStubs.ts` is what makes any of the persistence testable —
Node 26 shadows jsdom's `localStorage`, so by default every persistence path silently degrades
and has no coverage. Opt in per suite: with storage present, autosaves leak between test files.
It stubs `sessionStorage` too, because the autosave needs both to mean anything: the graph goes
in one and the tab identity that decides *which* graph in the other, so stubbing only the first
exercises the degraded single-slot path while looking like it covers the feature.

### The toolbar's run group, and the two buttons that left it

Reading order after the icon cluster is **Run · Auto-run · Clear**, then the bell. Run leads: it
is the only primary button on the bar and the one thing on it reached for repeatedly, so it gets
the position, and its two neighbours are both statements about it — Auto-run whether it happens on
its own, Clear the same action from the other end (Run brings the stale nodes up to date, Clear
makes every node stale again). Clear read *before* Run once, which put a destructive verb in front
of the button people are aiming for; both neighbours are ghost or checkbox against Run's primary,
so none of the three reads as an equal choice to it.

**The brand is the name alone.** `connectome data analysis` sat beside it on a shared baseline,
which is what `.toolbar__brandText` existed for — the mark has to centre on a one-line name rather
than on a block that goes two lines whenever the descriptor wraps. One line needs no wrapper, so
the rule and `.toolbar__brand span` went with the words. The descriptor still leads `index.html`,
`overview.html` and `tutorial.html`, which is where somebody who has not seen the app is reading;
in the toolbar it was a subtitle shown only to people already inside.

**Two buttons left the toolbar, and only one of them moved.** `+ Add Tab` became the round **+**
in the canvas's bottom-right corner — which now unfolds into the six node categories rather than
opening the browser outright (see [canvas.md](canvas.md) for that menu, and for why the button
asks for the canvas anchor rather than the pointer); `Commands Space` was deleted outright,
keeping the key. Both were
wide word-plus-shortcut buttons for things the status bar's hint strip already advertises, and
`Commands` in particular offered a beginner a choice between two doors into the same room.

Two consequences worth knowing. `Toolbar` now takes **no props at all** — it had `onOpenPalette`
and `onOpenBrowser`, relayed through the store because the toolbar sits outside the React Flow
provider and cannot convert screen coordinates; the canvas's own button converts them itself, so
the relay went with the button. `requestPalette` stays on the store, since the Save menu and the
tour still open the palette. And the button now **goes away with the canvas** while the dashboard
is up, which the toolbar version did not — where it was a *dead* control, since `NodeBrowser` and
the Tab binding both live in `Editor`.

### The toolbar's icon cluster

Four buttons carry an icon and no words — **Share** (a box with an arrow leaving it),
**Connections** (a branch), **Assistant** (a robot head) and **Inspector** (a lens). They are in
`src/ui/Icons.tsx`, drawn on the usual 24-unit grid with a 2-unit stroke and painting in
`currentColor`, so each takes the ink of the button it sits in and follows its hover and pressed
states. Same rule as `CodaMark`, and for the same reason: an accent-coloured icon here would be
the same blue as a Table socket and read as a typed port rather than as chrome.

**Every one keeps its name in `aria-label` and `title`.** An icon-only control with neither is a
control only its author can use — and it is the one property nothing about the rendering would
report, since the icon draws either way. `panels.test.tsx` asserts all four have a name, an
`<svg>` and no text.

**`aria-pressed` now carries what the glyph used to.** The inspector toggle drew `▐` against `▕`,
which said open-or-closed in the mark itself; an icon that does not change with the state says it
through the pressed style and the tooltip instead. Same trade `.coda-node__fold` records.

**Four messages elsewhere had to learn the icon.** "Add one in Connections, in the toolbar" pointed
at a button that no longer has the word "Connections" on it — so `client.ts`, `ai/registry.ts`, the
assistant drawer and the start page's dataset rail all name **the branch icon** now. The start
page's line was additionally stale from before: it still said *Sources*, which that button has not
been called for some time. This is the standing cost of an icon-only control, and the thing to
check when adding a fifth.

**Share leads the cluster and is the odd one out** — a verb, where the other three are toggles or a
dialog. It sat under `Save ▸` first; the menu entry is gone rather than duplicated, because two
routes to one dialog is two places for the wording to drift.

## More than one workflow open in one tab

**Prototype.** A collapsible box in the canvas's top-left corner (`ui/panels/WorkflowTabs.tsx`)
lists what is open and switches between them. Everything below is built and tested; what is
deliberately *not* built is at the end.

### Why it was cheap, which is also the design

The store already had the switch. `loadGraph` replaces the graph, resets `past`/`future`/
`selection`/`lastRun`, drops the expanded node and the pin, reads `dashboardOpen` back off the
document and re-derives every badge. A tab switch is that, with the outgoing half kept instead of
thrown away — so `DocStash` is exactly the list `loadGraph` resets, and that is not a coincidence.

The blast radius is what makes it a prototype rather than a rewrite: **1,204 `useGraphStore`
references across 125 files, and none of them changed.** The document was already a value the
store swapped; multi-document is a change to the store's interior, not to its interface.

### Where a document lives

`GraphState` holds one row per open workflow — `tabs: WorkflowTab[]`, an id and a name and
nothing else — plus `activeTabId`. The documents themselves are a `Map<string, DocRecord>` in the
store's closure, beside the Scheduler and for its reason: they own caches of potentially large
tables, and copying references to them through immutable state updates on every tick buys nothing.

`tabs` is rebuilt by `syncTabs` from `afterGraphChange`, so it fires on **every keystroke** — and
therefore compares before it writes. A fresh array each time would re-render the switcher, and
everything else selecting it, for an edit no row displays.

### A Scheduler per document, not one shared

The tempting cheap version is one Scheduler with `pruneCache` widened to the union of open graphs.
Freshness is derived (`cached.key === desiredKey`), so switching back and calling `refreshStates`
recovers every badge with no run and no fetch — which is what makes a switch cost nothing either
way, and is worth knowing on its own.

It is wrong for one reason: **`newId` is unique within a session and `deserializeGraph` does not
remap**, so two documents opened from the same file carry the *same node ids* — and the same
provenance keys, since the graphs are byte-identical. One cache keyed by node id would report the
second copy as already run, and the reader would be looking at another document's results with
nothing on screen to say so. `documents.test.ts` opens one file twice and asserts exactly that.

An instance each also makes closing a document a single `invalidateAll`, which is the only thing
that returns its results to the heap.

### The three things a switch does beyond swapping state

- **It cancels.** Only the document on screen runs. The alternative needs a `busy` per document, a
  status bar reporting somebody else's run, and an `onIteration` writing files for a canvas nobody
  is looking at. `cancelActiveWork` bumps `runToken` rather than awaiting the abort, because
  `runFull`'s `finally` lands a tick later and would otherwise clear `busy` out from under the
  document that has arrived since — the same guard two overlapping runs on one document already use.
- **It moves the autosave**, which holds whichever document is on screen. Without that, a reload
  comes back to the workflow you switched *away* from.
- **It restores the viewport**, through `viewportRequest` — a counter for `fitRequest`'s reason,
  and a separate one from it because the two answers are exclusive: a document seen for the first
  time is framed, one being returned to is restored.

Two rules about that viewport, both of which read as a bug when broken. It is captured on React
Flow's **`onMove`, not `onMoveEnd`**: `onMoveEnd` ends a *gesture*, so a document that was only
ever framed by `fitView` — every document nobody has panned — records nothing, and switching to it
leaves the canvas on the outgoing document's transform. And it lives on the `DocRecord` rather than
in `DocStash`, because it is written continuously by a pan: a stash captured at the moment of the
switch is fine for a selection and wrong for a transform two gestures old. Verified in a real
browser by comparing `.react-flow__viewport`'s `transform` across a switch, since jsdom performs
no layout.

### Every open route mints a document, and the replace-confirm is gone

`openDocument` is `loadGraph` with `beginDocument` in front of it, and it is what the New menu, the
file picker, the palette, the Zoo, the wizard, a share link, the start page's cards and the browser
shelf all call now. `loadGraph` itself is unchanged and still replaces in place — the tour restores
through it.

**A blank, untouched document is reused rather than left behind**, or a fresh visit strands an
empty tab beside the workflow the user actually asked for. "Untouched" is the *history*, not the
node count: a graph somebody built and then emptied has a past they can undo into.

So the replace-confirm no longer has anything to be about — nothing is replaced and no undo
history goes — and it is **deleted** rather than neutered: `replaceConfirm.ts`, the
`confirm-replace` arm of `ShareLoad`, `SharedLinkGate`'s dialog for it, and the inline prompts in
the Zoo, the wizard and the start page's cards. Keeping the hook with a pass-through `ask` was
tried and is the worse answer, because what the hook *was* is a guard (`hasWork`) plus a sentence:
the guard is the half that stopped being true, so a fourth destructive route would have to write
it from scratch anyway and would meanwhile inherit four surfaces rendering a flow nothing can
produce. Git history is the record of how the question was worded.

The share link's *first* question is untouched and still asked — "fetch from this host?" is about
a bare `https://` hiding where it goes, which is unaffected by where the result lands.

**`newGraph` and `newWorkflow` are two operations, not one with a mode.** `newGraph` empties the
current document in place, which is what it has always meant and what twenty-three test suites
reset with; `newWorkflow` is `openDocument(emptyGraph())` and is what the New menu, the palette
and the switcher's `+` call. Folding the second into the first made the first depend on hidden
state and silently changed every one of those suites — they accumulated a document and a live
Scheduler per case, with nothing failing.

### The open set survives a reload

Built, and split across two stores along a line drawn by *when the answer is needed*: the active
document stays in the `localStorage` slot and is read synchronously in the store's initialiser, so
the first paint is unchanged; every other open document lives in IndexedDB and arrives an await
later. The whole design, the measurements that settled it and the three failures that live in the
join are in [persistence.md](persistence.md).

Two consequences that belong here rather than there. A reload comes back to **the document that
was on screen**, not to the first in the list, because `loadActiveDocId` is read in the same tick
as the graph. And the restore is **additive and never activates**, so a share link followed before
it lands is safe — the recovered workflows slot in around it.

### What is deliberately not built

- **Closing asks nothing**, and an unsaved document really is lost. Now that the open set is
  persisted, the honest version of this is an undo rather than a confirm — a closed workflow could
  be recoverable for the rest of the session — and neither is built.
- **There is no switcher in the dashboard.** `DashboardView` replaces `Editor` in the same grid
  area, so React Flow — and the canvas panel this lives in — unmounts with it. `← Canvas` is the
  way back.
- **No keyboard shortcut.** `src/ui/shortcuts.ts` is the one table and nothing has been added to it.

## Pinning a viewer beside the graph

`⇥` on a viewer card, `P`, or the palette's *Pin Selected Output to the Side*. The result is
`ViewerDock` — the same surface the expand overlay draws, in a column down the right of the shell
instead of a modal over it, so the graph stays live and editable beside a scene that stays up.
The ask it answers: a Neuroglancer node open at half the window while the wires feeding it are
rewired one at a time.

**It is a grid column, not a floating panel, and that is why it was cheap.** `.app` was already
`'canvas inspector'` over `1fr auto`; the dock is a third area between them. The canvas column is
genuinely narrower rather than partly covered, so React Flow re-measures on its own, the minimap
keeps its corner, and nothing needed pushing out of the way. Two details in that column are
load-bearing:

- **`minmax(0, 1fr)` for the canvas, not `1fr`.** A bare `1fr` is `minmax(auto, 1fr)`, whose
  automatic minimum is the *content's* — React Flow's pane reports the whole graph's extent, so a
  wide graph refuses to let the column shrink and pushes the dock off the screen instead.
- **A px floor under the fraction, and the store has to know about it.** The stored width is a
  share of the window (see below), and that clamp is about keeping the *canvas* usable. Keeping
  the *dock* usable is a number in pixels, because a viewer plus its 268px styling sidebar does
  not get more possible on a smaller display; below 360px the panel was a legend and a scrollbar.
  The CSS floor alone was not enough: with only `DOCK_MIN_FRACTION` in the store, dragging to the
  floor on a 1600px window stored 0.2 while the column rendered 360px, so `aria-valuenow`
  announced 20% for a dock that was 22.5%. `clampDockFraction` takes the width it will be
  resolved against, so what is stored is what gets laid out — every caller that has one passes it.
  The sidebar takes a 45% cap for the other half of this, so a narrow dock degrades into two
  halves rather than into a sidebar with a strip beside it. Measured in Chrome at 1600×900: the
  floor leaves 159px of sidebar and 195px of view.

**The shared identity is a class, not a convention.** `ViewerSurface` renders a fragment, so
"a full-size viewer surface" existed in TypeScript with no representative in the DOM — and every
rule written with `.overlay` as an *ancestor* needed a hand-written `.viewer-dock` twin, failing
silently when one was forgotten (the rule simply does not apply, and a dataset blurb renders at
the wrong measure). Both frames wear `.viewer-surface` instead, and the three such rules key off
that; a third surface joins by wearing it.

**One node is never live in two full-size surfaces, and the exclusion is written asymmetrically.**
The card already stands down while the overlay owns its node — three WebGL contexts and 3 × 170 kB
measured for one 21-neuron scene — and the dock is a *third* mount site, so `showPreview` gained
`pinnedNodeId !== id` too. What the store refuses is one id in both `pinnedNodeId` and
`expandedNodeId`, which would be two live instances of one neuroglancer embed, each an application
fetching EM. Two *different* nodes it allows, because a glance at a table has no business costing
somebody the scene they pinned: `expandNode` releases the pin only for the same node, while
`pinNode` always closes the overlay — leaving a modal over the thing somebody just asked to see
beside the graph is not an answer to the request. Verified in Chrome: with the 3D viewer pinned
there is exactly one `<canvas>` on the page, and it is in the dock.

**No ⛶ and no ⤢ on the dock.** Both mean handing *this* node to the overlay, which is the one case
the exclusion refuses — so the button somebody pressed to see it bigger would be the button that
loses the pin when they close it again. The grip answers the same request without a remount, and a
remount is what a neuroglancer embed pays for in a camera (`sceneMemo` recovers it same-origin and
cannot cross-origin).

**The width is a fraction; which node is pinned is not stored at all.** A stored 700px is right on
the display it was set on and wrong on the next one, so `coda.dock.v1` holds a share of the window
— which is also what a percentage in `grid-template-columns` resolves against, so what is stored is
what gets laid out. The node id is deliberately session-only: ids mean nothing in the next
document, and a remembered pin would open the dock on a node that does not exist. Three paths drop
it — unpinning, deleting the node, loading a graph.

**The grip measures from the dock's own right edge, not the window's.** The inspector may be open
to the right of it, and 320px would otherwise be added silently to every width the drag computes.
That edge does not move during the gesture, so it is read once at pointerdown. It carries
`role="separator"` and arrow keys, because a resize handle only a drag can reach is one a keyboard
cannot.

**And the drag paints the column directly, committing to the store once on release.** Routing
every pointer sample through `setDockFraction` was the obvious version and the expensive one: it
writes `localStorage` synchronously, and the tick that follows re-renders the whole shell —
`ViewerSurface` and the viewer inside it included, which is the one surface whose entire design
goal is to stay up untouched. The width is a CSS custom property, so the gesture writes it where
it is read and leaves React out. Measured over 25 pointer samples in Chrome: **zero** storage
writes during the drag and one on release, against one per sample before.

jsdom performs no layout, so `dock.test.tsx` covers the state machine and the number handed to the
column, and the geometry above was driven in real Chrome over CDP.

## Fullscreen, and installing

Two halves answering two different moments, and they compose rather than overlap: **⛶ / `F`**
is one session's worth of "give me the canvas now", and the **web manifest** is "this is how I
always use it". `src/ui/fullscreen.ts` is the whole of the first; `public/manifest.webmanifest`
plus three lines of `index.html` is the second.

**The app's own chrome stays.** What fullscreen reclaims is the browser's ~90px of tabs and
address bar, not the toolbar and status bar — Run, Auto-run and the stale count are precisely
what you want in view while a graph is running, and a mode that hid them would be a different
feature (a presentation mode) wearing this one's name.

**The root element is what goes fullscreen, and that is what keeps the layout identical.** The
fullscreen UA stylesheet's `position: fixed` rule is `:fullscreen:not(:root)`, so the root is
exempt: the page simply stops having a browser around it. Any wrapper `<div>` would be pulled
out of flow and have to be sized back by hand. The one thing the root does need stating is a
background — the UA paints a black `::backdrop` behind whatever is fullscreen, and `html`
carries no background here, only `body` does. Hence the `html:fullscreen` rule in `theme.css`.

**`document.fullscreenElement` is the only honest source of truth, and the button reads it
back.** Escape, F11 and the browser's own window chrome all leave fullscreen without passing
through anything in this app, so a boolean written where the toggle was clicked is wrong the
first time somebody uses any of them — and a ⛶ latched on by its own click reads as the app
having lost track of the window, which is exactly what it has done. `useIsFullscreen`
subscribes to `fullscreenchange` and returns a **boolean**, not the element, so the snapshot
is a primitive (invariant 7).

**Entering is a request, not a command.** Browsers refuse outside a user gesture and refuse
again under some kiosk and iframe policies, with no way to ask in advance — so
`toggleFullscreen` returns whether we ended up fullscreen rather than throwing, and the two
callers that can distinguish a refusal from an ordinary exit (they know which direction they
were going) are the ones that put a notice up. It is also why fullscreen is **not persisted**:
a preference restored at load would be refused, since a page load is not a gesture.

**`toggleFullscreen` compares against its own target, never against "is anything
fullscreen".** That is what lets the two halves nest: the overlay's ⛶ pressed inside an
already-fullscreen window shows the _panel_ full size instead of dropping the window out, and
the Fullscreen API's element stack means leaving the panel lands back on the fullscreen app.
The overlay's `close` and its Escape handler were both widened for the same reason — they used
to ask "is anything fullscreen?", which was only ever equivalent because nothing else could be.
Closing a viewer has no business dropping the whole window out of fullscreen.

**And that Escape handler stands aside for an open popover.** It is bound on the *capture*
phase, which is what lets it beat the canvas's shortcuts — and which also meant it beat every
popover's own dismissal: pressing Escape to shut the network viewer's context menu closed the
whole overlay from under it. It now returns early while a `.context-menu` is in the document,
so the key reaches that menu's own handler on the way back up and the *next* press closes the
overlay. By class rather than by a registry, because `.context-menu` is what all four of them
are, and a dialog knowing which popovers exist is the coupling being avoided.

### The manifest

**`start_url` and `scope` are relative, and that is the one thing here that fails silently.**
They resolve against the manifest's own URL, so `"."` is `/coda/` on GitHub Pages and `/` on a
dev server. An absolute `"/"` works perfectly in dev and scopes the installed app to the domain
root in production, where somebody else's site lives. `vite` rewrites the `<link rel="manifest">`
href against `base` (`'./'`) the same way it does the favicon, so the href in `index.html` stays
in the usual `/manifest.webmanifest` form. `fullscreen.test.tsx` asserts the relative form,
because nothing else would catch it before a deploy.

**There is deliberately no service worker.** Chromium's installability criteria historically
wanted one with a fetch handler, and Chrome is explicitly [walking that
back](https://developer.chrome.com/blog/update-install-criteria) — sites answered it with empty
fetch handlers, which is what a service worker here would be too. This app has no offline story
to write: every dataset it reads comes over the network. A cache that outlived a deploy is the
classic way to strand somebody on a stale bundle, and that is a real cost against a hypothetical
install prompt. Both browsers that matter install from a menu item regardless of one.

**The icons are `purpose: "any"`, not maskable.** Android's maskable safe zone is the middle
80%, and the coda sign's cross arms reach ±65% of the half-width — declaring maskable would have
the platform crop the tips off the mark. `icon-192.png` and `icon-512.png` are rasterised from
`icon.svg` with `rsvg-convert -w N -h N`; the SVG is listed first, at `sizes: "any"`, for the
platforms that take it.

**No visual verification exists.** jsdom implements no part of the Fullscreen API, so what the
suite checks is which element is handed over and how the button reads the answer back
(`installFullscreenStub` grants fullscreen the way a browser does — by setting
`document.fullscreenElement` and firing the event, never from inside `requestFullscreen`). The
transition itself, and the installed window, have not been driven by anyone here. Same standing
as the WebGL viewers.

## Run indicator

A stroked rounded rect traced round the node perimeter (`ui/nodes/NodeRunRing.tsx`), replacing
a 2px linear bar that showed the same number inside one card.

`pathLength="1"` on the rect makes `stroke-dasharray` a plain fraction, and the rect's
geometry is set in **CSS** (an SVG 2 geometry property) — together those mean the ring tracks
a node whose height changes with no measurement and no ResizeObserver.

**It is a sibling of `.coda-node`, not a child.** The ring is drawn 3–6px _outside_ the card,
and the card clips with `overflow: hidden`; rendering it inside would work only by accident
(handles escape that clip today solely because `.coda-node` is unpositioned, so their
containing block is React Flow's wrapper). As a sibling it is unambiguously outside the clip
chain. `runRing.placement.test.tsx` asserts that, because moving it back inside throws
nothing and fails no type check — the outline just quietly loses everything past the edge.

**It paints _behind_ the sockets, via `z-index: 0` and DOM order.** A right-hand socket
reaches 6.5px past the card edge (`right: -1px` plus React Flow's `translate(50%)` on an 11px
disc), so it genuinely intersects the ring. Passing behind the opaque discs keeps the outline
tight to the card; raising the z-index draws it straight through every socket.

**Size the ring explicitly; never `width: auto`.** `<svg>` is a _replaced_ element, so
`width: auto` takes its intrinsic size (300×150 with no viewBox) and drops `right`/`bottom` as
over-constrained — an `inset: -6px` shorthand drew a fixed 300×150 box hanging off the node's
corner, which read as a bounding box around the outgoing edges. Hence
`width: calc(100% + 2 * var(--ring-out))` with a matching negative `top`/`left`; percentages
resolve against React Flow's wrapper, which is the card's size. jsdom does no layout, so
`runRing.placement.test.tsx` asserts the _declaration_ instead — the only way this class of
bug is catchable here.

**The gold is per-mode and computed.** It sits on the _canvas_, and a bright gold that reads
at 10.2:1 on the dark canvas is 1.5:1 on the light one — under the 3:1 non-text floor, i.e.
invisible. Hence `--status-running-ring`: `#fab219` dark, `#a87400` light (3.4:1). No single
value clears 3:1 in both while still looking gold; the ones that do (`#9c6a00` and darker) are
muddier on dark than the blue they replaced.

Two channels, deliberately: **pulse** says running (a static ring cannot be told from a
stalled node), **length** says how far. Indeterminate work gets a short _travelling_ arc
rather than a pulsing full ring, because a complete outline reads as finished. Under
`prefers-reduced-motion` the animations go and the arc stays — motion is decoration here,
length is information.

A conic-gradient border is the obvious alternative and is wrong: it sweeps by angle about the
centre, so on a wide node the arc races along the short edges. Perimeter distance is what
reads as progress.

**The indicator is only worth anything because the sources report.** Every node used to call
`ctx.progress` exactly once, so a ring would have frozen at 10% for the whole fetch —
`Meshes` most of all. `GeometryRequest.onProgress` now carries a fraction from the source,
which is the only layer that knows how many bodies have landed.

Two traps in that plumbing, both hit:

- **Count completions, not dispatches.** An ordinal handed out when a task starts runs
  backwards with six workers in flight: skeleton progress went `0.6 → 0.4 → 0.8 → 0.2 → 1`.
  Increment in the callback, after the await.
- **Weight the phases.** Reading mesh manifests is a few hundred bytes per body; the fragments
  behind them are megabytes. `meshProgressFraction` gives manifests the first fifth, so the
  bar does not reach the halfway mark in the first second and then appear to hang.

## Telling somebody a run finished

`ui/notify.ts` and the toolbar's bell. The mechanism is small; every interesting part of it is a
constraint the browser imposes rather than a design choice, which is why it is written down.

**Two channels, and only the second one asks for anything.** The tab's own title is rewritten —
`✓ Run finished`, or `⚠ Run failed` — whenever a run past the floor lands on a tab nobody is
watching. That costs no permission, works in every engine including an iPhone's Safari, and is
invisible to anyone who *is* watching because it reverts the moment they come back. On top of it
sits the real OS notification, which is opt-in.

They are complementary rather than redundant, and the redundancy is what makes the feature work
for the case it exists for: a desktop notification auto-dismisses in about twenty seconds unless
the OS is set to keep alerts, so somebody away for an hour comes back to *no notification at
all*. The title is still saying it. That is also the fallback for the three engines that will
never show one — an iOS Safari tab that was not installed to the home screen, an Android Chrome
that serves notifications only through a service worker (there is none here, and the constructor
throws `Illegal constructor` outright rather than failing quietly), and a permission refused.

**Permission can only be asked for from a user gesture**, so the opt-in *is* the prompt: the
bell's click is the only place `requestNotifyPermission` is reachable from. Not on load, and in
particular not when a run finishes — which is exactly when it would be most useful and least
allowed. Same rule fullscreen records, for the same reason, and with the same consequence: the
stored preference cannot simply be restored and acted on.

**`denied` is terminal, and that is why the bell has three states rather than two.** Once
refused, a page can never ask again — only the user can undo it in browser settings, and there
is no event for their having done so. So the *stored* preference is not the truth about whether
notifications will appear; `notifyState()` is, and the pressed state is the conjunction of the
two. That conjunction is `bellState`, exported and tested rather than derived in the component:
it is the rule the whole feature turns on, its interesting row (granted, preference off) is
unreachable from jsdom in a render, and a second surface re-deriving it would get the
`denied`/`unsupported` split wrong with nothing to say so. A toggle that latched on while the browser silently dropped every notification is the
failure this whole feature would otherwise present as. The refused and unsupported states draw a
struck-through bell, disabled, whose tooltip names who has to undo it **and** says the tab title
still changes — a struck-through bell alone reads as "nothing will tell you anything", which is
not true.

**Granting permission shows one immediately, and that is a deliberate exception to everything
above.** It was not there at first, and the cost of leaving it out was measured rather than
guessed: notifications were reported as not working in both Chrome and Firefox, with the tab
title changing correctly, and the cause was macOS **Do Not Disturb**. Under a Focus mode — and
equally when the browser itself is not allowed to post in System Settings → Notifications —
`new Notification()` constructs successfully and posts nothing. There is no API that reports
this, and none that asks whether a notification was seen.

So granting was the one step in the feature with no visible result. The next notification is a
run past the floor away, on a tab you have since left, which means a chain broken anywhere at
all presents as silence fifteen seconds later somewhere else — indistinguishable from the
feature not existing. `showTestNotification` fires while the user is still looking, which is the
only honest test available. It runs on **every** enable rather than only on the first grant,
because a browser that already remembers the grant skips the permission branch entirely, and
that is the path anybody re-testing this takes. Its own tag, so it neither replaces nor is
replaced by a run's.

**Away is two questions, not one.** `visibilityState` alone misses the case people actually hit:
a second monitor. A Coda window fully covered by another — or simply sitting behind the editor
you switched to — is still `visible` by the spec, and only `hasFocus()` says otherwise. The cost
is that anything else taking focus counts as away, devtools most of all; that false positive is
accepted, because it produces a notification you did not need against a missed one for everybody
who works with two windows side by side.

**A duration floor rather than a manual/automatic distinction.** What decides whether somebody
switched away is how long the run took, not which button started it — auto-run makes the same
wait. `NOTIFY_AFTER_MS` is 15s: above every cached re-run and every mock-dataset graph, the ones
that finish while you are still typing, and below any real neuPrint or CAVE query.

Three runs say nothing whatever the tab is doing, and each is a decision rather than a shortcut.
A **cancelled** run is silent, because the user pressed Cancel and knows. A run that **touched no
node** is silent even if it took a while — an auto pass over a graph of expensive nodes defers
all of them and still reports a duration, so announcing it would be announcing that nothing
happened. A **failure** is announced, and differently: coming back in an hour to find the run
died in its first minute is the case this exists to prevent.

Two smaller things that would each be wrong in the obvious version. The body carries
`iterations` when there are any, because `executed` is a *set of node ids* and reads "6 nodes"
for a loop that made four hundred passes — and a loop is what a run long enough to reach the
floor usually is. And the duration is `formatDuration`, the same spelling the status bar uses,
so the notification and the line you read when you get back agree about one number; `formatAge`
would print a prettier `1m` for exactly these longer runs and would then disagree with the
`95.4s` on screen.

**The title we replaced is captured once.** Re-reading `document.title` on a second flash latches
our own text in as the base, and the tab goes on saying "Run finished" for the rest of the
session with nothing left to restore. It is module state rather than a ref, because the flash
outlives the component that raised it: a viewer going fullscreen remounts half the tree, and a
title that reverted because of *that* would revert while the user is still away — the one moment
it exists for.

`useRunNotify` is mounted from `EditorCanvas` beside `useDownloads` and `useForEach`, on their
reasoning: a run finishing is a whole-app event and the tab it lands on may have no card expanded
at all. It triggers on `lastRun` changing identity rather than on `busy` going false, which comes
free with `runFull`'s token guard — a run *superseded* by a newer one never writes `lastRun`, and
it is the newest run's completion that means the wait is over. The ref holding the last announced
summary is **mount-seeded**, the same guard the store's request counters use, so a remount with a
run already in the store does not announce it twice.

## The New menu

Everything that starts something which is not a file, in one menu, ordered by how much the app
decides for you:

| | |
|---|---|
| **Empty** | nothing decided |
| **Workflow Wizard…**, **Browse Workflows…** | a whole pipeline decided |
| **neuPrint ▸**, **CAVE ▸**, **CATMAID ▸** | a dataset decided, the rest yours |

The rules between the three are that statement, and the order within the middle pair is the one
the Zoo has always drawn: the wizard builds locally and instantly, the row under it goes to a
public repository over the network. Pinned in `panels.test.tsx` rather than left to be read off
the JSX.

**Those two rows were a `Workflows` menu of their own for about an hour.** A top-level button
holding two rows, beside a "New" that means the same thing — *where do I begin* — is one menu too
many; and before that they were an `Examples` menu holding the Zoo plus four bundled graphs, which
the Workflow Wizard replaced (see [wizard.md](wizard.md)).

**The datasets are submenus, one per backend, and that is what made the rest possible.** Flat they
were a dozen rows under four headings and the panel needed a scrollbar — the state where a heading
is something you scroll past rather than something you choose. Folded, the menu is six rows and
316px tall (measured in Chrome), which is what lets it take `flyouts`: opting out of the panel's
`overflow-y` is only safe for a menu short enough never to need it, and `overflow-y` on a box makes
`overflow-x` compute to `auto` as well, so a flyout at `left: 100%` would otherwise render inside a
scrollbar or not at all. The two facts are the same change.

**A backend is a real choice**, which is why it gets a row rather than a heading: it decides what a
dataset node can *do* — the `SourceCapabilities` question the wizard's own gating turns on. The
row's blurb lists what is inside it (`MaleCNS · Hemibrain · MANC`), derived from the same table the
flyout is built from, so a family added to that table cannot leave the row claiming something else.

**One submenu per backend, not per source**, and the difference only shows on CATMAID: FAFB and L1
are two servers and therefore two `CatmaidSource`s, so grouping on the source put a second row in
the menu spelled as a hostname. The key list is the **union** of the family table and
`CUSTOM_DATASET_NODES`, so a backend with no starter family still gets its escape hatch under its
own name rather than in a trailing "Other" — and a backend with neither is dropped, which is what
removing the synthetic dataset does to the mock one.

**The synthetic dataset is not offered here.** It is the Workflow Wizard's first answer instead: a
demo dataset is worth reaching for when you want a *pipeline* to look at, and `New ▸ Demo Data`
offered it as though it were somewhere to begin real work. The gold "no token needed" heads-up
that used to close the Examples menu went with that menu; its contrast finding — `--status-warn`
straight rather than mixed towards the surface, because no single gold clears 4.5:1 on both panels
— is recorded on the token itself in `theme.css`, which is where it survives being useful.

## The `?` menu's submenus

Six rows, two of which open a flyout: Welcome Dialog, `Guides ▸` (Basics, Learn to Build),
`Documentation ▸` (Overview, Field Guide, Node Guide), Data & Privacy, Keyboard Shortcuts, Give
Feedback. Flat it was nine two-line rows, which is a wall you read rather than scan — in the one
menu whose readers are by definition already lost.

**The order runs from "I am lost" to "I know what I want and need to check it"**: the way back to
the start page, the two groups that teach, then the two cards a reader looks something up in —
and last, once none of those was it, somewhere to say so. Give Feedback goes bottom rather than
near the top for that reason: high up it is the loudest row in the menu offering to take a
question the rows below it answer, and the reader who reaches it having passed all of them is
exactly the one whose "this is missing" is worth having.

**It replaced a rule that described the code accurately and organised the menu by the wrong
thing.** That rule was: above `Documentation ▸`, rows that act on the canvas you are looking at;
inside it, documents that open a tab. True of every row, and it bought a distinction about what a
click costs that the submenu's own blurb already makes — at the price of splitting Data & Privacy
and Keyboard Shortcuts, the two cards a reader looks *up* from, away from the documents they
belong beside. Both are still dialogs, and still for `ShortcutsDialog`'s reason: their questions
are asked *while* a graph is on screen. That is a fact about the surface, not about where the row
goes.

Data & Privacy sits before Keyboard Shortcuts because it is the one row carrying something a
reader is obliged to act on, and a keymap is the more findable of the two without help.

**`Dropdown` needs `flyouts` for this, and the reason is a CSS rule with no exceptions.**
`.dropdown__panel` sets `overflow-y: auto` so the long menus (New, Open, Save, Examples) cap at
70vh — and per spec a box with `overflow-y: auto` computes `overflow-x` to `auto` as well. There
is no "scroll one axis, overflow the other". Without the opt-out the flyout is clipped to the
panel's box and appears as a horizontal scrollbar. It is opt-in rather than default because only
a menu short enough never to scroll can afford it.

**The flyout butts against its row with no gap** (`left: 100%`, `top: -3px` for the panel's own
padding) and is a DOM *child* of the row's wrapper. Both together are what stop it closing as you
reach for it: travelling from row to flyout never leaves the wrapper, so `pointerleave` never
fires mid-journey. A gap of even a pixel here is the classic submenu you cannot reach.

**Which side it opens on is measured, not guessed.** `useLayoutEffect` reads the row and flyout
rects on each open and flips to `right: 100%` when the right side would run off. A breakpoint
would not do: the `?` button's x depends on how wide the graph's name rendered.

**The parent row's click opens; it deliberately does not toggle.** A toggle read correctly and
was wrong in all three input paths, because in each one something has already opened the flyout
by the time the click lands — a pointer hovered, a keyboard focused, a tap fired `pointerenter`
first. Enter on a row a keyboard user had just opened closed it again. Closing belongs to
leaving.

**Tab does not walk these rows, and that is not the submenu's doing.** `Editor.tsx` binds Tab
globally to the node browser and exempts only text fields, so Tab inside *any* toolbar menu opens
the browser — measured in a browser against the untouched Examples menu. The `onFocus`/`onBlur`
handling on `Submenu` is correct and goes live the moment that guard learns about open menus.

**The tours take `TOURS[].short` here and `label` elsewhere.** Under a heading that already says
"Guides", "Guided Tour" stutters; in the flat command palette and the start page's link row a
bare "Basics" says nothing. The shortening is a consequence of the nesting, so it belongs to the
surface that nests.

## Data & Privacy

`PrivacyDialog.tsx`, opened by `privacyRequest` — the same counter-plus-mount-seeded-guard idiom
as Share, Shortcuts and Feedback, because the `?` menu closes on pick and has nowhere to hold a
dialog.

**Two answers in one dialog, and the second is the loud one.** The privacy half is reassuring —
work and credentials stay in this browser, analysis runs here — and reassurance does not need
volume. The citation half is an *obligation the reader acquires without doing anything*: a picker
that says "MaleCNS" gives no hint that behind it are years of somebody's reconstruction work,
published asking for attribution. So it gets the callout treatment (`.privacy__cite`, tinted panel
plus a rule down the leading edge) and goes second, where a short document is actually read.

**It lists no papers, deliberately.** Any list here is a second copy of the publisher's own
wording that drifts from it from the day it is written — and it would go stale *silently*, since a
citation that is merely out of date still looks like a citation. The `Description` node already
renders the publisher's own text and arrives wired to every dataset node, so the dialog points at
it instead. Losing that pointer is what `privacy.test.tsx` guards; it is what makes the obligation
actionable rather than a slogan.

**The failure mode the test actually watches for is the overclaim.** "Nothing leaves your browser"
is the sentence this dialog is one careless trim away from, and it is false — every dataset node
fetches, and the assistant sends the graph to a third party. A privacy notice that is wrong in the
*reassuring* direction is worse than none, because it is believed. Hence assertions that fetching
and the assistant are both still disclosed, rather than a snapshot of the copy.

**Each of those notes is now one line and a `?`.** The dialog had accumulated a paragraph per
section plus a paragraph per field, and a reader met four of them before the button they came to
press — the copy had become the interface. `Why` (a `title`, the tooltip every other explain-this
in this app uses) holds the rest, and the rule is one line per point. Two things it must not do.
The **headline stays on screen**: a promise entirely behind a tooltip is one nobody reading the
panel has been told, and `sources.test.tsx` pins that half separately from the claim itself. And
the AI section keeps a **second** visible sentence, because where a key is kept is a promise about
us that costs a reader nothing to skip, while the question and the *graph* leaving the machine is a
consequence for them that no key field implies — a consent line behind a tooltip is not a consent
line. The tests read both halves through a `promise()` helper, since what they are about is which
claims are made rather than where; the negative ones ("does not claim a proxy") then mean nowhere
in the section, tooltip included.

**It repeats what `SourcesPanel`'s four `sources__privacy` notes say about credentials**, on
purpose. Those are read by somebody already in Connections configuring a token; this is read by
somebody who has never opened it. A reader who must find the other surface to learn whether their
token is safe has already been failed.

## Keyboard shortcuts

`src/ui/shortcuts.ts` is the one table of every key and canvas gesture, and
`ui/panels/ShortcutsDialog.tsx` draws it under `Help ▸ Keyboard Shortcuts` (and the palette's
`Help: Keyboard Shortcuts`). Four surfaces read it: the dialog, the palette's right-aligned
badges, the status bar's hints, and the start page's key box.

**It is not a keymap.** `Editor.tsx` still owns the bindings, and React Flow owns three more at
props it reads itself (`selectionKeyCode`, `multiSelectionKeyCode`, `deleteKeyCode`). The table
owns the *description* only. So adding a binding means adding an entry here too — nothing
enforces it, and a key nobody can find is a key nobody presses.

**Chords are stored by meaning, not by glyph.** `{ mod: true, key: 'Z' }`, not `'⌘Z'`. All four
surfaces used to have the glyph typed into them, which meant all four told a Windows user to
press a key their keyboard does not have; `formatChord` is now the single place that knows ⌘
from Ctrl, and it spells `⌫`/`⏎` out as Backspace/Enter off Apple as well. `shortcutKeys` and
`shortcutHint` **throw** on an unknown id rather than returning `undefined` — every caller is a
literal in the source, and a badge that silently renders nothing is exactly the kind of nothing
nobody notices.

**A phrase in the key column has to fit the key column.** The wiring gestures are named in
words, and written out in full ("drag a link into space") they overflowed the 112px track and
printed on top of the label beside them — a grid track does not clip. The noun each one acts on
lives in the label instead, and `overflow-wrap: anywhere` on the `kbd` is the backstop. jsdom
performs no layout, so the suite was green throughout; this was found in a browser and is only
findable there.

**`⌘S` is deliberately absent.** `Editor.tsx` swallows it and shows "Use the Save button",
which is a refusal rather than a shortcut. A row for it would be the card teaching a key that
does nothing.

## The guided tours, where they touch the rest of the app

The tours themselves are documented where they live — `steps.ts` for what a stop is, `tour.ts`
for the lifecycle and driver.js, `builder.ts` for a tour that builds a graph. Two things about
them are *not* local to those files, and both are here because they bite code that is not about
tours at all.

**A dialog that opens itself while a tour is running is a dialog nobody can use.** driver.js
makes every element but the one it is spotlighting `pointer-events: none`, so a modal that
arrives mid-step can be neither typed into nor dismissed: the reader is stuck behind a form with
the tour still going underneath it. Reported from "Build a Dashboard", whose third step adds a
MaleCNS node — a neuPrint dataset node peeks at the deployment the moment it is created, so a
browser with no token draws a 401 out of the server on the spot, and the app's answer to a 401
is to open Connections over everything. So `SourcesPanel` asks `isTourActive()` and sends the
message to the status bar instead, keeping `reason` recorded so opening Connections by hand
afterwards still lands on the tab that failed. That rule is about the *dialog*, not about
neuPrint: any surface that opens itself in response to something asynchronous is one tour step
away from the same wedge. Verified by A/B in a real browser — with the check disabled the panel
appears over step 3, with it enabled the same 401 surfaces on the card and in the status bar.

**A tour that needs a credential asks for it in a step, not in a sentence.** `TOKEN_STEP` in
`dashboard.ts` opens Connections through the store, spotlights the form, and advances by itself
when a token is saved. Four properties make it a way *past* the credential rather than a second
wall — `when`, `interactive`, `advanceWhen`, and an `after` that closes the panel so Next is a
real way out — and `tour.test.tsx` asserts each, because each is a way the fix could have
shipped broken.

**`TourStep.when` is asked once, when the tour starts.** `tour.ts` filters the step list before
driver is handed anything: `go` indexes into that array, so a list that could change mid-tour
would move the reader to a different step than the one it counted, and the `prepare` preamble is
appended to `steps[0]`, which has to be the step that actually shows first. It is for a step
that would be *wrong* to show — the token step for somebody who already has a token — and not
for one whose anchor happens to be missing: `tour.ts` is explicit that a stop which quietly
vanished leaves the copy referring to something the reader never saw. Measured in a browser: 13
stops with a token, 14 without.

**An anchor that can fall back resolves too early.** `before` opens the panel through the store,
but React has not committed by the time driver resolves the step's element — so
`byTour('connections-panel') ?? byTour('connections')` handed driver the toolbar *button*, which
ends its `waitForElement` poll on the spot. The step then spotlit a 28px icon behind the dialog
and granted the pointer events to that, leaving the form inert: the bug the step exists to fix,
reproduced by the fix. Returning null keeps the poll alive. Same trap `spanCards` records from
the other direction, and the general form is: **an anchor for something a step is bringing into
existence must answer null until it is there.**

**The span that covers two cards is `spanCards` in `steps.ts`**, shared by the Guided Tour's
wire step and every builder tour's "notice the wire" step. It was `Builder.span`'s private
implementation while only a tour that *builds* wanted one; the Guided Tour spans two cards it
merely found, so the arithmetic moved and `Builder.span` is now the same call with the ids looked
up by node type.

## The first-run guides dialog

What a first-time visitor actually opens on, in front of the start page: three rows, one per
entry in `TOURS`, with the first one badged. `GuidesDialog.tsx`, `launchStage.ts`, the guides
half of the store slice beside `startPageOpen`, and the `.guides*` block in `editor.css`.

**Why it goes in front of a page that is already an introduction.** The start page is a good
page and it offers eleven ways in — which is the problem it has on the one visit where the
reader has no basis for choosing between them. This asks one question with a recommended answer
and hands over to the page behind it either way. It is also the only surface that can say "take
this one first"; a rail cannot, because a rail is a row of equals.

**The launch sequence is one boolean and a stage, not two modals.** `startPageOpen` means the
sequence is on screen; `guidesOpen` means it is still at its first stop. `useLaunchStage`
composes the two and both surfaces read it — nothing else may ask the question, or the two
answers drift and you get either a stack of two modals or a first visit with nothing on it.
That composition is also what keeps the sequence closable from one place: the toolbar, a share
link, `openZoo` and thirty-odd tests already ended it through `startPageOpen`, and every one of
them ends it from either stage without having learned that a second dialog exists. A second
independent boolean would have needed each of those callers to say so again — which is a change
that fails silently in tests, because a modal nobody closed is not an assertion anybody wrote.

**Shown once, ever, and the flag is written on sight.** `coda.guidesSeen.v1`, from the dialog's
mount effect — not on close and not when the guides are finished, either of which would bring it
back for somebody who closed it on purpose. That is what earns it the front slot: a modal that
recurs has to be quiet, and this one is not. Every guide stays reachable afterwards from the `?`
menu, the palette and the doors rail, none of which this changes.

**A guide taken from here comes back here, and one taken from anywhere else does not.**
`beginGuide` takes the whole sequence off screen (`startPageOpen: false`, `guidesOpen` left
*true* — it is what brings the dialog back), the tour runs over the canvas, and `tour.ts`'s
`onDestroyed` calls `finishGuide`. The return hangs on a closure flag `beginGuide` sets, because
`finishGuide` runs at the end of *every* tour: one started from the `?` menu ends on the canvas
the reader was working on, which is where they were. Ordered after `restore`, so the state the
tour borrowed is back before a modal goes over the canvas again.

**A checkmark means finished, not started.** `drive` sets `completed` in the one place that can
tell the difference — `go` walking off the end of the step list, which is what both the Done
button and a Right arrow on the last step do. The ×, Escape and any other `destroy` reach
`onDestroyed` too and none of them is a guide somebody read. An abandoned guide still returns to
the dialog, unticked, which is the honest reading and leaves it inviting rather than crossed off.
Completions are kept in `coda.guidesDone.v1` as ids, so a guide added later starts unticked
instead of arriving already marked; nothing validates them against `TOURS`, because the dialog
iterates the table and asks whether each id is in the list — an entry left by a renamed guide is
invisible rather than wrong.

**The tick is green and the word beside it is not.** `--status-ok` is 3.18:1 on the light panel:
over the 3:1 floor for a graphical mark, under the 4.5:1 one for 11px prose — the same trap
`--status-warn` and `.zoo-row__requires` are both recorded against. So the colour is on the
glyph, "Completed" takes `--text-secondary`, and the state is carried by the glyph swapping from
a step number to a tick rather than by hue.

**Keyboard focus lands on the first guide not yet taken**, which is the Basics on the first
visit and the next one along on the way back from it, so Enter always does what the dialog is
currently suggesting.

**Driven in a real browser, because the round trip is the feature.** `guides.test.tsx` covers
the sequence with `startTour` stubbed — driver.js is the half `tour.test.tsx` deliberately never
loads. The full loop (first visit → Guided Tour → Done → dialog back with a tick and
`coda.guidesDone.v1` written) was walked in headless Chrome over CDP, which is the only place
`onDestroyed` and the real library are in the picture at all.

## The small-screen notice

The one thing Coda says on a phone. `src/ui/smallScreen.ts` decides when, `SmallScreenGate.tsx`
says what, the `.small-screen*` block in `editor.css` draws it, and
`src/store/persistence.ts` keeps the answer.

**It is a notice, not the first step of a responsive layout.** Coda is a node-graph editor: a
canvas of cards you place and wire, an inspector, a dock, and viewers that want every pixel.
None of that has a phone-sized form, and a workflow you cannot see the shape of is not a
workflow you can reason about — so the position taken here is that small screens are not
supported, said once, plainly, with a way through. What was there before was worse than either
answer: a shell that laid out at whatever width it was given, which on a handset is a toolbar
wrapped onto three rows and a canvas the reader cannot tell is broken from being empty.

**A media query, not the user agent, and both axes.** What makes the shell unusable is the
viewport, and a phone is only the commonest way to have a small one — a desktop window dragged
to a third of the screen is the same problem, and no UA string can see it, while a tablet is a
UA string away from being called a phone. `SMALL_SCREEN_QUERY` is
`(max-width: 720px), (max-height: 560px)`, and the second half is not decoration: a phone in
landscape is *wide*. The numbers come from the gap between the two populations rather than from
a round figure — every phone is at most 440 CSS px on its short axis, the narrowest tablet meant
to keep working is the iPad mini's 744, and both thresholds sit in between with room for the
browser chrome that eats into height. A threshold raised to a tidy 768 takes every tablet with
it. `smallScreen.test.tsx` pins them against a table of real device viewports, through a parser
that understands exactly this query's shape and **throws** on any other — a query rewritten into
a form it cannot read has to fail loudly rather than answer `false` and turn the table green.

**The one opaque backdrop in the app.** Every other dialog tints the canvas, because the canvas
behind it is context. This one is *about* the canvas not fitting, and a wrapped toolbar showing
round the edges of the sentence explaining it reads as the same bug rather than as the subject.
`backdrop-filter` goes off with it — nothing behind to blur, and it is the expensive half of the
rule on exactly the hardware this appears on. The type is also the only place in `editor.css`
that goes *up* from the app's 11px: this is read at arm's length on a handset, and it is four
sentences.

**It stands the guides dialog down, and that is the silent failure.** `coda.guidesSeen.v1` is
written the moment `GuidesDialog` mounts — on *sight*, which is what makes it a first-run dialog
— so mounting it behind an opaque backdrop would spend the single appearance it gets on a modal
the reader never saw, and they would never be offered the guides at all. `GuidesDialog` asks
`useSmallScreenNotice()` and returns null, rather than the write moving: "shown" is the honest
key, and a dialog underneath this one was not shown. Nothing else in the suite could see it,
because jsdom's `matchMedia` answers `false` to everything and every other `App` test therefore
renders at desktop size — which is also the property that keeps this out of the other three
dozen of them.

**The acknowledgement is `localStorage`, and it does not record the size.** `coda.smallScreen.v1`
— see `loadSmallScreenAck` for why it is kept for good rather than for the session: the condition
is not transient, a phone is still a phone next week, and a notice that comes back every visit is
one somebody learns to tap through without reading, at which point it has stopped being a warning
and is only a delay. What is stored is *that the reader answered*, never the viewport they
answered at, so a smaller screen later is not a new question. The store is `hints.ts`'s shape and
for its reasons — nothing here is about the graph, and a boolean about the viewport in
`useGraphStore` would wake 1,204 call sites for a tap on a button.

**Growing the viewport dismisses it and writes nothing.** A window pulled back out is somebody
fixing the condition rather than accepting it, and asking them to acknowledge a state that no
longer holds would be the wrong question; storing it would then silence the notice on the phone
they pick up later. Narrowing again brings it back.

**The links are the useful half.** The overview, the field guide and the node guide are separate
vite entries, already responsive, and carry the prose. A reader who arrived on a phone from a
link very often wanted one of those, and offering them beats both "sorry" and a canvas they
cannot use. Through `import.meta.env.BASE_URL`, like every other in-app link to them, because
`base` is `'./'` and an absolute path 404s off the domain root on GitHub Pages.

**Not driven in a real browser yet.** The logic is covered; the *look* at 390×844 is not, and
jsdom performs no layout. Check it with `pnpm dev` and a device emulation preset before trusting
the padding.

## Start page

The second thing a first-time visitor sees and the first thing everyone else does: a modal over
the canvas with the release-stage blurb, the rails of starting points, the repo link and a
"Don't show again" checkbox. `StartPage.tsx`, `startCards.ts`, and the `.start*` block at the
end of `editor.css`. It stands down while the guides dialog above is up — `useLaunchStage` is
where the two agree — and is otherwise unchanged by it, including the tour cards on its own
doors rail: this page is where the guides live for every visit after the first.

**Three rails, and the order is how often each is what somebody came for:** the user's own saved
workflows (only when the shelf has something on it), **Start & learn**, **Datasets**. There was a
fourth — a rail of four bundled example graphs — until the Workflow Wizard replaced them; see
[wizard.md](wizard.md).

**"Start & learn" is the doors rail: the wizard, the three tours, then the Zoo.** The line it
draws is the one the toolbar's Workflows menu draws with a rule — the Datasets rail below builds
a graph and replaces the canvas the moment a card is clicked, and nothing on this rail does. The
wizard leads because it is the one that produces *their* graph; the tours explain the app and the
Zoo opens a stranger's workflow.
So `pick` returns early on all three kinds, *before* the replace-confirm, and for a different
reason each: the wizard asks that question on its own summary screen, over the chain it is about
to build; `ZooBrowser` asks it over the preview of the workflow being opened,
which is where it can be answered (asking on the rail asks it twice, the first time about a
graph nobody has chosen yet); a tour that touches the canvas announces it in its own first step
and goes through `setGraph`, so it is warned *and* undoable, which is more than a yes/no here
would buy. Both close the page on the way — `openZoo` because two full-screen modals is one too
many, a tour because its first stop is the canvas.

**The tours are cards here and no longer links in the credits row.** Offering both is the same
three things twice in one dialog, and a card is what a first-time reader clicks: `TOURS` already
carries a `label` and a `blurb` each, which is exactly a card. The row keeps what a rail cannot
hold — the new-tab documents and the feedback dialog — and the `?` menu still lists the tours
for the visit somebody ticked "Don't show again" on. `DOOR_CARDS` is built from `TOURS` rather
than restating it, which is what that table was introduced to stop; the tour order is the
table's, which leaves the dashboard tour last, the one whose blurb already admits it wants a
neuPrint token.

**Their art is the one hand-drawn set in the app** (`startGlyphs.tsx`), and the exception is
bounded rather than a repeal: the "derived, never per-card" rule below exists so a rail that
*grows* never ships a blank tile, and this rail is a fixed table of three tours plus one Zoo,
none of them a node or a dataset with anything to derive from. `doorGlyph` is keyed by card id
so a new tour needs one entry and nothing else, and it falls back to the Zoo's mark rather than
to `undefined` — an empty `<svg>` wearing the right class is exactly the blank tile the rule is
about. `DOOR_CARDS` is a module constant, unlike the other three rails, because none of it is
derived from the node registry. The tint is `--accent`, not a `--cat-*`: a door stands for a
surface, any category would be a claim about what is behind it, and one tint is what makes the
rail read as a group against the four below it.

**A fresh visit now lands on an empty canvas.** `graphStore` used to auto-load `EXAMPLES[0]`
when there was no autosave. That works against the start page twice: the start page _is_ the
onboarding, and a graph the newcomer never asked for makes their first card click trip the
replace-confirm. Don't restore it.

**Closing is not dismissing.** Esc, ✕, Close and a backdrop click all just close;
only the checkbox writes `coda.startPage.v1`. Ticking it deliberately does _not_ close, so it
stays undoable in the same visit. `startPageOpen` is a plain boolean rather than a `seq` pulse
like `paletteRequest` — it is state the store owns, not a request a component has to catch, so
it needs no mount-seeded guard.

**No text, and no card, ever sits on raw image pixels.** The image is one layer;
`.start__scrim` covers it with theme tokens and goes fully opaque from the rails down. That is
what lets `public/start/backdrop.svg` be swapped for any photograph without re-checking a
contrast ratio — the numbers are the theme's, not the picture's. One image serves both modes
(a JPEG cannot adapt), so `--start-image-opacity` carries the difference: 0.55 dark, 0.32
light, because a picture with enough presence on the dark canvas turns the light panel muddy.

**Reference the backdrop through `import.meta.env.BASE_URL`.** `base` is `'./'` so the build
works from a subpath; a bare `/start/backdrop.svg` resolves to the domain root on GitHub Pages
and 404s — leaving a panel that looks fine locally and flat in production.

**Card art is derived, never per-card.** An example's tile glyph comes from the _terminal
viewer node_ of its own `build()`, a dataset's from the family table, both reusing the art the
app already draws (`nodeGlyph`, `datasetGlyph` — exported for this, not duplicated). Adding
the examples rail is what forced `out.network` and `out.viewer3d` into `NODE_GLYPHS`: without
them two of the four examples drew the same generic bars. Every card also has an unused `image`
slot, so real screenshots drop in later without the layout moving. Same rule as
`NodeThumbnail`: per-item artwork means the next item ships blank.

**The replace-confirm is inline, on the card.** Loading resets the undo history, so a card
asks before overwriting a graph that has nodes. Not `window.confirm` — jsdom does not
implement it, and browser chrome in front of a page explaining the app reads as an error.

**Tests that mount the real `App` must close it first.** It renders over everything, which is
its job; `App.smoke.test.tsx` and `explore.test.tsx` call `closeStartPage()` in `beforeEach`
and one test opens it deliberately. A new App-mounting test that starts failing on
`getByText('Coda')` or `findByRole('dialog')` is hitting exactly this. A suite that wants this
page *open* needs `guidesOpen: false` as well, because the store made its first-visit decision
once, when the module was imported: `startPage.test.tsx`, `library.test.tsx` and the one
`App.smoke.test.tsx` case that opens it all say so.

**The funder logos ship in both inks, and CSS picks.** `src/ui/logos/` holds a light and a dark
variant of each mark, imported with `?url` so vite hashes them and emits
`new URL(..., import.meta.url)` — which resolves from the module and so survives `base: './'`
without going through `BASE_URL` the way a `public/` asset has to. `.start__logo--light` /
`--dark` are toggled across the same three scopes `theme.css` uses (bare `:root`, then
`prefers-color-scheme`, then `[data-theme]`), because the app's own toggle has to win over the
system setting in *both* directions — the default preference is `'dark'`, so an app that only
honoured the media query would show white-on-white to anyone whose OS is in light mode. Picking
in JS instead would mean resolving `theme: 'system'` through `matchMedia` and subscribing to it;
`display: none` also drops the unused copy out of the accessibility tree, so each mark is
announced once rather than twice. Verified in Chrome across all four preference × system
combinations — jsdom loads no CSS and would call any of them passing.

Both marks are used under their owners' brand rules, so **nothing recolours or fades them**: no
`opacity`, no filter — including on hover, now that each is a link. The affordance lives on the
anchor instead: a plate behind the mark (`--surface-hover`) and the usual focus outline, so the
surround changes and the artwork never does. No `border-bottom` either, though `.start__links a`
underlines its links — a rule under a logo reads as part of the artwork.

**One anchor wraps both inks**, not one per image. The unused ink is `display: none` and so out
of the accessibility tree, which leaves each link named exactly once by the `alt` of whichever
ink is showing — checked in Chrome, where exactly one ink per anchor survives `display: none`.
The unit test asserts the wrapping through `closest('a')` rather than by accessible name,
because jsdom loads no stylesheet: both inks are live to it and the name it computes is the alt
text twice over.

The pair is subordinated by being small and last. The two heights
differ (36px LMB, 28px Cambridge) because LMB sets three lines of text to Cambridge's two —
equal heights make its wordmark read smaller. Those numbers bring both to ~136px wide, which is
what actually looks like a matched pair.

**The version comes from `package.json` through a vite `define`** (`__APP_VERSION__`), not a
JSON import, which would land the whole manifest in the bundle. A build that cannot say which
build it is makes every bug report ambiguous — so bump `package.json` when the build changes
meaningfully.
