"""The pieces a proofread neuron was in at an earlier time — the ground truth `probe:seam-extend` grows against.

    python seam_extend_truth.py <neuron> <t0 ISO> <t1 ISO> <out.json>

A neuron that proofreaders merged together between `t0` and `t1` was, at `t0`, a set of separate
roots. Those roots are the answer to "which pieces belong to this neuron": a candidate the search
finds at `t0` is right exactly when it is one of them.

**It is a lower bound on what is right.** The neuron at `t1` may still be missing pieces, and a
candidate that truly belongs but was never merged reads here as wrong. The probe compares piece
ends against the ends of the pieces it starts from, under the same truth, so the bias is on both sides.

It also writes where the neuron's nucleus is, at `t1`. A rewound root has no row in the nucleus
table, so Find Open Ends cannot mask the cell body for it and the probe has to.

Reads only: `get_past_ids` (the lineage graph), `get_leaves` (level-2 ids) and one query of the
nucleus table. Needs caveclient and a CAVE token in its usual place.
"""

import datetime
import json
import sys

from caveclient import CAVEclient

DATASTACK = "wclee_aedes_brain"
SERVER = "https://global.daf-apis.com"
NUCLEI = "nuclei_v1_aedes"


def main() -> None:
    neuron, t0, t1, out = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
    past, future = (datetime.datetime.fromisoformat(t) for t in (t0, t1))
    client = CAVEclient(DATASTACK, server_address=SERVER)
    graph = client.chunkedgraph
    pieces = graph.get_past_ids([neuron], timestamp_past=past, timestamp_future=future)
    roots = [int(root) for root in pieces["past_id_map"][neuron]]
    # A level-2 chunk count per piece: the same size `seam:proofreadMerges` shows for a candidate.
    counts = {}
    for root in roots:
        try:
            counts[str(root)] = len(graph.get_leaves(root, stop_layer=2))
        except Exception:  # one unreadable piece is a gap in the size column, not a failed run
            counts[str(root)] = None
    nuclei = client.materialize.live_query(
        NUCLEI, timestamp=future, filter_equal_dict={"pt_root_id": neuron}, desired_resolution=[1, 1, 1]
    )
    # One nucleus or none: a neuron holding two is a merge, and has no one cell body to mask.
    soma = [float(v) for v in nuclei["pt_position"].iloc[0]] if len(nuclei) == 1 else None
    with open(out, "w") as handle:
        # Ids as text: an 18-digit root through a JSON number is a different neuron in JavaScript.
        json.dump({"neuron": str(neuron), "t0": t0, "t1": t1, "somaNm": soma, "pieces": counts}, handle)
    print(f"{len(roots)} pieces of {neuron} at {t0}")


if __name__ == "__main__":
    main()
