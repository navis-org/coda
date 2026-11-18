## What Suggest Merges does

Suggest Merges takes a table of open ends and looks, around each one, for the piece of segmentation that continues the neuron there. For every end it reads a 6 µm box of segmentation, measures each object that comes near the neuron inside it, and ranks them. The result is the queue [Review Suggestions](#seam:review) works through: one row per tip in `Tips`, and every tip's ranked list in `Candidates`.

It runs SEAM's search in your browser, on the ends you give it. [Merge Suggestions](#seam:suggestions) publishes the same two tables from a run somebody else did on a cluster; use that one if a published set covers your neurons, and this one for a neuron no set covers or one that has been edited since.

```coda-graph
caption: A neuron's open ends found, searched and reviewed. The dotted wire is what lets you extend an accepted piece.
dataset.cave as ds
seam:openEnds as ends
seam:suggestMerges as search
seam:review as review
ds -> ends:dataset
ends -> search:tips
ds -> search:dataset
search:tips -> review:tips
search:candidates -> review:candidates
review:extended -> search:review
```

Wire [Find Open Ends](#seam:openEnds) into `Tips` and a CAVE dataset into `Dataset`. Nothing is written anywhere: the node reads segmentation, root IDs and chunk counts, and that is all.

## Rows arrive while it runs

Each end is published as soon as it is finished, so the review card fills while the rest of the neuron is still being measured, and you can start on the first tips straight away. A published end is final. Nothing that comes later changes it.

The `searched` column on `Tips` says where each tip stands: true once it has been searched, empty while it is still waiting, and false where it never will be. A tip is never searched when its box lies outside the segmentation volume, and the node warns about how many those were.

An unassessed end takes about three seconds. A whole neuron is a few hundred ends, so the node warns before a long run and then runs anyway.

## With and without an assessor

With `Assessor` set to "None — rank by geometry", you get the forest's ranking: where each candidate is, how far it is from the neuron, how big it is, and its place in the list. There is no probability and no cutoff, and the columns that would carry them (`p_cand`, `conf`, `q`, `r`, `shown`) are absent from the tables. The first candidate is still the most likely continuation, so a queue sorted this way is worth working through.

Pick an assessor and each candidate's 4 µm patch of segmentation also goes through SEAM's network. Every candidate then carries `p_cand` and `conf`, each tip carries `p_tip`, `q` and `r`, and `shown` says whether the tip clears SEAM's calibrated cutoff. The checkpoint is a 133 MB download, kept in your browser, and `Download the model` has to be ticked before the node fetches it.

> [!NOTE]
> **Firefox is slower at this**
> The network runs on WebGPU, and a patch costs about 27 ms in Chrome against about 98 ms in Firefox on the same machine. If you are on Firefox and the run is slow, `Assess top` is the setting to try: capping at 10 took a measured end from 11.0 s to 4.5 s. It changes a few answers, so read its tooltip first.

## Narrowing the ends

Suggest Merges searches every row it is given. To search fewer, cut the table above it: a [Filter Table](#core.filterTable) on `e_tip`, or a Sort and a Sample to keep the best 25.

> [!IMPORTANT]
> **A filtered run keeps a few candidates a whole-neuron run would drop**
> A candidate is dropped when its contact is nearer to some *other* tip of the same neuron. The node can only compare against the tips it was given, so with most of them filtered away, a piece that belonged to one of the missing tips can show up as a suggestion for one you kept. If you are comparing against a published set, search the whole neuron.

## Which moment is searched

Each neuron is searched as it stood at one moment, which follows the neuron rather than the Dataset. The first run that meets a neuron searches it at the present and keeps that moment in the document, in `Searched at`. The same suggestions then come back after a reload, and when you return to the neuron from another one. On a dataset with a chunkedgraph, the Dataset's materialization does not change what is searched, so it can stay on "Latest".

If a neuron has been edited since its moment, by you through the review card or by somebody else, the card says so. A root that has been replaced is searched as it last stood. To search the neuron as it is now, run [Update Root IDs](#cave.updateRootIds) above `Tips`: the new root is met for the first time and searched at the present.

The card's ⟳ forgets every moment, and the run after it searches each neuron at the present. `Clear Cache` keeps them.

If the chunkedgraph cannot be asked whether a neuron has changed, the run goes on at the moments in `Searched at` and says so. A neuron with no moment yet has to wait for the chunkedgraph.

## What is remembered

Finished ends are remembered for the session. Cancel a run, or change a setting and change it back, and the next run answers the ends it already has in well under a second and carries on from there. The card's "cached … ago" is the age of the oldest end behind the answer.

`Clear Cache` forgets them, and the next run searches everything again, at the same moments.

## Extending accepted pieces

A piece you accept in the review card often has open ends of its own. Wire the review card's `Extended` output back into this node's `Review` input and you can search those too, without leaving the queue: accept a piece, press **Extend** on its row, and its ends are listed beneath it. Accept one of those, extend it, and so on until the neuron is filled out. [Review Suggestions](#seam:review) has the card's side of this.

The wire is dotted and runs backwards on the canvas. It carries no data downstream. It only tells this node which accepted pieces to extend, so the node runs again when that list changes and at no other click on the card.

Here is what happens for each extended piece:

1. **Its open ends are found** by running everything above `Tips` again with that piece in place of your neuron: the meshes, Find Open Ends, and any Sort or Sample you have there. A Sample that keeps the best 25 therefore keeps the best 25 of *each piece*.
2. **The end where it joins the neuron is left out.** That is the one tip nearest the contact the piece was accepted at. It is published with `junction` true and never searched.
3. **The remaining ends are searched with the neuron and the piece read as one object**, along with any accepted pieces between the two. So the neuron itself never comes back as a candidate, and the ranker sees the size of the whole thing.

The neuron's own ends are answered from memory each time, so extending a small piece takes a few seconds. A measured piece of one chunk took 5 s and one of 15 chunks took 9 s.

> [!WARNING]
> **A large piece is a whole neuron's worth of work**
> Extending a piece of 1,721 chunks took 169 s when it was measured, most of it finding the piece's open ends before any was searched. The Extend button reads `Extend (large)` from 41 chunks up, and its tooltip gives the piece's size.

If you extend a piece while the neuron's own search is still running, the run starts again with the new piece in it. The ends already finished come back from memory, and the piece is searched ahead of the neuron's remaining ends, so you are not kept waiting for them.

For this to work the chain above `Tips` has to start from one neuron table, such as an Input IDs node. The node refuses, naming the reason, when nothing above `Tips` is wired from a neuron table, when two different neuron tables feed it, or when there is a loop in the chain. Suggestions read from a published set cannot be extended, since there is no chain to run again.

A piece that goes wrong is a warning on this card that names the piece, and the rest of the run goes on. In the review card that piece reads `nothing to search` or `search failed`.

## Outputs

| Output       | Contents |
| ------------ | -------- |
| `Tips`       | one row per tip: the incoming columns, the first candidate's measurements, and `searched` |
| `Candidates` | every tip's ranked candidates, joined to `Tips` on the neuron's `ID` and `end_uid` |

Extended pieces add rows to both tables, after the neuron's own. Four columns on `Tips` say where a row belongs:

| Column        | Contents |
| ------------- | -------- |
| `seed`        | the neuron being extended; `ID` stays the root the tip is on, which for a piece is the piece's own |
| `accepted_on` | the root the piece was accepted on; empty for the neuron's own tips |
| `steps`       | how many accepts lie between the tip's root and the neuron; 0 for the neuron's own tips |
| `junction`    | true for the end a piece joins the neuron by |

Group on `seed` if you want one neuron per group. Grouping on `ID` gives you each piece on its own.

```coda-params
seam:suggestMerges: model, assessor, download, assessTop, chunkCacheMb
```
