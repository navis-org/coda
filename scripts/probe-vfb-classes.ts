/**
 * Measure `typeClass` against hemibrain's own cell typing, through the real bridge.
 *
 * The question `docs/vfb-plan.md` Phase 0 asks: for what fraction of hemibrain neurons does the
 * rule ("the most specific class, at or above the asserted ones, that some dataset names") land on
 * the class FBbt itself names after the neuron's hemibrain type? Hemibrain is the check because
 * its types are fine and VFB records them twice independently: as the individual's symbol (the
 * neuPrint *instance*, `LAL140_R`) and as `name_in_hemibrain` synonyms on classes. Agreement
 * between those two is what the rule has to reproduce.
 *
 * Read-only: every statement goes through `pdb.ts`, which refuses a write. Printed with
 * `console.error`, the convention `probe-zapbench.ts` and `probe-influence.ts` follow.
 *
 *   pnpm probe:vfb-classes            # all 22,705 hemibrain v1.2.1 individuals
 *   pnpm probe:vfb-classes 2000       # the first 2,000, for a quick look
 */

import { performance } from 'node:perf_hooks'

import { fetchClassGraph, fetchIndividuals } from '../src/data/vfb/bridge'
import { ancestorsOf, typeClass } from '../src/data/vfb/classes'
import type { TypeAnswer } from '../src/data/vfb/classes'
import { text, texts } from '../src/data/vfb/common'
import { cypher } from '../src/data/vfb/pdb'
import { vfbSiteFor } from '../src/data/vfb/sites'

const limit = Number(process.argv[2] ?? Infinity)
const { site, nameKey } = vfbSiteFor('neuprint', 'hemibrain:v1.2.1')!

const seconds = (t0: number) => ((performance.now() - t0) / 1000).toFixed(1)

let t0 = performance.now()
const all = await cypher(
  `MATCH (n:Individual)-[r:database_cross_reference]->(:Site {short_form: $site})
   RETURN r.accession AS accession, n.symbol AS symbol`,
  { site },
)
const instances = new Map<string, string>()
for (const row of all) {
  const accession = texts(row.accession)[0]
  const symbol = text(row.symbol)
  if (accession && symbol && instances.size < limit) instances.set(accession, symbol)
}
console.error(`${instances.size} hemibrain individuals with a symbol (${seconds(t0)} s)`)

t0 = performance.now()
const individuals = await fetchIndividuals(site, [...instances.keys()])
console.error(`fetchIndividuals: ${individuals.length} (${seconds(t0)} s)`)

t0 = performance.now()
const graph = await fetchClassGraph(individuals.flatMap((i) => i.classes))
console.error(
  `fetchClassGraph: ${graph.labels.size} classes, ${graph.names.size} named (${seconds(t0)} s)`,
)

/**
 * The hemibrain type an instance is of: the longest hemibrain name FBbt holds that the instance
 * equals or starts with, followed by `(`, `_` or a space. An instance is the type plus aliases and
 * suffixes (`LC13(LWF1)`, `PFNm_a(PB02a)_R3_C8`), and "longest" is what stops `PFNm` claiming a
 * `PFNm_a` neuron. Only names among the classes reached can be found, which the outcomes say.
 * The candidates are the whole instance and every prefix ending at a delimiter, tried longest first.
 */
function typeOf(instance: string, known: ReadonlyMap<string, unknown>): string | undefined {
  if (known.has(instance)) return instance
  for (let at = instance.length - 1; at > 0; at--) {
    if ('(_ '.includes(instance[at]!) && known.has(instance.slice(0, at))) {
      return instance.slice(0, at)
    }
  }
  return undefined
}

// Which classes FBbt names after each hemibrain type, among the classes reached.
const byHemibrainName = new Map<string, string[]>()
for (const [id, byKey] of graph.names) {
  for (const name of byKey.get(nameKey) ?? []) {
    const list = byHemibrainName.get(name) ?? byHemibrainName.set(name, []).get(name)!
    list.push(id)
  }
}

type Outcome =
  | 'exact'
  | 'coarser than the type'
  | 'finer than the type'
  | 'unrelated class'
  | 'named, not in hemibrain'
  | 'no named class'
  | 'tied'
  | 'instance matches no hemibrain name'

function outcomeOf(type: string | undefined, answer: TypeAnswer): Outcome {
  if (answer.tied.length > 0) return 'tied'
  if (answer.classId === undefined) return 'no named class'
  const names = graph.names.get(answer.classId)?.get(nameKey)
  if (type && names?.includes(type)) return 'exact'
  if (!names) return 'named, not in hemibrain'
  if (!type) return 'instance matches no hemibrain name'
  const target = byHemibrainName.get(type)!
  const chosen = answer.classId
  if (target.some((t) => ancestorsOf(graph, chosen).has(t))) return 'finer than the type'
  if (target.some((t) => ancestorsOf(graph, t).has(chosen))) return 'coarser than the type'
  return 'unrelated class'
}

const bump = <K>(counts: Map<K, number>, key: K) => counts.set(key, (counts.get(key) ?? 0) + 1)
const histogram = (counts: Map<number, number>) =>
  [...counts]
    .sort((a, b) => a[0] - b[0])
    .map(([c, n]) => `${c}: ${n}`)
    .join(', ')

const tally = new Map<Outcome, number>()
const examples = new Map<Outcome, string[]>()
const climbs = new Map<number, number>()
const climbedOther = new Map<number, number>()

for (const individual of individuals) {
  const instance = instances.get(individual.accession)!
  const type = typeOf(instance, byHemibrainName)
  const answer = typeClass(graph, individual.classes)
  const outcome = outcomeOf(type, answer)
  bump(tally, outcome)
  if (answer.classId) bump(outcome === 'exact' ? climbs : climbedOther, answer.climbed)
  const list = examples.get(outcome) ?? examples.set(outcome, []).get(outcome)!
  if (list.length < 8) {
    const chosen = answer.classId
      ? `${answer.classId} ${graph.labels.get(answer.classId)}`
      : answer.tied.map((id) => graph.labels.get(id)).join(' | ')
    list.push(`${instance} (${type ?? '?'}) → +${answer.climbed} ${chosen}`)
  }
}

const total = individuals.length
console.error('\noutcome                        neurons    share')
for (const [outcome, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.error(
    `${outcome.padEnd(30)} ${String(n).padStart(7)}  ${((100 * n) / total).toFixed(1)}%`,
  )
}
console.error('\nexact, by steps climbed:', histogram(climbs))
console.error('not exact, by steps climbed:', histogram(climbedOther))
const escaped = [...instances.values()].filter((s) => s.includes('\\')).length
console.error(`symbols carrying a backslash: ${escaped}`)
for (const [outcome, list] of examples) {
  if (outcome === 'exact') continue
  console.error(`\n${outcome}:`)
  for (const line of list) console.error(`  ${line}`)
}
