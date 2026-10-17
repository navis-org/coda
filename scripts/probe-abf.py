"""Hold Coda's ABF reader against pyABF on a real file.

    pnpm probe:abf <file.abf>

`probe-abf.ts` writes what Coda read to /tmp/coda-abf-probe.json; this reads the same file with
pyABF (`pip install pyabf`) and compares the summary, every recorded sample and every rebuilt
command sample. Nothing in the app or CI depends on it, and no recording is committed.
"""

import json
import math
import sys

import numpy as np
import pyabf

path = sys.argv[1]
ours = json.load(open("/tmp/coda-abf-probe.json"))
abf = pyabf.ABF(path)
s = ours["summary"]
print(f"{s['format']} · {s['protocol']} · {s['mode']} · {s['sweeps']} sweeps × {s['sweepSamples']} samples at {s['rate']:g} Hz · read in {ours['ms']:.0f} ms")
print("channels:", [(c["name"], c["unit"]) for c in s["channels"]], "| commands:", [(c["name"], c["unit"]) for c in s["commands"]])
for note in s["notes"]:
    print("note:", note)

assert s["sweeps"] == abf.sweepCount, (s["sweeps"], abf.sweepCount)
assert s["sweepSamples"] == abf.sweepPointCount
assert math.isclose(s["rate"], abf.dataRate, rel_tol=1e-6), (s["rate"], abf.dataRate)
assert [c["name"] for c in s["channels"]] == abf.adcNames
assert [c["unit"] for c in s["channels"]] == abf.adcUnits

worst = 0.0
for c in range(abf.channelCount):
    for sweep in range(abf.sweepCount):
        abf.setSweep(sweep, channel=c)
        diff = np.max(np.abs(np.array(ours["channels"][c][sweep], dtype=np.float32) - abf.sweepY))
        worst = max(worst, float(diff))
print(f"channels: largest difference {worst:g} across {abf.channelCount} × {abf.sweepCount} sweeps")
assert worst <= 1e-4, worst

# The commands Coda rebuilt are the DACs with an epoch waveform; pyABF's sweepC per DAC.
enabled = [d for d in range(abf._dacSection._entryCount)
           if abf._dacSection.nWaveformEnable[d] and abf._dacSection.nWaveformSource[d] == 1]
worst = 0.0
for k, d in enumerate(enabled):
    for sweep in range(abf.sweepCount):
        abf.setSweep(sweep, channel=min(d, abf.channelCount - 1))
        theirs = pyabf.stimulus.Stimulus(abf, d).stimulusWaveform(sweep)
        mine = np.array([np.nan if v is None else v for v in ours["commands"][k][sweep]], dtype=float)
        both = ~(np.isnan(mine) & np.isnan(theirs))
        diff = np.nanmax(np.abs(mine[both] - theirs[both])) if both.any() else 0.0
        worst = max(worst, float(diff))
print(f"commands: largest difference {worst:g} across {len(enabled)} output(s)")
assert worst <= 1e-4, worst
print("agrees with pyABF")
