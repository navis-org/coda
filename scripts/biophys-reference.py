"""Run the synthetic biophysics cases in NEURON and write the fixture the solver tests compare to.

    pnpm biophys:reference

Reads what `biophys-cases.ts` wrote and writes `src/biophys/__fixtures__/neuron-reference.json`:
per case, NEURON's traces every `STRIDE` samples, and both d_lambda segment counts. Regenerate it
after changing a case; the solver is checked against it in `pnpm test` with no NEURON installed.
No wall clock goes into the file, so a regeneration that changes nothing changes no bytes.
"""

import json
import sys

from biophys_neuron import run_case

# Every 4th sample of a 25 µs run: 0.1 ms, fine enough to place a spike, small enough to commit.
STRIDE = 4

cases_path, out_path = sys.argv[1], sys.argv[2]
with open(cases_path) as f:
    cases = json.load(f)

fixture = {"stride": STRIDE, "cases": []}
for case in cases:
    result = run_case(case)
    entry = {
        "name": case["name"],
        "traces": [[round(x, 7) for x in trace[::STRIDE]] for trace in result["traces"]],
        "ourNseg": [s["nseg"] for s in case["sections"]],
    }
    if "neuronNseg" in result:
        entry["neuronNseg"] = result["neuronNseg"]
    fixture["cases"].append(entry)
    print(f"{case['name']}: {len(case['sections'])} sections, {sum(entry['ourNseg'])} segments")

with open(out_path, "w") as f:
    json.dump(fixture, f, separators=(",", ":"))
    f.write("\n")
print(f"→ {out_path}")
