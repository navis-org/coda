/**
 * The VFB pack's "See also" groups, merged by `help/seeAlso.ts` — see the note there on why this is
 * a table of groups.
 */

const groups: readonly (readonly string[])[] = [
  // The lookup and what reads its type column, and the other way from an EM neuron to the light
  // level: NeuronBridge's image matches.
  ['vfb:neurons', 'vfb:publications', 'out.neuronbridge'],
  // A term's page, and the two tables that list what it points at: its papers, its lines.
  ['vfb:neurons', 'vfb:info', 'vfb:publications', 'vfb:lines'],
  // From a type to the lines that label it, their images, and those images as points.
  ['vfb:neurons', 'vfb:lines', 'vfb:images', 'vfb:gallery', 'vfb:expression'],
  // Two galleries of light-microscopy images for EM neurons: VFB's lines, NeuronBridge's matches.
  ['vfb:gallery', 'out.neuronbridge'],
]

export default groups
