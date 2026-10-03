## What ROI Counts does

ROI Counts tells you where the incoming neurons have their synapses: for each neuron and each brain region, how many presynapses (`pre`) and postsynapses (`post`) it has there. Wire a Dataset and a table of neurons.

> [!WARNING] neuPrint only
> neuPrint is the only backend that provides precomputed ROI counts.

The output has one row per neuron per region, with the columns `neuronId`, `type`, `roi`, `pre` and `post`. Use [Group By](#core.groupBy) or [Pivot](#core.pivot) to summarise it. For example, grouping by `roi` and summing `post` gives you the total number of postsynapses the neurons have in each region.

## Nested regions

Like in [ROI Completeness](#neuron.roiCompleteness), regions are nested. A synapse in `LO(R)` is also counted in `OL(R)` (the optic lobe, a super-region) and in `LO-C1(R)` (a sub-region). If you add up all rows, each synapse is therefore counted several times.

To avoid this, filter `roi` down to the regions you are interested in before adding things up. If you want only the primary regions (the ones that don't overlap), you can [Join](#core.join) the table with the output of [ROI Completeness](#neuron.roiCompleteness) on `roi` and filter on its `primary` column.
