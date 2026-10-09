"""
Regenerates the synthetic Delta table: `python3 make.py` from this directory (deltalake >= 1.6).

`edges/` is an edge list the way CAVE's exports are written by delta-rs, small enough to read at a
glance and shaped to reach every path the reader has:

- 18-digit ids, so the log's per-file stats hold numbers past 2^53 (`JSON.parse` would round them)
- a partition column, `pre_partition`, a range of `pre_pt_root_id` stored only in the log
- three appends, then a delete that rewrites a file (a `remove` beside an `add`), then a checkpoint
  at that version, then two more appends after it — so a replay reads the checkpoint *and* commits
- the last step compacts one partition into a ZSTD file, the way `optimize` leaves CAVE's tables

The other three tables here are copied verbatim from delta-rs's test data (Apache-2.0,
https://github.com/delta-io/delta-rs/tree/main/crates/test/tests/data), because delta-rs cannot
write deletion vectors and they are Spark's: `table-with-dv-small` (a deletion vector on disk),
`table_with_column_mapping` (logical names over physical ones), and
`table_with_partitioning_mapping` (a renamed partition column, and deletion vectors enabled).
"""

import shutil

import pyarrow as pa
from deltalake import DeltaTable, WriterProperties, write_deltalake

BASE = 720575940600000000
TABLE = "edges"
shutil.rmtree(TABLE, ignore_errors=True)


def batch(pres, posts, n_syn, score):
    return pa.table(
        {
            "pre_pt_root_id": pa.array([BASE + p for p in pres], pa.int64()),
            "post_pt_root_id": pa.array([BASE + 1000 + q for q in posts], pa.int64()),
            "n_syn": pa.array(n_syn, pa.int64()),
            "score": pa.array(score, pa.float64()),
            "nt": pa.array(["ach" if i % 2 else "gaba" for i in range(len(pres))], pa.string()),
            "pre_partition": pa.array([p // 10 for p in pres], pa.int32()),
        }
    )


write_deltalake(TABLE, batch([1, 1, 2, 12], [1, 2, 3, 4], [5, 1, 3, 7], [0.9, 0.2, 0.5, 0.8]),
                partition_by=["pre_partition"])
write_deltalake(TABLE, batch([3, 13, 13], [5, 6, 7], [2, 4, 1], [0.4, 0.6, 0.1]), mode="append",
                partition_by=["pre_partition"])
write_deltalake(TABLE, batch([21, 22], [8, 9], [6, 3], [0.7, 0.3]), mode="append",
                partition_by=["pre_partition"])
DeltaTable(TABLE).delete("n_syn < 2")
DeltaTable(TABLE).create_checkpoint()
write_deltalake(TABLE, batch([4, 23], [10, 11], [8, 2], [0.95, 0.55]), mode="append",
                partition_by=["pre_partition"])
write_deltalake(TABLE, batch([5], [12], [9], [0.85]), mode="append", partition_by=["pre_partition"])
DeltaTable(TABLE).optimize.compact(
    partition_filters=[("pre_partition", "=", "0")],
    writer_properties=WriterProperties(compression="ZSTD"),
)
DeltaTable(TABLE).vacuum(retention_hours=0, enforce_retention_duration=False, dry_run=False)
print(DeltaTable(TABLE).version(), len(DeltaTable(TABLE).file_uris()), "files")
