"""Check Coda's axon/dendrite split against navis, node for node.

`pnpm probe:split`. Needs `navis` and `navis-fastcore` installed locally; it is a probe rather
than a test for `probe-heatmap-order.py`'s reason — vitest has no Python, and pinning the answer
as a fixture would pin whatever this file happened to produce rather than what navis produces.

What it exists to catch is a *silent* divergence. Every step below returns something plausible
when it is wrong: an omitted correction moved 549 of 4,465 nodes and still drew a neuron with an
axon and a dendrite. The three that were actually wrong on the first pass, in the order they were
found, are recorded in `src/pyodide/topology.py` — they are the reason this runs the reference
rather than reading it.

Run against navis 2.0.0-rc.1 / navis-fastcore 0.13.0.
"""

import importlib.util
import sys

import numpy as np

try:
    import navis
except ImportError:  # pragma: no cover - the probe is opt-in
    sys.exit("navis is not installed; `pip install navis` to run this probe")

spec = importlib.util.spec_from_file_location("coda_topology", "src/pyodide/topology.py")
topology = importlib.util.module_from_spec(spec)
spec.loader.exec_module(topology)

NAMES = {
    topology.UNASSIGNED: "None",
    topology.DENDRITE: "dendrite",
    topology.AXON: "axon",
    topology.LINKER: "linker",
}


# The settings sweep. The defaults are what the node ships with; the second row exists because a
# knob nobody checks against the reference is a knob that agrees with navis only at its default —
# and both of these are exposed on the Compartments tab precisely so somebody moves them.
#
# navis spells the axon threshold *inside* its `split` argument, which is the whole reason it is
# easy to get wrong: `split='prepost:0.5'`, not a keyword of its own.
SETTINGS = [
    (0.9, 1.0, "prepost"),
    (0.6, 0.5, "prepost:0.5"),
]


def coda_split(neuron, flow_thresh=0.9, split_val=1.0):
    """Coda's answer for one navis neuron, in navis's own node order.

    Reproduces what the node does on the JavaScript side: reroot to soma (navis's
    `reroot_soma=True`), reindex node ids to `0..n-1` so parents are row numbers — which is what
    `SkeletonGeometry.parents` already holds — and count synapses per node, which Coda does by
    nearest-node lookup in `assignSynapses` and navis reads off a `node_id` column.
    """
    x = neuron.copy()
    if np.any(x.soma) and not np.all(np.isin(x.soma, x.root)):
        x.reroot(x.soma, inplace=True)

    nodes = x.nodes.reset_index(drop=True)
    index = {int(v): i for i, v in enumerate(nodes.node_id.values)}
    parents = np.array(
        [index.get(int(p), -1) if p >= 0 else -1 for p in nodes.parent_id.values],
        dtype=np.int32,
    )

    pre = np.zeros(len(nodes), dtype=np.uint32)
    post = np.zeros(len(nodes), dtype=np.uint32)
    for node_id, kind in zip(x.connectors.node_id.values, x.connectors.type.values):
        i = index[int(node_id)]
        if str(kind) == "pre" or kind == 0:
            pre[i] += 1
        else:
            post[i] += 1

    compartment, _, status = topology._split_one(parents, pre, post, flow_thresh, split_val)
    return nodes.node_id.values, np.array([NAMES[int(c)] for c in compartment]), status


def compare(neuron, flow_thresh, split_val, split_arg):
    """One neuron at one setting. Returns 1 if it disagrees with navis, 0 otherwise."""
    try:
        reference = navis.split_axon_dendrite(
            neuron.copy(),
            metric="synapse_flow_centrality",
            flow_thresh=flow_thresh,
            split=split_arg,
            label_only=True,
        )
    except ValueError as exc:
        # navis refuses a multi-rooted neuron outright. Coda reports it instead, so the one
        # thing to check here is that it refuses the *same* neurons rather than inventing an
        # answer for one navis will not touch.
        _, _, status = coda_split(neuron, flow_thresh, split_val)
        ok = status == topology.MULTIPLE_ROOTS
        print(f"neuron {neuron.id}: navis declined ({exc.args[0].split(':')[0]}) — "
              f"coda status={status} {'✓' if ok else '✗ expected MULTIPLE_ROOTS'}")
        return 0 if ok else 1

    node_ids, coda, status = coda_split(neuron, flow_thresh, split_val)
    theirs = (
        reference.nodes.set_index("node_id")["compartment"]
        .astype(str)
        .reindex(node_ids)
        .values
    )
    agree = int((coda == theirs).sum())
    total = len(coda)
    mark = "✓" if agree == total else "✗"
    print(f"neuron {neuron.id}: {total:6d} nodes  status={status}  "
          f"{agree}/{total} = {agree / total:.4%} {mark}")
    for label in ("axon", "dendrite", "linker"):
        n_theirs = int((theirs == label).sum())
        n_ours = int((coda == label).sum())
        flag = "" if n_theirs == n_ours else "   <- differs"
        print(f"    {label:9s} navis {n_theirs:6d}   coda {n_ours:6d}{flag}")
    if agree == total:
        return 0

    import collections

    worst = collections.Counter(zip(theirs[coda != theirs], coda[coda != theirs]))
    print(f"    disagreements (navis -> coda): {worst.most_common(6)}")
    return 1


def main():
    failures = 0
    neurons = navis.example_neurons(5)
    for flow_thresh, split_val, split_arg in SETTINGS:
        print(f"== flow_thresh={flow_thresh}  split={split_arg!r} ==")
        for neuron in neurons:
            failures += compare(neuron, flow_thresh, split_val, split_arg)
        print()

    if failures:
        sys.exit(f"{failures} neuron/setting pair(s) disagree with navis")
    print("every neuron agrees with navis node for node, at both settings")


if __name__ == "__main__":
    main()
