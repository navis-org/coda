## About this dataset

FAFB ("Female Adult Fly Brain") is an electron microscopy volume of a whole adult *Drosophila* brain ([Zheng et al., 2018](https://doi.org/10.1016/j.cell.2018.06.019)). Before the automated segmentation that became [FlyWire](#dataset.flywire), neurons in this volume were reconstructed by hand in CATMAID. This node reads the published data from those efforts, which the Virtual Fly Brain project hosts at [catmaid-fafb.virtualflybrain.org](https://catmaid-fafb.virtualflybrain.org/). No credentials are needed.

You get neuron skeletons, synapse locations, connectivity and annotations.

## Annotations

CATMAID annotations are free text. The VFB instance carries a cleaned-up set, but nothing marks which annotations are cell types, which are developmental stages and which are something else entirely. Coda makes some educated guesses (e.g. which annotation is a neuron's type), but for the rest you will have to make up your own mind.

## Searching

`Explore Dataset` runs a fuzzy search over all annotations, similar to CATMAID's "Global Search". It does not do everything CATMAID's more elaborate "Neuron Search" widget does.
