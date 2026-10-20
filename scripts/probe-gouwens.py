"""Hold the biophysics model to Gouwens & Wilson 2009's own NEURON model of DM1 projection neurons.

    pnpm probe:gouwens

Their model (ModelDB 118662) is the source of the "Drosophila PN" preset, by way of Tobin et al.
2017. This builds their reconstructed DM1 cells as they did, with the passive constants each of
their Fig. 4 scripts sets, and asks what the figure shows: the input resistance at the soma, and
how much of a voltage held at the soma reaches every tip in the steady state. Three steps, one file
between them (`/tmp/coda-gouwens-probe.json`):

1. `export` (here): their morphology in NEURON, exported as a skeleton (every 3D point a node), with
   NEURON's answers on their own segment counts and on d_lambda's.
2. `scripts/probe-gouwens.ts`: our model of the same skeleton, cut by d_lambda, and its answers.
3. `compare` (here): ours against NEURON's converged answer, beside NEURON's own at coarser cuts.

Measured (2026-10-18), against NEURON at 0.1 µm segments, whose input resistance moves 0.012%
between 0.1 and 0.05 µm:

- **Ours, at d_lambda's cut: input resistance within 0.03–0.09%, every tip's share within 5e-4**, on
  all five. The residual is the 10 µm² annulus a skeleton puts where the 10 µm soma meets thin
  neurites (consecutive points at one place, two radii), which NEURON's sections never have.
- **NEURON on their own segment counts is 0.3–0.55% low** (tip shares within 4e-3): the published
  model was nearly converged.
- **NEURON at d_lambda's cut is 7–14% low** (tip shares off by up to 0.087), from a rule
  `docs/biophys.md` already records: a child joined at x < 1 hangs from its parent's last segment
  centre, and their export joins 30 children at x = 0.99999994 — one of them the primary neurite's,
  so at one segment a section the whole dendrite hangs from its midpoint. Ours joins at the point.

One trap, in the export: `trueparentseg()` answers None for a section on the root's 0 end, which is
where these templates attach the soma's other half; `parentseg()` does not, and the first version of
this probe dropped that 10 µm cylinder and read 0.7% high.

Their files are downloaded into `/tmp/coda-gouwens` on first use and never committed: the ModelDB
repository carries no licence. Local only: needs `pip install neuron`. Nothing here touches a
server but GitHub's, once, for those files.
"""

import json
import math
import os
import sys
import urllib.request

PATH = "/tmp/coda-gouwens-probe.json"
CACHE = "/tmp/coda-gouwens"
RAW = "https://raw.githubusercontent.com/ModelDBRepository/118662/HEAD/"
# Their Fig. 4A scripts: all three on `dm1_morph_2`, each with one cell's fitted constants. The third
# is the "Drosophila PN" preset's (Tobin et al. rounded Cm to 0.8). The other two morphologies at
# that preset's constants, as the shapes the preset is used on.
CASES = [
    ("cell 1 (Fig. 4A)", "dm1_morph_2.hoc", {"rm": 8300, "cm": 2.57, "ra": 163.9}),
    ("cell 2 (Fig. 4A)", "dm1_morph_2.hoc", {"rm": 20400, "cm": 1.50, "ra": 102.5}),
    ("cell 3 (Fig. 4A)", "dm1_morph_2.hoc", {"rm": 20800, "cm": 0.79, "ra": 266.1}),
    ("morphology 1", "dm1_morph_1.hoc", {"rm": 20800, "cm": 0.79, "ra": 266.1}),
    ("morphology 3", "dm1_morph_3.hoc", {"rm": 20800, "cm": 0.79, "ra": 266.1}),
]
E_LEAK = -60.0
D_LAMBDA = {"kind": "dLambda", "dLambda": 0.1, "frequency": 100}
# µm: NEURON's converged answer, its input resistance moving < 0.02% below this.
FINE_UM = 0.1


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        urllib.request.urlretrieve(RAW + name, path)
    return path


def mechanisms():
    """Their `LeakConductance`, which the morphology inserts, compiled once in the cache."""
    from biophys_neuron import load_mechanisms

    where = os.path.join(CACHE, "mod")
    os.makedirs(where, exist_ok=True)
    mod = os.path.join(where, "LeakConductance.mod")
    if not os.path.exists(mod):
        with open(fetch("LeakConductance.mod")) as src, open(mod, "w") as dst:
            dst.write(src.read())
    load_mechanisms(where)


def build(morph):
    """One instance of a neuroConstruct template, its sections and the root section."""
    from neuron import h

    h.load_file("stdlib.hoc")
    text = open(fetch(morph)).read()
    template = text.split("begintemplate ", 1)[1].split()[0]
    if not hasattr(h, template):
        h.load_file(fetch(morph))
    cell = getattr(h, template)("probe", template, "")
    secs = list(cell.all)
    # `parentseg`, never `trueparentseg`: the latter answers None for a section on the root's 0 end,
    # which is how these templates attach the soma's other half — a 10 µm cylinder silently dropped.
    root = next(s for s in secs if s.parentseg() is None)
    return cell, secs, root


def passive(secs, p):
    """Their constants, on NEURON's own `pas` in place of the leak their template inserts."""
    for sec in secs:
        sec.Ra = p["ra"]
        sec.cm = p["cm"]
        sec.uninsert("LeakConductance")
        sec.insert("pas")
        for seg in sec:
            seg.pas.g = 1 / p["rm"]
            seg.pas.e = E_LEAK


def answers(root, tips):
    """Input resistance at the root (MΩ), and each tip's steady-state share of the root's voltage."""
    from neuron import h

    imp = h.Impedance()
    imp.loc(0, sec=root)
    imp.compute(0)
    rin = imp.input(0, sec=root)
    # Current into the root: V(tip) = Z(tip, root)·I and V(root) = Z(root)·I.
    return rin, [imp.transfer(1, sec=tip) / rin for tip in tips]


def export():
    from neuron import h

    from biophys_neuron import dlambda_nseg

    mechanisms()
    out = []
    for name, morph, p in CASES:
        cell, secs, root = build(morph)
        # Every 3D point a node; a section's first point hangs from the node where it joins its
        # parent — at the parent's end, or the root's 0 end — which `connect` puts at x = 1 or 0.
        positions, radii, parent = [], [], []
        last = {}
        first = {}
        order = [root]
        children = {}
        for sec in secs:
            ps = sec.parentseg()
            if ps is not None:
                children.setdefault(ps.sec.name(), []).append(sec)
        k = 0
        while k < len(order):
            sec = order[k]
            k += 1
            order.extend(children.get(sec.name(), []))
        for sec in order:
            ps = sec.parentseg()
            if ps is None:
                up = -1
            else:
                up = last[ps.sec.name()] if ps.x > 0.5 else first[ps.sec.name()]
            for i in range(int(h.n3d(sec=sec))):
                positions += [h.x3d(i, sec=sec), h.y3d(i, sec=sec), h.z3d(i, sec=sec)]
                radii.append(h.diam3d(i, sec=sec) / 2)
                parent.append(up)
                up = len(radii) - 1
                if i == 0:
                    first[sec.name()] = up
            last[sec.name()] = up
        # Only what hangs from the root: a floating piece reaches no soma, and our model drops it too.
        tips = [s for s in order if not children.get(s.name())]
        tip_nodes = [last[s.name()] for s in tips]
        floating = len(secs) - len(order)

        passive(secs, p)
        own = answers(root, tips)
        own_nseg = sum(s.nseg for s in order)
        for sec in order:
            sec.nseg = dlambda_nseg(sec, D_LAMBDA)
        fine = answers(root, tips)
        dl_nseg = sum(s.nseg for s in order)
        # And converged: NEURON attaches a child at x < 1 to its parent's last segment centre, which
        # their export does at x = 0.99999994 on 30 joins, so its answer settles only as segments shrink.
        for sec in order:
            n = max(1, int(sec.L / FINE_UM))
            sec.nseg = n if n % 2 else n + 1
        converged = answers(root, tips)
        out.append(
            {
                "name": name,
                "morph": morph,
                "tree": {"positions": positions, "radii": radii, "parent": parent},
                "ra": p["ra"],
                "cm": p["cm"],
                "gLeak": 1 / p["rm"],
                "eLeak": E_LEAK,
                "rule": D_LAMBDA,
                "tips": tip_nodes,
                "neuron": {
                    "own": {"nseg": own_nseg, "rin": own[0], "atten": own[1]},
                    "dLambda": {"nseg": dl_nseg, "rin": fine[0], "atten": fine[1]},
                    "converged": {
                        "nseg": sum(s.nseg for s in order),
                        "rin": converged[0],
                        "atten": converged[1],
                    },
                },
            }
        )
        print(f"{name}: {len(order)} sections ({floating} not connected to the root), "
              f"{len(radii)} points, {len(tips)} tips")
        del cell, secs, root
    with open(PATH, "w") as f:
        json.dump(out, f)


def compare():
    with open(PATH) as f:
        cases = json.load(f)

    def worst(a, b):
        return max(abs(x - y) for x, y in zip(a, b))

    # Every answer against NEURON's converged one: ours at d_lambda's cut, and NEURON at their own
    # segment counts and at d_lambda's, which is what an unconverged NEURON costs on these cells.
    print(f"{'':18} {'input resistance, MΩ':^42}   {'tip share, max |Δ| vs converged':^34}")
    print(f"{'case':18} {'converged':>10} {'ours':>10} {'their nseg':>10} {'d_lambda':>10}   "
          f"{'ours':>10} {'their nseg':>11} {'d_lambda':>10}")
    for c in cases:
        n, ours = c["neuron"], c["ours"]
        ref = n["converged"]

        def rel(x):
            return f"{x / ref['rin'] - 1:+.1e}"

        print(
            f"{c['name']:18} {ref['rin']:10.2f} {rel(ours['rin']):>10} {rel(n['own']['rin']):>10} "
            f"{rel(n['dLambda']['rin']):>10}   {worst(ours['atten'], ref['atten']):10.1e} "
            f"{worst(n['own']['atten'], ref['atten']):11.1e} {worst(n['dLambda']['atten'], ref['atten']):10.1e}"
        )
    print("\nsegments: converged / ours / their nseg / d_lambda")
    for c in cases:
        n = c["neuron"]
        print(f"  {c['name']:18} {n['converged']['nseg']} / {c['ours']['nseg']} / "
              f"{n['own']['nseg']} / {n['dLambda']['nseg']}")


if __name__ == "__main__":
    {"export": export, "compare": compare}[sys.argv[1]]()
