/**
 * The plan on the wire: the schema a provider is given, and the parser that reads a reply.
 *
 * Split from `planShape.ts`, which holds the types and the two three-line predicates. Not
 * tidiness — a measurement: the store imports `applyPlan`, so anything `apply.ts` touches is in
 * the main chunk, and this file's `planJsonSchema` and `parsePlan` are ~1.4 kB gzipped that only
 * the lazily-loaded `converse.ts` ever calls. Keeping the shape and the wire apart is what lets
 * the wire half stay in the chunk nobody pays for until they ask a question.
 */

import type { AssistantPlan, PlannedNode, PlannedParam, PortRef } from './planShape'
import { emptyPlan } from './planShape'
import type { ParamValue } from '../core/node'

/**
 * JSON Schema for `output_config.format`, so the reply is a plan rather than a plan wrapped
 * in prose about the plan.
 *
 * Every field is `required` and every object carries `additionalProperties: false`. The
 * structured-output compiler wants the second; the first is a choice — it costs the model
 * `"remove": []` on a plan that deletes nothing, and buys an applier that never has to tell
 * "the model omitted this" apart from "the model meant none". `parsePlan` is lenient anyway,
 * because a schema is a constraint on one model's output and not on what a saved plan or a
 * hand-written test fixture may contain.
 */
export function planJsonSchema(): object {
  const portRef = {
    type: 'object',
    additionalProperties: false,
    required: ['node', 'port'],
    properties: {
      node: { type: 'string', description: 'A ref from `add`, or an existing node id.' },
      port: { type: 'string', description: 'Port id as given in the catalogue.' },
    },
  }

  // `ParamValue` is `number | string | boolean | string[]`; `anyOf` is supported, and the
  // numeric/length constraints that are not are exactly what this does not need.
  const paramValue = {
    anyOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: { type: 'string' } },
    ],
  }

  /*
   * A list of pairs, not a map keyed by param id — which is the shape this obviously wants and
   * the one structured outputs cannot express. `additionalProperties` may only ever be `false`,
   * so an open-ended object is not a schema the compiler will take, and the failure is a 400 on
   * a request the user already paid for. `parsePlan` normalises it back to a map.
   */
  const paramList = {
    type: 'array',
    description: 'Params to set. Omit any that should keep its default.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['param', 'value'],
      properties: { param: { type: 'string' }, value: paramValue },
    },
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'add', 'remove', 'setParams', 'connect', 'disconnect'],
    properties: {
      summary: {
        type: 'string',
        description: "One sentence describing the edit, in the user's terms.",
      },
      add: {
        type: 'array',
        description: 'Nodes to create.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'type', 'params', 'title'],
          properties: {
            ref: {
              type: 'string',
              description: 'Short handle, unique within this plan, used by `connect`.',
            },
            type: { type: 'string', description: 'A node type from the catalogue.' },
            params: paramList,
            title: { type: 'string', description: 'Header override, or "" for the default.' },
          },
        },
      },
      remove: {
        type: 'array',
        description: 'Existing node ids to delete.',
        items: { type: 'string' },
      },
      setParams: {
        type: 'array',
        description: 'Param changes on existing nodes, or on nodes added by this plan.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['node', 'param', 'value'],
          properties: {
            node: { type: 'string' },
            param: { type: 'string' },
            value: paramValue,
          },
        },
      },
      connect: {
        type: 'array',
        description: 'Wires to make, source output to target input.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: { from: portRef, to: portRef },
        },
      },
      disconnect: {
        type: 'array',
        description: 'Wires to cut, named by the input end.',
        items: portRef,
      },
    },
  }
}

/**
 * Read a plan out of a model's reply.
 *
 * Lenient in the same way `deserializeGraph` is: a missing array reads as empty rather than
 * as a failure, because the alternative is refusing a plan that is perfectly clear about what
 * it wants. What is *not* tolerated is a shape that would silently do nothing — a `connect`
 * entry with no `to`, say — since the applier would skip it and the user would be told the
 * edit succeeded.
 */
/** The plan's own top-level fields — the shape a reply has to be in to mean anything. */
const PLAN_KEYS = Object.keys(emptyPlan())
/** The fields that actually ask for an edit. `summary` alone is a decline, which is valid. */
const ACTION_KEYS = PLAN_KEYS.filter((key) => key !== 'summary')

/**
 * Dig a JSON object out of a reply that has something else wrapped around it.
 *
 * Only reached once a plain parse has failed. Structured output is *requested* of every provider
 * here, but honouring it ranges from a compiled grammar to a strong suggestion — a model may put
 * the object in a ```json fence, or reason aloud before it. Both are recoverable and neither is
 * worth failing a turn over.
 *
 * Reasoning blocks come off first, because a model thinking about the plan writes braces while
 * doing it, and the *first* `{` in the reply would then be the wrong one. Scanning respects
 * strings and escapes, or a `}` inside a summary ends the object early.
 */
function salvageJson(text: string): unknown {
  const body = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
  const start = body.indexOf('{')
  if (start < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * Flatten `{steps: [{add: …}, {connect: …}]}` into the plan's own per-kind arrays.
 *
 * A weak model very often gets the *actions* exactly right and puts them in an envelope of its
 * own invention — one list in execution order, each entry a single-key object naming the verb.
 * Everything inside is already the right shape, so the plan is recoverable rather than lost.
 *
 * Two spellings, because both turned up: the verb as the entry's **sole key**
 * (`{add: {type, ref}}`) and the verb as a **tagged field** (`{action: 'add', type, ref}`, or
 * `op`, or anything else). The second was three of four samples.
 *
 * Neither the envelope key nor the tag field is ever named here, and that is the whole of what
 * separates this from a guess: what is recognised is `add`/`connect`/… appearing *as a verb*,
 * which is this module's own vocabulary. So `steps`, `ops`, `plan`, `actions` and `action:`,
 * `op:`, `kind:` all work without appearing in the code. Sampling a model that accepts the
 * schema and ignores it gave a different envelope on **every single run**, which is exactly why
 * naming them would be chasing one sample.
 *
 * It cannot touch a well-formed plan: it returns immediately when any action key is already
 * present at the top level, so the only inputs it sees are ones that are otherwise refused
 * outright. And a recovery it gets wrong is still validated port-by-port by `applyPlan`, which
 * refuses the whole thing — so the downside is a confusing refusal, never a wrong graph.
 */
function unwrapActions(source: Record<string, unknown>): Record<string, unknown> {
  if (ACTION_KEYS.some((key) => key in source)) return source

  const collected: Record<string, unknown[]> = {}
  for (const value of Object.values(source)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const fields = entry as Record<string, unknown>
      const keys = Object.keys(fields)

      // `{add: {…}}` — the verb is the sole key, and its value is the whole payload.
      if (keys.length === 1 && ACTION_KEYS.includes(keys[0]!)) {
        ;(collected[keys[0]!] ??= []).push(fields[keys[0]!])
        continue
      }

      /*
       * `{action: 'add', …}` — the verb is a value, and everything else is the payload. Safe
       * against `add`'s own `type` field, which names a node type: those all carry a dot
       * (`dataset.hemibrain`) and none is a bare verb.
       */
      const tag = keys.find(
        (key) => typeof fields[key] === 'string' && ACTION_KEYS.includes(fields[key] as string),
      )
      if (!tag) continue
      const { [tag]: verb, ...payload } = fields
      ;(collected[verb as string] ??= []).push(payload)
    }
  }
  return Object.keys(collected).length > 0 ? { ...source, ...collected } : source
}

export function parsePlan(
  text: string,
): { ok: true; plan: AssistantPlan } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = salvageJson(text)
    if (raw === undefined) {
      return {
        ok: false,
        error:
          'The reply was not JSON, and no JSON object could be found in it. The model may not ' +
          'support structured output.',
      }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'The reply was not a plan object.' }
  }

  const source = unwrapActions(raw as Record<string, unknown>)

  /*
   * A reply in somebody else's shape is a refusal, not an empty plan.
   *
   * Every field below is read by name and a missing one is simply absent, so an object with none
   * of them and a `summary` on it parsed *successfully* as a plan that does nothing — while
   * carrying a confident sentence saying what it had done. Observed against a model that accepts
   * the schema and ignores it, which answered `{summary, steps}`: the panel reported the summary
   * and changed nothing, which reads as the assistant having decided not to act.
   *
   * `summary` alone is left valid, because that is exactly how a real decline arrives.
   */
  if (!ACTION_KEYS.some((key) => key in source)) {
    const foreign = Object.keys(source).filter((key) => !PLAN_KEYS.includes(key))
    if (foreign.length > 0) {
      return {
        ok: false,
        error:
          `The reply is JSON but not a plan — it has \`${foreign.join('`, `')}\` where a plan ` +
          `has \`${ACTION_KEYS.join('`, `')}\`. The model did not follow the requested format.`,
      }
    }
  }
  const summary = typeof source.summary === 'string' ? source.summary : ''
  const plan: AssistantPlan = { ...emptyPlan(), summary }

  const problems: string[] = []
  const arrayOf = (field: string): unknown[] => {
    const value = source[field]
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      problems.push(`\`${field}\` should be a list.`)
      return []
    }
    return value
  }

  /**
   * Params, from either the wire's list of pairs or a plain map.
   *
   * Both, because they are two spellings of one thing and the module already holds both: the
   * schema has to emit a list, while a plan written by hand — in a test, or saved to be
   * replayed — is far more readable as a map.
   */
  const readParams = (
    value: unknown,
    where: string,
  ): Record<string, ParamValue> | undefined => {
    if (value === undefined || value === null) return undefined

    if (Array.isArray(value)) {
      const params: Record<string, ParamValue> = {}
      for (const [index, entry] of value.entries()) {
        const pair = entry as { param?: unknown; value?: unknown }
        if (!pair || typeof pair.param !== 'string') {
          problems.push(`${where}[${index}] needs a \`param\`.`)
          continue
        }
        if (pair.param in params) {
          problems.push(`${where}: "${pair.param}" is set twice.`)
          continue
        }
        params[pair.param] = pair.value as ParamValue
      }
      return params
    }

    if (typeof value === 'object') return value as Record<string, ParamValue>
    problems.push(`${where} should be a list of {param, value}.`)
    return undefined
  }

  for (const [index, entry] of arrayOf('add').entries()) {
    const node = entry as Partial<PlannedNode>
    if (!node || typeof node.ref !== 'string' || typeof node.type !== 'string') {
      problems.push(`add[${index}] needs a \`ref\` and a \`type\`.`)
      continue
    }
    const params = readParams(node.params, `add[${index}].params`)
    plan.add.push({
      ref: node.ref,
      type: node.type,
      ...(params ? { params } : {}),
      ...(node.title ? { title: node.title } : {}),
    })
  }

  for (const [index, entry] of arrayOf('remove').entries()) {
    /*
     * An object naming the node is accepted alongside a bare id, because the tagged envelope
     * above turns `{action: 'remove', node: 'n3'}` into `{node: 'n3'}` — every other verb's
     * payload is an object, and this is the one that is a bare string.
     */
    const id =
      typeof entry === 'string'
        ? entry
        : ((entry as { node?: unknown; id?: unknown; ref?: unknown })?.node ??
          (entry as { id?: unknown })?.id ??
          (entry as { ref?: unknown })?.ref)
    if (typeof id !== 'string') {
      problems.push(`remove[${index}] should be a node id.`)
      continue
    }
    plan.remove.push(id)
  }

  for (const [index, entry] of arrayOf('setParams').entries()) {
    const set = entry as Partial<PlannedParam>
    if (!set || typeof set.node !== 'string' || typeof set.param !== 'string') {
      problems.push(`setParams[${index}] needs a \`node\` and a \`param\`.`)
      continue
    }
    plan.setParams.push({ node: set.node, param: set.param, value: set.value as ParamValue })
  }

  /**
   * A port reference, in the canonical form and the two a model reaches for instead.
   *
   * `ref` because that is the word `add` uses for the very same node, so conflating them is the
   * natural mistake rather than an exotic one; `"node.port"` because a compact spelling is what
   * a model writes when it is composing the shape itself. Neither node ids (`n3_k91f`) nor port
   * ids carry a dot, so the split is unambiguous — and both forms are only ever reached where
   * the canonical one is absent, which is currently a hard error.
   */
  const readPort = (value: unknown, where: string): PortRef | undefined => {
    if (typeof value === 'string') {
      const dot = value.lastIndexOf('.')
      if (dot > 0 && dot < value.length - 1) {
        return { node: value.slice(0, dot), port: value.slice(dot + 1) }
      }
      problems.push(`${where} should be {node, port}, or "node.port".`)
      return undefined
    }
    const ref = value as Partial<PortRef> & { ref?: unknown }
    const node = typeof ref?.node === 'string' ? ref.node : ref?.ref
    if (!ref || typeof node !== 'string' || typeof ref.port !== 'string') {
      problems.push(`${where} needs a \`node\` and a \`port\`.`)
      return undefined
    }
    return { node, port: ref.port }
  }

  for (const [index, entry] of arrayOf('connect').entries()) {
    const wire = entry as { from?: unknown; to?: unknown }
    const from = readPort(wire?.from, `connect[${index}].from`)
    const to = readPort(wire?.to, `connect[${index}].to`)
    if (from && to) plan.connect.push({ from, to })
  }

  for (const [index, entry] of arrayOf('disconnect').entries()) {
    const port = readPort(entry, `disconnect[${index}]`)
    if (port) plan.disconnect.push(port)
  }

  if (problems.length) return { ok: false, error: problems.join(' ') }
  return { ok: true, plan }
}

