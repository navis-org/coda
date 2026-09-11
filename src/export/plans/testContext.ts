/**
 * A `NeutralContext` for the plan tests, built from plain data.
 *
 * A real one, not a cast: every member is present and typed, so a plan that starts reading a
 * member its test never supplied fails on the member's own default rather than on `undefined`
 * from a hand-rolled object. The column readers follow a real context's rules where a plan can
 * see the difference — an empty string is an unset picker, as `ctx.column` resolves it, and a
 * multi-column picker holds only the strings it was given.
 *
 * Params are taken as stored, not filled with the definition's defaults: a real context fills
 * them (`withDefaults`), so a case reading a default names it.
 */

import type { GraphNode } from '../../core/graph'
import type { ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import type { CodaType, TableSchema } from '../../core/types'
import '../../nodes'
import type { NeutralContext } from '../neutral'

export interface FakeContextOptions {
  /** The node type, whose definition `def` is — which is what `inputPorts` reads. */
  type: string
  params?: ParamValues
  /** The upstream variable per wired port. An unwired port reads as `unwired_<port>`. */
  wires?: Record<string, string>
  types?: Record<string, CodaType>
  schemas?: Record<string, TableSchema>
  /** A network port's attribute table, whichever part is asked for. */
  attributes?: Record<string, TableSchema>
}

export function fakeNeutralContext({
  type,
  params = {},
  wires = {},
  types = {},
  schemas = {},
  attributes = {},
}: FakeContextOptions): NeutralContext {
  const node: GraphNode = { id: 'node', type, position: { x: 0, y: 0 }, params }
  return {
    node,
    def: requireNodeDef(type),
    params,
    wired: (port) => wires[port] ?? `unwired_${port}`,
    input: (port) => wires[port],
    inputType: (port) => types[port],
    schema: (port) => schemas[port],
    attributes: (port) => attributes[port],
    column: (id) => {
      const value = params[id]
      return typeof value === 'string' && value !== '' ? value : undefined
    },
    columns: (id) => {
      const value = params[id]
      return Array.isArray(value) ? value.filter((name) => name !== '') : []
    },
  }
}
