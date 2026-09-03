# The Workflow Wizard

Four questions — which dataset, how to choose the neurons, what to work out, and how to look at it
(one answer or several) — and a graph. `src/wizard/options.ts` holds the option space, `src/wizard/build.ts` turns one set
of answers into a `CodaGraph`, `src/ui/panels/WizardDialog.tsx` asks the questions.

## What it replaced, and why the replacement is not the same offer

Four bundled example graphs, hand-written on the synthetic dataset. They had two jobs and did the
second one better than the first.

**As an answer to "show me how this works" they were fine.** As an answer to "give me a pipeline
for *my* data" — which is what somebody opening a connectome tool actually has — they could only
ever say *open this one and swap the dataset node*, which is a lesson about the app rather than an
answer to the question. Every example ran on `dataset.mock.opticlobe` because a real dataset needs
a token, so the first thing a reader had to do with an example was edit the one node the example
was not about.

**As end-to-end fixtures they were load-bearing**, and that standing moved rather than being
dropped: `wizard/wizard.test.ts` holds every combination the wizard can build to what
`examples.test.ts` held four graphs to. That is a stronger test for the same reason the wizard is
a better offer — a broken example was one bad graph, while a broken arm of the builder is a bad
graph handed to somebody who has no way to tell that it is the tool and not their answers.

Removing them was not free, and the bill is worth knowing: `loadExample` and `EXAMPLES` had
around forty callers, most of them tests that wanted *a realistic graph on the canvas*.
`demoWorkflow(analysis)` is what they call now — the wizard's own output on the synthetic
dataset — so the graph the suites exercise is the graph the app ships. Node ids (`ds`, `find`,
`conn`, `group`, `sort`, `view`) are short and meaningful for the same reason they always were: a
share link carries the whole graph in the URL fragment, and a saved file that reads as
`conn → group → sort` is one somebody can edit by hand.

## The option space narrows, and that is the design

A wizard that offers every combination and produces a broken graph for some of them is worse than
no wizard: the reader cannot tell a bad answer from a bad tool. So every question narrows against
what came before, in two different ways.

**On what the source can do**, through `capabilityAnywhere`: browsing needs `neuronIndex`, 3D
morphology needs `skeletons`, a Neuroglancer cell needs `viewerScene` — which the synthetic
source has no bucket for, so the synthetic dataset never offers it.

**The ceiling, not the floor, and that distinction is the whole of it.** A wizard answer is a
*family*: which dataset it resolves to is not known until the node runs, and the version dropdown
defaults to "Latest" off a listing that has not landed when the dialog opens. So the question
here is not "can this dataset do X" — the one `capabilityOf` answers for the fifteen `validate`
sites — but "is X worth offering for this source at all". Asking the first of the second cost
exactly what you would expect: `capabilityOf(source, undefined, …)` gives `source.capabilities`,
CAVE's `skeletons` is a deliberately safe `false` there for a datastack nothing has been peeked
about, and so the wizard hid **View morphology in 3D** and **NBLAST clustering** for all three CAVE
families — every one of which has skeletons (FlyWire's published beside materialization 783, and
BANC's and minnie65's built from the level-2 cache). `capabilitiesAnywhere` on `DataSource` is
the ceiling and only CAVE declares one, for `skeletons` alone; see `docs/backends.md`.

Two properties of that arrangement are load-bearing. **The floor is still what the node reads**,
so a dataset that really has no skeletons says so on the Skeletons card — an over-offer lands a
message where an over-refusal leaves a reader looking at a question two answers short with
nothing to see. And **the ceiling names only the keys that vary**: `paths` stays false at both
ends, because no CAVE datastack aggregates a hop server-side and a ceiling that lifted everything
would offer a workflow the Paths node correctly refuses. `wizard.test.ts` asserts both directions
on CAVE, which is what was missing while the bug was live — not the positive direction as such,
which "offers only what the source can do" has always checked, but the positive direction on
*this backend*: that test covers one capability (`viewerScene`) on one family (the first
published one, a neuPrint dataset), so nothing anywhere pinned `skeletons` on CAVE. A gate that
narrows too much is the failure a suite has to go looking for, because the app shows nothing.

**On what the analysis produces**: a heatmap wants a matrix, a network diagram wants a network, a
table wants a table. `VIEWS` is that pairing **and** the node each pair ends on — one table, read
by `visualisationOptions` for what to offer and by `bodyOf` for what to build. It was two tables
plus a third holding the demo's viewer, and two of the three were already wrong: the ids said
heatmap-first for `matrix`, the dialog offered the table first because it filtered a
differently-ordered copy table, and the third hardcoded `heatmap` under a comment claiming it was
"the first one that analysis offers". `wizard.test.ts` running `inferGraph` over every combination
catches a pair that cannot be *wired*; it says nothing about two halves disagreeing, which is why
they are now one.

## The third question names techniques, not questions

Its answers were written as plain language — "What the wiring looks like", "Which of them are
wired alike" — on the theory that a newcomer meets the tool before the vocabulary. That was wrong
about who is reading. Somebody who has opened a connectome analysis tool knows what an adjacency
matrix and an NBLAST are, and a paragraph standing where the term should be is one more thing to
decode rather than a way in. So the label is the term (`Adjacency matrix`, `Network graph +
stats`, `Connectivity similarity`, `NBLAST clustering`) and the blurb under it is the *chain* it
builds — `Partner Vectors → Similarity Matrix → Linkage` — which is the other thing that reader
wants before choosing.

The canvas notes did not change: those are read after the choice, beside the nodes they are
about, which is where the prose belongs. One consequence worth knowing: the analysis label is no
longer lowercased into the graph's name and description, because "NBLAST clustering" would arrive
as "nblast clustering" — a term spelled wrong in three places at once.

## The fourth question takes a set

A reader who wants a table *and* a bar chart of the same ranked partners wants two viewers on one
chain, not two workflows — so `visualisations` is a list, the question draws checkboxes, and the
footer grows a Continue (the other three questions advance on the answer, because each of them
*is* one answer). Unticking the last viewer is refused: an empty set builds a chain with nothing
on the end of it.

**The viewers sit side by side, stepped by each card's own width.** Stacking them was the first
shape and it was wrong the moment the graph ran: a viewer's *height* is its content, so an unrun
Table card is short and a run one is 387px (a Bar Chart, 428 — measured in a browser), against a
pitch chosen for an ordinary node. The two cards overlapped exactly when the reader was looking at
them. A width is *declared* and does not move, so `cardWidth` — which reads all three places a
width can be said, and now lives in `ui/nodes/nodeBodies.ts` where two of them already are —
gives the step, and `placeGuards.test.ts` checks the clearance over every combination.

**A viewer's own upstream belongs to the viewer, not to the analysis.** The row-normalise is the
heatmap's and the geometry queries are the 3D scene's, so ticking only the matrix's table builds
no `norm`, and a morphology workflow whose one viewer is Neuroglancer downloads no skeletons and
leaves its search uncapped. Ticking both builds each once.

**`everyCombination` walks one viewer at a time**, deliberately: the reachable answers are now a
power set, which is a different order of magnitude for no more coverage, since a second viewer is
the same chain with another node on the same port. That shape is pinned directly instead.

**An answer that stops being available is replaced, not kept.** Going back and switching to a
dataset with no skeletons cannot leave `morphology` selected underneath, because that would build
a graph nobody could have asked for — and the reader would have no way to see where it came from,
since the question that would have shown it is two screens back. `resolveOption` does it on the
way *out* of the state rather than as a repair on the way in, so no path can forget it, and the
set of viewers states the same rule for itself (drop what the new analysis does not offer; never
end up with none).

## Four arms that are not a straight chain

Most analyses are a line of nodes from the head to the viewers. Four are not, and each departs
in its own way.

**A paths query has two ends, so it gets a second head** — the same kind of card as the first,
stacked under it, built by `headOf` with a suffix rather than by a second arm. It is not a fifth
question: "which neurons?" is answered once, and asking twice would be asking a reader who has
not yet been told there are two ends. The second card starts empty and the note under it says
which is which. `neuron.paths` also answers with a **layout** beside its network, and the network
viewer takes both — a path graph laid out by force is a hairball where the hop count is the whole
point, so the geometry the query already knows is handed over rather than recomputed.

**The two clusterings are one arm.** By the time they reach Linkage they are the same thing — a
square matrix of how alike every pair is — so only the two heads of the chain differ: partner
vectors and a similarity metric for the wiring, an all-by-all NBLAST over skeletons for the shape.
`Similarity Matrix → Linkage` needs nothing configured, because the matrix carries its `measure`
and Linkage reads exactly that. The dendrogram then reads the tree and the heatmap reads the
matrix *reordered by* that tree, which is the pairing that makes a cluster visible as a block
rather than a scatter.

**The influence arm is the only one where a viewer's upstream depends on *another* viewer.**
`Per query neuron` belongs to the heatmap — a queries x influencers picture needs the scores
before they are summed across the neurons somebody wired in — which is `matrix`'s row-normalise
rule and nothing new. What is new is the knock-on: once that control is on the node emits one row
per (query, influencer), so the **table** no longer reads the ranking off it, and a `Group By` and
a `Sort` put it back. Ticked alone the table wires straight to the node and neither of those exists.

So the same viewer has two different upstreams depending on what else is ticked, which is the one
thing in this file worth reading twice. It is also the round trip the Influence node's single port
is designed for: the totals are a `Group By` away from the pairs, which is why they are not a
second output. One Influence node feeds both halves — two would be two walks over the same
connectome. `everyCombination` walks one viewer at a time, so this shape is pinned directly in
both `wizard.test.ts` and `placeGuards.test.ts`, the second because the Group By and the Sort land
on a row neither singleton has.

**Neither clustering can be run outside a browser**, and that is a fact about the runner: both
`neuron.nblast` and `cluster.linkage` do their arithmetic in Pyodide, which is loaded into a
module worker. `wizard.test.ts` checks their *inference* like everything else and excludes them
from the run tier, naming the reason; the chains themselves were driven in Chrome — 30 skeletons
into a 30 × 30 NBLAST matrix into a ward linkage into a dendrogram, and 401 neurons into
1,673 partner vectors into a 398 × 398 similarity matrix.

**A card is never stacked under the node that feeds it.** Linkage under NBLAST was the first
shape of that arm and the two overlapped once the graph ran, for the reason the viewers taught:
a card's height is its content and only its width is declared. Everything is a column of its own
now, and the notes sit under the **deepest row** rather than at a fixed height — derived from the
same row numbers the cards were placed at, because the fixed one had been chosen when every chain
was a single row and the paths query's second head landed straight on it.

## Three numbers, and what each is protecting

**`SEARCH_LIMIT` (100) on a published dataset.** Auto-run is on by default, so a generated Find
Neurons with no filters and no limit fires a whole-connectome query at a shared production server
the moment the graph lands. The synthetic dataset is 401 neurons that never leave the browser and
gets no limit at all.

**`GEOMETRY_LIMIT` (30) on the morphology arm's search, whatever the dataset** — when a 3D scene
is one of the ticked viewers, since a workflow whose only viewer is Neuroglancer downloads nothing
— and *on the search*, which is the correction worth recording. A skeleton node's `Limit` is a **warn-above**
threshold, not a cap: guard rails warn, they do not refuse (`limits.md`). Setting it to 30 while
the search returned everything produced a graph that fetched 401 skeletons and 4,404 synapse
points and papered both cards with a warning about how long it would take. Seen in a browser.
Capping the search caps the work, and the geometry nodes keep their own thresholds — which then
fire only if somebody widens the search themselves, which is exactly when a warning is useful.

**`EXPLORE_SHIFT`, derived rather than chosen.** The Explore card is wider than a grid column, so
a workflow that browses would draw its second node inside its first. Everything downstream of the
head shifts rather than the grid changing, because a note lining up with column 2 has to move with
it — and the shift is measured off the card's own declared width, so a card that changes width
takes its clearance with it where a hand-tuned 160 would not.
`layout/placeGuards.test.ts` walks every combination for exactly this — it used to walk the four
examples, and the check is worth more here: an example was laid out by hand once and looked at,
while a generated chain's geometry is arithmetic, and the combination nobody tried is the one
that overlaps.

## Two things on the summary that are not questions

**Notes**, and **"open as a dashboard"**. Both are checkboxes rather than a fifth and sixth
question, and both are remembered per profile (`coda.wizardNotes.v1`, `coda.wizardDashboard.v1`),
because each says how this reader likes to be *handed* a workflow rather than anything about the
workflow itself.

Their defaults are opposite, and deliberately. Notes are **on**: they explain the graph somebody
just generated and cost nothing to ignore. The dashboard is **off**: it replaces the view the
reader is in, and a first workflow that opened somewhere other than the canvas would be answering
a question about the app before they had one.

**The dashboard is written into the document, not switched on in the app.** `dashboardFor` puts a
`DashboardLayout` on the graph with `open: true`, which is the flag `loadGraph` reads — so the
answer survives a save and a share link, which is the whole difference between this and a view the
app happened to be in. A graph built with the box unticked carries no layout at all, not an empty
one: a file without this feature must serialise exactly as it did before the feature existed.

**The cells are the control and the viewers, in that order** — the composition "Build a Dashboard"
teaches, and the only one a generated workflow can know is right: one widget chooses and the
others follow. The head is that widget whichever it is (an Explore card to tick in, a Find Neurons
card to change the filter on, a box to paste ids into), so the grid can be *steered* rather than
only read. Everything between them is plumbing, and a grid of plumbing is a canvas with worse
ergonomics. **Two columns unless there is one cell**, and cells that fit on a single row get the
whole height — one rule rather than a table of compositions, so a fourth viewer cannot land
somewhere nobody has looked at.

## The examples' teaching job, kept — one note and three hints

An overview note above the chain, and a **hint docked to each of the three cards the questions
were about**, written from the same option copy the dialog showed — so the canvas repeats the
answers the reader gave rather than describing them again in different words. The checkbox is on
the summary and the answer is remembered (`coda.wizardNotes.v1`), because whether you want
commentary on your canvas is a statement about you and not about the workflow. It governs both
kinds: one checkbox, because a reader ticking it off is saying "no commentary", not "commentary of
one shape only".

### Why three of the four moved off the canvas

It was four Text notes: the overview plus one under the head, the analysis and the viewer. The
three stage notes said things like *type in the search box, tick a few neurons, then Run* — a
sentence whose subject is **one card**, printed on a card of its own some distance below it. Three
costs followed from that, and all three are gone rather than reduced.

**A note has to be matched to its card by horizontal position**, which is a thing the reader does
rather than a thing the layout says. `stageNote(col, …)` placed one per column and the columns are
adjacent, so the notes were narrower than a column purely to stop them overlapping each other —
a geometric constraint on *prose*, which is how copy ends up written to fit a box.

**Their vertical placement was arithmetic, and it had already been wrong once.** The `y` was a
constant chosen when every chain was a single row; a paths query stacks a second head and landed
on top of it. The fix derived the height from the deepest row the cards were placed at — correct,
and still a calculation that a future arm could break in silence. A hint has no placement: it is
docked to the card's own border by CSS, so a card that moves, grows a result or is dragged
somewhere else takes its guidance with it.

**Dismissing one meant deleting a node.** So the reader's choice was between prose they had
finished with and an edit to their own document — and the edit is in the undo stack, the saved
file and the share link. Dismissing a hint is none of those things (see `docs/canvas.md`), and it
is remembered by *text*, so a second generated workflow does not re-teach the same sentence.

**The overview stayed a note**, and the split is not about length. It is about what the sentence
points at: the overview is about the *graph* — which four answers built it, how to run it — and
there is no one card to dock that to. It is also a paragraph with a heading, which is the shape a
note is for.

**One hint per stage even when several viewers were ticked**, on the first of them, for the reason
the note had: a stack of boxes down the side of a row of cards is not three times as useful.

**Two hints on one card is the case the notes had to stack for.** A chain can be short enough for
the analysis and the viewer to be one stage — morphology drawn in Neuroglancer is a single node —
and where two notes had to be moved apart by arithmetic, two hints are a list on one card that the
stack lays out. `wizard.test.ts` pins that combination directly.

**Every wizard hint docks to the bottom**, and that is a real constraint rather than a default
taken. `NodeHint.side` allows `top`, and a top-docked hint on the head card is drawn straight into
the overview note, which sits above the chain and is opaque — seen in Chrome, not reasoned about.

## The rough edge, and where the fix belongs

**A `browse` or `ids` workflow with a query in it lands with a red card**, saying
`No neuronIds in the incoming neuron table`. Nothing has gone wrong: Explore's `selected` is
empty until somebody ticks a row, and auto-run — on by default — fires the chain immediately.
The hints on both start cards say so in as many words, which is a job they do better than the
notes did: the sentence is now beside the card the reader has to act on.

The honest fix is not in the wizard. `neuron.connectivity` (and its neighbours in
`query/morphology.ts`, `query/roiCounts.ts`) treat an empty neuron table as an error, and an
empty *selection* is not an error — it is a state the reader is in the middle of, which is the
same reasoning invariant 5's corollary already applies to an unresolved column picker. Splitting
that check — no `neuronId` **column** is a mistake, zero **rows** is an empty result — would make
every one of these graphs land quiet. It is a change to a shipped node's contract and so was left
for its own decision rather than made in passing here.

## Where it is reachable from

Three surfaces, all going through `openWizard`: the start page's doors rail (first card), the
toolbar's **Workflows** menu (first row), and the command palette (`Workflow: Workflow Wizard`).
`openWizard` closes the start page on the way in, for `openZoo`'s reason — two full-screen modals
is one too many.

## What the node guide says now

`GuideNode.workflows` replaced `GuideNode.examples`: which wizard workflows contain each node
type, named by the *analysis* — "Who they connect to" rather than "Demo Data / browse / partners
/ pie", because the first is a question a reader recognises and the second is a row of settings.
It is derived from **every combination** on the synthetic dataset, which is why a viewer only one
answer reaches (the pie chart, the graph metrics card) is credited where four hand-written
examples mentioned whichever viewers they happened to contain.

One trap there, and it is the module-init one `CLAUDE.md` records: `data.ts` is SSR'd on its own
by `vite/nodeGuideData.ts`, and the option space is gated on `capabilityOf`, which answers *true*
for a source nobody registered. Without `registerBuiltinSources()` the guide enumerates
combinations the app never offers and credits a Neuroglancer cell to the synthetic dataset. The
same trap bites a test file that builds its `describe.each` from `everyCombination` at collection
time, before any `beforeAll` has run — which is why `wizard.test.ts` and `placeGuards.test.ts`
both register at module scope.
