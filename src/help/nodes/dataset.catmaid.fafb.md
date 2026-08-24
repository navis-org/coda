## FAFB (CATMAID)

The "Female Adult Fly Brain" (FAFB) dataset is an image dataset of a whole *Drosophila* brain (see [Zheng et al., 2018](https://doi.org/10.1016/j.cell.2018.06.019)). Before it became "FlyWire FAFB" (the automated segmentation), people manually reconstructed neurons in this dataset using CATMAID.

The published data from these early efforts is hosted by the Virtual Fly Brain project at [catmaid-fafb.virtualflybrain.org/](https://catmaid-fafb.virtualflybrain.org/).

### What CATMAID provides

CATMAID is a web-based tool for collaborative neuron reconstruction. It provides neuron skeletons, synapse locations, connectivity and annotations.

The annotations are free-text and while the VFB instance contains a sanitized set of annotations, there is no way to tell which annotations are meant to be e.g. Cell types, developmental stages, or other properties. Coda tries to make educated guesses but ultimately you'll have to make up your own mind about what the annotations mean.

### Search

The "Explore Dataset" widget uses a fuzzy search on the full set of annotations (similar to CATMAID's "Global Search" function). We currently do not match the more elobarate functionality of CATMAID's "Neuron Search" widget.
