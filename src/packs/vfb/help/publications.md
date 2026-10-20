## What VFB Publications does

VFB Publications lists the papers [Virtual Fly Brain](https://virtualflybrain.org) cites for each cell type in a table: one row per type and paper, with the citation, title, year, DOI and PubMed id. Wire it after [VFB Neurons](#vfb:neurons), which adds the `fbbtId` column it reads.

```coda-graph
caption: Papers on the types of a set of FlyWire neurons.
dataset.flywire as ds "FlyWire"
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

## Settings

```coda-params
vfb:publications: typeColumn, roles
```

`Cited as` picks which kinds of citation to list. FBbt records why each paper is attached to a type:

- "Defines the type": the paper the type's definition is based on.
- "Source of a name": the paper a name or synonym comes from, e.g. the connectome paper that named it.
- "Text-mined mention": a paper that mentions the type, found automatically.

Text-mined mentions are off by default. They are often attached to broad classes rather than to one cell type, and a type of yours may pick up dozens of papers that only mention it in passing.

## The output

Rows are grouped by type, in the order the types first appear in your table, with defining papers first and then the newest. `roles` lists every role a paper plays for that type, so a paper that both defines a type and names it is one row reading `def, syn`. In a [Table](#out.table), `doi` and `pmid` are links you can click.

The `neurons` column counts how many rows of your table carry the type.

> [!NOTE] Papers about the type
> These papers describe the cell type, not the particular neurons in your table. A paper about MBON01 is listed once for MBON01, however many MBON01 neurons you looked up.
