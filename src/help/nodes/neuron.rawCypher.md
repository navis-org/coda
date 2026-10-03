## What Cypher does

Cypher runs a query you write yourself against a neuPrint dataset and returns the result as a table. neuPrint stores its data in a Neo4j graph database, and that database holds a lot more than the other nodes expose. With this node you can ask it anything, using Neo4j's query language, Cypher. See [the Cypher manual](https://neo4j.com/docs/cypher-manual/current/introduction/cypher-overview/) for an introduction.

```coda-graph
caption: A query written by hand, shown in a Table.
neuron.rawCypher as c {query: "MATCH (m:`male-cns_Meta`) WITH m.superLevelRois AS rois MATCH (neuron :`male-cns_Neuron`) WHERE (toLower(neuron.type) = \"da1_lpn\" OR toLower(neuron.instance) = \"da1_lpn\" OR toLower(neuron.hemibrainType) = \"da1_lpn\" OR toLower(neuron.synonyms) = \"da1_lpn\" OR toLower(neuron.systematicType) = \"da1_lpn\" OR toLower(neuron.flywireType) = \"da1_lpn\") RETURN apoc.map.setKey(properties(neuron), 'bodyId', toString(neuron.bodyId)) as neuron"}
out.table as t
c -> t
```

The query is sent exactly as you typed it. The column names in the result are whatever your query returns, e.g. `RETURN n.bodyId AS neuronId` gives you a column called `neuronId`. Column types are worked out from the values.

> [!WARNING] neuPrint only
> CAVE and CATMAID datasets have no query engine and don't work with this node.

The neuPrint servers are shared and only accept read-only queries. It's a good idea to add a `LIMIT` while you are trying out a query.

## Column pickers

Until the query has run, the node can't know which columns it will return, so the column pickers on nodes downstream are empty. They fill in as soon as the query has run. This information is not saved with the workflow, so after reloading the page the pickers are empty again until you re-run the query. [Pivot](#core.pivot) behaves the same way.

```coda-params
neuron.rawCypher: query
```
