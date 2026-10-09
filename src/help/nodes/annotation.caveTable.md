## What CAVE table does

CAVE table reads an annotation table (or view) from a CAVE datastack and turns it into neuron labels. Wire its output into the `Annotations` input of a CAVE dataset node, and the columns of the table show up as properties of the neurons: you can search by them, filter on them and colour by them. A `cell_type` column is renamed to `type`, which is the name Coda reads cell types from.

> [!WARNING] CAVE only
> This node only works with CAVE datasets.

The table needs a column with root ids (`ID column`, `pt_root_id` by default). Tables that reference another table work too: in that case, set `ID column` to the column of the referenced table that holds the root id.

## Which datastack

There are two ways to tell the node where the table lives:

- Wire a Dataset into its `Dataset` input. This is the usual way, and it works even if the same Dataset is the one receiving the annotations, so `Dataset → CAVE table → Dataset` is fine. Wiring a Dataset is also how you read a table from a different CAVE deployment.
- Type the datastack and materialization into `Datastack`, e.g. `flywire_fafb_public:783`. This is ignored while a Dataset is wired.

Once the datastack is known (and you have a CAVE token), `Table` offers the datastack's tables and views. You can still type any name.

## Long tables and pivoting

Some annotation tables are in long format, with one row per (neuron, kind, value). BANC's `codex_annotations` is an example: a `classification_system` column says what kind of annotation a row is, and `cell_type` holds the value. To turn such a table into one column per kind, set `Pivot on` to the column naming the kind and `Value column` to the column holding the annotation itself.

```coda-params
annotation.caveTable: pivotOn, valueColumn
```

Leave `Pivot on` empty if the table already has one row per neuron. In that case you can use `Columns` to pick which columns to keep; by default you get all of them.

## Chaining annotation sources

CAVE table has an `Annotations` input of its own, so you can chain it with [FlyTable](#annotation.flyTable), [SeaTable](#annotation.seaTable), [Google Sheet](#annotation.googleSheet) and other CAVE tables. Each node adds its columns to the ones arriving from upstream, matched on neuron id. A neuron that only one of the sources knows about keeps its labels. If two sources have a column of the same name, the later one in the chain wins, so the order of the chain matters.

The output is an ordinary table of neurons, so you can put a Filter, Sort or any other table node in the chain before it reaches the Dataset.
