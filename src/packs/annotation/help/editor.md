## What Annotate does

Annotate shows the annotations of the incoming neurons as a table, read live from FlyTable or SeaTable tables, from Clio datasets, or from a CSV file on your computer. You can edit the cells directly on the card, and each edit is written straight back to the table, dataset or file.

```coda-graph
caption: Annotate the neurons a query returned. A Scatter Plot's Selected output can be wired in the same way.
dataset.hemibrain as hb
neuron.findNeurons as find
annotation:editor as an
hb -> find
find -> an
```

The node passes its neurons on unchanged, so you can put it in the middle of a chain. Pressing **Run** does not read or write anything: the card reads the annotations as soon as neurons arrive on `Neurons`, so the upstream node has to have run.

## Setting up a tab

Each tab on the card is one table or dataset, and **+** adds another. In each tab, pick the `Backend` and then fill in:

- **FlyTable or SeaTable:** the `Base`, the `Table` and the `Key column`. The key column is the table's column holding the neuron id; on FlyWire's `info` table that is the root id column of the release your ids come from, e.g. `root_783`.
- **CSV file on this computer:** the `File` and its `Key column`, the column holding the neuron id as named in the file's first row. Edits are written into the file itself, so keep a copy if you are unsure. Only Chromium browsers (Chrome, Edge) can write to a file on disk, so a CSV tab works only there; other browsers say so instead. In Chrome the file is remembered after a reload, but you may need to click `Allow editing` once.
- **Clio:** the `Dataset`, picked from the datasets Clio lists once your token is in Connections (without one, type it as Clio spells it, e.g. `CNS`).

You also need a token, which goes into Connections ▸ Annotations: an account token for FlyTable or SeaTable, or a ClioStore token for Clio.

Once a tab's settings are complete they fold away behind the tab's name. Click the name to see them again.

Use `Fields ▾` to choose which of the table's columns (or the dataset's fields) to show; they are listed alphabetically. Some columns are shown but cannot be edited because the backend does not allow it: the id, formula columns and columns locked in the base. Clio's `_user` and `_time` fields, which record who last changed each field and when, are not offered.

Clio has nothing at all for a body nobody has annotated yet, so by default such a body is counted as not in the dataset and gets no row. Tick `Unannotated` in a Clio tab's settings to show these bodies as empty rows that you can annotate. Leave it off when your selection may hold ids from another dataset: Clio accepts annotations for any body id, including ones the dataset does not have.

A CSV tab has the same option, `Missing ids`: ticked, a neuron the file has no row for is shown as an empty row, and its first edit adds that row to the end of the file. Every cell of a CSV file is treated as text.

## Editing

A cell is written when you leave it or press Enter. Escape abandons the edit. A cell you have changed is drawn in italics with a bar on its left, until you undo the change. Select columns offer their options, checkbox columns show a checkbox, and list columns take comma-separated values.

> [!WARNING] Edits are written immediately
> There is no save step. Whatever you type goes into the table that everyone else reads, under your
> account. **Undo** writes the previous value back (newest change first), and **Log** downloads every
> change this card made in this session as a CSV.

Before writing, the card reads the cell again. If somebody else has changed it since the card showed it, nothing is written: the cell is marked and shows the current value instead. Edit it again if you want to overwrite it.

To set one field on many rows at once, tick those rows (the box in the header ticks every row shown) and use the `Set … to …` line above the table. Leaving the value empty clears the field. **Undo** reverts the whole fill in one go.

## Side effects

Clio tabs have one optional side effect, off unless you switch it on:

- `Instance`: keeps `instance` in step with `type` by writing `{type}_{side}`, using the neuron's `soma_side` or, if it has none, its `root_side`. Setting the type of a right-side neuron to `LC4a` therefore writes `LC4a_R` into `instance`. A neuron with neither gets just the type, and clearing the type clears the instance.

**Undo** also reverts the side effect together with the change that caused it.

## Which neurons are shown

Every neuron arriving on `Neurons` is looked up by its `ID column`. One id can match several rows (FlyWire's `info` table has a few root ids more than once), in which case each row is shown, numbered, and can be edited on its own.

On the canvas the card shows the first 40 rows; expand it to see all of them. For selections of more than 2,000 neurons, the card asks before reading them.

### Neurons from several datasets

If your selection mixes datasets, give each tab its own table and set its `Serves` field to the datasets that table is for, e.g. `flywire`. A neuron belongs to a dataset if its id is qualified (`flywire:7205…`) or if the `Dataset column` says so (in a BigClust project, that is the `dataset` column). Each tab shows only the neurons it serves, and the card tells you how many neurons no tab serves.

With several tabs, **Undo** reverts the last change of the current tab's table, while **Log** downloads the changes from all tabs.
