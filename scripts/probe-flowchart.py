#!/usr/bin/env python3
"""Run the generated `coda_flow_layers` and check it answers what the canvas answered.

    pnpm probe:flowchart

The second third of a three-language check; `scripts/probe-flowchart.ts` writes the reference.
The helper is read out of the golden notebook rather than transcribed here, so what runs is
exactly what the exporter writes — `probe-py-helpers.py`' arrangement and for its reason.

It also runs `multipartite_layout` over the result, because that is the call the emitted cell
makes and it is the one that can reject a layering rather than merely disagree with it: the
layout requires the subset key on every node and raises otherwise, which a layering that skipped
an isolated node would trip.
"""
import json
import sys
from pathlib import Path

import networkx as nx

ROOT = Path(__file__).resolve().parent.parent
NOTEBOOK = ROOT / "src" / "export" / "python" / "__fixtures__" / "everything.ipynb"
REFERENCE = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/coda-flowchart-probe.json")


def load_source(notebook: Path, marker: str) -> str:
    """The generated cell containing `marker`, as text."""
    book = json.loads(notebook.read_text())
    for cell in book["cells"]:
        source = "".join(cell.get("source", []))
        if cell["cell_type"] == "code" and marker in source:
            return source
    raise SystemExit(f"no cell containing {marker!r} in {notebook}")


def load_cell(notebook: Path, marker: str, ns: dict) -> dict:
    """Exec that cell into `ns`, and hand `ns` back."""
    exec(compile(load_source(notebook, marker), str(notebook), "exec"), ns)
    return ns


fails = []


def check(name, cond, detail=""):
    print(f"{'ok  ' if cond else 'FAIL'} {name}{f'   {detail}' if detail else ''}")
    if not cond:
        fails.append(name)


if not REFERENCE.exists():
    raise SystemExit(f"{REFERENCE} missing — run `pnpm probe:flowchart` (the vite-node half) first")

ns = load_cell(NOTEBOOK, "def coda_flow_layers(", {})
coda_flow_layers = ns["coda_flow_layers"]

for case in json.loads(REFERENCE.read_text()):
    graph = nx.DiGraph()
    for node in case["nodes"]:
        graph.add_node(node, hops=case["hops"][node])
    for source, target, weight in case["edges"]:
        graph.add_edge(source, target, weight=weight)

    layers = coda_flow_layers(
        graph, **({"layer_attr": case["layerColumn"]} if case["layerColumn"] else {})
    )
    expected = case["layers"]
    same = all(layers.get(node) == expected[node] for node in case["nodes"])
    check(
        f"{case['name']}: the same layering as the canvas",
        same,
        "" if same else f"{ {n: layers.get(n) for n in case['nodes']} } vs {expected}",
    )

    # The feedback classification falls out of the layering, so a layering that agrees and a
    # classification that does not would mean the two disagree about which edges exist.
    kinds = {}
    for source, target, _ in case["edges"]:
        if source == target:
            kinds[f"{source}->{target}"] = "self"
        elif layers[target] > layers[source]:
            kinds[f"{source}->{target}"] = "forward"
        elif layers[target] < layers[source]:
            kinds[f"{source}->{target}"] = "back"
        else:
            kinds[f"{source}->{target}"] = "within"
    check(f"{case['name']}: the same feedback edges", kinds == case["kinds"],
          "" if kinds == case["kinds"] else f"{kinds} vs {case['kinds']}")

    # The call the emitted cell actually makes. It raises on a node with no subset key, which is
    # the failure a layering that quietly skipped the isolated node would produce.
    nx.set_node_attributes(graph, layers, "coda_layer")
    pos = nx.multipartite_layout(graph, subset_key="coda_layer", align="vertical")
    check(f"{case['name']}: multipartite_layout places every node", len(pos) == len(case["nodes"]))

    # And that the layering is what decides the axis the layers run along — the property the
    # figure rests on, rather than the numbers themselves.
    by_layer = {}
    for node, at in pos.items():
        by_layer.setdefault(layers[node], set()).add(round(float(at[0]), 6))
    one_x_per_layer = all(len(xs) == 1 for xs in by_layer.values())
    ordered = [x for _, xs in sorted(by_layer.items()) for x in xs]
    check(
        f"{case['name']}: one column per layer, in layer order",
        one_x_per_layer and ordered == sorted(ordered),
        "" if one_x_per_layer else f"{by_layer}",
    )

# ---------------------------------------------------------------------------
# coda_paths_network, the other helper the Flow Chart depends on
# ---------------------------------------------------------------------------

# `neuron.paths` had to start binding its Network port once something downstream read it, and the
# builder's one interesting rule is that the shift is *within* a path. Applied to the frame whole
# it joins the last body of one route to the first body of the next — an edge that does not exist,
# carrying the next route's first weight, indistinguishable from a real one in the picture.
print()
print("-- coda_paths_network --")

import pandas as pd

pn = load_cell(NOTEBOOK, "def coda_paths_network(", {"pd": pd, "nx": nx})
coda_paths_network = pn["coda_paths_network"]

# `fetch_paths`' documented shape: one row per step, `weight` the strength from the previous body
# in the same path, 0 on a route's first row. Two routes, deliberately arranged so the last body
# of path 0 and the first body of path 1 are different neurons — which is what makes the spurious
# edge visible at all.
frame = pd.DataFrame(
    [
        {"path": 0, "bodyId": 1, "type": "L1", "weight": 0},
        {"path": 0, "bodyId": 2, "type": "Tm3", "weight": 11},
        {"path": 0, "bodyId": 3, "type": "T4a", "weight": 15},
        {"path": 1, "bodyId": 4, "type": "L2", "weight": 0},
        {"path": 1, "bodyId": 2, "type": "Tm3", "weight": 7},
        {"path": 1, "bodyId": 3, "type": "T4a", "weight": 15},
    ]
)
graph = coda_paths_network(frame)

# `check` takes the name first. Written the other way round every one of these passed on a
# truthy string while asserting nothing — which is what the printed labels said, and is the
# reason to read a probe's first run rather than only its exit code.
check(
    f"a node per body ({graph.number_of_nodes()})",
    set(graph.nodes()) == {"1", "2", "3", "4"},
)
check(
    "an edge per consecutive pair within a path",
    set(graph.edges()) == {("1", "2"), ("2", "3"), ("4", "2")},
    str(sorted(graph.edges())),
)
check(
    "and no edge from one route's last body to the next route's first",
    not graph.has_edge("3", "4"),
)
# `2 -> 3` is on both routes at the same weight, so it is one edge at that weight rather than 30.
check(
    "a connection on two routes is one edge at its own weight, not the sum",
    graph.edges["2", "3"]["weight"] == 15,
    str(graph.edges["2", "3"]["weight"]),
)
check("and each node carries its type", graph.nodes["2"]["type"] == "Tm3")
check("an empty frame is an empty graph", coda_paths_network(frame.iloc[0:0]).number_of_nodes() == 0)

# ---------------------------------------------------------------------------
# The emitted cell itself, run
# ---------------------------------------------------------------------------

# Lifted out of the golden notebook and executed against a graph of our own, because the checks
# above cover the *helper* and the golden covers the *text*, and neither runs the twenty lines
# that draw. Its R twin found four bugs in exactly those lines.
print()
print("-- the emitted cell, run --")

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


# Carries everything the cell reads: a `hop` column to layer by, a `role` column to label by,
# `weight` for the widths and `pairs` for the labels — and an edge skipping a layer, which is
# where a straight-line renderer and Coda's routed one visibly part company.
paths_network = nx.DiGraph()
for name, hop, role in [
    ("in1", 0, "source"),
    ("via", 1, "via"),
    ("via2", 2, "via"),
    ("out", 3, "target"),
]:
    paths_network.add_node(name, hop=hop, role=role)
for source, target, weight, pairs in [
    ("in1", "via", 120, 3),
    ("via", "via2", 45, 2),
    ("via2", "out", 300, 7),
    ("in1", "out", 8, 1),
]:
    paths_network.add_edge(source, target, weight=weight, pairs=pairs)

cell_ns = {
    "nx": nx,
    "pd": pd,
    "plt": plt,
    "coda_flow_layers": coda_flow_layers,
    "paths_network": paths_network,
}
try:
    exec(compile(load_source(NOTEBOOK, "coda_flow_layers(_figure"), "<cell>", "exec"), cell_ns)
    ran, why = True, ""
except Exception as error:  # noqa: BLE001 — the probe's whole job is to report this
    ran, why = False, f"{type(error).__name__}: {error}"
plt.close("all")

check("the emitted cell runs", ran, why)
check(
    "it binds the pass-through and the selection",
    "flow_chart_out" in cell_ns and "flow_chart_selected" in cell_ns,
)
if "flow_chart_selected" in cell_ns:
    # The fixture's selection names a neuron this graph does not have, so the frame is empty —
    # what is checked is that the column survives, since a frame with no columns at all is what
    # makes a later merge against a real one fail.
    selected = cell_ns["flow_chart_selected"]
    check(
        "the selection frame keeps a neuronId column",
        "neuronId" in selected.columns,
        f"{len(selected)} rows",
    )

print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
