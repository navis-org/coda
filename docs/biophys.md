# Biophysics — single-neuron compartment models

The `biophys` pack: take one reconstructed neuron, place the synapses of its presynaptic partners on
it, drive those partners, and read what the soma — or any point — sees. The question it answers is
*"how much does partner X move this neuron, and from where on the arbour?"*, the electrical
counterpart of Connectivity's synapse count.

Two nodes: **Compartment Model** (`biophys:model`, `cheap`) builds a `cellModel` value from a
skeleton and a synapse cloud; **Simulate Model** (`biophys:simulate`, `expensive`) runs it. The pack is
off by default (`/biophys` switches it on) and requires no other: its inputs are the built-in
skeleton and point kinds, whichever backend made them.

## Where things are

| Path | What |
| --- | --- |
| `src/biophys/` | The solver, headless and neuron-agnostic: `discretize.ts` (cable → compartments), `solver.ts` (Hines, backward Euler, HH, Exp2Syn, `Simulation`), `channels.ts`, `referenceCases.ts`. On eslint's headless list beside `src/umap`. |
| `src/packs/biophys/` | The pack: `build.ts` (skeleton + cloud → `CellModelValue`, pure), `model.ts`, `solverInputs.ts` (value → solver model, the one bridge), `stimulus.ts` (seeded trains), `simulateOps.ts` (`planRun`, the tables and their schemas, the arbour), `simulateJob.ts` + `simulate.worker.ts` / `movie.worker.ts`, `simulate.ts`, `presets.ts`, `nodeValues.ts`, `wizard.ts`, `glyphs.ts`, `seeAlso.ts`, `help/`. |
| `src/ui/biophys/` | Simulate Model's expanded view: `SimulateView` (tabs), `SimulatePartners` + `partnerRows.ts`, `SimulatePlayback` + `movie.ts` + `useMovie.ts`. |
| `src/nodes/output/lineChart.ts` | The core Line Chart, which the traces are drawn on. See `docs/viewers-charts.md`. |
| `scripts/biophys_neuron.py`, `scripts/biophys-reference.py`, `pnpm biophys:reference`, `pnpm probe:biophys` | The NEURON harness. The reference writes `src/biophys/__fixtures__/neuron-reference.json` (byte-stable); `pnpm test` holds the solver to it with no NEURON installed. `scripts/biophys-mod/` is the fly channels as `.mod` files, generated from their specs by `pnpm biophys:mods` and compiled by the harness on first use (the build directories are git-ignored). |
| `pnpm probe:gouwens` (`scripts/probe-gouwens.{py,ts}`) | Gouwens & Wilson 2009's DM1 projection neurons in NEURON against our model of them: input resistance and steady-state attenuation. Local only; their files are fetched into `/tmp`. |

## Why our own solver, in TypeScript

NEURON, Arbor and Brian2 are not in the Pyodide lock, and a Hines loop in numpy would be slow. The
solver is a few hundred lines of typed-array code that runs in a Web Worker
(`data/workerJob.ts`), and it is held to NEURON rather than argued to agree with it.

**Measured against NEURON 8.2.6** on our sections and segment counts:

| Case | Compartments | max \|Δv\| | Ours | NEURON |
| --- | --- | --- | --- | --- |
| Squid HH point, 6.3 and 16.3 °C | 3 | 5e-8 mV (the fixture's rounding) | | |
| Synthetic branched, passive, d_lambda, synapse counts | 31 | 3e-7 mV | | |
| Synthetic branched, HH soma + axon stub, spiking | 85 | 2e-6 mV | | |
| hemibrain DA1 PN 1734350788, passive, 53 sites, 60 ms | 2,459 | 2.7e-10 mV | 80 ms | 150 ms |
| hemibrain DA1 PN 1734350908, HH near the soma, 58 sites, 60 ms | 3,043 | 1.7e-8 mV | 99 ms | 472 ms |

The test asserts 1e-5 mV. Throughput is 6–7 × 10⁷ compartment-steps a second on one thread, and
the cost warning is priced from the slow end (5 × 10⁷).

What makes the agreement rounding-level rather than approximate:

- **d_lambda is NEURON's `fixnseg.hoc` formula exactly**, `int((L/(dλ·λ_f) + 0.9)/2)·2 + 1`, so a
  section gets the count NEURON (and the paper's Jaxley models) would give it. The `+ 0.9` can leave
  a compartment slightly over `dλ·λ`, as NEURON does. The fixed-length rule is ours and never
  exceeds its cap.
- **The node layout is NEURON's**: `nseg` centres per section plus a zero-area node at every section
  end and at the root.
- **Area and axial resistance are integrated over the original cone edges**, as `pt3dadd` does,
  never from a mean radius (off by a third on a cone).
- **A synapse lands by NEURON's `sec(x)` rule** (`compartmentAt`). A synapse at a section's end
  must be at `x = 1` *exactly*: 0.99999… from two slightly different arc sums puts NEURON's at the
  last segment centre.
- **A compartment's region is the label nearest its centre**, not its distal end, which flips with
  the root; the re-rooting test caught that.

**Checked against Meier & Borst's own CT1 model** (2019; their code and stitched `BigCT1.swc`,
Zenodo 2636606, CC BY-NC-SA — so a probe, never a committed fixture). Their Fig. 3B measure, the
mean steady-state voltage at ten terminals as a share of the one given 10 pA, at Rm 8,000 and Ra
400: **ours 13.21%, 2.618 GΩ**, the same at 1,651, 2,745 and 26,733 compartments; **theirs 15.41%,
2.743 GΩ**. The whole gap is their geometry: one compartment per SWC node with a cylinder of the
node's diameter for its membrane and the mean diameter's cross-section for its axial conductance.
Their solver given a cone's exact conductance (π r₁ r₂ / ρL) and lateral area gives **13.21%, 2.618
GΩ** — ours to the last digit. The mean-diameter cylinder understates a tapering neurite's
resistance, which is why theirs reads a little less isolated.

## The model

- **Radii decide everything.** Axial resistance goes with 1/r², so a skeleton with noisy or missing
  radii gives a model with spiky or arbitrary resistance and a plausible trace. Missing radii take
  `Default radius` and are counted; `Smooth radii` averages along unbranched stretches. Datasets
  that stamp a floor radius (optic-lobe's 256 nm) trip `stampedRadius`'s note. A model built on
  radii far too thin saturates: every input drives the cell to the reversal potential.
- **The soma.** A labelled soma (SWC 1) becomes one sphere-equivalent section, every fibre leaving
  it starting at its own radius (`startRadius`, which forces a section break) **and at its surface**
  (`startOffset`: the stretch from the centre is the soma's own membrane). `Soma diameter` adds or
  overrides one, under **`Soma`: cut off and replace** (default) — **use the skeleton as is** keeps
  the skeleton's nodes and radii there, the soma node only where "the soma" is recorded and clamped.
  **What is replaced is the `soma` region painted touching the soma node** (`modelRegions`, the one
  statement the build and the Regions tab both read, the tab drawing it in a hue of its own,
  `replacedInk`, the greys being taken). It **starts** as the
  skeleton's taper (`somaNodes`) — a computed base layer, never stored as strokes, which would go
  stale with the skeleton and fill the list with strokes nobody made — and strokes adjust it, an
  `upTo` scope ("from the soma to here": the path out to a node and the twigs dying before it) being
  how a cell body is outlined in one click per neurite. Why replace more than the labelled node: an
  EM skeleton labels one node near the nucleus, its neighbours sit at nearly its radius, and
  skeletonisation leaves dead-end side branches inside the cell body. On MaleCNS 10075 (soma 5.9 µm)
  that kept cable was 190 µm² within 1.5 soma radii against the soma's 108, some of it inside the
  soma's own volume; the neighbourhood went from 462 µm² to 142 within three radii once replaced.
  The taper's rule (nodes at least half the soma's radius, within three radii, plus dead ends never
  reaching three radii) was asked, not assumed: a fixed distance either leaves a fat stub (1×:
  10075's 2.83 µm node at 3.1 µm) or reaches into neurites. A soma-painted patch not touching the
  soma node stays cable. **`ignored`** leaves a subtree out like a fragment, its synapses dropped and
  counted; a stroke that would ignore the soma node is refused whole. `soma-surface` holds the
  offset to NEURON (its first 3D point moved to the surface). With neither a labelled soma nor a
  `Soma diameter`, the bare root stands in, and it is a poor soma: a zero-area node,
  so current clamped there enters through thin neurites (0.05 nA drove a passive PN to +26 mV, and
  NEURON agrees). The card says so.
- **Only the soma's component is modelled.** Fragments off it are dropped and counted; synapses on
  them would never reach the soma, which navis only logs.
- **An input is a row whose postsynaptic neuron is this one**, asked of the row's two ends and
  never of `polarity` alone: `polarity` is the drawn end on Synapses Between and the queried
  neuron's role on Synapses. A first version dropped `pre` rows and with them every synapse on the
  recommended wiring. Hence Synapses to Edges' controls, shared (`orientationParams`, `rowFlips`).
  `Presynaptic` may be None, which lumps every synapse into one partner `-`, and any column names
  partners — `name` on points placed by hand, `strahler` to fire tips and trunk apart.
- **Several synapses on one compartment are that many times the conductance**, never one synapse.
- **Two synapse sockets, one mechanism each** (`synapseParams.ts`): `Synapses (exc.)` and
  `Synapses (inh.)`, each with its own tab, pickers and mechanism, since the two wires may come from
  different nodes. Four rules. **The excitatory socket keeps its old ids** (`synapses`, `gmax`,
  `tau1`, …) and a fresh `synapsePreset` defaults to Custom, so a graph from before loads with its
  wire and its numbers; the inhibitory ids are the same names prefixed `inh`. **A sign is the
  socket, never read off a reversal**: `synapseTypes[0]` is excitatory and `[1]` inhibitory, always
  both, and `synapses.type` points into them. **A partner on both sockets is one partner**, firing
  as one, each synapse with its socket's mechanism (co-transmission, or a per-synapse transmitter
  prediction that disagrees); `partners.inhibitory` counts its share, `partnerSign` reads
  `excitatory`/`inhibitory`/`mixed` from it, and the card counts such partners. **A note names its
  socket** wherever the inhibitory one is wired; an excitatory cloud alone reads as it always did.
- **Synapse presets are sourced as membrane presets are** (`synapsePresets.ts`), each number read in
  the paper: ORN→PN nicotinic (Gouwens & Wilson 2009, g max from Tobin et al. 2017), fly nicotinic
  in culture (Lee & O'Dowd 1999), PN→KC nicotinic (Turner et al. 2008's EPSC, not its 2.1/11.5 ms
  somatic EPSP), GABA_A (Lee, Su & O'Dowd 2003's kinetics, Groschner et al. 2022's −68 mV, their
  culture's −41.5 mV being the culture's chloride) and glutamate/GluClα (Groschner's −71 mV,
  **kinetics borrowed from GABA_A**: none are published). A rise time is Exp2Syn's τ1 **solved**
  from the measured 10–90% rise against the decay (0.61 ms over 2.1 ms is τ1 0.64), not the rise
  itself. A preset sets **g max only where its source states one** (ORN→PN) and never the delay.
  Mixing sources or borrowing a number is allowed where the source line says so. Not presets:
  Shiu et al. 2024 is current-based (no reversal), and Warren & Kloppenburg 2014's −110 mV is a
  slow GABA_B potassium response.
- **Channels are a list on the card**, edited in the expanded view (`channelRows.ts`,
  `ChannelsEditor.tsx`): a channel, the regions it sits on (none is everywhere), a density in
  mS/cm² or a **total per cell** in nS spread over those regions by area (Vieira et al.'s Fig. 1B
  comparison), and ΔV50 shifts by gate role (`shiftedChannel`; `gateRole` reads `h` as
  inactivation). The squid HH soma is a one-click preset of two rows; it was an `Active soma`
  switch with its own gNa/gK before. Regions are named by `compartmentKey` — a computed split
  (`split`) where the skeleton has one, the SWC codes otherwise, basal and apical both `dendrite` —
  so `axon` means the same whichever labelled it. **There is no axon-terminal region** (decided for
  v1.5): a channel on the axon covers the terminals, unless they are painted. A region the model
  lacks and unlabelled cable that region-placed channels skip are both said on the card.
- **Regions can be painted** (`regions.ts`, `RegionsEditor.tsx`, the expanded view's Regions tab):
  the split editor's gesture — everything distal of a clicked point, or everything else — under a
  name, an existing region's or a new one. Four rules. **Strokes paint over, later wins**, over each
  other and over the skeleton's labels, so a compartment is in exactly one region and a channel row
  stays a set of regions rather than growing a compartment mask (the plan's "one value change",
  not needed). **Anchored by position with their root**, through `placeStroke` and `fillScope` —
  the landing and the painting split corrections use, generalised from three codes to any — so a
  re-fetch that renumbers keeps them, and one landing nowhere is counted on the card and **adds no
  name**: a stale stroke naming an empty region would let a channel placed there cover no membrane
  in silence. **The soma node is found from the skeleton's own labels**, the cable taking the
  painted ones, so painting relabels the soma's membrane (its section takes its node's painted
  region) without moving its centre — though what it replaces is the painted `soma` touching it
  (above), which is why `soma` is not offered for a rename; an *added*
  soma is no node's and stays `soma` whatever its root was painted. And **both
  tabs read `modelRegions` over the wired skeleton**, the function the build calls, so a region
  is in the channel list the moment it is painted, before any run. A rename reaches every stroke of
  that name, any neuron's, and every channel row placed on it — names are shared across neurons as
  rows are, in one commit (`setParams`). The two editors share the stroke reader (`readStrokes`), the scope words and
  `positionOf`.
- **The library is the squid HH and Jaxley's Pospischil Na/K.** The Pospischil gates are
  transcribed from `jaxley.channels.pospischil` and held to Jaxley's own run of one compartment,
  spikes included, at **5 × 10⁻⁸ mV** (`pnpm biophys:jaxley` writes the fixture; Jaxley 0.14.0 in a
  virtualenv of its own). Jaxley's `efun` answers NaN at its removable singularities (m's α at
  −47 mV, β at −20 mV); ours fills them with the limit. **Vieira et al.'s fly channels are not
  here**: their Zenodo record (10.5281/zenodo.20752905) holds their raw voltage-clamp recordings, not
  the fitted models, and the paper states only Para's V50s.
- **Günay et al. 2015's are (decided 2026-10-18): the first fly channels.** NaT (para), NaP, Ks
  (Shab) and Kf (Shal) of the larval aCC motoneuron, fitted to voltage-clamp recordings from fly
  neurons, as a third kinetics kind, `fitted`: a Boltzmann steady state and a time constant that is
  constant, sigmoid or exponential in voltage. **From the paper's Table 5, not their code**: the
  paper is CC BY 4.0, the ModelDB repository (152028) carries no licence and stores its time
  constants as 1,501-point `KSChan` tables, which Table 5 states as the formulas they were sampled
  from — so nothing tabulated was copied and the solver needed no table gate. Three choices, each on
  the spec's comment: the reversals are their reconstructed model's (65 / −74 mV; their isopotential
  model used −80), no Q10 (none stated), and Kf has the one inactivation their table and code have
  (their text mentions a second, slow one). Densities start at their reconstructed model's axon
  (Table 4: NaT 180, NaP 0.0001, Ks 400 mS/cm²), where a new row goes; Kf, absent from that model,
  at Ks's 400 scaled by their isopotential model's Kf : Ks (24.1 : 50 nS), said in its
  `densitySource`.
  **Held to NEURON** by `branched-fly-channels` in `neuron-reference.json`, NEURON running `.mod`
  files **generated from the specs** (`src/biophys/modFile.ts`, `pnpm biophys:mods`, which
  `biophys:reference` runs first; `modFile.test.ts` refuses a committed file that differs), so Table
  5 has one transcription and NEURON runs it: 4 × 10⁻⁶ mV over two spikes — the soma at their
  whole-cell densities and the axon stub at their axon's, two groups naming the same channels, which
  NEURON is handed summed per mechanism — with Kf at the same derived density as the editor's. The
  case ends at 35 ms, before a third spike (37 ms) that creeps up on threshold after the clamp ends,
  where a slow crossing turns float rounding into timing (2.7 × 10⁻⁵ mV on such an upstroke, a shift
  of 1.5 × 10⁻⁷ ms). nocmodl refuses a non-ASCII byte anywhere, comments included, which the
  generator's test checks. **The `.mod` files hold no reversals** either: `neuronExport` sends each
  mechanism's from its `ChannelSpec`. The harness compiles them only when a case places one (passive
  and HH runs need no C compiler), rebuilds them when a `.mod` is newer than the library or the
  library was built by another NEURON (`.neuron-version` beside it), refuses a library NEURON will
  not load, and names a channel with no `.mod` rather than letting NEURON refuse a string. The
  generator writes a file only when its text changed, since a new mtime is what triggers a rebuild.
- **A new fly row is their model's axon (decided 2026-10-18/19).** On the axon (`ChannelOption.regions`),
  at that axon's densities (Table 4 "Recon. axon only": NaT 180, Ks 400, NaP 0.1 µS/cm²; Kf, absent,
  Ks × 24.1/50). Their NEURON session confirms Table 4's units (`gmax_DmNaT` 0.03 S/cm² whole-cell).
  Why not the whole cell: NaT's window current (m V½ −29, h V½ −47) is large, and placed everywhere
  it keeps a weak-leak cell firing on its own — the PN and Vieira presets fire at a few Hz from about
  −56 mV, where the CT1 and T4 presets rest near −60 mV. **An I–V root is not a rest**: a first
  version said the cell "sits at −34 mV", which is where the steady-state current crosses zero on
  the PN preset, a fixed point the cell never stays at; a run checked that. The text now names no
  voltage. A row at its channel's own placement takes the next channel's when switched, a row placed
  by hand keeps its own, whichever order the channels were chosen in; a switch resets the ΔV50s. The
  editor's step is the order of the starting density, fixed per channel: one read off the row's
  value shrank tenfold per decade on the way down and never reached 0.
- **Settling waits for the gates too**, not only the voltage: NaT h carries little current at rest
  while its τ runs to hundreds of ms, so the voltage stopped moving while sodium availability was
  still relaxing. The warning for a cell that never settles says it may be firing on its own.
- **Every gate is held to their code**, not only to `.mod` files generated from the same reading of
  Table 5: `channels.test.ts` compares each steady state with their `KSChan` sigmoid and each τ with
  their table at five voltages. NaT's m τ alone differs, by 2.4% where it bottoms out — the paper's
  caption says its NaT time constants differ slightly from the earlier published set.
- **Kf inactivates fast and recovers slowly**, as Table 5 has it and as their own `KSChan` table
  agrees to every digit: τh is about 5 ms at 0 mV and 14 ms at −40 mV, but 34 ms at −70 mV and 85
  ms at −100 mV. The first description of it said it "inactivates over hundreds of milliseconds", which
  is its recovery near rest, not its inactivation; `channels.test.ts` now holds τh to their table.
- **Presets are published models, and every deviation is on the preset.** Four ship: **Drosophila
  PN** (Tobin et al. 2017 after Gouwens & Wilson 2009), **Fly visual** (Meier & Borst 2019, CT1),
  **Fly optic lobe** (Vieira et al. 2026, T4/T5) and **Fly T4** (Gruntman, Romani & Reiser 2018,
  ModelDB 239435: Rm 100,000 Ω·cm² and Ra 100.07 Ω·cm fitted, E leak their −65 mV, Cm NEURON's
  default since their code sets none — so 1 µF/cm² is what their model ran, said in its `source`).
  The PN preset is **held to Gouwens & Wilson's own NEURON model** by `pnpm probe:gouwens` (below). A source must state Rm, Ra and Cm; the leak
  reversal may be missing (a model in voltage relative to rest states none), and is then −60 mV,
  said in the preset's `source` and its comment. The optic-lobe set carries two further notes: their
  2.6 µm soma is `Soma diameter`, not the preset, and their Fig. 1 HH model used a leak of 25
  µS/cm² rather than 1/Rm. Under a preset the four numbers are hidden, so the key sees the
  preset's id.
- **One neuron.** Several on the wire are refused, naming Select One and For Each.
- **The geometry is memoised per skeleton and cloud**, the node being `cheap` and none of that
  work depending on a param. Every note rides on the value, so a cached result says what the run
  said.

- **From the audit (2026-10-13)**, rules a reasonable change would undo:
  - **The soma is read before `Smooth radii`, and kept out of it.** Smoothed first, a 6 µm soma
    averaged with its fibre came out 3.87 µm (2.4× less membrane) and the fibre's first nodes
    swelled from 300 nm to about 1.3 µm — the shoulder `startRadius` exists to prevent.
  - **A region with no membrane is missing**, whatever names it: `resolveChannels` asks each
    region's area on the built cable, not the names table, which the skeleton fills from every
    node — fragments the build drops included — so a channel on an axon that arrived as a separate
    fragment used to land on nothing in silence. A channel id this build lacks is said here too.
  - **A cable with no membrane anywhere is refused** (a lone root, no Soma diameter): the solver
    would divide by zero and every trace come back NaN. The bare root of an ordinary cable has
    none of its own and is fine.
  - **The soma section points at the first fibre node not on the soma node**, a duplicated root
    otherwise giving it no direction and no length.
  - **Custom is any id that is not a preset**, the reading `evaluate` takes, so an unknown preset
    keys on the four numbers it is built from (invariant 4).
  - **A rename is one commit** (`setParams`, through `onParamsChange`), strokes and channel rows
    together, so one ⌘Z cannot leave the rows on a name nothing paints.

- **From the second audit (2026-10-13):**
  - **Two coincident nodes are an annulus.** `integrate` skipped a zero-length piece without moving
    its radius on, so the cone after it ran from the radius *before* the duplicate — or from its
    own, wherever a segment cut fell — and one compartment differed from NEURON by 95 mV where
    seven differed by 6. Now the annulus π|r₁²−r₀²| is membrane, as NEURON's pt3d counts it,
    **belonging to the integration that ends at its point** (NEURON's rule where a cut falls on
    one; the third audit found the opposite here) and, at a section's very start, to its first —
    so a pair inside a section, at a cut, at either end or beside a branch point is counted once.
    Eight reference cases (`duplicate-node-*`) hold every placement to NEURON.
  - **A pairing that cannot tell inputs from outputs is refused** (`socketRefusal`): both pickers
    on one column — a neuPrint or CATMAID Synapses cloud, which has no partner column, `resolveColumn`
    rule 3 handing Postsynaptic `neuronId` too — turned every synapse, outputs included, into an
    input; and Polarity with no Presynaptic column emptied every swapped row, trading inputs and
    outputs. Both on the card at edit time, and in the build.
  - **One note for channels with nowhere to sit**, the missing-region one, with the soma's own remedy
    (Give a Soma diameter); the separate soma note fired even where a painted `soma` carried them.

- **From the third audit (2026-10-13):**
  - **Every fibre is wired to the soma's centre** (NEURON's soma(0.5)): the soma section is laid
    along the first fibre and centred on the soma node, which becomes a junction cutting it in two
    halves. Wired to one end before, a fibre leaving another way crossed an invented bridge of thin
    cable — about 75 MΩ for 8 µm at 0.3 µm — that is in no skeleton. `soma-centre` holds the
    geometry to NEURON. The soma's compartment is the half ending at the centre.
  - **A section's first piece takes its own node's label**, never the junction's, which belongs to
    the parent section: by nearness, a long first edge out of a labelled soma came out soma — and
    under Fixed length took soma-only channels. On the probe's HH case this moved the soma's peak
    from −9.8 to −35.8 mV, the HH channels having sat on the fibres' first compartments too.
  - **Presynaptic None under fixed orientation is warned on** where the cloud has a polarity column
    holding outputs: right for points placed by hand, wrong for a Synapses cloud, and the columns
    alone cannot tell which. The one-column refusal names both remedies.
  - **Jaxley holds a branched Pospischil cable with every gate shifted +5 mV** to 5e-9 mV
    (`jaxley-reference.json`'s `branched`, Jaxley's shared `vt` raised to −55): the shift's sign,
    checked from outside. The opposite sign is 115 mV out.

## The run

- **A run starts at rest.** No `v_init`: a model with channels settles first, and the settled state
  comes back with the result to be handed to the next job at that `dt` (`keepRest`), a worker
  keeping nothing. navis starts at −65 mV under a −60 mV leak and every run opens with a drift that
  reads as a response.
- **A run that does not end at rest says so** (`unrestedNote`). An active model with too little
  potassium for its sodium has a second stable state — one PN with an AIS at Na 200 / K 10 mS/cm²
  fired once and sat at −25 mV, holding the dendrites at −27 mV while the axon fired on its own
  for the rest of the run, and every trace read as a long response. The note names the compartment
  furthest from its rest, and only once the last input and any clamp ended **three membrane time
  constants** before the end, so an ordinary slow tail is not mistaken for it, and never after a
  settle that did not converge, which leaves no rest to measure from. Rest is `restOf`, the one
  definition the job's own deflections use; the potassium hint is for a cell stuck **above** rest
  only. The run's last voltages ride on the result (`final`) for this. Not done: Rm·Cm is the
  leak's time constant, and an active model with slow gates can take longer than three of them to
  recover, so a slow recovery may be named as a stuck one.
- **One train per partner, seeded by its id**, so ticking another partner does not move this one's
  spikes. NetStim's vocabulary (`start`, `number`, `interval`, `noise` 0–1) plus `Seed`. The seeded
  generator is `nodes/lib/tableOps.seededRandom`, which is why the stimulus lives in the pack.
- **Who fires is a silenced list** (empty = all fire), edited by the Partners tab; a silenced id the
  model lacks is counted and named.
- **`Fire` = "the top N by synapses"** fires only the N strongest of the partners not silenced
  (`firingIndices`, one rule for the run and the Partners tab's count). It exists because every
  partner at once saturates a real neuron: on hemibrain DA1 PN 1734350788 the defaults drive the
  soma to about −10 mV, near the synapses' reversal, and the arbour reads one flat colour. The
  wizard builds Simulate Model on the top 1. A setting rather than a silenced list written by the
  wizard, because the wizard builds before any partner is known.
- **Record sites** are the soma plus an optional point cloud, each placed by the synapses' rule
  (`placePoints`); far and off-piece points are counted.
- **The per-partner summary** runs every firing partner alone, recording only the soma and its own
  synapses, whose peaks and troughs the solver keeps every step (`recordPeak`, `recordTrough`). A
  peak is **signed**: the larger of the rise and the fall from rest, so an inhibitory partner reads
  as the hyperpolarisation it causes rather than as zero, and soma / local is a positive share for
  two falls as for two rises. A partner that did not run alone has empty cells, not zeros. The solver walks only the synapse slots an event reaches, so a solo run costs a
  handful of slots.
- **Two spike tables, named by side.** `Input spikes` (input port and output) is the drive and
  `Output spikes` the cell's threshold crossings; the input was "Spike table" and the output
  "Spikes", opposite things under one word. The **Input spikes output** is the run's own firing,
  seeded trains included, in the columns the input port reads by default (`partnerId`, `time`,
  plus `partnerType` and `arrival`), so wiring it into another Simulate Model replays the drive.
  Arrival is read from `partnerDelays`, kept per model: a partner's first delay for that output, and
  each distinct delay for Playback's ticks (`inputArrivals`).
- **Spike threshold defaults to 0 mV**: a fly's somatic spikes arrive attenuated.
- **The Arbour output** is the model's skeleton with each node's compartment peak
  (`peakVoltage`, declared in the pack's `nodeValues.ts` and merged into the 3D View's list); NaN off
  the modelled piece. It is a new value, never values written onto the model, which is the input
  to every run. Recording peaks costs about 6% of a run.

- **Two more from the audit.** **A partner whose spike reaches none of its synapses before the
  summary window ends is unmeasured** — empty cells and a note, not peaks of 1e-10 mV whose ratio
  read as "reaches the soma undiminished" — and an attenuation needs a local change of at least
  1 µV (`MEASURABLE_MV`). **Traces are refused past `CRASH_FLOOR_BYTES`** before the run
  (`traceBytes`: record sites × samples × 8 bytes, twice, the worker's arrays and the page's
  table): two independently set numbers multiply there, and the time warning, on compartments ×
  steps, sees neither. A worker that dies after reporting progress is now said to have stopped,
  most likely out of memory, rather than "Coda has been updated, reload".

- **More from the second and third audits.** **A response whose soma extreme falls on the summary
  window's last step is unmeasured** — still rising when the window closed: a window ending one
  millisecond after the spike arrived reported 35% more attenuation than the real answer. Asked of
  the extreme's **time** (`recordPeakAt`), not its size: a first rule, "still at 95% of its peak",
  also cut slow responses that had peaked and were decaying. **Trains stop where a spike would no
  longer arrive before the end** — its time plus the partner's shortest delay (`partnerTrain`'s
  `until`) — and a table's are cut there; such a spike cannot reach the run, Input spikes and Playback's ticks no longer list it, and the "not back at
  rest" note no longer counts it as drive — at 1,000 spikes over 100 ms, 99% of the events had
  fallen off the end. **Events are checked against the crash floor** before the run (spikes ×
  synapses × `EVENT_BYTES`), a train drive's from its shape **before** the trains are built.
  **Input spikes is one row per spike**, `arrival` its first: a row per delay was read back as that
  many spikes, doubling a two-delay partner's drive on replay. **Settling yields** on the page's own
  thread (`settleSliced`), so up to two seconds of it can be cancelled. **`traceBytes` counts the time column.** And a worker says `started`
  on receiving its job, so one that dies of memory before its first progress is no longer told to
  reload. The solver itself refuses a cable with no membrane, for callers other than the build.

- **Current injection is the Clamp tab generalised, not a Drive** (decided 2026-10-16): a shape
  (step, ramp, sine, pulse train) at any record site, picked by name. Not a fourth `Drive` because
  Drive is exclusive and a clamp is not — injecting while partners fire is the ordinary case — and
  because `Clamp the soma` already existed: `clamp` keeps its id and `clampSites` defaults to
  `soma`, so a graph from before injects where it did. **Start + Duration, not Start + Stop**:
  IClamp's own `del`/`dur`, and a Stop param could not have carried a saved Duration across. **One
  waveform for every ticked site**, a clamp per **compartment**, two names on one compartment
  injected once and said; a name no site has any more (a `Record at` point gone, a trace renamed)
  injects nothing and is said too, since dropping it silently looks like a weaker cell.
- **The sites are picked in the full view's Sites tab, not the inspector**, because a `Record at`
  site is named by its label column's *value* and a param's options see only schemas. The tab
  reads `runRecordSites`, the run's own list, so a ticked name is the compartment the run injects at;
  ticking while off turns injection on there in one commit, unticking the last turns it off.
- **A shape is read at the half-step time, and the solver precomputes it** (`clampWave`): NEURON
  evaluates an IClamp's current at `t + dt/2`, so a NEURON IClamp whose `amp` is set before every
  step to the waveform at that time is the same run, which is how `biophys_neuron.py` drives one
  (`clamp_current`, written from the shapes' definitions, not from our step counting). Pulses
  switch on and off by `stepAt` as separate step clamps would, and the test holds them to that.
  `branched-shaped-clamps` puts all three on the spiking arbour at once, every edge off a half step.
- **One per-step rule for the current, `clampCurrent`, read by everything that shows it**: the run
  (precomputed per clamp), the Traces output's `injected` column (nA, the step starting at each
  sample), Playback's strip under the traces, and the Clamp tab's preview. One column, not one per
  site, the waveform being shared. The strip reads the clamp from the **plan that made the movie**
  (the clamps are in `movieBasis`, so a served movie's are the card's), and is the chart's own
  `Line`, decimated as the traces are. The preview is `ViewerEntry.tabFigures` on Simulate Model's viewer
  entry — a drawing under a sidebar tab, on the per-type table that already exists rather than a
  second one, its keys swept against the node's tabs — and folds the run into columns by each
  column's extremes (`clampEnvelope`, asking only the steps inside the clamp's window), sampling
  being what loses a pulse narrower than a pixel. **The column is decided from the params, not the
  last run**: inference takes the site names from the observed schema (its `mV` columns) and the
  `injected` column from `Inject current` now, both through `injectedColumn`, so ticking it reaches
  a picker downstream before the next run, by the name the run will give it.

## Playback

- **The movie is computed on demand, not kept.** It is compartments × frames of float32, tens of
  megabytes on a large model, and nothing else reads it. Opening Playback replays the main run in
  a worker with every compartment recorded (`runMovieJob`); the trains are seeded and the rest is
  kept, so the replay is the run. `mainRequest` builds both runs' requests, so they cannot drift.
- **Frames at the card's own `Sample every`**, so the movie is as fine in time as the traces. It was
  a fixed ~400 frames first, which put a frame every 0.25 ms on a 100 ms run and hid the one moment
  a compact arbour is *not* uniform: the first few hundred µs at a synapse. Past
  `MOVIE_BUDGET_BYTES` (128 MB, a quarter of `CRASH_FLOOR_BYTES`) the frames are spaced as little
  further apart as fits (`movieFrameSteps`), and the view says so; nothing is refused.
- **Movies are cached weakly, up to `KEPT_BYTES`** (two at the per-movie budget), keyed on what
  the movie replays — the model, weakly, then the job's `movieBasis` — so a rebuilt or dropped
  model takes its movies with it. It was keyed on the card's `traces` value first, which put the
  record sites in the key and replayed an identical movie after a click and a Run. Bounded by bytes rather than by count,
  so the views on screen (pinned and expanded, a few dashboard cells) do not evict each other's,
  each eviction being a whole every-compartment replay; past the budget the **least recently played**
  go first, each kept while it fits (a read refreshes it; a small movie survives a large one).
  A strong `Map` of two was tried and kept deleted nodes' movies alive. **Only an `ok` card makes
  one**: a stale one's params are not its run's, and a running one's output is still the last
  run's. A stale card plays one already kept for its model and basis, below.
- **One colour scale for the whole run**, never per frame: a per-frame scale makes every frame look
  equally eventful. **"From rest" is the default** (made so 2026-10-13): sequential, colouring each
  compartment's **rise above its own rest** (its frame 0) up to the run's largest, because on the diverging scale a few-mV EPSP and a 10–20% difference between two
  branches are a sliver of a ramp spent half on hyperpolarisation, and read as one colour. Its cost
  is that anything below rest takes the lowest colour, so an inhibitory input's fall is invisible
  there; "about rest" (diverging) is the scale for that. **Its own rest, not the soma's**: a model
  with channels does not settle uniform (the HH soma preset leaves the dendrites 0.14 mV above the
  soma), and measured from one rest that gradient was the whole ramp, resting dendrites in the peak
  colour through an inhibitory run. With **nothing risen** the scale is held at 0, every
  compartment the lowest colour, and the controls say to choose "about rest".
- **The colour scale is centred on where the run started** (the soma's frame 0), not E leak, which an
  active model does not rest at. **Opening before a run is an opt-in** (`opensBeforeRun`)
  rather than implied by `withoutValue`, which also put ⤢ on unrun Dataset Summary, ROI Viewer, 3D
  View and Graph Metrics cards that open on "No result yet".
- A tick colours compartments, not nodes (`frameColors`); both views look up through
  `nodeCompartment`. Clicking a branch adds that compartment's trace (`rootNodeFor`'s nearer-end
  rule), marked on the dendrogram in its line's colour; a second click or ✕ removes it.
- **Added traces are kept on the node**, as positions on the neuron with a name (`TRACES_PARAM`,
  the `ManualPoint` shape, `internal`), so a re-run, a rebuilt model or a reload keeps them. They
  are placed on each model by the click's own rule (`placeTraces`, in `simulateOps.ts` so the run
  and Playback share it); one that lands nowhere — another neuron's, off the cable, at the soma —
  is counted on the controls. A name is never reused (`nextTraceName`), and labels are made
  unique, being table columns.
- **They are record sites, so a column each of the Traces output** (decided 2026-10-16). They were
  presentational first, drawn from the movie alone, and a user found the output held only the
  soma. In the key, a click makes the card stale until the next Run — so **Playback keeps playing
  a stale card's movie where nothing a movie shows has moved** (`movieBasis`: the job minus
  record sites, threshold, settled rest and summary — named as what is *left out*, so a field added
  to the job counts by default), or every click would have taken the movie away with it. Anything
  else that changed still asks for a Run. Playback draws the run's own placement
  (`RunPlan.traces`, handed over by `useMovie`) rather than placing them again, so a line and its
  column carry one name — a second placement named them against different columns once.
- **The trace plot under the scrubber can be hidden** (`showTraces`, Playback's `Traces` checkbox),
  because with the traces in the output a Line Chart wired to it draws them better. A param rather
  than view state, so the layout survives a reopen and a reload; `presentational`, a layout
  changing nothing a run returns. The clicked traces stay clickable while it is off, being record
  sites as much as lines.
- **`Inputs` marks the fired partners' synapses where they sit**, as ticks on the dendrogram and
  points in 3D (`sitePositions`, on the cable, the model keeping no cloud positions). The model value carries each
  synapse's `sites` (node, edge start, share along it) for this, a compartment being tens of µm
  long; `solverPart` leaves them out of the worker's copy. The line chart ticks the time axis
  where the inputs arrive (spike plus synaptic delay, `inputArrivals`), through the chart's
  general `xMarks`.
- **`Radius`** draws branch widths from the radius on both views: the 3D view's `radius` width
  mode, and on the dendrogram `radiusWidths` (`arborPlot.ts`), the Neuron Dendrogram's rule lifted
  out of it so the two cannot drift — p95 radius at twice the line width, clamped, quarter-pixel
  steps. Session state, like the colour scale and the speed.

### A table of current (decided 2026-10-18)

Simulate Model's `Current` socket takes a table of injected current: a recording's command, noise,
or breakpoints. Four rules, each put to the user:

- **Held, not interpolated**, onto the run's steps (`held` in `resample.ts`, read at each step's
  half-step time, where every clamp is read), and played as a `samples` clamp of 1×. A command is a
  level held between samples, so linear interpolation would invent a ramp at every step. Any spacing
  works; nothing is injected before the first row or after the last row plus one sample.
- **Into the soma, or the site a row names** through an optional site column; a name no record site
  has injects nothing and is said. Two names on one compartment add.
- **One main run per sweep**, all from the same rest (`SimulateJob.sweeps`, `sweepClamps`). The
  Traces and Output spikes tables gain a `sweep` column whenever the sweep picker resolves, even
  for one sweep, so inference states the schema before a run. The Arbour is the peak over every
  sweep; the per-partner summary runs once; Playback replays the first sweep and says so, its movie
  basis hashing that sweep alone. An empty table is one run with no current, said, never a run of
  no sweeps; a table ending on a non-zero current is said too, its last row being held one step. Traces stay wide over
  sites and go long over sweeps, which is what a Line Chart's Series and Fit Model Passive read.
- **It adds to the Clamp tab's current**: the solver sums every clamp on a compartment, so a
  holding current and a recorded command are two clamps.

The `injected` column is the current into the first record site that takes any (`injectedCompartment`). The
Clamp tab's waveform is one for every ticked site, so that column was all of it; a table naming
several sites is now summarised by its first. The current is read by unit through `unitColumns.ts`,
shared with Fit Model Passive: a picker lists only columns in pA or nA, and an unset one with two
candidates is asked rather than guessed; the column-scale rule (`columnScale`) and the walk that
groups a long table by sweep (`rowsBySweep`) are shared with it too, so one recording splits into the
same sweeps on either card. **Each table clamp spans only the steps carrying current**, trimmed at
both ends, so its window says when its current stops as any clamp's does: the "not back at rest"
note (run per sweep) reads that window, where a clamp padded to the whole run would never let it
speak. And a typed array is hashed over its bytes (`stableStringify`), the held currents riding in
the job that Playback's movie basis hashes on the page.

## Recordings

Load Recording and Combine Traces (decided 2026-10-17) put a patch-clamp recording beside a
simulation.

- **One node for every format, a reader per format** (`data/ephys/recording.ts`). Every reader
  fills one `Recording` — sweeps of equal length, channels and commands with a name and a unit, a
  rate — and is chosen by the file's **signature**, the extension only naming what an unrecognised
  file was probably meant to be. HEKA PatchMaster and NWB would each be one entry in `READERS`, so
  a workflow built today reads them the day they exist, with no node and no migration.
- **The ABF2 reader is a port of pyABF** (MIT), layouts, scaling and stimulus rules, so a number
  read here is the number most people check a file against. `pnpm probe:abf <file>` holds the two
  side by side; on the first real file (an MBON I–V, 12 sweeps × 32,000 samples, two channels) every
  recorded sample agreed to float32 rounding (7.6e-6) and the rebuilt command exactly. **No recording
  is committed** — it was a colleague's data; the unit tests build ABF2 files byte by byte instead.
- **The command is rebuilt, not read**: ABF stores the waveform as an epoch table, and the rules are
  pyABF's — the first sixty-fourth of a sweep at the holding level (or, when the output keeps it, the
  last sweep's final level), then the epochs with their per-sweep increments, then holding again.
  Only outputs whose waveform is enabled and drawn from epochs become columns; a waveform played from
  a stimulus file is not in the recording, so it is said rather than drawn flat.
- **The file is stored, not a table** (`uploads.ts`, a third kind beside tables and meshes), and read
  every run: the channel, sweep and window controls decide the table, and changing one must not mean
  picking the file again. The summary stored beside it is what inference and the channel picker read
  synchronously — Upload Table's peek. Its cost is Upload Table's too: a shared workflow arrives
  without the file. Being `cheap`, the node reads through `storedRecording` (`data/ephys`), which keeps
  the **recordings read, within a byte budget** (a quarter of the crash floor; a parsed recording
  holds its whole file, so a count would not bound it), a read counting as a use and the newest
  always kept — so a recording and its control do not evict each other; the card hands over the
  one it has just parsed, and overlapping runs share one read, or every
  keystroke in Sweeps read the file back out of IndexedDB and parsed it again; a channel is
  decoded **only over the window** asked for, a short crop of a long gap-free file being the case;
  and the crash floor is asked of the summary and the controls, so the card says it before a run.
- **Long, not a column per sweep**: `t`, `sweep`, a column per channel and command. A protocol's sweep
  count is the file's, and the Line Chart draws a line per sweep from `Series` as it is. Downsampling
  **averages** blocks (timed at their middle, so a trace never shifts), keeping noise from aliasing at
  the price of blunting a spike narrower than the block. Not read: ABF1, variable-length event mode,
  digital outputs, tags.
- **ABF1 is a port of pyABF's `HeaderV1` and `_readHeadersV1`** (decided 2026-10-18): a fixed
  header at set byte positions, the samples and the epoch table as ABF2's, so the command is rebuilt
  by the same `commandWaveform`. pyABF's readings are kept where they are what a value is checked
  against — the rate truncated to whole hertz, the ignored points added to the data start as bytes,
  an output's holding level taken from its first epoch's level — and its string decoding is not,
  `µ` reading as `u` as in ABF2 rather than being dropped. `pnpm probe:abf` agrees with pyABF on all
  eleven ABF1 files in pyABF's own test data, samples to float32 rounding and commands exactly; it
  now compares samples relative to their value, pyABF scaling in float32.
- **NWB is read through h5wasm** (`data/ephys/nwb.ts`; decided 2026-10-18), HDF5 compiled to
  WebAssembly, loaded on the first NWB file through `data/libraries.ts` and external to the MCP
  bundle (4.8 MB in a chunk of its own). The reader is asynchronous now; the file is copied into
  h5wasm's memory file system, the chosen group's samples copied out, and the file closed.
- **A file is read as groups, and a group is a shape, not a description.** Every public file
  measured holds several protocols at different rates and lengths (an Allen file 13, from 7,650 to
  980,000 samples, at 50 and 200 kHz, voltage and current clamp), and a `Recording` is one rate and
  one sweep length. So `protocols` lists the sweeps sharing an electrode, a series type, a unit, a
  rate and a length, each named by the `stimulus_description` they share — but grouped by shape,
  because a writer may give every sweep a description of its own (DANDI 001261: fourteen). Load
  Recording's `Protocol` picks one; a group's sweeps carry the file's `sweepNumbers`, which the
  table's `sweep` column and the Sweeps field read.
- **Pairing a response with its stimulus is by sweep number and electrode**, a number counting only
  where it reads as one (a one-element array does not). A file numbering no sweeps (DANDI 001789,
  NWB 2.9) pairs in the order the file lists them — only where both lists are as long, one missing
  stimulus shifting every pairing after it — said, and its groups count their sweeps from 1. A
  stimulus at another rate or length than its response is no pairing at all: indexed by the
  response's samples it would draw the command shifted against the voltage. Start times cannot
  pair them: writers leave every series at 0. A series timed by `timestamps` has no rate and is set
  aside and counted, never a table of NaN times.
- **A group reads windows, not sweeps.** The HDF5 file stays open in h5wasm's file system while the
  recording lives and closes when it is collected (a `FinalizationRegistry`), so a sweep is decoded
  only as far as Sweeps and Crop reach, after Load Recording has checked the table's size against
  the crash floor. The stored-recording budget charges the file's size. Group names are unique,
  numbered where shapes round to one wording, or a later group could never be picked.
- **Read in mV and pA**, and a trace whose values no cell gives is said, never corrected: three of six
  public files measured carry a converter's unit error (mV stored under a pA conversion, mV as volts,
  pA as amperes). `pnpm probe:nwb <file>` holds every group of a file to pynwb, sample by sample;
  all six agreed to float32 rounding (relative 6e-8).
- **Combine Traces interpolates, and never past an input's own range**: a recording and a simulation
  share almost no sample time, so Join cannot line them up. Linear onto one grid (the first input's
  times, the finest step, or a fixed one), a **shift** per input to align stimuli, nothing
  extrapolated (numpy's `interp` holds the end value, which is why there is no emitter yet), and no
  interpolation across a gap. An input that names a time twice within a trace is said — the shape
  of a long table not spread into its sweeps, which would otherwise draw every sweep interpolated
  across one another. Each input is grouped by sweep and put in time order **once**, for
  every column (no sort at all for a table already in order), and the grid is walked beside each
  trace. A long input is **spread** into a column per sweep, which makes the
  columns a fact about the data: the node observes its schema then, as Pivot does. A column two inputs
  share takes each input's label in front, decided on the **source** column's name — a simulated
  `soma` beside a recorded `soma 1` is one measurement, and the name has to say whose.

## Fitting

Fit Model Passive (`fitModel.ts`; method in `fit.ts`, optimiser in `biophys/leastSquares.ts`) fits a
Compartment Model's passive membrane — Rm, Cm, Ra, E leak and an area factor — to a current-clamp
recording, and Apply writes the answer back into the card it came from.

- **The model is rescaled, never rebuilt.** The membrane reaches the solver as a leak density, a
  reversal, a capacitance and axial conductances that scale as 1/Ra, so an evaluation rescales those
  on the compartment tree the model was built with. The fitted `Model` keeps that tree, and the card
  says when the fitted length constant has shrunk past what its compartments were cut for.
- **Each sweep gets the current the cell got**: its command replayed sample by sample (`ClampShape`
  `samples`, held to NEURON by `branched-sampled-clamp`). A passive response is linear, so sweeps
  whose commands are scaled copies — an I–V's steps — share one simulation. A model with channels is
  fitted as its passive copy, which the node's name says; the card speaks of the channels only
  where a fitted area factor changed what they carry (`channelAreaNote`).
- **Bounded Levenberg–Marquardt in log space** for the positive parameters, with an active set: without
  it, Ra ran onto its bound and the fit crept along it to the iteration limit (133 s against 37 s on
  the user's MBON, the same answer). The finite-difference Jacobian runs over a worker pool kept for
  the fit (`fitPool.ts`). Standard errors come from JᵀJ at the optimum, and a bound reached, a loose
  parameter and a traded pair are each a sentence on the card.
- **Area, Cm and Rm cannot all be free**: the model sees only Cm·F and F/Rm, so a fit freeing all
  three is refused with the fix named.
- **An unset voltage or current picker is asked, not guessed**, when several columns share the unit:
  a Clampex file records the current monitor in pA before the command, and fitting the monitor gave
  a plausible RMS for nonsense.
- **The electrode's seal is a parameter (decided 2026-10-18)**, after Gouwens & Wilson 2009: a
  whole-cell recording adds a leak at the soma to 0 mV, and left out of the model a fitted E leak
  absorbs it and reads depolarised (the test measures that) while Rm reads low. `Seal (nS)` holds
  it, 0 by default — no channel is added at 0, so every fit before it is unchanged — and `Fit Seal`
  frees it, linear rather than log since 0 is a value. Two consequences: **rest is not E leak**
  once a seal is in, so the shared-simulation shortcut scales about the soma's zero-current steady
  state (`restAt`), and a sweep with no command sits there; and **the fitted Model leaves the seal
  behind** (`fittedModel` drops it), the seal being the electrode's. Günay et al. 2015's Table 2
  fitted 0.20 ± 0.03 nS on a larval motoneuron.

### Held to Gouwens & Wilson's model (measured 2026-10-18)

`pnpm probe:gouwens` builds their three reconstructed DM1 projection neurons (ModelDB 118662,
downloaded into `/tmp`, never committed) with the constants each Fig. 4A script sets, and compares
input resistance at the soma and every tip's steady-state share of the soma's voltage with NEURON's
on their own geometry. Against NEURON converged (0.1 µm segments): **ours at d_lambda's cut within
0.03–0.09% on input resistance and 5 × 10⁻⁴ on every tip**, on all five cases. The residual is a
skeleton's: their soma (10 µm) meets thin neurites at section joins, which a skeleton writes as two
radii at one point, a 10 µm² annulus NEURON's sections never have. Two findings beside it:

- **Their published model on its own segment counts is 0.3–0.55% low** — nearly converged — but
  **NEURON at d_lambda's cut on their geometry is 7–14% low**: their export joins 30 children at
  x = 0.99999994, one of them the primary neurite's, and NEURON hangs a child at x < 1 from its
  parent's last segment centre (the rule this doc's `compartmentAt` note records), so at one segment
  a section the whole dendrite hangs from the neurite's midpoint. A model built here joins at the
  point, which is why ours is converged at the count where NEURON is not.
- **`trueparentseg()` is the wrong question in an export**: it answers None for a section on the
  root's 0 end, where these templates attach the soma's other half. The probe's first version
  dropped that cylinder, 34 µm² beside the injection site, and read 0.7% high; `parentseg()`.

The fitted model carries how the fit ended (`CellModelValue.fit`: settled or why not, the RMS before
and after), which is the card's foot line through `describeValue` and what marks a model Apply can
write back. Rules for Apply (decided 2026-10-17):

- **It writes into the Compartment Model wired straight into `Model`**, one `setParams` — Custom,
  the four numbers to four figures, and `Area factor`. Through Select One or another fit, which card
  the numbers belong to is a guess, so it is refused with that reason. **Only a current result**:
  a cached one outlives a rewire, an edit and a failed re-run, and would be written into a card it
  was never fitted to; "applied" is asked first, applying being what makes the fit stale.
- **The area factor is a Compartment Model param**, not folded into Rm and Cm, so the applied cell is
  legible on the card. It multiplies `compartments.area` after discretisation (the soma's too), and
  d_lambda cuts for `cm × F`, as NEURON does with a spine factor folded into cm. `areaFactor` rides on
  the value for the readers that work an area out of geometry: the soma's π·d² (`somaMembrane`) and
  a length constant from the reconstruction's radii (`cableConstants`, Rm / F).
- **The fit's area factor is the card's own**, absolute rather than a share of the start model's:
  it starts at the model's `areaFactor` and `PassiveBase.area0` turns it into a scale on the areas
  the tree was built at. A relative factor put two numbers under one label — the Parameters table
  said 2 where Apply wrote 3 — and its bounds now share the card's floor (`AREA_FACTOR_MIN`), or a
  fitted value could be one the card refuses.
- **A fitted model holds extra membrane the way a built one does.** `fittedModel` scales
  `compartments.area` and sets `areaFactor`, rather than folding the factor into Rm and Cm (as it
  did first): one meaning of `areaFactor` on every model, so Apply copies the fitted model's
  membrane and factor as they stand.
- **"Applied" is a comparison, not a flag**: the button stands down while the card holds exactly
  what Apply would write, so an undo brings it back with no bookkeeping.
- A total-per-cell channel row is resolved to a density when the model is built. On the fitted
  `Model` that density meets the fit's extra area, so its total grows with it; the card rebuilt from
  Apply spreads the row's total over the larger area and keeps it. For such a row the two differ.

The full-size view (`FitView.tsx`) reads the four outputs: the traces one sweep at a time — a line is
a (series, column) pair in the Line Chart, so every sweep at once would colour each sweep's recorded
and fitted traces as two unrelated lines — the parameter table and the error per iteration. Foot
controls are a table of their own (`nodeFooter`), Fit Model Passive needing one without a body.

## In the wizard

**Simulate synaptic input**, contributed through `wizard.ts`: the start's neurons → **Select One**
→ Skeletons and Synapses Between (the neuron as Targets) → Compartment Model → Simulate Model → a Line
Chart or Table of the traces. Select One because a start is usually a search and the model takes
one neuron. Gated on skeletons (`requires`) and synapses (`when`, through `wizard/gates.ts`, which
exists so a pack can ask a capability without importing `options.ts` while it loads the packs),
and **never on Demo Data**: its neurons are miniatures, a few µm across with ~40 nm radii and no
soma, and on the card's defaults every run is a flat line at the synapses' reversal. So the demo
link opens a published dataset (maleCNS today) and needs a neuPrint sign-in.

## Carried over from navis

navis's `CompartmentModel` (`navis/interfaces/neuron/comp.py`) builds the same model in NEURON.
Several of its behaviours give a plausible trace when wrong; each is answered here:

| In `comp.py` | Consequence | Here |
| --- | --- | --- |
| `v_init=-65` while `DrosophilaPN` sets `e_pas=-60` | Every run opens with a 5 mV drift | Start at rest; settle first |
| The example passes `post.node_id.unique()` | Several synapses on one node become one | Conductance scales with the count |
| Several roots only log a warning | Synapses on a floating fragment never reach the soma | Only the soma's component; the rest counted |
| `nseg = 1 + 2*int(L/(2*res))` | A 19 µm section at res 10 is one segment | NEURON's d_lambda, or `ceil` then odd |
| `main_t` global; `finitialize` resets every model | Two models interfere | A pure per-run solver |
| "mF/cm²"; non-micron coordinates only warned | Unit slips | The nanometre guard, one nm → µm conversion |
| One `NetStim` per partner | Correct | One train per partner, seeded |
| Exp2Syn 0.1 / 10 ms, 0 mV, 1 ms delay | Sensible | Adopted |
| `pt3dadd` cone integration | Exact area and resistance | The same integration |
| Smooths radii (`window=3`) | Noisy radii make resistance spiky | `Smooth radii` |
| `celsius` left at 6.3 °C | HH rates scale by Q10 = 3 | `Temperature` |
| Re-roots at the soma | The cable equation has no root | A re-rooting invariance test |

## Export

Both notebook exporters refuse both nodes (`NO_EMITTER`): no notebook library reproduces the model
as is. Downloading the *model* for NEURON is the planned next step, and the harness's
`biophys_neuron.py` is half of it: a downloaded script can be run against Simulate Model's soma trace,
which makes "it loads in NEURON and gives the same answer" a test.

## Not built yet

- **Fit Model Active** (noted 2026-10-17, deferred 2026-10-18 for want of data to test it on): a
  second fit node freeing channel densities and ΔV50 shifts against feature targets (spike count,
  threshold, width, adaptation) rather than a trace, by CMA-ES over the fit's worker pool — Fit
  Model Passive's sibling, `biophys:fitActive` beside its `biophys:fit`. With it: an expanded fit
  summary for both (goodness of fit per sweep, the fit over time), and whether Apply goes, the
  fitted `Model` output already carrying the result.

- **More recording formats**: HEKA PatchMaster (`.dat`) and NWB next, then whatever is asked for,
  each a reader in `data/ephys`. ABF1 the same way, if old files turn up.
- **Emitters for Load Recording and Combine Traces**: pyABF and `numpy.interp` are the obvious
  cells, but the window, the averaging, the rebuilt command and the no-extrapolation rule each want a
  golden held to the node first.

- **The model as a NEURON (then Jaxley) script**, from the value's modelled cable rather than the
  source skeleton, with counts handed over rather than recomputed.
- **Vieira, Deistler et al. 2026's fly channels**, to rebuild their Fig. 1 and 4 (PNAS 123(40)):
  their fitted parameters are not in their Zenodo record. Günay et al. 2015's are in.
- **An adult central-brain fly channel set.** Günay et al.'s are a larval motoneuron's.
- **Moving the soma** in the Regions tab, and a 3D view beside its dendrogram.
- **Synaptic circuits**: graded synapses between point neurons, per-partner parameters.
- **A rate lookup table for the gates** (NEURON's `TABLE`): gate kinetics dominate the solver's
  step — three `Math.exp` per gate per compartment-step, nine per compartment for HH — and a table
  indexed by voltage would cut that several-fold. Its price is the step-for-step agreement with
  NEURON that `neuron-reference.json` holds to 1e-5 mV: NEURON interpolates its tables, so a table
  here would agree only to the table's resolution. Worth it if run time becomes the complaint;
  then hold it against NEURON run with `usetable` on, and keep the exact path for the fixtures.
