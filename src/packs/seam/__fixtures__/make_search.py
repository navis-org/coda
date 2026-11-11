"""Cut the search's two goldens out of SEAM's published set, for Coda's tests.

Run from the repo root with SEAM's fixture directory as the argument — the same
directory `make.py` takes:

    python3 -I src/packs/seam/__fixtures__/make_search.py ~/Github/SEAM/data/fixtures/coda_rv2

Apart from `make.py` only in what it reads. That one trims `tips.parquet`,
`candidates.parquet` and `verdicts.parquet` into the pack's parquet fixtures;
this one reads `candidates_all.parquet` — the search's top 100 per end **before**
the own-tip rule, which nothing in the pack's loader touches — and writes two
JSON goldens:

- `searchEnd.json` — one end's ranked list, which `pnpm probe:candidate-search`
  checks the whole of stages 4 and 5 against.
- `ownTipNeuron.json` — one neuron's ends and a handful of its lists, with the
  own-tip rule's own answer per list. The rule is a *per-neuron* pass, so a
  single end cannot test it: what a list keeps depends on every other end of
  the neuron, including ends that were never searched.

**The kept set is SEAM's, read, not recomputed.** `candidates.parquet` is the
post-rule set with `geo_rank` already renumbered, so that is what goes into the
golden. The rule is also run here in numpy and the two are required to agree —
but that pass exists for `tooFar` and `anothersTip`, which SEAM publishes
neither of. Writing the numpy answer instead would make the golden a second
implementation written from the same reading as `ownTip.ts`, and a shared
misreading would then agree with itself, which is the one failure a golden is
there to prevent.

**Why only a handful of lists.** A list's answer depends on its own candidates
and on *all* the neuron's ends, and on nothing else — so keeping every end and
a few lists is exact, not a sample. The ends are chosen for the cases rather
than taken off the top: one that keeps most of its list, two that keep nothing,
one that gives nine tenths of what was near enough to a nearer end, and the end
the search probe already drives end to end.

**Every number comes from the published set**, including `own_um` — so a refit
upstream moves the goldens rather than disagreeing with them silently, and the
`version` the set stamps itself with is written into both files.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

XYZ = ["x_nm", "y_nm", "z_nm"]
CONTACT = ["contact_x_nm", "contact_y_nm", "contact_z_nm"]

SEARCH_END = 0  # the end probe:candidate-search drives; its neuron is the own-tip one
TOP = 20  # how much of the ranked list searchEnd.json pins

# end_uid -> why it is here. Everything the rule can do to a list, on real data.
ENDS = {
    SEARCH_END: "half the list too far and a third of the rest another end's; 14 of 100 kept",
    43: "nine tenths of what was near enough belongs to a nearer end",
    99: "nothing within own_um at all -- an empty list, not a failed one",
    377: "the few that were near enough are every one of them nearer another end",
    422: "keeps 87 -- nothing lost to another end",
    263: "most of the list near enough, and 70 of it another end's",
}

src = Path(sys.argv[1])
out = Path(__file__).parent

manifest = json.loads((src / "fixture.json").read_text())
own_um = manifest["pipeline"]["own_tip"]["own_um"]
stamp = {"seam_commit": manifest["commit"], "set_version": manifest["version"]}

# `columns=` on all three: parquet skips the column chunks nothing here reads, which on
# candidates_all's 270,700 rows is most of the file.
lists = pd.read_parquet(
    src / "candidates_all.parquet",
    columns=["end_uid", "cand_root", "q_root", "geo_rank", "geo_score", "min_dist_um",
             "vol_um3", *CONTACT],
)
ends = pd.read_parquet(src / "tips.parquet", columns=["end_uid", "neuron", *XYZ])
after = pd.read_parquet(src / "candidates.parquet", columns=["end_uid", "cand_root", "geo_rank"])

# One pass over each file rather than one per end: each `== uid` is a scan of all 270,700 rows.
wanted = {uid: rows.sort_values("geo_rank").reset_index(drop=True)
          for uid, rows in lists[lists.end_uid.isin(ENDS)].groupby("end_uid")}
missing = sorted(set(ENDS) - set(wanted))
if missing:
    raise SystemExit(f"{src.name} has no list for end(s) {missing}")
# An end that kept nothing has no rows here at all, so absence is "kept nothing" only
# because the end is known to have been searched -- which `wanted` above is what establishes.
survivors = {uid: rows.sort_values("geo_rank")
             for uid, rows in after[after.end_uid.isin(ENDS)].groupby("end_uid")}

neuron = ends.set_index("end_uid").neuron
one_neuron = neuron[SEARCH_END]
astray = {uid: neuron[uid] for uid in ENDS if neuron[uid] != one_neuron}
if astray:
    # The rule is per neuron, so a golden mixing two of them would be answering a
    # different question than the one it claims to.
    raise SystemExit(f"ends {astray} are not on neuron {one_neuron}")

tips = ends[ends.neuron == one_neuron].sort_values("end_uid").reset_index(drop=True)
row_of = {int(u): i for i, u in enumerate(tips.end_uid)}
positions = tips[XYZ].to_numpy(float)
tree = cKDTree(positions)

# --- searchEnd.json: one end's ranked list, before the rule ------------------

one = wanted[SEARCH_END]
search = {
    "what": "One open end's ranked candidates, from SEAM's own candidates_all.parquet.",
    "end_uid": SEARCH_END,
    "neuron": one_neuron,
    "kind": "tip",
    "endNm": [float(v) for v in positions[row_of[SEARCH_END]]],
    "queryRoot": one.q_root.iloc[0],
    "rows": int(len(one)),
    "how": "SEAM searched this end at the rv2 snapshot and kept its top 100 before the own-tip "
    "rule. geo_score is a rank key -- lower is better -- so geo_rank ascends with it. Pinned to "
    "this segmentation and this snapshot: if either is rebuilt the ranks move together and every "
    "check in probe-candidate-search fails at once, which is the signal that this file is stale "
    "rather than the search wrong. Written by make_search.py, which cuts it out of the set.",
    "top": [
        {
            "cand_root": r.cand_root,
            "geo_rank": int(r.geo_rank),
            "geo_score": float(r.geo_score),
            "min_dist_um": float(r.min_dist_um),
            "vol_um3": float(r.vol_um3),
            # The point the own-tip rule measures from, so the probe can check that Coda
            # computes the *place* a candidate touches and not only how far away it is.
            "contact_nm": [float(r.contact_x_nm), float(r.contact_y_nm), float(r.contact_z_nm)],
        }
        for r in one.head(TOP).itertuples()
    ],
    **stamp,
}

# --- ownTipNeuron.json: a neuron's ends, some lists, and what SEAM kept ------

kept_lists = []
for uid, why in ENDS.items():
    rows = wanted[uid]
    contact = rows[CONTACT].to_numpy(float)
    near = np.linalg.norm(contact - positions[row_of[uid]], axis=1) <= own_um * 1000
    _, nearest = tree.query(contact)
    mine = nearest == row_of[uid]
    recomputed = list(np.flatnonzero(near & mine))  # in geo_rank order, the new rank's order

    # SEAM's own answer, by candidate rather than by position, and the recomputation held
    # against it. The golden carries SEAM's; the numpy pass is only here for the two counts.
    at_of_root = {root: i for i, root in enumerate(rows.cand_root)}
    if len(at_of_root) != len(rows):
        raise SystemExit(f"end {uid} lists a candidate twice")
    theirs = survivors.get(uid)
    stranded = [] if theirs is None else [r for r in theirs.cand_root if r not in at_of_root]
    if stranded:
        raise SystemExit(
            f"end {uid}: {len(stranded)} candidate(s) SEAM kept are not in its own top 100 "
            f"(e.g. {stranded[0]}). The two published files disagree; do not write the golden."
        )
    kept = [at_of_root[root] for root in theirs.cand_root] if theirs is not None else []
    if theirs is not None and list(theirs.geo_rank) != list(range(1, len(theirs) + 1)):
        raise SystemExit(f"end {uid}'s published geo_rank is not 1..n; the rule has moved")
    if kept != recomputed:
        raise SystemExit(
            f"end {uid}: SEAM kept {len(kept)} candidates, the rule as re-run here keeps "
            f"{len(recomputed)}. One of the two has drifted -- do not write the golden."
        )

    kept_lists.append(
        {
            "end_uid": int(uid),
            "why": why,
            "tip": row_of[uid],
            "contactNm": [[float(v) for v in p] for p in contact],
            "geoRank": [int(v) for v in rows.geo_rank],
            "kept": [int(i) for i in kept],
            "tooFar": int((~near).sum()),
            "anothersTip": int((near & ~mine).sum()),
        }
    )

own_tip = {
    "what": "One neuron's open ends and a few of its candidate lists, with SEAM's own kept set "
    "per list, from the published rv2 set.",
    "neuron": one_neuron,
    "own_um": own_um,
    "how": "`tipsNm` is every open end of the neuron in end_uid order -- including any no list "
    "was searched for, which still take candidates away from their neighbours. `lists` holds a "
    "few of them, chosen for the cases; a list's answer depends on its own candidates and on all "
    "the ends and on nothing else, so this is exact rather than a sample. `kept` indexes into the "
    "list, in the order SEAM's renumbered geo_rank puts them -- read from candidates.parquet, "
    "not recomputed. `tooFar` and `anothersTip` are derived, since SEAM publishes neither. "
    "Written by make_search.py.",
    "endUids": [int(u) for u in tips.end_uid],
    "tipsNm": [[float(v) for v in p] for p in positions],
    "lists": kept_lists,
    **stamp,
}
# Written only here, both of them. Every refusal above says "do not write the golden", which an
# earlier write of `searchEnd.json` would have made untrue: an aborted run would have left the
# two files stamped with different set versions, and the next reader with no sign of it.
(out / "searchEnd.json").write_text(json.dumps(search) + "\n")
(out / "ownTipNeuron.json").write_text(json.dumps(own_tip) + "\n")

survived = sum(len(one["kept"]) for one in kept_lists)
scored = sum(len(one["geoRank"]) for one in kept_lists)
print(
    f"searchEnd.json: end {SEARCH_END}, top {TOP} of {search['rows']}\n"
    f"ownTipNeuron.json: neuron {one_neuron}, {len(tips)} ends, {len(kept_lists)} lists, "
    f"{survived} of {scored} kept (SEAM's own, cross-checked against the rule re-run here)\n"
    f"SEAM {stamp['seam_commit']}, set {stamp['set_version']}"
)
