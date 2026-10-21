/**
 * Which helpers a document carries, and which parts of a large one, for both languages.
 *
 * A helper can be a class (`CodaCatmaidDataset`) or a file of functions (`coda_catmaid_dataset`
 * and its siblings) that every graph on that backend pulls in whole, so a seven-node CATMAID
 * notebook was 397 lines with 19 of them the workflow's own. A helper declaring `trim` is split
 * into members here and only the members the document refers to are written out.
 *
 * **What a document needs is read off the document, never declared.** Calls to these members are
 * spread over a dozen emitters, several shared with another backend that has methods of the same
 * name (`CodaCustomDataset`), and a member an emitter forgot to declare would be an
 * `AttributeError` at run time that no golden shows. So a member is kept when its name is
 * referred to — `.name` in Python, `name` as a word in R — by the body cells, by any helper kept
 * whole, or by a member already kept, to a fixed point. The cost of that rule is a false positive
 * (`.labels` on another dataset keeps this one's too), which is a few extra lines and never a
 * missing one. **A trimmed helper's `needs` are conditional the same way**: a needed helper is
 * emitted only where the kept source mentions it, so `coda_walk` leaves with `connectivity`.
 */

import { escapeRegex } from '../data/terms'

/** How a helper's source splits into members: a Python class's methods, or R's functions. */
export type TrimRule = 'methods' | 'functions'

/** The fields this module reads off either language's `HelperSpec`. */
interface Trimmable {
  name: string
  needs?: string[]
  source: string[]
  trim?: TrimRule
}

/**
 * A helper's transitive closure over `needs`, dependency first and deterministic, so the cell
 * reads top to bottom — the one walk both languages' registries use.
 */
export function helperClosure<S extends Trimmable>(
  registry: ReadonlyMap<string, S>,
  names: Iterable<string>,
  language: string,
  needsOf: (spec: S) => readonly string[] = (spec) => spec.needs ?? [],
): S[] {
  const out: S[] = []
  const seen = new Set<string>()
  const visit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const spec = registry.get(name)
    if (!spec) throw new Error(`Unknown ${language} helper "${name}"`)
    for (const dep of needsOf(spec)) visit(dep)
    out.push(spec)
  }
  for (const name of [...names].sort()) visit(name)
  return out
}

interface Member {
  name: string
  lines: string[]
}

interface Rule {
  /** A line opening a member, its name in group 1. */
  member: RegExp
  /** Lines right above a member that belong to it: comments, and decorators in Python. */
  attached: RegExp
  /** Members always kept, as part of the head. */
  keep: (member: string, helper: string) => boolean
  /** Whether text refers to a member. */
  refers: (member: string) => RegExp
}

/** `name` as a whole word, not after a `.` — a call, or a function passed by name. */
const word = (name: string): RegExp => new RegExp(`(?<![.\\w])${escapeRegex(name)}\\b`)

const RULES: Record<TrimRule, Rule> = {
  // A dunder (`__init__`) is how the class is used at all.
  methods: {
    member: /^ {4}def (\w+)\b/,
    attached: /^ {4}[#@]/,
    keep: (member) => /^__\w+__$/.test(member),
    refers: (member) => new RegExp(`\\.${escapeRegex(member)}\\b`),
  },
  // The function named after the helper is its entry point.
  functions: {
    member: /^([.A-Za-z][.\w]*) <- function\b/,
    attached: /^#/,
    keep: (member, helper) => member === helper,
    refers: word,
  },
}

/** Trailing blank lines off, so pieces joined with one blank line stay one apart. */
function trimEnd(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end--
  return lines.slice(0, end)
}

/**
 * A trimmable helper as the head it always keeps and the members it may drop. Lines attached to
 * a member, and blank lines among them, go with the member they precede. A class with code after
 * it at column 0 is refused: that code has no member to belong to, and keeping it in the head
 * would write it into the class.
 */
export function splitMembers(spec: Trimmable & { trim: TrimRule }): {
  head: string[]
  members: Member[]
} {
  const rule = RULES[spec.trim]
  const head: string[] = []
  const members: Member[] = []
  let pending: string[] = []
  let current: Member | undefined
  let inClass = false
  for (const line of spec.source) {
    if (spec.trim === 'methods' && /^\S/.test(line) && !line.startsWith('#')) {
      if (inClass) throw new Error(`${spec.name}: code after the class cannot be trimmed`)
      inClass = /^class \w+/.test(line)
    }
    const opened = rule.member.exec(line)
    if (opened) {
      current = { name: opened[1]!, lines: [...pending, line] }
      members.push(current)
      pending = []
    } else if (rule.attached.test(line) || (pending.length > 0 && line.trim() === '')) {
      pending.push(line)
    } else {
      ;(current?.lines ?? head).push(...pending, line)
      pending = []
    }
  }
  ;(current?.lines ?? head).push(...pending)

  const kept = members.filter((m) => rule.keep(m.name, spec.name))
  // Leading blank lines off too: an R file opening on its entry function has an empty head.
  const first = head.findIndex((l) => l.trim() !== '')
  const own = first < 0 ? [] : trimEnd(head.slice(first))
  const pieces = [...(own.length > 0 ? [own] : []), ...kept.map((m) => trimEnd(m.lines))]
  return {
    head: pieces.flatMap((piece, i) => (i > 0 ? ['', ...piece] : piece)),
    members: members.filter((m) => !kept.includes(m)),
  }
}

interface Entry {
  head: string[]
  members: Member[]
  /** `rule.refers` for each member, compiled once rather than once per worklist round. */
  patterns: RegExp[]
  chosen: Set<string>
}

/**
 * Text with its whole-line comments blanked, so a comment naming a member does not keep it: the
 * entry function of R's CATMAID helper names `coda_catmaid_labels` in a comment, which wrote the
 * neuron table's builder into every CATMAID document. Only whole lines, because a `#` later in a
 * line may be inside a string.
 */
const uncommented = (text: string): string => text.replace(/^[ \t]*#.*$/gm, '')

/**
 * The helpers to write and the source of each, dependency first, trimmed to what the body
 * cells refer to.
 */
export function assembleHelpers<S extends Trimmable>(
  names: Iterable<string>,
  registry: ReadonlyMap<string, S>,
  language: string,
  cells: ReadonlyArray<{ source: string[] }>,
): Array<{ spec: S; source: string[] }> {
  const body = cells.map((c) => c.source.join('\n')).join('\n')
  const wanted = [...names]
  const keptNeeds = new Map<string, Set<string>>()
  const entries = new Map<string, Entry>()

  for (;;) {
    const specs = helperClosure(registry, wanted, language, (spec) =>
      spec.trim ? [...(keptNeeds.get(spec.name) ?? [])] : (spec.needs ?? []),
    )
    for (const spec of specs) {
      if (spec.trim && !entries.has(spec.name)) {
        const { head, members } = splitMembers({ ...spec, trim: spec.trim })
        const rule = RULES[spec.trim]
        entries.set(spec.name, {
          head,
          members,
          patterns: members.map((m) => rule.refers(m.name)),
          chosen: new Set(),
        })
      }
    }

    // A worklist: each round tests the members not yet chosen against the text the last round
    // added, starting from the body, the helpers kept whole, the heads and the members an earlier
    // pass chose — a helper reached through a kept need is new this pass, and what refers to its
    // members may be a member chosen before it was here to be tested.
    let fresh = [
      body,
      ...specs.filter((s) => !s.trim).map((s) => s.source.join('\n')),
      ...[...entries.values()].flatMap((e) => [
        e.head.join('\n'),
        ...e.members.filter((m) => e.chosen.has(m.name)).map((m) => m.lines.join('\n')),
      ]),
    ]
    while (fresh.length > 0) {
      const text = uncommented(fresh.join('\n'))
      fresh = []
      for (const entry of entries.values()) {
        entry.members.forEach((member, i) => {
          if (!entry.chosen.has(member.name) && entry.patterns[i]!.test(text)) {
            entry.chosen.add(member.name)
            fresh.push(member.lines.join('\n'))
          }
        })
      }
    }

    let added = false
    const assembled = specs.map((spec) => {
      const entry = entries.get(spec.name)
      if (!entry) return { spec, source: spec.source }
      const source = [
        ...entry.head,
        ...entry.members
          .filter((m) => entry.chosen.has(m.name))
          .flatMap((m) => ['', ...trimEnd(m.lines)]),
      ]
      const text = uncommented(source.join('\n'))
      const kept = keptNeeds.get(spec.name) ?? new Set<string>()
      const before = kept.size
      for (const need of spec.needs ?? []) if (word(need).test(text)) kept.add(need)
      keptNeeds.set(spec.name, kept)
      added ||= kept.size > before
      return { spec, source }
    })
    // A newly kept need brings helpers of its own, which can refer to members in turn.
    if (!added) return assembled
  }
}
