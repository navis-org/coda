> [!WARNING] neuPrint-only
> neuPrint is the only backend that provides precomputed ROI counts.

## The nested region trap

neuPrint's region counts nest, just like [ROI Completeness](#neuron.roiCompleteness). A synapse in `LO(R)` is counted again in `OL(R)` (optic lobe, super-level) and in `LO-C1(R)` (sub-level), so summing across every row counts each synapse several times.
