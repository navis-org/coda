/**
 * The two colours an axon and a dendrite are drawn in, wherever Coda draws them apart.
 *
 * navis's convention — a warm axon, a cool dendrite — because anybody who has looked at a split
 * neuron before reads it without a legend. Fixed rather than ranked: ranked colours would put the
 * *commonest* compartment in slot 0, so the axon would change colour between two neurons. One
 * function for Topology's computed split and the Cortex gallery's published labels alike, so the
 * two never disagree about which colour means axon.
 */

import type { Mode } from './colors'
import { cycleColor } from './colors'

export function axonDendriteInk(mode: Mode): { axon: string; dendrite: string } {
  return { dendrite: cycleColor(0, mode), axon: cycleColor(1, mode) }
}
