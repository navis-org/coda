## What Find Merges does

Find Merges cuts each neuron's surface into overlapping 15 µm windows and asks a model, for every one of them, whether that patch looks like the place two neurons were wrongly joined. It gives back a score per window, the model's own split of each window's points, and two neuroglancer layers you can put over the EM.

The model is SEAM's Model A, trained on real merges from the FlyWire v783 edit history — the ones proofreaders actually found and split. That is the difference from [Affinity Clusters](#seam:affinityClusters), whose checkpoint was trained on synthetic merges and scores at chance on real ones.

```coda-graph
caption: Suspected merge sites drawn over the EM.
dataset.flywire as ds
neuron.findNeurons as find
neuron.meshes as mesh
seam:findMerges as merges
out.neuroglancer as ng
ds -> find
find -> mesh:neurons
ds -> mesh:dataset
mesh -> merges:in
ds -> ng:dataset
merges:layers -> ng:layers
```

> [!NOTE]
> **Two layers, because there are two pictures**
> `Layers` carries the same points twice. One is coloured by **score**, on a continuous ramp — brighter is more suspicious. The other is coloured by **fragment**, in two hues per cell, showing where the model would cut it. Switch between them with neuroglancer's own layer checkboxes; neither depends on any setting here.

## Downloading the model

The weights are about 71 MB. Nothing is fetched until you tick `Download the model`, and the card refuses to run until you do. They are then kept in this browser, so every later run starts in about a second.

You need WebGPU. Chrome and Edge have it; Safari and Firefox are adding it. A page served over plain `http` has it switched off, and the node says so rather than running on the CPU.

## Outputs

| Output   | Contents                                                                             |
| -------- | -------------------------------------------------------------------------------------- |
| `Table`  | one row per cell: `neuronId`, `cell`, `score`, `logit`, `points`, `balance` and the cell's centre `x`/`y`/`z` |
| `Points` | the drawn points, with their cell's `score` and each point's `fragment`                |
| `Meshes` | the input, with `cells`, `maxScore` and `meanScore` on its attributes                  |
| `Layers` | two annotation layers of those points — one by score, one by fragment                  |

`Layers` goes into the Neuroglancer node's `Extra layers` socket. The summary columns are on the meshes' attribute table, so [Split Neurons](#neuron.splitNeurons) and [Filter Table](#core.filterTable) work on them directly — `maxScore > 0.9` keeps the neurons worth opening.

`fragment` is which piece of its cell a point was put in, named `12a` / `12b` for cell 12. **A fragment label only means something inside its own cell.** The model is trained so that which piece it calls the first and which the second is arbitrary in every window independently, so `12a` and `13a` have nothing to do with each other — stitching them into labels that mean something across a whole neuron is a separate problem and is not solved here. That is why the cell is in the name.

`balance` is the other half of the answer, and it is worth as much as the score. It is the share of a cell's points that went to the *smaller* of the two pieces: 0 means the model put everything on one side and found nothing to cut, and 0.5 means it halved the cell. Every cell gets one, whatever it scored.

Read the two together rather than either alone. The per-point head is **not trained on windows that contain no merge** — SEAM's loss skips them — so it still emits a split in a clean cell and a confident-looking `balance` there means nothing on its own. A cell that scores high *and* splits is the one worth opening; a high score with a `balance` near zero is the model saying "something here" without being able to say where.

## Finding a cutoff

The card draws a histogram of the scores from the last run, and `Score cutoff` is a line on it. Click a bar to put the line at its left edge, or click the line's own bar to clear it. The summary beside it counts the cells at or above the line.

**Moving the line re-runs nothing.** It is not a filter and it changes no output — every cell, its score and its split are in the outputs whatever the line is set to. It is there so you can find a number by looking, on a model that ships no calibration curve and so can suggest none. When you have one, put it into a [Filter Table](#core.filterTable) on `score`, where the cut is visible as something you did.

## Reading a score

A score is the model's confidence, between 0 and 1, and **it is not a calibrated probability**. This checkpoint ships no calibration curve, so 0.8 does not mean "right eight times in ten" — it means the model is more sure than it is about a window scoring 0.6. Compare windows against each other, and treat any cutoff you set as your line rather than one the model earned. The card says so on every run.

For what it is worth as a yardstick, the checkpoint scored 0.94 AUC on its validation fold. That is a different population from your neurons.

## Settings

`Score cutoff` is empty by default and only ever marks the card's histogram — see above. It costs nothing to move.

`Draw every nth point` thins only what comes back for drawing — the model always sees every point of every window. At the default of 16 a large neuron's cloud is a few megabytes instead of eighty.

`Max windows` is a hard stop, and 0 — the default — covers the whole neuron. Raise it off 0 only if you want a run to stop early, and know that it takes windows in the order the tiling makes them, which sweeps across the neuron rather than sampling it. A capped run has looked at part of the arbour, not at a thinner version of all of it.

> [!TIP]
> **Expect about a minute for a large neuron**
> Roughly 95 ms a window, and a big FlyWire neuron tiles into several hundred. The card projects the whole run from the first neurons it tiles and warns if that is going to be long; progress is per neuron, and Cancel is seen within about half a second.

A mesh with no faces is skipped and counted. Meshes must be in nanometres — a dataset answering in voxels is refused, because the window size is a physical one and there would be nothing to convert it with.

```coda-params
seam:findMerges: cutoff, drawEvery, maxWindows
```
