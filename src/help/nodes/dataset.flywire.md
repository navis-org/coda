### Materialization

FlyWire FAFB has two materializations: `783` (matching the Nature paper package) and `630` (matching the preprint).

### Annotations

Two sets exist:

1. Structured hierarchical annotations — super class, class, type, side — from Schlegel et al., 2024; Matsliah et al., 2024; Berg et al., 2024.
2. Free-form community annotations.

> [!WARNING] On its own, this node uses `hierarchical_neuron_annotations`
> That CAVE table holds a by now **outdated** version of the hierarchical annotations.

You do not have to wire the current ones up by hand. **New ▸ FlyWire FAFB public** and the **Workflow Wizard** both open this dataset with the full setup in front of it: the latest hierarchical annotations from the [flywire_annotations](https://github.com/flyconnectome/flywire_annotations) repository, root ids repaired, and the community annotations joined in as tags. It arrives as one folded frame called *FlyWire annotations* — open it to see the six cards, or leave it alone.

The AI assistant knows to build the same chain. The zoo's *FlyWire FAFB Full Stack* is the same graph with the viewers already arranged.

### Connectivity

FlyWire FAFB is one of the CAVE datastacks offering a server-side "view" into the synapse table that aggregates connections between neurons, which makes small queries reasonably fast.

> [!NOTE] Speeding up large connectivity queries
> Every dataset node, this one included, can use a local copy of the edge table — the `Edge data`
> button on the card.

### For datastacks beyond FlyWire

[Custom CAVE](#dataset.cave) is the general escape hatch. Name the datastack and which table holds neurons.

```coda-params
dataset.flywire: version
```
