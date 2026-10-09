## What Mirror Neurons does

Mirror Neurons flips neurons (skeletons, meshes or points) onto the other side of the brain. The typical use is comparing a neuron with its partner in the other hemisphere: the two have the same shape but don't overlap, so in a [3D View](#out.viewer3d) you can't tell whether they are the same cell type, and [NBLAST](#neuron.nblast) scores them as unrelated (it measures how well one neuron lies along the other).

The mirrored neurons keep their ids and stay in the same space, they are just on the other side:

```coda-graph
caption: NBLAST mirrored neurons against the originals.
dataset.hemibrain as ds
neuron.skeletons as skel
neuron.mirror as mir
neuron.nblast as nb
ds -> skel:dataset
skel -> mir
mir -> nb:query
skel -> nb:target
```

The template space is read from the neurons themselves, so usually there is nothing to configure.

## How mirroring works

Mirroring happens in two steps:

1. **Flip.** Every coordinate is reflected about the midline of the template space (`x' = c − x`, where `c` is a property of the template). This is fast and essentially free.
2. **Warp.** Brains are not perfectly symmetric, so the flipped neuron is then moved onto its counterpart with a thin-plate spline built from a few thousand pairs of landmarks.

Without the warp, a flipped neuron ends up about 7 µm away from its contralateral partner on FlyWire, and about 33 µm on MaleCNS. That is roughly the width of a small neuropil, and more than enough for NBLAST to miss a match.

We recommend keeping `Warp` on for anything quantitative. Turning it off is fine if you just want a picture, and avoids downloading a Python runtime (~10 MB) on the first run of a session.

If you have landmarks of your own, wire a Landmark Transform node into the `Warp` input. It replaces only the warp step; the node still needs to know the template space for the flip.

## Speed

The spline is fitted once and then reused, both within a session and (via the browser's storage) in later sessions:

|                                 | What happens                             | Roughly                       |
| ------------------------------- | ---------------------------------------- | ----------------------------- |
| first mirror ever               | Python is downloaded, spline is fitted   | 10 MB, plus 0.1–5 s of fitting |
| first mirror in a later session | spline is rebuilt from stored values     | 0.1 ms                        |
| every mirror after that         | only the transform itself                | 0.3 s per 100k points         |

Fitting time grows quickly with the number of landmarks: the hemibrain's 1,484 landmarks take 0.7 s, FlyWire's 3,390 take 4.7 s. Applying the transform runs at roughly a quarter of a million points per second.

## Supported brains

Coda ships mirror landmarks for seven template spaces: hemibrain, MaleCNS, MANC, FlyWire and FAFB, plus the *Aedes aegypti* (mosquito) brain and the Fish2 zebrafish brain.

navis can also mirror a brain by going through another template, but that requires registration files that are native libraries and gigabytes of data, so Coda only supports spaces with direct landmarks. For any other dataset (e.g. the optic lobe, a synthetic connectome, or a Custom node pointed at your own server) the node tells you it has no midline for it.

The mosquito and fish brains need a little extra setup:

- The *Aedes* brain is the `wclee_aedes_brain` CAVE datastack. There is no dedicated dataset node for it: use the [Custom CAVE](#dataset.cave) node, and the template space is set on the geometry automatically.
- Fish2 is a private neuPrint server, which you reach through the Custom neuPrint node. Coda doesn't recognise that server, so the neurons arrive without a template space: set `Space` to "Fish2 (zebrafish)".

> [!NOTE] Mosquito and fish neurons can't be transformed
> [Transform Neurons](#neuron.xform) doesn't support these two brains, since its shared template
> (JRC2018U) is a *Drosophila* brain. Mirroring is not affected: each of these brains has its
> own midline.

## Good to know

- **Ids don't change.** A mirrored neuron keeps its id. The node adds a `mirrored` column to the attribute table, which you can use to colour originals and mirrors differently after combining them in one viewer.
- **Side annotations are not updated.** Columns like `soma_side` still say what they said before mirroring, i.e. they describe where the original neuron is, not where the mirrored copy is.

## Compatibility with navis

The midline is calculated from the same template bounding boxes that `navis.mirror_brain` uses, and the two are checked to agree exactly for every space. The landmarks come from navis-flybrains (navis-fishbrains for Fish2), and the spline uses the same `navis-fastcore` implementation as navis. A mirror in Coda and a mirror in a Python notebook are therefore the same operation, and the notebook export uses `navis.mirror_brain(..., warp=True)`.
