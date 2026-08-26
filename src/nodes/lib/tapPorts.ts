/**
 * The output types of a **tap** — a node that hands its input straight on.
 *
 * Every viewer in the pack is one: `out` is the input table unchanged, and any second port
 * carries a subset of it. So all of them want the same four lines of `inferOutputs`, and until
 * this existed all of them had their own copy — `out.table`, `out.scatter` and then the three
 * charts, five in all, each with a variant of the same comment beside it.
 *
 * The line worth not losing is the middle one. **Neurons-ness is preserved**, because that is
 * what keeps a filtered or selected subset pluggable straight back into Connectivity, the 3D
 * viewer and everything else that takes `T.neurons`. A copy that quietly returned `T.table()`
 * would degrade every column picker downstream of it with nothing failing to say so — the
 * failure invariant 2 is about — and with five copies there was no way to be sure none did.
 */

import type { CodaType } from '../../core/types'
import { T, isTabular, schemaOf } from '../../core/types'

export function tapPorts<P extends string>(
  input: CodaType | undefined,
  ports: readonly P[],
): Record<P, CodaType> {
  const make = isTabular(input) && input.kind === 'neurons' ? T.neurons : T.table
  const schema = schemaOf(input)
  return Object.fromEntries(ports.map((port) => [port, make(schema)])) as Record<P, CodaType>
}
