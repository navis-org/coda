"""Hold Coda's NWB reader against pynwb on a real file.

    pnpm probe:nwb <file.nwb>

`probe-nwb.ts` writes what Coda read to /tmp/coda-nwb-probe.json; this reads the same file with
pynwb (`pip install pynwb`), groups its intracellular series by the rule Coda states — the sweeps
sharing an electrode, a series type, a unit, a rate and a length — and compares every group's sweeps
and every sample, response and stimulus, in mV and pA. Nothing in the app or CI depends on it, and no
recording is committed.
"""

import json
import sys
from collections import defaultdict

import numpy as np
from pynwb import NWBHDF5IO
from pynwb.icephys import (
    CurrentClampSeries,
    CurrentClampStimulusSeries,
    IZeroClampSeries,
    VoltageClampSeries,
    VoltageClampStimulusSeries,
)

INTO = {"volts": 1e3, "amperes": 1e12}
path = sys.argv[1]
ours = json.load(open("/tmp/coda-nwb-probe.json"))
io = NWBHDF5IO(path, "r", load_namespaces=True)
nwb = io.read()

responses = [s for s in nwb.acquisition.values() if isinstance(s, (CurrentClampSeries, IZeroClampSeries, VoltageClampSeries))]
stimuli = [s for s in nwb.stimulus.values() if isinstance(s, (CurrentClampStimulusSeries, VoltageClampStimulusSeries))]
numbered = all(getattr(s, "sweep_number", None) is not None for s in responses + stimuli)
# h5py lists a group's members alphabetically, which is the order Coda pairs unnumbered series in.
responses.sort(key=lambda s: s.name)
stimuli.sort(key=lambda s: s.name)
sweep_of = lambda s, i: int(s.sweep_number) if numbered else i
stim_for = {(sweep_of(s, i), s.electrode.name): s for i, s in enumerate(stimuli)}

groups = defaultdict(list)
for i, s in enumerate(responses):
    key = (s.electrode.name, s.neurodata_type, s.unit, float(s.rate), len(s.data))
    groups[key].append((sweep_of(s, i), s))

def relative(mine, theirs):
    # float32 samples: a difference against the value, a pA trace being in the thousands and a
    # mislabelled one in the hundreds of trillions.
    return float(np.max(np.abs(mine - theirs) / np.maximum(1.0, np.abs(theirs))))

def scaled(s):
    return (np.asarray(s.data[:], dtype=float) * s.conversion + getattr(s, "offset", 0.0)) * INTO.get(s.unit, 1.0)

print(f"{len(responses)} responses, {len(stimuli)} stimuli, {len(groups)} groups, numbered: {numbered} · Coda read in {ours['ms']:.0f} ms")
assert len(groups) == len(ours["groups"]), (len(groups), len(ours["groups"]))
theirs = {tuple(sorted(n for n, _ in members)): members for members in groups.values()}
# A file numbering no sweeps gives Coda's groups no sweep numbers: match those by their shape.
by_shape = {(float(m[0][1].rate), len(m[0][1].data), len(m)): m for m in groups.values()}
worst_v = worst_c = 0.0
for g in ours["groups"]:
    s = g["summary"]
    if "sweepNumbers" in s:
        key = tuple(s["sweepNumbers"])
        assert key in theirs, (s["protocol"], key)
        members = sorted(theirs[key], key=lambda m: m[0])
    else:
        key = (s["rate"], s["sweepSamples"], s["sweeps"])
        assert key in by_shape, (s["protocol"], key)
        members = sorted(by_shape[key], key=lambda m: m[0])
    assert s["rate"] == float(members[0][1].rate) and s["sweepSamples"] == len(members[0][1].data)
    for k, (n, series) in enumerate(members):
        worst_v = max(worst_v, relative(np.array(g["channels"][k], dtype=float), scaled(series)))
        stim = stim_for.get((n, series.electrode.name))
        if g["commands"] and stim is not None:
            mine = np.array([np.nan if v is None else v for v in g["commands"][k]], dtype=float)
            worst_c = max(worst_c, relative(mine, scaled(stim)))
    print(f"  {s['protocol']}: {s['sweeps']} sweeps × {s['sweepSamples']} at {s['rate']:g} Hz, {s['channels'][0]['unit']}" + (f", command {s['commands'][0]['unit']}" if s["commands"] else ""))
for note in ours["groups"][0]["summary"]["notes"]:
    print("note:", note)
print(f"largest relative difference: responses {worst_v:g}, stimuli {worst_c:g}")
assert worst_v <= 1e-6 and worst_c <= 1e-6, (worst_v, worst_c)
print("agrees with pynwb")
