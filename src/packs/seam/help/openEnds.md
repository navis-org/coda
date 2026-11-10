## What Find Open Ends does

Find Open Ends takes the tips of each neuron's skeleton and asks SEAM's Model E, for the surface around every one of them, whether this is a place where the reconstruction stopped short — a neurite that carries on in the EM and was never traced. It gives back one row per tip with a score, `e_tip`.

The model is SEAM's Model E, trained on real open ends from the FlyWire v783 edit history: the places proofreaders went on to extend. It is the same network as Model A behind [Find Merges](#seam:findMerges) and answers the opposite question — where a neuron is *missing* something rather than where it has too much.

```coda-graph
caption: A neuron's tips, ranked by how much each looks cut off.
dataset.flywire as ds
neuron.findNeurons as find
neuron.meshes as mesh
seam:openEnds as ends
out.table as table
ds -> find
find -> mesh:neurons
ds -> mesh:dataset
mesh -> ends:meshes
ends -> table
```

## `e_tip` is a ranking, not a probability

`e_tip` is the model's best score within a micrometre of the tip. A higher number means the surface there looks more like a cut-off neurite — but the number itself has no calibrated meaning, and a reader should use it to decide **what to look at first**, not to decide anything on its own.

> [!NOTE]
> **The columns that are empty are empty on purpose**
> The output carries the same columns as [Merge Suggestions](#seam:suggestions) — `p_tip`, `q`, `shown`, the candidate's id and its measurements — and this node fills in only `e_tip`. The rest need the stages that go looking for what each end should join to, which are not in Coda yet. They are present and null so that the table is the one [Review Suggestions](#seam:review) already reads, and so a column picker is offered the same choices either way.

## Rows arrive while it runs

A whole neuron is a few hundred windows and about a minute of scanning. You do not wait for it: a tip is finished as soon as every window that could reach it has been scored, so rows appear as the scan sweeps the arbour. What you see part-way through is exactly what those tips will say at the end — nothing recomputes them.

## What counts as a tip

Five things happen before the model sees anything, and each is SEAM's own:

- Disconnected fragments are joined end to end, with `Heal fragments` as the longest bridge allowed. A long bridge invents topology, which is why SEAM caps it at a micrometre.
- Twigs shorter than `Prune twigs` go first. A skeleton of a segmentation sprouts single-node spurs along the backbone, and every one of them would be a false open end.
- A tip is a node with exactly **one** connection, counting the one to its parent. A root with a single child is an end of the cable, and so counts.
- Each tip is moved onto the nearest point of the mesh. The skeleton runs down the middle of the neurite and the model scores the surface, so a tip left in the middle asks about a place that is half a neurite away from anything the model has an opinion about.
- Tips within `Soma mask` of the soma are dropped, where the soma is known. A cell body is a tangle of ends and none of them is a missing neurite.
- If `Also look for kinks` is on, the sharp turns go through the last two of those steps as well, so a kink is snapped and soma-masked exactly as a tip is.

## Kinks

Not every missing neurite leaves a tip. When a small side branch swallowed the real end, the skeleton does not stop — it carries on around the corner into the wrong neurite, and there is no leaf anywhere near the place something is missing. What is left is a **kink**: a turn of more than 60° over a micrometre of path, inside a run with no branch in it.

Tick `Also look for kinks` and those turns are scored too, as extra candidates beside the tips. The `kind` column says which is which, so you can look at them separately or ignore them.

They are off by default because of what they cost. On the Aedes neuron this was measured on there were 111 kinks beside 853 tips, and each one is scored like any other, so the run takes about an eighth longer.

What you get for it is a handful of extra ends, not an eighth more answers. A kink is about as likely to be right as a tip when you look at it — in SEAM's reviewed set 19 of 38 against 216 of 359 — but far fewer of them clear the cutoff at all: 2 of the fixture's 610 kinks were worth showing, against 118 of its 2,098 tips. Worth turning on when you are hunting for ends the tips missed, and not worth it as a default.

> [!NOTE]
> **A kink is a turn in the skeleton, so the skeleton decides**
> A skeletonizer that rounds a corner leaves no kink to find. Against SEAM's own 166 kinks on that neuron, this node found 75% of them from the mesh as CAVE serves it, and 92% once the mesh had been through Clean Meshes’ internal-face removal — which is the surface SEAM skeletonizes. The tips barely move either way (96% against 99%); it is the kinks that are sensitive.

> [!NOTE]
> **Changing these changes what the score means**
> SEAM fitted its thresholds on tips found exactly this way. Moving `Prune twigs` away from 1 µm gives you a different set of ends, scored the same way — useful for looking around, but no longer comparable with SEAM's own numbers.

## Where the soma is

Some datasets publish a soma position with each mesh and the mask works without you doing anything. Many do not — and then every end of the cell body counts as an open end, which on one Aedes neuron was 1,214 ends against 548 real ones.

Where that happens, name a CAVE nucleus table in `Nucleus table` and wire the Dataset it belongs to. The node reads each neuron's soma from it directly.

> [!NOTE]
> **It reads the table itself rather than taking one from a CAVE table card**
> A CAVE table read the ordinary way gives positions in the table's own voxels, which is a factor out of the nanometres everything here is measured in — and a soma a factor out either masks nothing or masks the whole neuron, with nothing failing. This node asks CAVE for nanometres, so there is no setting to get wrong. (If you do want a table's positions in nanometres elsewhere, the CAVE table card has a `Position units` field for exactly that.)

A neuron with no row in the table keeps all of its tips, which is what no soma has always meant; the node says how many that happened to. A neuron holding two nuclei is a merge and counts as having none.

## Giving it your own skeletons

Left unwired, the node skeletonizes each mesh itself with SEAM's settings. Wire `Skeletons` and it uses yours instead, matched to the meshes by neuron id — so you can see the skeleton on the canvas, cache it, and clean it however you like with Skeletonize Meshes and [Clean Skeletons](#neuron.cleanSkeletons).

`Heal fragments` and `Prune twigs` still apply to a skeleton you wire in, because both are part of what a tip is rather than a tidy-up. The healing matters most: a skeleton of a segmentation is normally several disconnected pieces, and the ends where it was cut are not open ends — on the neuron this was measured on they outnumbered the real ones four to one. Set both to 0 to say "the skeleton I gave you is the one I mean".

## Downloading the model

The weights are tens of megabytes. Nothing is fetched until you tick `Download the model`, and the card refuses to run until you do. They are then kept in this browser, so every later run starts in about a second.

You need WebGPU. Chrome and Edge have it; Safari and Firefox are adding it. A page served over plain `http` has it switched off, and the node says so rather than running on the CPU.
