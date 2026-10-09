# Plan: axon/dendrite compartments as data

Status: **phases 1–2 built** (the field and `splitSkeletons`; Split Axon/Dendrite, the 3D compartment mode, segregated demo synapses); phases 3–5 not started. Departures from this plan found while building are marked *Built:*. Decisions already taken are marked ✔; open ones are listed at
the end. When it lands, this file becomes the compartments section of
[nodes-morphology.md](nodes-morphology.md) (the split) and
[nodes-connectivity.md](nodes-connectivity.md) (the connection types).

## What it is for

Two questions Coda cannot answer on a wire today:

1. **Where on this neuron is the axon?** The split exists, but only inside `out.topology`, and only as
   per-neuron totals on `Morphometrics`. The per-node labels never leave the card, so nothing
   downstream can shade, filter or count by compartment.
2. **What kind of connection is this?** A synapse from A onto B is axo-dendritic, axo-axonic,
   dendro-axonic or dendro-dendritic, depending on where it sits on *each* neuron. That is a fact
   about every synapse of an edge, and it needs a split of both partners.

The first is the foundation and the second is the payoff. fish2 publishes the answer to (2) on
every `ConnectsTo` (`weightAxonAxon`, `weightAxonDendrite`, `weightDendriteAxon`,
`weightDendriteDendrite`); this computes it for every other dataset.

## Decisions taken

| | Decision |
| --- | --- |
| ✔ Value | A computed split travels as a **separate field**, `SkeletonGeometry.split`, beside the source's `compartments`. The rule in `values.ts` stands: source labels are never overwritten, and a result is never presented as a measurement. |
| ✔ Algorithm | The existing one: `pyodide/topology.py`, navis's `split_axon_dendrite` copied step by step and checked by `pnpm probe:split`. No second implementation. |
| ✔ Node 1 | **Split Axon/Dendrite**: skeletons and synapses in, skeletons carrying `split` out. |
| ✔ Node 2 | **Edges in, typed edges out.** Takes an edge list plus split skeletons, fetches the synapses between the listed pairs itself, places each end on its own neuron, and counts. |
| ✔ Layout | **Both**, as a `Layout` param: wide (one row per edge, fish2's column names) or long (one row per edge × class). |
| ✔ 3D | A **compartment** colour mode on `out.viewer3d`'s skeleton socket. |
| ✔ Cost | Split node **`cheap`**: no fetch, sliders re-split live. Connection node `expensive`. |
| ✔ Placement | Split node **core** (`neuron.splitCompartments`); connection node in **Connectome** (`connectome:connectionCompartments`). |
| ✔ Synapses | Split node's synapses are **wired only**; it has no Dataset socket and fetches nothing. |
| ✔ Long labels | **One `connection` column**: `axo-dendritic`, `axo-axonic`, `dendro-axonic`, `dendro-dendritic`, `linker`, `unsplit`. |
| ✔ Snap cap | 10 µm by default (the splitter's warning threshold); beyond it a synapse is `unsplit` and counted. |
| ✔ Scope | Core only. Mesh shading, mesh skeletonization, manual corrections, the published-weights path and exports are follow-ups (last section). |

## The value: `SkeletonGeometry.split`

```ts
/**
 * A *computed* axon/dendrite split, one code per node, in Coda's own vocabulary:
 * 0 unassigned, 1 dendrite, 2 axon, 3 linker (`topology.py`'s numbers).
 * Absent means nobody split this skeleton. Never written by a source.
 */
readonly split?: Uint8Array
```

*Built:* the value-level record of how the split was made (`SkeletonsValue.split`) was left out.
Nothing reads it yet; the per-item field is what the 3D View and the connection node need.

**Why not SWC codes in `compartments`.** SWC has no linker code. MICrONS' skeleton service already
fills `compartments` with *its own* automatic split. Writing a second split there would leave a
viewer with no way to say which one it is drawing. Two fields keep both readable, and the 3D mode
(below) says which one it used.

**The vocabulary is `topology.py`'s.** *Built:* `core/values.ts` is the one TypeScript spelling —
`CODE_*` beside `SWC_*`, with `splitName` and `compartmentKey` (either vocabulary as `axon` /
`dendrite` / `linker` / `soma`) beside `compartmentName` — and `topology.test.ts` holds the Python's
constants to it. `pyodide/topology.ts` no longer restates the codes.

### Every place a skeleton is built has to decide what happens to it

The survey found these. Each needs a deliberate answer, because dropping the field is silent:

| Site | Node count | Answer |
| --- | --- | --- |
| `skeletonBuffers` (values.ts:289) | — | **Add it**, or the cache budget and the memory readout under-count. |
| `transformOps.mirrorGeometry`, `withPositions` (warp/xform) | same | Spread already keeps it. Correct: positions moved, topology did not. |
| `arborHeal.ts:76` | same, parents change | Spread keeps it. The labels are per node and stay valid. |
| `sliceElements`, `stackGeometry` | by reference | Kept. |
| `cleanOps` / `skeletons.py` round trip (Clean Skeletons) | **changes** | **Drop it, and say so with `ctx.warn`.** A split computed on one tree is not a split of the resampled one. Carrying it through the Python would be cheap, but it would be a label on nodes that did not exist when the flow was computed. "Clean, then split" is the order to teach, and the warning says it. |
| Source builders (swc, neuPrint, CAVE, CATMAID, precomputed, mock) | — | Never set it. That is the invariant. |

## Node 1: Split Axon/Dendrite

`neuron.splitCompartments`, category `transform`, beside Skeleton to Points.

| | |
| --- | --- |
| Inputs | `skeletons` (Skeletons, required), `synapses` (Points, required). Normally a plain `Synapses` cloud of the same neurons, both polarities. |
| Outputs | `skeletons`: the same items, each with `split`. `synapses`: the cloud with a `compartment` column (the label of the node each synapse snapped to). `summary`: one row per neuron. |
| Params | `Linker threshold` (0.9), `Axon threshold` (1), `Heal fragmented skeletons` (off): Topology's three controls, shared through `compartmentOps.splitParams()`. *Built:* no `Polarity` picker; `validate` asks for `neuronId` and `polarity` columns, which every source's Synapses cloud has. |
| Cost | **`cheap`**. It does no fetch, and the sliders are worth seeing live. The first auto-run pays the Pyodide download. |

**The computation is Topology's, moved.** Topology's evaluate (`topology.ts:700-760`) groups the
sites, runs `assignSynapses` per neuron, `flattenForSplit`, `runSplitCompartments`, then scatters
the results. That whole sequence moves into one headless function:

```ts
// nodes/lib/compartmentOps.ts
splitSkeletons(skeletons, sitesByNeuron, settings, { signal, onProgress })
  → { labels: Uint8Array[]; status: SplitStatus[]; assignments: SynapseAssignment[] }
```

Topology calls it as well. One implementation means the card, Topology's port and this node cannot
disagree, which is the rule `useCompartments` already follows.

*Built:* the outputs are `out` (Skeletons), `labelled` (Synapses) and `summary`, an output port
not being allowed to share an input's id. `summary` carries the skeletons' attribute table first, so
it can be grouped by `type`, then the split columns. Those columns (`topologyOps.splitColumns` /
`splitColumnData`) are shared with Topology's Morphometrics, which therefore gained
`segregationIndex` too.

**`summary`** is `compartmentStats` per neuron (`splitStatus`, `cableAxon`, `cableDendrite`,
`cableLinker`, `preAxon`, `postAxon`, `preDendrite`, `postDendrite`), plus `segregationIndex`
(Schneider-Mizell 2016, the number your splitter reports beside each verdict). Invariant 3 applies:
a `splitSummarySchema()` / `splitSummaryTable()` pair, with an agreement test.

**Rules it must keep:**

- **A neuron that cannot be split keeps its geometry and gets no `split`.** The same goes for
  `multiple roots` and `no synapses`. It is counted by status in one `ctx.warn`, worded as
  Topology's, and the `heal` hint is given when any neuron was fragmented.
- **Synapses with no matching skeleton are counted, not dropped silently.** The match is by
  `neuronId` through `groupSynapses`, so `idText` (invariant 8) comes with it.
- **Nanometres, one space.** `checkGeometryUnits` on both inputs, and refuse two template spaces,
  the rule the distance nodes keep.
- **A synapse's `compartment` is the split's, and the column says it.** It is named `compartment`,
  but the help and the schema description say "computed". The source's SWC label is
  `Skeleton to Points`' column, which is a different thing.

## Node 2: connection types

Working name **Connection Compartments**, `connectome:connectionCompartments`.

| | |
| --- | --- |
| Inputs | `dataset` (Dataset), `edges` (Table), `skeletons` (Skeletons with `split`, from node 1) |
| Outputs | `edges`: typed edge list, wide or long. `synapses`: the per-synapse cloud with `preCompartment` and `postCompartment`, which a 3D View can colour by the class. |
| Params | `Presynaptic` (column, default `preId`), `Postsynaptic` (default `postId`), `Layout` (wide / long), `Max snap distance (µm)` (10), `Min confidence`, and the synapse `Rows` unit (`synapseUnitParam`, as Synapses Between) |
| Cost | **`expensive`**: it fetches. |

### The steps

1. Resolve the pairs through `ctx.column` (invariant 5). Deduplicate, and keep each pair's first
   row index so the output keeps the input's order.
2. `fetchSynapsesBetween({ sourceIds: unique pre, targetIds: unique post, location: 'both' })`.
   That returns every synapse in the cross product. Keep only rows whose (pre, post) is a listed
   pair. The cost warning is priced from the cross product, because that is what the server does.
3. Per synapse, place **the presynaptic end on the presynaptic skeleton** and **the postsynaptic end
   on the postsynaptic skeleton**: nearest node, the same grid `assignSynapses` uses, built once per
   neuron. Then read `split` there.
4. Tally per pair into six counts: the four classes, `linker` (either end on linker), and
   `unsplit` (either end's neuron has no split, is missing from `skeletons`, or snapped beyond the
   distance cap).

### Both ends of a synapse: a change to the seam

`SynapsesBetweenRequest.location` gains a third value, `'both'`: the point is drawn at the
presynaptic site, and the row carries `partnerX/Y/Z` for the postsynaptic one.

**Why not one coordinate for both neurons.** A T-bar and its PSD are a few hundred nm apart. The
nearest node on the postsynaptic skeleton is usually the right one, but where an axon and a
dendrite of the same neuron interdigitate, it will sometimes be a node on the other compartment.
That is exactly the misclassification this node exists to measure. Classifying the wrong end gives
plausible counts with nothing to say they are wrong, the same failure class as the `polarity` flip.

| Source | Both ends today? | Change |
| --- | --- | --- |
| neuPrint | Matched in the query (`ns`, `ms`), and only `${drawn}` returned (cypher.ts:897-930) | Return both locations |
| CAVE | Asks for one `<stem>_position` (CaveSource.ts:2046) | Ask for both `pre_pt_position` and `post_pt_position` |
| CATMAID | One connector position, but each link carries its **treenode id** (api.ts:241) | Use the connector for both ends. Follow-up: snap by treenode id, which is exact |
| Custom | One position per row | `'both'` refused with a reason unless the table maps a second position |
| Mock | One point on the drawn neuron | Generate the other end on `skeletonOf(other)` near it |

`capabilities` gains `synapseBothEnds`. Where it is false, the node falls back to one coordinate
for both ends and says so in `ctx.warn`, giving the number of synapses classified that way.

### Output layouts

**Wide** keeps every input column and appends `weightAxonAxon`, `weightAxonDendrite`,
`weightDendriteAxon`, `weightDendriteDendrite`, `weightLinker`, `weightUnsplit`. The first four use
fish2's spelling on purpose, so a computed table and a published one read the same. The six sum to
the synapses counted for that edge.

**Long** has one row per (edge, class) with a `connection` column after `weight`, which is where `Split by region` puts `roi`. **`weight` is
replaced by the class count**, never repeated: a whole-edge weight on every class row is counted
again by anything that sums the parts. That is the rule `roiConnectivityCypher` already learned.
Every other input column is carried.

**The counted synapses are not the input's `weight`, and the node says so.** neuPrint's `weight`
counts PSDs. A Synapses Between row counts whatever `Rows` says. Filtered and unfiltered
confidence differ again. So the wide layout adds a `synapses` column (the total counted), leaves
the input's `weight` untouched, and warns with the number of edges where the two differ by more
than rounding. The long layout's `weight` is the count by construction.

## 3D viewer: shading by compartment

There is no generic hook for this, so it follows the survey's route:

- `ColorMode` gains `'compartment'`, with an `allowCompartment` flag, offered on the skeleton
  prefix only, and listed in `DATALESS_MODES`.
- `ValuePreview.tsx:485` builds `skeletonNodeColor` from `item.split ?? item.compartments` when the
  mode is on. That is `Viewer3D`'s existing `nodeColorAt`, which only Topology uses today.
- **Computed beats source when both are present**, because wiring a split node is a deliberate act.
  The legend says which one was drawn ("computed split" / "source labels"), so the precedence is
  visible.
- Colours come from one table, `compartmentInks(mode)` in `ui/compartmentInk.ts`: dendrite and
  axon the first two categorical slots, linker `muted`, soma `primary`, unlabelled `secondary`.
  Topology's card, the Cortex wall and gallery, and the 3D shading all read it. The per-node colour
  reaches the scene as `ResolvedColor.nodeAt`.
- *Built:* the legend can recolour a key but not hide it, a key being a set of *nodes* where the
  channel hides whole neurons. A categorical legend prints no title, so which labels were drawn is
  a caption note (`compartmentNote`: "computed split" / "source labels"). Unlabelled nodes take
  `CHART_INK.secondary` under the key `unlabelled`, not the neuron's colour: under this mode a
  neuron has no colour of its own.
- The legend lists the codes present. The Python/R viewer3d emitters skip the mode with a note
  (exports are deferred).

## Synapse flow as a per-node value (*Built*, after phase 2)

`Write synapse flow` (off by default, in the Split group so it reaches a dashboard cell) asks the
Python for the flow it already computes — navis's sum-mode flow with the branch-point correction,
floored, the number `Linker threshold` is applied to — and stores it as
`SkeletonGeometry.nodeValues.flow`, **a fraction of each neuron's own peak**: the raw count spans
orders of magnitude between neurons, and as a fraction the linker is visibly everything at or above
the threshold on every arbour. A neuron with no split carries none, rather than zeros.

`nodeValues` is a map so the next per-node number needs no new field, and `NODE_VALUES` in
`core/values.ts` is the list the 3D View's picker offers. The 3D View's `by node value` mode colours
by one on the `by value` ramp: `valueRamp` in `style/encoding.ts` is now the one function both
modes go through, so a palette, a typed end and a log mean the same thing on either. Clean
Skeletons drops `nodeValues` with the split, and says so.

## Manual corrections (*Built*)

| | Decision |
| --- | --- |
| ✔ Home | On Split Axon/Dendrite, edited in its expanded view. |
| ✔ Gesture | **Subtree from a node**: click a node, and everything distal (or proximal) of it becomes axon, dendrite or linker. The splitter's skeleton mode. Segment and lasso are follow-ups. |
| ✔ Surface | **A dendrogram** of the neuron on screen, coloured by compartment. 2D picking has no depth ambiguity. |
| ✔ Thresholds | Corrections **compose** with the thresholds: absolute assignments, reapplied on top of whatever the automatic split now says. The opposite of the splitter, which discards them. |

**The value.** A `corrections` param (an `ids` list of JSON entries, like the Heatmap's selection),
in the provenance key, so files and share links carry it:
`{ neuron, at: [x, y, z] nm, scope: 'distal' | 'proximal', to: 'axon' | 'dendrite' | 'linker' }`.
**Anchored by position, not node index**, because indices do not survive a re-fetch, a heal or a
different skeleton route. At apply time each anchor snaps to the nearest node of its neuron within
a tolerance. One that no longer lands is kept, counted in a `ctx.warn`, and listed as stale. It is
never silently dropped, and never applied to whatever node happens to be nearest.

**The pass.** `applyCorrections(labels, skeleton, root, corrections)` in `compartmentOps.ts`,
headless and pure. "Distal" is measured from the root the dendrogram draws from (soma where
labelled, else the delivered root: `resolveRoot('soma')`), so outward on screen is distal in the
data. Entries apply in order, and a later one wins. **Nodes only**: `labelSynapses`, Summary and
the segregation index already read the node labels, so a correction reaches every output. This
deliberately drops the splitter's synapse mode, which can leave a synapse disagreeing with its own
skeleton. Summary gains a `corrections` count per neuron.

**Python stays out of the edit loop.** The automatic split is memoised on (skeletons, synapses,
thresholds), the Heatmap's `SHAPED` idiom, and the corrections are applied after it. A click
re-runs a TypeScript pass in milliseconds rather than a Pyodide round trip. Flow is untouched: it
is what the automatic split was computed from, not a label.

**The surface.** A `SplitEditor` body for the expanded node, composed from the dendrogram's own
layers rather than the 1,400-line Neuron Dendrogram viewer, which is welded to fetching and the
partner list:
- `arborLayout` + `useArborLayout`;
- `buildScene` / `paintScene`, with a compartment branch colour from `compartmentInks`;
- `pickPiece` → `arborPointAt` for the click;
- `usePanGesture` / `useWheelZoom`.

Around it go a neuron pager, the corrections for the neuron on screen (each removable), and "Reset
this neuron". A click opens a small menu: "From here outward → axon / dendrite / linker" and
"Towards the root → …". Picking is jsdom-testable in arithmetic. Layout and hit areas want a
`probe:` script in a real browser.

*Built:* the editor is the split node's `ValuePreview` entry (`SplitEditor.tsx`), not a node body,
so the card keeps its threshold rows. It is drawn on every full-size surface (the overlay, the
dock, a dashboard cell), and is `fullSizeOnly`: never the inspector's `summary`, which keeps its
geometry preview. The tree a correction is measured over is `splitArbor`, cached on the geometry's
arrays so neither the node nor the editor rebuilds it per click. Known limit: it carries no heal
bridges, so with Heal on a correction reaches only the fragment holding the root, the one the
editor draws. One on another fragment counts stale.
`SNAP_NM` is 2 µm. "Towards the root" became **everything else**, the complement of the subtree,
as the splitter's proximal is. The cache holds 8 settings per skeletons value. *Built, later:* the editor draws the **unrooted** layout (`equalAngle`, with the
dendrogram's daylight passes), and the click menu can **re-root** at the nearer end of the clicked
branch. The root is chosen per neuron on screen, not a param. Each correction records the root it
was made against (`root`, a position snapped like its anchor) and is re-applied from it. One
without a root is measured from the default. A neuron reopens on the root of its latest
correction. The menu's "From here outward" became "Away from the root", since an unrooted drawing
has no outward of its own. Not yet measured in
a real browser: where the menu falls over a dense arbour, and a split of the demo dataset end to end.

**Tests.** `applyCorrections`: order, distal vs proximal, snapping, stale anchors, an anchor on a
neuron not in the set, and composition with a re-split at new thresholds. The node: corrections in
the key, Summary's count, the memo not re-entering Python on an edit. The editor: a click on a known
piece writes the expected entry.

## What else this touches

- *Built:* 90% of each polarity on its own arbour (`OWN_ARBOUR_SHARE`), so the demo split is
  polarised rather than perfect and all four connection kinds occur. No fixture pinned the old
  positions.
- **Mock data has to segregate.** Mock synapses are spread evenly over both arbours today
  (`morphology.ts:418`, polarity-blind), so a split of the demo dataset is noise. Bias pre sites to
  the distal arbour and post sites to the proximal one, recording each node's arbour at
  generation. This is what makes the demos, the tests and the wizard show a real split. It changes
  every mock synapse position, so the goldens and fixtures that pin them move once.
- Glyphs (`ui/glyphs.ts`, one drawing per type, `glyphs.test.ts`), help documents in the navis voice
  (`src/help/nodes/`), `seeAlso.ts` (the split, Topology, Skeleton to Points; the connection node,
  Connectivity, Synapses to Edges, Synapses Between).
- The assistant catalogue: `PortDef.feeds` on the split's `skeletons` port, pointing at the
  connection node and the 3D View.
- `NO_EMITTER` entries in both coverage tests, with Topology's reasons.
- `knip` baseline for the moved functions.

## Tests

- `compartmentOps.test.ts`: `splitSkeletons` on a hand-built Y-neuron (the outputs on one branch,
  the inputs on the other) gives the expected codes. The same function called from Topology gives
  the same labels.
- Schema/table agreement for `summary` and for both layouts (invariant 3).
- Classification on two hand-built neurons with known synapse placements: all four classes, the
  linker, the unsplit (missing skeleton, failed split, past the cap), a repeated edge row, and the
  long layout summing to the wide one.
- **The both-ends test uses interdigitated geometry**, so that one coordinate for both ends gives a
  *different* answer. Otherwise the seam change is untested.
- Every skeleton builder: `split` survives mirror, warp, heal, slice and stack, and Clean Skeletons
  drops it with a warning.
- `cypher.test.ts` / CAVE spec tests for the `'both'` request. A live test per backend asserts
  that the two ends of a sampled synapse are within ~1 µm of each other.
- 3D: the mode resolves no column, unlabelled items fall back, and the legend names the source.

## Phases

1. **Value + lib**: the field, `skeletonBuffers`, `compartmentOps.splitSkeletons`, Topology moved
   onto it (no behaviour change; `probe:split` covers only the Python, so the check is `compartmentOps.test.ts` on the bookkeeping either side of the bridge), and Clean's drop.
2. **Split node + 3D mode + mock segregation.** Usable end to end on the demo dataset.
3. **Seam**: `location: 'both'` on neuPrint, CAVE and mock, plus the capability.
4. **Connection node**, both layouts.
5. Help, glyphs, See also, and the assistant.

## Open questions

None blocking. Naming (`Split Axon/Dendrite`, `Connection Compartments`) can still change before
phase 2, while the ids are not yet permanent.

## Follow-ups (noted, not in v1)

- **Mesh shading**: label each mesh vertex by its nearest split-skeleton node of the same neuron.
  It needs per-vertex mesh colours in `Viewer3D` (meshes take one colour per item today) and the
  skeleton on the wire too. No skeletonization needed where a dataset publishes skeletons.
- **Mesh skeletonization**, for mesh-only neurons. Nothing in the Pyodide lock does it (no
  skeletor). A JS wavefront/TEASAR is a project of its own.
- **Manual corrections**, following `mcns_neuron_splitter`: select synapses or a node, then set
  axon/dendrite (distal or proximal of the node). Stored in the graph as edits keyed by
  **position**, not node index, because indices do not survive a re-fetch. The splitter
  position-encodes connectors for the same reason. Also: read the splitter's saved
  `{id}_nodes.feather` / `_synapses.feather` as a published split. Its codes (`na`, `axon`,
  `dendrite`, `linker`, `cellbodyfiber`, `mixed`, `unknown`) are a superset worth adopting before
  the field's vocabulary is frozen.
- **Published weights**: a `Source` control on the connection node. Automatic reads fish2's four
  properties where `edgeProperties` lists them, without skeletons. Also a check: computed against
  published on fish2 is the probe this node should have.
- **Exports**: Python via `navis.split_axon_dendrite` + `fetch_synapse_connections`, held to the
  standard that Topology's refusal sets (checked by running it against the node).
- Topology and Neuron Dendrogram reading an incoming `split` instead of recomputing.
- CATMAID's treenode ids for exact placement.
