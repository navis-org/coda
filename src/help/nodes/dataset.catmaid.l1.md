## About this dataset

L1 is an electron microscopy volume of the whole central nervous system of a first-instar *Drosophila* larva, imaged at 3.8 × 3.8 × 50 nm ([Ohyama, Schneider-Mizell et al., 2015](https://doi.org/10.1038/nature14297)). Neurons were reconstructed by hand in CATMAID over the following decade, and the brain was published as a complete connectome in [Winding, Pedigo et al., 2023](https://doi.org/10.1126/science.add9330).

The data is hosted by the Virtual Fly Brain project at [l1em.catmaid.virtualflybrain.org](https://l1em.catmaid.virtualflybrain.org/). That is a separate CATMAID server from the one behind the [FAFB](#dataset.catmaid.fafb) node, and the two share nothing: not the skeleton IDs, not the annotations and not the project number. Both happen to be project `1`, but on each server that means a different volume.

You get roughly five thousand traced skeletons covering the brain, the subesophageal zone and the thoracic and abdominal neuromeres, plus 27 region meshes for the ROI viewer.

No credentials are needed. If you add a row for `*.virtualflybrain.org` under Connections ▸ CATMAID, it covers both this server and the FAFB one.

## Types and annotations

Each neuron comes with a free-text name and a large number of annotations: around seventy per neuron, where FAFB averages a handful. Unlike FAFB, this server has no meta-annotation that marks which annotation is the cell type. So in Coda:

- `type` is the neuron's whole name, e.g. `A05q_a1l`, `KC #0` or `Ladder-a_a1`.
- `instance` is empty, because nothing on this server separates the type from the individual neuron (FAFB uses a `#` for that).
- everything else ends up in `annotations`.

The annotations are where most of the information is: lineages (`Ingrid Lineage Brain`, `mw lineages`), hemisphere and side, the hierarchical clusterings from the connectome paper (`mw brain clusters level 0` to `level 7`), and a `papers` group naming the 26 publications a neuron appeared in. When you start from this dataset, Explore's `Additional tags` points at the `annotations` column, so the tags show up under each row.

## Loading times

Compared to FAFB, L1 is heavier on labels and lighter on geometry. The annotation index is about 8 MB (FAFB: 1.4 MB), whereas a larval skeleton has 1,000–8,000 nodes (a traced FAFB neuron can have up to 17,000). The index is downloaded once; searching is local after that.
