"""Build and run a `src/biophys/referenceCases.ts` case in NEURON.

The case arrives as `neuronExport` writes it: our sections (lists of skeleton nodes), our `nseg`
per section, our HH densities per segment and each node's arc fraction `x` along its section. So
NEURON is handed the discretisation rather than re-deriving it, and a comparison measures the
integrator. Its own d_lambda count is still computed — with NEURON's `lambda_f` — and returned
beside ours, so the counting rule is checked too.

Shared by `biophys-reference.py` (the committed fixture) and `probe-biophys.py` (a real skeleton).
Needs `pip install neuron`; nothing in the app or in CI depends on it.
"""

import math

from neuron import h

h.load_file("stdrun.hoc")


def clamp_current(c, tm):
    """A shaped clamp's current at time `tm`, in IClamp's terms: on for `delay <= tm < delay + dur`.

    Written from the shapes' definitions rather than from the TypeScript, which counts steps.
    """
    t = tm - c["delay"]
    if t < 0 or t >= c["duration"]:
        return 0.0
    shape, amp = c["shape"], c["amplitude"]
    if shape["kind"] == "ramp":
        return shape["from"] + (amp - shape["from"]) * t / c["duration"]
    if shape["kind"] == "sine":
        return shape["offset"] + amp * math.sin(2 * math.pi * shape["frequency"] * t / 1000)
    if shape["kind"] == "pulses":
        return amp if math.fmod(t, shape["interval"]) < shape["width"] else 0.0
    if shape["kind"] == "samples":
        k = math.floor(t / shape["every"])
        values = shape["values"]
        return amp * values[k] if 0 <= k < len(values) else 0.0
    raise ValueError(f"unknown clamp shape {shape['kind']}")


def run_case(case):
    """Run one exported case; returns the recorded traces and, under d_lambda, NEURON's count."""
    pos = case["tree"]["positions"]
    rad = case["tree"]["radii"]

    secs = []
    for i, s in enumerate(case["sections"]):
        sec = h.Section(name=f"s{i}")
        for j, node in enumerate(s["nodes"]):
            # A section may start at a diameter of its own (`CableTree.startRadius`).
            diam = s.get("startDiameter", 2 * rad[node]) if j == 0 else 2 * rad[node]
            # ...and begin past its first node (`CableTree.startOffset`), at a soma's surface.
            x, y, z = s["startPoint"] if j == 0 and "startPoint" in s else pos[3 * node : 3 * node + 3]
            h.pt3dadd(x, y, z, diam, sec=sec)
        secs.append(sec)
    for i, s in enumerate(case["sections"]):
        if s["parent"] >= 0:
            secs[i].connect(secs[s["parent"]](s["parentX"]), 0)

    rule = case["rule"]
    neuron_nseg = []
    for sec, s in zip(secs, case["sections"]):
        sec.Ra = case["ra"]
        sec.cm = case["cm"]
        if rule["kind"] == "dLambda":
            # NEURON's own `lambda_f` integrates over the 3d points; the `+ 0.9` rounding around it
            # is fixnseg.hoc's and copied on both sides, so agreement checks the integral.
            lam = h.lambda_f(rule["frequency"], sec=sec)
            neuron_nseg.append(int((sec.L / (rule["dLambda"] * lam) + 0.9) / 2) * 2 + 1)
        # nseg before any mechanism, or NEURON redistributes the densities set below.
        sec.nseg = s["nseg"]
        sec.insert("pas")
        for seg in sec:
            seg.pas.g = case["gLeak"]
            seg.pas.e = case["eLeak"]
        if s.get("hh"):
            sec.insert("hh")
            for seg, d in zip(sec, s["hh"]):
                seg.hh.gnabar = d["gna"]
                seg.hh.gkbar = d["gk"]
                seg.hh.gl = 0

    h.celsius = case["temperature"]
    # hh.mod evaluates its rates directly (its TABLE is commented out since NEURON 8), as the
    # TypeScript side does. An older NEURON with the table needs `h.usetable_hh = 0` here.
    h.secondorder = 0
    h.dt = case["dt"]

    def at(node):
        loc = case["location"][node]
        return secs[loc["section"]](loc["x"])

    keep = []
    netcons = []
    syn = case.get("synapse")
    for site in case.get("synapses", []):
        s = h.Exp2Syn(at(site["node"]))
        s.tau1 = syn["tau1"]
        s.tau2 = syn["tau2"]
        s.e = syn["eRev"]
        nc = h.NetCon(None, s)
        nc.weight[0] = syn["gmax"] * site["count"]
        nc.delay = 0
        keep.append(s)
        netcons.append((nc, site["times"]))
    shaped = []
    for c in case.get("clamps", []):
        ic = h.IClamp(at(c["node"]))
        keep.append(ic)
        shape = c.get("shape")
        if shape is None or shape["kind"] == "step":
            ic.delay = c["delay"]
            ic.dur = c["duration"]
            ic.amp = c["amplitude"]
        else:
            # Always on, its `amp` set before every step to the waveform at that step's half time.
            ic.delay = 0
            ic.dur = 1e9
            shaped.append((ic, c))

    def schedule():
        for nc, times in netcons:
            for t in times:
                nc.event(t)

    fih = h.FInitializeHandler(schedule)

    traces = [h.Vector().record(at(node)._ref_v) for node in case["record"]]
    h.finitialize(case["vInit"])
    while h.t < case["duration"] - case["dt"] / 2:
        tm = h.t + case["dt"] / 2
        for ic, c in shaped:
            ic.amp = clamp_current(c, tm)
        h.fadvance()

    out = {"traces": [list(v) for v in traces]}
    if neuron_nseg:
        out["neuronNseg"] = neuron_nseg
    del fih, keep, netcons, secs
    return out
