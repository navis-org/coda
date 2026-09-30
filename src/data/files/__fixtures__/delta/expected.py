"""Writes expected.json: every table here as delta-rs reads it — the reference the tests compare to."""
import json
import pyarrow as pa
from deltalake import DeltaTable, QueryBuilder

out = {}
for name in ["edges", "table-with-dv-small", "table_with_column_mapping", "table_with_partitioning_mapping"]:
    dt = DeltaTable(name)
    t = pa.table(QueryBuilder().register("t", dt).execute("select * from t").read_all())
    rows = [
        {k: (str(v) if isinstance(v, int) and abs(v) > 2**53 else v) for k, v in row.items()}
        for row in t.to_pylist()
    ]
    out[name] = {"version": dt.version(), "columns": t.column_names, "rows": rows}
json.dump(out, open("expected.json", "w"), indent=1, sort_keys=True)
print({k: (v["version"], len(v["rows"])) for k, v in out.items()})
