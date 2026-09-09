## L1 (CATMAID)

The whole central nervous system of a **first-instar *Drosophila* larva**, imaged as ssTEM at
3.8 × 3.8 × 50 nm ([Ohyama, Schneider-Mizell et al., 2015](https://doi.org/10.1038/nature14297))
and reconstructed by hand over the decade since — the brain half published as a complete
connectome in [Winding, Pedigo et al., 2023](https://doi.org/10.1126/science.add9330).

Hosted by the Virtual Fly Brain project at
[l1em.catmaid.virtualflybrain.org/](https://l1em.catmaid.virtualflybrain.org/), and a **different
server** from the one behind the FAFB node — same organisation, separate installation. Nothing is
shared: not the skeleton ids, not the annotations, and not the project number, which is `1` on both
and means a different volume on each.

### What arrives with a neuron

Roughly five thousand traced skeletons covering brain, subesophageal zone and the thoracic and
abdominal neuromeres, plus 27 region meshes for the ROI viewer.

Each neuron carries a free-text **name** and a large bag of **annotations** — around seventy per
neuron, where FAFB averages a handful. What they do *not* carry is a meta-annotation saying which
annotation is a cell type: this instance uses neither of the conventions FAFB does. So `type` here
is **the neuron's own name**, whole — `A05q_a1l`, `KC #0`, `Ladder-a_a1` — and everything else
lands in `annotations`. `instance` stays empty, because nothing on this instance draws the
type-versus-individual distinction that FAFB's `#` convention encodes.

The annotations are where the work is: lineages (`Ingrid Lineage Brain`, `mw lineages`), hemisphere
and side, the hierarchical clusterings from the connectome paper (`mw brain clusters level 0` …
`level 7`), and a `papers` group naming the 26 publications a neuron appeared in. Starting from this
dataset points Explore's `Additional tags` at that column, so they draw under each row.

### Reading it costs more than FAFB

Heavier per neuron on labels and lighter on geometry: the annotation index is about 8 MB against
FAFB's 1.4 MB, while a larval skeleton is 1,000–8,000 nodes where a traced FAFB neuron reaches
17,000. The index downloads once and search is local after that.

No credentials are needed. A row under `Connections ▸ CATMAID` for `*.virtualflybrain.org` covers
this instance and the FAFB one together.
