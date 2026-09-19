# Node semantics

One section per node whose behaviour cost a decision, split by family because the record outgrew
one file. See also [adding-a-node.md](adding-a-node.md), which holds the extension point itself and
what a port's declaration means.

## [nodes-tables.md](nodes-tables.md) — tables and matrices

- [Pivot: a matrix and a wide table](nodes-tables.md#pivot-a-matrix-and-a-wide-table)
- [Unpivot: the other direction, and what it cannot give back](nodes-tables.md#unpivot-the-other-direction-and-what-it-cannot-give-back)
- [Reduce Matrix: the way out of a matrix](nodes-tables.md#reduce-matrix-the-way-out-of-a-matrix)
- [Filter Network, and why "Filter" became "Filter Table"](nodes-tables.md#filter-network-and-why-filter-became-filter-table)
- [Adjacency: a matrix, and the same connections as links](nodes-tables.md#adjacency-a-matrix-and-the-same-connections-as-links)
- [Heatmap: three tabs are data, the Colour tab is not](nodes-tables.md#heatmap-three-tabs-are-data-the-colour-tab-is-not)
- [Embedding: three ways in, one k-NN graph](nodes-tables.md#embedding-three-ways-in-one-k-nn-graph)
- [Group By: one aggregation, several value columns](nodes-tables.md#group-by-one-aggregation-several-value-columns)
- [Normalize](nodes-tables.md#normalize)
- [Deduplicate](nodes-tables.md#deduplicate)
- [Type column, and combining several into one](nodes-tables.md#type-column-and-combining-several-into-one)
- [Rename Columns](nodes-tables.md#rename-columns)
- [Edit Table: disagreeing with the data](nodes-tables.md#edit-table-disagreeing-with-the-data)
- [Select One: stepping through a collection](nodes-tables.md#select-one-stepping-through-a-collection)
- [Join: four directions, and one key column](nodes-tables.md#join-four-directions-and-one-key-column)
- [Relabel: the third way to combine two tables](nodes-tables.md#relabel-the-third-way-to-combine-two-tables)
- [Stack Tables: the vertical Join](nodes-tables.md#stack-tables-the-vertical-join)

## [nodes-morphology.md](nodes-morphology.md) — morphology and synapses

- [Carry fields: getting a column onto the geometry](nodes-morphology.md#carry-fields-getting-a-column-onto-the-geometry)
- [Attach Attributes: the general form of Carry fields](nodes-morphology.md#attach-attributes-the-general-form-of-carry-fields)
- [Split Neurons: both halves of a filter, on a collection](nodes-morphology.md#split-neurons-both-halves-of-a-filter-on-a-collection)
- [Select Neurons: the geometry a table names](nodes-morphology.md#select-neurons-the-geometry-a-table-names)
- [Points in Volumes: the region a synapse is in](nodes-morphology.md#points-in-volumes-the-region-a-synapse-is-in)
- [Skeletons: which copy, and saying which one answered](nodes-morphology.md#skeletons-which-copy-and-saying-which-one-answered)
- [Synapses: what one point counts, and the confidence that was called a weight](nodes-morphology.md#synapses-what-one-point-counts-and-the-confidence-that-was-called-a-weight)
- [Synapses Between: a connection's synapses, bound at both ends](nodes-morphology.md#synapses-between-a-connections-synapses-bound-at-both-ends)
- [Synapses to Edges: connectivity counted where the synapses are](nodes-morphology.md#synapses-to-edges-connectivity-counted-where-the-synapses-are)
- [Distance between: how far apart, and how much of one is near the other](nodes-morphology.md#distance-between-how-far-apart-and-how-much-of-one-is-near-the-other)

## [nodes-connectivity.md](nodes-connectivity.md) — connectivity and networks

- [Connectivity similarity: Partner Vectors and Similarity Matrix](nodes-connectivity.md#connectivity-similarity-partner-vectors-and-similarity-matrix)
- [Network Metrics and Network Centrality: two nodes because cost is a node property](nodes-connectivity.md#network-metrics-and-network-centrality-two-nodes-because-cost-is-a-node-property)
- [Connectivity: hops and direction](nodes-connectivity.md#connectivity-hops-and-direction)
- [Paths: how does this reach that?](nodes-connectivity.md#paths-how-does-this-reach-that)
- [Influence: how much of this is attributable to that?](nodes-connectivity.md#influence-how-much-of-this-is-attributable-to-that)
- [Find Neurons: a filter builder, not a form](nodes-connectivity.md#find-neurons-a-filter-builder-not-a-form)

## [nodes-io.md](nodes-io.md) — input, output and ids

- [Text notes](nodes-io.md#text-notes)
- [Upload Table and Table from URL: somebody else's data](nodes-io.md#upload-table-and-table-from-url-somebody-elses-data)
- [Upload Mesh: somebody else's regions](nodes-io.md#upload-mesh-somebody-elses-regions)
- [Download: a side effect in a reactive graph](nodes-io.md#download-a-side-effect-in-a-reactive-graph)
- [Copy IDs: the second side effect, and the one that cannot ride a run](nodes-io.md#copy-ids-the-second-side-effect-and-the-one-that-cannot-ride-a-run)
- [IDs from Label: the inverse query](nodes-io.md#ids-from-label-the-inverse-query)
- [Input IDs: the ids themselves](nodes-io.md#input-ids-the-ids-themselves)
- [List CAVE tables and CAVE table info](nodes-io.md#list-cave-tables-and-cave-table-info)
- [Neurons to ZapBench Traces: a join across two modalities of one specimen](nodes-io.md#neurons-to-zapbench-traces-a-join-across-two-modalities-of-one-specimen)
- [ZapBench Traces and ZapBench to Neurons: the way back from activity](nodes-io.md#zapbench-traces-and-zapbench-to-neurons-the-way-back-from-activity)
