## What Review Suggestions does

A queue of SEAM's merge suggestions, one row per tip. Each row is a tip and one of its candidates — the piece SEAM would merge into the neuron there. Click a row and the card's viewer shows the neuron and that candidate in two colours, with the camera on the point where they touch. Accept it, reject it, or mark it unsure, and move on.

A verdict is a note saved with the workflow. Nothing is written to the segmentation until you press **Submit** and confirm the merges — see "Submitting merges" below.

```coda-graph
caption: Suggestions read, worked through, and shown in the viewer.
dataset.flywire as ds
seam:suggestions as sug
seam:review as review
out.neuroglancer as ng
sug:tips -> review:tips
sug:candidates -> review:candidates
ds -> review:dataset
ds -> ng:dataset
review:current -> ng:control
review:layers -> ng:layers
```

Wire **both** of Merge Suggestions' tables in: `Tips` is the queue and `Candidates` is what the arrows page through. The `Dataset` input is what the card's viewer needs to be a scene.

## One neuron at a time

The card reviews one neuron at a time. The `Neuron` list at the top of the card picks which one, and each entry gives the root ID, how many tips it has and how many of its candidates you have judged. Until you pick, the card is on the first neuron in `Tips`. That is also the first one [Suggest Merges](#seam:suggestMerges) searches, so it is the first one ready.

Switching neuron jumps to the top row of the new neuron's list. The list, the counts in the footer and the `Layers` annotation layer all cover the picked neuron only. `Tips` and `Verdicts` still carry every neuron, so no verdict is lost when you switch.

If the picked root ID is no longer in `Tips` (the neuron was edited, or the table upstream changed), the card goes back to the first neuron. Your choice is kept, and it comes back if that root ID does.

## Working through it

**Wire `Current` into a [Neuroglancer](#out.neuroglancer) node's `Control` socket.** Then clicking a row shows that pair in the full-size viewer, in two colours, with the camera on the point where they touch — in the scene you already had up, rather than a second one. The card itself shows the list alone.

### Start before the search finishes

Suggest Merges publishes each end as it is scored, and the queue fills from that — so you can work through the first tips while the rest of the neuron is still being measured, and the Neuroglancer node follows your clicks exactly as it does afterwards. The foot says **still searching — N to go** while that is happening.

The N is the picked neuron's tips, not candidates, and it reaches zero: an end the search can never read — its box lies outside the segmentation volume — is counted as done rather than as waiting, and Suggest Merges warns separately about how many those were.

> [!IMPORTANT]
> **A filter or a sort reaches only what has arrived**
> `Min confidence`, `Min size` and `Sort by` narrow the tips published so far. On a third-full queue that is a third of the neuron, which is what the caption in the foot is there to say. Nothing is lost — a verdict recorded now is kept — but the top of the list will move as more ends land.

With nothing wired to `Current`, expanding the card (⤢) gives it a small viewer of its own so it is usable by itself. That is a fallback: it is a second WebGL context showing two segments, and it stands down the moment something else is driving.

> [!IMPORTANT]
> **The camera needs the embedded viewer**
> Moving a camera without reloading the whole scene is a message to the frame, and only Coda's own neuroglancer can receive it. Pointed at another deployment, the segments still change and the camera stays where it is. `Viewer type` is on the Neuroglancer node and the embedded one is the default.

| Control | What it does |
| ------- | -------------- |
| a row   | shows that tip's candidate and points the camera at their contact |
| `‹` `›` | the candidate ranked above or below this one, within the same tip |
| Accept / Reject / Unsure | records a verdict on the piece you are looking at, for this neuron (greyed out once the piece is merged) |

Pressing the same verdict again clears it, so a misclick costs one click.

The row you are on has a blue outline. The bar on its left shows the verdict (green, red or yellow), so you can still tell which row is selected once it has one.

A verdict is about the piece and the neuron, not about the tip: a piece listed at two tips shows the same verdict on both rows. Verdicts survive running the suggestions again, as long as neither the neuron nor the piece has been edited in between. Verdicts saved before 16 November 2026 were tied to a tip number that changes between runs, and are no longer read.

### Seeing what you accepted

With `Show accepted` on (the default), every candidate you have accepted on this neuron is shown in the viewer in green, wherever the cursor is. The scene is then the neuron as it will look once you make the merges, and a piece that does not fit stands out. Accepting the candidate you are looking at turns it from orange to green straight away.

With no row selected, the viewer shows the neuron and its accepted pieces, and the camera stays where it is. Only `Accept` counts; `Reject` and `Unsure` are not drawn.

The number on the left is `q`, SEAM's score for the tip's **first** candidate. The list is sorted on it, and SEAM's cutoff — what `shown` means — is a value of it. Beneath it is `r`, rounded: about how often a first candidate at that `q` turned out right, such as `≈90%`. Treat it as an estimate. It comes from about 14 steps fitted on some 335 judged tips, mostly near the cutoff, so far below the cutoff it rests on a handful each. The line under the id is the candidate itself: its size, its rank within the tip's list, its own confidence, the search's own rank, and how far the two pieces are apart.

**Size is the candidate's level-2 chunk count** — the chunkedgraph's own decomposition of the whole object, wherever it reaches. That is what `Sort by: size` orders on and what `Min size` counts, because it is the best proxy there is for whether a piece is a loose fragment or part of a neuron. It is coarse by construction: anything small is one chunk, and the number only starts separating pieces further up.

> [!NOTE]
> **Not the same as `vol_um3`**
> The table also carries `vol_um3`, which is the candidate's voxels *inside the 6 µm search box* — how much of the piece is near the tip rather than how big the piece is. A long neurite passing through counts only for the part in view. A set from [Merge Suggestions](#seam:suggestions) carries no chunk count, and there the rows fall back to µm³ and say so; the two differ by orders of magnitude, so a number that worked in `Min size` on one will not mean the same on the other.

`conf` there is the candidate's own score, `p_tip × p_cand`: how likely something belongs at this tip at all, times how much of that belongs to *this* piece. For a first candidate it is exactly the `q` SEAM's cutoff is applied to.

> [!NOTE]
> **Rank 1 is the suggestion; the rest is context**
> SEAM's cutoff was calibrated on first candidates only, so the row you see when you click is the suggestion. The arrows let you look down the list — useful when the first is clearly wrong and the second is clearly right — but a verdict on rank 4 is your judgement rather than one of SEAM's suggestions. Both are kept, and the `Verdicts` table says which rank each was.

## Extending a neuron

A piece you accept often has open ends of its own. With suggestions from [Suggest Merges](#seam:suggestMerges) you can search those too and grow the neuron piece by piece, all in one queue: accept a piece, extend it, accept one of the new suggestions, extend that, and Submit the lot at the end.

```coda-graph
caption: The dotted wire tells Suggest Merges which accepted pieces to extend.
seam:suggestMerges as search
seam:review as review
search:tips -> review:tips
search:candidates -> review:candidates
review:extended -> search:review
```

**Wire `Extended` back into Suggest Merges' `Review` input.** The wire is dotted and runs backwards. Without it the Extend button is greyed out and says so. Suggestions from a published set ([Merge Suggestions](#seam:suggestions)) cannot be extended.

### The Extend button

Every accepted row has an **Extend** button. Press it and Suggest Merges finds that piece's open ends and searches them, with the neuron and the piece read as one object. It runs whatever auto-run is set to. The new tips appear beneath the row, and the button says how far the search has got:

| The button reads | Meaning |
| ---------------- | ------- |
| `Extend` | not extended; the tooltip gives the piece's size |
| `Extend (large)` | the same, for a piece of 41 level-2 chunks or more, which can take minutes |
| `waiting…` | asked for, and none of its tips listed yet |
| `searching 3 of 7` | its tips are listed and three are done |
| `7 ends searched` | finished |
| `3 of 7 ends searched` | the search stopped part way, e.g. you cancelled the run |
| `no open ends` | the piece has tips, and none left to search |
| `nothing to search` | the search finished and listed nothing for this piece |
| `search failed` | the search ended in an error; the reason is on the Suggest Merges card |
| `not searched yet` | extended, and the search has not run |

Pressing the button again stops extending the piece and takes its tips off the list. The piece stays accepted.

Extending a small piece takes a few seconds, because the neuron's own ends are remembered. If the neuron's search is still running when you press Extend, the piece is searched ahead of the ends that are left.

### How the list reads

A piece's tips are listed directly beneath the row the piece was accepted on, indented behind an arrow. Tips of a piece accepted on a piece are indented a step further, and so on.

- The row a piece hangs beneath names that piece, even where it was not the tip's first candidate, and it stays listed whatever the filters say.
- `Min confidence`, `Min size` and `Sort by` apply to each level on its own, so a piece's tips stay together.
- The end where a piece joins the neuron is not listed. There is nothing to review there.
- The neuron list at the top, the counts in the footer, the green pieces in the viewer and the `Layers` output all cover the neuron with its extended pieces.

A candidate you have already accepted somewhere else on this neuron has an `in this neuron` tag, and its verdict buttons are greyed out. Accepting it twice would be merging it twice.

### Changing your mind

Rejecting or clearing an extended piece takes its tips off the list, along with those of every piece extended beyond it. The verdict buttons say how many pieces go with it before you click. Your verdicts on those rows are kept: accept and extend the piece again and they come back. It is one undo step.

### Auto-extend

With `Auto-extend` on, accepting a piece extends it straight away. Two things to know:

- A large piece (41 chunks or more) is accepted and left to its `Extend (large)` button.
- Switching it on starts nothing. Pieces you accepted earlier keep their Extend button.

The setting is with the filters in the footer.

## One row per tip, or per candidate

`One row per` changes the grain. **Per tip** — the default — a row is a tip and its suggestion, and the big number is `q`. This is the unit SEAM calibrated: the cutoff, `p_tip` and `r` were all fitted on first candidates, so a row here is a suggestion somebody made.

**Per candidate** gives every candidate of every tip its own row, led by that candidate's `conf`. Nothing at that grain is calibrated — there is no `r` for a rank 4 — but it is how you work when the first candidate is clearly wrong and something further down is clearly right. Clicking a row opens on *that* candidate rather than on the tip's first.

The filters read whichever number the row leads with, so `Min confidence` means `q` per tip and `conf` per candidate. Set it from the cutoff your set was made with (0.159 for the single-seed configuration Suggest Merges runs, 0.118 for SEAM's production sets) to browse just below it. `r` is never filtered or sorted on: it has only about 14 values, so thousands of tips would tie.

## Filtering

`Min confidence` and `Min size` narrow the list; `Sort by` orders it. All three are reading aids: they change nothing this node publishes, so moving them costs nothing and re-runs nothing.

On the card they fold away behind `Filters` in the footer, for when the list is what you want the room for. Expanded, they are in the panel's own controls above the body rather than in it.

A tip that clears SEAM's own calibrated cutoff is marked `shown`, and its number is drawn in the brighter colour. The cutoff is a value of `q`, so to list only those tips, set `Min confidence` to it. The full list is worth working through too: in the published Aedes set, 97 tips cleared the cutoff, and of the 614 tips just below it a review found about three in five were real. The cutoff is tuned to be right when it speaks, not to find everything.

`Exclude organelles` leaves out candidates the search flags as organelles: mitochondria, vesicles and other pieces wrapped inside one cell, which are never the continuation of a neurite. It is **on** by default. With one row per candidate, flagged candidates are not listed. With one row per tip, a tip whose first candidate is flagged stays in the list but leads with its next candidate, marked `first was an organelle` — often the real continuation is the second. SEAM's `q`, `r` and `shown` are about the first candidate, so [Suggest Merges](#seam:suggestMerges) scores each list a second time with its organelles taken out, and any tip whose list holds one reads those numbers instead, marked `scored without organelles`. That includes a tip whose organelle is further down: every candidate's share is a share of the whole list, so an organelle anywhere in it lowers the first candidate's `q`. These are Coda's numbers, not SEAM's, and an estimate, since SEAM fitted its scores on lists that still held organelles. A set that carries no such numbers (one from [Merge Suggestions](#seam:suggestions)) keeps SEAM's, except on a row that passed over its first candidate: that row shows no `q` and is never counted as shown, so `Min confidence` passes it by. The footer says how many rows the filter changed. About one flagged piece in a hundred is not an organelle, so switch the filter off to see the list as it was. The flag comes from [Suggest Merges](#seam:suggestMerges), and from [Merge Suggestions](#seam:suggestions) for sets made since SEAM added it. An older published set has no flag, and nothing is left out of it.

Every filter reads a tip's **first** candidate, so paging through a tip's other candidates never makes its row jump or disappear. A flagged candidate you page to is marked `organelle`.

## Submitting merges

Once you have accepted pieces on a neuron, **Submit** at the foot of the card merges them into it, with your own CAVE token. The number on the button is how many accepted pieces are not merged yet.

You need a CAVE Dataset wired into `Dataset`, and to be signed in to its server (Sources). If Submit is greyed out, hover over it to see why — for example, the search is still running, or nothing is accepted.

> [!WARNING]
> **These are real edits**
> Submit changes the shared segmentation, and everybody working on that datastack sees the result. There is no Undo button in Coda: to reverse a merge, take its operation ID from the `Merges` table and undo it with your usual tool, e.g. caveclient's `client.chunkedgraph.undo_operation(...)`.

Pressing Submit sends nothing yet. Coda first checks the accepted pieces and then opens an overlay with the list on the left and the neuron as the merges will make it on the right: the neuron see-through, each piece in green and a line across each gap where the merge is made. Untick anything you are not sure about, then press **Merge 3 pieces into 720575940… on wclee_aedes_brain**. Only a click or Space presses it, never Enter.

### A neuron you extended

Merges are sent from the neuron outwards: a piece accepted on another piece is merged after that piece, and onto it. In the overlay such a row says `onto 7205…`, the piece its merge point is on. It says `after 7205…` as well where the merge point is on the neuron itself and the piece it was accepted on still has to go first.

Ticks follow the tree. Unticking a piece unticks every piece beyond it, and ticking a piece ticks the pieces between it and the neuron. Hiding a piece in the overlay's viewer does the same.

If a piece cannot be merged, the pieces beyond it are listed under **N not merged** with `nothing to merge onto`. Pieces elsewhere on the neuron are not affected.

A batch of 27 merges, six pieces deep, took 37 seconds on Aedes.

### What is checked

Before the overlay opens:

- that your account may edit the datastack;
- that the neuron and every piece are still current. If the neuron has been edited since the suggestions were made, none of its pieces is merged; an edited piece is left out on its own;
- where to merge: for each piece, the supervoxel on either side nearest the suggestion's contact point. Merges are sent as supervoxels and positions, the way Spelunker sends them, not as root IDs.

Pieces that cannot be merged are listed under **N not merged**, each with its reason. `Re-check` asks again, e.g. after somebody else's edit.

Then, just before each merge, both supervoxels are looked up again on the server. If somebody else has edited the neuron in the meantime, the batch stops there. A piece that is already part of the neuron is skipped. A piece that was edited in the meantime is recorded as not sent, and so is every piece that was to be merged onto it; the batch carries on with the rest.

### While it runs

Merges are sent one at a time, in the order listed, and each row shows how it went. `Stop after this merge` stops before the next one. The first failure stops the batch, and nothing is ever retried. If a reply is lost — the network drops, or the server takes more than two minutes — the merge is recorded as **unknown**, and the next Submit on that neuron reads the roots to find out what happened before planning anything. A merge that is merely slow is still waited for: Submit stays greyed out, and the browser asks before you close the tab, until the server answers (for up to ten minutes); the answer is then added to `Merges`.

While merges are being sent, the card and its workflow stay put: deleting the card, undoing it away, loading another workflow or switching tabs are refused until the batch ends, and the browser asks before you close the tab.

### Afterwards

The card follows the neuron to its new root, in its own viewer and on `Current`. A merged piece's row says **✓ merged** and its verdict can no longer be changed. Each merge is recorded with the workflow, and the `Merges` output lists them. Undo does not remove the record. The record is read for the datastack each merge was made on: wire the card to another datastack — say, from the sandbox to production — and it starts afresh there.

### Outdated neurons and pieces

With a CAVE dataset wired and you signed in, the card also checks whether the neuron and its candidates are still current, as they arrive. A candidate edited since it was suggested gets a red **outdated** tag. If the neuron itself has been edited — by somebody else, not by your own Submit — the foot says so and Submit is greyed out. Run the suggestions again on the neuron's new root to carry on.

This is common with a published set, which is a snapshot: on Aedes, a neuron from a set a few weeks old has often been edited since.

## Outputs

| Output     | Contents                                                                    |
| ---------- | ----------------------------------------------------------------------------- |
| `Tips`     | the tips passed through, with a `verdict` column for each one's first candidate |
| `Verdicts` | one row per judgement — neuron, candidate, verdict, and the tip and rank where the piece is first listed |
| `Current`  | the ids to show — the neuron at its root now, the candidate being looked at and, with `Show accepted` on, every accepted piece not yet merged — with a `part` column saying which is which |
| `Layers`   | an annotation layer of **every** shown suggestion on the picked neuron — a map of where the work is |
| `Merges`   | one row per merge Submit made or tried, on every neuron — the datastack, the outcome, the new root, the operation ID, both supervoxels and their positions, and the time. `accepted_on` names the piece a merge was accepted on, and is empty for a piece accepted on the neuron itself |
| `Extended` | the accepted pieces being extended, one row per piece: `parent`, the root it was accepted on, and `piece`. Wire it into Suggest Merges' `Review` input |

`Layers` holds every shown suggestion on the neuron rather than just the one you are on, and that is deliberate: an annotation layer's contents are not part of a scene's *selection*, so a layer that changed on every click would make every click rebuild the whole viewer — and reset the camera with it. Which suggestion is current travels on `Current`, where it costs nothing.

`Verdicts` is the one to keep. It carries every judgement, including those on candidates other than the first, which the folded `verdict` column on `Tips` cannot — a tip is one row.

```coda-params
seam:review: mode, minConfidence, minSize, excludeOrganelles, sortBy, showAccepted, autoExtend
```
