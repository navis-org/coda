## L1 (CATMAID)

The whole central nervous system of a **first-instar *Drosophila* larva**, imaged as ssTEM at
3.8 × 3.8 × 50 nm ([Ohyama, Schneider-Mizell et al., 2015](https://doi.org/10.1038/nature14297))
and reconstructed by hand over the decade since — the brain half of it published as a complete
connectome in [Winding, Pedigo et al., 2023](https://doi.org/10.1126/science.add9330).

The data is hosted by the Virtual Fly Brain project at
[l1em.catmaid.virtualflybrain.org/](https://l1em.catmaid.virtualflybrain.org/), and it is a
**different server** from the one behind the FAFB node — same organisation, separate
installation. Nothing is shared between them: not the skeleton ids, not the annotations, and not
the project number, which is `1` on both and means a different volume on each.

### What arrives with a neuron

Roughly five thousand traced skeletons covering brain, subesophageal zone and the thoracic and
abdominal neuromeres, plus 27 region meshes (the whole CNS, both brain hemispheres, and each
neuromere left and right) for the ROI viewer.

Each neuron carries a free-text **name** and a large bag of **annotations** — around seventy per
neuron, where FAFB averages a handful. What they do *not* carry is a meta-annotation saying which
of those annotations is a cell type: this instance uses neither of the conventions FAFB does. So
`type` here is **the neuron's own name**, whole — `A05q_a1l`, `KC #0`, `Ladder-a_a1` — rather
than a curated label, and everything else lands in `annotations`. Coda does not guess past that:
`instance` stays empty, because nothing on this instance draws the type-versus-individual
distinction that FAFB's `#` convention encodes.

The annotations are where the work is. Lineages
(`Ingrid Lineage Brain`, `mw lineages`), hemisphere and side, the hierarchical clusterings from
the connectome paper (`mw brain clusters level 0` … `level 7`), and a `papers` group naming the
26 publications a neuron appeared in — Ohyama 2015 through Winding 2023. Starting from this
dataset points Explore's `Additional tags` at that column, so they draw under each row; searching
for any of those strings works exactly as searching for a cell type does elsewhere.

### Reading it costs more than FAFB

Both are small datasets by connectome standards, and this one is the heavier of the two per
neuron on labels and the lighter on geometry: the annotation index is about 8 MB against FAFB's
1.4 MB, while a larval skeleton is 1,000–8,000 nodes where a traced FAFB neuron reaches 17,000.
The index downloads once and search is local after that.

No credentials are needed to read it. If you add a row under `Connections ▸ CATMAID` for
`*.virtualflybrain.org`, it covers this instance and the FAFB one together.
