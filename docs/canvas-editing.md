# Canvas: hints, groups and the clipboard

Hints docked to a card, group frames and folding them, and copy, cut and paste.
[canvas.md](canvas.md) holds framing, fitting and the lock.

## Hints on a card

A small dismissable box docked to a card's top or bottom border, carrying guidance somebody wrote
*about that card*: "search and tick neurons here". The document side is `NodeHint` on `GraphNode`
(`core/graph.ts`), the box is `ui/nodes/NodeHints.tsx`, and what has been read is `ui/hints.ts`.
The Workflow Wizard writes them (`docs/wizard.md`), and so does anybody preparing a workflow to
share, through the node menu's **Add Hint…** — see the end of this section.

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
  the clicked card's; the `?` ▸ **Guides** menu's **Show Hints Again**, its last row and under a
  rule since it is the one entry there that starts no tour, restores the lot. Each row appears
  only when there is something to bring back. A box dismissed for good with no route back is the
  failure this feature is one deleted row away from at all times.

Both are live under the lock, and neither is an undo step — freezing the canvas changes nothing
about what a reader has read.

**Outside the card rather than inside it**, which is the distinction the design is defending. The
card already draws a band for what the *machine* has to say: `ui/nodes/nodeIssues.ts` ranks an
inference error over a run warning over a type warning and shows one at a time, inside the border.
A hint is what an *author* has to say. Sharing a band would make "the graph is broken" and "here is
where to start" the same kind of object, and a reader who cannot tell them apart acts on neither.

**The tone is a name off `markdown.ts`'s `CALLOUT_TONES`, never a colour.** A `.coda.json` arrives
from a gist, from the Zoo, from a mailed file, and a tone spent into an inline `style` is a CSS
injection — the same reasoning `GROUP_COLORS` records, and `deserializeGraph` falls back to the
default for an unknown one rather than passing it through. The vocabulary is the help documents'
own (`note` / `tip` / `warning`), because they already draw admonitions in exactly those three and
a second three-word list is how "tip" comes to be blue in one place and green in another. The
stylesheet agrees by sharing `.markdown__callout`'s own `--cal` token and its tone table rather
than carrying a second one.

**Writing one is an edit, and dismissing one still is not.** The node menu's **Add Hint…** and the
✎ on a box open `ui/panels/HintEditor.tsx`, a popover hung under the card with the text, a tone, a
side and a preview at the card's own width. Save and Delete go through `setNodeHints`, which runs
the loader's own `validHints`, so a hint written in the app obeys exactly what a mailed file does —
no empty hint, no unknown tone, no more than `MAX_HINTS` — rather than a second set of rules the
next load quietly disagrees with.

This reverses a scope line this section used to draw: that a right-click "Add hint" would compete
with the Text note for the same sentence. The wizard had settled that split by then (`docs/wizard.md`,
*Why three of the four moved off the canvas*): a sentence whose subject is **one card** is a hint, a
sentence about **the graph** is a note. What is left is four rules.

- **Live under the lock**, like renaming a card or a frame. The lock freezes structure and geometry,
  and a sentence docked to a card is neither; `store/lock.test.ts` classifies both actions.
- **The ✎ sits beside the ×, because they are opposite acts.** An author tidying a workflow reaches
  for the × to delete their own sentence, watches it go, and shares a file that still carries it.
  The editor's footer says it in words: the × hides a hint for one reader, Delete removes it for
  everybody. The ✎ is drawn only on hover where there is hover, and always on a touch screen.
- **The popover does not close on a press elsewhere**, unlike every `ContextMenu`. It holds a
  half-written paragraph, and the press that lands outside it is usually the author clicking the
  card to check what it does. Escape, Cancel and Save are the ways out.
- **Saving restores that text's dismissal.** Dismissal is keyed on the words, so an author who once
  dismissed the same sentence elsewhere would otherwise save a hint they cannot see.

Wizard hints are ordinary hints here — editable, deletable — which is what somebody tidying a
generated workflow for colleagues wants, and why there is no "authored by" flag to keep true.

**A sentence true of the reader's browser is derived, never written.** Link Table in Firefox or
Safari cannot keep a local file across a reload (no File System Access picker, so no handle to
remember), and the card says so in a hint. Written into the node when a Firefox user added it, that
sentence would ride a share link to a Chrome user, for whom it is false, and never appear on the
same card opened in Firefox from somebody else's file — the document is the wrong home for a fact
about whoever is reading it, which is the same argument that put dismissal in `localStorage`. So
the definition answers per card from its params and the browser (`NodeDefinition.readerHints`, on
the definition rather than in a UI table so the type is declared in one place), and `splitHints`
folds the answer in after the document's own: the same box, the same ×, dismissal on the same text
key, and **Show Hints** / **Show Hints Again** bring it back. What it lacks is the ✎ — a box gets one
only when its hint is in `node.hints`. The answer must be a module constant or an empty one,
because `CodaNodeView` asks on every render to decide whether to mount `NodeHints` at all. Whether
the browser remembers is `hasFileHandles` in `data/files/remembered.ts`, the one statement the
card's picker and the missing-file sentence read too. It appears only once a *local* file is
chosen: a URL survives a reload everywhere.

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
  per render. `groupBox` takes **one** accessor (`nodeRects`) rather than a position lookup and a
  size lookup that have to agree — the loop frame's substitution composes that single resolver
  once, and the folded box's corner comes from the same `union` the arrange's own bounds use.

**A node belongs to at most one group and groups do not nest.** So "which box owns this card" has
an answer, which is what folding a group into one box needs — see *Folding a group*, below — and
what an overlapping model could not give it. Grouping a card that is already framed **moves** it rather
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

## Folding a group

⌘-free: the chevron above a frame's top-left corner, or **Collapse** on the frame's own menu. The
frame is replaced by one node-sized box carrying its title, the number of cards inside it and a
mini-map of them; every wire crossing its boundary arrives at a single socket on the left or
leaves from one on the right. `GraphGroup.collapsed` is the whole of what is stored.

**A collapsed frame *is* a React Flow node, and that inverts the rule above deliberately.** The
case against a node for an expanded frame is that its members are cards whose positions must stay
absolute, and `parentId` would re-base them. A folded frame has no members on the canvas at all:
it is a box that wires arrive at, which is exactly what a node is. Drawn in the viewport portal
instead it would need hand-rolled edge geometry, hand-rolled handles and a hand-rolled hit test
for both ends of every crossing wire. It is still not in the document — the pseudo card is minted
per render by `layout/collapse.ts`, `graph.nodes` never holds one, and three React Flow flags keep
it that way (`draggable`, `selectable`, `deletable` all false), each closing a path that would
otherwise reach the store with an id naming nothing. `collapsedGroupId` is asked at the top of
`onNodesChange` for the same reason.

**Those three flags cost the box its pointer, and both failures looked like features working.**
`NodeWrapper` puts `pointer-events: none` on any node that is neither selectable nor draggable and
carries no mouse handlers of its own (`hasPointerEvents`), so the box could be neither grabbed nor
right-clicked: a drag reached the pane and **panned the canvas**, which moves the box on screen by
the drag delta and is indistinguishable from a drag that worked unless you check whether anything
*else* moved — the first browser check here did not, and reported a working drag. A right-click
reached the pane and opened the node palette, leaving the chevron as the only way back out.
`node.style` is spread *after* that line in the wrapper, so `style: { pointerEvents: 'all' }` on
the pseudo node is the seam that puts it back; the gestures stay ours. jsdom dispatches neither
gesture, so what the suite pins is the inline style.

**One derivation, two readers.** `collapsedView` answers the canvas (which cards to withhold,
which box to draw, which wires to redraw) and the layout pass (`condense` → one ELK node per
folded group, `expandPositions` → the members move by the delta the box was given). Written per
surface, the half that goes wrong silently is the second: an arrangement made against the members
while the canvas draws a box moves cards nobody can see and leaves a hole where they were. A
consequence worth knowing rather than designing away: folding a group is now also how you tell
auto-layout to keep part of a graph as it is.

**Crossing wires are merged by their two visible ends, and drawn un-interactive.** Several cards
inside one box wired to the same socket outside it are one line; keeping every real edge would
stack N hit targets under that line, any of which deletes a wire into a card the reader cannot
see. The merge key includes the *port*, so two wires from one box into two sockets of the same
card stay two wires. A merged line takes its type colour only when every socket it stands for
agrees; where they disagree it is achromatic, because a wire drawn Neurons-green that is also
carrying a table is a claim.

**Two things about the selection, and the second was found in a browser.** A folded group's
members stay selected in the store — that is what the inspector, ⌘D and the box's own outline
read — and React Flow is told the truth about it. But React Flow draws a **multi-selection
rectangle** around every node it thinks is selected and does not skip hidden ones, so a folded
group left an 850×240 box across the empty canvas its cards had vacated, draggable, moving cards
nobody could see. The overlay is stood down instead (`has-folded-selection`), and only while the
selection reaches into a fold. Lying about the flags was the other option and is worse: a hidden
card React Flow does not know is selected is one a pane click cannot *de*select, so the store's
selection would quietly accumulate cards nobody can see and the next ⌫ would take them along.
jsdom draws no such overlay, so nothing in the suite could have caught either half.

The same overlay had a second failure on an ordinary canvas, and it reads as a bug somewhere else
entirely. React Flow gives its rect `pointer-events: all` and hangs a drag-the-whole-selection
gesture off it, and the overlay is a **sibling of the viewport at `z-index: 3`** — above everything
the renderer draws. So the box a Shift+drag leaves behind covers the cards it surrounds and takes
their events: a right-click there reaches `onSelectionContextMenu`, which `Editor` does not pass,
and with nobody calling `preventDefault` the **browser's** menu opens over the canvas. What is
reported is that the node menu stopped working after a box-select. The rect is made
`pointer-events: none` in `editor.css`, leaving the box as a marker of the selection's extent and
nothing more; dragging any *card* in the selection still moves all of them, which is React Flow's
own behaviour rather than this overlay's, and what is given up is dragging by the empty space
between the cards. Same silent failure as the rule above — jsdom draws no overlay, so an upstream
rename brings the interception back with every test green.

### The controls a folded group carries

A frame may promote any of its members' params onto the box (`GraphGroup.exposed`), which is what
makes a folded group something you can still *drive* — the picker is a section inside the frame's
own menu, closed by default and counted on its row.

**A reference, never a copy.** `{node, param}` names a card and one of its params; the row draws
the same `ParamField` the card and the inspector draw, with an `InferContext` built for that node
the way all three existing surfaces build one, and writes through the same `setParam(nodeId, …)`.
One value with two editors: nothing about evaluation, the cache or the provenance key differs,
because nothing about the *param* differs. A column picker on a promoted param therefore resolves
against its own node's input schema, and typing coalesces into one undo step, both for free.

**Three ways the reference stops naming something, checked in two places.** A card outside the
frame or a param the type does not declare is refused at the edit and dropped at the load
(`validGroups`); a deleted member is dropped by `pruneGroups`, a regrouped one by `createGroup` —
a frame drawing a control for a card it no longer contains is the same lie as a membership naming
a node nobody can see. `cloneGroups` **remaps** them, or a duplicated frame's controls would write
to the original's cards, with both boxes on screen. The third check is `visibleIf`, and it lives in
`collapsedView` rather than in the file on purpose: it is a function of the node's *current*
params, so it answers differently a keystroke later.

**The same call decides the rows and the size.** A box with controls is 288 wide and taller by a
row each, and that size is what the canvas draws *and* what ELK is told — computed once in
`layout/collapse.ts`, so a row the layout reserved no space for cannot exist. The three numbers
that add up to it reach the stylesheet as custom properties the card writes onto its own element
(`--collapsed-header`, `--collapsed-row`, `--collapsed-rows-pad`), which is `AddMenu`'s
arrangement: the arithmetic belongs where the size is decided, and only CSS can draw it, so the
numbers go that way rather than being written twice. The card draws from `box.size` rather than
React Flow's `width`/`height` props: the same number in a browser, and not the same under a
measurement stub.

Two details found in Chrome. The controls band **swallows the pointer** (`stopPropagation` on
pointerdown, not `nodrag` — React Flow's class only stops React Flow's drag), or a pointerdown on
a slider takes hold of the frame and moves every card inside it while the value stays put. And the
row's label is two elements, `Card · Param`, of which only the **owner** shrinks: as one
ellipsised string at 288px a row reads `Explore Dataset · Sea…`, naming the card you already know
and hiding the control you were looking for.

Params of a node that draws its own body (Find Neurons, Paths) are offered like any other and get
the generic control, which for most of them *is* the card's control and for a few is the raw
value. That is the reader's call rather than a rule per node type somebody has to keep true.

### What a folded frame says about the run inside it

Folding hides the cards, not the work — so the box says what those cards would have: the **running
ring** while any member is running, and an **error badge** with a red outline while any of them has
failed. Without it a graph working inside a fold looks idle, and a failure inside one is invisible
until somebody unfolds it.

Three things worth knowing. The ring is `NodeRunRing`, which sizes itself against React Flow's
wrapper with `pathLength="1"` and now takes the one number it cannot derive — the corner it should
be concentric with, `COLLAPSED_RADIUS`, since a folded frame wears the frame's 14px rather than a
card's `--radius`. A prop rather than a stylesheet rule reaching in, because the ring is a
*sibling* of what it rings and the alternative was a CSS selector keyed on React Flow's generated
`.react-flow__node-groupBox` — i.e. on a TypeScript string constant, which a rename breaks in
silence. It is **indeterminate on purpose**: a group's progress is not the mean of its members',
and averaging a member reporting 90% with one that has not started claims a number nobody measured.

**Only the failure reaches the outline**, and it does so by joining `.coda-node[data-state='error']`'s
own rule rather than writing a second one. Running is the ring's to say: a card tints its *header
strip* for it, which a folded box has not got, and a second signal that only ever appears
alongside the ring is a rule to keep true for nothing. Both can still be true at once — a box
wears the ring and the badge while one member works and another has already failed.

The two facts come from `useAnyNodeState` and `useNodeStateCount`, `useStaleCount`'s idiom scoped
to a set, each returning a **primitive** for invariant 7's reason. A *boolean* where only
truthiness is read: a running count makes every 1→2→1 among members a new snapshot and a full
re-render of a box whose markup never changed, and a For Each region ticks thousands of times. The
badge is the card's `.state-badge` with the card's glyph (`STATE_GLYPH`, lifted to
`ui/nodes/runState.ts` at its second reader) plus a count, which is the one thing a card's badge
never says — `--count` widens the 14px disc into a pill, because two characters in a circle sized
for one is a clip.

`ui/panels/groupMenu.test.tsx` fakes the states through `nodeInfo` (restoring it after each case,
and holding one object per id — a fresh `{ state }` per call is an identity loop). The states were
also driven for real in Chrome: folding a frame around the neuPrint dataset node with no token and
pressing ⇧R, a `MutationObserver` on the box saw the ring appear and then the error land, ending on
a red outline and `1 node of 2 inside failed`.

Not built, and deliberately: the mini-map does not mark *which* member failed. It is drawing a rect
per member already, so a stroke on the failed one would turn the count into a picture — the badge
says how many and the panel says which.

### Looking inside without unfolding

Double-click a folded box's mini-map, or **Look inside** on its menu, and the group opens in a
modal panel: `ui/panels/GroupPeek.tsx`, a **second React Flow** holding the group's own cards and
the wires among them, framed by `fitView`. Unfolding on a full canvas puts those cards back where
they were, over whatever has since been put there; this is the same read without the move.

**The cards are the real ones**, and they are built by the same `cardShape`/`CARD_TYPES`/
`wireStyle` the canvas uses — written separately, the panel silently drew a muted node's wires and
a reference wire as ordinary live ones. `CodaNodeView` reads the store by node id, so what the
panel draws is live — params, run state, ports, issues. `subgraphOf` supplies the fragment, the same
helper copy and duplicate use, so "what is in this group" has one answer. Nothing writes a
position: no `onNodesChange`, no dragging, no selection, no delete key, and the canvas's own
selection is untouched — a click in the panel must not change what ⌫ would act on outside it.
Viewer cards draw their controls and **not their results** (`previews: false` on the node data): a
peek is opened to see what is in the group, and mounting several live viewers is a heavy answer to
a glance.

**The trap it would have sprung, and the one it did.** Both are about a second flow drawing cards
with the *same ids*. `measureCardSizes` and `useArrange`'s port measurement read
`.react-flow__node[data-id]` out of the whole document — and while a group is folded the panel's
copies are the only ones, so ELK would have sized the graph from cards in a dialog and
`structureKey` would have changed the moment a peek opened, re-arranging the canvas behind it
under auto-layout. Both queries (and `spliceOn`'s) are scoped to `.canvas-area` now. The one that
did spring is `CARD_POINTERS`: a card that is neither draggable nor selectable gets
`pointer-events: none` from React Flow, so every control in the panel was inert — and the
keystrokes meant for them fell through to the canvas's window listeners, where `d` opened the
dashboard *behind the dialog*. `CARD_POINTERS` puts the pointer back — one constant, since the folded box
needs it for the same reason — and the panel stops **bare** keys from reaching those listeners,
letting the modified ones (⌘Z, ⌘C) through to the history and clipboard, which a dialog showing
live cards has no business deciding on their behalf.

The deeper version of that last fix is written down and **not taken**: the two canvas listeners
could ask `isDialogOpen()` beside `isTourActive()`, which would close the same hole in the
fourteen other `Modal`s — `ViewerOverlay` and `HelpOverlay` have it too. It is a change
to what every dialog does with every shortcut, and eleven tests across five files currently assert
that `i`, `Space`, `Tab` and `p` still fire with one up. That is a decision about the app rather
than a cleanup.

`peekGroupId` is session state beside `expandedNodeId`, never the document — a workflow somebody
sends you does not arrive with a panel open — and it is cleared whenever the document under it is
replaced, since a group id means nothing in the next graph.

### The rest

**Renaming reaches whichever surface is on screen.** `groupBoxes` skips a folded frame, so the
menu's Rename used to open the title field on an outline that is not drawn — the edit landed on
the frame you would see after expanding again, which reads as a menu row that does nothing. The
field is `ui/GroupTitle.tsx` now, drawn by the frame *or* by the box's header, off one
`editingGroupId` in the store — beside `peekGroupId` and for the identical reason, since the menu
that starts a rename can reach neither surface that draws one. Prop-drilled instead (two props on
the layer, two fields in the box's `data`, a callback on the menu) it also sat in `rfNodes`'
dependencies, so starting a rename rebuilt every card on the canvas. Double-clicking the header
starts it, as double-clicking the outline does. On the header alone, because the rows below hold real fields where a
double-click selects a word.

The rest is inherited rather than written: the drag is `ui/groupDrag.ts`, shared with the expanded
frame, so ⌘Z puts a whole gesture back and a locked canvas refuses it; a loop frame around a
folded group is drawn around the *box* (`loopBoxes`' `substitute`), not around the empty canvas
its members left; and `structureKey` carries the **folded** frames — their membership and how many controls they
carry, both of which change the box — so auto mode re-arranges when one is folded, exactly as it
does when a card is added. An expanded frame contributes nothing to that key, deliberately: ⌘G
changes no input the layout has.

Folding is **live under the lock** and an ordinary undo step, like `toggleCollapsed` on a card: it
hides cards where they are and puts them back where they were. `store/lock.test.ts` classifies it.

`layout/collapse.test.ts` pins the arithmetic; `ui/panels/groupMenu.test.tsx` pins the DOM, the
two affordances, the overlay class, the promoted rows and the rename landing in the box; `store/groups.test.ts` pins the four
ways a promoted reference goes stale. **Checked in Chrome, and only there:** folding and
unfolding from both chevrons and both menus, a right-click reaching the frame's own menu, a click
selecting the members, the box dragged at a zoom other than 1.0 **with every other card asserted
still** (the check that separates a drag from a pan), the wires joining at its edges, the
mini-map's tints, and an arrange with a group folded — which laid the graph out around the box and
moved its members with it. Then, for the promoted controls: the picker offering each member's
params under its own caption and staying open across several picks, the box growing to 288×184 for
two rows, typing in a promoted field landing on the member's param, and the box still dragging by
its header with every other card still. And for the peek: opened by the double-click, both member
cards drawn inside with one wire and no previews, a param written through it (a select changed from
100 to 500 on a card nobody can see), the canvas behind it unmoved, and Escape closing it. The two
findings above came out of exactly that run — the second was found by typing into a peeked field
and watching the dashboard open behind the panel.

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
