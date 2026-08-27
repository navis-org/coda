# Prior art — capabilities to steal

A survey of what [FlyWire Codex](https://codex.flywire.ai/), [CATMAID](https://catmaid.readthedocs.io/)
and [neuPrint](https://github.com/connectome-neuprint/neuPrint) offer, and what each maps to
in Coda's node-graph model. Sourced from their live UIs, docs, and source trees (Codex
`codex/data/structured_search_filters.py` + `blueprints/app.py`, CATMAID's widget registry
in `static/js/widgets/`, `neuPrintExplorerPlugins/packages/{query,view}/src`, and
`neuprint-python`'s query API) — not from memory.

Coda is a pipeline editor, not a page-per-question app, so most of their features arrive
here as **nodes** rather than screens. Where a feature is genuinely an _editor_ affordance
(not a computation), that's called out.

## The three, in one line each

| Tool                | Shape                                                                   | What it's good at                                                                       |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Codex** (FlyWire) | Flask app, page per question, 5 datasets (FAFB, BANC, MANC, MAOL, MCNS) | A real **query language** over neuron attributes, and network-level aggregates          |
| **CATMAID**         | Django + ~80 floating JS widgets, tracing-first                         | **Morphometrics**, arbor analysis, and a composable widget/filter architecture          |
| **neuPrint**        | Neo4j + `neuPrintHTTP` + plugin-based Explorer + `neuprint-python`      | A clean **declarative criteria** model, ROI-resolved connectivity, synapse-level access |

---

## A. Query and selection

Coda has `Find Neurons` (type/status/ROI-ish) and `Filter`. The gap is expressiveness.

### A1. Structured query operators — Codex's is the best design out there

Codex parses free text into `<attribute> {operator} <value>` terms, `{and}`/`{or}` combined,
each operator with a two-char shorthand. Twenty attributes: `root_id`, `label`, `side`,
`nt_type`, `input_neuropils`, `output_neuropils`, `input_hemisphere`, `output_hemisphere`,
`flow` (intrinsic/efferent/afferent), `super_class`, `class`, `sub_class`, `cell_type`,
`hemilineage`, `nerve`, `name`, `group`, `connectivity_tag`, `mirror_twin_root_id`, `marker`.

The operators split into two families, and the split matters for us:

| Family                                    | Operators                                                                                                                                                                                                         | Coda mapping                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Predicates** on a cell's own attributes | `{equal}` `{not_equal}` `{starts_with}` `{contains}` `{not_contains}` `{in}` `{not_in}` `{has}` `{not}`                                                                                                           | Extend the **`Filter` node's** operator set. `{has}`/`{not}` (attribute non-empty) and `{in}`/`{not_in}` (comma-separated set membership) are cheap wins we're missing. |
| **Traversals** disguised as predicates    | `{upstream}` `{downstream}` `{upstream_region}` `{downstream_region}` `{reciprocal}` `{pathways}` `{similar_shape}` `{similar_upstream}` `{similar_downstream}` `{similar_connectivity}` (+ `_weighted` variants) | These should **not** be Filter operators in Coda — each is a node (see B, F). Codex has to fold them into search because it has no pipeline. We have one.               |

Also worth copying: Codex records a **`description` and a `value_range` per attribute**, and
does fuzzy attribute-name correction via edit distance (`label`/`tag`/`labels`/`annotation`
all resolve). Our socket schemas already carry dtype; adding an optional `enum` of legal
values would let the `Filter` node offer a _value_ dropdown, not just a column dropdown —
and it feeds the palette's fuzzy matcher for free.

### A2. Declarative criteria objects — neuPrint's `NeuronCriteria` / `SynapseCriteria`

neuPrint's Python API centres on two criteria objects passed to every fetch. This is
effectively our `Find Neurons` param set, and their field list is a good checklist:
bodyId, type, instance, status, cropped, ROI (with `roi_req` = `all` vs `any`), input/output
ROI, min pre/post counts, plus `SynapseCriteria` (ROI, primary-only, confidence threshold,
`rois` grouping). **Confidence threshold** and **`all` vs `any` ROI semantics** are two we
don't have and would both be one-param additions.

### A3. Selection persistence and set algebra

- CATMAID **Selection Table** — "manage lists of neurons": named lists, colour per neuron,
  visibility toggles, import/export, and it acts as a _source_ for every other widget.
  → In Coda this is a **`Neuron List` node** (literal bodyId list, editable, saved in the
  document). Needed the moment anyone wants a hand-curated set. Currently there's no way to
  pin a set of IDs into a graph.
- CATMAID **Venn Diagram** — "use set logic to filter skeletons".
  → **`Set Ops` node** (union / intersect / difference on ID collections). Trivial to build,
  and it's the thing that makes two query branches composable.
- neuPrintExplorer **Saved Search** / Favorites, Codex `download_search_results` +
  `root_ids_from_search_results`.
  → Mostly subsumed by `.coda.json` being the document. The one genuinely missing piece is
  **copy the resolved ID list to clipboard** from any table viewer.

### A4. Raw query escape hatch

neuPrintExplorer **Custom Query** ("Enter custom Neo4j Cypher query") and a
**Show Cypher Query** button on _every_ result — you can always see the query a plugin
generated and edit it. Codex's equivalent is `headless=1` / `download` on each route.

→ Already on our roadmap as the Cypher node. The part worth copying is the _second_ half:
**every query node should be able to show the query it would send**. That's a debugging
affordance and a teaching tool, and it costs one extra field on the node's evaluate result.

---

## B. Connectivity analysis

### B1. Partner tables with the right knobs

Codex's `/connectivity` route takes: `nt_type` filter, `min_syn_cnt`, `cap` (top-N
connections, default 50), `group_by`, `show_regions`, `include_partners`, `hide_weights`.
neuPrint has `fetch_simple_connections`, `fetch_adjacencies` (with **per-ROI breakdown**),
`fetch_traced_adjacencies`, and a **Ranked Table** plugin ("connections to neuron(s) ranked
in order and colored by neuron class"). CATMAID's **Connectivity Widget** lists partners with
a synapse-count threshold and node-filter application.

→ Our `Connectivity` node needs: **min synapse count**, **top-N cap**, and
**per-ROI breakdown as an optional extra column**. The ROI breakdown is the important one —
it's what turns "A → B, 40 synapses" into "A → B, 40 synapses, 32 of them in LO".

### B2. Common / shared connectivity

neuPrint **Common Connectivity** + `fetch_common_connectivity` ("shared inputs or outputs
across neurons"); Codex has `{similar_upstream}` / `{similar_downstream}`.

→ **`Common Partners` node**: N input ID sets → partners connected to ≥k of them. Distinct
from a join because the interesting output is the _membership pattern_, not a merged row.

### B3. Paths

- Codex `/pathways` (layered pathway diagram between two cells) and `/path_length`
  (**all-pairs shortest-path length matrix** between two sets).
- neuPrint `fetch_paths` (multi-hop routes) / `fetch_shortest_paths`, plus the
  **Shortest paths** plugin ("all neurons along the shortest paths between two neurons").

→ Two nodes, and they're different: **`Shortest Paths`** (source set → target set →
`Table` of paths, with hop limit and min-weight-per-edge) and **`Path Length Matrix`**
(set × set → `Matrix` of hop counts). The second is the more useful one for us because it
lands straight in the existing heatmap viewer.

### B4. Motif search

Codex `/motifs` — a sketch UI for up to **3 nodes**, with per-edge constraints:
allowed regions, min synapse count, NT type. neuPrint has **Motif Query** ("sketch interface
to query the database for motifs") and **Vimo**/**VimoMotif**.

→ **`Motif Search` node**. Note the shape mismatch worth thinking about: the query _is_ a
small graph, and Coda is a graph editor. Either a mini sketch widget in the node body, or —
more in keeping with the design — a `ForEach`-adjacent idea where a subgraph _is_ the motif
pattern. Park it, but it's the most interesting long-term fit of anything in this list.

### B5. Network-level rollups

- Codex `/heatmaps`: `group_by` an attribute × **count type ∈ {Synapses, Connections,
  Reciprocal Connections}**. The count-type distinction is the insight — same grouping,
  three very different matrices, and our heatmap only knows about synapse weight. Also
  shows _two_ numbers per cell (count, and pairs-of-neurons in the group pair).
- Codex `/network_graph`: group nodes by attribute, **split groups by side**, edge-weight
  visibility toggles.
- neuPrint **ROI Connectivity** ("extract connectivity matrix for a dataset") and
  **Brain Region Connectivity**; CATMAID **Connectivity Matrix** ("aggregate partner
  connections and display them in a matrix") and **Compartment Graph**.

→ Our `Adjacency` + `Pivot` + `Heatmap` chain covers the mechanics. What's missing is
(a) **count type** as a param on `Adjacency`, (b) **normalisation choices** beyond row-norm
(column, total, log), (c) **an ROI × ROI adjacency node** (region-level, not cell-level).

### B6. Connectivity-derived labels

Codex ships a precomputed `connectivity_tag` attribute per neuron:
`3_cycle_participant`, `broadcaster`, `feedforward_loop_participant`,
`highly_reciprocal_neuron`, `integrator`, `nsrn`, `reciprocal`, `rich_club`.

→ A **`Network Metrics` node** (in/out degree, in/out synapse totals, reciprocity,
clustering coefficient, participation in 3-cycles / FFLs) computing these _client-side_ from
an adjacency table, rather than depending on the source to precompute them. This is a pure
`cheap` node over data we already have in a `Matrix`, which makes it unusually good value.

---

## C. Morphology and morphometrics

This is CATMAID's strongest area and our biggest hole — README lists no skeleton work at
all. Their metric definitions are the spec worth copying.

**Measurements Table** columns, verbatim: `Raw cable (nm)`, `Smooth cable (nm)`,
`Lower-bound cable (nm)`, `N inputs`, `N outputs`, `N presynaptic sites`, `N nodes`,
`N branch nodes`, `N end nodes`, `Est. radius volume (nm³)`.

**Analyze Arbor** — "metrics for different parts of a neuron": splits an arbor into
backbone / axon terminals / dendritic terminals, approximates twigs by **Strahler number**,
and reports cable per compartment plus distance to nearest mitochondrion.

**Morphology Plot** — "histogram based analysis tool working on neuron intervals"
(synapse density vs distance from soma). **Synapse Plot** — "plot synapse distribution of
multiple skeletons". **Neuron Dendrogram** — "visualize the topology of a neuron".

→ For Coda:

| Node                   | Output     | Notes                                                                                                                                |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Skeleton Fetch`       | `Skeleton` | The type is already reserved in `core/types.ts`.                                                                                     |
| `Morphometrics`        | `Table`    | The Measurements Table column set above, one row per neuron. Column names are the contract — match theirs so results are comparable. |
| `Arbor Split`          | `Skeleton` | axon / dendrite / backbone / twigs, by Strahler order or synapse-flow centrality.                                                    |
| `Synapse Distribution` | `Table`    | binned by geodesic distance from soma → feeds the existing bar chart.                                                                |
| `Dendrogram` viewer    | —          | topology-only view; no 3D needed, so it's reachable before three.js lands.                                                           |

Two notes. First, several of these want `navis`, which is the Python-service item already on
the roadmap — but `Morphometrics` over a fetched skeleton is pure arithmetic and can be a
`cheap` TS node. Second, `Skeleton` values break the "columns declared statically" rule for
tables but not for sockets; they're opaque payloads, so no schema work is needed.

---

## D. Spatial / ROI

- neuPrint: `fetch_all_rois`, `fetch_primary_rois`, **`fetch_roi_hierarchy`** (nested ROI
  tree), `fetch_synapses` / `fetch_mean_synapses` / `fetch_synapse_connections`,
  **ROIs Intersecting Neurons**, **Cell Objects Spatial Query** ("find objects around a
  point"), **Find Objects** ("find objects at a point").
- Codex `/neuropils` (per-region connection view) and `/cell_coordinates`.
- CATMAID **Volume Manager** ("list and edit volumes and create new ones") and the
  `Volume` / `Use a region` node-filter strategies.

→ Priorities: **ROI hierarchy as a first-class value** (so an ROI param can be a tree
picker and a `Roll Up ROIs` node can aggregate child regions into parents), then
**`Synapse Positions`** as a table of points. The hierarchy is the one that changes results:
without it, "synapses in the optic lobe" and "synapses in ME+LO+LOP" are different answers.

---

## E. Similarity and clustering

- Codex operators `{similar_shape}` (NBLAST-backed), `{similar_connectivity}`,
  `{similar_upstream}`, `{similar_downstream}`, each with a `_weighted` variant. The service
  computes **weighted and binary Jaccard** over partner sets (`jaccard_weighted`,
  `jaccard_binary` in `codex/utils/stats.py`).
- CATMAID **Neuron similarity** ("compare neurons and rank them by similarity using
  NBLAST"), **Neuron similarity detail**, **Pair statistics** ("similarity of pairs of
  neurons, e.g. to find homologues"), **Clustering Widget**.
- neuPrint **Find similar neurons**, **Cell Type** overview.

→ **`Connectivity Similarity` node** — set × set → `Matrix` of Jaccard (binary or weighted)
over shared partners, with an up/down/both param. This is entirely client-side over an
adjacency matrix, needs no backend, drops into the heatmap viewer, and is the highest
value-per-line item in this whole document. NBLAST comes later with the Python service.

Downstream of it: a **`Cluster` node** (hierarchical, on any `Matrix`) plus dendrogram
ordering on the heatmap viewer. Codex's mirror-twin / `{similar_shape}` pairing and
CATMAID's Pair Statistics are both really "find homologues", which is the same machinery.

---

## F. Aggregate statistics

Codex `/stats` runs over _any search result_: attribute value distributions as charts, plus
summary counts. `cell_details` shows per-cell charts — input/output synapse split, input and
output synapses by neuropil, by hemisphere, and by neurotransmitter.

→ Two things. A **`Describe` node** (per-column: count, distinct, min/max/mean, top values)
which is generic table infrastructure we'll want regardless. And the observation that
Codex's per-cell chart set is just _group-by neuropil / hemisphere / NT → bar chart_ —
which our existing nodes already express. Worth shipping as a fourth **example graph**
("cell detail card") rather than as new code.

Skip: `/leaderboard`, `/labeling_log`, CATMAID **User Analytics**, **Project Statistics**,
**Neuron History** — these measure annotation _effort_, which is a proofreading-platform
concern, not an analysis one.

---

## G. Viewers

We have table, bar chart, heatmap. Their inventory:

| Theirs                                                                                                                                                                                                                   | Coda viewer                            | Priority                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------ |
| CATMAID **3D Viewer** ("neurons, synapses and image data in 3D"); neuPrint **Skeleton** view with compartment selection, synapse toggles, per-neuron colour picker, meshes-vs-skeletons switch; Codex Neuroglancer embed | `Skeleton` viewer node (three.js)      | High — it's the one output type every one of these has and we don't      |
| neuPrint **Cytoscape** / **Graph**; CATMAID **Graph Widget** ("display and analyze neurons as nodes in a directed graph"); Codex `/network_graph`                                                                        | `Network Viewer` node                  | High — a `Matrix` renders as a graph as naturally as a heatmap           |
| neuPrint **HeatMapTable**, **CollapsibleTable**, **SimpleTable**                                                                                                                                                         | have heatmap + table                   | Add **collapsible/grouped rows** to the table viewer                     |
| CATMAID **Circuit Graph Plot** / **Data Plot** ("plot various skeleton properties with respect to each other")                                                                                                           | `Scatter` viewer node                  | Medium — the obvious missing chart type, and cheap next to the other two |
| CATMAID **Synapse Fractions** ("plot input/output fraction wrt. partner neurons")                                                                                                                                        | stacked-bar with normalise-to-fraction | Low — one param on the existing bar chart                                |
| CATMAID **Neuron Dendrogram**, **Venn Diagram**                                                                                                                                                                          | see C, A3                              | —                                                                        |

Per-neuron **colour assignment** deserves separate mention: CATMAID's Selection Table and
neuPrint's Skeleton view both let you bind a colour to a neuron and have _every_ view honour
it. In Coda that's a `Colour By` node emitting a colour column that viewers respect —
which is a schema convention, not a viewer feature, and should be decided before the 3D
viewer is written rather than after.

---

## H. Interop and export

| Capability                                                                                                                          | Where                                                                                                         | For Coda                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Download results** (CSV) from every result panel                                                                                  | neuPrint, Codex `/download_search_results`                                                                    | Per-node "download table" — small, and immediately useful |
| **Copy to clipboard**                                                                                                               | neuPrint modal                                                                                                | Copy resolved ID list / table                             |
| **Deep link into a 3D viewer** — Codex `search_results_flywire_url`, `flywire_neuropil_url`; neuPrint's Neuroglancer menu + `nglui` | Build a Neuroglancer URL from an ID collection. Cheap, no CORS, and useful _before_ we have any 3D of our own |
| **GML / GraphML round-trip** for external layout (Gephi)                                                                            | CATMAID Graph Widget                                                                                          | Export a `Matrix` as GML/GraphML                          |
| **Sharable deep links** — CATMAID **Link Widget** ("create and manage sharable deep links"), neuPrint URL-encoded query state       | We have `.coda.json` files; a URL-encoded graph would be strictly better for sharing an example               |
| **VR viewer seed download**                                                                                                         | neuPrint                                                                                                      | Ignore                                                    |

---

## I. Editor architecture — what CATMAID proves and what it lacks

Two of CATMAID's architectural ideas are worth reading closely, because one validates our
design and the other is a node pack we can lift directly.

**Skeleton sources.** Every CATMAID widget exposes a "source" dropdown and can pull a neuron
list from any other widget, append to it, or sync with it. It's a hand-rolled dataflow graph
with no visible edges — the wiring lives in dropdowns spread across floating windows. Coda's
node graph is a strict superset with the wiring made visible. Worth noting in our own docs as
the argument for the whole approach: they arrived at dataflow, then had to hide it.

**Node filter strategies** — CATMAID's composable, stackable filter rules, applicable to
most widgets. The full list is a ready-made node pack for when skeletons land:
`Take all nodes`, `Only soma`, `Only branch nodes`, `Only end nodes`, `Only tagged nodes`,
`Axon`, `Dendrites`, `Binary split`, `Strahler number`, `Pruned arbor`,
`Sub-arbors starting from a tag`, `Volume` / `Use a region`, `Synaptic connections to other
neurons`, `In skeleton source`, `Sampler domain`, `Sampler interval`, `Created by user(s)`,
`Date range`.

Also from CATMAID: widgets **self-register** (`CATMAID.registerWidget({name, description,
key, creator})`) with a name + description + hotkey, and an "Open Widget" dialog fuzzy-
searches them. That's our command palette and `paletteItems.ts`, already done, and the
`description` field is why their dialog reads as well as ours does.

Not worth copying: tracing, review/proofreading, ontology and classification editors,
landmarks, reconstruction sampler, project/user management, notification tables. CATMAID is
an annotation platform that grew analysis; Coda is analysis only.

---

## Suggested order

Grouped by what unblocks what, not strictly by value.

**Now — no backend needed, pure additions over data we already have**

1. **`Filter` operator set**: `in` / `not_in` / `has` / `is_empty` / `not_contains`, plus
   `enum` on column schemas so values get a dropdown (A1).
2. **`Neuron List` node** and **`Set Ops` node** (A3) — without these, two query branches
   can't be combined, and nothing can be hand-curated.
3. **`Connectivity Similarity` node** (E) — Jaccard over partner sets, client-side, straight
   into the heatmap. Best value/effort ratio in the document.
4. **`Network Metrics` node** (B6) — degree, reciprocity, clustering coefficient, motif
   participation from an adjacency matrix.
5. **`Describe` node** (F) and **per-node CSV download** (H).

**Next — needs the neuPrint source, so it lands with it**

6. **`Connectivity` node knobs**: min synapse count, top-N cap, per-ROI breakdown (B1).
7. **`Shortest Paths`** + **`Path Length Matrix`** (B3).
8. **ROI hierarchy** as a value type, and **`Roll Up ROIs`** (D).
9. **Count type** (synapses / connections / reciprocal) on `Adjacency`, and more
   normalisation modes (B5).
10. **"Show the query"** on every query node (A4) — do it while writing the source, not after.

**Then — new value types**

11. **`Skeleton Fetch`** + **`Morphometrics`** with CATMAID's exact column names (C).
12. **Network Viewer** and **Scatter Plot** (G).
13. **Neuroglancer deep-link node** (H) — real 3D for free, before our own viewer exists.
14. **Colour-column convention** (G) — decide before the 3D viewer, not after.
15. **`Arbor Split`**, **`Synapse Distribution`**, **NBLAST** — the Python-service tier (C, E).

**Parked**

**Motif Search** (B4). The right design is probably "a subgraph _is_ the pattern", which
means it wants the `ForEach`/subgraph work first. Revisit then — it's the feature where
Coda's form could beat all three of theirs rather than match them.
