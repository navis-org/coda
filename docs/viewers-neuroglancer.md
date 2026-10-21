# Viewers: Neuroglancer

The Neuroglancer card: the scene it builds, the embedded frame, and the `Selected` output.
[viewers.md](viewers.md) holds what every viewer shares — export, tooltips, table filtering and the
styling sidebar.

## Neuroglancer

`out.neuroglancer` emits a **URL** and the widget is an iframe on it. There is no SDK and no
bundled copy of neuroglancer; the entire integration is `src/data/neuroglancer/scene.ts`
(headless, source-agnostic — FlyWire and CAVE publish states too) plus one endpoint call in
`neuprint/nglayers.ts`.

**A published scene is edited, never rebuilt.** The camera, the EM volume, the ROI meshes and
the synapse layer wired to the segmentation are the reason to reuse it. Verified shapes,
because they are not uniform and the differences are load-bearing:

| dataset            | what it publishes                                                              |
| ------------------ | ------------------------------------------------------------------------------ |
| `hemibrain:v1.2.1` | `{ layers }` and nothing else — no dimensions, position or layout              |
| `hemibrain:v1.1`   | `{ layers, badlayers }`; `badlayers` is Explorer bookkeeping, not viewer state |
| `manc:v1.2.3`      | full state, `layout: "3d"`, and a stray `segmentColors` for one body           |
| `male-cns:v0.9`    | full state, 38 layers, 38 kB before a single neuron id is added                |

So the module supplies `layout` and `showSlices` when absent — neuroglancer's own defaults
open hemibrain in 4-panel with EM planes cutting through the neurons — clears manc's stray
colour rather than merging into it, and strips `badlayers`.

**Layers of your own go on the end.** The `Extra layers` socket takes what a
`Neuroglancer Source` node emits, and `buildScene` appends them after the published list —
appended rather than merged in, because order is neuroglancer's draw and panel order and a
published scene is somebody's curated arrangement. They survive `Layers: neurons only`, which is
about how much of the *dataset's* scene to carry: a layer somebody wired up is not published
context to trim. A name that collides with a published layer is suffixed, because neuroglancer
keys layers by name and a duplicate is not a merge — the second wins and the first becomes
unreachable, silently.

**Which layers are ours cannot be read off the scene, and assuming it could was a bug twice.**
The tempting test is "carries a `segments` array". Measured against the live endpoint, that is
**sixteen of male-CNS's thirty-eight layers**, eight of MANC's eleven and seven of optic-lobe's
seventeen — published shells and neuropil layers that ship a preset selection and have nothing to
do with us. Reading those as ours means the splice copies our copy of a shell over the user's live
one, and — worse — a user who deletes any one of the sixteen makes the splice bail to the merge
tier, throwing away every layer edit they had made. Silently.

So `ownedLayerNames(scene, datasetId, extraCount)` applies `buildScene`'s own two rules instead:
the dataset's own segmentation layer, found by `segmentationLayerIndex`, and the extras appended
to the end. Neither fact is in the scene, so both arrive as props on the viewer — for exactly the
reason `viewerType` does, which that file already documents: the URL cannot carry them. Without a
`datasetId` the splice is skipped and updates fall to the merge tier, which is the honest degrade:
writing into somebody's live state is worse done wrongly than not at all.

The single-layer version that came before was correct only by luck — the published layers carrying
`segments` happen to sit *after* the dataset's own on both real multi-layer states.

**A layer of ours missing from the live state declines the splice altogether.** The list itself has
changed rather than a selection within it (a datasource wired up after the frame loaded, or a layer
the user deleted), and the merge tier below already sends the whole list, which is exactly what
that needs.

**Two published defaults are overridden, not offered as options.** `showAxisLines` goes to
false — the lines cross the middle of the volume and read as anatomy at a glance — and
`selectedLayer.visible` goes to false, keeping the panel's `flex`/`size`/`layer`. MANC and
male-CNS both publish it open, which costs about 70% of a card that is already far smaller
than the browser window those states were framed for. Neither key is in `SCENE_PATCH_KEYS`,
and that is deliberate: they are _opening_ defaults, so a later merge does not slam shut a
panel the user has since opened. Note that neuroglancer drops `visible` from its own
serialisation once it is false, since that is its default — so a round-trip will not show it.

**Find the neuron layer by name, not by type.** male-CNS ships thirty segmentation layers:
ROI shells, nuclei, cross-dataset mesh overlays. Writing neuron ids into `brain-shell` renders
nothing with nothing to blame. Same family-name rule as `meshSourceFromState`.

**This is the one node with no presentational params, and that is the invariant.** Its output
_is_ the styled artefact — the colours are inside the URL — so marking a colour param
presentational would leave the node `ok` while its link still carried the old palette. That
is why `colorParams` grew a `presentational` opt-out; do not use it anywhere else.

**It imports `resolveColor` from `src/ui`** — the only `nodes → ui` edge in the tree. That is
deliberate: "never re-implement colour mapping" applies to an external viewer too, and
reusing it is what makes a neuron the same colour in the 3D view and in neuroglancer. Both
modules are pure, so it stays testable headlessly. Colours resolve in `'dark'` regardless of
Coda's theme, because neuroglancer renders on black.

**`cheap`, despite fetching**, because the fetch is one small JSON per dataset that
`NeuPrintSource` caches — the failure included, since a `cheap` node re-runs on every
restyle. Everything after that is string building.

**The frame is mounted in the node body, not only in the overlay.** That is a real cost —
each one is a full WebGL application that starts fetching EM on mount, and a canvas can hold
a dozen — and it is paid deliberately, because a viewer you have to open before anything
appears is not an exploration surface. The escapes are the resize handles and the ordinary
collapse toggle, which unmounts the preview.

**`uiScale` is the one presentational param, and it marks the line.** Everything else reaches
the URL, so it belongs in the provenance key; scaling the _frame_ cannot change a byte of what
`evaluate` returns. The frame is laid out at `1/scale` and drawn at `scale`, so it fills the
card exactly while neuroglancer believes it has a larger viewport — which is what makes its
chrome take a smaller share. A `transform` rather than the `zoom` property: it composites
instead of relaying out, and pointer coordinates into an iframe map through it correctly. Not
called "zoom" on purpose, since neuroglancer has a camera zoom and two of those on one card is
a trap.

**Every param is `advanced`, i.e. inspector-only.** A row of pickers above a 400px embed
takes a tenth of the space someone opened the node for. The inspector shows the full set for
the selected node, which is where a control that rebuilds a scene belongs. Note the
consequence: these params are _not_ presentational, so they never appear in the overlay's
rail either — the inspector is the only place they live.

**Colour mode `default` sends nothing at all** and lets neuroglancer hash-colour each
segment, and it is **this node's default**. Distinct from `constant`, which sends one
`segmentDefaultColor`; the point is that no colour data travels, which is also the shortest
link — and this is the one node whose entire output is a URL somebody pastes into mail.

It is the right default rather than merely the cheapest, and the reason is the palette's own
rule: Coda caps a categorical encoding at eight slots and folds everything past them into one
achromatic bucket, because in a legend a repeated hue claims two series are the same thing. A
scene has no legend, and past the eighth cell type every remaining neuron would be the same
grey. Neuroglancer gives every segment a distinct colour and needs no legend to do it.
`defaultColumn: 'type'` is still there for the moment somebody picks a data-driven mode —
`neuronId` is the first compatible column and is the wrong answer for the same eight-slot
reason.

`colorParams` only offers the mode when a caller opts in with `allowDefault`, because no in-app
viewer can honour it — `resolveColor` degrades it to the flat colour so it is harmless if it
ever leaks.

**Updates go through neuroglancer's `#!+` merge form, and this is the load-bearing part.**
The plain `#!` form makes neuroglancer `reset()` before restoring, so every upstream edit threw
away the camera, the layout and every runtime tweak — change a filter three nodes away and the
framing you had just set up was gone. `#!+` restores _over_ the live state: keys it does not
mention keep their current values. So `scenePatchUrl` sends only `SCENE_PATCH_KEYS` — the three
things this app owns — and the camera survives.

Four facts behind that, all established against the deployed viewer rather than reasoned:

1. **Assigning `src` a URL differing only in fragment does not reload the document.** It is a
   same-document fragment navigation; neuroglancer keeps its meshes and handles `hashchange`.
2. **The iframe element's `load` event fires on fragment navigations too**, so a load counter
   in the parent reports a reload that did not happen. That measurement said the opposite of
   the truth for a while. Only a signal from inside the frame distinguishes them.
3. **`layers` must be the whole list in a patch.** The merge is per top-level key, not per
   layer: a patch naming only the segmentation layer deletes the EM volume and every ROI mesh.
4. **Per-layer runtime state cannot survive**, precisely because of (3) — a visibility toggle
   or a randomised colour seed is rebuilt from what we send. That is the limit of what an
   iframe allows; reading the live state back would need a same-origin frame.

**`SCENE_PATCH_KEYS` is one key, and shrinking it was a bug fix.** It held
`['layers', 'layout', 'showSlices']` until neuroglancer was reported erroring under rapid
updates: a cascade of `can't access property "generation" of undefined` ending in
`Error restoring property "layout"` — which names the key. Restoring `layers` tears down and
rebuilds every layer; restoring `layout` in the same pass rebuilds the panels holding
references to them, and doing both while someone is dragging is asking the two to race.
Sending only `layers` takes the named property out of the update path. The cost is that
`layout` and `showSlices` fall into `sceneIdentity`, so changing either re-navigates and the
camera returns to the published framing — right trade, since they are structural and rare
while selection changes are constant.

**Where the viewer is proxied same-origin, updates are _spliced_ rather than merged.** This is
the answer to "why can't we just change the segments and leave everything else alone": a merge's
finest granularity is a top-level key, `layers` is one key, and restoring it replaces the whole
list — so a merge sends _our_ layer list and takes with it any layer the user hid, added or
reordered. Verified in both the array and the name-keyed map forms; neither reconciles per layer.

The way round it is to stop sending our list. `spliceSegments` reads what the frame is currently
showing, writes only that one layer's `segments`/`segmentColors`/`segmentDefaultColor` into it,
and sends _that_ back — so the list written already contains everything the user did. Reading
`location.hash` needs same-origin, which is the only reason `/ng` exists in `vite.config.ts`;
neuroglancer frames fine cross-origin. Without the proxy the embed still works and falls back to
merging, so a static deploy loses the preservation, not the viewer.

Note the split: the **frame** goes to the proxied path, the **link** to the deployment the node
chose. A copyable link that pointed at `/ng` on someone's dev server would be useless. Since Coda
serves its own copy (below), the default deployment *is* this page's host — public in a deployed
build, `localhost` under `pnpm dev` — so a link copied in development opens only there.

**And "without the proxy" has to be asked of the build, not of the origin** — `sameOriginViewer`
in `NeuroglancerViewer.tsx`, gating `proxiedViewer` on `import.meta.env.DEV`. `proxiedViewer`
answers which origins have a prefix *declared*, which is a fact about `VIEWER_PROXIES`; whether
anything is serving it is a fact about who is serving the page, and the two had been treated as
one. The consequence is not the documented degrade, because `/ng` is an **absolute path**: a
static deploy pointed its frame at `/ng/#!…` on its *own* origin and got a 404, rather than
falling back to the public viewer. Measured against the published site —
`navis-org.github.io/ng/` and `/coda/ng/` both answer 404, and the first is where the card sent
its frame — so the deployed Neuroglancer node was a blank panel for every dataset that does not
name a `viewerSite` of its own, which is most of them.

`DEV` rather than a build-time flag of our own, and it costs the splice under `pnpm preview` even
though that server *does* mount the rule (`preview: { proxy: … }`) — which is now dead weight
there, since nothing in a preview build will ever request `/ng`; read the config first and it
looks like a contradiction. That is the right way round:
preview serves the deploy artefact, and a preview that behaves better than the thing it previews
is not one. It meant the splice, `sceneMemo` and everything else same-origin were **dev-only
behaviour** — until Coda served its own copy of neuroglancer (below), which is same-origin in every
build. That copy is now the default; the `/ng` proxy is reached only by a scene pointed explicitly
at the public demo.

**A remount is the other way the state dies, and none of the above touches it.** Expanding a
Neuroglancer card reset the view, and closing the expansion reset it again — because the card
stands down while the overlay owns the node (`showPreview` in `CodaNodeView`, and the reason is
measured: two instances of a viewer are two of everything it holds), so each transition is an
unmount and a fresh mount with an empty frame. Nothing about merging helps when the component
itself has gone.

`sceneMemo` is the answer, and it is `cameraMemo` one seam further out: a module-level,
session-scoped map, keyed by the graph node id, holding what the frame was last showing. Read on
the way out; the next mount navigates to *that*, with the current selection spliced in, instead of
to the published scene. It carries the whole state rather than a camera because there is no
smaller unit that helps — the frame is re-pointed with one URL either way — and because the panel
layout and the layers the user hid or added die with the iframe exactly as the camera does.

Three things it has to get right, each of which was a way to get it wrong:

1. **The gate is the *applied* scene's identity, not the stored state's.** A live scene differs
   from the built one on precisely the keys the user moved, so `sceneIdentity(live)` would never
   match anything and the memo would be dead code. What the memo stores alongside the state is
   the identity of the scene that was *asked for* when it was read — the same comparison
   `canMerge` makes, which is the same question: same place, same deployment.
2. **The read happens while the frame is still in the document.** It was a `useLayoutEffect`
   cleanup for that reason, and is now the frame registry's `destroy`, which runs before the host is
   removed (see the next section). **A detached iframe has no browsing context**, so a read after
   removal returns null every time, and a null here is indistinguishable from the cross-origin
   degrade. The test's `contentWindow` stub is a getter that honours `isConnected` for that reason.
3. **Reload forgets.** That button is how somebody escapes a frame that has gone wrong, so
   resuming into the state it went wrong in is the one outcome it must not have.

Same-origin only, since it reuses the same read `spliceSegments` needs, and it degrades the same
way: no proxy, no memory, and the embed behaves as it did. The frame in `Neuron Profile` passes no
`viewerId` and so remembers nothing — it is a tile showing one neuron at the published framing,
with no identity of its own to hand anything to.

### No bounding boxes, written as `bounds: false` on every volume source

Asked for: no scene Coda shows draws the volume's bounding box, a wireframe round the whole
dataset that on a card is mostly box. Removing `"bounds": true` where a state said it was not
enough, and the reason is measured: a **bare URL source gets neuroglancer's default subsources, and
`bounds` is one** — hemibrain's segmentation as a bare URL draws the box, and as
`{ url, subsources: { bounds: false } }` it does not while its meshes still load (screenshotted
through the dev server's `/ng` proxy). The published neuPrint states list their subsources without
`bounds`; the scenes Coda builds itself (a BigClust Scene, a Neuroglancer Source's layers) are bare
URLs, which is where the box came from.

So `sceneForViewer` writes `bounds: false` on every source of an **image or segmentation** layer
(annotation layers have no such subsource), turning a bare URL into `{ url, subsources }` and
keeping every other key. Two orderings matter. It runs **after** the graphene rewrite — and that
rewrite now reads a source through `sourceUrl`, whichever spelling it is in, because a scene re-sent
from a link already carries the object form; reading only strings, a FlyWire scene re-targeted to
the Seung-lab fork kept a `middleauth+` that fork refuses (the viewer suite caught it). And **not
for the Seung-lab fork**, whose older format is not known to take the object spelling — it gets the
bare URL back.

### The Neuroglancer frame is handed between surfaces, not reloaded

`sceneMemo` carries the *state* across a switch, and every switch still reloaded the application:
neuroglancer booted again, refetched and re-uploaded everything, and restored — slow on a large
scene, and in a deployed build, where the frame is cross-origin and nothing can be read, not even
the state came back. The 3D viewer's answer (keep the renderer, move its element) does not transfer
directly, because **an iframe reloads when it is moved**: `appendChild` detaches it, and a detached
iframe has no document. `Element.moveBefore` is the exception — a state-preserving move, Chrome and
Edge 133+ and Firefox 144+, not Safari.

Measured in Chrome 153 on a bare page first, with a same-origin frame carrying a JavaScript marker,
`example.com` and the public neuroglancer demo, counting `load` events on each element:

| move | marker | new `load` events |
| --- | --- | --- |
| `moveBefore` into a `transform: scale` container (a zoomed card) | kept | none |
| `moveBefore` into the hidden parking lot, and back out | kept | none |
| `moveBefore` of an ancestor holding the frame | kept | none |
| `appendChild` (control) | lost | one each — all three reloaded |

Then in the app (`pnpm probe:viewer3d-switch -- --neuroglancer --limit 10`, male-CNS, the dev proxy
making the frame same-origin): card → overlay → card, twice, the same element every time, no `load`
event, the marker set in its document still there and neuroglancer's own hash unchanged; parked
while the dashboard hid the card, released after `RELEASE_AFTER_MS`, a fresh frame on the way back.
Screenshots at both sizes confirm it draws. What the app run could not show is the cross-origin case,
which is what a deployed build has — the bare-page table is the evidence there.

So `NeuroglancerViewer` leases its frame from `persistentRoots.ts` exactly as `PersistentCanvas`
leases a root, and five rules are what make it work:

- **Kept only where `moveBefore` exists** — `keepOnlyIfMovable` on the registry, so it is the
  registry's rule rather than something each caller remembers to check. Moved any other way the frame
  reloads onto whatever `src` it was last given — a `#!+` patch as often as not, which loads onto
  neuroglancer's defaults rather than the published scene — while the component still believes it is
  showing that scene. Without it each surface builds its own frame and `sceneMemo` resumes, as before.
- **What the component knows about the frame lives with the frame** (`HeldFrame.applied` and
  `.loaded`, which were refs). A surface adopting a live frame has to know what it already shows;
  without it the new instance takes the frame for an empty one and sends it the full scene, resetting
  exactly the camera and layers keeping it exists to carry. With it, adopting navigates nothing — the
  effect's "already applied" guard returns — and the next selection merges as it always did.
- **The registry places the host itself** (`lease(key, parent)`) and makes every later move, since
  `moveBefore` only moves between connected parents and one `appendChild` anywhere in the path is a
  reload — no caller holds the element to move it any other way. The lot is shared by every registry,
  and a frame's host is **pinned at the size it had** while parked (`pinWhenParked`): neuroglancer
  watches its own size and would otherwise follow the lot down to one pixel and back. Pinned on
  principle rather than measured to harm, and opt-in because the size read forces a layout, which a
  React Three Fiber host — sized by its surface — would pay for nothing.
- **`sceneMemo` is written as a frame is destroyed** (the registry's `destroy`), which runs while the
  host is still in the document — a removed iframe has no document to read. So a frame handed to the
  next surface is never read at all, and one released after its grace period or built privately
  (Safari, a second surface on the key) is. Reload discards before it forgets, so the way out still
  leaves nothing behind.
- **The key names the workflow** (`viewerKey` in `ValuePreview`): a kept frame answering for one node
  id in two open copies of a file would show one workflow's scene in the other. Reload discards the
  kept frame rather than parking it, and the profile tile, passing no `viewerId`, keeps nothing.

**Merges are debounced** (`MERGE_DEBOUNCE_MS`), trailing-edge, and only merges — the first
navigation is immediate. Auto-run turns one upstream edit into a scene per keystroke, and
applying each had neuroglancer rebuilding its layers several times a second. Only the last of
a burst is worth anything.

**Nothing is written into a frame the pointer is inside**, and that is the real answer to the
`generation` error above — the `SCENE_PATCH_KEYS` change narrowed it and did not remove it,
because `layers` alone is enough. Traced through neuroglancer's own source rather than reasoned
from the message this time, and it is two bugs of theirs meeting:

1. **A layer is built in two steps.** `TopLevelLayerListSpecification.restoreState` constructs
   *every* layer first (`initializeLayerFromSpecNoRestoreState`, each followed by an
   `addManagedLayer` that synchronously dispatches `layersChanged`) and only then initialises
   them in a second loop. `SegmentationUserLayer`'s **constructor** calls
   `segmentSelectionState.bindTo(manager.layerSelectedValues, this)`, subscribing to the hover
   machinery — but `UserLayer.selectionState` is assigned in `initializationDone()`, which is in
   the *second* loop. Anything that asks a layer about the mouse in between reads `generation`
   off `undefined`. `LayerSelectedValues.handleLayerChange` asks precisely when
   `mouseState.active`, and that is true when the pointer is over a render panel with a resolved
   pick (`perspective_view/panel.ts`, `sliceview/panel.ts`).
2. **The subscription is never disposed.** `segmentSelectionState` is a plain field on
   `SegmentationUserLayerDisplayState`, which is not a `RefCounted` and is not registered on the
   layer, and `UserLayer.disposed()` releases only data sources and render layers. So a layer
   disposed *before* it was initialised — which is exactly what (1)'s throw causes, via
   `restoreState`'s per-layer `catch` — leaves a listener behind that is still pointed at it.
   From then on **every** `layerSelectedValues.changed` dispatch throws, for the life of the
   document.

Which is why the error people report arrives on `onMouseout` rather than on the edit: that is
not the original failure, it is an echo of one, and only reloading the frame clears it. The
first failure is swallowed by neuroglancer into an "Error creating layer …" banner.

So the update waits for `mouseleave` on `.ng-frame` — `pointerInside`, held in state because the
navigation effect has to re-run when it clears, with `heldRef` recording that a resume is not a
fresh navigation. Three details are load-bearing. It gates **replacements too**, not only merges:
`#!` resets and restores, which is the same teardown through the same code. It does **not** gate
the opening navigation, since an empty frame has no layers to tear down and a card mounting under
the cursor should still fill in. And a held replacement goes through `MERGE_DEBOUNCE_MS` rather
than firing on the spot, because the pointer has just crossed out and the frame's *own*
`mouseleave` is what clears `mouseState.active`; the timer keeps our write behind it instead of
racing it across two documents.

The listeners are `addEventListener('mouseenter'/'mouseleave')` on the wrapper rather than React's
`onMouseEnter`/`onMouseLeave`, and the iframe is the reason: React synthesises enter/leave from
delegated `mouseover`/`mouseout` at the root, and a pointer that has crossed into a foreign
document produces neither — those events happen in the frame's tree. The element's own boundary
events are dispatched against the iframe box, so they fire either way.

**The other half is `isSegmentId`, and it is the same failure reached without touching the
mouse.** Neuroglancer parses `segments` and the keys of `segmentColors` with `parseUint64`, whose
grammar is `^(?:0|[1-9][0-9]*)$` — no sign, no leading zeros, no exponent, no whitespace, nothing
non-numeric. A miss is not a skipped id: it throws out of `SegmentationUserLayer.restoreState`,
`completeUserLayerInitialization` catches it and calls `deleteLayer`, and the layer is disposed
before `initializationDone()` — landing straight in (2) above. One unusable cell costs the viewer,
not one neuron.

`out.neuroglancer` built its ids with `String(cell)`, which is two of those misses at once: a
label in the id column (`LC4`, a blank, a decimal) goes through untouched, and a wide `i64` cell
prints `1e+21`, which is invariant 8 exactly — a confident wrong id with nothing to say so. It is
`idText` then `isSegmentId` now, counting what it drops and saying so through `ctx.warn`. Warned
rather than thrown, per `docs/limits.md`: the scene is good without those rows, and the competing
reading of a short scene is that the neurons have no meshes.

**The filter itself is in `buildScene`, and the node's copy of it is the one that can explain
itself.** That split is the whole altitude question here. Filtering only in the node closes one of
two doors: `NeuroglancerProfileFrame` is the other `buildScene` caller and hands over whatever
`idText` read off a profile row — no grammar, by that function's own design — into the *same*
`NeuroglancerViewer`, so a profile over a relabelled table reaches the identical poisoned-hover
failure. `buildScene` filters `segments` and the keys of `segmentColors`, which makes "a scene
this module produces satisfies neuroglancer's grammar" a property of the module rather than a
discipline each caller keeps. It is silent there, necessarily: it is pure and has no `ctx`. So the
node filters first as well, for the one thing that layer can do — count the drops and say so. The
ids are tested twice on the node path; that is a few hundred regex calls against a silent viewer
death, and it was measured at +1.3 ms per 50,000 rows inside a function that already spends 1–17 ms
in `resolveColor`.

Worth knowing for the next person who chases this: it does not reproduce in Chrome or in headless
Firefox (no WebGL there, so the render paths that set `mouseState.active` never run), and it
cannot reproduce in a static deploy at all while the frame is pointed at a 404 — see the proxy
gate above.

A full navigation returns when `sceneIdentity` changes — everything outside the patch keys,
i.e. a different dataset or viewer. Merging across those would keep a camera framed on the old
volume, leaving you in empty space beside the one you asked for. The component also refuses to
merge before the frame's first `load`, or a selection changed during the second neuroglancer
takes to boot would merge onto its defaults.

**The Neurons port is `required: false`, and the empty cases do not throw.** A dataset alone
resolves to the published scene with no segments, which is a perfectly good thing to look at
— and an empty _table_ means the same thing, because that is what an untouched Explore Dataset
selection is and what a starter graph opens in. Only a port wired to something that is not a
table is an error. Getting this wrong turned the node into a dead card until someone had
ticked a neuron, which is the opposite of an exploration surface.

### Coda's own neuroglancer, and the `Selected` output

This paragraph used to say there would never be a `Selected` output, because a foreign-origin frame
cannot be read. The answer was to stop embedding a foreign origin: `neuroglancer.html` is a second
vite entry bundling **Spelunker** — CAVE's build, see below — so the frame is same-origin wherever
Coda is served. **Two questions, answered by different things.** The `Link`
is always the datastack's own viewer in that viewer's own format (`viewerBaseFor`, `viewerKind`),
so it opens the same thing for whoever it is sent to. What the *card* embeds is `Viewer type` —
Coda's copy (default), the dataset's viewer, or a custom deployment typed into `Viewer` with the
format named, since an unknown host cannot be read — resolved by `frameTarget`; the frame's scene
is rebuilt for that deployment by the same `sceneUrl` every navigation uses. Both params are
therefore **presentational**: nothing `evaluate` returns depends on them. Pointing the link at
Coda's copy was tried first and made it a fact about the host — a `localhost` URL out of
`pnpm dev`, a different link from the MCP server, which has no page — and letting `Viewer` change
the link made a shared link depend on somebody's embed preference. The old values migrate by
meaning rather than by a pass: `spelunker`/`seunglab` were set for a typed `Viewer`, which is what
the Custom options are, and the old default `auto` is a **retired** option (`absentMeans` too), read
as before. Any frame other than Coda's is one-way, apart from **From link**. Measured: about 1.5 MB of script, 433 kB
gzipped, loaded only inside the frame.

Eleven things that were each a way to get it wrong:

1. **Our own entry, not neuroglancer's `main.js`**, which imports `util/google_tag_manager.js` — a
   third-party tag in a build that otherwise ships only the gated GoatCounter one. `vite/entries.ts`
   keeps the page out of the sitemap and the analytics (a hit per mounted card is event tracking).
2. **The frame posts; nothing polls.** Neuroglancer writes its hash with `replaceState`, which fires
   no event, so `src/ngframe/main.ts` posts its state (`frameMessage.ts`) when the **layers**
   subtree's generation moves — a camera drag posts nothing — and reuses the JSON the hash binding
   already built (`getCachedJson`) rather than serialising a 38 kB state twice.
3. **Edits, not a snapshot** (`selectionEdits.ts`): one `ids` param of `+id`/`-id`, applied on top of
   the input, so an upstream edit keeps somebody's additions — one param because two are two undo
   steps. The viewer folds a report in **against the scene it last sent, never against the input
   table**, which can have moved in between; diffed against the input, every neuron an upstream edit
   added reads as one the user removed. A neuron toggled twice leaves no trace.
4. **A selection is set in place, not restored.** Restoring `layers` through the fragment — merge or
   splice alike — clears the layer list and constructs every layer again, which is the teardown the
   pointer hold exists for, and reloads every mesh. Where a new scene differs from the last one sent
   only in some segmentation layers' `segments`/`segmentColors`/`segmentDefaultColor`
   (`selectionChanges`, asked of every key of every layer), the card posts a
   `FrameSegmentsMessage` and the frame edits the live `selectedSegments`/`visibleSegments` and colour
   state, touching only ids that changed. No layer's lifetime is involved, so it applies **with the
   pointer inside**, the camera and layout untouched and loaded meshes kept — measured by the probe
   on the layer *object* surviving, which jsdom cannot see. It needs the frame to have reported once
   (`speaksFor`, keyed by deployment), so a typed `Viewer` and the dev proxy's demo keep navigating.
   The scene the node hands back after a double-click is this case with nothing left to change.
   A frame that cannot apply one (the layer renamed or deleted) says so (`FrameUnappliedMessage`),
   and the card stops updating in place and navigates, which restores what the scene needs. A
   navigation to another deployment loads a new document, so what the card knew about the old
   one — loaded, reported, told which keys are Coda's — is dropped with it (`forgetDocument`). And
   the neuron layer is found by **either** flavour's type: the card reads its own frame back
   against the link, which for FlyWire is written for the Seung-lab fork and names the layer
   `segmentation_with_graph`.
   Anything else — a layer added, `Layout`, a different dataset — still navigates and still waits.
   **An update set in place keeps the user's changes it was computed without.** The frame reports
   250 ms after a change settles, so an update the card sends inside that window — an upstream edit,
   a colour change — lists the selection as it was before the latest double-click, and applied
   wholesale it took the neuron back out with nothing recorded (the probe's "overtaken" check, which
   fails on the old frame). The frame keeps what the card last said each layer holds (`told`) and,
   per id, keeps its own state where the update says the same about that id as before
   (`keepUnseenChanges`). Where the update says something new about an id, the card has decided
   about it since and wins — which is also what keeps a neuron hidden under "leave Selected", a
   removal to the card, from coming back as hidden.
5. **An added neuron is looked up, in a `cheap` node** (`lookupNeurons`), which bends invariant 6 on
   purpose: it fires per double-click, settled by the frame, never per keystroke, and only for ids
   the input did not describe. Kept per dataset and id so a restyle asks nothing, and each id is
   answered only by the request that looked it up, or an id asked twice after an eviction comes back
   twice. Shared without a signal. A failure is never kept as an answer, but it is replayed for a
   minute rather than asked again on every upstream keystroke — under the token it was met with
   (`ReplayedFailures`, beside `memoPromise`, keyed on `DataSource.credential`), so signing in asks
   again at once, as does Invalidate Results. The rows fall back to an id each, with a warning. A segment
   the neuron table does not list (a fragment) keeps an id-only row, since somebody chose it.
6. **A report says which update it describes.** Every navigation (in the frame-only fragment key
   `codaUpdate`) and every in-place message carries a number; the frame echoes the last one it
   *applied* on each report, and the card folds only a report of its latest. Without it, a report
   taken before the frame handled an update (its settle timer already running) was read against
   the new scene, and every neuron the update added was saved as the user's removal. A message the
   frame cannot apply (no such layer) leaves the number behind, so its reports are dropped rather
   than misread — the frame stays stale until the next update instead of corrupting the edits.
7. **A double-click hides; it does not remove.** Neuroglancer's `select` action toggles
   `visibleSegments` only, so the neuron stays in the list as `!id`. `Hidden neurons` decides what
   that means: by default `Selected` is what is drawn and a hidden neuron is a removal (`-id`), so
   the chip goes on the next update; under "stay in Selected" it is noted as `~id`, written back as
   `!id`, and `Selected` gains a `visible` column — and only deleting the chip removes a neuron.
8. **The view is saved, against the rule for every other viewer.** `cameraMemo.ts` keeps a camera
   out of the document — six floats of somebody else's window aspect. Neuroglancer is the
   exception because a neuroglancer view is shared *as a place*: a workflow reopened, or a share
   link followed, has to land on the zoomed-in section somebody was looking at. The frame posts
   `VIEW_KEYS` (layout, position, orientations, scales, depths) once it settles; the card stores
   them in `view` with the dataset id (`encodeSavedView`) through a param declared **`unrecorded`**,
   which `setParam` writes with no undo step and no auto-run, so a camera drag is never what Ctrl+Z
   rewinds through, and undo and redo step around it: they lay the live value over whatever
   snapshot they restore (`withLiveUnrecorded`), rather than the write being copied into every
   holder of one — `past`, `future` and a gesture's start were each a copy, and the third was found
   by its bug. **The view a frame opens on is not saved** — it is the scene opening, and saving it
   wrote a camera into every workflow whose card had merely loaded. The frame decides that, where
   the navigation is seen: it notes the first settled view of a document and after each full
   navigation, and posts only views after it. The card used to skip one report per navigation
   instead, and the two halves disagreed whenever an opening changed no view, the frame then posting
   nothing and the user's next camera move being the one skipped.
   The view is applied **only by a frame opening from nothing**, never by a later
   full navigation — that one is somebody changing `Layout` or the dataset and means the published
   framing; and a view taken in another dataset is **cleared**, a camera being a position in one
   volume's coordinates. Frame only: the link opens the dataset's own framing.
9. **The bundle is Spelunker, built here and committed** (`vendor/`, `scripts/build-neuroglancer.mjs`).
   Spelunker is `seung-lab/neuroglancer`'s `spelunker` branch: Google's master with CAVE's commits
   rebased on top — middleauth that understands a terms-of-service refusal, graphene tools,
   annotation tags. It replaced the npm release, 2.41.2, which trailed master by a year: it could
   not load the public FlyWire segmentation (fixed upstream in `ca5cd35b3c`, carried for a day as a
   patch) and did not read `uiControlVisibility`, so the entry applied the layer bar by hand. Both
   went with the switch. Nobody publishes it, and the branch is **force-pushed**, so a git
   dependency pinned to a commit can stop resolving and would run neuroglancer's build on every
   install; the script runs the same `npm pack` the npm releases come from, at one commit, and
   writes the tarball and `vendor/neuroglancer.json` (which commit — the version inside still says
   2.41.2). **Its keybindings are enabled, and reach neuroglancer by a route of their own.**
   Spelunker's deployment injects `config/custom-keybinds.json` at build time as the global
   `NEUROGLANCER_CUSTOM_INPUT_BINDINGS`, read once as `default_viewer_setup` is evaluated, so the
   package carries none. The script vendors the file from the same commit and `src/ngframe/keybinds.ts`
   sets the global, imported ahead of neuroglancer — a runtime global rather than a vite `define`,
   which would have to reach into a dependency under the dev server. `m`, `c` and `f` arm graphene's
   merge, multicut and find-path tools (merge and multicut write to the segmentation, for anybody
   with access), and `Ctrl+Shift+X` clears the layer, which the card reads as every neuron
   removed — an undo step like any other. Keys pressed in the frame stay in its document, so none
   of them reaches the editor's shortcuts. They were left off for a day as a precaution and turned
   on at the user's request; there is no technical reason against them.
   **Nothing updates it by itself, so a weekly job says when it is behind**
   (`.github/workflows/neuroglancer-freshness.yml`, `scripts/check-neuroglancer.mjs`). It opens one
   issue with the tip, its newest commits and the update steps, updates it when the tip moves again,
   and closes it once the bundle matches. An issue rather than a red run, which would email only the
   workflow's last editor and say nothing about what changed; and a flag rather than an automatic
   rebuild, because an update wants the selection probe and a CAVE dataset checked by hand. It
   reports the tip's date and newest commits rather than a count of commits behind, the branch being
   rebased: after a rebase every commit is new.

10. **A key pressed in the frame never reaches Coda's document**, so the dashboard's ⌥1–9 did
   nothing once somebody had clicked into the scene — and neuroglancer, which binds `alt+digitN` to
   `toggle-pick-layer-N`, quietly changed a layer instead. The card tells its frame which chords are
   Coda's (`FrameKeysMessage`: ⌥1–9 while the dashboard is open, none elsewhere, where Coda leaves
   them free); the frame takes those in the capture phase, ahead of neuroglancer, and posts them
   back; the card re-dispatches each as a `keydown` on its own window, so `appShortcuts` decides
   exactly as for a key pressed outside — tour and all. A field in the frame keeps the key
   (`isTypingTarget`, moved to `core/keys.ts` so the frame can share it). The claim is re-sent on
   the frame's first report, a message posted before its script loads being lost. Other app keys
   (`D`, `F`, `I`, `/`) are not forwarded: neuroglancer uses single letters of its own.

11. **Coda's CAVE tokens are offered to neuroglancer as its credentials** (`src/ngframe/caveCredentials.ts`),
   so somebody signed in to Coda is not asked again inside the card. The frame's entry registers a
   `middleauthapp` provider before `setupDefaultViewer`, which copies neuroglancer's provider
   registry into the viewer it builds. Neuroglancer asks it per data server, when a layer first
   needs one, and it answers with Coda's token where that server's `/auth_info` names the login
   service the token came from (`codaTokenFor` — the rule neuroglancer's own middleauth applies,
   and the reason a server trusting another login service never sees the token). Otherwise, and
   once Coda's token has been refused, it hands over to neuroglancer's own provider, so the stored
   token or the sign-in popup work as they always did; a terms-of-service form accepted after a
   refusal earns Coda's token one more try. This **replaced a first version that wrote the token
   into neuroglancer's `localStorage` before boot**: that needed a three-second wait at start-up,
   a reload whenever a scene needed a server the boot had not covered (neuroglancer reads that
   entry once, and an in-memory token's `appUrls` never grow), a marker to keep neuroglancer's own
   sign-in from being overwritten, and a sweep for tokens forgotten in Coda — all of it a
   consequence of going through storage rather than the hook neuroglancer provides. Measured in a
   browser with a stand-in token: the frame's first request to FlyWire's segmentation carries it,
   nothing is written to storage, and the refusal brings up neuroglancer's own login prompt.

Two dev-server traps, both silent: the page was first named `ng.html`, and the `/ng` proxy key
matches by prefix, so the dev server forwarded the page itself to the public demo and it 404'd
(measured). The page was renamed `neuroglancer.html`, which no prefix catches, and the key anchored
anyway (`^/ng(?:/|$)`) so the next `/ng…` path is not caught either. And vite's dependency pre-bundling put neuroglancer in `.vite/deps`, where its
`new Worker(new URL('./chunk_worker.bundle.js', import.meta.url))` 404s — a scene with no meshes
and no CAVE sign-in, and only in `pnpm dev`. `optimizeDeps` excludes it and pre-bundles its
CommonJS dependencies by name. `pnpm probe:neuroglancer-select` drives the whole loop in a browser.

Limits: only the dataset's own segmentation layer is read back, so a neuron added in a second
volume of a multi-volume scene (a BigClust project) is not seen; FlyWire's public segmentation
fails in mainline and spelunker alike, upstream; and the exporters still refuse the node, so a
`Selected` wired downstream blocks the notebook.
