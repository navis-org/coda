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
# A blank name: Coda reads it as blank (the table then numbers the channel), where pyABF keeps
# ABF1's NUL padding as characters, or puts "?" in its place.
blank = lambda n: n.replace("\x00", "").strip().strip("?")
assert [c["name"] for c in s["channels"]] == [blank(n) for n in abf.adcNames], ([c["name"] for c in s["channels"]], abf.adcNames)
assert [c["unit"] for c in s["channels"]] == abf.adcUnits, ([c["unit"] for c in s["channels"]], abf.adcUnits)

worst = 0.0
for c in range(abf.channelCount):
    for sweep in range(abf.sweepCount):
        abf.setSweep(sweep, channel=c)
        mine = np.array(ours["channels"][c][sweep], dtype=float)
        # Relative to the value: pyABF scales in float32, so a pA trace in the thousands differs
        # by a float32 step (1e-3) where a mV trace differs by 1e-5.
        diff = np.max(np.abs(mine - abf.sweepY) / np.maximum(1.0, np.abs(abf.sweepY)))
        worst = max(worst, float(diff))
print(f"channels: largest relative difference {worst:g} across {abf.channelCount} × {abf.sweepCount} sweeps")
assert worst <= 1e-6, worst

# The commands Coda rebuilt are the DACs with an epoch waveform; pyABF's sweepC per DAC.
if abf.abfVersion["major"] == 1:
    # ABF1: two outputs, their switches in the one header.
    h = abf._headerV1
    enabled = [d for d in range(2) if h.nWaveformEnable[d] and h.nWaveformSource[d] == 1]
else:
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
