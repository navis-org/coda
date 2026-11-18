## What Merge Suggestions does

A reconstruction is full of neurons that stop early. Merge Suggestions reads a set of SEAM's **merge candidates**: places where a neuron ends at a tip, and a separate piece of segmentation just past it is probably its continuation. Each row is one tip, the piece SEAM would merge into it, how likely that is to be right, and whether it clears SEAM's own cutoff.

Nothing is computed here and nothing is written. The set was made by SEAM's pipeline at a pinned snapshot; this node reads it. To work through the suggestions and merge the ones you accept, wire `Tips` and `Candidates` into [Review Suggestions](#seam:review) — see "Reviewing and merging" below.

> [!IMPORTANT]
> **This node is about false splits — the pack's other two are about false merges**
> Merge Suggestions suggests **merges**, because a neuron stopping early is one neuron cut in two. [Find Merges](#seam:findMerges) and [Affinity Clusters](#seam:affinityClusters) look for false **merges** — one segment holding two neurons — and their fix is a split. The names run in opposite directions and it is easy to read one for the other.

```coda-graph
caption: The suggestions drawn over the EM, beside the neurons they belong to.
dataset.flywire as ds
seam:suggestions as sug
neuron.meshes as mesh
out.neuroglancer as ng
sug:neurons -> mesh:neurons
ds -> mesh:dataset
ds -> ng:dataset
sug:layers -> ng:layers
```

## Pointing it at some suggestions

A pipeline that runs SEAM over a project deposits each run as a **set** — a manifest and two parquet files — into a hosted directory, and keeps an `index.json` listing what is there. `Suggestions` takes the address of that index, and `Set` picks one of them.

The Aedes sets are at `https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/suggestions/aedes/`, which is what the field offers if you leave it empty. Paste the directory and the `index.json` is filled in for you; paste a file and it is used as it is. One directory per dataset, so another connectome's sets sit beside it under their own name.

It also takes a single set's manifest directly, for a one-off. The field works out which kind of document it was given, so there is nothing to tell it.

**A card holds the set it was pointed at.** A newer run appearing in the directory shows up in the `Set` dropdown and changes nothing until you pick it, so a workflow opened months later reads the same files it read the first time.

The tips and candidate files are read by byte range, so a large set costs only the columns this node publishes. The manifest also says what the set holds: if the files beside it disagree — a half-finished upload, two runs' files in one directory — the card says so rather than quietly showing a shorter queue.

## Outputs

| Output       | Contents                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `Tips`       | one row per tip: where it is, the first candidate, `q`, `shown`, `r`, and SEAM's own verdicts |
| `Candidates` | every candidate on every tip's list, ranked — the context behind a suggestion                 |
| `Points`     | the tips as a cloud, carrying the `Tips` columns                                               |
| `Neurons`    | one row per neuron: `tips` and `shown`                                                         |
| `Layers`     | an annotation layer of each shown suggestion — its tip and its contact point                   |

`Neurons` goes straight into [Meshes](#neuron.meshes), which is how the neurons get drawn beside their own suggestions.

## Reading the numbers

`shown` is **SEAM's** decision, not this node's: a first candidate is shown when `q` is at or above a cutoff calibrated on a proofreader's verdicts. There is no threshold setting here, and that is deliberate — narrowing the queue is a [Filter Table](#core.filterTable) on `shown` or on `q`, where the cut is visible as something you did rather than something the node hid.

Sort tips by `q`, highest first. `r` puts `q` into words: 0.7 means about seven of ten tips scoring like this one had a right first. It is a staircase of a few wide steps over `q`, so it never reorders tips, but it ties thousands of them that `q` keeps apart. Use it as a rounded label, and don't add it up: a neuron's sum of `r` is mostly its lowest step.

`source` says which set a tip came from: `set:` and the set's version, for example `set:rv4-ad75ed161bb6`. Each version has its own `q`, cutoff and `r`, so don't compare a single-seed set's `q` with a production set's, or `r` from before a refit with `r` after it. A set too old to name a version leaves `source` empty.

> [!WARNING]
> **`r` is an estimate, and one step covers many tips**
> SEAM fits its steps on tips a proofreader judged — since 18 November 2026 about 536 of them from 15 neurons, with at least 20 tips behind every step. The lowest step covers most of a neuron's tips with one average, so a low `r` is right on average over very different tips, not about the one in front of you. Take the set version SEAM published with the refit; a set from before it carries the old steps.

Only the **first** candidate of each tip is a suggestion. The rest of the list is context: the cutoff was calibrated on firsts, so treating rank 2 as a second suggestion reads a number that was never fitted for it.

The `seam_` columns are the verdicts from SEAM's own review of this set, carried so a new round can be compared with the old one. An empty `seam_belongs` means the tip was judged and nothing on its list belonged; an empty cell means nobody looked at it. A set SEAM did not review leaves them all empty.

`Candidates` carries `n_l2`, each piece's level-2 chunk count, where the set has it (rv4 on). Review Suggestions sizes pieces by it, as it does for [Suggest Merges](#seam:suggestMerges); where it is empty, the card falls back to `vol_um3`.

## Reviewing and merging

```coda-graph
caption: The suggestions reviewed one neuron at a time; the full-size viewer follows the card.
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

[Review Suggestions](#seam:review) takes both tables and lists one neuron's tips at a time. Accept the pieces that belong, then press **Submit**: Coda checks each merge, shows them all beside the neuron as it will look, and merges the ones you confirm, with your own CAVE token. Wire a CAVE Dataset into its `Dataset` socket — the datastack the set was made on — and sign in to its server first.

A piece from a published set cannot be extended: its own open ends were never searched. To grow a neuron piece by piece, search it with [Suggest Merges](#seam:suggestMerges) instead.

## What a set is tied to

A suggestion set is made at one snapshot, and the manifest carries it. A merge you make through Review Suggestions gives the neuron a new root id, and the card follows it there: the rest of that neuron's suggestions can still be reviewed and submitted.

A neuron somebody else has edited since the snapshot is different. Its suggestions were computed against a segment that has moved on, so Review Suggestions marks it as edited and Submit refuses all of its merges, and a candidate edited since is refused on its own. Ask SEAM for a newer set rather than trusting a stale one, and use [Update root IDs](#cave.updateRootIds) if you need the current ids for something else.

```coda-params
seam:suggestions: url, set, layerName
```
