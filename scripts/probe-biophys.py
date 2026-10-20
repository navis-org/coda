"""Compare the biophysics solver with NEURON on real reconstructions.

    pnpm probe:biophys

Three steps, one file between them (`/tmp/coda-biophys-probe.json`):

1. `export` (here): two hemibrain DA1 projection neurons from navis's example data, re-rooted at
   the soma and converted to micrometres, with synaptic input on real postsynaptic sites — each
   site's synapse **count** kept — written as cases in `src/biophys/referenceCases.ts`'s shape.
2. `scripts/probe-biophys.ts` discretises and simulates each case and adds our sections and traces.
3. `compare` (here): NEURON builds each case on those sections (`biophys_neuron.py`) and the two
   sets of traces are compared, with both wall times.

Local only: needs `pip install navis neuron`. Nothing here touches a server.
"""

import json
import sys
import time

PATH = "/tmp/coda-biophys-probe.json"
FLY = {"ra": 266.1, "cm": 0.8, "gLeak": 1 / 20800, "eLeak": -60}
SYNAPSE = {"scheme": "exp2syn", "tau1": 0.1, "tau2": 10, "eRev": 0, "gmax": 0.0005}


def export():
    import navis
    import numpy as np

    cases = []
    for n, (rule, hh) in zip(
        navis.example_neurons(2, kind="skeleton"),
        [({"kind": "dLambda", "dLambda": 0.1, "frequency": 100}, False),
         ({"kind": "maxLength", "length": 10}, True)],
    ):
        n = navis.reroot_skeleton(n.convert_units("um"), np.atleast_1d(n.soma)[0])
        nodes = n.nodes.reset_index(drop=True)
        index = {nid: i for i, nid in enumerate(nodes.node_id)}
        parent = [index.get(p, -1) for p in nodes.parent_id]
        soma = index[np.atleast_1d(n.soma)[0]]
        sx, sy, sz = nodes.loc[soma, ["x", "y", "z"]]
        near = ((nodes.x - sx) ** 2 + (nodes.y - sy) ** 2 + (nodes.z - sz) ** 2) ** 0.5
        # Region 1 is everything within 3 µm of the soma node: a stand-in for a soma, which these
        # skeletons do not outline. It checks the solver, not a soma model (Phase 1's business).
        labels = [1 if d < 3 else 3 for d in near]

        # Every 40th postsynaptic site by connector id: deterministic, spread over the arbour.
        post = n.connectors[n.connectors.type == "post"].sort_values("connector_id")
        picked = post.iloc[::40]
        counts = picked.node_id.map(index).value_counts().sort_index()
        synapses = [
            {"node": int(node), "count": int(count), "times": [5 + (k % 20), 30 + (k % 7)]}
            for k, (node, count) in enumerate(counts.items())
        ]
        tips = [i for i in range(len(parent)) if i not in set(parent)]
        far = max(tips, key=lambda i: near[i])
        record = [soma, far] + [s["node"] for s in synapses[:4]]

        case = {
            "name": f"{n.id}-{'hh' if hh else 'passive'}-{rule['kind']}",
            "tree": {
                "positions": nodes[["x", "y", "z"]].to_numpy().ravel().tolist(),
                "radii": nodes.radius.tolist(),
                "parent": parent,
                "labels": labels,
            },
            "rule": rule,
            **FLY,
            "temperature": 22,
            "vInit": -60 if not hh else -65,
            "synapse": SYNAPSE,
            "synapses": synapses,
            "clamps": [{"node": soma, "delay": 45, "duration": 10, "amplitude": 0.05}],
            "record": record,
            "dt": 0.025,
            "duration": 60,
        }
        if hh:
            case["hh"] = {"regions": [1], "gna": 0.12, "gk": 0.036}
        cases.append(case)
        print(f"{case['name']}: {len(parent)} nodes, {len(synapses)} sites, "
              f"{sum(s['count'] for s in synapses)} synapses")
    with open(PATH, "w") as f:
        json.dump(cases, f)


def compare():
    from biophys_neuron import run_case

    with open(PATH) as f:
        cases = json.load(f)
    worst = 0
    counts_differ = False
    for case in cases:
        t0 = time.perf_counter()
        ref = run_case(case)
        neuron_ms = (time.perf_counter() - t0) * 1000
        # `zip` stops at the shorter of two traces, so a run that ended early would compare only the
        # part that agrees: lengths first, a mismatch being a failure of its own.
        shapes = ([len(t) for t in case["ours"]], [len(t) for t in ref["traces"]])
        if shapes[0] != shapes[1]:
            print(f"{case['name']}: trace lengths differ, ours {shapes[0]} against NEURON's {shapes[1]}")
            sys.exit(1)
        diff = max(
            abs(a - b)
            for ours, theirs in zip(case["ours"], ref["traces"])
            for a, b in zip(ours, theirs)
        )
        worst = max(worst, diff)
        peak = max(case["ours"][0])
        nseg = ""
        if "neuronNseg" in ref:
            same = ref["neuronNseg"] == [s["nseg"] for s in case["sections"]]
            nseg = f", d_lambda counts {'agree' if same else 'DIFFER'}"
            # NEURON is handed our counts, so the traces agree either way: a counting rule that
            # disagrees with NEURON's is a failure of its own, not a line to read past.
            counts_differ = counts_differ or not same
        print(f"{case['name']}: {case['compartments']} compartments, max |Δv| {diff:.2e} mV, "
              f"soma peak {peak:.1f} mV, ours {case['ms']:.0f} ms, NEURON {neuron_ms:.0f} ms{nseg}")
    print(f"worst {worst:.2e} mV")
    # The tolerance `solver.test.ts` holds the committed fixture to.
    sys.exit(0 if worst < 1e-5 and not counts_differ else 1)


if __name__ == "__main__":
    {"export": export, "compare": compare}[sys.argv[1]]()
