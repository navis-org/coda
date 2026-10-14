## What VFB Neurons does

VFB Neurons looks each neuron of a connectome table up in [Virtual Fly Brain](https://virtualflybrain.org) and adds four columns: the neuron's VFB id, its cell type as an FBbt term, the name of that term, and how far up the ontology the term was found. The FBbt term is what the other VFB nodes read, so this is usually the first VFB node in a workflow.

```coda-graph
caption: The papers describing a set of MaleCNS neurons' types.
dataset.malecns as ds "MaleCNS"
neuron.findNeurons as fn
vfb:neurons as vn
vfb:publications as pubs
out.table as tbl
ds -> fn:dataset
ds -> vn:dataset
fn -> vn:neurons
vn -> pubs:types
pubs -> tbl
```

## Inputs

Wire the neuron table into `Neurons` and the dataset it came from into `Dataset`. The dataset is needed because a neuron id only means something within one release of a connectome.

```coda-params
vfb:neurons: idColumn
```

VFB holds these releases: hemibrain v1.2.1, male CNS v0.9 and v1.0, MANC v1.0 and v1.2.1, Optic Lobe v1.0.1, FlyWire 783, and BANC 626 and 888. A dataset at any other version is refused, and the card says which versions VFB has. Pick one of those on the Dataset node rather than looking ids up across releases: the same id at another release can be a different neuron.

## The columns it adds

- `vfbId`: the neuron's own VFB id, e.g. `VFB_jrmc2094`.
- `fbbtId` and `fbbtLabel`: its cell type, e.g. `FBbt_00100234`, *mushroom body output neuron 1*.
- `fbbtClimbed`: how many steps above VFB's own annotation the type was found. Usually 0.

All rows are kept. A neuron VFB does not hold, or holds without a cell type, gets empty VFB columns, and the card counts each case in a warning.

## How the type is chosen

VFB annotates a neuron with several FBbt terms at once. MBON01 in the male CNS is *mushroom body output neuron 1*, but it is also an *adult cholinergic neuron*-style class inferred from its transmitter. The node takes the most specific term that some connectome uses as a name for a cell type. FBbt records those names, e.g. `name_in_hemibrain: PFNa`, so a general class like *adult cholinergic neuron* never wins.

Where VFB's own term is finer than any connectome's typing, the node walks up the ontology to the nearest named type. Hemibrain annotates its PFNa neurons with one class per protocerebral bridge glomerulus, and none of those is a name anywhere, so they come out as PFNa with `fbbtClimbed` of 1.

Measured against hemibrain's own types, 86% of hemibrain neurons come out on the term FBbt names after their hemibrain type. Most of the rest are neurons VFB annotates with a coarser class to begin with.

> [!NOTE] Empty rather than general
> A neuron whose only terms are general classes gets an empty type rather than one of those classes. The same goes for a neuron with two unrelated named types. Each case is counted on the card.
