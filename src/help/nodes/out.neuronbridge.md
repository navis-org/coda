## What NeuronBridge does

[NeuronBridge](https://neuronbridge.janelia.org) has matched the neurons of hemibrain, male CNS, MANC, FlyWire and BANC against FlyLight's light-microscopy (LM) collections. This node shows those matches, one neuron at a time: for the neuron on screen, you get the driver lines whose images look most like it, best match first. This is how you go from a cell you found in EM to a driver line that labels it.

```coda-graph
caption: Pick neurons in Explore Dataset, then page through their driver-line matches.
neuron.explore as exp
out.neuronbridge as nb
exp:selected -> nb
```

Each tile is one line, shown with its best-matching image. The number underneath is the match score, and `⇋` means the neuron matched the mirror image of the sample. Click `+N` on a tile to see the line's other images, or `NeuronBridge ↗` to open the same list on NeuronBridge's own website.

## Comparing a match

Click a tile's image to open it above the tiles. Two rows of buttons control what is shown:

- "Side by side", "LM only" and "Overlay" show the EM neuron next to the LM image, the LM image alone, or the EM neuron on top of it. In the overlay the EM neuron is drawn in white; `EM in colour` uses its depth colours instead, so that a good match lines up colour for colour. The slider sets how strongly the EM neuron is drawn.
- "Hit", "Whole line" and "Hit + line" show the segmented hit that NeuronBridge compared against, the whole sample it was cut from, or the hit in colour on top of the whole sample in grey. The last two let you see what else a line labels.

Use the ← and → keys to step to the previous and next line, both on the card and in full screen. Images of the next few lines are fetched ahead of time, so each step shows up immediately. Stepping past the last tile loads the next batch.

Click either image to view it full screen, with the same controls and the match's details underneath. `EM` and `LM` switch between the two images, and Escape closes the view. `Keep in view` keeps the comparison pinned above the tiles while you scroll.

These settings are saved with the workflow:

```coda-params
out.neuronbridge: compare, lmView, emTint, emOpacity, freeze
```

> [!NOTE] Mirrored matches
> For a match marked `⇋`, the EM neuron is flipped so that it lands on the hit. The LM sample is
> always shown the way it was imaged, including the whole line.

## Collections and method

```coda-params
out.neuronbridge: collections, method
```

The four collections are shown as chips above the tiles:

- **Split** and **Omnibus** are split-GAL4 lines, i.e. the reagents you would actually order.
- The two **MCFO** sets are sparse single-cell images of Gen1 GAL4 lines. These are useful for confirming a match even when the line itself is broad.

The default method is colour depth search ("Colour depth search (CDS)"), which covers every dataset. "PPPM (hemibrain)" exists only for hemibrain and ranks MCFO images, so its button only appears for hemibrain neurons. With PPPM, the overlay is NeuronBridge's own rendering with the EM skeleton already drawn in, so `EM` does nothing there. PPPM's hit is published on a grey background, so it can't be laid over the whole line.

## Pinning matches

Click ☆ on a tile, or `☆ Pin` next to an opened image (also in full screen), to pin a match. The `Pinned` output emits all pinned matches as a table with the line, collection, score and the NeuronBridge release the match came from. `Pinned matches (CSV)` in the card's download menu saves the same table, with the pins for every neuron.

Paging, the collection chips and the method only change what the card shows. Pinning is the only thing that changes the output.

## Missing neurons and versions

Plenty of neurons have no NeuronBridge record at all, because NeuronBridge only indexes neurons it was able to render. In that case the card tells you and moves on.

The same applies to dataset versions NeuronBridge has not matched. For example, male CNS `v1.0` is looked up in NeuronBridge's `v0.9`, and the card shows both versions. A neuron that was edited between the two versions may be shown as it was in the older one.

## Data usage

Each neuron costs about 3 MB the first time you look at it. The data is fetched straight from NeuronBridge's public bucket and kept for the rest of the session. Nothing is fetched when the workflow runs.
