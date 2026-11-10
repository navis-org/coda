## What Review Suggestions does

A queue of SEAM's merge suggestions, one row per tip. Each row is a tip and one of its candidates — the piece SEAM would merge into the neuron there. Click a row and the card's viewer shows the neuron and that candidate in two colours, with the camera on the point where they touch. Accept it, reject it, or mark it unsure, and move on.

Nothing is written to the segmentation. A verdict is a note saved with the workflow; the merge is yours to make, with your own token, in the viewer.

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

## Working through it

**Wire `Current` into a [Neuroglancer](#out.neuroglancer) node's `Control` socket.** Then clicking a row shows that pair in the full-size viewer, in two colours, with the camera on the point where they touch — in the scene you already had up, rather than a second one. The card itself shows the list alone.

With nothing wired to `Current`, expanding the card (⤢) gives it a small viewer of its own so it is usable by itself. That is a fallback: it is a second WebGL context showing two segments, and it stands down the moment something else is driving.

> [!IMPORTANT]
> **The camera needs the embedded viewer**
> Moving a camera without reloading the whole scene is a message to the frame, and only Coda's own neuroglancer can receive it. Pointed at another deployment, the segments still change and the camera stays where it is. `Viewer type` is on the Neuroglancer node and the embedded one is the default.

| Control | What it does |
| ------- | -------------- |
| a row   | shows that tip's candidate and points the camera at their contact |
| `‹` `›` | the candidate ranked above or below this one, within the same tip |
| Merge / Not a merge / Unsure | records a verdict on the pair you are looking at |

Pressing the same verdict again clears it, so a misclick costs one click.

The number on the left is `r` — the chance this tip's **first** candidate is right. The line under the id is the candidate itself: its size, its rank within the tip's list, its own confidence, the search's own rank, and how far the two pieces are apart.

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

## Outputs

| Output     | Contents                                                                    |
| ---------- | ----------------------------------------------------------------------------- |
| `Tips`     | the tips passed through, with a `verdict` column for each one's first candidate |
| `Verdicts` | one row per judgement — neuron, tip, candidate, rank and verdict              |
| `Current`  | the two ids being looked at, with a `part` column saying which is which        |
| `Layers`   | an annotation layer of **every** shown suggestion — a map of where the work is |

`Layers` holds every shown suggestion rather than just the one you are on, and that is deliberate: an annotation layer's contents are not part of a scene's *selection*, so a layer that changed on every click would make every click rebuild the whole viewer — and reset the camera with it. Which suggestion is current travels on `Current`, where it costs nothing.

`Verdicts` is the one to keep. It carries every judgement, including those on candidates other than the first, which the folded `verdict` column on `Tips` cannot — a tip is one row.

```coda-params
seam:review: mode, minConfidence, minVolume, shownOnly, sortBy
```
