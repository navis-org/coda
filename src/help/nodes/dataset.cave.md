## What Custom CAVE does

Custom CAVE connects to any CAVE datastack that Coda doesn't ship a dedicated node for. For FlyWire, BANC and MICrONS, use their own nodes instead: they come with sensible defaults already filled in.

A CAVE datastack is a fairly loose collection of data. There is always a segmentation and meshes, but skeletons are not guaranteed, and annotation tables may or may not exist. Where they do, their names and contents differ from datastack to datastack. With neuPrint, Coda can offer the same complete interface for every dataset; with CAVE, you have to know what is in the datastack and set the node up accordingly.

## Settings

```coda-params
dataset.cave: server, datastack, version, neuronTable, idColumn
```

- `Global server` is the CAVE deployment that lists the datastack. FlyWire, BANC and MICrONS are on `https://global.daf-apis.com` (the default); H01 is on `https://global.brain-wire-test.org`. Each deployment has its own sign-in, so add a token for it under Connections ▸ CAVE. A token from one deployment is refused by another.
- `Datastack` is the datastack's name as that server lists it, e.g. `flywire_fafb_public`. Once you are signed in, the field suggests the datastacks your account can see. Note that this lists what your account may *view*, which can be more than it may query, because CAVE checks each dataset's terms of service separately. You can always type in a name that is not in the list, e.g. for a private datastack.
- `Materialization` is the version to query. Leave it empty to always use the newest one. Coda only queries materialized versions, not the live data. Materializations expire after a while; if a pinned one stops working, the card tells you.
- `Neuron table` (optional) is a table with one row per neuron, e.g. `proofread_neurons`, a nuclei table or an annotation table. Leave it empty if the datastack has none and you are wiring annotations in instead.
- `ID column` (optional) is the column holding root IDs, usually `pt_root_id`.
- `Synapse table` (optional) is the table holding the synapses. If you leave it empty, the node uses the one the datastack declares, and the option tells you which that is. Pick another one if the declaration is missing or out of date.
- `Connection view` (optional) is a server-side summary of the synapse table, if the datastack publishes one (see below).

## Annotations

A CAVE datastack doesn't declare any particular table as its cell typing, so there is nothing for this node to fall back on. Labels come from whatever you wire into the `Annotations` input, typically a [CAVE table](#annotation.caveTable).

## Connectivity

> [!NOTE] Connection views are much faster
> Some datastacks publish a "view" that adds up synapses into weighted connections on the server.
> If you name one under `Connection view`, Coda uses it for connectivity queries. Otherwise it falls
> back to querying the synapse table itself, which can be slow.
