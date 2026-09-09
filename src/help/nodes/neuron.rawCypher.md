> [!WARNING] neuPrint-only
> CAVE and CATMAID backends have no query engine and reject this node.

See [the Cypher manual](https://neo4j.com/docs/cypher-manual/current/introduction/cypher-overview/) for an introduction to neo4j's query language.

```coda-graph
neuron.rawCypher as c {query: "MATCH (m:`male-cns_Meta`) WITH m.superLevelRois AS rois MATCH (neuron :`male-cns_Neuron`) WHERE (toLower(neuron.type) = \"da1_lpn\" OR toLower(neuron.instance) = \"da1_lpn\" OR toLower(neuron.hemibrainType) = \"da1_lpn\" OR toLower(neuron.synonyms) = \"da1_lpn\" OR toLower(neuron.systematicType) = \"da1_lpn\" OR toLower(neuron.flywireType) = \"da1_lpn\") RETURN apoc.map.setKey(properties(neuron), 'bodyId', toString(neuron.bodyId)) as neuron"}
out.table as t
c -> t
```

### Schema timing

Before the first run this node cannot know what columns the query will return, so downstream column pickers are empty. They resolve the moment a query executes. That schema is runtime state and is not saved, so after a page reload the node is unknown-shaped again until it re-runs. See [Pivot](#core.pivot) for the same limitation.

```coda-params
neuron.rawCypher: query
```
