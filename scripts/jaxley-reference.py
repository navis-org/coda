"""Run Pospischil cases in Jaxley and write the fixture our solver is held to: one isopotential
compartment, and a branched cable with a shifted threshold.

    python3 scripts/jaxley-reference.py src/biophys/__fixtures__/jaxley-reference.json

Needs Jaxley installed (a virtualenv of its own; nothing here imports it otherwise). The case is the
one `channels.test.ts` builds with our solver: a 20 µm cylinder, 20 µm across, Jaxley's own
Pospischil leak, Na and K at its default densities, stepped with a current, at rest before it.
Every 4th sample of a 25 µs run is kept. No wall clock goes into the file.
"""

import json
import sys

import jax

jax.config.update("jax_enable_x64", True)

import jaxley as jx  # noqa: E402
from jaxley.channels.pospischil import K, Leak, Na  # noqa: E402

STRIDE = 4
DT = 0.025
DURATION = 50.0
CASE = {
    "radius": 10.0,  # µm
    "length": 20.0,  # µm
    "capacitance": 1.0,  # µF/cm²
    "gLeak": 1e-4,  # S/cm²
    "eLeak": -70.0,
    "gNa": 50e-3,
    "gK": 5e-3,
    "vInit": -70.0,
    # A step from 5 ms for 40 ms, nA.
    "clamp": {"delay": 5.0, "duration": 40.0, "amplitude": 0.2},
}

out_path = sys.argv[1]

comp = jx.Compartment()
cell = jx.Cell([jx.Branch([comp], ncomp=1)], parents=[-1])
cell.set("radius", CASE["radius"])
cell.set("length", CASE["length"])
cell.set("capacitance", CASE["capacitance"])
cell.insert(Leak())
cell.insert(Na())
cell.insert(K())
cell.set("Leak_gLeak", CASE["gLeak"])
cell.set("Leak_eLeak", CASE["eLeak"])
cell.set("Na_gNa", CASE["gNa"])
cell.set("K_gK", CASE["gK"])
cell.set("v", CASE["vInit"])
cell.init_states()

clamp = CASE["clamp"]
current = jx.step_current(clamp["delay"], clamp["duration"], clamp["amplitude"], DT, DURATION)
cell.branch(0).comp(0).stimulate(current)
cell.branch(0).comp(0).record("v")
v = jx.integrate(cell, delta_t=DT)[0]

# A branched cable: three branches of five 16 µm compartments (Jaxley's `length` is a
# compartment's, not a branch's), Pospischil everywhere, `vt` raised by 5 mV — which shifts every
# gate of both channels, and is our ΔV50 of +5 on each (`channels.test.ts`): a check from outside
# on the shift's sign and on a multi-compartment Pospischil cable, branch point included.
BRANCHED = {
    "branches": 3,
    "ncomp": 5,
    "compLength": 16.0,  # µm
    "radius": 1.0,  # µm
    "axialResistivity": 100.0,  # Ω·cm
    "vt": -55.0,  # Jaxley's default is −60
    "clamp": {"delay": 5.0, "duration": 30.0, "amplitude": 0.05},
    "duration": 40.0,
    # (branch, compartment) recorded: the clamped one, and each child's last.
    "record": [[0, 0], [1, 4], [2, 4]],
}

tree = jx.Cell([jx.Branch(jx.Compartment(), ncomp=BRANCHED["ncomp"])] * 3, parents=[-1, 0, 0])
tree.set("radius", BRANCHED["radius"])
tree.set("length", BRANCHED["compLength"])
tree.set("capacitance", CASE["capacitance"])
tree.set("axial_resistivity", BRANCHED["axialResistivity"])
tree.insert(Leak())
tree.insert(Na())
tree.insert(K())
tree.set("Leak_gLeak", CASE["gLeak"])
tree.set("Leak_eLeak", CASE["eLeak"])
tree.set("Na_gNa", CASE["gNa"])
tree.set("K_gK", CASE["gK"])
tree.set("vt", BRANCHED["vt"])
tree.set("v", CASE["vInit"])
tree.init_states()
step = BRANCHED["clamp"]
tree.branch(0).comp(0).stimulate(
    jx.step_current(step["delay"], step["duration"], step["amplitude"], DT, BRANCHED["duration"])
)
for b, c in BRANCHED["record"]:
    tree.branch(b).comp(c).record("v")
branched = jx.integrate(tree, delta_t=DT)

fixture = {
    "jaxley": jx.__version__,
    "dt": DT,
    "stride": STRIDE,
    "case": CASE,
    "v": [round(float(x), 7) for x in v[::STRIDE]],
    "branched": {
        **BRANCHED,
        "v": [[round(float(x), 7) for x in trace[::STRIDE]] for trace in branched],
    },
}
with open(out_path, "w") as f:
    json.dump(fixture, f, indent=1)
    f.write("\n")
print(f"{len(fixture['v'])} samples → {out_path}", file=sys.stderr)
