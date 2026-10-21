# Canvas: wires

Dropping a wire on empty canvas or a node onto a wire, breaking and re-routing links, and the
output-port preview. [canvas.md](canvas.md) holds framing, fitting and the lock.

## Dropping a wire on empty canvas

Letting go of a link drag over nothing opens the command palette filtered to nodes that can take
what is on the wire, and picking one inserts it and wires it up. The filter was already there.
**What it filtered on was `isAssignable`, and that is not the question.**

**Dropping a `Tree` opened on five nodes that would all have refused it.** In order: `Mirror
Neurons`, `Select One`, `Split Neurons`, `Stack Neurons`, `Transform Neurons` — then `Cut Tree`
and `Dendrogram`, which are the only two nodes in the registry that take a linkage at all. Every
one of the five leaders declares `T.any()` as a stand-in for a union `CodaType` cannot spell, and
every one had the real answer written down already, as the predicate its own `validate` refuses
on — `isGeometryKind`, `isSplitKind`, `isIterableKind`. Nothing connected the two, so the palette
believed them and so did the card, which lit those sockets for every drag in the app.

**`PortDef.kinds` is the connection, and it takes the same array.** Not a transcription of it:
`GEOMETRY_KINDS` moved into `core/types.ts` (which kinds are geometry is a fact about `CodaType`),
`ITERABLE_KINDS`, `SPLIT_KINDS` and `COLLECTABLE_KINDS` are exported from the modules that own
them, and each node hands the port the array its predicate already reads. `registerNode` refuses
the three spellings that fail silently — a set beside a concrete type, an empty set, `any` inside
a set. `core/sockets.test.ts` sweeps the registry for an `any` port that declares neither
`kinds` nor **`anyKind`** — the sibling field that says an `any` is deliberate — and one node
holds it: **`out.download`, the only port that really means anything.** The exemption was an
allow-list in the test first, which put a node fact in a test file with an unenforced prose twin
in `download.ts`: you could delete the `kinds` off `Mirror Neurons`, add its name to the list,
and ship a green build.

**Then order, because filtering alone leaves 61 rows for a neuron table.** `socketTier` is four
tiers — the kind itself, a widening `isAssignable` allows, a named union, a bare `any` — with
*required before optional* under it. It is the mirror image of `wizard/demo.ts`' `tierOf`, which
ranks the source end of the same question and was put there by two wrong demos. The optional key
is what stopped a neuron table opening on eight dataset cards: every dataset has an optional
`annotations` socket taking a table and `dataset` sorts first in the registry.

**Declaration order stays inside the node**, and that was got wrong first in a way one row shows.
Folded into the rank the caller sorts on, it made "the node whose *first* port takes this" beat
"the node whose second port takes this", and a neuron drag opened on `Copy IDs` — whose only
socket is a neuron table — above `Connectivity`, whose `neurons` port is its second. Between two
nodes at one tier the order that means something is the registry's.

**The drag carries the socket, not the type.** `dragPortSocket` reports the *declaration* on an
input, which for these ports is `any` — so dragging backwards out of `Mirror Neurons` asked "what
produces anything?" and answered with every producer there is. With the set it answers six, and
the wire in flight leaves violet instead of grey, which is the second half of a sentence
`draggedWireStyle`'s own doc comment had been making since before it was true.

What it comes to, dropping from an output:

| wire | before | after |
| --- | --- | --- |
| `Linkage` | 10 rows, `Mirror Neurons` first, `Cut Tree` sixth | **3 rows**, `Cut Tree`, `Dendrogram`, `Download` |
| `Points` | `Split Neurons` offered | `Split Neurons` gone — it declines points — `syNBLAST` first |
| `Skeletons` | 12 rows in category order | 12 rows, exact kinds first, unions next, `Download` last |
| `Neurons` | 65 rows led by 8 dataset `annotations` sockets | 61 rows led by the queries; the datasets sit at 43–50 |

**A wire outside a declared set is refused**, and that took a second round to get right. It
shipped narrowing only what was *offered* — `producedBy`'s declaration-not-constraint line — and
came back as a bug: `Mirror Neurons`' output draws as a violet Geometries ring and could be
dropped straight onto a `Dataset` socket, which is a promise the picture makes and the behaviour
broke. `checkConnection` reads the declaration now and says which two (`Geometries does not fit
Dataset`, where the old message would have managed `Any does not fit Dataset`).

**The half that made it invisible is worth more than the fix**: an unwired passthrough's
`inferOutputs` hands back a perfectly truthy `T.any()`, so every reader that took the inferred
type and stopped there threw away the only declaration that knew anything. Two did — the wire
check and the *drag itself*, which is why the in-flight wire off that socket drew grey and dimmed
nothing while the socket it left drew violet. `resolvedSocket` is that rule in one place, and
`portStyle`'s "`any` counts as unresolved" clause turned out to be the same rule with a smaller
reach. It also deleted work: `splice.ts` had grown a `socketAccepts` guard at each end for its own
version of this, and `checkConnection` learning the rule subsumed both — the test that caught the
spliced Mirror still passes with them gone, which is the evidence they were a symptom patch.

Why `resolved ?? declared` is not the rule: `outputTypesFor` seeds the inference map with the
port's own declared `type` before asking `inferOutputs`, so the inferred value is never absent — it
is a truthy `T.any()`, and the fallback never fires. **`resolvedSocket` deliberately stops short of
`inferGraph`'s own input check**, which stays `isAssignable` (the comment in `core/inference.ts`
records it): that check is the only gate a pasted or shared wire passes through, and every port
declaring `kinds` took that array from a `validate` that already reports the mismatch in its own
words, so asking `socketAccepts` there added a second, worse sentence to every such card.

An unresolved socket is still never refused: a bare `any` on either end passes, so a half-built
graph wires up exactly as it did.

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

## Previewing an output port

Hovering an output socket puts up a small panel showing what is actually on that wire — the
headline the card's own footer draws, the facts a count implies nothing about, and the value's
**columns down the panel with its first row across**, under a head naming all three. `OutputPort` owns the gesture, `portPreview` decides the content, `PortPreviewPanel` draws
it, and `hoverPlacement` puts it somewhere. Measured with `pnpm probe:port-preview`; the unit
coverage is `ui/nodes/portPreview.test.ts`, `ui/nodes/portPreviewHover.test.tsx` and
`ui/hoverPlacement.test.ts`.

**It is silent where nothing has run, and that is the decision the whole component is shaped
around.** A port's value exists only once its node has run. Hovering may not cause a run and may
not fetch — invariant 6 is the record of what a per-keystroke request at a shared production
server costs — and a panel offering a Run button is that button an inch from every socket on the
canvas. The alternative considered was falling back to the *inferred* schema, labelled as
not-run: real information, free, and rejected because a hover that answers on a port with no
value and a hover that answers on a port with one are two different promises under one gesture,
and the second is the one somebody acts on. So the store is asked at the moment the delay
elapses, and where it answers nothing the socket's own `title` is what the reader gets.

**With a second line on it, which is what the silence was otherwise missing.** A port with
nothing cached says nothing, deliberately — and a reader who has seen a preview on one socket and
gets none on the next cannot tell "this node has not run" from "this does not work here". So the
tooltip carries `Run this node to preview its output`, and the native tooltip is the right place
for it rather than a panel: a panel opens at 260 ms where a tooltip appears at about a second, so
on a port that *has* a value the title is dropped before it is ever seen and the line is read
almost only where it is true. It is gated on **`needsRun`** rather than on "is there a value" —
the card's own word for what a Run would change, already subscribed there so no socket subscribes
to anything, and it excludes annotation nodes, which have nothing to compute and for which the
sentence would be an instruction that cannot help.

That read is also why **nothing subscribes**: `getState()` at open time rather than a selector per
port. A sixty-node graph has a couple of hundred sockets, and a selector on each would put a
scheduler-cache lookup per socket on every run tick to serve the one the pointer is over. The
*panel* subscribes, because it is mounted one at a time and a hover can outlive a run — a preview
of a wire showing what used to be on it is the one thing this may not do.

**Outputs only.** An input's value is the upstream output's, one socket away and already answered
there; giving both sides a panel doubles the surface for a duplicate answer.

**The hover target is the whole port row side, not the disc.** A socket is 11px with a 20px hit
box, which is a fine target for a wire and a poor one for a pointer at rest. The delay is
**260 ms** against the thumbnail preview's 130, because the gestures differ: a thumbnail is
hovered deliberately, where a pointer crosses several sockets on the way to the one it wants and a
panel per socket would strobe down the side of the card.

**Three dismissals, and each covers something the others cannot.** The pointer leaving is the
ordinary one. A **press** is a wire drag starting on this very socket, so the panel goes *and
stays gone* until the pointer has left and come back — the flag is a ref, since a re-entry with no
intervening leave is exactly what a drag ending here produces. And the socket **moving** has no
event at all: React Flow pans and zooms by writing a transform onto the pane, and an auto-layout
pass moves the card outright, so the rect is watched per frame while a panel is open.

**All of which is `useHoverPanel`, because it was written twice first.** The delay, the mouse-only
guard, the portal to `document.fullscreenElement ?? document.body`, the rect measured at open
rather than on arrival, and the rAF watch above are Explore's thumbnail preview's too — about
forty lines that matched near token for token, comments included. `useDismiss`'s own note records
the same lesson one gesture over ("written out five times before this — a fix to that reached
exactly one popover at a time"), and the watch is exactly the piece where that bites: it has no
event to key off, so its tolerance and its "must not outlive the placement" rule are the subtle
part, and a fix to either used to reach one surface. What each caller keeps is what is its own —
the thumbnail's finer body, fetched on open and released on close; this port's store read, which
is also its `canOpen`. The press dismissal is an option because only a socket needs it.

**It opens right, where the thumbnail preview opens left, and the two rules are one rule.** Open
into the empty half: a thumbnail's row text is to its right, and an output socket's *card* is to
its left. That is why `hoverPlacement` is one function taking a `prefer` side rather than two
copies of a clamp — the second copy is where one side would get a fix the other did not. Neither
caller flips to the other side when the preferred one runs out: a clamp slides the box *partly*
over the anchor's content, a flip puts it *wholly* over it, and Explore measured that in a browser
before this feature existed.

**The panel measures itself and then places itself.** Its height is its content — two facts, or
two tables — so there is no size to hand `hoverPlacement` before the thing exists. Mount hidden,
measure, place, show; jsdom measures zero, which is why the arithmetic is a pure function tested
apart from the component.

**A network is two tables, and that is the shape the content model is built for.** Its nodes and
its edges have separate schemas, so a panel showing one of them shows the wrong one about half the
time. Geometry is the same one level down: a collection's attribute table is the collection's own,
which after a `Carry fields` join is not the table that named its neurons.

**The headline is `describeValue` rather than a second spelling of it** — that string is already
the card's footer, and two answers to "what is on this wire", one under the card and one beside
the socket, is exactly how they drift apart. **Which is also what the facts may not restate.** The
first version drew `Leaves 128 / Method ward / Cut 6 clusters` under a headline reading
"128 leaves · ward · 6 clusters" — `describeValue`'s own line taken apart and set again
underneath itself, and a second derivation of the same fields (two `new Set(clusters)`, two
`Object.keys(positions)`) free to drift from the first. So a fact has to be something the headline
cannot say: `directed` on a network, the backend behind a dataset, a matrix's `measure`, and for a
linkage the one thing `describeValue` says by *omission* — an uncut tree. Layout, transform and
layers are headline-only in consequence.

Every other kind answers something under its headline, and that totality is asserted, because a
kind that fell through to an empty panel would look on screen exactly like the not-run case the
hover is deliberately silent about — with the headline-only kinds listed in the test rather than
derived from the output, or the exemption could not tell a deliberate one from a fall-through. A
scalar is headline-only for the same reason, its headline being the value; a long string comes
back as wrapped text cut to `TEXT_PREVIEW_CHARS`, since a Neuroglancer link is 70 kB and hiding
the rest in CSS still builds it — a few thousand line boxes to paint six, synchronously, on the
frame the panel measures itself.

**The panel is pivoted, and that is a claim about which question it answers.** Which columns a
value carries is the thing a reader cannot get anywhere else — the row count is on the card
already and the values themselves are the Table node's job — and read across the page a wide table
spends its whole width on four of them. Turned ninety degrees a schema is a list, which is
`TableSummary`'s finding on a surface with the same shape. On the demo's neuron table that is 5 of
7 columns before against **all 7** after, in a panel 8px shorter.

**One value column, always, and the fixed number is the finding.** The first pivot spent whatever
width the field names left over, which drew four sample rows on a two-column table, two on a
neuron table and none at all on a table with no rows — the same feature looking like three
different ones depending on what the pointer was over, off arithmetic nothing on screen explained.
One is the count that always fits: a name, a type and a value come to 408px at their widest
against a 416px budget, so a *second* value column would have to be paid for by cutting the first,
and the cell most often under a pointer here is an eighteen-digit id, which invariant 8 says is
not an id once it is truncated. One honest example beats two mutilated ones — and it is
`TableSummary`'s answer for the same job. A table with **no** rows keeps the column and draws it
empty rather than as a dash: there is no first row to be absent from, and an empty table stays
recognisably the same drawing as a full one.

A **matrix keeps four columns and is not turned**: it is already a grid with a label on each axis,
a single column of one says nothing about it, and its short labels and numeric cells can afford
them. It is the same rendering all the same — a label column and some value columns — which is why
`fitCount` survives as its guard alone, and why `PreviewTable` carries a `fieldNoun` rather than
assuming one: a matrix's field is a row where a table's is a column.

**The head names all three, because pivoted they are otherwise three unlabelled things in a row.**
`column · type · first row`, and the field noun is *the same string* the footer counts in, so
"+36 more columns" cannot end up under a heading that calls them something else. That footer is
now the only thing in it: a count of the rows **not** drawn used to sit there too, and under a
list of fields it read as counting the fields — while saying nothing the headline (`401 rows × 7
col`) and the head (`first row`) had not already said between them.

`MAX_FIELDS` (24, halved between a network's two tables) is the height bound and the one thing
still counted, since a schema really can run past the panel. The rule it answers to is older than
the pivot and was earned before it: the first version took six columns across and let `max-width`
and `overflow: hidden` do the rest, which on a neuron table meant six columns wanting ~420px in a
360px panel — the sixth drawn as half a column of digits with no header, *underneath a footer
saying "+1 more columns"*. **A count is only honest if nothing else is dropping anything behind
it.** So the builder decides, and `pnpm probe:port-preview` asserts in a real browser that the
table overflows the panel on neither axis — the half an estimate of character widths cannot
promise, and two halves since the pivot put a field list under a `max-height` too.

Measured at 1600×1000 on the synthetic connectome:

| | panel | drawn | note |
|---|---|---|---|
| `Find Neurons ▸ Neurons`, 0.659× pane | 250×185 at 565,407 | all 7 columns, one value each | 401 rows × 7 col, and no footer at all |
| the same, 0.243× pane | 250×185 | 7 × 1 | identical, and 11px type at both — no transformed ancestor |
| `Paths ▸ Network` | 211×351 | Nodes and Edges, both schemas whole | the tallest case, against a 1000px window |

349 and not 129 is the transform question answered — the panel is portalled to
`document.fullscreenElement ?? document.body`, which is also what gets it out of `.coda-node`'s
`overflow: clip`, and the hit test at its own centre is what says so. `pointer-events: none` is
load-bearing for a sharper reason than the thumbnail preview's: the panel opens beside a socket,
which is where the next wire is dropped.
