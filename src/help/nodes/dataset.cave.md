### CAVE gotchas

A CAVE datastack is a free-form collection of data: there is always a segmentation and meshes, but skeletons are not guaranteed. Annotation tables may or may not exist, and where they do they come with unpredictable names and contents.

So unlike neuPrint, where Coda can offer a complete interface whatever the dataset, *you* have to know what is in the datastack and wire it up.

### Materialization

CAVE supports queries against the live data; Coda does not. Queries run against one of the available materialization versions.

### Annotations from the socket, not this node

Annotations come from whatever you wire to the **Annotations** socket. A CAVE datastack does not advertise any single annotation table, so there is nothing for a setting here to default to.

### Parameters

- **Global server**: the CAVE deployment that lists the datastack. FlyWire, BANC and MICrONS are on `https://global.daf-apis.com`, the default; H01 is on `https://global.brain-wire-test.org`. Each deployment has its own sign-in, so add one for it in **Connections ▸ CAVE** — a token from one is refused by another.
- **Datastack**: the name as that server lists it (e.g. `flywire_fafb_public`). Once you are signed in to the deployment this field completes from the datastacks your account can see. It shows what your account may *view*, which can be more than it may query — CAVE checks each dataset's terms of service separately. It stays a text field either way, so a private datastack the listing leaves out can still be typed in.
- **Materialization**: which version to query; empty tracks the newest the server reports.
- **Neuron table** (optional): a CAVE table with one row per neuron (e.g. `proofread_neurons`). Leave empty if the datastack has none and you are wiring annotations instead.
- **ID column** (optional): which column holds root IDs, usually `pt_root_id`.
- **Connection view** (optional): a server-side roll-up of synapses, if published.

> [!NOTE] Connectivity views
> Some datastacks publish a "view" into the raw synapse table that aggregates synapses into
> weighted connections on the server side, which is much more efficient. Coda uses it if provided
> and falls back to querying the synapse table, which can be slow.

```coda-params
dataset.cave: server, datastack, version, neuronTable, idColumn
```
