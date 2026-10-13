The Compartment Model turns one neuron's skeleton into a model that [Simulate](#biophys:simulate) can run. The skeleton is cut into compartments, each gets a passive membrane, and the synapses of a wired point cloud are placed on the arbour where they sit, grouped by presynaptic partner. Optionally, the soma gets Hodgkin–Huxley channels.

The usual way to wire it: [Skeletons](#neuron.skeletons) for the neuron, and Synapses Between with the neuron as `Targets` and its partners as `Sources`.

```coda-graph
caption: One neuron and the synapses onto it, as a model.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
neuron.synapsesBetween as syn
biophys:model as model
ds -> find
ds -> skel:dataset
find -> skel:neurons
ds -> syn:dataset
find -> syn:targets
skel -> model:neuron
syn -> model:synapses
```

The model takes exactly one neuron. If your search returns several, put a [Select One](#core.selectOne) in front of Skeletons and step through them.

## Membrane

`Preset` fills in the passive properties from a published model:

- "Drosophila PN" is from Tobin et al. 2017, after Gouwens & Wilson 2009, fitted to antennal-lobe projection neurons. It makes a fairly compact cell.
- "Fly visual (Meier & Borst)" is from Meier & Borst 2019, fitted to calcium imaging of the optic-lobe cell CT1 and consistent with Yang et al. 2016's fits to Mi1. Its lower membrane resistance and higher axial resistivity give a length constant about half as long, so thin neurites isolate their ends much more. Their model works in voltage relative to rest, so `E leak` is not theirs: it is set to −60 mV.

- "Fly optic lobe (Vieira et al.)" is the passive constants of Vieira et al. 2026's T4 and T5 models: round values they describe as standard for invertebrate neurons and consistent with T4's input resistance. They state no `E leak`, so it is −60 mV here, and their models add a 2.6 µm soma, which you set with `Soma diameter`.

None was fitted to the neuron you are modelling. Pick "Custom" to set `Rm`, `Ra`, `Cm` and `E leak` yourself.

```coda-params
biophys:model: preset, rm, ra, cm, eLeak
```

Radii matter more than anything else here: axial resistance goes with 1/r², so a skeleton with noisy or missing radii gives a model with spiky or arbitrary resistance. Nodes without a radius get `Default radius`, and the card says how many did. `Smooth radii` averages each radius with its neighbours along unbranched stretches.

```coda-params
biophys:model: defaultRadius, smooth
```

## Compartments

By default each section is cut by the "d_lambda rule": no compartment longer than `d_lambda` times the length constant at 100 Hz. This is NEURON's own rule, so a model built here has the same number of compartments NEURON would give it. "Fixed length" caps each compartment at `Max length` instead. Smaller is more accurate and slower; the card reports the compartment count.

```coda-params
biophys:model: discretisation, dLambda, maxLength
```

Pieces of the skeleton that are not connected to the soma are left out, and the card counts them.

## Soma

If the skeleton labels a soma, it is used as one compartment. Most reconstructions do not label one; set `Soma diameter` to add a spherical soma at the root.

```coda-params
biophys:model: somaDiameter
```

## Regions

Channels are placed on regions. A model starts with the regions its skeleton is labelled with — `soma`, `axon`, `dendrite`, `linker` — taken from Split Axon/Dendrite where the skeleton went through it, otherwise from the source's own (SWC) compartments.

To add your own, expand the card (⤢) and open the Regions tab. Click a branch of the dendrogram and choose what to paint: everything distal of that point (away from the soma), or everything else, becomes one of the existing regions or a new one. New regions are called `region 1`, `region 2` and so on; rename them in the list beside the dendrogram. Renaming a region also moves the channels placed on it.

Strokes are applied in order and a later one paints over an earlier one, so every compartment is in exactly one region. To mark a spike initiation zone between two points, for example, paint distal of the first point as `SIZ`, then distal of the second point back as `axon`. Strokes are saved with the workflow by position; one that no longer lands on the skeleton (for example after a different reconstruction is wired in) is ignored and counted on the card.

Painting the soma's branch relabels its membrane, not where the soma is.

```coda-params
biophys:model: paintedRegions
```

## Channels

Without channels the model is a passive cable. To add voltage-gated channels, expand the card (⤢) and use the Channels tab. Each row is one channel:

- **Regions**: where it sits, from the regions above. With none ticked it sits everywhere, unlabelled cable included.
- **Amount**: a density in mS/cm², or a total per cell in nS. A total is spread over the ticked regions by membrane area, so moving a channel from the axon to everywhere keeps how much of it the cell has.
- **ΔV50**: moves the channel's activation or inactivation curve by that many mV, e.g. −15 on inactivation.

Each row's "?" says what its channel is, its gating and reversal potential, and the density it starts at. Choosing a different channel resets a density to that channel's own starting value; a total per cell is kept.

Two sets of channels are available. "Pospischil" sodium and potassium are the ones Jaxley ships, as used by Vieira et al. (2026) for their Fig. 1. "Squid HH" are the squid axon's, with "+ Squid HH soma" adding both to the soma in one go. Neither is a fly's channel: use them to see whether inputs could drive a spike at all, not to predict a firing rate.

```coda-params
biophys:model: channels, temperature
```

> [!NOTE] No axon terminals
> There is no separate region for axon terminals, so a channel placed on the axon covers its
> terminals too. To treat them apart, paint them as a region of their own.

## Synapses

The model has two synapse inputs: `Synapses (exc.)` for excitatory synapses and `Synapses (inh.)` for inhibitory ones. Each has its own tab, with its own column settings and its own mechanism. Wire either or both. A common setup is the same Synapses Between twice, split by predicted neurotransmitter: cholinergic partners on the excitatory input, GABAergic and glutamatergic partners on the inhibitory one.

Each row of a synapse input is one synapse. `Presynaptic` names the partner it belongs to; all synapses of one partner fire together. `Postsynaptic` names the neuron the synapse is on, and rows for any other neuron are dropped and counted. The defaults fit Synapses Between with this neuron as `Targets`. A Synapses cloud of the neuron works only if it has a column naming each synapse's partner; set `Orientation` to "read from a polarity column" for it. neuPrint's and CATMAID's Synapses clouds have no such column: use Synapses Between. The card refuses such a cloud where it can tell, and warns where `Presynaptic` is "None", which is otherwise right for points placed by hand.

A partner that turns up on both inputs is still one partner: it fires as one, and each of its synapses keeps the mechanism of the input it came in on. The card says how many such partners there are.

You do not need a connectome to place synapses: points placed by hand in Skeleton to Points work too, with `Presynaptic` set to their `name` column so that points sharing a name fire together, or to "None" to make every point one partner.

```coda-params
biophys:model: presynaptic, postsynaptic, partnerType, maxSnap
```

Each synapse is a double-exponential conductance (NEURON's `Exp2Syn`). A site holding several synapses gets that many times `g max`. `Preset` sets the rise, decay and reversal from a published source:

| Preset                   | Input | τ rise / decay (ms) | E rev (mV) | Source                                                     |
| ------------------------ | ----- | ------------------- | ---------- | ---------------------------------------------------------- |
| ORN→PN nicotinic         | exc.  | 0.2 / 1.1           | −10        | Gouwens & Wilson 2009; g max 0.1 nS from Tobin et al. 2017 |
| Fly nicotinic (cultured) | exc.  | 0.64 / 2.1          | 0          | Lee & O'Dowd 1999                                          |
| PN→KC nicotinic          | exc.  | 1.0 / 2.8           | 0          | Turner, Bazhenov & Laurent 2008                            |
| GABA_A (Rdl)             | inh.  | 0.84 / 5.4          | −68        | Lee, Su & O'Dowd 2003; E rev from Groschner et al. 2022    |
| Glutamate (GluClα)       | inh.  | 0.84 / 5.4          | −71        | Groschner et al. 2022; kinetics are GABA_A's               |

Only ORN→PN sets `g max`, being the only source that states one; with the other presets it stays on the card. `Delay` is never part of a preset. "Custom" shows all the numbers. The inhibitory input starts on GABA_A.

```coda-params
biophys:model: synapsePreset, gmax, tau1, tau2, eRev, delay
```

> [!NOTE] Glutamate is usually inhibitory in the fly brain
> In the central brain of _Drosophila_, glutamate mostly acts on the glutamate-gated chloride
> channel GluClα and inhibits (Liu & Wilson 2013). No synaptic kinetics have been published for
> it, so the Glutamate preset borrows GABA_A's.

> [!TIP] Check the counts on the card
> The card says how many synapses were placed, how many were too far from the arbour, and how
> many belonged to another neuron. If most were dropped, the usual cause is the wrong column in
> `Postsynaptic`, or a synapse cloud fetched for a different neuron.
