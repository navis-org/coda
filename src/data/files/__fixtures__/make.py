"""
Regenerates the lazy-reader fixtures: `python3 make.py` from this directory (pyarrow >= 18,
polars >= 1.40).

Twelve synapse-like rows in three blocks of four, written three ways:

- synapses.parquet           sorted by pre_pt_root_id, so each row group's min/max brackets a
                             distinct run of ids and a lookup can skip whole groups
- synapses-unsorted.parquet  the same rows shuffled, so every group spans every id and nothing
                             can be skipped — the case the card warns about
- synapses.feather           lz4, the pyarrow default, in three record batches
- synapses-polars.feather    the same rows as polars writes them: lz4 frames carrying block
                             checksums (arrow-rs sets the flag, pyarrow does not), and strings
                             as Utf8View
- synapses-required.parquet  the same rows as non-nullable columns in tiny data pages: `hyparquet`
                             hands such a column back a chunk per page rather than one per group,
                             which is the path a lookup has to read in place rather than join

- decimals.parquet           an 18-digit id as DECIMAL(20, 0), the way a SQL export spells one,
                             beside a DECIMAL(10, 2) measurement and a DECIMAL(9, 0) count

`hash` is an int64 that is not an id by name but holds values past 2**53, which only the Parquet
statistics can reveal; `region` carries nulls.
"""

import random
from decimal import Decimal

import polars as pl
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq

BASE = 720575940600000000
pre = [BASE + i // 3 for i in range(12)]          # four pre ids, three rows each
post = [BASE + 1000 + (i * 7) % 12 for i in range(12)]
table = pa.table(
    {
        "pre_pt_root_id": pa.array(pre, pa.int64()),
        "post_pt_root_id": pa.array(post, pa.int64()),
        "size": pa.array([10 + i for i in range(12)], pa.int64()),
        "score": pa.array([i / 10 for i in range(12)], pa.float64()),
        "region": pa.array([None if i % 5 == 0 else f"R{i % 3}" for i in range(12)], pa.string()),
        "hash": pa.array([2**60 + i for i in range(12)], pa.int64()),
    }
)

pq.write_table(table, "synapses.parquet", row_group_size=4)

order = list(range(12))
random.Random(4).shuffle(order)
pq.write_table(table.take(order), "synapses-unsorted.parquet", row_group_size=4)

feather.write_feather(table, "synapses.feather", chunksize=4)
pl.from_arrow(table).write_ipc("synapses-polars.feather", compression="lz4")

required = pa.table(
    {name: table[name] for name in ["pre_pt_root_id", "post_pt_root_id", "size", "score"]},
    schema=pa.schema(
        [
            pa.field("pre_pt_root_id", pa.int64(), nullable=False),
            pa.field("post_pt_root_id", pa.int64(), nullable=False),
            pa.field("size", pa.int64(), nullable=False),
            pa.field("score", pa.float64(), nullable=False),
        ]
    ),
)
pq.write_table(
    required,
    "synapses-required.parquet",
    row_group_size=12,
    data_page_size=16,
    write_batch_size=4,
    use_dictionary=False,
)

pq.write_table(
    pa.table(
        {
            "root_id": pa.array(
                [Decimal(720575940600000001), Decimal(720575940600000002)], pa.decimal128(20, 0)
            ),
            "volume": pa.array([Decimal("1.25"), Decimal("2.50")], pa.decimal128(10, 2)),
            "count": pa.array([Decimal(7), Decimal(9)], pa.decimal128(9, 0)),
        }
    ),
    "decimals.parquet",
)
