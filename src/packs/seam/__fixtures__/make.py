"""Trim SEAM's rv2 suggestion set to a few neurons' worth, for Coda's tests.

Run from the repo root with SEAM's fixture directory as the argument:

    python3 -I src/packs/seam/__fixtures__/make.py ~/Github/SEAM/data/fixtures/coda_rv2

The point is that the tests read **real parquet bytes**, written the way SEAM writes them
(pyarrow, SNAPPY, string id columns, `;`-joined verdicts), through the same reader the node uses
over HTTP. A hand-built table would test the folding and nothing about the reading, which is
where every failure in this path has been.

Small on purpose, and chosen rather than sampled: the tips kept are the first shown ones plus
some unshown and some unjudged, so the fixture exercises the distinctions the node makes —
`shown` versus not, a verdict versus none at all (null, not "").
"""

import json
import sys
from pathlib import Path

import pandas as pd

PER_NEURON_SHOWN = 2
PER_NEURON_OTHER = 3

src = Path(sys.argv[1])
out = Path(__file__).parent

tips = pd.read_parquet(src / "tips.parquet")
cands = pd.read_parquet(src / "candidates.parquet")

# Per neuron, not off the top of the file: the tips are grouped by neuron, so a plain head()
# gives a fixture of one neuron and the per-neuron fold is then tested against a single row.
parts = []
for _, rows in tips.groupby("neuron", sort=True):
    parts.append(rows[rows.shown].head(PER_NEURON_SHOWN))
    parts.append(rows[~rows.shown & rows.tip_verdict.notna()].head(PER_NEURON_OTHER - 1))
    parts.append(rows[~rows.shown & rows.tip_verdict.isna()].head(1))
kept = pd.concat(parts).sort_values("end_uid").reset_index(drop=True)
keptCands = cands[cands.end_uid.isin(set(kept.end_uid))].reset_index(drop=True)

kept.to_parquet(out / "tips.parquet", index=False, compression="snappy")
keptCands.to_parquet(out / "candidates.parquet", index=False, compression="snappy")

# A copy with the 2026-11-09 incident put back: `top_cand_root` and the judged ids through a
# float64, exactly as `Series.map` over a nullable Int64 column produced them. Written so the
# loader's two cross-checks are tested against the real shape of the failure rather than
# against something hand-made -- it was a *string* column of *rounded* ids, which is why
# "every id is a string column" did not catch it.
rounded = out / "damaged"
rounded.mkdir(exist_ok=True)


def through_float(text):
    if not isinstance(text, str) or not text:
        return text
    return ";".join(str(int(float(i))) for i in text.split(";"))


hurt = kept.copy()
for column in ("top_cand_root", "belongs", "not_belongs"):
    hurt[column] = hurt[column].map(through_float)
hurt.to_parquet(rounded / "tips.parquet", index=False, compression="snappy")
keptCands.to_parquet(rounded / "candidates.parquet", index=False, compression="snappy")

manifest = json.loads((src / "fixture.json").read_text())
manifest["what"] = "A trimmed copy of SEAM's rv2 set, for Coda's tests. Not a suggestion set."
manifest["neurons"] = sorted(set(kept.neuron))
manifest["counts"] = {
    "tips": int(len(kept)),
    "shown": int(kept.shown.sum()),
    "candidates": int(len(keptCands)),
}
(out / "fixture.json").write_text(json.dumps(manifest, indent=1) + "\n")

damagedManifest = dict(manifest)
damagedManifest["what"] = "The trimmed set with the 2026-11-09 rounded-ID incident put back."
(rounded / "fixture.json").write_text(json.dumps(damagedManifest, indent=1) + "\n")

# A manifest whose counts disagree with the files beside it -- the one warning the loader
# gives that nothing else can produce. Derived from the real manifest rather than kept by
# hand, with exactly one number moved: a hand-written copy goes stale the first time the set
# is recut, and then it disagrees in ways nobody meant as well as the one way they did.
WRONG_TIPS = 9999
mismatched = dict(manifest)
mismatched["what"] = "A manifest whose counts disagree with the files beside it, for Coda's tests."
mismatched["counts"] = {**manifest["counts"], "tips": WRONG_TIPS}
(out / "mismatched.json").write_text(json.dumps(mismatched, indent=1) + "\n")

# The directory a card can point at instead of one manifest. Same reason it is written here:
# its per-set counts are what the picker shows before anything is read, so a stale copy sends
# a reader looking for a set that has the number they saw.
index = {
    "what": "A directory of SEAM merge-candidate suggestion sets, for Coda's tests.",
    "sets": [
        {
            "id": "rv2",
            "path": "fixture.json",
            "label": "Aedes rv2",
            "dataset": manifest["dataset"],
            "datastack": manifest["datastack"],
            "snapshot": manifest["snapshot"],
            "commit": manifest["commit"],
            "neurons": len(manifest["neurons"]),
            "counts": manifest["counts"],
        },
        {
            "id": "rv2-mismatched",
            "path": "mismatched.json",
            "label": "Aedes rv2, with counts that disagree",
            "datastack": manifest["datastack"],
            "snapshot": manifest["snapshot"],
            "neurons": len(manifest["neurons"]),
            "counts": mismatched["counts"],
        },
    ],
}
(out / "index.json").write_text(json.dumps(index, indent=1) + "\n")

hurtRows = int((hurt.top_cand_root != kept.top_cand_root).sum())
print(f"{len(kept)} tips ({int(kept.shown.sum())} shown), {len(keptCands)} candidates, "
      f"{len(manifest['neurons'])} neurons; damaged/ has {hurtRows} rounded first-candidate ids")
