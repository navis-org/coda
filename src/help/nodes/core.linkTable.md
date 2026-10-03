## What Link Table does

Link Table connects a large Parquet or Feather file, either on your disk or at a URL, to your workflow without loading it. It only reads the file's footer: the columns, their types, the number of rows and how the file is divided into blocks. That is enough for every column picker downstream to show the file's columns straight away, however large the file is.

To get actual rows out of the file, wire it into [Read Rows](#core.readRows). Read Rows reads only the blocks that hold the rows you ask for, in a background worker. Looking up three neurons in a 5 GB synapse table therefore reads only a small part of the file, and the canvas stays responsive while it does.

```coda-graph
caption: Find neurons in the connectome, then look up their rows in the file.
dataset.hemibrain as ds
neuron.findNeurons as find
core.linkTable as file
core.readRows as rows
out.table as table
ds -> find
file:file -> rows:file
find:neurons -> rows:ids
rows -> table
```

Typical uses:

- a connectome's full synapse table (hundreds of millions of rows) when you only need the synapses of a handful of neurons
- a whole-dataset edge list or connection table released as Parquet
- a large annotation or measurement dump, e.g. another lab's cell typing or per-neuron morphometrics, that is too big to upload
- a public release on a bucket (`https://`, `gs://`, `s3://`) that a shared workflow should read without anyone downloading it first
- a Delta table, such as CAVE's exports (see "Delta tables" below)

For a table of a few thousand rows, [Upload Table](#core.uploadTable) is simpler: its output is an ordinary table that every node accepts.

## Link Table or Upload Table?

|                | Link Table                               | Upload Table                          |
| -------------- | ---------------------------------------- | ------------------------------------- |
| The data       | stays on disk or on the server           | is copied into this browser's storage |
| Reading        | only the blocks a lookup needs           | all of it, into memory, on every run  |
| Size           | many gigabytes                           | warns at 50 MB, refuses above 200 MB  |
| Formats        | Parquet, Feather, Delta tables           | CSV, TSV                              |
| After a reload | see below                                | always there, in any browser          |
| Output         | a table file, which only Read Rows reads | an ordinary table                     |

## Local files and URLs

The file itself is never copied, neither into the workflow nor into browser storage. What the node remembers depends on where the file is:

|                      | Local file, Chrome / Edge              | Local file, Firefox / Safari             | URL                              |
| -------------------- | -------------------------------------- | ---------------------------------------- | -------------------------------- |
| What is kept         | a handle to the file on disk           | the file, for as long as the tab is open | the address                      |
| After a reload       | back, at most after a click on `Allow access` | choose the file again; the card names it | back                      |
| In a shared workflow | the recipient chooses their own copy   | the recipient chooses their own copy     | works as is                      |
| Read from            | your disk, only the parts needed       | your disk, only the parts needed         | the server, via range requests   |

> [!WARNING] Local files don't travel with the workflow
> The `.coda.json` file only names a local file; it does not contain it. A colleague opening your
> workflow has to pick the same file on their machine. A URL needs no such step, so if the data is
> already published somewhere, linking the URL is the reproducible choice.

## Delta tables

To read a Delta table, paste the URL of its folder, i.e. the one containing `_delta_log/`. For example:

`gs://mat_dbs/public/deltalake_exports/flywire_fafb_production/v783/valid_connection_v2/pre_pt_root_id`

For a Delta table, the node reads the transaction log instead of a footer. That tells it which data files currently make up the table and what each of them holds. The card then shows something like `Delta · version 596 · 76,460,814 rows · 33 files`.

- The log records the smallest and largest id in each data file, so a lookup only opens the files that can contain the ids you ask for. Looking up a single neuron in a table of dozens of files typically reads just one of them.
- The version is pinned: everything downstream keeps reading the version shown on the card, even if new commits land afterwards. Press ⟳ to move to the newest version.
- Deleted and updated rows (Delta's deletion vectors) are left out, and renamed columns show up under their current names.
- If a table uses a Delta feature that Coda can't read yet, the node refuses it and names the feature.
- Delta tables on your own disk are not supported. Either publish the table or export it once as a Parquet file.

## Filtering

You can put a [Filter Table](#core.filterTable) between Link Table and Read Rows. The filter is then applied to the rows each lookup fetches, as they are read; it does not scan the whole file.

## Making lookups fast

A lookup can only skip a block of the file if that block cannot contain any of the ids you ask for. How fast lookups are therefore depends on how the file is ordered:

- **Parquet sorted by the id column** is the fast case. Each row group records its smallest and largest value, and every group outside the ids you ask for is skipped without being read.
- **Feather** files don't record these ranges. Pick the id column under `Index columns`: the first lookup then records each batch's range as it reads (kept in this browser, for this exact file), and every later lookup can skip batches just like sorted Parquet.
- **Shuffled files**, where every block contains a bit of every id, can't be sped up either way: every block has to be read. Read Rows tells you when a lookup could not skip anything.

Sorting a file once is usually worth it. In pandas:

`pd.read_parquet(path).sort_values("pre_pt_root_id").to_parquet("sorted.parquet")`

## Id columns

A 64-bit integer column can hold either neuron ids, which must stay exact, or counts, which should be numbers. With `Detect id columns` ticked, a column is read as text if its name suggests it holds ids (`root_id`, `bodyId`, `pre_pt_root_id`) or if Parquet's statistics show values too large to be stored as a number. Untick it to choose the text columns yourself under `Read as text`.

```coda-params
core.linkTable: autoText, indexColumns
```

If a value is too large for a number column, Read Rows stops with an error naming the column instead of rounding it into a different neuron's id. Feather files have no statistics, so this is most likely to happen there with an id column called something like `pre`. The error message tells you which setting to change.

## Limits

- Parquet files must be compressed with SNAPPY or ZSTD, or not at all. These are the defaults of pandas, pyarrow, polars and Delta. Files using GZIP, LZ4 or BROTLI are refused, and the error tells you how to rewrite the file.
- CSV files are not supported: they have no footer to locate rows with, so every lookup would have to read the whole file. Convert to Parquet once, sorted by the column you look ids up in.
- Columns holding lists, structs or maps are left out. The card lists them.
- A URL must be on a server that allows cross-origin requests, reports the file's size and answers range requests. If the server sends the whole file instead, the node refuses rather than downloading it. Files under 64 kB are the exception and are simply read whole.
- If a file has changed since it was linked, Read Rows refuses to read it. Press ⟳ on the card to read the footer again. A local file is then read afresh if the browser remembers it; otherwise the card asks you to choose it again.
