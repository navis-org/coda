# The shell around the canvas

Panels, fullscreen, the run indicator, the `?` menu, the keyboard-shortcut table and the
start page.

Moved verbatim out of `CLAUDE.md`.


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
plus a chevron in its own header; the minimap has a button in the corner it occupies. That button is rendered
**outside `<ReactFlow>`** so it keeps its corner whether or not the map is mounted — a toggle
that disappears when used cannot be undone.

**The minimap's size goes through its `style` prop, not CSS.** React Flow reads
`style.width`/`style.height` to compute the map's viewBox, so sizing it in the stylesheet leaves
it drawing a 200×150 projection into whatever box CSS produced: it renders, and is silently
wrong. `MINIMAP_SIZE` in `Editor.tsx` is the single constant; `.canvas-area` publishes its height
as a CSS variable inline so the toggle can clear it without a second copy of the number.

`installStorageStub()` in `test/jsdomStubs.ts` is what makes any of the persistence testable —
Node 26 shadows jsdom's `localStorage`, so by default every persistence path silently degrades
and has no coverage. Opt in per suite: with storage present, autosaves leak between test files.
It stubs `sessionStorage` too, because the autosave needs both to mean anything: the graph goes
in one and the tab identity that decides *which* graph in the other, so stubbing only the first
exercises the degraded single-slot path while looking like it covers the feature.

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

## The `?` menu's submenus

Four rows, two of which open a flyout: Welcome Dialog, `Guides ▸` (Basics, Learn to Build),
Keyboard Shortcuts, `Documentation ▸` (Overview, Field Guide, Node Guide). Flat it was seven
two-line rows, which is a wall you read rather than scan — in the one menu whose readers are by
definition already lost.

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

## Start page

The first thing anyone sees: a modal over the canvas with the alpha blurb, two rails of
starting points, the repo link and a "Don't show again" checkbox. `StartPage.tsx`,
`startCards.ts`, and the `.start*` block at the end of `editor.css`.

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
them three of five examples drew the same generic bars. Every card also has an unused `image`
slot, so real screenshots drop in later without the layout moving. Same rule as
`NodeThumbnail`: per-item artwork means the next item ships blank.

**The replace-confirm is inline, on the card.** Loading resets the undo history, so a card
asks before overwriting a graph that has nodes. Not `window.confirm` — jsdom does not
implement it, and browser chrome in front of a page explaining the app reads as an error.

**Tests that mount the real `App` must close it first.** It renders over everything, which is
its job; `App.smoke.test.tsx` and `explore.test.tsx` call `closeStartPage()` in `beforeEach`
and one test opens it deliberately. A new App-mounting test that starts failing on
`getByText('Coda')` or `findByRole('dialog')` is hitting exactly this.

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
JSON import, which would land the whole manifest in the bundle. An alpha that cannot say which
alpha it is makes every bug report ambiguous — so bump `package.json` when the build changes
meaningfully.
