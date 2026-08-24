> [!WARNING] neuPrint-only
> CAVE and CATMAID backends do not have a query engine and will reject this node.

See [this documentation](https://neo4j.com/docs/cypher-manual/current/introduction/cypher-overview/) for an introduction to neo4j's Cypher query language.

```coda-graph
neuron.rawCypher as c {query: "MATCH (m:`male-cns_Meta`) WITH m.superLevelRois AS rois MATCH (neuron :`male-cns_Neuron`) WHERE (toLower(neuron.type) = \"da1_lpn\" OR toLower(neuron.instance) = \"da1_lpn\" OR toLower(neuron.hemibrainType) = \"da1_lpn\" OR toLower(neuron.synonyms) = \"da1_lpn\" OR toLower(neuron.systematicType) = \"da1_lpn\" OR toLower(neuron.flywireType) = \"da1_lpn\") RETURN apoc.map.setKey(properties(neuron), 'bodyId', toString(neuron.bodyId)) as neuron"}
out.table as t
c -> t
```

### Schema timing

Before the first run this node cannot know what columns the query will return, meaning downstream column pickers are empty. The moment a query executes, downstream pickers resolve. That schema is runtime state and is not saved, so after a page reload the node is unknown-shaped again until it re-runs. This is the same lifetime as the results it describes. See [Pivot](#core.pivot) for a similar limitation.


```coda-params
neuron.rawCypher: query
```
