Simulate Model runs a [Compartment Model](#biophys:model): its partners fire, and the voltage is recorded at the soma and at any points you wire into `Record at`. It runs in the background, so you can keep working while it does.

It has five outputs:

| Output          | Contents                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `Traces`        | `t` in ms, then one column of voltage (mV) per record site, `soma` first                                        |
| `Input spikes`  | one row per spike fired at a partner: `partnerId`, `partnerType`, `sign`, `time`, and `arrival` at its synapses |
| `Output spikes` | one row per spike at a record site: `site` and `time`                                                           |
| `Partners`      | one row per partner: its `sign`, whether it fired, and with the per-partner summary, what it did alone          |
| `Arbour`        | the neuron as a skeleton, each node carrying the highest voltage it reached                                     |

`sign` says which of the model's synapse inputs a partner came in on: `excitatory`, `inhibitory`, or `mixed` for a partner on both.

The traces table plots as it is in a [Line Chart](#out.lineChart): with `Y` left empty it draws every trace against `t`. To see where on the neuron the voltage went, wire `Arbour` into a [3D View](#out.viewer3d) and colour the skeleton "by node value" with "peak voltage (mV)".

```coda-graph
caption: Run a model, plot the traces and colour the neuron by peak voltage.
biophys:model as model
biophys:simulate as sim
out.lineChart as chart
out.viewer3d as view
model -> sim:model
sim:traces -> chart
sim:arbour -> view
```

## Running

`Duration` and `dt` set how long the run is and its time step. `Sample every` is how often the traces are written; spikes and peaks are read at every step whatever it is. Long runs on large models take a while, and the card says so before you press Run.

```coda-params
biophys:simulate: duration, dt, sampleEvery, threshold
```

## Driving the cell

`Drive` decides how the partners fire:

- "Spike trains" gives every partner its own train: `Spikes` spikes from `Start`, `Interval` apart. `Noise` jitters the intervals, from 0 (exactly regular) to 1 (Poisson), like NEURON's `NetStim`. The trains are seeded, so the same settings give the same run.
- "Input spikes" reads times from a table wired into the `Input spikes` input, with a `Partner` and a `Time` column. Another Simulate Model's `Input spikes` output has exactly those columns, so wiring it in replays that run's drive, seeded trains included — on another model, say, or with some partners silenced.
- "None" fires nobody, which is what you want for injected current alone.

```coda-params
biophys:simulate: drive, start, number, interval, noise, seed
```

By default every partner fires. On a real neuron that is often hundreds of synapses at once, which drives the cell close to the synapses' reversal potential and flattens everything you wanted to compare. Set `Fire` to "the top N by synapses" to fire only the strongest few; the workflow wizard starts you on the top one. To leave particular partners out, untick them under Partners in the expanded view (⤢), or edit `Silenced partners`.

```coda-params
biophys:simulate: fire, top
```

## Injecting current

Tick `Inject current` under `Clamp` to inject a current, on its own or alongside the synapses. It goes in at the soma unless you pick other sites: expand the card (⤢) and tick them under Sites, which lists every record site, the soma, the `Record at` points and the traces added in Playback. Every ticked site gets the same current.

`Shape` sets the waveform between `Start` and `Start` plus `Duration`: a "Step" of `Amplitude`, a "Ramp" from `From` to `Amplitude`, a "Sine" of `Amplitude` at `Frequency` about `Offset`, or a "Pulse train" of `Amplitude` for `Width` every `Interval`. Outside that window no current flows. In the expanded card the `Clamp` tab draws the waveform under its settings, and Playback draws it again under the traces.

While current is injected, the `Traces` output has an extra `injected` column: the current in nA at each sample. It is in different units from the voltages, so pick the columns you want when you plot `Traces` in a Line Chart.

```coda-params
biophys:simulate: clamp, clampShape, amplitude, clampDelay, clampDuration
```

A site is picked by its name, so if a `Record at` point goes away or a trace is renamed, the card says nothing is injected there; tick the sites again under Sites.

### A table of current

To inject a waveform the shapes above can't make, wire a table into `Current`: a recording's command from [Load Recording](#biophys:loadRecording), noise, or a few breakpoints written by hand. `Current` picks the column to inject. It lists the columns in pA or nA, and if the table has several it asks you to pick, since a recording often holds a noisy current monitor beside the command. Each value is held from its row's time until the next row's, as an amplifier holds a command, with times counted from the start of the run. Nothing is injected before the first row, or after the last row plus one sample: end the table with a row where the current should stop, and the card says when it doesn't.

The current goes into the soma. To send rows elsewhere, set `Current site` to a column naming a record site (the soma, a `Record at` point or a Playback trace) in each row. A name no site has is said on the card, and those rows inject nothing.

If the table has a `sweep` column, each sweep is its own run, every one starting from rest. The `Traces` and `Output spikes` outputs then gain a `sweep` column, so a whole I–V protocol is one card: plot `Traces` in a Line Chart with `Series` set to `sweep`. `Current sweep` names the column; set it to none to inject the whole table in one run. Playback replays the first sweep, and says so.

A table adds to `Inject current` rather than replacing it: a holding current from the Clamp tab plus a recorded command, say. The `injected` column of `Traces` is the current into the first site that gets any, which is the soma when a recording is replayed.

```coda-params
biophys:simulate: currentValue, currentSite, currentSweep, currentTime, currentUnit
```

## Recording

The soma is always recorded. To record elsewhere, wire points into `Record at`: for instance this neuron's output synapses from Synapses, or points placed by hand in Skeleton to Points. Each point is snapped to the arbour; a point further than `Record distance` is not recorded and is counted on the card. `Record label` names each trace column from a column of the points, such as `name`.

```coda-params
biophys:simulate: recordLabel, recordSnap
```

## Which partners matter

Tick `Per-partner summary` and Simulate Model also runs every firing partner alone: one spike at `Summary onset`, for `Summary window` ms. The `Partners` table then gives each partner's peak change in voltage at the soma and at its own synapses, and the ratio between the two, which is how much of it survives the trip to the soma. An inhibitory partner's change is negative: the fall below rest it causes. This is one extra run per partner, so it takes longer.

If the cell is still well away from rest at the end of the run, long after its last input, the card says where. An active model with too little potassium for its sodium can stay depolarised after a spike, or keep firing on its own; raising the potassium, or moving rest further from threshold, fixes it.

```coda-params
biophys:simulate: perPartner, summaryOnset, window
```

## Playing it back

Expand the card (⤢) and open Playback to watch the last run move over the neuron: the dendrogram and the neuron in 3D coloured by voltage, with the soma trace below. Play, step with the arrow keys, or drag the time slider. Click a branch on the dendrogram to add its trace; click it again, or its ✕, to remove it. Added traces are saved with the workflow, and each becomes a column of the `Traces` output after the next run: adding one marks the card as needing a Run, while Playback keeps playing the run it has. Untick `Traces` to give the neuron the whole view and plot the `Traces` output with a Line Chart instead. Tick `Radius` to draw each branch as wide as its radius, on the dendrogram and in 3D. Tick `Inputs` to mark the synapses of the partners that fired, on the dendrogram and in 3D. Inhibitory synapses are drawn in grey and, on the dendrogram, on the other side of the branch; the ticks along the bottom of the trace plot are when their spikes arrive.

The movie has a frame for every `Sample every`, so lower it to see the first fraction of a millisecond at a synapse. A very fine movie of a large model is spaced out to fit in memory, and the controls say so. Colours are "from rest" by default, the whole colour ramp spent from the resting potential up to the run's peak, which shows small depolarisations well. "About rest" colours depolarisation and hyperpolarisation either side of rest; use it to see inhibitory inputs.

> [!NOTE] Playback re-runs the simulation
> To save memory, the movie is not kept with the result. Opening Playback runs the simulation
> again with every compartment recorded, which gives exactly the same voltages. If you change a
> setting, run the node again before playing it back.
