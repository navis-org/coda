# Canvas: layout

Automatic layout (ELK, companions, packing) and align & distribute. [canvas.md](canvas.md) holds
framing, fitting and the lock.

## Automatic layout

Four buttons in the canvas controls rail, after Zoom In / Zoom Out / Fit View / Fit Selected
(`ui/panels/LayoutControls.tsx`): **arrange**, **auto-layout**, wire **routing**, and an
**options** bubble of seven controls.
ELK Layered via `elkjs`. The headless half is `src/layout/`; only the buttons and the pass
driver (`ui/useArrange.ts`) are React.

**`src/layout` is a top-level sibling of `core`/`data`/`nodes`, and that placement is load-bearing.**
The store holds the layout preferences, so `store/persistence.ts` needs `LayoutOptions` — and
putting the module under `src/ui` would make the store import the UI, which is both a new
dependency direction and a cycle, since the UI imports the store. Nothing in `src/layout`
touches React.

**Only the canvas knows how big a card is.** A node's height comes from its param rows, its port
count, its body widget and whether it is collapsed — none of which the document records. So
`resolveSize` prefers the canvas's measurement and falls back to `node.size`, then to `cardWidth`
(the widest the type can draw: `defaultSize`, `NodeDefinition.cardWidth`, a viewer's 360) by the
declared height (`declaredHeight`: `defaultSize`'s, else `cardHeight`) or 120. The width is the
widest rather than the unrun one because every headless reader of it is *placing* something.
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

**One option comes from the window, and it is off by default.** `Use screen aspect ratio` in the
options bubble sends `elk.aspectRatio` — the shape the packer aims at — measured off the canvas
pane rather than assumed. Every other option in the bubble is answered from the graph, so two
people arranging one `.coda.json` get one arrangement; this one makes the result depend on the
window it was arranged in, which is what somebody on an ultrawide wants and what makes a shared
file land differently on the next machine. Hence a control rather than a rule.

Three measurements decide its shape, taken on twelve unwired two-card components at 232×120 with
the ratio swept 0.5 … 8:

- **It is a component-packing target and nothing else.** With `separateConnectedComponents` off
  the bounds are 572×1980 at every ratio; with it on but only _one_ component, 3852×132 at every
  ratio. That second case is the ordinary Coda graph — a single wired chain — so on most canvases
  this option correctly does nothing.
- **`radial` ignores it**, at 621×192 throughout; `layered`, `force` and `mrtree` all move.
- **ELK's own default is 1.6**, confirmed by 1.6 and _unset_ returning identical bounds.

So the checkbox is disabled — not hidden, as Alignment is — whenever packing is off or the
algorithm is radial, and `aspectRatioApplies` is the single predicate both the disabled state and
`elkOptionsFor` read. Two spellings of that condition would drift silently in both directions: a
live checkbox over an option ELK is not being sent, or a greyed one over an option it is. A live
checkbox that does nothing is also precisely the failure the `routed` wire mode was deleted for.

The measurement is `.canvas-area`'s bounding rect (`useArrange.canvasAspect`) — the window minus
the toolbar, the panels and, with a viewer pinned, a whole grid column, which on a 16:9 display
with the dock open is nearer 1:1 than 1.78. A rect rather than `offsetWidth`, inverting the rule
two paragraphs up for `measurePorts`' reason: the pane sits _outside_ React Flow's transformed
subtree, so its rect is CSS pixels at any zoom, and this is the one measurement here that wants
the fractional answer. An unmeasurable pane sends no key at all, which lands on ELK's 1.6 —
the same result as leaving the checkbox off, rather than a number nobody typed. `ASPECT_RANGE`
clamps to 0.25 … 4 as a guard, not a taste: ELK overshoots its target at the extremes rather than
refusing them, returning an actual ratio of 21 under layered and 48 under mrtree when asked for 8.

**A wrong ELK option key is silent.** ELK ignores an option it does not recognise instead of
rejecting it, so a typo in one of those strings survives typecheck, lint and the eye. That is why
`layout.test.ts` runs the real algorithm and asserts on the _result_ — direction, spacing, port
order — rather than on the record being built. The aspect option is checked the same way, by
packing twelve components for a tall pane and then a wide one and requiring the second to be
wider, with the checkbox-off pair asserted identical so the test cannot pass on the packer's own
1.6.

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
different one. And `dataset.description` is **not** an annotation — it has a Dataset input, so it
is arranged rather than dodged; what keeps it off the pipeline is the next section rather than
this one.

### A companion is placed with its host, not after it

`layout/companions.ts`. A dataset node arrives with a Description card wired to it
(`NodeDefinition.companion`), and that card has no outputs at all — it is a credit hanging off the
dataset rather than a step. Handed to ELK as an ordinary node it is treated as one, and layered
puts it in the layer *after* its dataset, where it competes with the real next step for the column
and adds a row to it. Measured in a browser on the wizard's `flywire + banc / compare`: both
Description cards at x = −540 beside `find` and `find2`, a full layer right of their datasets at
x = −884; on the four-dataset co-cluster, one of them was the **topmost card on the canvas** while
its dataset sat in the previous column.

**It is condensed, not constrained.** ELK has no "directly below" constraint, and the two things
that come closest are both wrong: a partition puts the pair in one *layer* and says nothing about
which is above, and a post-pass that moves the card afterwards lands it on whatever ELK put there.
So the pair goes through `collapse.ts`' shape one level down — the companion leaves the layout
graph, **the host's box grows to cover where it will sit**, and it is put back at the declared
gap under the host once positions are known. ELK reserves the space, so nothing can be placed in it,
and the rule holds exactly rather than on average. The host keeps its id, ports and edges; only its
size changes, which is why `toElkGraph` and `place.ts` learn nothing about this.

The growth is the half that fails silently: withholding a node and putting it back produces a
perfectly plausible arrangement whether or not the box grew, and the only symptom is a card drawn
over whatever filled the gap. `companions.test.ts` runs the real algorithm and asserts no two cards
overlap at their real sizes — 1 collision with the growth removed. The grown sizes are an
**overlay** on the measurement map rather than a `size` on the node, because `resolveSize` reads
`measured` first and a written `size` would be ignored on exactly the graphs where it matters; the
overlay is a copy, since the original is what `structureKey` is computed from and growing it in
place would make the key follow the pinning rather than the cards.

Three refusals, each of which the obvious loop gets wrong. **A companion carrying any other wire
is left alone** — a Description has no outputs so this is not the daily case, but withholding a
node with a real dependency deletes that edge from the layout silently. That same rule settles the
*shared* companion: one card fed by two datasets is pinned under neither, rather than under the
first, because pinning it would hide the second wire while looking like a decision. **A second
companion on one host** stays an ordinary node, two cards at one offset being worse than either
place ELK would have chosen. And **a negative offset declines the pin**: the box's top-left is the
host card's, which is what keeps a pinned socket offset (`FIXED_POS` takes those literally)
describing the host — a companion above or to the left would need every one of them shifted, and
would sit outside the reserved box if they were not.

Expansion inverts `expandPositions`' rule on purpose. A folded group's members keep the
arrangement their author left, because folding is a way of telling the layout to leave that part
alone; a companion has no such arrangement to keep — it is placed by its host's *definition*, so
an arrange snaps it back there.

**Under the host's height, never at a fixed depth.** `CompanionSpec.offset` is `{ x, gap }`: the
companion's top goes `gap` below the host's **bottom** edge. It was `{ x: 0, y: 300 }` from the
host's top, and measured in a browser on a cold session a dataset card is 306–327 tall on neuPrint,
282 on CAVE, 249 on CATMAID and 161 as a Custom CATMAID card — so one depth overlapped every
neuPrint card by up to 27 units and left 139 of empty canvas under the last, on starters and on
hand-added cards alike. The height comes from two places, because there are two moments: **on add** (`addNodeWithCompanion`) nothing has drawn the
host, so it is the definition's declared `cardHeight` — the tallest the card was measured at, per
backend, which `registerNode` requires of every companion host — and **at an arrange** it is the
canvas's measurement, **floored by the declaration**. The floor is the part a browser found: a
starter's arrival arrange measured a neuPrint card at 291 and it settled at 326 once its listing
failed a moment later, so a snap to the measurement alone landed the Description 11 units inside it;
BANC's CAVE table card read about 219 and settled at 265, and its caption landed 46 inside. The
floor is `cardHeight` alone, not `defaultSize`: a resizable card resized shorter is drawn shorter.
Measured on every dataset type added by hand, the Description clears its card by 24 units, 44
under the four neuPrint cards that draw 20 short of the declared 326.

### A chain caption is carried the same way, and it is the one note that moves

`AnnotationChain.caption` arrives as a Text note under the chain it describes, and notes are not in
the layout: `dodge` keeps the arranged block off them and never moves one, because a note is
somebody's sentence about a place on the canvas. A caption's place is a *card*, so that rule left it
behind — after a starter's arrival arrange, FlyWire's caption sat 399px (on screen) above the box it
captions and BANC's 476px above its card. So a caption goes through the companion's shape exactly:
it leaves the pass, its host's box grows to cover it (the same overlay), it is taken off `dodge`'s
obstacle list, and it is snapped `CAPTION_GAP` under the host afterwards.

**Declared, never inferred.** A caption is a note carrying `GraphNode.captionOf`, the id of the
card it is about, written by the builder that placed it (`wizard/build.ts`). Every other note keeps
`dodge`'s rule however near a card it sits; inferring "the card this note is under" would move
notes somebody placed deliberately. Being an id reference, it has the same three places to stop
naming something as a group's membership: dropped on load when the card is not in the file,
remapped by paste and duplicate (`insertFragment`, which needs the whole id map because a card can
come after its note), and dropped — the note kept — when the card is deleted.

**The host is the card named, or the box standing in for it.** The builder names the chain's output
card (`join` on FlyWire, the lone CAVE table on BANC). While that card is inside a **folded** group
the host is the group's box, which is what is drawn and where the caption was placed to begin with.
**Expanded**, the frame is not a layout item — only its members are — so the caption goes under the
card it names: the one thing in that state ELK can reserve room under, where a post-pass under the
members' union would land on whatever ELK put there. A host already carrying a pinned companion
refuses the caption, for the "second companion on one host" reason. Auto-layout, the Arrange button
and the arrival arrange all run `condenseForArrange` / `expandArranged`, the same pair the tests run
against ELK (`src/test/arrange.ts`).

### A reference edge is not a layering constraint

`arrangeScope` filters through `core/graph.ts`' `referenceEdgeIds`. A reference names a node
instead of consuming its output (`PortDef.reference`), which is exactly why `topoSort` and
`wouldCreateCycle` already exclude them: a round trip through one is not a cycle. Handed to ELK it
**is** one. An annotation chain reads its datastack out of the dataset it is about to feed
(`dataset:dataset → chain:dataset`) and feeds the same dataset back
(`chain:out → dataset:annotations`), so layered has to break the two-edge loop and picks whichever
end it likes — and on the wizard's cross-dataset workflows it picked the annotations edge, drawing
the plumbing *after* the thing it feeds. Measured in a browser: the folded FlyWire chain at
x = −540 with its dataset at x = −884.

**Excluded rather than reversed.** Reversing asserts a direction ELK would then reserve a routing
channel for; a reference constrains nothing, so the honest statement is that it is not an ordering
constraint at all. Nothing here touches what the canvas draws — the wire is still there, and still
a wire.

**And filtering at the scope is not enough on its own — this is the half that was shipped broken
and caught in review.** `collapsedView` merges its stand-ins from `graph.edges`, *not* from the
edge list the caller hands `condense`, so a withheld wire comes straight back as `ds → box` the
moment either end is folded. That is not a corner: `foldChain` folds FlyWire's annotation chain by
default, so the exact graph the rule was written for still went to ELK with its two-edge loop. The
arrangement it produced looked entirely reasonable — the browser measurement passed by luck —
which is why nothing saw it until the edge list itself was printed. So `arrangeScope` **returns**
the set it withheld, `condense` takes it as `omit`, and `CollapsedEdge.merged` names the real wires
behind each stand-in so a stand-in can be dropped when **every** one of them was omitted. One
author, every stage applying the same rule. `collapse.test.ts` pins all three: that the unguarded
call still re-introduces the loop, that the guarded one does not, and that a stand-in merging one
omitted wire and one real one survives.

**One arm does not show it, and that is worth knowing before writing a fixture.** Swept against the
real algorithm with the references left in: at one dataset the card still lands left and the bug is
invisible, at two the second arm's card flips, at three both later arms do. Two arms is also the
shape the wizard builds for a comparison, which is where it was reported. `layout.test.ts` covers
both halves — that `arrangeScope` withholds the edge, and that ELK then puts the card on the left —
and both were verified by mutation, since the first passes on a fixture the second cannot fail on.

What the two rules together bought, measured in a browser at a pane of 1600 × 843 (aspect 1.90),
arranged bounds before → after:

| workflow                       | before             | after              |
| ------------------------------ | ------------------ | ------------------ |
| flywire + banc, compare        | 2016 × 1414 (1.43) | 2016 × 1072 (1.88) |
| hemibrain + malecns, compare   | 1916 × 1323 (1.45) | 1916 × 1072 (1.79) |
| four datasets, co-cluster      | 4112 × 2545 (1.62) | 4112 × 2167 (1.90) |

The width never moves — neither rule adds or removes a layer from the pipeline — so the whole of it
is height, and all three now sit at or near the shape of the pane they are framed into. The
four-dataset figure is the one worth reading twice: it was 2475 with the reference rule applied at
the scope alone, and only reached 2167 once `condense` stopped handing the withheld wire back. The
graph with the most folded chains had the most to gain, and the version that "worked" in the browser
was leaving a third of the improvement on the table while looking correct.

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

### Packing columns into the shape of the canvas

`layout/pack.ts`, a **post-pass** on ELK's answer, on by default and switched off by *Pack columns*
in the options bubble. Layered gives every node its own layer and a layer is a column, so it spends
a whole column on a card that is only ever a leaf and makes the graph as tall as its tallest column
whatever else is going on. Measured in a browser on a hand-tidied FlyWire workflow: **1939 × 1259
against the hand-placed 1743 × 857** — 63% more area for the same six cards, most of it an L-shaped
void beside a tall Neuroglancer card.

The move a person makes and layered cannot is to put a card in its *predecessor's* column, drawn
below it, so `Explore ▸ Table` is one column rather than two. That is a layer violation by
construction. **No ELK configuration produces it**, which was swept rather than assumed:

| what was tried                      | area   | aspect | vs hand-placed              |
| ----------------------------------- | ------ | ------ | --------------------------- |
| `layered`, as it shipped            | 2404k  | 1.56   | +61%                        |
| all four `nodePlacement` strategies | 2404k  | 1.56   | +61% — no change at all     |
| `postCompaction`, all five          | 2216k  | 1.44   | +48%                        |
| `mrtree` / `force`                  | ~2280k | ~1.3   | +49% / +57%                 |
| `rectpacking` / `box`               | 1617k  | 0.92   | +8%, by ignoring every edge |
| **this pass**                       | 1652k  | 2.28   | **+11%**                    |

End to end that is 1939 × 1259 becoming **1941 × 851**: the width does not move at all, and a third
of the height goes. `elk.partitioning` was tried as a way of handing the columns *back* to ELK; it
ignored the assignment and spread the graph to 2557 wide, worse than not asking.

**A post-pass, not a fifth algorithm.** Run standalone it gives the same answer as it does over
ELK's output, so replacing layered buys nothing and loses crossing minimisation, the within-layer
ordering and the port-order work that makes a wire arrive at the right socket. It reads ELK's answer
and moves cards *leftwards into slack*, which is why it composes with the algorithm choice instead
of being one — and why the checkbox sits in the bubble rather than in the algorithm dropdown. It is
gated regardless by `packApplies` — one predicate the checkbox and the pass both read, homed in
`options.ts` beside `aspectRatioApplies` for that predicate's reason. It asks for `layered` **and
`RIGHT`**: a column is a layer only under a left-to-right direction. Under `DOWN`/`UP` layered's
layers are *rows*, so grouping by `x` reads within-row neighbours as columns and stacks them, and
under `LEFT` "move into an earlier column" moves a card *against* the flow with the
predecessor/successor asymmetry inverted. `force` and `radial` have no layers at all.

**The objective is one-sided, and that is the whole character of it.** It scores only how much
*taller* than the target shape the box is; once the graph is wide enough the score is zero, no move
can improve on zero, and the input comes back untouched. Scoring the distance to the target in both
directions makes the packer fight a graph for being too *wide*, which is nobody's problem — measured
on a four-card chain, perfectly good at an aspect of 5.4, a two-sided score folded it into a single
vertical column to "reach" 1.6.

**The target is the pane** (`canvasAspect`, the one input the graph cannot answer), clamped through
`ASPECT_RANGE` and falling back to `PACK_TARGET_ASPECT` = ELK's own 1.6 when it cannot be measured.

Routing it through `useScreenAspect` instead was built and measured first, because that control
exists to answer exactly this question and its note argues a window-dependent arrangement makes a
shared file land differently on the next machine. **The measurement settled it against that**: on
the worked case the packed height is 851 aiming at the pane and 1156 aiming at a fixed 1.6 — most
of the win, on the graph the feature was built for, and the complaint it answers is *specifically*
"taller than wide despite the screen having more horizontal space". A packer aiming at a constant is
a worse answer to that, and one needing a second checkbox — labelled for something else — before it
works properly is the shape of control this codebase has deleted before. The cost is bounded: two
people pressing Arrange on one `.coda.json` at different window shapes get different arrangements,
but not a different *file*, since positions are saved. `useScreenAspect`'s note has been narrowed to
say it governs `elk.aspectRatio` alone — silently outgrowing it was the part that would not do.

Two rules keep the result readable rather than merely small. A card joins a column at its **bottom**,
so it may share one with a *predecessor* — the wire runs downwards, which is the move being copied —
and never with a *successor*, which would draw a wire back up the column; minimising the box with
that second rule missing put a dataset's annotation chain below the dataset it feeds. And the order
within a column is **ELK's**, by `y`, never recomputed: this pass moves cards between columns and
reorders none, so the crossing minimisation still holds.

Columns are read off ELK's `x` with a tolerance of half the layer gap, because layered left-aligns a
layer but nudges a node whose predecessors are all short a few units off its neighbours — grouped by
exact `x` that reports one column as several and the pass has nothing to merge.

Two gates stand it down entirely, and both are correctness rather than caution. **More than one
connected component, while `packComponents` is on** and it declines: ELK packs disconnected pieces
in *two* dimensions, so its answer is not a row of columns and summing column widths describes a
single strip — run over it the pass would mis-score and merge a column of one component with an
unrelated column of another, dismantling the packing that option just asked for. The two are
complements, since `elk.aspectRatio` shapes a multi-component graph and can do nothing for a single
chain. It is conditional on that option because the argument is: with component packing off, ELK
gives every node one shared set of layers and the model holds at any number of pieces.

Worth knowing what the component gate costs, because it is not rare: **an unwired card is a second
component**, so packing stands down while a graph is being built and comes back when the last wire
lands — and it counts components of the *layout* graph, which `arrangeScope` has already stripped of
reference edges, so a card joined only through one is its own piece here while the canvas shows it
connected. Both are a missed improvement rather than a worse arrangement. Packing each component and
re-placing the boxes is a rectangle packer, i.e. a second algorithm, which is why declining is where
this stops. **Above `PACK_MAX_NODES` (80)** it declines too: the greedy is `passes × nodes × columns` trials
and `passes` grows with the graph on exactly this shape — re-measured against the current code on
the worst *legal* shape at 2.3 ms for 40 cards, **33 ms at 80 and 200 ms at 120**, synchronously
inside a promise continuation, so the tail would eat the frame the arrange animation starts on. An
ordinary pipeline is not on that curve: already wide enough, it evaluates one box and leaves, about
0.1 ms at any size. Both gates are pinned at their boundary, because a fixture the packer would
decline anyway proves nothing. `docs/limits.md` carries the row.

**What it costs is ELK's edge routes.** A bend point describes a gap between two cards at the
positions ELK chose, so a card that has moved to another column leaves its wire heading into empty
space — the staleness `routeKey` exists to catch. `useArrange` gives the routes up whenever this
pass moved anything. The `orthogonal` mode survives it, because it steps *every* wire rather than
only the ones ELK bent; what is lost is the routed-around-a-card half. That is the same trade
`EdgeRouting`'s note records, and it is why "did it move anything" matters — a graph the packer
cannot help keeps every route it would have had.

**That signal shipped broken for one round, and it is the useful part of this record.** It rode on
map identity (`raw !== laid`), and every one of the packer's do-nothing exits builds a fresh `Map`,
so `packed` was true on every arrange and the waypoints were discarded even on the graphs the pass
declined to touch. Three doc comments described the contract and nothing enforced it; the test that
was supposed to pin it asserted *zero* routes after a pack, which passed for exactly the wrong
reason. `moved` is a field of the return type now, so the compiler carries it, and the test asserts
the case jsdom can actually show — that a decline **keeps** the routes. The two remaining route
tests arrange with packing off, since they are about the waypoints rather than the packer.

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
frame's menu, pointed at its members (dimmed while that frame is folded; see below). `ui/panels/AlignTools.tsx` draws it; `layout/align.ts` is
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

**A folded group is one card, and it is `condense`'s answer rather than a second one.** Taking
hold of a box selects its *members* (`useGroupDrag`), and folding a frame leaves them selected,
so a selection reading "this card and that box" is half a dozen ids of which most name cards
nobody is drawing. Handed straight to `alignNodes` those were what moved: the cards *inside*
the box were brought onto one edge, invisibly, while the box wandered to wherever its derived
corner then sat and the one card on screen stayed put. The fix is the three steps `useArrange`
already takes, minus the layout in the middle — `collapsedView`, `condense(selected, [],
view)`, align, `expandPositions` — so align and arrange cannot come to disagree about what a
folded group counts as, and `layout/align.ts` goes on knowing nothing about the feature. Two
properties come with the pair rather than being written again here: a box is aligned by *its
own* geometry, the frame's corner and the box's size, since that is what somebody sees; and its
members move by the **delta**, so the arrangement inside the frame survives exactly as it does
under an arrange pass. What is new is only that the minimums count **condensed** cards, so a
card beside a folded box is two cards to align and not three to distribute.

The frame's own menu needs no argument for this: every id it passes is a member of the one box
it draws, so what the grid condenses to is a single card and the tools dim themselves. The
reason is worded for the case — "expand this frame to align the cards inside it" rather than
"select at least 2 cards", which is not true of a frame holding five — and it is read off the
condensed set rather than passed in as a prop, so it belongs to the condition instead of to the
surface that happens to raise it.

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
