## What mirroring is for

A neuron and its partner on the other side of the brain have the same shape and never touch. They
do not overlap in a 3D view, so you cannot see whether they are the same cell type, and NBLAST
scores them as strangers, because it asks how well one arbor lies *along* another.

Mirroring moves one onto the other. What comes out is the same neuron with the same id, in the same
space, on the other side.

```coda-graph
caption: The mirrored set scores against the original, which is the comparison the flip exists for.
dataset.hemibrain as ds
neuron.skeletons as skel
neuron.mirror as mir
neuron.nblast as nb
ds -> skel:dataset
skel -> mir
mir -> nb:query
skel -> nb:target
```

## The two halves, and why the switch exists

**The flip** reflects every coordinate about the midline of the template space — `x' = c − x`,
where `c` is a property of the volume rather than of your data. One pass over a buffer, and free.

**The correction** is a thin-plate spline through a few thousand landmark pairs, and it is there
because *an insect brain is not symmetric*. Flipped and left there, a neuron sits about **7 µm**
from its contralateral partner on FlyWire and **33 µm** on MaleCNS — roughly the width of a small
neuropil, comfortably enough for NBLAST to score a homologue as a stranger.

`Warp` on is what you want for anything quantitative. Off is reasonable when framing a picture:
off costs nothing where on downloads a Python runtime (~10 MB) the first time in a session.

## What it costs

The spline is fitted once and then kept — in the session, and in the browser's own storage after
that:

| | what happens | roughly |
| --- | --- | --- |
| first mirror ever | Python downloads, spline is fitted | 10 MB, plus 0.1–5 s of fitting |
| first mirror in a later session | spline rebuilt from stored coefficients | 0.1 ms |
| every mirror after that | nothing but the transform itself | 0.3 s per 100k points |

The fit is cubic in the landmark count: the hemibrain's 1,484 landmarks fit in 0.7 s and FlyWire's
3,390 take 4.7 s. Applying is linear, at roughly a quarter of a million points per second.

## Which brains it works in

Coda ships direct mirror landmarks for six spaces — hemibrain, MaleCNS, MANC, FlyWire and FAFB,
plus the *Aedes aegypti* brain. **Only direct ones.** navis can mirror a brain by routing through
another template; that needs registration files which are native libraries and gigabytes of data.

A dataset outside that list — the optic lobe, a synthetic connectome, a Custom node pointed at your
own server — has no midline anywhere, and this node says so instead of guessing one.

> [!note] The mosquito brain has no route into the shared template
> `Transform Neurons` does not offer it: JRC2018U is a *Drosophila* template, and there is no
> registration between the two animals to build one from. Mirroring is unaffected — a midline is a
> property of the volume itself, and this one has its own.

The Aedes volume is the `wclee_aedes_brain` CAVE datastack, which Coda ships no dataset node for:
reach it through **Custom CAVE**, and the space is stamped on the geometry from there.

## Two things worth knowing

**The id does not change.** A mirrored neuron *is* that neuron. What is added is a `mirrored`
column on the attribute table, which is how you colour the original and the mirror apart after
stacking them into one viewer.

**A `side` annotation does not update.** If the neurons carry `soma_side` or similar, that column
still says what it said: it is somebody's annotation of the original. Read it as a fact about where
the neuron came from, not where it now is.

## Where the numbers come from

The flip constant is generated from the same template bounding box `navis.mirror_brain` reads, by a
script in this repository, and a check holds the two to *exact* agreement on every space. The
landmarks are navis-flybrains' own, and the spline is the same `navis-fastcore` implementation
navis itself uses — so a mirror here and a mirror in a notebook are the same operation. The
exported cell reads `navis.mirror_brain(..., warp=True)`.
