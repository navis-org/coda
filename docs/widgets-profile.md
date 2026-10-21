# Widgets: Neuron Profile

Neuron Profile: one neuron, or one group, at a time. [widgets.md](widgets.md) is the index.

## Neuron Profile: one neuron at a time

`out.profile`, the counterpart to Explore Dataset one level in — Explore Dataset answers "what is in this
dataset?", Neuron Profile answers "what is this cell?". Modelled on Codex's Cell Details page. It takes
a whole neuron collection and pages through it, so it works on an Explore Dataset selection or a
Connectivity result, not only a hand-picked body.

**Browse free, pin to commit — the whole design turns on this.** `page` is presentational, so
flipping through twenty-seven neurons costs nothing and invalidates nothing; `selection` is not,
and it is what the `Current` port emits. Had the page index fed `Current` directly, every press
of the pager would mark the downstream graph stale, and with auto-run on would fire a full pass
per page turn. Same live-widget/committed-param split that makes Explore Dataset feel like a browser.
`profile.test.ts` asserts it through the scheduler, because dropping the flag fails no type
check and the symptom — a graph going stale whenever anyone browses — reads as a scheduler bug.

**A grouped number is wider than an ungrouped one, and the list rows could not pay for it.** The
first version printed `stat()` everywhere, so a row that said `30 · 39% · 2` came to say
`4.2±5.3 · 39% · 1.5±2`. A bar row is `key | track | value` with the value on an `auto` grid
track, so those extra characters come straight out of the bar — on a 190px tile column the tracks
lost about half their width, and the one thing the list exists for, comparing lengths, got *worse*
the moment you grouped. The headline facts had the mirror-image problem: `26.5 ± 37.5 in · 35 ±
49.5 out` is one nowrap line with an ellipsis, so the "out" half was silently truncated.

Three rules came out of it, and the first is the general one:

- **A list row prints the mean; the spread is a mark, not text.** `mean()` is what every value
  and detail slot uses, and ±1 sd is drawn as a whisker on the track the bar already occupies —
  zero horizontal cost, and the exact figures stay in the row's tooltip. Achromatic (`--text-muted`)
  because colour on this card is the categorical channel and a spread is not a category, with a 1px
  surface ring so it stays readable where it crosses the fill. `stat()` is now used *only* where a
  value has a line to itself.
- **The lower arm clamps at zero.** On a real cell type the sd routinely exceeds the mean, and an
  unclamped arm draws a negative synapse count.
- **A compound fact splits when grouped.** Four short rows beat two truncated ones; the compact
  `in · out` form stays where it still fits.

Checked by rendering it — `.tile__bar`'s `minmax(36px, 1fr)` track floor and the whole layout were
established against headless Chrome at 190px columns in both themes, since jsdom performs no
layout. `profileViewer.test.tsx` can still assert the rule that matters (no `±` in a
`.tile__bar-value`, a `.tile__bar-spread` per multi-member bar), which is what stops it coming back.

**A subject is a neuron or a group of them, and `Group by` is presentational too.** With it set the
pager pages cell types instead of cells and every tile draws a mean with a spread. That could
easily have reached the ports and does not, because **a pin resolves the group to its member ids
at pin time** — `selection` is a list of neurons under both modes, so `evaluate` is untouched and
`Current` never acquires a second meaning. `profile.test.ts` asserts it through the scheduler for
`page`'s reason.

A **column picker rather than a `Show types` boolean**, and that is not taste. A boolean has to
name `type`, which is the one thing this widget's own rule forbids: CAVE and CATMAID spell it
differently, a table through Select may not carry it, and `Match Cell Types` publishes a *shared*
label that is the only sensible subject for a cross-brain profile. The same control then profiles
by hemilineage, by class, or by a `Cut Tree` cluster for nothing extra. `optional`, because
`resolveColumn`'s rule 3 substitutes the first compatible column for a *required* picker the
schema has no default for — which here would group every profile by whatever column came first,
on graphs saved before this existed.

**The grouped answer is the ungrouped one folded, by construction.** `profileStats`' subject layer
partitions the fetched table by member and runs the *same* single-neuron roll-ups on each part —
one `selectRows` per member over a partition, so O(rows) overall. **The partition is a value the
caller holds**, not a memo inside the stats module: six roll-ups read three partitions, so
building one per roll-up re-copied a whole direction of connectivity three times. It was a
`WeakMap` here first, which made a pure module's hit rate depend on the *viewer's* `useMemo` —
silently quadratic for any other caller — and pinned a second copy of every cached table for as
long as the cache held it, which `keyedCache`'s row budget does not count. Passing it in says the
same thing in the type and lets the memo that owns the lifetime be the one that can see it. Reimplementing the roll-ups over
a grouped table was the obvious reach and is how the two modes come to disagree: the untyped
bucket, the `>= minWeight` boundary, the distinct-partner count and the nested-ROI filter are each
a decision made once, and a second implementation gets one of them wrong in a way that still draws
a plausible bar.

**Absent is zero here, and that inverts `groupByTable`'s rule on purpose.** There a group holding
no number is *unmeasured*, so its mean is null. Here the fetch enumerated every partner of every
member, so a member with no row for a partner type has been measured and the measurement is zero —
averaging over only the members that connect would report that mean under the type's name. Which is
exactly why `Aggregate.present` sits beside `mean`: 4 across thirty cells where two connect is a
different fact from 4 where all thirty do, and the mean alone cannot tell them apart. Two
measurements deliberately go the other way, and both say so where they are computed — a transmitter
*probability* and a table attribute like `size` are genuinely unmeasured when absent, so their
denominator is the members that publish one. `sd` is the sample deviation and **null below two
members**: the spread of one measurement is unknown, not zero, and `12 ± 0` is a claim one neuron
cannot support.

**A large group is deferred, not refused.** `Group by` is a column picker, so `status` is one
mis-click from asking a connectome for every traced neuron's partners between two presses of ›.
Above `MAX_AUTO_MEMBERS` (50) nothing is fetched until the banner beside the pager is answered —
and **nothing local is computed either**, which is the half a fetch gate does not cover on its
own. A deferred subject has tens of thousands of members by definition, so materialising a record
per row and running the per-column consensus over them is rows × columns of work per press of ›,
while the banner says nothing has loaded. A subject nobody asked for computes nothing.
Approvals are a **set of subject keys**, and the gate asks the cache first: approving one type must
not approve the next one the pager lands on, must not un-approve the last, and must not re-ask
about an answer already in hand — the approvals are the component's and the cache is the module's,
so paging back to a type you loaded would otherwise demand the decision again.
That is a deferral rather than a refusal, which is what [docs/limits.md](limits.md)'s rule
requires — the answer is well defined at any size; what is unreasonable is asking for it by
accident. One banner naming the group and its size, not a button in each of six tiles: six
buttons for one decision reads as six decisions.

**The cache grew a row budget with it.** Twenty-four single neurons is a few thousand rows;
twenty-four cell types is a dataset's connectivity, so `keyedCache` gained an optional `budget`
(a `weigh` function and a `max`, as one object so "both or neither" is a thing the type says) and
`useNeuronProfile` finally joined the two hooks already using it. `clear()` gained a generation
guard at the same time, which is a real bug and not only a test-isolation one: a request issued
before the reload button was pressed used to write its result into the store just after, so
"forget everything and ask again" returned the answer it had been told to discard.

**`minWeight` and `topN` are presentational too, and that is not an oversight.** Neither can
change a byte of what either port carries: the outputs are the pass-through and the pinned row.
They decide what the widget draws. The threshold is also not passed to the fetch, so raising it
never costs a round trip — one request at weight 1 serves every threshold above it.

**`cheap`, despite the widget fetching.** `evaluate` touches no network at all. The connectivity
and ROI requests are the widget's, issued per neuron _viewed_. Same reasoning as
`out.neuroglancer`.

**Three requests per neuron, and identity is free.** Type, classification, transmitter call and
synapse totals all come off the neuron's own row in the incoming table, which already carries
every column schema discovery found — no index download, no query. Only the two connectivity
fetches and the ROI breakdown go to the wire, and they are cached per body.

**`roiInfo` nests, so the region bars must filter.** A synapse in `LO(R)` is counted again in
its parent `OL(R)`; summing the raw blob reports roughly twice the neuron's synapses. Only
`Meta.primaryRois` names a set that tiles the volume, so `DatasetInfo` grew `primaryRois` and
`runDiscovery` now captures it — the Cypher already returned it and threw it away. Note the
`ordered` swap at the end of discovery is now unconditional: it carries the ROI list as well as
the statuses, and a dataset whose status sample came back empty would otherwise keep handing out
an info without it. When the list has not arrived the widget says the totals may double-count
rather than presenting them; `undefined` is not `[]`.

**Paging is debounced, not aborted, and the distinction is load-bearing.** Two profiles on the
same neuron share one in-flight request, so cancelling on unmount kills the fetch the other one
is still waiting for. Not fetching for `SETTLE_MS` has no such failure mode, and a neuron already
cached skips the wait entirely — so paging back through what you have seen stays instant.

**The card and the overlay show different 3D on purpose.** The card draws the cached coarse
silhouette of the first member — a silhouette is a shape, and the tile does not claim it is the
average of anything — while the overlay draws **every** member, capped at 25 segments and saying so,
because a cell type drawn as one of its cells is the least useful of the available pictures. The card's
is free and usually already fetched by Explore Dataset; the overlay mounts a live neuroglancer
frame, in a tile that is **2×2**. A grid column is ~190px, which is not a 3D viewer — it is
about the width of neuroglancer's own layer bar, so a one-cell tile showed the chrome and
nothing else. The `min-height` on that rule is the half that actually does the work: rows are
auto-sized, so spanning two of them beside tiles that are five lines of text tall resolves to
roughly one card's height, and the span alone would make the tile wider and no taller — which
looks like it worked. `profileViewer.test.tsx` asserts the declaration, since jsdom does no
layout. **The floor belongs to the viewer, and the tile has to keep its automatic minimum** — a
`min-height: 0` on the tile itself stopped the rows growing at all, and the frame hung out of the
bottom of its tile instead: measured in a 625px dashboard cell, 236px of it over Top input types,
Top output types and both partner lists. Nothing clips a grid item's overflow, so it read as the
frame being drawn on top of the card; the test now refuses that declaration too. The frame also
passes `NeuroglancerViewer` a `summary`, because its segments travel in the scene rather than as a
`neurons` table, and the viewer's own count captioned a drawn neuron "no neurons connected". (`uiScale` is the other lever for the same complaint; the frame does not use it yet.) Each frame is a full WebGL application that starts fetching EM on mount and a canvas can
hold a dozen profile cards. The card carries an `Open 3D` control inside the tile, because a
difference the user cannot see is a bug. `NeuroglancerProfileFrame` wraps `NeuroglancerViewer`
rather than reimplementing it — the `#!+` merge is what keeps the camera across a page turn, and
it was established against the deployed viewer rather than reasoned about.

**The frame hides neuroglancer's layer bar, and the link does not.** The strip of layer chips
along the top costs the tile a real share of its height, so `NeuroglancerViewer`, unless told otherwise,
writes `uiControlVisibility.showLayerPanel: false` (`withLayerPanel`) into
what it points the *frame* at. The same `url` is what ↗ and ⧉ hand out, and a scene opened in a
tab of its own has the room, so the key is applied at navigation rather than built into the scene:
nothing has to be stripped on the way out. The profile tile deliberately has no control to bring it
back — the link is the way to see the full UI. Checked against the deployed bundles: the demo deployment and
spelunker restore the key as state; `ngl.flywire.ai` has the control only as a constructor option,
so a FlyWire profile keeps its bar — an unknown key is skipped, not refused.

**The Neuroglancer node hides it too, on every surface, unless its `Layer bar` param asks for
it.** It used to go with `compact` — hidden on the card and the inspector, shown in the overlay, the
dock and a dashboard cell — and was changed on request (2026-10-14) to an inspector-only boolean,
off by default, so the expanded node matches the card. `presentational`, like `Interface scale`:
it reaches only the frame, never the URL. The profile tile passes nothing and stays hidden. The
trap is that the card and the overlay share **one kept frame**, and the setting can change while it
is loaded, so it cannot be an opening default only. Three routes, all in the navigation effect,
with `HeldFrame.applied.layerPanel` recording what was last sent:

- **Only the setting changed, frame loaded:** a `#!+` patch (`patchUrl`) holding `layerPanelPatch`
  and nothing else. `#!+` is `restoreState` without `reset`, so no layer is rebuilt and the camera stays; and
  `showLayerPanel` is the *only* member of the state's `uiControlVisibility`, so restoring that key
  resets nothing beside it. Sent immediately and not held for the pointer, since no layer is
  touched. Explicit `true` when showing, because a merge leaves an absent key alone.
- **Not yet loaded:** the full navigation carries it — a fragment-only patch landing as the opening
  navigation would leave a scene holding nothing but the bar.
- **A full navigation, including one resumed from `sceneMemo`:** the setting is applied
  whatever the state came from, since a state read off the frame carries what it last showed.
  Showing *removes* the key rather than writing `true`, so an untouched scene comes back as itself.

A selection merge carries the bar only when it changed in the same pass, so a bar somebody toggles
inside the viewer stays put until the setting changes.

**A tile renders only when its data exists.** Datasets disagree about nearly everything, so a
tile that cannot say anything is absent rather than full of dashes, and nothing in the widget
names a column that must be present. `transmitterReading` matches by name against whatever
discovery found — and checks presence _before_ `Number()`, because `Number(null)` is 0 and a
missing probability would otherwise draw a confident zero-length bar. Same trap `numeric()`
exists for.

Two small general changes came out of this, both worth knowing about:

- **`ValuePreview` gained `onParamChange`.** The viewer-to-node write path was hardcoded to
  `selection`; the pager needs `page` as well. `onSelectionChange` stays as the narrow
  convenience for the three viewers that only ever write a selection.
- **`ColumnsParam` gained `optional`.** A decorative picker with nothing to offer is not an
  issue — Neuron Profile's `Tags` on a table whose schema is not yet known was raising a warning badge
  about a control nobody had touched, which is how a real issue further down the list stops
  being read.
