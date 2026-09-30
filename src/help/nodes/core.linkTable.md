## A table you point at, not one you copy

Link Table reads only a Parquet or Feather file's footer — its columns, their types, how many rows,
how the file is divided into blocks — and hands that on. Nothing of the table itself is loaded.
**Read Rows** then reads just the blocks that hold the rows you ask for, in a background worker,
so a lookup of three neurons in a 5 GB synapse table reads a small part of it and the canvas stays
responsive while it does.

```coda-graph
caption: The ids come from the connectome; the rows come from the file. Only the matching blocks are read.
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

## What it is for

- A connectome's **full synapse table**, hundreds of millions of rows, when you want the synapses
  of a handful of neurons.
- A **whole-dataset edge list** or connection table released as Parquet.
- A large **annotation or measurement dump** — another lab's cell typing, per-neuron morphometrics
  — too big to upload.
- A **public release on a bucket** (`https://`, `gs://`, `s3://`) that a shared workflow should
  read without anybody downloading it first.
- A **Delta table** — CAVE's exports, for one: paste the table's folder, below.

For a table of a few thousand rows, [Upload Table](#core.uploadTable) is simpler: its output is an
ordinary table every node accepts.

## Where the data lives

The file is never copied — not into the workflow, not into browser storage. What differs is how
the node keeps hold of it:

| | Local file, Chrome / Edge | Local file, Firefox / Safari | URL |
| --- | --- | --- | --- |
| What is kept | a handle to the file on disk | the file, for as long as the tab is open | the address |
| After a reload | back — at most a click on **Allow access** | choose the file again; the card names it | back |
| In a shared workflow | the recipient chooses their own copy | the recipient chooses their own copy | works as is |
| Read from | your disk, the parts needed | your disk, the parts needed | the server, by range request |

> [!WARNING] A local file does not travel with the workflow
> The `.coda.json` names the file; it does not contain it. A colleague opening the workflow picks
> the same file on their machine. A URL has no such step, which makes it the reproducible choice
> for anything already published.

## Delta tables

Paste the URL of a Delta table's folder — the one holding `_delta_log/`, such as
`gs://mat_dbs/public/deltalake_exports/flywire_fafb_production/v783/valid_connection_v2/pre_pt_root_id`
— and the card reads its transaction log rather than a footer: which data files currently make up
the table, and what each one holds. The card shows `Delta · version 596 · 76,460,814 rows · 33 files`.

- **A lookup opens only the files that can hold the ids.** Each file's smallest and largest id is
  in the log, so a lookup of one neuron in a table of dozens of files reads one of them.
- **The version is pinned.** Everything below the card reads the version it showed, however many
  commits land afterwards. Press ⟳ to move to the newest.
- **Deleted and updated rows are left out** the way Delta records them (deletion vectors), and
  renamed columns carry their current names.
- A table using a Delta feature Coda does not read yet is refused by name rather than read as if
  it were plain. A Delta table on your own disk is not supported: publish it, or export it once as
  a Parquet file.

## Filtering

A [Filter Table](#core.filterTable) between this and its reader drops rows as they are read, from
the rows each lookup fetched — never by scanning the file.

## Link Table or Upload Table

| | Link Table | Upload Table |
| --- | --- | --- |
| The data | stays on disk or on the server | copied into this browser's storage |
| Read | only the blocks a lookup needs | all of it, into memory, on every run |
| Size | many gigabytes | warns at 50 MB, refuses above 200 MB |
| Formats | Parquet, Feather, Delta tables | CSV, TSV |
| After a reload | see above | always there, in any browser |
| Output | a table file, which only Read Rows reads | an ordinary table |

## Making lookups fast

A lookup can only skip a block that cannot hold any of the ids it is asked for, so speed depends on
how the file is ordered.

- **Parquet sorted by the id column** is the fast case: each row group records its smallest and
  largest value, and every group outside the ids is skipped without being read.
- **Feather** records no such ranges. Choose the id column under `Index columns` and the first
  lookup records each batch's range as it reads — kept in this browser for this exact file — so
  every later lookup skips as sorted Parquet does.
- **A shuffled file**, where every block holds some of every id, cannot be sped up by either:
  every block has to be read. Read Rows says so when a lookup skipped nothing.

Sorting once is usually worth it. In pandas:
`pd.read_parquet(path).sort_values("pre_pt_root_id").to_parquet("sorted.parquet")`.

## Id columns are read as text

A 64-bit integer column can hold neuron ids, which must stay exact, or counts, which should be
numbers. `Detect id columns` reads a column as text when its name says it is an id (`root_id`,
`bodyId`, `pre_pt_root_id`) or when Parquet's statistics show values too large for a number.
Untick it to choose exactly, under `Read as text`.

```coda-params
core.linkTable: autoText, indexColumns
```

A value too large for a number column is refused when read, naming the column, rather than
rounded into a different neuron. Feather keeps no statistics, so an id column called something
like `pre` is where that happens — the message says which setting fixes it.

## Limits

- **Parquet compressed with SNAPPY, ZSTD or not at all** — the defaults of pandas, pyarrow,
  polars and Delta. GZIP, LZ4 and BROTLI are refused with the line that rewrites the file.
- **A CSV is refused.** It has no footer to find a row in, so every lookup would read all of it.
  Convert it to Parquet once, sorted by the column you look ids up in.
- **Columns holding lists, structs or maps are left out**, and the card names them.
- **A URL** must allow cross-origin requests, report its size, and answer range requests. A server
  that sends the whole file instead is refused rather than downloaded — except a file under 64 kB,
  which is read whole anyway.
- **A file rewritten since it was linked** is refused by Read Rows. Press ⟳ on the card to read its
  footer again. A local file is then read afresh where the browser remembers it; where it does not,
  the card asks you to choose the file again.
