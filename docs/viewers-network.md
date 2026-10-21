# Viewers: networks and flows

The Network Viewer and the value model it shares with the geometry viewers, Network Metrics, the
Flow Chart and the Sankey. [viewers.md](viewers.md) holds what every viewer shares — export,
tooltips, table filtering and the styling sidebar.

## Network Viewer + 3D widgets

**Value model.** `Network`, `Skeletons`, `Meshes` and `Points` all pair geometry/topology
with an ordinary Coda **attribute table** (one row per node/item/point, in the same order).
That is the whole trick: column pickers, encodings and future analysis nodes all reuse the
table machinery. `attributeSchema(type, part)` reads that schema off a type, which is why
"colour by [type]" populates on a Network socket exactly as on a Table.

**`BuildNetwork` carries edge attributes, and the merge rule is where the care went.** It used
to emit exactly `source`/`target`/`weight`/`edges`, dropping every other column of the incoming
edge table — which is also why a categorical _link_ colour had almost nothing to bind to.

**`Keep columns` empty means all of them**, not none. That matches the node half of this same
node, which has always taken every joined column, and the `chips` idiom where empty means
"decide for me". Four kinds never ride along: the four names this node owns, plus the source,
target and weight columns themselves, which are already carried under those names.

**Where parallel links merge, a value survives only if every merged row agrees on it** —
whatever its type — and is empty otherwise. A link standing for forty synapse groups across
five ROIs has no single ROI, and naming the first row's would be a confident lie; `edges` says
how many rows are behind it.

**Numbers are deliberately not summed, and this was got wrong first.** Summing is right only
for a measure, and nothing in a dtype separates a measure from an identifier or a code: on a
real male-CNS connectivity table it added `preId` up to 24093454514 — noise, and noise offered
to the numeric pickers where it could have driven a size encoding. `weight` is the one additive
channel; a second additive quantity belongs in a `groupBy` upstream, which names its result
honestly as `sum_x`.

Note the disanalogy that made summing look safe: `nodeSchemaFor` carries everything without a
merge rule because a node join is one row per node. Only edges merge.

`keptEdgeColumns` is called by both `inferOutputs` and `evaluate`, so invariant 3 holds by
construction. And loading does _not_ fill missing params with defaults, so a graph saved before
the param existed has no `keep` key — `resolveColumns` reads that as `[]`, which is why empty
had to mean "all" for those files to gain anything.

The viewer was never the culprit: `out.network` passes the network through and `filterNetwork`
uses `selectRows`, which preserves the schema whole.

**Encodings** live in `style/encoding.ts` (resolution) and `nodes/lib/encodingParams.ts` (param
factories, headless). Never re-implement colour mapping in a viewer — the 8-slot cap, the
achromatic Other fold, area-scaled sizes and null-as-grey are enforced in one place.
`numeric()` exists because `Number(null)` is `0`, which silently painted missing data as the
ramp's minimum.

**Two colour modes are network-only, and neither can be a column.** A node's **connected
component** is not in the attribute table — it is derived from the link set — and a link
coloured **by its upstream node** does not resolve against the edge table at all: its answer is
the *node* encoding's answer for a different table's row. A column picker can only offer what
the schema already has, so both are modes, in the way `hash` is. `networkColor.ts` holds them,
headless, and its whole job is to hand `resolveColor` something it can already answer — the
palette, the eight slots, the achromatic `Other`, the null grey, the overrides and the legend
all stay in one place.

**Components are numbered by size and that makes two orderings agree by construction.**
`connectedComponents` numbers largest-first; `resolveColor` ranks categorical slots by
frequency. So the legend reads left to right in the same order as the sizes, and "1" means the
giant component — which on a connectome is the reading everybody already has. It is
**undirected**, like `expandSelection`'s `component` scope, and `networkOps.test.ts` asserts the
two agree rather than trusting that two walks written for one rule stay one rule: a viewer
colouring by component beside a menu selecting one are two statements about the same partition.

**The component keys are the one node channel that gets a name.** Node groups are otherwise
unnamed in the strip — nodes being the default subject of a node-link drawing — but `1 2 3 4`
with nothing saying what the numbers are is where that economy costs more than it saves.

**A link borrowing an endpoint's colour reads the resolved node channel, not its spec.**
Whatever a node ended up painted — palette slot, folded `Other`, hand-picked override — is what
its links take, by construction rather than by the rule being written down twice. And it
deliberately produces **no legend**: the node key already names every colour on screen, and a
second strip repeating those swatches under the word "links" is the stutter `NetworkLegend`
exists to avoid. `labelAt` is still carried through, so a link stays addressable by the key its
endpoint belongs to.

Note what this is *not*: picking `source` in the categorical picker. That has always worked and
answers a different question — it ranks the palette by link count and lands on colours that
disagree with the nodes an inch away. The point of the mode is agreement.

**Verified in a real browser**, since a colour is the thing no test can see: a weight filter
fragmenting the example into eight components, each drawn in one colour and none shared; then
nodes by category with links by upstream, every link the colour of the node it leaves, and by
downstream, every link the colour of the node it enters — including the grey ones, where both
endpoints had folded into `Other`.

**Categorical colour cycles here; it folds in the charts.** `resolveColor` used to put
everything past the eighth slot into an achromatic `Other`, on the grounds that a repeated hue
claims two categories are the same thing. That reasoning holds exactly where the *mark* folds
too — a bar, a slice, a histogram segment and a box all sum or drop the tail into one shape,
which needs one colour, and `foldByRank` still governs them. It does not hold for a node, a
point or a neuron, each of which keeps its own mark whatever colour it is handed: folding bought
nothing and cost everything, since on a connectome the ninth cell type onwards is most of the
picture and all of it was grey.

**The cost of cycling is said out loud in two places**, because two categories a palette-length
apart do share a hue. `+N more` on the legend once there are more keys than `LEGEND_KEYS` (12),
and `colours repeat` in the caption off `CategoricalLegend.cycled` — the admission
`out.dendrogram` has always made, now that the network can need it too. A legend cannot carry
the second one itself: two identical swatches read as a mistake rather than as a statement.

**The exported SVG legend admits its remainder too, and that is a fix rather than a feature.**
`drawLegend` has always stopped when it ran out of width, silently — so a figure with nine
types and room for four was a figure of four as far as the file was concerned. It now counts
what it skipped *and* what the encoding left unlisted, and prints one `+N more`.

**Five palettes, one dropdown per channel.** Node and link get their own, because the two halves
of a network are styled apart everywhere else on this node and a link categorised by ROI has
nothing to do with a node's cell types. The dropdown is hidden for every mode that cycles
nothing — `constant` and `literal` name their own colours, `sequential` is a ramp, `hash` derives
one per value, and a link taking its endpoint's colour is reading the *node* channel's palette
rather than one of its own.

The values are published sets transcribed whole and only `coda` is validated for this app; the
**order** is ours, since `resolveColor` gives the leading slots to the commonest values. See the
note in `colors.ts` for what that rotated and why, and CLAUDE.md for the rule.
**Adding a sixth palette means transcribing a published set, never mixing hues** — the rule the
heatmap's ramps follow too (see *The palettes are transcribed* below). The imported four are one
set for both themes, so their pale members are weak on the light surface: that is the price of the
capacity, and the param's help says so rather than the set being retuned per theme.

**`CHART_INK.grid` is for chrome only; anything carrying data takes `muted`.** The grid ink sits
under the 3:1 non-text floor on purpose — gridlines are meant to be invisible — so a network link
or its arrowhead drawn in it is data drawn below legibility. `muted` is the data ink for those, and
it is achromatic so it never competes with a categorical encoding.

**Sequential colour is for area marks, not for hairlines — and that is measured.** Link
colour offers `constant` and `categorical` only. The blue ramp's receding end is **1.46:1**
against the dark surface: correct under a heatmap cell or a node disc, where a low value is
_supposed_ to recede into the page, and invisible on a 0.5px line. Clamping the ramp to clear
the 3:1 non-text floor works — dark reaches 3.23:1 using ramp steps 0–8, light 3.54:1 using
6–12 — but squeezes adjacent steps to ΔL **0.047** dark / **0.035** light against a 0.06 floor,
so it buys visibility with step separation and the validator fails it either way. Link weight
already has an honest channel in `Width`. `ColorParamOptions.modes` is how a caller declines a
mode; if someone re-adds `sequential` for links, `paramGroups.test.ts` is the tripwire.

**Node borders are ours, and two things about them are load-bearing.** Sigma itself ships only
`NodeCircleProgram` and `NodePointProgram`, and a border is what stops a node dissolving into
the links crossing behind it; `@sigma/node-border` supplied one until the shape channel needed
a program of its own, and `nodeShapeProgram.ts` now draws both (see below — the dependency is
gone). First, the outline eats _inward_ from the radius, so `applyStyle` adds the border width
back onto the encoded size — without that a size-4 node loses 44% of its area to a 1px outline
and the size legend stops telling the truth. Second, a node program's own `drawLabel`/`drawHover`
take precedence over the settings, so declaring them would silently discard the haloed labels
and the selection ring. Ours declares neither, deliberately.

**Alpha rides in the colour, because sigma takes one colour per mark.** `withAlpha` folds a
constant link opacity into `#rrggbbaa`, which sigma's `parseColor` reads. Two consequences
worth knowing: `mixHex` carries an alpha byte through a blend untouched — dimming a translucent
link must not make it opaque — and the SVG export calls `splitAlpha` to write `stroke-opacity`
rather than an eight-digit hex, because an exported file outlives the browser that made it.

**The legend strip keys four channels, and only two of them used to exist on screen.** Node
colour, node size, link colour, link width. Before this the screen drew categorical swatches
and nothing else, while `networkToSvg` had always appended a legend — so a sequential encoding
had no key at all on screen and neither size channel had one anywhere. In `compact` the
identity keys survive and the magnitude ramps stand down: a categorical colour without its key
says nothing, whereas a size ramp annotates a comparison the reader can already make by eye,
and its row costs a tenth of a 150px card.

**Selection is not presentational.** `kind: 'ids'` params are written by viewers, live in the
saved file, and take part in the provenance key. Marking one presentational would let a
stale downstream result survive a selection change.

**The Network Viewer filters its own output, and that is the one place it stops being a
tap.** `minLinkWeight`, `topNodes` and `hideIsolated` are **not** presentational: they change
what `evaluate` returns, so they join the provenance key and stale everything downstream. The
alternative — filtering only the drawing — leaves the picture disagreeing with every node
wired after it, which is worse than the cost. `networkOps.ts` holds the logic, headless.

No widget-local preview path exists, and that is deliberate: `out.network` is `cheap`, so the
ordinary 180ms pass already redraws while you drag. Explore Dataset's live-widget/debounced-commit
split is for an `expensive` node; copying it here would put a filtered picture beside a stale
downstream graph and have the two disagree, which is the failure being avoided.

**The three filters apply in a fixed order, and the order is the point.** Weight cut, then
top-N ranked _over the links that survived it_, then isolated nodes. Ranking before the cut
answers a different question — "the biggest players in the graph I am looking at" is the
useful one. Ties break on id, because the result reaches a provenance key.

**Filtering recomputes `degreeIn`/`degreeOut`/`weightIn`/`weightOut`.** They are roll-ups
`BuildNetwork` derives from the link set, so a node still claiming `degreeOut: 7` after four of
those links were cut is not merely stale — it is driving a size encoding and a tooltip that
contradict the picture beside them. Only those four names, only when the schema has them; a
network from elsewhere is untouched.

**A tab that changes data has to say so.** `ParamGroup.affectsData` is what widens the panel's
presentational-only admission rule (`paramsForPanel`), and it is also what makes the tab render
its warning. Presentational-only is the promise that makes a styling panel safe to touch;
breaking it silently, so a graph goes stale with no visible cause, is exactly the confusion the
note prevents. The caption carries the other half — `N nodes, M links filtered`, in the same
idiom as `labels thinned`, because a graph that is simply smaller than its data with nothing
saying why is the failure that note already exists to avoid.

### Shape, the channel that survives without colour

**Six marks, and the sixth is the last one.** `resolveShape` sits beside `resolveColor` in
`src/style/encoding.ts` and mirrors it exactly — same frequency ranking so the commonest value gets
the most distinguishable mark, same `—` key for a null, same `Other` label, same override-wins
rule — with one deliberate departure: **it folds where colour cycles.** Cycling a hue is
survivable because there are twenty of them, the eye reads position too, and the caption admits
to the repeat. There are six shapes; a seventh category drawn as a second circle is a claim that
two categories are the same thing, and nothing downstream can undo it. So the tail folds onto
`OTHER_SHAPE`, a **dash** — chosen because it shares no silhouette with any of the six, where
folding onto `circle` would make the residual bucket indistinguishable from the commonest
category.

The point of having it at all is in CLAUDE.md's palette note: only three chromatic families clear
the all-pairs colourblind gate on the dark surface, which is why a socket is colour *plus* shape
*plus* a label. Pointing `Shape by` and `Colour by` at one column is two channels saying one
thing, and it is what makes a categorical network readable to a reader who cannot separate the
hues, or in print.

**Sigma draws one shape and we replaced its program to get seven.** `@sigma/node-border` was
supplying the outline, and its generated fragment shader is `length(v_diffVector)` at every
setting — there is no per-node shape to be had from it. `nodeShapeProgram.ts` is that program
rewritten: the circle test becomes a signed distance function chosen per node, and the border is
written out rather than generated, because it was only ever an outline plus a fill. Ours rather
than a patch, deliberately — the `flexLineMaterial.ts` precedent has to throw when a patch site
stops matching, and that cost is worth paying where the library's shader does something
irreplaceable. Here it does `length()`. The dependency is **removed**, not merely unused.

Four things about it are load-bearing and none is visible in a test, because jsdom has no WebGL:

- **Sigma blends premultiplied.** `gl_FragColor = vec4(paint.rgb, paint.a * inside)` leaks the
  colour at full intensity wherever alpha is near zero, which paints the **whole vertex triangle**
  in the border colour: a grey wedge behind every node, scaled with it. It reads as a geometry or
  an antialiasing bug and is neither. `mix(transparent, paint, inside)` is the fix and is the
  idiom every sigma program already uses.
- **The vertex quad inscribes a circle of exactly `v_radius`**, and the marks do not fit inside
  it: they are sized for equal *area*, so a square's corner sits at 1.25 (`SQUARE = √π/2`).
  `MARK_EXTENT` — derived from the geometry, so a new mark cannot silently overflow it — grows
  the quad while `v_radius` stays put. It is spent **per shape**: a circle needs no margin and is
  the default mark, and paying the full margin for every node rasterises 1.8× the fragments an
  unshaped network needs, where node fill is the dominant fragment cost.
- **One definition of what a diamond is**, in `markGeometry.ts`. The marks are drawn by two
  unrelated back-ends — polygons on a canvas and in SVG, signed distance functions in a shader —
  and the constants used to be written out in both languages with a comment on each saying they
  matched. That is the wrong thing to hold together with a comment: the failure is a network and
  a scatter drawing one category at different weights, which turns shape into an accidental
  magnitude channel. The GLSL is now **generated** from the same constants the polygons are, and
  `markGeometry.ts` imports no sigma, so `markGeometry.test.ts` samples a grid and pins the two
  against each other.
- **The shader flips `p.y` on entry, and the triangle is why.** `markVertices` is screen-space
  (y down, apex at negative y, pointing up); the shader runs in sigma's graph space, where y runs
  up. The triangle is the only mark not symmetric about y, so without the flip it renders
  point-down on the canvas while the legend and the SVG export draw it point-up — from the same
  numbers. That is exactly the failure the shared constants were meant to prevent, arriving by a
  route the constants could not close; a test covers it.
- **The shape's number is `ALL_SHAPES`'s index**, not a table in the program. A second numbering
  is a second thing to keep in step with the vocabulary, and this one crosses into a vertex
  buffer where a mismatch draws the wrong mark in silence.

**The module cannot be imported by a test at all**, not merely untested: `sigma/rendering` touches
`WebGL2RenderingContext` at module scope, which jsdom does not define. It is loaded through the
same dynamic `import()` as sigma itself, inside the viewer's effect. A static import took every
test that renders a network down with it.

**Overrides are pinned from the legend**, which is new surface for this viewer — its colour key is
still inert, and its overrides remain reachable only from the 3D viewer's legend and the
inspector. The mark stays drawn and a transparent `<select>` sits over it, the same trick
`legend__swatch--input` uses for colour. A menu rather than colour's OS picker because the two
channels differ in kind: someone overriding a colour usually wants the one colour *not* in the
palette, so only the native picker has it; there are six shapes and no seventh to reach for, so
the whole vocabulary fits in a menu — and a menu can say `diamond` where a swatch can only show
one.

### The prefuse layout, and why a fragmented graph is a different problem

**It is the default**, ahead of ForceAtlas2, because a default has to be right for the graph
somebody actually has. On a graph that is genuinely one component the two are both ordinary
force layouts and the choice is taste; on a fragmented one ForceAtlas2 cannot draw a picture at
all, and fragmented is the ordinary case for a correspondence graph, a thresholded network, or
anything where most nodes have one or two links. Changing the default reaches only *new* nodes —
`defaultParams` writes the value in at creation — so every stored graph keeps what it was saved
with.

**Making it the default is what forced the slicing.** The component loop's yield cannot interrupt
a *single* component, and an ordinary connectome is one component, so the default layout would
have frozen the tab for the whole run — exactly the failure that moved ForceAtlas2 into a worker.
`prefuseRun` exists for that: the simulation is resumable, and above `PREFUSE_SLICE_ABOVE` (200
nodes, the size at which one whole component costs one yield window) `prefusePositions` advances
it a pass at a time against the clock. Measured longest main-thread block, which is what a frozen
tab actually is: 500 nodes 64ms, 2,000 71ms, 5,000 93ms, 12,000 97ms — against un-sliced runs of
234ms, 1.2s, 3.4s and 8s. It costs about 16% in wall-clock and buys a bounded hitch at any size.

The annealing state is carried *on the run* rather than recomputed per slice, and that is
load-bearing: `timestep *= (1 - i/total)` compounds, so a slice that restarted it would re-heat
the simulation on every yield and drift further from the settled layout the more often the thread
was handed back — while still producing something that looks like a picture. `prefuseForce.test.ts`
pins slices against a straight-through run for exact equality.

**A force simulation cannot draw a graph that is mostly not connected, and no amount of
tuning fixes it.** This was built for a real 36,171-node graph — the correspondence graph a
`Match Cell Types` node emits, neurons on one side and labels on the other — with 24,750
links. Those numbers force the shape: 24,750 links cannot connect 36,171 nodes, so the graph
is **11,936 separate pieces**, the largest of them 39 nodes and 11,767 of them ten nodes or
fewer. There is no giant component at all. Median degree is 1.

Scored by `neighbourPurity` — how much of a node's on-screen neighbourhood belongs to its own
component, which is the only thing the picture has to get right when every component is a
separate correspondence group:

| layout                              | time  | purity |
| ----------------------------------- | ----- | ------ |
| ForceAtlas2, ~25 iters (its budget) | 2.6s  | 0.047  |
| ForceAtlas2, 100 iterations         | 10s   | 0.038  |
| ForceAtlas2, 1,000 iterations       | 115s  | 0.033  |
| spectral                            | 0.2s  | 0.219  |
| prefuse, whole graph (hits budget)  | 8s    | 0.009  |
| **prefuse, per component**          | 0.6s  | **0.431** |
| a naive grid packing, for reference | —     | 0.367  |

Three findings, none of them the obvious one:

- **ForceAtlas2 gets worse the longer it runs.** It is not slow to converge; it converges
  fine, and what it converges to is a uniform pile. Its gravity draws every component into one
  well and no edge exists to push two of them apart, so the equilibrium *is* the interleaving.
  Reading "too slow" and reaching for more iterations makes the picture worse and costs 79
  seconds to do it.
- **The force law buys nothing.** Prefuse on the whole graph scores 0.009 — *below* the
  ForceAtlas2 it was brought in to beat. Anyone who reads this feature as "a better force
  simulation" has read it wrong.
- **The partitioning is the entire win.** Lay each component out on its own and pack the
  boxes, and the same simulation goes from 0.009 to 0.431 — past the naive grid packing that
  was meant to be the reference — in half a second. This is what Cytoscape's "Prefuse Force
  Directed Layout" actually does: its `AbstractPartitionLayoutTask` splits into components
  before laying anything out, which is why its output looked so much better than ours on the
  same file.

So the layout is prefuse's force simulation (`prefuseForce.ts`) plus component packing
(`componentPack.ts`), and the second is the part that matters. The `Components` param spells
the choice — Cytoscape spells the same one as a "singlePartition" checkbox — and `all at once`
is kept only so the comparison can be made rather than taken on trust.

**Faithful to prefuse's constants, because they are what Cytoscape's output was judged
against**: `NBodyForce(-1, -1, 0.9)`, `SpringForce(1e-4, 50)`, `DragForce(0.01)`, a
Runge-Kutta integrator, speed limit 1, and the annealing schedule from
`ForceDirectedLayout.run()` — `timestep *= (1 - i/iterations)` compounding from 1000 with a
floor of 50. The node mass of 3 is Cytoscape's `defaultNodeMass` rather than prefuse's. Two
places it deliberately departs, both because prefuse relies on something unavailable here:

- **Seeding.** Prefuse's run-once mode drops every node on one point and lets a `Math.random()`
  nudge in the spring force break the symmetry. Positions here are recomputed whenever anything
  presentational changes, so a random layout would reshuffle the picture every time a colour was
  picked — and an unlinked node, of which this graph has thousands, would never be nudged at
  all. A phyllotactic spiral instead: deterministic, no two nodes coincident, and no ring
  artefact for the repulsion to spend its budget undoing.
- **Coincident points.** Prefuse subdivides its quadtree until two points separate, which two
  points at the same location never do; it survives on float precision running out. Leaves hold
  a *chain* here instead, which says the same thing without the cliff — points that cannot be
  separated share a centre of mass, which is what the approximation would have done anyway.

**The n-body sum is exact below 96 nodes and Barnes-Hut above it.** Not a deviation: at those
sizes building the tree costs more than the pairs it saves, and a component of six nodes has no
far field to lump together. It matters that the two agree, and `addRepulsion` is exported so a
test can check that they do — **at theta 0 the quadtree walk reproduces the pairwise sum to
1.7e-15**, which pins the quadrant arithmetic, the centre-of-mass roll-up and the leaf chains
all at once. At prefuse's own theta of 0.9 the approximation is coarse (0.155 worst-case
relative error, against 2.4e-5 at theta 0.1), so a tolerance there would hide a structural bug
inside the approximation's own slack; the exact case does not.

**Cost is bounded by a clock, not by the iteration count**, because the partition does not
help a graph that really is one component. Measured on one connected component at 100
iterations: 500 nodes 200ms, 1,000 432ms, 2,000 992ms, 5,000 2,914ms, 10,000 6,481ms, 36,000
29,024ms. `PREFUSE_BUDGET_MS` cuts it at eight seconds, and what crosses into `prefuseForce.ts`
is a **predicate** rather than a deadline — a clock is not arithmetic, and a predicate is what
makes the budget testable with a counter instead of a stopwatch. The partitioned path also
yields to the event loop every 60ms, or the "laying out…" note cannot paint and the whole wait
reads as a freeze.

**The pass count is fixed at Cytoscape's 100 and is deliberately not a control.** The annealing
schedule is defined *relative* to the pass count — `timestep *= (1 - i/iterations)` — so a bigger
number does not refine the picture, it stretches the cooling curve. Measured on the real graph: 25
passes score 0.393 in 188ms, 100 score 0.431 in 536ms, **220 score 0.376 in 1,126ms**. The
`Iterations` param defaults to 220 because that is what ForceAtlas2 wants, so sharing the control
would have shipped prefuse at twice the wait for a worse answer. Sharing a control was cheap;
sharing its default was not, and `visibleIf` keeps `iterations` to ForceAtlas2.

**A packing must not overlap two boxes, and that is the only property the picture depends on.**
`shelfPack` sorts by height descending and wraps at √area, which is not optimal — bin packing
is NP-hard — and would look no different if it were, since 11,000 of the 12,000 boxes are
near-identical small squares. What it must never do is overlap, because two overlapping
components draw as one tangled component and that is indistinguishable, on screen, from a
layout that merely came out badly.

**`componentLabels` and `networkOps.connectedComponents` are two walks over one idea, and a
test pins them together.** The first numbers the components the layout packs by and takes a
`NetworkTopology`; the second numbers the ones the *colour* channel paints by and takes a
`NetworkValue`. They can drift, and if they did, a node would be drawn in one group's colour
inside another group's box, with nothing on screen saying so.

**Beware a separation test that passes without the feature.** The obvious assertion — components
end up far apart — passes on a small graph *with partitioning disabled*, because with a handful
of tiny components the repulsion separates them anyway. Measured: at 3, 5, 8, 12 and 20
components the unpartitioned layout also comes out clean. Forty is where it first fails (seven
overlapping box pairs, none with the partition on), which is why `networkLayout.test.ts` uses
forty triangles and not the three-component graph that would have been easier to read.

**ForceAtlas2 runs in a web worker, and that changed `computeLayout`'s contract.** It used to
return finished positions; for the force layout it now returns only a _seed circle_, and
`startForceLayout` hands the live graph to `graphology-layout-forceatlas2/worker`, which
mutates positions as it settles. Four things about that:

- **Start it after the graph is complete.** The supervisor listens for `nodeAdded`/`edgeAdded`
  and respawns its worker on each one, so starting early restarts the layout once per node.
- **The seed is deliberately not normalised**, unlike every other layout here. Normalising
  would hand FA2 a 1000-unit box when its gravity and scaling were tuned against a 50-unit
  one; sigma's `autoRescale` frames the result regardless, including while it is still moving.
- **Animation is not free, and the worker is only used where it pays.** Each iteration costs a
  postMessage round trip, so 220 iterations is 220 round trips however trivial the graph.
  Measured synchronously at 220 iterations on a 3-regular graph: 100 nodes 18ms, 200 33ms, 400
  122ms, 600 254ms, 800 451ms, 1200 986ms. Below `FORCE_SYNC_BELOW` (600) `computeLayout`
  settles the graph itself and no supervisor starts: there is no convergence worth watching at
  that size, only a wait to sit through.
- **The supervised loop is compute-gated, not frame-gated** — an earlier note here said
  otherwise and was wrong. `handleMessage` applies positions and calls `askForIterations`
  synchronously, so a cycle is one round trip; sigma renders on its own `requestAnimationFrame`
  and never blocks it, and the apply pass is a single bulk `updateEachNodeAttributes` costing
  0.05ms at 3,000 nodes. Per-iteration compute: 1,000 nodes 4.7ms (~213/s), 3,000 14.2ms
  (~70/s), 6,000 20.8ms (~48/s). No single `MS_PER_ITERATION` is right at every size; it is
  calibrated around three thousand nodes and over-delivers below that.
- **`iterations` is a budget, not a count.** The supervisor exposes no counter, so it stops on
  a timer (`settleDuration`), calibrated against the measured per-iteration compute above. It
  was 6ms, which under-delivered against the number asked for. The strip's ⏭ runs the
  remainder synchronously, which blocks;
  that is acceptable only because it takes an explicit press. `skipToSettled` bounds it at ten
  seconds, in batches of a hundred iterations — a backstop against an unbounded graph rather
  than a responsiveness guarantee, and the deadline is checked only between batches, so the
  last one can overrun it.
- **Link weight reaches the layout through the graph's `weight` edge attribute**, and
  graphology's getter coerces a missing one to 1 _without complaint_. That silence is what let
  the worker path ignore synapse counts entirely while the synchronous path used them: the two
  paths build different graphs — `toGraphology` sets `weight`, `NetworkViewer`'s own graph
  originally did not — so the same node laid out with different physics either side of
  `FORCE_SYNC_BELOW`. The viewer's graph now carries `weight` purely for the layout; sigma
  reads `size` for thickness and ignores it.
- **`edgeWeightInfluence` scales attraction only — it never switches weight off.**
  `ewc = pow(w, influence)`, so 0 flattens every edge to 1 for the pull; but
  `graphToByteArrays` accumulates node **mass as the raw weighted degree**, untouched by the
  influence, and mass drives repulsion and gravity. So `Weight pull: 0` means "weight does not
  pull", not "weight is ignored", and the help says so.
- **Kill it, don't stop it,** on unmount: a stopped supervisor keeps its worker alive.

The cost is the layout's determinism, and it is free here: positions are never persisted, and
`layout` is presentational.

**`networkRebuild.test.tsx` is the guard on the two-effect split.** jsdom has no WebGL so the
renderer never exists, but `computeLayout` is awaited in the same `Promise.all` as the sigma
import — so counting calls to it measures exactly how often the _structure_ effect ran. That
is the only handle available without a browser on the most expensive regression this component
has: anything slipping into that dependency list costs a full layout and throws away the user's
framing. Write the test before touching the effect.

**Nodes can be dragged, and sigma ships none of it.** `networkDrag.ts` holds the arithmetic —
which nodes a grab picks up, where they land — for the reason `networkStyle.ts` exists: jsdom has
no WebGL, so anything left inside the component is untestable by construction. The component keeps
the event wiring, and five things about that wiring fail *silently*:

- **The rescale box has to be pinned before the first move.** With `autoRescale` on, sigma
  normalises positions against the node extent and recomputes it on every refresh — so dragging
  one node outward rescales *every* node and the graph shrinks away under the cursor.
  `setCustomBBox(getBBox())` on the grab freezes it for the life of the renderer.
- **⤢ is what unpins it**, which is what makes "fit to view" still mean "frame everything,
  including what I dragged out there". `setCustomBBox` alone only schedules a *render*; the
  normalisation function is rebuilt in `refresh`, so both calls are needed.
- **`preventSigmaDefault` is what stops the camera panning under the drag**: the mouse captor
  emits `mousemovebody` and reads that flag only afterwards.
- **…and it is also why sigma still emits a click at the end of one.** The captor's own
  `draggedEventsTolerance` counter — what normally suppresses a click after a pan — is
  incremented *after* that same check, so it stays at zero for every drag here and dropping a
  node would toggle its selection. `draggedAway` is the tolerance we keep instead, cleared on the
  next press; `DRAG_SLOP` (3 viewport px) is the hand-tremor allowance that keeps a click a click.
  `clickStage` needs the same guard: releasing a dragged node over empty canvas ends in a click on
  the stage, which would clear the selection you had just finished arranging.
- **The end of a drag comes from the captor's `mouseup`, not from `upNode`/`upStage`.** The captor
  listens on the document, so releasing outside the canvas ends the drag rather than leaving a
  node stuck to the pointer.

**A grab on a selected node moves the whole selection; a grab outside it moves one node and leaves
the selection alone.** Cytoscape and Gephi both do this, and it is what makes arranging a figure
practical. Positions are carried as one delta from the grab, never snapped onto the pointer — a
snap would teleport the node under the cursor the instant the button went down, and would collapse
a multi-node drag onto a point. One node goes through `mergeNodeAttributes`, which sigma answers
with a partial refresh of that node; several go through the bulk updater, one aggregate event and
one full re-index, which is the cheaper trade only once several nodes moved at once.

**Nothing is pinned against the force layout, deliberately.** A running supervisor keeps moving
what you dropped. Below `FORCE_SYNC_BELOW` there is no supervisor at all, so most graphs are
already still by the time anyone can grab one; above it, a graph big enough to still be settling is
one where the physics is doing the arranging, and ❙❙ is how you stop it. A `fixed` attribute would
be the other design, and it is a bigger decision than a gesture — it turns dragging into a way of
steering the layout.

**A dragged arrangement lasts the session and no longer.** It rides the existing layout memo, which
already snapshots positions off the graph on unmount, so this was nearly free — and `LayoutMemo`
gained one field, `moved`, purely so the caption can keep admitting it after a rebuild. The caption
is `moved by hand`, in the same idiom as `labels thinned`: positions are not written to the
document, so a file that reopens laid out afresh would otherwise look like the drag was discarded
for no reason. Re-layout (↻) discards them now, which is what a new signature means. Persisting to
a param is a real option and a separate decision — it is two floats per node in every
`.coda.json`, and it reopens the "positions are not provenance" question `layoutMemo.ts` records.

**Dragging is `!compact`.** A 150px card preview is not where anyone arranges a figure, and its
canvas shares a mouse button with the graph node it sits on. `compact` is read through a ref rather
than a dependency, because the structure effect's dependency list is the thing
`networkRebuild.test.tsx` guards.

**Driven by hand in a real browser** — Chrome over CDP against the bundled `network` example,
since none of the above can be reached by a test. What was checked, and each of them is a way this
could have shipped doing nothing: a node follows the pointer while every other node stays exactly
where it was (no rescale, no pan); the drop does not toggle the selection; a plain click still
does; two selected nodes move rigidly together while an unselected one moves alone; a node dragged
past the old extent stays outside it until ⤢ brings everything back into frame; closing and
reopening the overlay restores both the arrangement and the note; ↻ discards both; the hover
tooltip and the `grab` cursor still behave; and a right-drag carries nothing.

**A right-click is a selection gesture, and the menu is `NodeContextMenu`'s.** Same
`.context-menu` rows, same `useDismissOnOutside`, and above all the same rule about what a
command applies to: a right-click *inside* the selection acts on the whole selection, one
outside it acts on that mark alone. `seedsFor` is that rule written once — the drag reads it
too, so a grab and a right-click cannot come to mean different things.

**The walk is `net.filter`'s `expandSelection`, not a second one.** It already knows the two
rules that are easy to get wrong and invisible when they are: a *component* that respected
arrows would be a reachable set, and an undirected network's `source`/`target` are an arbitrary
order, so honouring "downstream" on one would walk half of each pair by construction order —
which is also why the two directed rows are hidden on an undirected network rather than
offered three times over. A menu with its own BFS would have to rediscover both, and would
disagree with the node wired downstream of it about what "the component" means.

**What the menu adds is the ordering.** `expandSelection` answers with a Set; the answer goes
into an `ids` param that lives in the saved file and takes part in the provenance key, so it is
returned in **network node order**. An order that depended on which node was clicked first
would re-key every downstream node for no change in what was selected.

**Every scope replaces the selection, and every result contains its anchors** — so running
`Select connected` again reaches one hop further. That is why there is no "within N hops"
asking for a number: press it again. `Select connected component` needs no repeat.

**Sigma routes a right-click to exactly one of three events**, and the edge arm is live only
while `enableEdgeEvents` is — which is gated on link count. So suppressing the browser's own
menu inside those handlers would have had a hole in it that opens above eight thousand links;
it is one `contextmenu` listener on the container instead. The same routing is why a link gets
a menu at all rather than falling through to the canvas: it anchors on **both its ends**, which
is the reading that makes right-clicking a wire mean something.

**Escape has to reach the menu before the overlay.** `ViewerOverlay`'s Escape handler is on the
capture phase and beats every popover's own dismissal, so the first press closed the whole
viewer from under the menu. Both are on `useOverlayEscape`'s stack now, where the menu, opened
last, answers first — see [docs/ui-shell.md](ui-shell.md).

**Opening the menu dismisses the tooltip**, which is otherwise summoned by the same pointer
over the same mark and comes up underneath a menu already named after that node.

**Verified in a real browser**, like the drag: the menu opens on a node, a link and the canvas
with the right rows on each; the browser's menu is cancelled (`defaultPrevented` read at the
document); `Select connected` from LC4 takes its four targets, again takes nine, `Select
upstream` from a sink takes its two sources, the component takes all thirteen; Escape closes
the menu and then the overlay; an outside click dismisses; `Copy id` reaches the clipboard; and
the compact card is untouched, where a right-click still gets the canvas's own node menu.

**The action strip holds verbs; the styling panel holds settings.** Fit, re-layout, freeze and
find have no value to store, so they cannot be params. Re-layout works by bumping a nonce in
the structure effect's dependency list — heavy, and exactly what "lay it out again" means; the
camera survives because `sameIds` still matches. Find reuses the focus machinery but anchors on
_only_ the matches, with no neighbourhood: a hover asks "what does this touch?", a search asks
"where are these?". A live search owns the focus until the box is cleared, so neither a hover
nor a selection can take it back. Enter is the only thing here that writes to the graph.

**Layered gained a direction and a layer column; `grouped` is new.** Top-down swaps the axes
rather than rotating, so layer spacing stays on the layer axis. `layersFromValues` orders a
numeric column numerically (or 10 sorts before 2) and puts unlabelled nodes in a final layer of
their own rather than in layer zero, where they would read as the first stage. `grouped` rings
the groups by size and rings each group's members inside it, radius growing with √count —
entirely deterministic, no seeding, no relaxation.

**A settled layout survives the viewer closing** (`layoutMemo.ts`). A force layout at a few
thousand nodes is _earned_ — settled over seconds, skipped forward, frozen where it looked
right — and positions used to live in the renderer, which dies with the component. The memo is
module-level rather than a ref for exactly that reason, and it is keyed by the graph node, so
the card, the inspector and the overlay share one layout instead of each settling their own.

Deliberately **not** persisted to the document: positions are not provenance, they would add
two floats per node to every `.coda.json`, and `layout` stays presentational. A memo is reused
only while the node set _and_ a signature of every layout param still match — the re-layout
nonce is in that signature, which is what makes ↻ mean "do it again". **A restored layout does
not restart the supervisor**, since re-settling something somebody worked for is the loss the
memo exists to prevent.

**Spectral layout: eigenvectors of the Laplacian by power iteration on `cI − L`**, since power
iteration finds the largest eigenvalue and the wanted ones are the smallest. Unweighted on
purpose — synaptic weights span orders of magnitude and would let a few strong links dominate
the embedding. It declines rather than guessing when there is nothing to embed: fewer than
three nodes, or no edges at all, where `L` is the zero matrix and the iteration hands back
whatever it started from, which _looks_ non-degenerate to a spread check.

**Spectral seeding for ForceAtlas2 is offered and is not the default**, and that is a finding
rather than a preference. It is a standard technique and it should help; three synthetic
benchmarks each failed to show it, and each turned out to be measuring something else — a
blob's scale, a circulant cluster's own low eigenvalues swamping the between-cluster cut, and
finally index adjacency, which a circle seed satisfies by construction because it lays nodes
out in index order. Defaulting to an unvalidated change is the habit the palette rules exist to
prevent, so the circle stays until a real connectome says otherwise.

**Barnes-Hut is already on where it matters.** `inferSettings` enables it above 2,000 nodes, so
a 3,000-node graph is getting it before anyone asks. Measured at 100 iterations on a 3-regular
graph: 1,000 nodes 425ms → 259ms, 3,000 2656ms → 850ms, 6,000 10710ms → 2013ms. The `Quadtree`
param exists to force it on below the threshold, where it is still worth ~1.6×, or off when
comparing layouts.

**Layouts** are in `ui/viewers/networkLayout.ts`. `assignLayers` is deliberately not a
DAG algorithm — connectomes are full of recurrent loops, so it relaxes with a pass cap
rather than requiring acyclicity.

**`NetworkViewer` runs two effects, and the split is load-bearing.** _Structure_ (graph +
Sigma instance) rebuilds only on new data or a new layout, because building one resets the
camera and re-runs the layout. _Style_ (colours, sizes, labels, arrows, selection) mutates
the existing graph through `updateEach*Attributes` and repaints. Anything that lands in the
structure effect's dependency list by accident costs a full ForceAtlas2 run and throws away
the user's framing.

That is what `useStable` guards: `readColorSpec`/`readSizeSpec` mint a fresh object on every
render of the parent, so identity-keyed memos changed constantly and the renderer was being
rebuilt on every unrelated re-render. Memoise encoding specs **by value**.

It lives in `ui/viewers/useStable.ts` because the scatter plot needs exactly the same thing for
exactly the same reason — there it rebuilt the point set, the hit index and the canvas on every
store tick rather than resetting a camera. A second copy is how two viewers drift on what
"stable" means. `scatterRebuild.test.tsx` is its guard, in the same idiom as
`networkRebuild.test.tsx`: mock the one expensive call and count it.

**Both those files clear their mock in a `beforeEach` with a block body, and that is not
style.** `mockClear()` returns the mock for chaining, so a concise arrow _returns a function_
from the hook — which vitest reads as a teardown callback and duly invokes after every test,
with no arguments. It lands in the real function as `options === undefined` and reads as a bug
in the component under test.

**Reciprocal links bow apart, and both get the _same_ curvature.** The control point is
offset along the perpendicular of (target − source), which flips with the direction of
travel — so equal curvature puts A→B and B→A on opposite sides. Opposite curvatures would
stack them again. `assignCurvatures` in `ui/viewers/networkDraw.ts` owns this, and both the
WebGL path (`@sigma/edge-curve`) and the SVG export read it.

**Export re-draws rather than screenshots.** A WebGL drawing buffer can't be read back after
presentation without `preserveDrawingBuffer`, which taxes every frame. So `networkToSvg`
rebuilds the current view as SVG from sigma's _display_ data (post-reducer, so a focused
selection exports focused) and PNG rasterises that. Two consequences worth keeping: the
export is vector, and it is the only part of this viewer with real test coverage.

**Both viewers are lazy** (`LazyViewers.tsx`). three.js is ~900 kB; it must never enter the
main chunk. Verify with `pnpm build` — `Viewer3D-*.js` should stay a separate file, and
`sigma`, `graphology` and `sigma-edge-curve` should stay in theirs.

**Sigma culls labels three ways at once, and all three had to be dealt with.** A node
smaller than `labelRenderedSizeThreshold` (default 6px) never gets a label — and the default
node size is 4, so out of the box there were _no_ labels until you zoomed in. `labelDensity`
caps labels per 100px grid cell, so panning changes which node wins its cell and labels
blink. And `edgeLabelsToDisplayFromNodes` only draws a link label when **both** endpoints'
labels are already drawn, which made "Link labels" a no-op with node labels off. Fix:
`labelRenderedSizeThreshold: 0`, plus `forceLabel` on every item while the graph is under
`FORCE_NODE_LABELS_BELOW` / `FORCE_EDGE_LABELS_BELOW` — `forceLabel` bypasses all three.
Above the caps the culling returns and the caption says `labels thinned`; don't remove that
note, silent culling is exactly what made the viewer look broken.

**Sigma settings that exist for a reason.** `zoomingRatio: 1.25` + `zoomDuration: 110` (the
defaults animate a 1.7× jump over 250ms and drop any wheel tick inside 50ms of the last,
which on a trackpad reads as lag); `hideLabelsOnMove` only _above_ the force-label cap,
since hiding forced labels mid-gesture just makes them flicker; and `enableEdgeEvents` gated
on edge count because link hover costs a second render pass into a picking texture.

**Two sigma defaults are replaced outright, and one of them was a bug.** Sigma routes every
node carrying `highlighted` through `defaultDrawNodeHover`, whose stock implementation paints a
hardcoded `#FFF` label box with a black drop shadow — so marking a _selection_ lit a white blob
on the `#1a1a19` dark canvas, in a colour belonging to no palette. `makeSelectionRingDrawer`
replaces it with a ring, and three things about that are load-bearing:

- **It fills a disc, not a stroked circle.** Sigma repaints highlighted nodes in WebGL on top
  of the hover canvas, so the node's own colour covers the middle and what survives is a clean
  annulus. A stroke would simply be drawn over.
- **It rings only _selected_ nodes**, though sigma calls it for the hovered one too. Hover
  already reports itself through the focus dimming and the tooltip; a hovered node wearing the
  selection ring reads as having just been selected.
- **The ring is achromatic** (`CHART_INK.primary`). `--accent` is `#2a78d6` / `#3987e5`,
  byte-identical to categorical slot 0, so an accent-coloured ring would be invisible on
  exactly the nodes it marks.

The other replacement is `defaultDrawNodeLabel`, which gains the same halo `networkToSvg` has
always drawn. Until it did, the _exported file_ was more legible than the screen it came from.

**De-emphasis recedes; it never erases.** Dimming blends each mark's own colour towards the
surface, so the context around a focus keeps its structure. Replacing the colour with a flat
`CHART_INK.axis` — which this did — threw the categorical encoding away the instant anything
was selected, and `#383835` on `#1a1a19` is close enough to the background that selecting one
node read as deleting every other. Links recede further than nodes (`DIM_EDGE` > `DIM_NODE`)
because there are far more of them: at equal recession the dimmed mat is still a hairball.

**Focus is an ego network, anchored on the hover or else the selection.** A link is lit only
when it _touches an anchor_, not merely when both its ends are focused — otherwise hovering a
hub redraws that whole neighbourhood's internal structure, which is the thing being cut
through. Hover overrides the selection's focus rather than compounding with it, and hands it
back on leave; a hover is a momentary "show me this instead".

**`.viewer` must stay `position: relative`.** Both viewer overlays — the "laying out…" note
and the link tooltip — are positioned from the renderer's _container_ coordinates. Without a
containing block on `.viewer` they anchor to whatever distant ancestor happens to be
positioned (the node card, the overlay panel) and land nowhere near the pointer.

**No visual verification exists in the suite for these two.** jsdom has no WebGL, so sigma and
three cannot render in tests, and there is no browser automation checked in. Everything testable
is tested headlessly (layouts, encodings, geometry generation, node semantics).

The 3D viewer has since been driven by hand in a real browser — Chrome over CDP, against the
bundled morphology example — and four of the bugs recorded below were found that way and by no
other means. A green suite said nothing about any of them. If you change this viewer, do the
same: the failures here are not "slightly wrong output", they are a control that does nothing
and a gesture that does nothing.

## Network Metrics: a card of numbers, and the two plots they cannot stand in for

Tiles rather than a chart, sharing `DatasetSummaryViewer`'s primitives — a `Tile`, a `Facts` list,
a `Bars` row set — because the subject is the same shape: twenty unrelated quantities, each read on
its own, none comparable with the one beside it. A chart of "density, reciprocity, transitivity" is
three bars sharing an axis that means nothing.

**Why any plots at all.** Because several of those numbers are summaries of a distribution that is
not remotely normal, and the summary is where connectomics goes wrong. A mean degree of 14
describes a lattice and a graph with four 3,000-partner hubs equally well; a median link weight of 3
says nothing about whether the top percent of links carries a third of the synapses; and a
component count of 11,936 does not say whether that is one big graph with dust around it or genuine
fragmentation. So the card draws a histogram of whichever column is asked for, and a scatter of any
two per-node columns — the plot that answers "do the hubs cluster?" without another node.

**One histogram with a picker, not three fixed ones.** The card drew degree, link weight and
component size: the right three to look at first, and an arbitrary three to be able to look at
*only* — `clustering`, `coreness`, `strength` and every column `net.centrality` writes are
distributions too, and none of them had a picture. Three tiles that cannot answer a fourth question
is worse than one that answers any. The three sets of numbers stayed, as fact tiles: pointed at
`clustering`, a single plot would otherwise take the card's only mean degree with it, and a figure
a reader compares across graphs should not depend on which plot happens to be open.

The picker's vocabulary is a **`source:column` pair**, not a column name, and it lives in
`networkMetrics.ts` beside the schemas rather than in the viewer. Nodes, links and components are
three tables with three different row counts — one row per node, per link, per component — so there
is no single schema for a `column` param to resolve against, which is why `histColumn` is an `enum`
with an options *function*. Two parties need exactly the same list: the node builds it from the
input's schema before anything runs, and the card builds it from the tables in hand.
`histogramChoices` is that one function. Link and component entries are prefixed because `weight`
is a word both the node table and the edge table use.

**The controls are on the tiles they change**, which is `CompletenessTile`'s arrangement for its
reason: a control that changes what a plot *says* belongs where the plot is, not in a band above a
card where the plot is off the bottom. That is also why all five params are `advanced` — being
inspector-only is what stops the card carrying two copies of each. `ValuePreview` passes the four
writers **as a spread**, absent when `onParamChange` is: an `onParamChange?.(…)` arrow is still a
function, so the card would see a writer on every surface and draw live-looking controls that do
nothing on the one surface that cannot store them.

**The card reads the node's *input*, not its output.** Both carry the same topology, but
`networkMetrics` is memoised on the network object and `evaluate` was handed the input — so reading
the input is a cache hit and reading the output is a second triangle count on every render. That
also puts the branch **above** `ValuePreview`'s `!value` guard, which is the failure
`out.datasetSummary` shipped once: below the guard it showed "No result yet" permanently, with a
green suite, because every test rendered the viewer directly and so never reached the dispatcher.
`net.metrics` is a `withoutValue` entry for the same reason, and `networkMetrics.test.tsx`
renders through `ValuePreview` with no value at all.

**One log switch, and it does two things, because on this data they are one thing.** A connectome's
degree, weight and component-size distributions defeat a linear histogram twice over: linear *bins*
put nine tenths of the rows in the first bar and leave four of the ten empty, and linear *bar
lengths* then draw everything past the second bar as an invisible sliver. Fixing one and not the
other still reads as "there is nothing out there", which is the opposite of what the tail says. So
`logScale` bins in log10 (`buildHistogram`'s own `log`) and scales the bars by `log1p` together —
and the tile's qualifier says how many rows a log axis had nothing to say about, because a degree
of 0 has no logarithm and an isolated node is exactly the sort of row that should not leave a
picture silently.

**Three things were measured in a real browser, and two of them were wrong first.**

- **`BarRow` needed a `label` separate from its `key`.** `Bars` printed `row.key`, so
  disambiguating the key — which histogram bins need, since two adjacent bins of a heavy-tailed
  column round to the same printed range at the low end — put `3:` in front of every bin on screen.
  The component had conflated identity with text; splitting the two is the fix, and
  `DatasetSummaryViewer`'s rows are unchanged because `label` falls back to `key`.
- **The scatter sits above the histogram.** Three distribution tiles at ten bins each was about
  900px of card, so below them the scatter started off the bottom of the 620px default and stayed
  there. A plot nobody scrolls to is a plot that is not on the card. One histogram makes that less
  acute and not untrue — at forty bins it is still the taller of the two.
- **A scatter point is a zero-length round-capped subpath, not a `<circle>`, and all 3,000 are one
  `<path>`.** The box is `preserveAspectRatio="none"`, because the two axes are unrelated
  quantities and squaring them would waste most of a wide tile — but that scales x and y by
  different factors, so a circle of radius r draws as an ellipse five times wider than it is tall.
  `vector-effect="non-scaling-stroke"` is the one thing there measured in screen pixels, and a
  zero-length subpath with a round cap under it is a dot of a fixed size whatever the tile's
  aspect. One path rather than 3,000 elements because the marks were being built in the render
  body: every store tick created 3,000 elements and reconciled them against 3,000 fibers,
  including ticks that changed nothing about this node. The path string is built inside the memo
  that already computes the points. None of this is visible in jsdom, which performs no layout.

**Three more, measured in Chrome when the histogram became one plot.** All three are height, and
none is visible to a green suite.

- **The stats moved from a `Facts` block into the heading line.** Four rows is about 70px, and it
  bought a *duplicate*: pointed at `degree` or `link weight` — two of the three things anybody
  opens this on — every one of those numbers is already on a tile a few inches up. What the block
  was for is the third case, a column the card holds no summary of. One line does that, and the
  70px is the difference between ten bars clearing the fold and two.
- **`defaultSize` went from 620 to 700 high.** Five fact tiles are two grid rows at 620 wide
  (~250px), the scatter with its axis readout is ~190, and ten bars with a heading is ~175.
- **Bin labels are rounded on screen and exact in the tooltip.** The label track is 4.5em of
  monospace; `11.4–16.6` is nine characters and arrives as `11.4–16…`, which has stopped
  distinguishing itself from the bin below it. Every column with a bin wider than 1 here is a count
  of something, so the tenths are an artefact of dividing an integer range into ten. Below that
  width — `clustering`, `density` — the decimals are the whole number and are kept.

**The histogram scans once and re-bins per keystroke.** `histogramBins` splits `scanValues` (the
only O(rows) half) from `binScan` (per-bar) precisely so the bin field — which fires on every
keystroke, not on commit — reshapes bars instead of re-walking rows. Keyed together, a link-weight
distribution re-scanned every link in the network on every one, and since `bins` is
`presentational` the node does not re-run, so that scan *was* the whole cost of the edit. Three
memos: the scan, the bins, and `columnStats`.

**`columnStats` rather than `describeTable`, and the reason is the `Set`.** The heading needs a
mean, a median and a maximum for one column. `describeTable` answers exactly that and is memoised
— but it summarises *every* column, and its per-column pass builds a set of distinct printed
labels, which on a million-link edge table is a million string allocations to read three numbers
off one column. The quantile is still `boxStats`', so this and a Describe node downstream cannot
come to quote two different medians.

**Vertical is a checkbox, and horizontal is the default because of the labels.** A bin's label is
a *range* — `11–17` — where a completeness column's is a region name, and `Columns` sets its keys
in rotated text: ten of those are legible and forty are a picket fence, while as rows they are a
fixed-width track that stays readable at any bin count. So the shape that survives the control
above it is the default. One row set feeds both — `ColumnBar` is `BarRow` minus the fields the
rows use — which is also why `ColumnBar` gained the same `key`/`label` split `BarRow` has, for the
same reason: two adjacent bins of a heavy tail round to one printed range, and React would reuse
one bin's cell for another's count.

`Columns` is **restyled through a wrapper class**, not given a prop — the dashboard's rule, that
density is CSS's and a frame restyles the inside without the shared component learning a caller by
name. Three of its numbers are sized for six named regions: the `max-width` caps that keep six
bars a bar's width apart instead of six slivers across a metre of tile, which for a histogram
separate bars that are contiguous by convention; and a band and label track coming to about 200px
against the rows' 140, which put the axis below the fold of a card whose last tile this is.
`.metrics__columns` sets all three, measured at 620 wide.

The primitive's docstring also had to grow a second half. It says the axis is fixed rather than
scaled to the tallest bar, and that is right for what it was written for: completeness is a
*fraction of something*, and normalising to the best region would draw it full height whether it
were 90% or 9%. A **count** has no such ceiling, so this caller does normalise against the tallest
bar — not the same mistake, because there is no external scale left to misrepresent. The rule
forbids inventing a scale for a quantity that already has one, not having a scale at all.

**0 bins is the automatic rule.** One number rather than `out.histogram`'s `binMode` enum plus a
count: two controls for one decision is one too many on a tile heading, and there is no bin count
of zero for the sentinel to collide with. The param's `max` is `MAX_AUTO_BINS` (80), so the
hand-set range and the range the automatic rule can reach are the same range.

**The scatter subsamples by stride and says so**, capped at 3,000 points — a stride is
deterministic, which a random draw in a render function would not be, and the tile names what was
drawn against what exists. A null on either axis is a point with no *position*, not a point at
zero, so those rows are dropped and counted too: on a graph with many leaves, `clustering` is null
for every one of them and "278 of 320 nodes" is the honest caption.

**CSV of the summary, and no SVG.** The per-node numbers are a port an inch away and export like
any other table, so offering them here as well would be two routes to one file. There is no vector
export because the card is a grid of tiles, several drawing their own picture, and an SVG would
have to invent a composite nothing renders — `DatasetSummaryViewer`'s call, for its reason.

## Flow Chart: the same material as the Network Viewer, at the other end of the size range

`out.network` draws a WebGL disc per node with the label beside it, which is the right trade at
thirty-six thousand nodes and the wrong one at twelve, where the label *is* the node and the
weight on the arrow is the point. `out.flowChart` is the other end: SVG, boxes sized to their
text, arrows routed around what is in the way, a number on each.

**They draw the same material and the choice between them is about size**, which is exactly the
fact no category or socket type could relate them by — hence the See Also group naming the pair
explicitly. Below about twenty nodes a force layout has nothing to arrange; above a few hundred
a layered drawing has too much. `FLOW_NODES_WARN` (120) and `MAX_BOXES_DRAWN` (600) are the two
points on that line, and [limits.md](limits.md) carries the row.

### SVG rather than WebGL, and the layout inside the render

Three things follow from the boxes being text, and the first is what decides the rest.

**The layout cannot run until the labels are measured.** A box is as wide as the string in it,
so nothing upstream of a renderer can place one — which is why this node has **no `Layout`
socket**, departing from `out.network` deliberately. `Paths` computes its arrangement against
`NETWORK_NODE_SIZE`, a 120 × 36 placeholder standing in for a disc; honoured here those positions
overlap every box whose text is wider and waste the gap beside every box that is narrower. The
canvas's own rule one level down: only the thing that knows the font can say how big the box is.

**Measurement is a shared offscreen canvas**, not a DOM pass: `measureText` is synchronous and
needs no layout, which is what lets the whole arrangement stay inside the render. jsdom's stub
answers `text.length * 6`, the same estimate `truncateLabel` uses, so the layout genuinely runs
under test rather than being skipped — and a wrong answer there is a wrong *size*, never a crash.

**So the layout is synchronous.** Every other layout in the app is async and each pays for it in
a settle-on-mount effect and a frame of the wrong picture; at this size the pass is microseconds
and can just be part of the render.

### Why the layout is not ELK

`layout/network.ts` already runs ELK layered over a `NetworkValue` and `Paths` emits the result
of one, so not using it wants an argument. Four, each about this drawing rather than about ELK:

- **The layering is already decided.** `flowChartOps.flowGraph` assigns it, from a column where
  one is picked — and there is no way to hand ELK a layer assignment. `elk.partitioning`
  *ignores* one fed back to it, which [canvas-layout.md](canvas-layout.md) records from a sweep. Two layerers
  on one picture is one of them being silently overruled.
- **Back edges have to keep their direction.** ELK breaks cycles by reversing edges internally
  and returns a route for the reversed one, so a recurrent connection comes back
  indistinguishable from a feed-forward one. Telling feedback apart is most of what makes this
  node usable on a `Connectivity` fan rather than only on a `Paths` result.
- **The box sizes are text**, so the layout runs in the viewer, where ELK's worker round trip
  buys nothing.
- **Synchronous is worth a lot here**, per above.

What is *not* re-derived is the algorithm. `flowChartLayout.ts` is ordinary Sugiyama with the
layering step removed: dummy nodes for edges spanning more than one layer, barycentre sweeps to
order within a layer, then coordinates.

**The dummies are the load-bearing part** and the thing a hand-rolled layered drawing usually
leaves out. Without them a skip-layer arrow runs straight through whatever boxes lie between its
ends, which is the single most obvious defect in drawing a connectome this way. With them the
arrow gets a corridor that the ordering step keeps clear, because the corridor *is* a node as far
as the ordering is concerned. `flowChartLayout.test.ts` asserts it directly: on `a→b→c→d` plus
`a→d`, no interior point of the long arrow falls inside `b`'s or `c`'s box.

Two smaller decisions in the same pass. The barycentre is **weighted by the edge's weight**,
unlike `networkLayout.ts`' version — the strongest connection is the one a reader traces, so it
is the one worth drawing straight; a null weight counts as 1 rather than 0, since at 0 it would
exert no pull and let its endpoints drift to opposite ends of their layers. And several arrows at
one box are **fanned along its face**, sorted by where they are heading, or ten connections at a
hub overlap into one thick line with the arrowheads piled on each other.

### A layer is not a hop, and that is the whole of the layering control

Longest-path layering is a fact about the graph handed in: a node sits one column right of the
furthest-back thing that reaches it. That is exactly right for a `Paths` network, which is
assembled from routes and whose `hop` column is longest-path layering by construction.

It is wrong for an `Influence` network, and wrong in a way that looks fine. `hops` there is the
*fewest* synapses from the seed, and the induced subgraph of the top scorers is full of long
chains — so a neuron one synapse from the seed lands five columns out because something else
reaches it the long way round. Both pictures are internally consistent and only one answers the
question somebody asked.

So the layer source is a **column picker, `optional`, empty meaning longest path**, and the
caption says which ran. Deliberately *not* "automatic, preferring a column called `hop` or
`hops`": that is a substitution nobody asked for, and a network carrying a column of that name
meaning something else would be silently layered by it — the failure `resolveColumn`'s rule 3
already has a record of on `zapbench:traces` and `out.scatter`. Values read off a column are
**renumbered densely**, because the numbers are a measurement and the layers are positions: 0, 2
and 5 hops draw as three adjacent columns, not six with gaps. An unmeasured row lands in one
layer after every measured one rather than in layer 0 — null is not zero, `numeric()`'s trap.

### Four edge kinds, told apart by shape rather than by colour

A layering makes every edge one of four things, and a drawing that does not tell them apart is
the main thing wrong with drawing a connectome as a flow chart. `forward` is the ordinary case.
`back` is a recurrent connection, and drawn like a forward edge it is an arrow pointing right
through the boxes between its ends — which reads as a data error rather than as feedback.
`within` joins two nodes in one column and has no length to be drawn along. `self` is an autapse,
which has no two ends at all.

So `back` is **dashed**, `within` bulges off the flow axis so it cannot be mistaken for a
connection to the next layer, and `self` is a loop on the box. All four take the same colour: the
kinds differ in *shape*, because colour is already spent on the data. That classification is
`flowChartOps`', next to the layering that defines it, rather than inferred from coordinates
after a layout has run — which is also what lets both exporters reproduce it.

### The fold is presentational, and states what that costs

`Fold past` keeps the busiest N boxes in each layer and folds the rest into one `+N others`,
ranked by total incident weight rather than by degree — a box wired to twenty things by one
synapse each is exactly what somebody folding a layer wants folded away. Survivors come back in
**table order**: the ranking decides which boxes stay, never where they sit.

It changes which boxes exist, so it looks like it should reach the output port. It does not, and
the cost is stated where it is paid — a folded network is not available downstream — because the
alternative is that nudging a figure's density re-runs a connectome query. Clicking a folded box
selects its *members*, since `Selected` carries neuron ids and `+7 others` is not one.

Merged edges carry a **summed weight and nothing else**, which is `net.build`'s rule for parallel
links and its stated reason: `weight` is the one additive channel, and a folded edge standing for
eleven connections across four regions has no single region.

### What was checked in a real browser

`pnpm probe:flowchart-draw` (Chrome over CDP, the node's own demo link, no credential). Each of
its properties is one jsdom cannot reach: **every box is at least as wide as the text in it**,
**no two boxes overlap**, **no arrow passes through a box**, **the drawing fits the card**,
**clicking a box selects it**, **the wheel zooms in toward the reader and holds the point under
the cursor**, **an arrowhead points along the stroke it ends**, and **hovering an arrow
highlights that arrow and no other**.

**The count is deliberately not written down here.** It was, in three files, and by the time
anyone compared them they said five, six and eight against a script that checked eleven — a
number restated in four places drifts in four directions. `probeReport()` prints the real tally
at the end of a run, and the enumeration lives in the script's own header; what belongs in prose
is which properties earned their place.

The first is the one that earns the probe. A box is sized by a canvas `measureText` and drawn by
`.chart text`, which takes `--font-ui` — two code paths reading two font strings unless something
makes them one. They agree wherever `system-ui` resolves, which is every machine anybody would
test on, and part company exactly where it does not. So the measurer reads the variable rather
than spelling the family out, and the truncated string is stored beside the width it was measured
for: two independent truncations is the same failure one step later.

The label's own colour is `colors.ts`' `inkOn`, not a second luminance rule — two viewers filling
marks from one palette picking different inks for the same slot is exactly the drift that function
exists to prevent.

**Three more were reported from use, and all three are about the drawn stroke rather than the
layout** — which is why the probe grew the zoom and arrowhead checks. **The wheel ran
backwards and did not hold the pointer**: `useWheelZoom`'s `factor` is above 1 for a scroll
*away* from the reader, i.e. zoom out (`zoomRoiWindow` reads it the same way), and this
multiplied by it; and the pan is stored on top of a centring term that is a function of the zoom,
so re-centring had to be measured at the **new** zoom — measured at the old one the drawing slid
away from the cursor as it magnified. **An arrowhead read the waypoints, not the stroke**:
orthogonal draws `orthogonalCorners(points)`, whose last leg is axis-aligned, where the raw
polyline's last leg is the diagonal that leg replaced, so heads sat at an angle to the line they
end — 61.7° off at worst, confirmed by putting the old reading back under the new check. And
**`curved` drew straight lines**: the Catmull-Rom pass put its control points exactly on the line
for a two-point route, which is every arrow between adjacent layers, so the option did nothing on
most of a chart. It is a cubic per segment with tangents along the segment's dominant axis now —
the same axis `orthogonalCorners` turns on, so the two routings bend in the same places and
differ only in how sharply, and a segment whose ends share the cross axis stays straight because
a horizontal arrow is a horizontal arrow.

**Hovering an arrow highlights it, and the highlight is one extra path drawn over the arrow
layer** — `DendrogramLinks`' arrangement and its measured reason, which matters more here because
`FlowArrows` is memoised: a `hover` prop would defeat that memo outright and put every *other*
arrow back through reconciliation on each pointer move. It is drawn between the arrows and the
boxes, where the arrows themselves are, and traces the same `ArrowMark` the arrow does so the two
cannot end up on different geometry. A highlighted feedback arrow keeps its dash: the kinds are
told apart by shape, not by colour. The width is `+2` rather than a multiplier, because a factor
is invisible on the thinnest arrow of a weighted chart and a slab on the thickest.

**The router turns on the flow axis, not on whichever axis is longer.** That is the fix for a
defect the browser probe caught once its coordinates were right: a steep connection turned early,
running its long leg down the *source box's own face* — which in a layered chart is where the rest
of that column sits, so it grazed its neighbours, measured at 3.4px into `T5d`. The free space is
between the layers, and only the flow axis says where that is, so `orthogonalCorners` and
`curveControls` both take it. What it costs is that arrows between one pair of layers now share a
channel and overlap along it; per-edge channel assignment is the real answer and is not here.

One note for the next person to add a browser check: **a regex written inside an `evaluate`
template literal has its backslashes eaten before the page sees it** — `\d` becomes `d` — so the
pattern matches nothing and a check over "every arrow" silently passes over an empty list. It did
exactly that here, and `0 checked` in the output is what gave it away. Raw strings come back and
the parsing happens in Node; eslint's `no-useless-escape` flags the mistake if it is made again.

And the sharper one, from the same probe: **take a path's screen coordinates from the path's own
`getScreenCTM()`, never the `<svg>`'s.** The arrows live inside two nested transforms — the plot's
padding and the fit/zoom — and the svg's matrix carries neither, so a polyline built from it is
off by the pad and wrong by the scale. "No arrow passes through a box" had been comparing that
mis-placed polyline against real box rects and passing because nothing landed anywhere near them.
Corrected, it failed immediately on a real defect, which is the second time a check here has been
green for the wrong reason.

**Two earlier defects were found by looking at the screenshot, and neither is reachable by any
property above.** That is the part worth keeping: both make the picture *more* comfortably
correct by every check the probe asks.

**The fit would not magnify.** It was `Math.min(1, …)`, on the argument that a two-box chart blown
up to fill a card reads as a different node and that the text grows with it. At eighteen boxes in
a 1250 × 850 panel that drew about 340px across and left three quarters of the surface empty —
which is the one thing expanding a card is for. `MAX_FIT` is 2 now, which keeps the argument's
useful half: a chain of three boxes filling a wide panel would be 40px text beside a 12px
interface.

**Arrows ended at their layer band's edge rather than at the box's own face.** A band is as deep
as the deepest box in its layer and every box is centred in it, so a box narrower than its widest
neighbour sits inset from both edges and the arrowhead floats in the gap — about 40px on the demo
graph, where `AOTU008` sets its layer's depth and `Mi1` shares it. Invisible in every unit fixture,
which gives each box the same size and so makes band and box coincide; `flowChartLayout.test.ts`
now has one with a 40px box beside a 200px one. The corridor points stay on their band edges,
which is right — a corridor has no extent along the flow and *is* the layer as far as a route is
concerned.

### What the exporters do, and what running them found

Neither library draws this, so both emit Coda's layering through a generated helper
(`coda_flow_layers`) and then the nearest layered layout each has. **Both helpers agreed with the
canvas on all six probe graphs on the first run; every bug was in the dozen lines that draw** —
which is why `pnpm probe:flowchart` lifts the emitted *cell* out of each golden and executes it
rather than stopping at the helper.

Python gets `nx.multipartite_layout`, and **not** `nx_agraph.graphviz_layout(prog='dot')`, which
lays out properly and needs pygraphviz — a system package a notebook has no business requiring.
`topological_generations` is not a substitute: it is *earliest*-possible layering, so `a→c`
beside `a→b→c` draws `c` in column 1 with the route through `b` running backwards out of it. Two
divergences are stated in the cell: networkx does no crossing minimisation, and it draws every
edge straight, so a skip-layer arrow crosses what is in the way.

R gets `igraph::layout_with_sugiyama`, which is **the one library call in either document that
does what the canvas does** — handed the layers it minimises crossings and inserts dummy vertices,
exposed as `extd_graph`, so the arrow really is routed. Four things about that graph were measured
rather than assumed, and the emitted cell got two of them wrong first:

- **`extd_graph` carries only `orig` and `arrow.mode`.** Every attribute of the original edges is
  gone, so `E(.g)$weight` was `NULL` and the widths and arrow labels were silently absent. `orig`
  is the 1-based original edge index; reading through it gives each piece of a split edge the
  original's value.
- **A split edge is three edges there**, so labelling `E(.g)$label` printed the number three times
  along one arrow.
- **`sugi$layout` has a row per *real* vertex**, so plotting `extd_graph` with it is
  `The layout has 4 rows, but the graph has 6 vertices`. The extended graph's coordinates are
  `.g$layout`.
- **Sugiyama's layer axis runs downwards**, so left-to-right needs the axes exchanged *and* the
  layer axis negated. Exchanging them alone drew the circuit right to left — a figure that looks
  perfectly plausible and is backwards.

The gift in the same measurement: `arrow.mode` is already 0 on every piece of a split edge but the
last, so a routed arrow draws one head at its real target and the emitter must not touch it.

### A chart's name is an `aria-label` on screen and a `<title>` in the file

Reported on the Sankey and true of **nine viewers**, which is why it is here rather than in one
of their sections. A `<title>` that is a direct child of `<svg>` is the element's accessible name
*and* a native browser tooltip over the whole drawing — so every chart here was opening a tooltip
saying `Flow diagram of 8 boxes in 3 layers` on top of the hover card that says what the pointer is
actually on. The bigger the chart, the longer it covers the useful one.

So the live `<svg>` carries `role="img"` and `aria-label`, which is the same accessible name with
no tooltip, and `serializeSvg` turns that label into a real `<title>` when it clones for export —
where there is no pointer to interfere with and nothing else in the file can name the drawing. A
builder that synthesises its own root (`scatterToSvg`, `networkToSvg`, `heatmapToSvg`) may set a
`<title>` itself, so an existing one is left alone: two titles in one document is one of them being
silently ignored.

**A per-mark `<title>` is a different thing and stays.** `DendrogramViewer` puts one on a renamed
leaf — deliberately, and its own comment argues why it beats a `chart-tooltip` there — and `Tiles`
puts one on a pie slice. Those describe *one mark* and appear only over it, which is a tooltip
somebody wants. What was wrong was the one over everything.

The guard that caught the half-finished version is worth knowing about: `dendrogram.test.tsx` asks
for the chart by `getByRole('img', { name: /Dendrogram of 4 leaves/ })`, so an accessible name that
stops resolving fails a test rather than going quiet.

## Sankey: layered flow, where the width is the quantity

The picture `Influence` needed and the one a node-link diagram could not be. The retired `Network`
port drew the induced subgraph of the top scorers, which invited a reader to trace a route through
a ball whose other routes were not on the page; a flow diagram's bands *are* the drive, so a
column's total is the whole of what reached that depth. [nodes-connectivity.md](nodes-connectivity.md)
carries why that port went and what the `Transfers` port replaced it with.

**General over a table, not built around influence.** Four pickers — layer, from, to, value.
`Influence ▸ Transfers` fills them with no configuration and so does anything else shaped like layered
flow. Nothing in `sankeyFlow.ts` or `sankeyLayout.ts` knows what a neuron is.

### Conservation is measured, not assumed

A Sankey's grammar is that inflow equals outflow at every node: that contract is why the mark reads
as it does, and it is why most connectome Sankeys are quietly wrong — drawn on synapse counts,
which conserve nowhere, because a neuron's incoming synapse count has nothing to do with its
outgoing one.

The node cannot refuse such a table. Flow between categories is a legitimate thing to draw and this
is the conventional mark for it. So instead **the caption prints how far off conservation the
drawing is** — `conserves`, or `18% stops` — which turns the claim the mark makes into one a reader
can check. Warn, never refuse. On an Influence flow under the traversal denominator it reads
`conserves` exactly, because a neuron's outgoing shares sum to one.

### The shortfall belongs to the node, not to the column

This shipped wrong and a layout test caught it, which is worth keeping because the wrong version is
the one that looks obviously right.

A node is drawn as tall as **the larger of what it received and what it sent**, which is the
standard rule and the one that keeps a sink from vanishing. But it means a node that passes on less
than it took **already absorbs its own shortfall**, as unused bar. Drawing a notch for the same
quantity at the foot of the column adds it a second time, and the column comes out taller than the
one feeding it — a diagram that invents drive. So the mark is the dimmed tail of the box itself,
which is also better information: it says *which* box the drive stopped at.

Two cases it must not fire on, and both were found by asserting them. A node in the **last** column
has no outflow because it is the end of the diagram, not because anything was lost — counted, every
conserving flow reports losing the whole of its final column. And **layer 0 has no inflow** by
construction; drawn as a shortfall the whole first column reads as missing, where what it is is
where the picture was cut off. That one gets a feathered edge instead.

### A node is a (layer, label) pair

Which is what lets a label repeat down the diagram. An influence walk is not a breadth-first search
— a neuron is propagated from at every later hop — so a cell type carries drive at several depths
and appears in several columns. Keyed on the label alone those merge into one node and the flow
acquires cycles, which is a different picture and not a drawable one.

### Folding is safe here in a way it is not on a flow chart

`Fold past` keeps the largest N boxes per column and merges the rest, and **summing merged bands
preserves every column total exactly** — so the picture stays conserving and the caption keeps
reporting the same number. `out.flowChart`'s fold had to be presentational-and-lossy because its
boxes carry no additive quantity; here the quantity *is* the mark. Ranked by what a node carries
rather than by how many bands touch it, for `foldFlowGraph`'s reason, and survivors come back in
the data's own order: the ranking decides which boxes stay, never where they sit.

### What is shared with the flow chart, and what is not

The within-column ordering is **`barycentre.ts`**, extracted from `flowChartLayout.ts` when this
node needed the same sweep — an ordering rule written twice is an ordering rule that drifts, and
the two viewers would still be expected to put the same graph in the same order. The dense layer
renumbering is `columnLayers`, shared for the same reason: 0, 2 and 5 draw as three adjacent
columns in both.

What is *not* shared is the routing, and there is nothing to share: a flow chart's arrows need
corridors because they are lines between boxes that other boxes are in the way of, where a band
runs between two faces at a fixed pair of columns and has nowhere else to be.

### Colour is off by default

Width is already the quantity, and on a diagram of thirty labels a categorical palette cycles and
stops meaning anything. Pointing `Band colour` at the from or to column is one click for somebody
tracing a stream, and then it earns its place. The bands take their colour from the row they came
from, through `resolveColor` on the input table — so the palette, the frequency ranking, the
cycling and the legend are all `style/encoding.ts`' and none of it is re-derived here.

### What was checked in a real browser

Driven through the app on the synthetic dataset (`dataset.mock.opticlobe` → Find Neurons →
Influence → Sankey), which needs no credential. Three findings, none reachable from jsdom:

- **A 96px gutter reserved beside the last column was dead space.** That column's labels are drawn
  *before* its bar rather than after — it has nowhere further to go — so the reservation squeezed
  the drawing by a tenth of its width for nothing.
- **The bands were mud.** At `fillOpacity` 0.38 a muted band over `#1a1a19` lands about two and a
  half steps off the ground, which reads as an uneven background rather than as a mark. 0.55 is
  where they separate while still sitting under the node bars, which are drawn opaque so the two
  never read as the same thing.
- **Several bands meeting one node face drew as a single mass.** They are stacked fills, so they
  want the surface gap the bar chart already gives stacked segments; a 0.75px surface hairline
  round each band is what separates them.

### The exporters refuse, and the reason is a dependency

Neither library draws one. `matplotlib.sankey` is built for a different figure entirely — a single
balance of inflows and outflows, not layered flow — and the routes that work are plotly or
holoviews, each a fourth package in an exporter that is neuprint-python, pandas and navis. R is the
same story with ggalluvial. The arithmetic is about fifteen lines and is not the obstacle; what
stops it is the rule `out.topology` and `zapbench:traces` already record — an emitter has to be
checked by *running* it, and a flow diagram whose widths silently stopped conserving would look
entirely plausible. The Transfers table itself exports perfectly well, being four ordinary columns.
