# Simulating a neuron from its skeleton

The Biophysics plugin turns a reconstructed neuron into an electrical model and runs it in your browser. You can ask what a neuron's synaptic partners do to its voltage, where on the arbour an input is lost before it reaches the soma, where its spikes start, or which passive membrane makes a model behave like a cell you recorded from.

This guide explains what a compartment model is, then builds, runs and fits one, using a single neuron throughout: a projection neuron of the DA1 glomerulus from the hemibrain connectome. You don't need any background in biophysics to follow it. Each node also has its own help page (the **?** on its card) covering every setting, so this guide only mentions the ones that matter on a first run.

Boxes marked **In depth** are for readers who already know compartment modelling: they say what the plugin does exactly, and where it departs from NEURON. Skip them on a first read.

## 1. What a compartment model is

A neuron's membrane separates two salty solutions. It holds charge like a capacitor, and it leaks a little current like a resistor. Inside, the neurites conduct current along their length, but not very well, so a voltage change at one end of a long thin branch is much smaller by the time it reaches the other end.

A compartment model captures exactly this. The neuron is cut into short pieces, the **compartments**. Each one is a small patch of membrane, and neighbouring compartments are connected by the resistance of the cytoplasm between them. Current injected anywhere — by a synapse, by an electrode — spreads through this network, and the model tells you the voltage everywhere over time.

![A neurite cut into compartments, each one a patch of membrane (a capacitance Cm beside a leak Rm to its resting voltage E leak), joined to the next through the cytoplasm's resistance Ra.](compartments.svg)

### 1.1 Passive properties

A membrane with nothing but a capacitance and a leak is **passive**: it adds up its inputs and lets them fade, but never spikes. Four numbers describe it:

| Name   | Unit   | What it is                                                                          |
| ------ | ------ | ----------------------------------------------------------------------------------- |
| Rm     | Ω·cm²  | how well the membrane insulates: higher means less current leaks out                |
| Cm     | µF/cm² | how much charge the membrane stores: higher means it charges more slowly            |
| Ra     | Ω·cm   | how poorly the cytoplasm conducts: higher means signals fade faster along a neurite |
| E leak | mV     | the voltage the cell settles at when nothing drives it, its resting potential       |

None of these can be read off a reconstruction. They come from recordings — either published values from a similar neuron, or values fitted to a recording of your own, which is what section 4 is about.

The other thing that matters is the shape of the neuron, above all the **radius** of each neurite. A neurite half as thick has four times the axial resistance, so a model is only as good as the radii in its skeleton. How far a voltage reaches is measured by the **length constant** λ: the distance over which a steady voltage falls to about a third.

![A steady voltage fading along a neurite at the Drosophila PN preset's constants: a 0.25 µm neurite loses it in half the distance a 1 µm one does.](attenuation.svg)

> [!DETAIL] The model in NEURON's terms
> Each unbranched stretch of the skeleton is a section, cut into `nseg` segments by NEURON's d_lambda
> rule (`fixnseg.hoc`, the same formula exactly), so a model built here has the compartment count
> NEURON would give it. Membrane area and axial resistance are integrated over the skeleton's original
> cone frusta, as `pt3dadd` does, never from a mean radius. Synapses are double-exponential
> conductances (`Exp2Syn`) placed by NEURON's `sec(x)` rule.
>
> The solver is our own, a few hundred lines of TypeScript running backward Euler (NEURON's fixed-step
> method) with Hines elimination in a Web Worker, because NEURON is not available in the browser. It
> is held to NEURON 8.2 rather than argued to agree with it: on two hemibrain DA1 projection neurons
> (about 2,500 and 3,000 compartments, one passive and one with HH channels near the soma) the largest
> voltage difference over a 60 ms run is below 10⁻⁷ mV, and the test suite asserts 10⁻⁵ mV.

### 1.2 Active properties (channels)

Spikes come from **voltage-gated channels**: pores in the membrane that open when the voltage rises. Sodium channels open first and let positive charge in, which raises the voltage further; potassium channels open a little later and bring it back down. Where there are enough of them, a small depolarisation turns into a spike.

![A spike, computed by Coda's solver from the squid axon's channels: the sodium current carries the rise, the potassium current the fall and the dip below rest.](spike.svg)

You place channels on **regions** of the neuron — the axon, the soma, or any stretch you mark out — each at a density, in mS/cm². In most insect neurons the soma sits off to the side on a thin neurite and takes no part in spiking. Spikes start in the axon, close to where it leaves the dendrites, and the soma only sees them as small ripples. So the model in section 3 puts its channels on the axon, with a much higher density on the stretch where the axon starts.

> [!DETAIL] Channels on offer
> Three sets. **Fly (Günay et al. 2015)**: transient and persistent sodium (NaT, NaP) and slow and
> fast potassium (Ks, Kf), fitted to voltage-clamp recordings from *Drosophila* neurons — a larval
> motoneuron's, not an adult central brain neuron's. Each is a Boltzmann steady state and a fitted
> time constant, written from the paper's Table 5 and held to NEURON running the same equations.
> **Pospischil** sodium and potassium (Pospischil et al. 2008), as Jaxley ships them and as Vieira
> et al. (2026) used them. **Squid HH**, NEURON's `hh.mod`, whose rates scale with `Temperature` by
> Q10 = 3. The last two are not a fly's: use them to ask whether and where inputs could drive a
> spike, not to predict a firing rate. A channel's `ΔV50` shifts its activation or inactivation
> curve. An amount can also be a total per cell in nS, spread over its regions by membrane area.

## 2. The nodes

The Biophysics plugin adds five nodes. Everything else in the workflows below is a node Coda already has.

![The five Biophysics nodes, fresh on the canvas: each card says which input it needs first.](nodes.webp)

From the left: [Compartment Model](#biophys:model) builds a model from one neuron's skeleton, and [Simulate Model](#biophys:simulate) runs it. [Load Recording](#biophys:loadRecording) reads a patch-clamp recording (ABF or NWB), [Fit Model Passive](#biophys:fit) fits a model's membrane to one, and [Combine Traces](#biophys:combineTraces) puts a recording and a simulation on one time axis. Each card's **?** opens its own help.

The plugin is off until you switch it on: open **Plugins** in the toolbar and switch on **Biophysics**, or type `/biophys` in the command palette. Simulate Model and Fit Model Passive only run when you press **Run**, since a simulation can take a while. Both run in the background, so you can keep working.

## 3. Step by step: a neuron driven by its inputs

This section builds one model from start to finish: a projection neuron of the DA1 glomerulus, given sodium and potassium channels on its axon and driven by the olfactory receptor neurons (ORNs) that synapse onto it. Each step shows what your canvas should look like. The finished workflow is also [an example you can open](#!demo://biophys:simulate). It reads from neuPrint, so it needs a neuPrint sign-in, under **Connections**.

### Step 1: Switch on the plugin

The Biophysics plugin is off until you switch it on. Open **Plugins** in the toolbar and switch on **Biophysics**, or type `/biophys` in the command palette. Its five nodes then appear in the node menus.

![The Biophysics plugin in the Plugins dialog, switched on.](plugins.webp)

### Step 2: Pull a neuron

A compartment model is one neuron, so the first cards pick one and fetch its skeleton:

1. Add a **Hemibrain** dataset card.
2. Add **Find Neurons**, wire the dataset into it, and add a filter: `type` is `DA1_lPN`. It finds the seven DA1 projection neurons.
3. Add **Select One** after it. It passes on one neuron at a time; step its arrows to the second of the seven (hemibrain `754534424`) and press **Use this**.
4. Add **Skeletons**, and wire the dataset and Select One's item into it.

![Step 2: a DA1 projection neuron, picked out and its skeleton fetched.](step-neuron.webp)

### Step 3: Build the model

Add a **Compartment Model** and wire the skeleton into its `Skeleton` input. The card builds the model at once and says how many compartments it has. Then expand it (⤢) to set it up.

![Step 3: the skeleton wired into a Compartment Model.](step-model.webp)

**Passive properties.** The settings beside the drawing start on **Membrane**. **Preset** picks published passive constants; "Drosophila PN" (Tobin et al. 2017), fitted to antennal-lobe projection neurons like this one, is the default, so leave it. The **Model** tab draws the cable the solver will run on, with a few numbers that catch a broken model: the input resistance at the soma, the membrane time constant, the soma's share of the membrane, and each region's membrane area. Hover over any compartment to see what it carries.

![The expanded Compartment Model: the Model tab, and the Drosophila PN preset under Membrane.](model-membrane.webp)

> [!DETAIL] Presets, the soma and radii
> | Preset | Rm (Ω·cm²) | Ra (Ω·cm) | Cm (µF/cm²) | E leak (mV) |
> | --- | --- | --- | --- | --- |
> | Drosophila PN (Tobin et al. 2017, after Gouwens & Wilson 2009) | 20,800 | 266.1 | 0.8 | −60 |
> | Fly visual (Meier & Borst 2019) | 8,000 | 400 | 0.6 | −60 (not theirs) |
> | Fly optic lobe (Vieira et al. 2026) | 20,000 | 250 | 1 | −60 (not stated) |
> | Fly T4 (Gruntman et al. 2018) | 100,000 | 100.07 | 1 (NEURON's default) | −65 |
>
> The soma is cut off the skeleton and replaced by a sphere as wide as the skeleton's soma node, or
> `Soma diameter` across, in µm. This neuron's skeleton marks its soma; many don't, and then you
> should set a diameter. Nodes without a radius get `Default radius`, and `Smooth radii` averages
> each radius with its neighbours along unbranched stretches. `Area factor` multiplies every
> compartment's membrane area for membrane the reconstruction misses (spines, fine branches). The
> d_lambda rule sets the compartment count from the membrane, so changing the preset changes it too.

> [!WARNING] Check the soma's share of the membrane
> If the soma holds most of the cell's membrane, it is far too large, and injected current will
> barely move the voltage. The usual cause is a soma diameter meant in nanometres; the card warns
> above 100 µm.

**Regions.** Channels go on regions, so the axon has to be marked out first. This neuron's skeleton labels only its soma, so open the **Regions** tab and paint the rest. It draws the neuron as a dendrogram: click a branch and choose what to paint, everything **away from the root** (the soma) from that point on, or **everything else**, as an existing region or a new one. Strokes are applied in order, and a later one paints over an earlier one.

The primary neurite runs from the soma into the antennal lobe and splits, 75 µm out, into the dendrite and the axon. Paint two strokes:

1. On the axon, just past that branch point: away from the root, as a new region. Rename it `AIS` in the list beside the dendrogram.
2. 25 µm further along the axon: away from the root, as `axon`.

The second stroke paints most of the first one back, leaving a 25 µm `AIS` where the axon begins, and `axon` beyond it. The dendrite stays unlabelled, and the card says so: 61% of the membrane carries no channels, which is what this model intends.

![The Regions tab: the axon painted from where it leaves the dendrite, its first 25 µm as AIS.](regions-tab.webp)

**Channels.** Open the **Channels** tab and add four rows. Each row is one channel, the regions it sits on, and how much of it:

| Channel         | Regions | Density (mS/cm²) |
| --------------- | ------- | ---------------- |
| Na (Pospischil) | axon    | 30               |
| K (Pospischil)  | axon    | 20               |
| Na (Pospischil) | AIS     | 150              |
| K (Pospischil)  | AIS     | 100              |

The axon can carry a spike along its length, and the five-times denser AIS is where one starts. Each row's **?** says what its channel is. The fly set (NaT, NaP, Ks, Kf, from Günay et al. 2015) is in the same list; a new row of it starts as their model's axon, on the axon at their axon's densities.

![The Channels tab: sodium and potassium on the axon, denser on the AIS.](channels-tab.webp)

> [!WARNING] Balance sodium with potassium
> With too little potassium for its sodium, the axon fires once and then sticks near −20 mV, or keeps
> firing on its own. On this neuron, Jaxley's default 6:1 ratio sticks; 3:2 fires a train and comes
> back to rest. Simulate Model says when a cell is still far from rest when a run starts.

### Step 4: Add its input

The model so far has no synapses. Fetch the ones its ORNs make onto it:

1. Add a second **Find Neurons** on the same dataset, filtered to `type` is `ORN_DA1`. It finds 142 of them.
2. Add **Synapses Between**. Wire the dataset into it, the ORNs into `Sources`, and Select One's item (the projection neuron) into `Targets`.
3. Wire its points into the Compartment Model's `Synapses (exc.)` input.

Each synapse is placed on the arbour where it sits, and all synapses from one partner fire together. The card counts them: 1,413 synapses from 141 ORNs.

![Step 4: the ORNs' synapses onto the neuron, wired into the model's excitatory input.](step-synapses.webp)

Then tell the model what kind of synapse these are. Expand the Compartment Model again, open **Synapses (exc.)** among its settings, and choose the **ORN→PN nicotinic** preset: the rise, decay, reversal and conductance measured for exactly this connection.

![Synapses (exc.) with the ORN→PN nicotinic preset.](synapse-preset.webp)

> [!TIP] Read the counts on the card
> The card says how many synapses were placed, how many were too far from the arbour, and how many
> belonged to another neuron. If most were dropped, `Postsynaptic` names the wrong column, or the
> synapses were fetched for a different neuron. Inhibitory inputs go into `Synapses (inh.)` the same
> way; in the fly central brain, glutamate is usually inhibitory.

> [!DETAIL] Synaptic mechanism
> Each synapse is an `Exp2Syn` conductance. Several synapses on one compartment scale `g max` by
> their count rather than collapsing into one. The presets (ORN→PN nicotinic, cultured fly
> nicotinic, PN→KC nicotinic, GABA_A/Rdl, GluClα) set rise, decay and reversal from their sources;
> only ORN→PN states a `g max` (0.1 nS, Tobin et al. 2017), so with the others it stays at the
> card's value. A partner appearing on both inputs is one partner and fires once, each synapse
> keeping the mechanism of the input it came in on.

### Step 5: Set up the simulation

Add **Simulate Model** and wire the model into it.

![Step 5: Simulate Model, wired to the model.](step-simulate.webp)

**Who fires, and how.** Expand Simulate Model. The **Partners** tab lists every ORN with its synapse count. By default every partner fires at once, which on a real neuron drives the cell to the synapses' reversal and sits it there. Fire one strong ORN instead: set **Fire** under **Drive** to "the top N by synapses" with N at 1, which picks the strongest (25 synapses); or untick every partner but the one you want. Then set its spike train under **Drive**: `Spikes` spikes from `Start`, `Interval` apart. Here, 10 spikes from 10 ms, 5 ms apart.

![The Partners tab, one of 141 partners firing, and the spike train under Drive.](simulate-drive.webp)

**Where to record.** The soma is always recorded. Open **Playback** and click a branch on the dendrogram to record there too; each added trace is marked on the dendrogram in its colour, and becomes a column of the `Traces` output after the next run. Add one at the base of the dendrite, just past the branch point, and one at the far tip of the axon in the lateral horn.

![The three record sites: the soma (white dot), the dendrite's base and the axon's tip, each ticked in its colour.](record-sites.webp)

To record at many sites at once, wire points into `Record at` instead: the neuron's own output synapses, say, or points placed by hand in **Skeleton to Points**.

**Current instead of synapses.** To inject current, as an electrode would, tick `Inject current` under **Clamp** and pick a step, ramp, sine or pulse train; the **Sites** tab says where it goes in. Or wire a table into the `Current` input, such as a recorded command from Load Recording. Set `Drive` to "None" to inject current alone.

> [!DETAIL] Determinism and replay
> Spike trains are seeded, like NEURON's `NetStim`, with `Noise` from 0 (regular) to 1 (Poisson), so
> the same settings give the same run, and a result is cached until something that changes it does.
> Another Simulate Model's `Input spikes` output has the columns the `Input spikes` input reads, so
> one run's drive can be replayed on another model or with partners silenced. A `Current` table with
> a `sweep` column runs each sweep separately, every one from rest.

### Step 6: Run it

Press **Run**. The card estimates the run time beforehand; this one takes under a second. Then open **Playback** to watch the run spread over the neuron: the dendrogram and the 3D view coloured by voltage, the traces below. Play it, step with the arrow keys or drag the time slider.

![Playback at 24.5 ms: the first spike reaching the axon's terminals in the lateral horn.](playback.webp)

The ORN's train depolarises the dendrite, and once it is deep enough the AIS fires. The spike runs out to the axon's tip at full height, four times in all, while at the soma, 75 µm of thin neurite away, each one is only a ripple.

Simulate Model has five outputs:

| Output          | What it holds                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| `Traces`        | time, and the voltage at every record site, one column each                            |
| `Input spikes`  | every spike each partner fired, and when it arrived at its synapses                    |
| `Output spikes` | every spike at each record site that crossed `Spike threshold` (0 mV), and when        |
| `Partners`      | each partner, whether it fired, and with **Per-partner summary** ticked, what it did alone |
| `Arbour`        | the neuron, each node carrying the highest voltage it reached                          |

Wire `Traces` into a **Line Chart** and `Output spikes` into a **Table**:

![The finished workflow: the traces in a Line Chart, the output spikes in a Table.](step-outputs.webp)

![The traces: four spikes at the axon's tip, and at the soma and the dendrite only their echoes.](simulate-traces.webp)

`Arbour` goes into a **3D View**: colour the skeleton "by node value" with "peak voltage (mV)" to see how far each spike reached. And with **Per-partner summary** ticked, Simulate Model also runs each firing partner on its own, and `Partners` says how much each moved the voltage at its own synapses and at the soma: how much of its input survives the trip.

## 4. Fitting the model

Published membrane constants are a starting point. If you have recorded from the neuron type you are modelling, you can fit the passive membrane to that recording instead: load a current-clamp recording, build a model of the same neuron, and let Fit Model Passive adjust Rm, Cm, Ra and E leak until the model's voltage matches the recorded one.

The fitting example [opens a workflow](#!demo://biophys:fit) with a twist: the "recording" is itself a simulation of a model with known constants, so you can check that the fit finds them. That is worth doing once before trusting a fit to real data.

![The fitting example: a recording and a starting model go into Fit Model Passive.](fit-workflow.webp)

### 4.1 Load the recording

**Load Recording** reads Axon Binary Files (ABF 1 and 2, from Clampex) and Neurodata Without Borders files (NWB 2). Choose the file on the card. The file is read in your browser and never uploaded. It stays in this browser rather than in the workflow, so somebody you share the workflow with has to choose the same file again.

The card says what is in the file: the channels, their units, the sweeps and their length. Choose the sweeps to use under **Sweeps**. An NWB file often holds several protocols (a seal test, steps, ramps); **Protocol** picks one.

For a passive fit, use small hyperpolarising current steps: the cell stays well away from any spike, and its channels stay closed.

### 4.2 A starting model

Build a Compartment Model of the same neuron, as in step 3. Synapses are not needed. The model's membrane is where the fit starts, so a preset is fine.

### 4.3 Fit

Wire the model into Fit Model Passive's `Model` input and Load Recording's `Traces` into `Recording`, then press **Run**. The fit replays the current that was injected into the cell in each sweep, compares the model's voltage at the soma with the recorded voltage, and adjusts the membrane until the difference stops shrinking.

The tick boxes choose what is fitted. The usual choice is to leave **Cm** fixed at 1 µF/cm² and fit the **Area factor** instead: a reconstruction misses spines and fine branches, so the real cell has more membrane than the skeleton, and the recording can't tell more membrane apart from more capacitance per µm².

The recording electrode adds a leak of its own: current escapes through the seal between electrode and membrane to the bath, at 0 mV. Left out, the fit puts it on the cell, and `E leak` comes out depolarised. Set **Seal (nS)** if you know it, or tick **Fit Seal**. The fitted model leaves the seal behind, since it belongs to the electrode.

> [!DETAIL] What the fit does, and what it can't tell apart
> Levenberg–Marquardt least squares on the soma voltage, every sweep simulated with its recorded
> command played in sample by sample, starting from where a passive cell settles under the first
> sample's current — so a holding current is in place with no settling transient. Sweeps whose
> commands are scaled copies of one another (an I–V protocol) share one simulation, since the cell
> is linear. Each iteration runs one simulation per free parameter, spread over your cores.
>
> The model only ever sees Cm × area and area ÷ Rm, so Cm, Rm and the area factor are not jointly
> identifiable: fix one. A somatic recording constrains Rm and E leak well and Ra poorly, which the
> standard errors show. `Skip after steps` drops a short stretch after each command step, where the
> bridge-balance and capacitance-compensation artefact sits; `Fit window` limits the comparison
> while the replay still covers the whole sweep. A model with channels is fitted without them.

### 4.4 Read the result

After a run, the card's foot says how the fit ended — "Settled after 12 iterations", "Stalled", or "Stopped at" the iteration limit — with the error at the start and at the end. Expand the card to see the recorded and fitted voltage one sweep at a time, the fitted values with their standard errors, and how the error fell.

![Fit Model Passive expanded, on the example: the fitted voltage lies exactly over the recorded one, and the fitted parameters are the cell's own.](fit-view.webp)

Look at the standard errors before you look at the values. A large standard error means the recording says little about that parameter. A parameter that ended **on its bound** is not a measurement at all: the data wanted a value outside the allowed range. If Ra or Cm ends on a bound, the reconstruction's geometry probably doesn't match the cell you recorded from.

### 4.5 Use the fitted model

Fit Model Passive's `Model` output is the fitted cell, with any channels the starting model had: wire it into a Simulate Model and drive it as in steps 5 and 6. Alternatively, **Apply** on the card's foot writes the fitted values into the Compartment Model you started from; one undo takes it back.

To plot the recording and a simulation together, put both through **Combine Traces**, which puts them on one time axis, and wire the result into a Line Chart. Its `Shift` lines up the stimulus when the recording's step starts at 1000 ms and the simulation's at 10 ms.

> [!TIP] Replay a whole protocol
> Simulate Model's `Current` input takes Load Recording's table directly: each sweep becomes its own
> run, starting from rest, and the traces gain a `sweep` column. That makes a whole recorded
> protocol, replayed on the fitted model, one card.

## Things to watch out for

Most of these give a plausible-looking result when they go wrong.

- **Radii.** Axial resistance goes with 1/r². A skeleton with missing, noisy or very coarse radii gives a model whose resistance is arbitrary. Check how many nodes got the default radius on the card, and consider `Smooth radii`.
- **The soma.** A skeleton that marks no soma gets a point at its root; set a `Soma diameter`, in µm. A value meant in nm makes a soma that holds nearly all the membrane, and the card warns about it.
- **Too many partners at once.** Every partner firing drives the cell to the reversal potential. Fire the top few, or silence partners.
- **Borrowed channels.** Squid HH and Pospischil channels can tell you whether and where a spike is possible, not how a fly neuron fires. The fly set is a larval motoneuron's, not your neuron's. Densities are chosen, not measured, whichever set you use.
- **The seal.** A fit to a whole-cell recording with the seal left out reports the electrode's leak as the cell's: `E leak` too depolarised, `Rm` too low.
- **The reconstruction is not the cell you recorded from.** A fit to one animal's recording on another animal's skeleton absorbs every difference in shape into the membrane constants. Parameters ending on bounds are the usual sign.
- **Fitting a passive membrane with an active cell.** Only small hyperpolarising sweeps keep the channels closed. Large depolarising ones make the fit explain a channel with Rm.
- **One neuron, one model.** Synapses are inputs; their partners are not modelled. There is no network simulation.
- **No notebook export.** The notebook and R Markdown exporters refuse these nodes, since no Python or R library reproduces the model as built here. A NEURON script export is planned.

## Further reading

- Koch, C. (1999). _Biophysics of Computation_. Oxford University Press.
- Carnevale, N. T. & Hines, M. L. (2006). _The NEURON Book_. Cambridge University Press.
- Gouwens, N. W. & Wilson, R. I. (2009). Signal propagation in _Drosophila_ central neurons. _J. Neurosci._
- Tobin, W. F., Wilson, R. I. & Lee, W.-C. A. (2017). Wiring variations that enable and constrain neural computation in a sensory microcircuit. _eLife_.
- Meier, M. & Borst, A. (2019). Extreme compartmentalization in a _Drosophila_ amacrine cell. _Curr. Biol._
- Pospischil, M. et al. (2008). Minimal Hodgkin–Huxley type models for different classes of cortical and thalamic neurons. _Biol. Cybern._
- Günay, C. et al. (2015). Distal spike initiation zone location estimation by morphological simulation of ionic current filtering demonstrated in a novel model of an identified _Drosophila_ motoneuron. _PLoS Comput. Biol._
- Gruntman, E., Romani, S. & Reiser, M. B. (2018). Simple integration of fast excitation and offset, delayed inhibition computes directional selectivity in _Drosophila_. _Nat. Neurosci._
