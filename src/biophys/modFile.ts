/**
 * A library channel as a NEURON `.mod` file, for the reference harness: `scripts/biophys-mod/` is
 * written from here by `pnpm biophys:mods`, and `modFile.test.ts` refuses a committed file that
 * differs. So the kinetics have one transcription, the `ChannelSpec`, and NEURON runs that — not a
 * second hand-copy of the same table that nothing compares.
 *
 * Only the `fitted` kind (a Boltzmann steady state and a fitted τ) is written: NEURON has squid HH
 * built in, and the harness builds it from its own `hh`. The reversal is left at 0 here and set per
 * segment by the harness from the spec, the other half of the same rule. A Q10 or a ΔV50 shift is
 * refused rather than half-written; no library channel has either. nocmodl refuses any non-ASCII byte, comments
 * included, so nothing here may carry one.
 */

import type { ChannelSpec, FittedTau, GateKinetics } from './channels'

type Fitted = Extract<GateKinetics, { kind: 'fitted' }>

/** A library channel's mechanism name: its id, `gunay.nat` as `gunay_nat`. */
export function modMechanism(id: string): string {
  return id.replace(/\./g, '_')
}

/** Whether a channel is one the harness runs from a generated `.mod`: every gate fitted. */
export function writesMod(spec: ChannelSpec): boolean {
  return spec.gates.length > 0 && spec.gates.every((g) => g.kinetics.kind === 'fitted')
}

/** A number as nocmodl reads it, with a sign group: `(v - (-29.13))`. */
const num = (x: number): string => `(${x})`

function boltzmann(vHalf: number, k: number): string {
  return `1 / (1 + exp((v - ${num(vHalf)}) / ${num(k)}))`
}

function tauExpression(tau: FittedTau): string {
  switch (tau.form) {
    case 'constant':
      return num(tau.tau)
    case 'sigmoid':
      return `${num(tau.base)} + ${num(tau.amplitude)} * ${boltzmann(tau.vHalf, tau.k)}`
    case 'exponential':
      return `${num(tau.base)} + exp((v - ${num(tau.vHalf)}) / ${num(tau.k)})`
  }
}

/** The `.mod` text for a fitted library channel. */
export function modFileText(spec: ChannelSpec): string {
  if (!writesMod(spec)) throw new Error(`${spec.id} is not a fitted channel.`)
  // Refused rather than half-written: the .mod carries neither a Q10 nor a ΔV50 shift.
  if (spec.q10)
    throw new Error(`${spec.id} has a Q10, which the generated .mod does not carry.`)
  if (spec.gates.some((g) => (g.shift ?? 0) !== 0)) {
    throw new Error(`${spec.id} has a shifted gate, which the generated .mod does not carry.`)
  }
  const name = modMechanism(spec.id)
  const gates = spec.gates.map((g) => ({ power: g.power, k: g.kinetics as Fitted }))
  const letters = gates.map((g) => g.k.gate)
  if (new Set(letters).size !== letters.length) {
    throw new Error(`${spec.id} names two gates alike, which one .mod STATE cannot hold.`)
  }
  const product = gates.map((g) => Array(g.power).fill(g.k.gate).join(' * ')).join(' * ')
  return [
    `: ${spec.id}, generated from src/biophys/channels.ts by pnpm biophys:mods. Do not edit:`,
    ': modFile.test.ts refuses a file that differs from what the spec writes.',
    ': A non-specific current; its reversal e is set per segment by the harness from the spec.',
    '',
    'NEURON {',
    `    SUFFIX ${name}`,
    '    NONSPECIFIC_CURRENT i',
    '    RANGE gbar, e, i',
    '}',
    '',
    'UNITS {',
    '    (mA) = (milliamp)',
    '    (mV) = (millivolt)',
    '    (S) = (siemens)',
    '}',
    '',
    'PARAMETER {',
    '    gbar = 0 (S/cm2)',
    '    e = 0 (mV)',
    '}',
    '',
    'ASSIGNED {',
    '    v (mV)',
    '    i (mA/cm2)',
    ...letters.flatMap((x) => [`    ${x}inf`, `    tau${x} (ms)`]),
    '}',
    '',
    `STATE { ${letters.join(' ')} }`,
    '',
    'BREAKPOINT {',
    '    SOLVE states METHOD cnexp',
    `    i = gbar * ${product} * (v - e)`,
    '}',
    '',
    'INITIAL {',
    '    rates(v)',
    ...letters.map((x) => `    ${x} = ${x}inf`),
    '}',
    '',
    'DERIVATIVE states {',
    '    rates(v)',
    ...letters.map((x) => `    ${x}' = (${x}inf - ${x}) / tau${x}`),
    '}',
    '',
    'PROCEDURE rates(v (mV)) {',
    ...gates.flatMap(({ k }) => [
      `    ${k.gate}inf = ${boltzmann(k.vHalf, k.k)}`,
      `    tau${k.gate} = ${tauExpression(k.tau)}`,
    ]),
    '}',
    '',
  ].join('\n')
}
