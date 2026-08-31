/**
 * The per-index params a variadic port group needs, in one place.
 *
 * `core/ports.ts` makes *ports* variadic and deliberately leaves *params* alone — its own
 * header records why: a param is saved, undoable and in the provenance key, and a param list
 * that changed shape with an `int` would need all three to follow. So a node with a repeated
 * group declares its per-index params to the group's `max` and hides the surplus with
 * `visibleIf`, which keeps every stored value addressable and keeps a picker past the current
 * arity out of the key.
 *
 * That is three rules — the id suffix, the `from` port, and the `visibleIf` — restated at every
 * such node. `Match Cell Types` wrote them once for one picker; `Compare Connectivity` needs
 * them four times over a two-port group, which is the second instance and so the moment to
 * factor — the second-consumer rule `paramPairs.ts` states. (Not `limitParams.ts`, which was
 * factored from six and says so.)
 *
 * ## The arity param is passed whole, not its `max`
 *
 * `registerNode` refuses a group whose repeat param does not declare `min` and `max`, and says
 * why: *"The range lives on the param and nowhere else, so the inspector's spinner and the
 * expansion in `core/ports.ts` cannot disagree about how far a group goes."* `PortGroupDef` used
 * to carry its own copy and it was removed for that reason. Taking a bare `max: MAX_DATASETS`
 * here would put the copy back one directory over — and the drift is silent in the direction
 * that matters: ports past the param range get **no pickers at all**, at an arity that only
 * appears once somebody raises one of the two numbers.
 *
 * So the caller hands over the `int` param it is about to declare, and this reads `max` and the
 * default off it. One declaration, and the node's `params` array holds the same object.
 *
 * ## `from` and `schemaFrom` are written from one port id, here
 *
 * The builder names a *port base* — `fromPort: 'dataset'` — and this writes both `from` and
 * `schemaFrom` from the resolved id. That is the difference between documenting the rule and
 * enforcing it: hand-written, the two are independent strings, and a picker reading dataset 2's
 * schema while resolving against dataset 3 shows an **empty column list**, which reads as a
 * schema that has not arrived rather than as a bug. Nobody looks at the param declaration.
 *
 * The suffix rule itself is `core/ports.ts`' `portIdAt` rather than a second copy: these ids
 * address ports that module named, and a private convention here would address ports that do
 * not exist.
 */

import type {
  ColumnParam,
  ColumnsParam,
  NumberParam,
  ParamDef,
  ParamGroup,
  ParamValues,
} from '../../core/node'
import type { CodaType, TableSchema } from '../../core/types'
import { portIdAt } from '../../core/ports'

/**
 * `types` + 2 → `types2`. The one statement of a repeated *param* name's shape.
 *
 * Exported because `validate` and `evaluate` address these params by id — `ctx.columns(...)`
 * takes a string — and a node that rebuilt the name by concatenation at those two sites would
 * be two more copies of this rule. It delegates to `portIdAt` so a param and the port it reads
 * cannot be suffixed by two different conventions.
 */
export function repeatParamId(base: string, index: number): string {
  return portIdAt(base, index)
}

/**
 * `2` → `repeat2`. The one statement of a repeated *tab*'s id.
 *
 * Private, and reached through `slot.group` and `repeatGroups` — the two places that need it —
 * for `repeatParamId`'s reason one function up: a param naming a tab the node's `paramGroups`
 * spells differently is a control that vanishes into "Other" with nothing on screen to say why.
 */
function repeatGroupId(index: number): string {
  return `repeat${index}`
}

/**
 * A tab per index, for a node whose param band would otherwise grow with the arity.
 *
 * `compare.connectivity` is four params per dataset, so four datasets is sixteen rows on a card
 * that has to sit next to the graph. Handing these to `paramGroups` and `slot.group` to each
 * param puts each dataset behind one tab; the card draws a strip past two of them and the height
 * stops depending on the arity. Every tab is declared up to `max` and the ones past the current
 * count simply hold no visible params, which is the state `bucketParams` drops.
 *
 * `label` takes the index rather than being a template, because "Dataset 2" and "Brain 2" are
 * both reasonable and neither is this module's to choose.
 */
export function repeatGroups(
  count: NumberParam,
  label: (index: number) => string,
): ParamGroup[] {
  const max = typeof count.max === 'number' ? count.max : (count.default ?? 1)
  return Array.from({ length: max }, (_, i) => ({
    id: repeatGroupId(i + 1),
    label: label(i + 1),
  }))
}

/** One index of a repeated group, as the builder sees it. */
export interface RepeatSlot {
  /** 1-based, matching `ResolvedPort['group'].index` and the label a socket draws. */
  index: number
  /** The param id at this index: `pre` → `pre2`. */
  id: (base: string) => string
  /**
   * The tab id at this index, matching what `repeatGroups` declared.
   *
   * Rarely needed: `repeatParams` writes it onto every param it builds, the same way it writes
   * the `visibleIf` and resolves `fromPort`. Here for the param that wants a *different* tab
   * from its siblings, which is the only case a builder has to say anything.
   */
  group: string
}

/**
 * A param that reads the port at this index.
 *
 * `fromPort` replaces `from`, and `schemaOf` replaces `schemaFrom`, so that neither can name a
 * port: both are derived from the one base below.
 */
type RepeatedColumnParam = (
  | Omit<ColumnParam, 'from' | 'schemaFrom' | 'visibleIf'>
  | Omit<ColumnsParam, 'from' | 'schemaFrom' | 'visibleIf'>
) & {
  /** The port base this picker reads — `edges` resolves to `edges2` at index 2. */
  fromPort: string
  /** The schema behind that port, where it is not the port's own attribute schema. */
  schemaOf?: (type: CodaType | undefined) => TableSchema | undefined
}

/** Anything else — a name, a threshold — which needs only the id suffix and the `visibleIf`. */
type RepeatedPlainParam = Omit<ParamDef, 'visibleIf'> & { fromPort?: undefined }

export type RepeatedParam = RepeatedColumnParam | RepeatedPlainParam

export interface RepeatParamsOptions {
  /**
   * The `int` param the group repeats on — the same object the node puts in `params`, so `max`
   * and the default are read off the one declaration rather than copied.
   */
  count: NumberParam
  /** The params for one index. Anything returned gets its `visibleIf` from the arity. */
  build: (slot: RepeatSlot) => RepeatedParam[]
}

/**
 * Every index's params, flat, hidden past the current count.
 *
 * The `visibleIf` is applied here rather than left to the builder, because it is the half that
 * is invisible when wrong: a param that stays *visible* past the arity is also in the provenance
 * key, so editing a picker for a dataset that is not connected restales every downstream node —
 * a node re-running for a control nobody can see. `normalizeParams` excludes hidden params for
 * exactly this reason ([invariant 4](../../../docs/invariants.md)).
 *
 * The fallback when the count is unset is the param's own `default`, `countIn`'s `range.fresh`:
 * reading an absent count as zero would hide every picker on a node nobody has touched yet.
 */
export function repeatParams(options: RepeatParamsOptions): ParamDef[] {
  const { count, build } = options
  const max = typeof count.max === 'number' ? count.max : (count.default ?? 1)
  const fresh = count.default ?? count.min ?? 1
  return Array.from({ length: max }, (_, i) => {
    const index = i + 1
    const slot: RepeatSlot = {
      index,
      id: (base) => repeatParamId(base, index),
      group: repeatGroupId(index),
    }
    return build(slot).map((param) => {
      const visibleIf = (values: ParamValues) => Number(values[count.id] ?? fresh) >= index
      // The tab defaults to this index's, *before* the spread so an explicit `group` still wins.
      // Written here rather than by each builder for `portIdAt`'s reason one field over: a param
      // naming a tab its node spells differently does not fail, it lands in the trailing "Other"
      // with nothing on screen to explain it. Harmless on a node that declares no `paramGroups` —
      // `bucketParams` ignores a group id that was never declared.
      if (param.fromPort === undefined) {
        return { group: slot.group, ...param, visibleIf } as ParamDef
      }
      const { fromPort, schemaOf, ...rest } = param
      const portId = portIdAt(fromPort, index)
      return {
        group: slot.group,
        ...rest,
        from: portId,
        ...(schemaOf
          ? {
              schemaFrom: (inputs: Readonly<Record<string, CodaType | undefined>>) =>
                schemaOf(inputs[portId]),
            }
          : {}),
        visibleIf,
      } as ParamDef
    })
  }).flat()
}
