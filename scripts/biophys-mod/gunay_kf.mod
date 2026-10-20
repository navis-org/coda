: gunay.kf, generated from src/biophys/channels.ts by pnpm biophys:mods. Do not edit:
: modFile.test.ts refuses a file that differs from what the spec writes.
: A non-specific current; its reversal e is set per segment by the harness from the spec.

NEURON {
    SUFFIX gunay_kf
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
    hinf
    tauh (ms)
}

STATE { m h }

BREAKPOINT {
    SOLVE states METHOD cnexp
    i = gbar * m * m * m * m * h * (v - e)
}

INITIAL {
    rates(v)
    m = minf
    h = hinf
}

DERIVATIVE states {
    rates(v)
    m' = (minf - m) / taum
    h' = (hinf - h) / tauh
}

PROCEDURE rates(v (mV)) {
    minf = 1 / (1 + exp((v - (-17.55)) / (-7.27)))
    taum = (1.94) + (2.66) * 1 / (1 + exp((v - (8.12)) / (7.96)))
    hinf = 1 / (1 + exp((v - (-45)) / (6)))
    tauh = (1.79) + (515.8) * 1 / (1 + exp((v - (-147.4)) / (28.66)))
}
