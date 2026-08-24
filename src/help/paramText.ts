/**
 * What a parameter's value looks like when a *document* prints it.
 *
 * Extracted from `src/nodeguide/data.ts`, which had the only copy. Two surfaces now print
 * parameter values without a graph to resolve them against — the node guide page and the help
 * figures — and the awkward cases are the same in both, so a second copy would have been a
 * second place to get `resolved live` wrong.
 *
 * Headless on purpose: no React, no store, no data source. `src/nodeguide/data.ts` runs this in
 * Node at build time.
 */

import type { ParamDef } from '../core/node'

/**
 * The label a param shows for `value`, or for its own default when `value` is absent.
 *
 * An enum prints its *option's* label rather than the stored value, because that is what the
 * picker shows and a document saying `outputs` where the app says `downstream (outputs)` would
 * be describing a different control. Options can be computed rather than fixed — from the
 * resolved input types (Filter's operator list is dtype-aware), from a dataset listing that has
 * not arrived (every Version picker), or from another param (Custom CAVE's Materialization
 * follows its Datastack). None can be evaluated without a graph, so a *default* resolves to the
 * honest answer rather than to a guess. Deliberately not "depends on the input", which was true
 * of the first case and of neither of the others.
 *
 * An explicit `value` is different: whoever wrote it down knows what they meant, so it prints
 * verbatim when no option list can confirm the label.
 */
export function paramValueLabel(p: ParamDef, value?: unknown): string {
  const given = value !== undefined
  switch (p.kind) {
    case 'enum': {
      const raw = given ? String(value) : p.default
      if (typeof p.options === 'function') return given ? raw : 'resolved live'
      const hit = p.options.find((o) => o.value === raw)
      return hit?.label ?? (given ? raw : (p.options[0]?.label ?? '—'))
    }
    case 'boolean': {
      const raw = given ? value === true : p.default
      return raw ? 'on' : 'off'
    }
    case 'column': {
      const raw = given ? String(value) : p.default
      return raw || (p.optional ? 'none' : 'first compatible')
    }
    case 'columns': {
      const raw = given ? asStrings(value) : p.default
      return raw.length ? raw.join(', ') : 'all'
    }
    case 'ids': {
      const raw = given ? asStrings(value) : p.default
      return raw.length ? `${raw.length} selected` : 'none'
    }
    case 'multiEnum': {
      const raw = given ? asStrings(value) : p.default
      // Empty is what the node says it is — "the primary set", "every region" — and printing
      // `none` for it would state the opposite of what the picker does.
      return raw.length ? raw.join(', ') : (p.emptyLabel ?? 'none')
    }
    default: {
      const raw = given ? value : p.default
      return raw === '' ? '—' : String(raw)
    }
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

/** Whether the app draws this param as a dropdown or a picker, so a figure can give it a ▾. */
export function paramIsPicker(p: ParamDef): boolean {
  return (
    p.kind === 'enum' ||
    p.kind === 'multiEnum' ||
    p.kind === 'column' ||
    p.kind === 'columns'
  )
}
