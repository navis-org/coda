## FAFB (CATMAID)

The "Female Adult Fly Brain" — an image dataset of a whole *Drosophila* brain ([Zheng et al., 2018](https://doi.org/10.1016/j.cell.2018.06.019)). Before it became "FlyWire FAFB", the automated segmentation, neurons in it were reconstructed by hand in CATMAID.

The published data from those early efforts is hosted by the Virtual Fly Brain project at [catmaid-fafb.virtualflybrain.org/](https://catmaid-fafb.virtualflybrain.org/).

### What CATMAID provides

Neuron skeletons, synapse locations, connectivity and annotations.

The annotations are free text. The VFB instance carries a sanitised set, but nothing marks which annotations are cell types, developmental stages or other properties — Coda makes educated guesses, and you will have to make up your own mind about the rest.

### Search

`Explore Dataset` runs a fuzzy search over the full set of annotations, similar to CATMAID's "Global Search". It does not match the more elaborate functionality of CATMAID's "Neuron Search" widget.
