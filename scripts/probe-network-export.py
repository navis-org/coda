#!/usr/bin/env python3
"""Run the *generated* Python graph helpers and check they agree with the canvas.

    pnpm probe:netexport      (this is the second of its three steps)

The counterpart of `probe-py-helpers.py` for `coda_network_metrics` and
`coda_network_centrality`, and it exists for that script's reason: the golden says the emitted
text is unchanged, `check-export.py` says it parses and the names it calls resolve, and
**nothing executes a line of it**. These helpers are networkx, which is exactly where the
mistakes are.

It reads the helper cell out of the golden notebook rather than a transcription, so what is
probed is what the exporter actually writes — `probe-nblast.mjs`'s rule, one language over — and
compares against `/tmp/coda-network-probe.json`, which `probe-network-export.ts` wrote by running
Coda's own implementation over the same graph.

Two columns are compared loosely and both are said out loud rather than quietly skipped:

  * `community` is a *partition*, from networkx's Louvain rather than graphology's. Two
    partitions of equal quality can disagree about every label, so what is checked is the
    modularity they score and the number of groups, not the assignment.
  * `parallelLinks` is 0 here by construction, because the graph the notebook builds comes out of
    `from_pandas_edgelist` and cannot hold two edges on one pair.

Nothing here needs a token or a network.
"""

import json
import math
import sys
from pathlib import Path

import networkx as nx
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
NOTEBOOK = ROOT / "src/export/python/__fixtures__/everything.ipynb"
PROBE = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/coda-network-probe.json")

# Compared, but not to the last bit: an iterative method's stopping rule is not the same in two
# implementations, and a partition is not a number at all.
#
# 1e-8 for the two power iterations is measured rather than picked. Coda stops when the L1 change
# falls below `1e-10 * n`, networkx when it falls below `tol * n` with the tol the helper passes,
# and on this graph the two land about 1.2e-9 apart — converged, by two different rules. Anything
# tighter would fail on arithmetic and anything looser would stop noticing a wrong damping factor.
LOOSE = {"pagerank": 1e-8, "eigenvector": 1e-8, "modularity": 0.05}
PARTITION = {"community", "communities"}


def load_helpers() -> dict:
    """Exec the generated helper cell into a namespace, and hand it back."""
    cells = json.loads(NOTEBOOK.read_text())["cells"]
    for cell in cells:
        source = "".join(cell.get("source", []))
        if cell["cell_type"] == "code" and "def coda_network_metrics(" in source:
            ns = {"pd": pd, "nx": nx}
            exec(compile(source, "generated-helpers", "exec"), ns, ns)  # noqa: S102
            return ns
    raise SystemExit("no generated cell defines coda_network_metrics")


def build(probe: dict) -> nx.DiGraph:
    """The graph as the *notebook* would have it: grouped links, exactly as `net.build` emits."""
    links = pd.DataFrame(probe["links"], columns=["source", "target", "weight"])
    grouped = links.groupby(["source", "target"], dropna=False).agg(
        weight=("weight", "sum"), edges=("weight", "size")
    ).reset_index()
    g = nx.from_pandas_edgelist(
        grouped,
        source="source",
        target="target",
        edge_attr=["weight", "edges"],
        create_using=nx.DiGraph if probe["directed"] else nx.Graph,
    )
    # Isolated nodes carry no link, so the edge list alone loses them — and "how many nodes are
    # isolated" is one of the numbers being checked.
    g.add_nodes_from(probe["nodes"])
    return g


class Report:
    def __init__(self) -> None:
        self.failures = 0
        self.checks = 0

    def compare(self, what: str, ours: object, theirs: object, tolerance: float) -> None:
        self.checks += 1
        if ours is None or (isinstance(ours, float) and math.isnan(ours)):
            ok = theirs is None or (isinstance(theirs, float) and math.isnan(theirs))
        elif isinstance(ours, bool) or isinstance(theirs, bool):
            ok = bool(ours) == bool(theirs)
        else:
            try:
                ok = abs(float(ours) - float(theirs)) <= tolerance
            except (TypeError, ValueError):
                ok = ours == theirs
        if not ok:
            self.failures += 1
            print(f"  MISMATCH {what}: canvas {ours!r}, notebook {theirs!r}")

    def column(self, what: str, ours: list, theirs: list, tolerance: float) -> None:
        if len(ours) != len(theirs):
            self.failures += 1
            self.checks += 1
            print(f"  MISMATCH {what}: {len(ours)} rows on the canvas, {len(theirs)} in the notebook")
            return
        for row, (a, b) in enumerate(zip(ours, theirs)):
            self.compare(f"{what}[{row}]", a, b, tolerance)


def check_frame(report: Report, label: str, ours: dict, theirs: pd.DataFrame) -> None:
    """Compare two frames of the same columns, aligned on `id` where they have one.

    Aligned rather than zipped, and that is not caution: `from_pandas_edgelist` orders a graph's
    nodes by the *edge list*, so the notebook's rows come out in a different order from the
    canvas's node table. Both frames are keyed by `id` and neither promises an order, so
    comparing by position would report forty mismatches for a graph the two agree about
    completely.
    """
    missing = [name for name in ours if name not in theirs.columns]
    if missing:
        report.failures += 1
        print(f"  MISSING in {label}: {', '.join(missing)}")
    if "id" in ours and "id" in theirs.columns:
        theirs = theirs.set_index(theirs["id"].astype(str)).reindex([str(v) for v in ours["id"]])
    for name, values in ours.items():
        if name == "id" or name in PARTITION or name not in theirs.columns:
            continue
        tolerance = LOOSE.get(name, 1e-9)
        report.column(f"{label}.{name}", values, list(theirs[name].where(theirs[name].notna(), None)), tolerance)


def main() -> None:
    probe = json.loads(PROBE.read_text())
    ns = load_helpers()
    g = build(probe)
    report = Report()

    print(f"{g.number_of_nodes()} nodes, {g.number_of_edges()} links")

    nodes, summary = ns["coda_network_metrics"](g)
    check_frame(report, "metrics.nodes", probe["metrics"]["nodes"], nodes)
    check_frame(report, "metrics.summary", probe["metrics"]["summary"], summary)

    options = probe["options"]
    nodes, summary = ns["coda_network_centrality"](
        g,
        betweenness=options["betweenness"],
        closeness=options["closeness"],
        pagerank=options["pagerank"],
        eigenvector=options["eigenvector"],
        communities=options["communities"],
        weighted=options["weighted"],
        samples=options["samples"],
        seed=options["seed"],
        resolution=options["resolution"],
        damping=options["damping"],
    )
    check_frame(report, "centrality.nodes", probe["centrality"]["nodes"], nodes)
    check_frame(report, "centrality.summary", probe["centrality"]["summary"], summary)

    # The partition itself is not compared — see the module docstring — but its *quality* is, and
    # a Louvain that had silently fallen back to one group per node would fail here.
    ours = probe["centrality"]["summary"]
    print(
        f"  communities: canvas {ours['communities'][0]} at modularity "
        f"{ours['modularity'][0]:.4f}; notebook {summary['communities'][0]} at "
        f"{summary['modularity'][0]:.4f}"
    )
    report.compare(
        "centrality.summary.modularity", ours["modularity"][0], summary["modularity"][0], 0.05
    )

    print(f"{report.checks - report.failures}/{report.checks} comparisons agree")
    if report.failures:
        raise SystemExit(f"{report.failures} disagreements between the canvas and the notebook")


if __name__ == "__main__":
    main()
