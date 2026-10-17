/**
 * Biophysics: single-neuron compartment models built from reconstructions — the Compartment
 * Model, and Simulate to run one.
 *
 * Off by default, being a tool for one kind of question; `/biophys` switches it on. It requires no
 * other pack: its inputs are the built-in skeleton and point kinds, whichever backend made them.
 * The solver is `src/biophys`, which knows nothing about neurons; see `docs/biophys.md`.
 */

import type { PackDefinition } from '../../core/registry'
import { combineTracesNode } from './combineTraces'
import { fitModelNode } from './fitModel'
import { loadRecordingNode } from './loadRecording'
import { modelNode } from './model'
import { simulateNode } from './simulate'

export const biophys: PackDefinition = {
  id: 'biophys',
  label: 'Biophysics',
  description:
    'Compartment models of single neurons from their reconstructions, driven by their synaptic partners.',
  defaultOn: false,
  glyph: 'biophys:model',
  nodes: [modelNode, simulateNode, loadRecordingNode, combineTracesNode, fitModelNode],
}
