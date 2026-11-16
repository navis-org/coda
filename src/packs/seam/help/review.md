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

The card reviews one neuron at a time. The `Neuron` list at the top of the card picks which one, and each entry gives the root ID, how many tips it has and how many of its candidates you have judged. Until you pick, the card is on the first neuron in `Tips`. That is also the first one Merge Suggestions searches, so it is the first one ready.

Switching neuron jumps to the top row of the new neuron's list. The list, the counts in the footer and the `Layers` annotation layer all cover the picked neuron only. `Tips` and `Verdicts` still carry every neuron, so no verdict is lost when you switch.

If the picked root ID is no longer in `Tips` (the neuron was edited, or the table upstream changed), the card goes back to the first neuron. Your choice is kept, and it comes back if that root ID does.

## Working through it

**Wire `Current` into a [Neuroglancer](#out.neuroglancer) node's `Control` socket.** Then clicking a row shows that pair in the full-size viewer, in two colours, with the camera on the point where they touch — in the scene you already had up, rather than a second one. The card itself shows the list alone.

### Start before the search finishes

Merge Suggestions publishes each end as it is scored, and the queue fills from that — so you can work through the first tips while the rest of the neuron is still being measured, and the Neuroglancer node follows your clicks exactly as it does afterwards. The foot says **still searching — N to go** while that is happening.

The N is the picked neuron's tips, not candidates, and it reaches zero: an end the search can never read — its box lies outside the segmentation volume — is counted as done rather than as waiting, and Merge Suggestions warns separately about how many those were.

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
| Accept / Reject / Unsure | records a verdict on the pair you are looking at (greyed out once the piece is merged) |

Pressing the same verdict again clears it, so a misclick costs one click.

### Seeing what you accepted

With `Show accepted` on (the default), every candidate you have accepted on this neuron is shown in the viewer in green, wherever the cursor is. The scene is then the neuron as it will look once you make the merges, and a piece that does not fit stands out. Accepting the candidate you are looking at turns it from orange to green straight away.

With no row selected, the viewer shows the neuron and its accepted pieces, and the camera stays where it is. Only `Accept` counts; `Reject` and `Unsure` are not drawn.

The number on the left is `r` — the chance this tip's **first** candidate is right. The line under the id is the candidate itself: its size, its rank within the tip's list, its own confidence, the search's own rank, and how far the two pieces are apart.

**Size is the candidate's level-2 chunk count** — the chunkedgraph's own decomposition of the whole object, wherever it reaches. That is what `Sort by: size` orders on and what `Min size` counts, because it is the best proxy there is for whether a piece is a loose fragment or part of a neuron. It is coarse by construction: anything small is one chunk, and the number only starts separating pieces further up.

> [!NOTE]
> **Not the same as `vol_um3`**
> The table also carries `vol_um3`, which is the candidate's voxels *inside the 6 µm search box* — how much of the piece is near the tip rather than how big the piece is. A long neurite passing through counts only for the part in view. A set from [Merge Suggestions](#seam:suggestions) carries no chunk count, and there the rows fall back to µm³ and say so; the two differ by orders of magnitude, so a number that worked in `Min size` on one will not mean the same on the other.

`conf` there is the candidate's own score, `p_tip × p_cand`: how likely something belongs at this tip at all, times how much of that belongs to *this* piece. For a first candidate it is exactly the `q` SEAM's cutoff is applied to.

> [!NOTE]
> **Rank 1 is the suggestion; the rest is context**
> SEAM's cutoff was calibrated on first candidates only, so the row you see when you click is the suggestion. The arrows let you look down the list — useful when the first is clearly wrong and the second is clearly right — but a verdict on rank 4 is your judgement rather than one of SEAM's suggestions. Both are kept, and the `Verdicts` table says which rank each was.

## One row per tip, or per candidate

`One row per` changes the grain. **Per tip** — the default — a row is a tip and its suggestion, and the big number is `r`. This is the unit SEAM calibrated: the cutoff, `p_tip` and `r` were all fitted on first candidates, so a row here is a suggestion somebody made.

**Per candidate** gives every candidate of every tip its own row, led by that candidate's `conf`. Nothing at that grain is calibrated — there is no `r` for a rank 4 — but it is how you work when the first candidate is clearly wrong and something further down is clearly right. Clicking a row opens on *that* candidate rather than on the tip's first.

The filters read whichever number the row leads with, so `Min confidence` means `r` per tip and `conf` per candidate.

## Filtering

`Min confidence` and `Min size` narrow the list; `Sort by` orders it. All three are reading aids: they change nothing this node publishes, so moving them costs nothing and re-runs nothing.

On the card they fold away behind `Filters` in the footer, for when the list is what you want the room for. Expanded, they are in the panel's own controls above the body rather than in it.

`Only SEAM's shown set` leaves just the tips that clear SEAM's own calibrated cutoff. It is **off** by default, and that is deliberate — in the published Aedes set, 97 tips clear the cutoff and another 614 have `r ≥ 0.5`, of which a review found about three in five were real. The cutoff is tuned to be right when it speaks, not to find everything.

Every filter reads a tip's **first** candidate, so paging through a tip's other candidates never makes its row jump or disappear.

## Submitting merges

Once you have accepted pieces on a neuron, **Submit** at the foot of the card merges them into it, with your own CAVE token. The number on the button is how many accepted pieces are not merged yet.

You need a CAVE Dataset wired into `Dataset`, and to be signed in to its server (Sources). If Submit is greyed out, hover over it to see why — for example, the search is still running, or nothing is accepted.

> [!WARNING]
> **These are real edits**
> Submit changes the shared segmentation, and everybody working on that datastack sees the result. There is no Undo button in Coda: to reverse a merge, take its operation ID from the `Merges` table and undo it with your usual tool, e.g. caveclient's `client.chunkedgraph.undo_operation(...)`.

Pressing Submit sends nothing yet. Coda first checks the accepted pieces and then opens an overlay with the list on the left and the neuron as the merges will make it on the right: the neuron see-through, each piece in green and a line across each gap where the merge is made. Untick anything you are not sure about, then press **Merge 3 pieces into 720575940… on wclee_aedes_brain**. Only a click or Space presses it, never Enter.

### What is checked

Before the overlay opens:

- that your account may edit the datastack;
- that the neuron and every piece are still current. If the neuron has been edited since the suggestions were made, none of its pieces is merged; an edited piece is left out on its own;
- where to merge: for each piece, the supervoxel on either side nearest the suggestion's contact point. Merges are sent as supervoxels and positions, the way Spelunker sends them, not as root IDs.

Pieces that cannot be merged are listed under **N not merged**, each with its reason. `Re-check` asks again, e.g. after somebody else's edit.

Then, just before each merge, both supervoxels are looked up again on the server. If somebody else has edited the neuron in the meantime, the batch stops there. A piece that is already part of the neuron is skipped.

### While it runs

Merges are sent one at a time, in the order listed, and each row shows how it went. `Stop after this merge` stops before the next one. The first failure stops the batch, and nothing is ever retried. If a reply is lost — the network drops, or the server takes more than two minutes — the merge is recorded as **unknown**: the roots are asked what happened, and the next Submit on that neuron sorts it out before planning anything.

While merges are being sent, the card and its workflow stay put: deleting the card, undoing it away, loading another workflow or switching tabs are refused until the batch ends, and the browser asks before you close the tab.

### Afterwards

The card follows the neuron to its new root, in its own viewer and on `Current`. A merged piece's row says **✓ merged** and its verdict can no longer be changed. Each merge is recorded with the workflow, and the `Merges` output lists them. Undo does not remove the record, so a merge is never sent twice.

### Outdated neurons and pieces

With a CAVE dataset wired and you signed in, the card also checks whether the neuron and its candidates are still current, as they arrive. A candidate edited since it was suggested gets a red **outdated** tag. If the neuron itself has been edited — by somebody else, not by your own Submit — the foot says so and Submit is greyed out. Run the suggestions again on the neuron's new root to carry on.

This is common with a published set, which is a snapshot: on Aedes, a neuron from a set a few weeks old has often been edited since.

## Outputs

| Output     | Contents                                                                    |
| ---------- | ----------------------------------------------------------------------------- |
| `Tips`     | the tips passed through, with a `verdict` column for each one's first candidate |
| `Verdicts` | one row per judgement — neuron, tip, candidate, rank and verdict              |
| `Current`  | the ids to show — the neuron at its root now, the candidate being looked at and, with `Show accepted` on, every accepted piece not yet merged — with a `part` column saying which is which |
| `Layers`   | an annotation layer of **every** shown suggestion on the picked neuron — a map of where the work is |
| `Merges`   | one row per merge Submit made or tried, on every neuron — the outcome, the new root, the operation ID, both supervoxels and their positions, and the time |

`Layers` holds every shown suggestion on the neuron rather than just the one you are on, and that is deliberate: an annotation layer's contents are not part of a scene's *selection*, so a layer that changed on every click would make every click rebuild the whole viewer — and reset the camera with it. Which suggestion is current travels on `Current`, where it costs nothing.

`Verdicts` is the one to keep. It carries every judgement, including those on candidates other than the first, which the folded `verdict` column on `Tips` cannot — a tip is one row.

```coda-params
seam:review: mode, minConfidence, minSize, shownOnly, sortBy, showAccepted
```
