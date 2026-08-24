> [!WARNING] neuPrint-only
> NeuPrint is the only backend that provides precomputed ROI counts.

## The nested region trap

Neuprint's region counts nest, just like [ROI Completeness](#neuron.roiCompleteness). A synapse in `LO(R)` is counted again in `OL(R)` (optic lobe, super-level) and in `LO-C1(R)` (sub-level). When you sum across every row, each synapse is counted multiple times.