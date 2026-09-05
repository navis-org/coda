### CAVE gotchas

A CAVE datastack is a pretty "free-form" collection of data: there is always a segmentation + meshes but e.g. skeletons are not guaranteed. Likewise, annotation tables may or may not exist and if they do, they come with unpredictable names and contents.

Bottom line: unlike neuPrint where Coda is able to offer a pretty complete interface no matter the dataset, for CAVE dataset the onus on the user to know what's where. *You* have to know what's in the datastack and wire it up!

### Materialization

CAVE technically supports queries against the actual live data but Coda does not. We currently only allow queries against one of the available materialization versions.

### Annotations from the socket, not this node

Annotations come from whatever you wire to the **Annotations** socket, not from a setting here. This is deliberate: a CAVE datastack currently doesn't advertise any single annotation table - you have to know where annotations should come from and wire it in.

### Parameters

- **Datastack**: name as the CAVE info service lists it (e.g., `flywire_fafb_public`). Once a CAVE token is saved in **Connections**, this field completes from the datastacks that token can see — the listing needs a token, so signing in is what fills it. It shows what your account may *view*, which can be more than it may query — CAVE checks each dataset’s terms of service separately. It stays a text field either way: a datastack that isn't listed (a private one, or one on a deployment Coda hasn't asked) can still be typed in.
- **Materialization**: which version to query; empty tracks the newest the server reports
- **Neuron table** (optional): name a CAVE table with one row per neuron (e.g., `proofread_neurons`); leave empty if the datastack has none and you're wiring annotations instead
- **ID column** (optional): which column holds root IDs (usually `pt_root_id`)
- **Connection view** (optional): server-side roll-up of synapses, if published

> [!NOTE] Connectivity views
> Some datatsacks provide a "view" into the raw synapse table that aggregates synapses into weighted connections on the server side, which is much more efficient. Coda will use that view if provided and fall back to querying the synapse table (which can be slow) if not. If you know the view name, you can specify it here.

```coda-params
dataset.cave: datastack, version, neuronTable, idColumn
```
