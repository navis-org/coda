## Why a shared space

Two connectomes are two animals. A hemibrain skeleton and a FlyWire skeleton describe the same
anatomy, but the coordinates have nothing to do with each other — different origins, different
orientations, different scales. Drawn together they are two clouds in opposite corners of the
scene. Handed to NBLAST they score as strangers, because NBLAST asks how well one arbor lies
*along* another and these two are nowhere near each other.

This node puts them in the same coordinate system: **JRC2018U**, the unisex template that navis
and the natverse both treat as the meeting point.

```coda-graph
caption: Two datasets, one frame. Neither NBLAST nor a 3D view can compare them before this.
dataset.hemibrain as hb
neuron.skeletons as a
neuron.xform as xa
neuron.nblast as nb
hb -> a:dataset
a -> xa
xa -> nb:query
```

## One transform per dataset, and no graph

Every space Coda knows has exactly one registration — straight into JRC2018U. That is a **star**,
not a network: there is nothing to search and no route to choose. `Target` can name another
dataset's space, and that needs no search either — it is out through the hub and back, always
exactly two hops.

navis carries a real bridging graph and will happily route through four intermediate templates.
Most of those edges are CMTK and H5 registration files: native libraries and gigabytes of data,
neither of which exists in a browser. So Coda's landmark sets were **generated offline against
that full navis stack** and then flattened into one hop each.

The shortcut costs about a micron:

| space | median | p95 |
| --- | --- | --- |
| Hemibrain | 0.77 µm | 2.3 µm |
| FlyWire | 0.87 µm | 2.5 µm |
| MANC | 0.54 µm | 1.8 µm |
| MaleCNS | 0.61 µm | 4.4 µm |

Measured on 3,000 shell vertices per space against the long route. On a 250 µm brain, and
against the biological variation between two flies, that is not the limiting error.

> [!note]
> **Mirror before transforming, not after.** Mirroring in a dataset's own space uses landmarks
> fitted for that brain's asymmetry. After transforming, no such correction exists.

## Two hops cost about what one does, twice

`Target` can be another dataset's space rather than the shared one. That goes out through
JRC2018U and back — two splines instead of one — and the intuition that composing transforms
compounds their error turns out to be wrong. Measured against navis, in the region the target
actually covers:

| | two hops | the two one-hops added |
| --- | --- | --- |
| hemibrain → FlyWire | 1.33 µm | 1.61 µm |
| FlyWire → hemibrain | 1.87 µm | 1.61 µm |

About the sum, and on the first pair slightly under it: two splines' errors cancel as readily as
they add. The second hop costs time — another fit — and very little accuracy.

> [!note]
> **What does degrade an answer is a target that does not cover the neuron.** The hemibrain is
> roughly one hemisphere, so about 60% of a whole-brain FlyWire neuron has no hemibrain
> coordinate at all. Out there the spline extrapolates, and so does navis — its own deformation
> field warns on the same region. This is a fact about the target space, not about the route.

Where the two spaces do not overlap *at all* — a nerve cord into a brain-only volume — the node
says so before you run it. Partial overlap it cannot judge in advance, because whether it
matters depends on where your particular neurons are.

## The nerve cord is placed, not registered

JRC2018U is a **brain** template. There is no nerve cord in it.

A VNC is registered to JRCVNC2018U — the honest target for one — and then moved into the brain's
frame by a fixed affine, so that a brain and a nerve cord can be drawn in one scene. That is a
*layout*. A VNC coordinate here is in the right place relative to the brain and does not mean
anything anatomical on its own.

Two consequences worth having in mind:

- **MANC** is entirely nerve cord, so all of it is placed. The node says so on the card.
- **MaleCNS** is both, and its two halves reach the frame by different routes — so they disagree
  slightly where they meet. About 2% of points near the neck are more than 10 µm out, against a
  median of 0.6 µm everywhere else. A descending neuron is the case that sees it.

A combined `JRC2018Ucns` space, with the two arranged properly, will replace this.

## What the exported notebook does

Not the same thing, deliberately — and this is the one place an export is *better* than the
canvas. The cell reads `navis.xform_brain(..., source=…, target=…)`, which walks the full
bridging graph rather than the shortcut sampled from it. Same destination, about a micron more
accurate — and much more than that for a dataset-to-dataset target, where Coda goes via the hub
and navis usually goes direct.

For a dataset with a nerve cord the notebook **refuses** rather than emitting that call. navis
has no registration placing a VNC in a brain template, so `xform_brain` routes it through a
brain deformation field instead: every sample point lands outside the field, navis warns, and
the answer comes back 97 µm from Coda's. A cell that runs and returns nonsense is worse than a
gap with an explanation in it.

## Two smaller things

**The space is read off the geometry**, so there is nothing to set. The `Space` override exists
for geometry that arrived without one — a Custom dataset node pointed at a deployment Coda ships
no binding for. It can only *fill a gap*, never contradict the value: if the two disagree the
node refuses, because a setting made once and forgotten would otherwise relocate a later graph's
neurons with a green card and no warning.

**Coordinates stay in nanometres**, though JRC2018U is published in micrometres. The landmarks
are converted on load, which is exact — a 3-D thin-plate spline's kernel is homogeneous, so
scaling one side scales the result and nothing else. Everything in Coda is nm, and NBLAST's
units check keeps working downstream of this node.
