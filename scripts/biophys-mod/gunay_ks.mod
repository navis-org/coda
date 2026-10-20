: gunay.ks, generated from src/biophys/channels.ts by pnpm biophys:mods. Do not edit:
: modFile.test.ts refuses a file that differs from what the spec writes.
: A non-specific current; its reversal e is set per segment by the harness from the spec.

NEURON {
    SUFFIX gunay_ks
    NONSPECIFIC_CURRENT i
    RANGE gbar, e, i
}

UNITS {
    (mA) = (milliamp)
    (mV) = (millivolt)
    (S) = (siemens)
}

PARAMETER {
    gbar = 0 (S/cm2)
    e = 0 (mV)
}

ASSIGNED {
    v (mV)
    i (mA/cm2)
    minf
    taum (ms)
}

STATE { m }

BREAKPOINT {
    SOLVE states METHOD cnexp
    i = gbar * m * m * m * m * (v - e)
}

INITIAL {
    rates(v)
    m = minf
}

DERIVATIVE states {
    rates(v)
    m' = (minf - m) / taum
}

PROCEDURE rates(v (mV)) {
    minf = 1 / (1 + exp((v - (-12.85)) / (-19.91)))
    taum = (2.03) + (1.96) * 1 / (1 + exp((v - (29.83)) / (3.32)))
}
