"""SEAM's own numbers for the single-seed configuration, tip by tip, as a golden for stages 7-9.

    python3 -I src/packs/seam/__fixtures__/make_single_seed_golden.py \
        ~/Github/SEAM/data/fixtures/coda_rv2_single_s0 \
        src/packs/seam/__fixtures__/singleSeedTips.json

Needs `pandas` and `pyarrow`, which Coda does not depend on — a throwaway venv is the intended
way. Committed beside `make.py` and `make_ranker_golden.py` for their reason: a golden only
regenerable by whoever still has the scratchpad is not regenerable.

## Why a sample and not the parquet

`stages.test.ts` reads the production set's own `tips.parquet` and `candidates.parquet`, which
are 22 KB and 187 KB because that set was cut down for exactly this. The single-seed set has not
been: 2,708 tips and 108,788 candidates is 7.7 MB, to check arithmetic that is the same on every
row. So this takes a few dozen tips and stores both halves of each — what goes in, and what SEAM
published coming out.

## The rows are chosen, not sampled

Each group buys a failure that an average over 2,708 tips would hide:

* **every tip SEAM shows**, which is the decision the whole pipeline exists to make, and the one
  a reader acts on;
* **the tip whose `q` is the cutoff**, to the last bit. The cutoff is picked at an operating
  point on the observed scores, so one tip sits exactly on it and `>=` against `>` is a real
  suggestion either kept or lost;
* **the longest and shortest lists**, including the tips with **no candidates at all** — whose
  `segclr` is the fit's floor, `p_top` zero and verdict withheld, and which an implementation
  that skipped empty lists would publish as unsearched;
* **the extremes of `e_tip`**, so the `p_tip` fit is exercised at both ends of its second
  feature, and the tips nearest the floor where Model E found almost nothing;
* **a tip at each end of the `r` staircase**, which is searched rather than interpolated, so an
  off-by-one in the boundary reads a share one step out.
"""
import json
import sys
from pathlib import Path

import pandas as pd

src, out = Path(sys.argv[1]), Path(sys.argv[2])
fixture = json.loads((src / "fixture.json").read_text())
tips = pd.read_parquet(src / "tips.parquet")
cands = pd.read_parquet(src / "candidates.parquet")

lists = {key: group for key, group in cands.groupby(["neuron", "end_uid"], sort=False)}
cutoff = fixture["pipeline"]["show"]["cutoff"]

picked: dict[tuple[str, int], str] = {}


def take(frame, why: str, n: int) -> None:
    """The first `n` rows of `frame` that are not already in, tagged with why they were wanted."""
    added = 0
    for _, row in frame.iterrows():
        if added >= n:
            return
        key = (str(row["neuron"]), int(row["end_uid"]))
        if key in picked:
            continue
        picked[key] = why
        added += 1


sizes = tips.apply(lambda r: len(lists.get((r["neuron"], r["end_uid"]), [])), axis=1)
# The decision first and in bulk, then every edge, each of which is allowed to be scarce.
take(tips[tips["shown"]], "shown", 40)
take(tips.iloc[(tips["q"] - cutoff).abs().argsort()], "at the cutoff", 4)
take(tips[sizes == 0], "no candidates", 5)
take(tips.iloc[sizes.argsort()[::-1]], "the longest list", 3)
take(tips[sizes > 0].iloc[sizes[sizes > 0].argsort()], "the shortest list", 3)
take(tips.sort_values("e_tip"), "the lowest e_tip", 3)
take(tips.sort_values("e_tip", ascending=False), "the highest e_tip", 3)
take(tips.sort_values("r"), "the bottom of the r staircase", 3)
take(tips.sort_values("r", ascending=False), "the top of the r staircase", 3)
take(tips[~tips["shown"]], "withheld", 10)

rows = []
for key, why in picked.items():
    tip = tips[(tips["neuron"] == key[0]) & (tips["end_uid"] == key[1])].iloc[0]
    # **In `geo_rank` order**, which is the order Coda's own search hands the list over in.
    # SEAM's parquet is in `rank` order, and feeding that back would let a wrong tie rule pass:
    # ties are broken by arrival, so a list already sorted by the answer cannot show it.
    group = lists.get(key)
    group = group.sort_values("geo_rank") if group is not None else cands.iloc[0:0]
    rows.append(
        {
            "neuron": key[0],
            "end_uid": key[1],
            "why": why,
            "e_tip": float(tip["e_tip"]),
            "in": {
                "geo_rank": [float(v) for v in group["geo_rank"]],
                "vol_um3": [float(v) for v in group["vol_um3"]],
                "score_s0": [float(v) for v in group["score_s0"]],
            },
            "seam": {
                "logit": [float(v) for v in group["logit"]],
                "p_cand": [float(v) for v in group["p_cand"]],
                "rank": [int(v) for v in group["rank"]],
                "conf": [float(v) for v in group["conf"]],
                "cand_root": [str(v) for v in group["cand_root"]],
                "segclr": float(tip["segclr"]),
                "p_tip": float(tip["p_tip"]),
                # **Null, not a number.** SEAM leaves `p_top` NaN for a tip with no candidates
                # — there is no first candidate to have a share — where Coda carries 0, which is
                # the same statement with one fewer meaning of zero. JSON has no NaN, and
                # writing one would have made the golden unparseable rather than wrong, which is
                # how this was caught.
                "p_top": None if pd.isna(tip["p_top"]) else float(tip["p_top"]),
                "q": float(tip["q"]),
                "r": float(tip["r"]),
                "shown": bool(tip["shown"]),
                "top_cand_root": None if pd.isna(tip["top_cand_root"]) else str(tip["top_cand_root"]),
            },
        }
    )

out.write_text(
    json.dumps(
        {
            "what": (
                "SEAM's published numbers for the single-seed, masks-only configuration, for "
                "the tips that buy a failure an average would hide. See make_single_seed_golden.py."
            ),
            "version": fixture.get("commit"),
            "counts": fixture.get("counts"),
            "cutoff": cutoff,
            "tips": rows,
        },
        indent=1,
    )
    + "\n"
)
print(f"{out}: {len(rows)} tips, {sum(len(r['in']['geo_rank']) for r in rows)} candidates")
