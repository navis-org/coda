```coda-graph
caption: Pick neurons in Explore Dataset, then page through their driver-line matches.
neuron.explore as exp
out.neuronbridge as nb
exp:selected -> nb
```

[NeuronBridge](https://neuronbridge.janelia.org) has matched the neurons of hemibrain, male CNS, MANC, FlyWire and BANC against FlyLight's light-microscopy collections. This card shows those matches one neuron at a time: for the neuron on screen, the lines whose images look like it, best first. It is how you go from a cell you have found in EM to a driver line that labels it.

Each tile is one **line**, drawn with its best-matching image. The number under it is the match score. `⇋` means the neuron matched the mirror image of the sample. Click `+N` on a tile to see the line's other images. `NeuronBridge ↗` opens the same list on NeuronBridge's own site.

## Comparing a match

Click a tile's image to open it above the tiles. Two rows of buttons choose what is drawn:

- **Side by side**, **LM only** or **Overlay** — the EM neuron beside the light-microscopy image, the LM image alone, or the EM neuron laid over it. The overlay draws the EM in white so it stands apart; `EM in colour` keeps its depth colours instead, where a good match lines up with the hit colour for colour. The slider sets how strongly it is drawn.
- **Hit**, **Whole line** or **Hit + line** — the segmented hit NeuronBridge compared, the whole sample it was cut from, or the hit in colour over the whole sample in grey. The last two are how you see what else a line labels.

**← and → step to the previous and next line**, on the card and full screen alike, so you can scan a neuron's matches line by line; the images of the next lines are fetched ahead, so each step shows at once. Stepping past the last tile on screen shows the next batch.

Click either image to see it full screen, with the same controls and the match's details underneath; `EM` and `LM` switch between the two images, and Escape closes it. `Keep in view` holds the comparison above the tiles while they scroll.

```coda-params
caption: The comparison's settings, remembered with the workflow.
out.neuronbridge: compare, lmView, emTint, emOpacity, freeze
```

> [!NOTE] A mirrored match flips the EM image, never the light-microscopy one
> A match marked `⇋` was found against the mirror image, so the EM neuron is flipped to land on the
> hit. The sample is always shown the way it was imaged, whole line included.

Under PPPM the overlay is NeuronBridge's own rendering, with the EM skeleton drawn in, so `EM` does nothing there. PPPM's hit is published on grey, so it cannot be laid over the whole line.

```coda-params
caption: Which collections to show, and which matching method.
out.neuronbridge: collections, method
```

The four collections are the chips above the tiles. **Split** and **Omnibus** are split-GAL4 lines, the reagents you would order. The two **MCFO** sets are sparse single-cell images of Gen1 GAL4 lines, which are useful for confirming a match even when the line itself is broad. `PPPM` exists for hemibrain only and ranks MCFO images, so its button appears only on hemibrain neurons.

☆ on a tile, or `☆ Pin` beside an opened image — full screen included — pins a match. **Pinned** emits every pinned match as a table: line, collection, score and the NeuronBridge release it came from. `Pinned matches (CSV)` in the card's download menu saves the same table, every neuron's pins at once. Paging, the chips and the method change only what the card draws; pinning changes the output.

> [!NOTE] A neuron missing from NeuronBridge is not an error
> NeuronBridge indexes the neurons it could render, not every segment, so plenty of bodies have no
> record at all. The card says so and moves on. The same goes for a dataset version NeuronBridge
> did not match: male CNS `v1.0` is looked up in NeuronBridge's `v0.9`, and the card says both
> versions. A body edited between the two may be shown as it was.

Each neuron costs about 3 MB the first time you view it, fetched straight from NeuronBridge's public data and kept for the session. Nothing is fetched when the workflow runs.
