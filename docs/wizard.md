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

**On what the source can do**, through `capabilityOf`: browsing needs `neuronIndex`, 3D
morphology needs `skeletons`, a Neuroglancer cell needs `viewerScene` — which the synthetic
source has no bucket for, so the synthetic dataset never offers it. Asked with no dataset id,
which is the honest question here: a wizard answer is a *family*, and which dataset that resolves
to is not known until the node runs. Same call `genericStarter` makes.

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

## Three arms that are not a straight chain

Most analyses are a line of nodes from the head to the viewers. Three are not, and each departs
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

## Notes are the examples' teaching job, kept

An overview above the chain and one note per stage, written from the same option copy the dialog
showed — so the canvas repeats the answers the reader gave rather than describing them again in
different words. The checkbox is on the summary and the answer is remembered
(`coda.wizardNotes.v1`), because whether you want commentary on your canvas is a statement about
you and not about the workflow.

**Notes stack when two want the same column.** A chain can be short enough for the analysis and
the viewer to be one stage — morphology drawn in Neuroglancer is a single node — and without
stacking the two notes are drawn on top of each other. Their ids come from the note's index for
the same reason: a column is not unique and an id has to be.

## The rough edge, and where the fix belongs

**A `browse` or `ids` workflow with a query in it lands with a red card**, saying
`No neuronIds in the incoming neuron table`. Nothing has gone wrong: Explore's `selected` is
empty until somebody ticks a row, and auto-run — on by default — fires the chain immediately.
The notes for both starts say so in as many words.

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
