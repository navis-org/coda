"""Trim SEAM's rv4 suggestion set to a few tips, for Coda's tests.

Run from the repo root with SEAM's rv4 fixture directory as the argument:

    python3 -I src/packs/seam/__fixtures__/make_rv4.py ~/Github/SEAM/data/fixtures/coda_rv4

`make.py` cuts the main fixture from rv2. This one is for the two ways rv4 differs: its review
columns are empty and written with Arrow's `null` type (`docs/seam-merge-plan.md`, "Published
sets"), which the script checks survives the rewrite, and its candidates carry `n_l2`.

Small and chosen rather than sampled, as `make.py`'s: per neuron, the first shown tips and one
that is not.
"""

import json
import sys
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

NEURONS = 2
PER_NEURON_SHOWN = 2
UNREVIEWED = ("page", "tip_verdict", "belongs", "not_belongs")

src = Path(sys.argv[1])
out = Path(__file__).parent / "rv4"
out.mkdir(exist_ok=True)

tips = pd.read_parquet(src / "tips.parquet")
cands = pd.read_parquet(src / "candidates.parquet")

parts = []
for _, rows in list(tips.groupby("neuron", sort=True))[:NEURONS]:
    parts.append(rows[rows.shown].head(PER_NEURON_SHOWN))
    parts.append(rows[~rows.shown].head(1))
kept = pd.concat(parts).sort_values("end_uid").reset_index(drop=True)
keptCands = cands[cands.end_uid.isin(set(kept.end_uid))].reset_index(drop=True)

kept.to_parquet(out / "tips.parquet", index=False, compression="snappy")
keptCands.to_parquet(out / "candidates.parquet", index=False, compression="snappy")

# The point of the fixture: the columns are still untyped once written back.
written = pq.read_schema(out / "tips.parquet")
for column in UNREVIEWED:
    kind = str(written.field(column).type)
    if kind != "null":
        sys.exit(f"{column} was written as {kind}, not null: the fixture would not test the case")
counts = pq.read_schema(out / "candidates.parquet")
if "n_l2" not in counts.names or not pa.types.is_integer(counts.field("n_l2").type):
    sys.exit("candidates carry no integer n_l2: the fixture would not test the case")

manifest = json.loads((src / "fixture.json").read_text())
manifest["what"] = "A trimmed copy of SEAM's rv4 set, for Coda's tests. Not a suggestion set."
manifest["neurons"] = sorted(set(kept.neuron))
manifest["counts"] = {
    "tips": int(len(kept)),
    "shown": int(kept.shown.sum()),
    "candidates": int(len(keptCands)),
}
(out / "fixture.json").write_text(json.dumps(manifest, indent=1) + "\n")

print(f"{len(kept)} tips ({int(kept.shown.sum())} shown), {len(keptCands)} candidates, "
      f"{len(manifest['neurons'])} neurons")
