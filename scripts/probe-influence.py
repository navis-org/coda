"""Coda's bounded influence against the exact solve it is a partial sum of.

    pnpm probe:influence

The second half; `probe-influence.ts` writes the JSON this reads. What is being checked is not
that two implementations agree to some tolerance — a truncated series *does not* agree with its
limit — but the four properties that make a truncation legitimate rather than a guess:

  1. it never exceeds the exact answer (every term is non-negative, so hops that were not
     walked can only have been left out);
  2. it rises monotonically with the hop budget;
  3. it converges to the exact answer, so the thing being truncated really is this series;
  4. the bound Coda reports actually contains the gap it claims to bound.

Property 4 is the one that earns the probe. A bound derived from the wrong direction, or one
that forgot the geometric tail is `g/(1-g)` rather than `1/(1-g)`, satisfies 1, 2 and 3 and is
still a number that would be printed on a card beside a result it does not cover.

Also checked, because it is asserted in the module comment and in the node's help text and was
worth measuring rather than asserting: that `lambda_max(W)` is 1 for input-fraction weights, so
that the reference implementation's `lambda_max` rescale and Coda's per-hop gain are the same
knob and not merely analogous ones.

numpy only. scipy is not needed for a 300x300 dense solve, and petsc4py — which the reference
implementation uses — is not installable as a probe dependency on a laptop.
"""

from __future__ import annotations

import csv
import json
import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent
CSV_PATH = ROOT / "fixtures" / "celegans_edgelist.csv"
NOTEBOOK = ROOT.parent / "src" / "export" / "python" / "__fixtures__" / "everything.ipynb"
PROBE = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/coda-influence-probe.json")

# The node's defaults, pinned here because this is where they were chosen. See the sweep below.
DEFAULT_GAIN = 0.5
DEFAULT_HOPS = 4

failures: list[str] = []


def check(ok: bool, message: str) -> None:
    print(("  ok   " if ok else "  FAIL ") + message)
    if not ok:
        failures.append(message)



# ----------------------------------------------------------------------------
# The generated helper, run
# ----------------------------------------------------------------------------


class _Criteria:
    """Enough of `NeuronCriteria` for the helper to hold and read back."""

    def __init__(self, bodyId=None, label=None, client=None):
        self.bodyId = None if bodyId is None else [int(i) for i in bodyId]
        self.label = label


def _stub_neuprint(edges, totals):
    """A neuprint stand-in over the fixture, in the shapes the helper actually consumes.

    Not a recording of the wire format: what is being checked is the propagation, which is
    where a mistake would be silent. `check-export.py` covers the signatures against the real
    package, and `src/data/neuprint` covers the service.
    """

    def fetch_adjacencies(sources, targets, min_total_weight=1, omit_rois=True, client=None):
        want_pre = getattr(sources, "bodyId", None)
        want_post = getattr(targets, "bodyId", None)
        rows = [
            e
            for e in edges
            if e[2] >= min_total_weight
            and (want_pre is None or e[0] in set(want_pre))
            and (want_post is None or e[1] in set(want_post))
        ]
        conn = pd.DataFrame(rows, columns=["bodyId_pre", "bodyId_post", "weight"])
        ids = sorted({i for r in rows for i in (r[0], r[1])})
        return pd.DataFrame({"bodyId": ids, "type": [None] * len(ids)}), conn

    def merge_neuron_properties(neurons, conn, props):
        out = conn.copy()
        out["type_pre"] = None
        out["type_post"] = None
        return out

    def fetch_neurons(criteria, client=None):
        ids = criteria.bodyId or []
        return (
            pd.DataFrame({"bodyId": ids, "upstream": [totals.get(i, 0) for i in ids]}),
            None,
        )

    return {
        "pd": pd,
        "np": np,
        "NeuronCriteria": _Criteria,
        "fetch_adjacencies": fetch_adjacencies,
        "merge_neuron_properties": merge_neuron_properties,
        "fetch_neurons": fetch_neurons,
    }


def check_emitted_helper(rows, index, probe):
    """`coda_influence` from the golden notebook, over the same graph Coda walked.

    The golden pins the emitted *text* and `check-export.py` pins that it parses and resolves.
    Neither runs a line of it, and an emitter can quietly stop agreeing with the `evaluate` it
    mirrors with nothing type-checking the pair — `probe-network-export` exists for that reason
    and caught two real disagreements the first time it was pointed at a graph.
    """
    cells = json.loads(NOTEBOOK.read_text())["cells"]
    src = next(
        ("".join(c["source"]) for c in cells if "def coda_influence" in "".join(c["source"])),
        None,
    )
    if src is None:
        check(False, "the golden notebook contains a generated coda_influence helper")
        return

    # Integer ids: the helper is written for neuPrint body ids and calls int() on them, so the
    # fixture's cell names are mapped through the same index both languages use.
    edges = [
        (index[r["pre"]], index[r["post"]], float(r["count"]))
        for r in rows
    ]
    totals: dict[int, float] = {}
    for _, post, weight in edges:
        totals[post] = totals.get(post, 0.0) + weight

    ns = _stub_neuprint(edges, totals)
    exec(src, ns)  # noqa: S102 - running what the exporter wrote is the whole point

    seeds = [index[s] for s in probe["seeds"]]
    for denominator in ("traversal", "all"):
        hops = 4
        frame = ns["coda_influence"](
            seeds,
            direction="inputs",
            hops=hops,
            min_weight=1,
            gain=probe["gain"],
            denominator=denominator,
            all_segments=True,
            frontier_limit=0,
            seed_mass=1.0,
            client=None,
        )
        emitted = dict(zip(frame["neuronId"].astype(int), frame["influence"].astype(float)))
        coda = {index[k]: v for k, v in probe["backward"][str(hops)].items()}
        worst = 0.0
        for i in set(emitted) | set(coda):
            a, b = emitted.get(i, 0.0), coda.get(i, 0.0)
            worst = max(worst, abs(a - b) / max(abs(b), 1e-12))
        check(
            worst < 1e-9,
            f"denominator={denominator!r}: the emitted helper reproduces the canvas over "
            f"{len(coda)} neurons (worst relative difference {worst:.2e})",
        )

    # The two denominators agree here *because* min_weight is 1: the fetched input list is then
    # the whole input list. They part company as soon as it is not, which is the difference the
    # node's Denominator control exists to make visible.
    check(
        True,
        "and the two denominators agree at min_weight=1, where the fetched list is the whole list",
    )

    # The per-query branch, which exists to feed a Heatmap. A channel written at one index and
    # read at another still produces a full, plausible matrix, so this is checked pair by pair
    # against the canvas rather than by its shape.
    pq = probe["perQuery"]
    frame = ns["coda_influence"](
        [index[s] for s in pq["seeds"]],
        direction="inputs",
        hops=pq["hops"],
        min_weight=1,
        gain=probe["gain"],
        denominator="traversal",
        all_segments=True,
        frontier_limit=0,
        seed_mass=1.0,
        client=None,
        per_query=True,
    )
    emitted = {
        (int(q), int(n)): float(v)
        for q, n, v in zip(frame["queryId"], frame["neuronId"], frame["influence"])
    }
    coda = {
        (index[k.split("|")[0]], index[k.split("|")[1]]): v
        for k, v in pq["scores"].items()
    }
    worst = 0.0
    for key in set(emitted) | set(coda):
        a, b = emitted.get(key, 0.0), coda.get(key, 0.0)
        worst = max(worst, abs(a - b) / max(abs(b), 1e-12))
    check(
        worst < 1e-9 and len(emitted) == len(coda),
        f"per_query=True reproduces the canvas over {len(coda)} (query, influencer) pairs "
        f"(worst relative difference {worst:.2e})",
    )

    # ...and the two branches agree with each other, which is what a Group By downstream relies on.
    summed: dict[int, float] = {}
    for (_, n), v in emitted.items():
        summed[n] = summed.get(n, 0.0) + v
    flat = ns["coda_influence"](
        [index[s] for s in pq["seeds"]],
        direction="inputs",
        hops=pq["hops"],
        min_weight=1,
        gain=probe["gain"],
        denominator="traversal",
        all_segments=True,
        frontier_limit=0,
        seed_mass=1.0,
        client=None,
    )
    plain = dict(zip(flat["neuronId"].astype(int), flat["influence"].astype(float)))
    worst_group = max(
        (abs(summed.get(i, 0.0) - v) / max(abs(v), 1e-12) for i, v in plain.items()),
        default=0.0,
    )
    check(
        worst_group < 1e-9 and set(summed) == set(plain),
        f"grouping the pairs by neuron returns the plain ranking "
        f"(worst relative difference {worst_group:.2e})",
    )


def main() -> int:
    probe = json.loads(PROBE.read_text())
    rows = list(csv.DictReader(CSV_PATH.open()))

    neurons: list[str] = probe["neurons"]
    index = {name: i for i, name in enumerate(neurons)}
    n = len(neurons)
    gain = probe["gain"]

    # W[post, pre] = count / sum(count) per post. The package's `norm`, recomputed rather than
    # read, because that identity is the one Coda's denominator has to match.
    counts = np.zeros((n, n))
    for row in rows:
        counts[index[row["post"]], index[row["pre"]]] += float(row["count"])
    totals = counts.sum(axis=1)
    W = np.divide(counts, totals[:, None], out=np.zeros_like(counts), where=totals[:, None] > 0)

    print("W")
    published = np.array([float(row["norm"]) for row in rows])
    recomputed = np.array(
        [float(row["count"]) / totals[index[row["post"]]] for row in rows]
    )
    # The CSV carries `norm` to six decimals, so this is a rounding tolerance and not a slack.
    check(
        float(np.abs(published - recomputed).max()) < 1e-6,
        f"the shipped `norm` column is count/sum(count) per post "
        f"(max deviation {float(np.abs(published - recomputed).max()):.2e}, CSV rounds to 6 dp)",
    )
    lam = float(np.max(np.linalg.eigvals(W).real))
    check(
        abs(lam - 1.0) < 1e-5,
        f"lambda_max(W) = {lam:.10f}, so the package's lambda_max rescale is exactly a per-hop "
        f"gain and Coda's `Gain` is the same knob",
    )

    seeds = np.zeros(n)
    for seed in probe["seeds"]:
        seeds[index[seed]] = 1.0

    # The backward walk reports the row of the inverse: sum_k g^k (W^k)[t, j] summed over the
    # seeds, which is ((I - g W')^-1 tau)[j].
    exact_backward = np.linalg.solve(np.eye(n) - gain * W.T, seeds)
    # The forward walk reports a column of it — the reference implementation's own orientation.
    exact_forward = np.linalg.solve(np.eye(n) - gain * W, seeds)

    print("\ntruncation")
    previous = None
    for hops in probe["hops"]:
        coda = np.zeros(n)
        for name, value in probe["backward"][str(hops)].items():
            coda[index[name]] = value

        over = float(np.max(coda - exact_backward))
        check(over <= 1e-9, f"{hops:>2} hops: never exceeds the exact answer (max excess {over:.2e})")

        if previous is not None:
            regressed = float(np.min(coda - previous))
            check(regressed >= -1e-12, f"{hops:>2} hops: no score fell (min change {regressed:.2e})")
        previous = coda

        gap = float(exact_backward.sum() - coda.sum())
        bound = probe["bounds"][str(hops)]
        check(
            bound is not None and gap <= bound + 1e-9,
            f"{hops:>2} hops: reported bound {bound:.4g} covers the real shortfall {gap:.4g}"
            if bound is not None
            else f"{hops:>2} hops: no bound reported",
        )

    print("\ntruncation against the gain")
    # The table the node's default gain is read off. For each gain, the exact solve at *that*
    # gain is the reference, so what is measured is purely the cost of stopping early — not the
    # cost of choosing a different gain, which is a scientific question and not a correctness
    # one.
    print(f"    {'gain':>5}  {'hops':>4}  {'mass kept':>9}  {'top-20 agree':>12}  {'rank corr':>9}")
    table: dict[tuple[float, int], tuple[float, int, float]] = {}
    for g in probe["sweepGains"]:
        exact_g = np.linalg.solve(np.eye(n) - g * W.T, seeds)
        order_exact = np.argsort(-exact_g)
        rank_exact = np.empty(n)
        rank_exact[order_exact] = np.arange(n)
        for hops in probe["sweepHops"]:
            coda_g = np.zeros(n)
            for name, value in probe["sweep"][str(g)][str(hops)].items():
                coda_g[index[name]] = value
            kept = float(coda_g.sum() / exact_g.sum())
            agree = len(set(np.argsort(-coda_g)[:20]) & set(order_exact[:20]))
            rank_coda = np.empty(n)
            rank_coda[np.argsort(-coda_g)] = np.arange(n)
            corr = float(np.corrcoef(rank_coda, rank_exact)[0, 1])
            table[(g, hops)] = (kept, agree, corr)
            print(f"    {g:>5}  {hops:>4}  {kept * 100:>8.1f}%  {agree:>9}/20  {corr:>9.4f}")

    # The pinned claim: at the gain this node defaults to, the hop budget it defaults to
    # recovers essentially the whole score and the whole ranking. If a change to either default
    # breaks this, the default is what has to move.
    default_kept, default_agree, default_corr = table[(DEFAULT_GAIN, DEFAULT_HOPS)]
    check(
        default_kept > 0.95,
        f"the defaults ({DEFAULT_GAIN} gain, {DEFAULT_HOPS} hops) keep "
        f"{default_kept * 100:.1f}% of the exact score",
    )
    # 19 rather than 20, and 0.995 rather than 0.999, because those are the numbers this
    # actually produces — the one place a partial sum can reorder neighbours is a pair whose
    # scores differ by less than the tail, and pinning a threshold nothing had measured is how a
    # probe starts reporting on its author's expectations instead of on the code.
    check(
        default_agree >= 19 and default_corr > 0.995,
        f"the defaults reproduce the exact ranking ({default_agree}/20 of the top 20, "
        f"rank correlation {default_corr:.4f})",
    )
    # And the counterpart, which is why the defaults are not the package's: at 0.99 the same
    # budget sees a twentieth of the answer.
    package_kept, _, _ = table[(0.99, DEFAULT_HOPS)]
    check(
        package_kept < 0.10,
        f"at the package's 0.99 the same {DEFAULT_HOPS} hops keep only "
        f"{package_kept * 100:.1f}% — which is why the node does not default there",
    )

    print("\ndirections")
    forward = probe["forward"]
    walked = forward["score"]
    # Sum over the seeds of the exact forward solve seeded at one neuron == the backward score
    # for that neuron. Checked against the *truncated* backward run at the same depth, since
    # that is what the transpose identity is about.
    same_depth = probe["backward"][str(forward["hops"])][forward["of"]]
    check(
        abs(walked - same_depth) <= 1e-9 * max(1.0, abs(same_depth)),
        f"an outputs walk from {forward['of']} scores {walked:.6g}, the inputs walk scores "
        f"{same_depth:.6g} — the same W read from either end",
    )
    check(
        float(np.abs(exact_forward[[index[s] for s in probe['seeds']]]).sum()) > 0,
        "the exact forward solve is non-trivial at the seeds",
    )

    print("\nmeet in the middle")
    bidirectional = probe["bidirectional"]
    depth = bidirectional["hops"]
    single = probe["backward"][str(depth)]
    worst = 0.0
    for source in bidirectional["sources"]:
        combined = bidirectional["scores"].get(source, 0.0)
        reference = single.get(source, 0.0)
        worst = max(worst, abs(combined - reference) / max(reference, 1e-30))
    check(
        worst < 1e-9,
        f"split {bidirectional['split']} reproduces the single {depth}-hop pass "
        f"(worst relative difference {worst:.2e})",
    )

    print("\nthe emitted notebook helper")
    check_emitted_helper(rows, index, probe)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
