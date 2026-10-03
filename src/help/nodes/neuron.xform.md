## What Transform Neurons does

Transform Neurons moves neurons (skeletons, meshes or points) from their dataset's own coordinate system into a shared template space, **JRC2018U**. That is the unisex *Drosophila* template that navis and the natverse also use as the common reference.

You need this whenever you want to compare neurons from different datasets. A hemibrain skeleton and a FlyWire skeleton may describe the same anatomy, but their coordinates have different origins, orientations and scales. Without transforming them, they show up in opposite corners of a [3D View](#out.viewer3d), and [NBLAST](#neuron.nblast) scores them as unrelated.

```coda-graph
caption: Transform hemibrain neurons into the template space before NBLAST.
dataset.hemibrain as hb
neuron.skeletons as a
neuron.xform as xa
neuron.nblast as nb
hb -> a:dataset
a -> xa
xa -> nb:query
```

The source space is read from the neurons themselves, so usually there is nothing to configure.

## How it works

Coda ships exactly one transform (a thin-plate spline through landmarks) per dataset, going directly into JRC2018U. You can also pick another dataset's space as the `Target`: the neurons are then transformed into JRC2018U and from there into the target space, i.e. always exactly two steps.

navis has a full network of registrations and may route through up to four intermediate templates. Most of those are CMTK or H5 registration files, which require native libraries and gigabytes of data and therefore can't run in a browser. Coda's landmarks were generated offline from that full navis setup, condensed into one step per dataset.

This shortcut costs about a micron of accuracy:

| Space     | Median  | 95th percentile |
| --------- | ------- | --------------- |
| Hemibrain | 0.77 µm | 2.3 µm          |
| FlyWire   | 0.87 µm | 2.5 µm          |
| MANC      | 0.54 µm | 1.8 µm          |
| MaleCNS   | 0.61 µm | 4.4 µm          |

These numbers were measured on 3,000 points on the surface of each brain, compared against the full navis route. For a 250 µm brain, and compared with the natural variation between two flies, that is usually not the limiting factor.

If you have a registration of your own, build it with a Landmark Transform node and wire it into the `Transform` input. It then replaces the built-in route entirely, and `Target` and `Space` are ignored.

> [!TIP] Mirror before transforming
> If you also want to mirror neurons, do that first with [Mirror Neurons](#neuron.mirror). Mirroring
> in the dataset's own space corrects for that brain's left/right asymmetry; after transforming,
> that correction is no longer available.

## Transforming between two datasets

Going from one dataset to another via JRC2018U doesn't add up errors as much as you might expect. Measured against navis, in the region covered by the target:

|                     | Two steps | The two single steps added |
| ------------------- | --------- | -------------------------- |
| hemibrain → FlyWire | 1.33 µm   | 1.61 µm                    |
| FlyWire → hemibrain | 1.87 µm   | 1.61 µm                    |

So the error is roughly the sum of the two steps, sometimes less. The second step mostly costs time (another fit), not accuracy.

> [!WARNING] Neurons outside the target volume
> The hemibrain covers only about one hemisphere, so about 60% of a whole-brain FlyWire neuron has
> no corresponding hemibrain coordinate. In that region the transform extrapolates (navis does too,
> and warns about it), so those parts of the neuron are less accurate.

If two spaces don't overlap at all (e.g. a nerve cord into a brain-only dataset), the node tells you before you run it. Partial overlap can't be checked in advance, since whether it matters depends on where your neurons are.

## The ventral nerve cord

JRC2018U is a brain template and contains no nerve cord. Nerve cord neurons are therefore first registered to the VNC template (JRCVNC2018U) and then placed next to the brain with a fixed affine transform, so that brain and nerve cord neurons can be shown in one scene. Note that this is just a layout: a VNC coordinate is in the right place relative to the brain, but has no anatomical meaning in JRC2018U.

- **MANC** is entirely nerve cord, so all of it is placed this way. The node says so on the card.
- **MaleCNS** contains both brain and nerve cord, and the two parts take different routes into the template. Where they meet they disagree slightly: about 2% of points near the neck are off by more than 10 µm, compared with a median of 0.6 µm elsewhere. You will notice this mostly with descending neurons.

A combined `JRC2018Ucns` space, with brain and nerve cord arranged properly, will replace this.

## Exporting

The Python notebook export uses `navis.xform_brain(..., source=…, target=…)`, which goes through navis's full network of registrations instead of Coda's shortcut. It ends up in the same place, but about a micron more accurate, and more than that when transforming from one dataset into another (Coda goes via JRC2018U, navis often has a direct route).

> [!WARNING] Datasets with a nerve cord are not exported
> navis has no registration that places a VNC in a brain template, so `xform_brain` would send it
> through a brain registration instead. Every point would land outside that registration and the
> result would be about 97 µm away from Coda's. The notebook export therefore refuses these
> datasets.

## Good to know

**The source space is read from the neurons.** The `Space` setting is only for neurons that arrive without a space, e.g. from a Custom dataset node pointed at a server Coda doesn't know. It can only fill in a missing space: if it disagrees with the space the neurons carry, the node refuses to run rather than silently moving the neurons somewhere else.

**Coordinates stay in nanometres**, even though JRC2018U is published in micrometres. The landmarks are converted when they are loaded, which doesn't change the result.
