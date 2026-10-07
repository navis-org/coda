/**
 * How often a skeleton route hands back a node with no radius — the number that decides whether
 * the Neuron Dendrogram's electrotonic axis is usable at all.
 *
 *   NEUPRINT_TOKEN="$NEUPRINT_APPLICATION_CREDENTIALS" \
 *   CAVE_TOKEN=$(jq -r .token ~/.cloudvolume/secrets/cave-secret.json) \
 *     pnpm probe:radii
 *
 * Electrotonic length is `Σ Δx / λ(r)` with `λ ∝ √r`, so a node at `r ≤ 0` is an infinite
 * distance and the node refuses the axis for that neuron. Whether that refusal is a rare honest
 * answer or a feature that never works is a fact about each source's published radii, which no
 * contract states — so it is measured here, per route, over a sample of real neurons.
 *
 * Reported per route: how many neurons carry *any* zero radius (what the refusal would hit),
 * the share of nodes affected, *where* the zeros sit (leaf, root, branch point or along a
 * segment — a zero only at tips would argue for a narrower rule than a zero mid-cable), and the
 * positive radii's spread so a units mistake shows up as a median of 0.03 or 30,000.
 *
 * Reads only. A route whose credential is absent is skipped and says so.
 *
 * `console.error`, for `probe-distance.ts`'s reason: the lint rule lifts `no-console` for the
 * plain-JavaScript scripts only.
 */

import { ID_COLUMN_NAME } from '../src/core/ids'
import { quantileSorted } from '../src/core/stats'
import type { SkeletonGeometry, SkeletonsValue } from '../src/core/values'
import { CaveSource } from '../src/data/cave/CaveSource'
import { setToken as setCaveToken } from '../src/data/cave/credentials'
import { materializationsFor } from '../src/data/cave/datastack'
import { DEFAULT_CAVE_SERVER } from '../src/data/cave/deployments'
import { CatmaidSource } from '../src/data/catmaid/CatmaidSource'
import { DEFAULT_CATMAID_SERVER } from '../src/data/catmaid/credentials'
import { NeuPrintSource } from '../src/data/neuprint/NeuPrintSource'
import { setToken as setNeuPrintToken } from '../src/data/neuprint/credentials'
import { SKELETON_ROUTES, type SkeletonRouteId } from '../src/data/skeletonRoutes'
import { buildArbor, resolveRoot, stampedRadius } from '../src/nodes/lib/arborOps'
import {
  NODE_BRANCH,
  NODE_LEAF,
  NODE_ROOT,
  classifyNodes,
} from '../src/nodes/lib/topologyOps'

const SAMPLE = Number(process.env.SAMPLE ?? 20)

function warn(message: string): void {
  console.error(`  warn: ${message}`)
}

interface NeuronStats {
  id: string
  nodes: number
  zero: number
  /** Where the zero-radius nodes sit, by topology. */
  at: { leaf: number; root: number; branch: number; slab: number }
  /** Positive radii, for the units sanity check. */
  positive: number[]
  /** `stampedRadius`' answer — the rule the Neuron Dendrogram ships, not a re-derivation of it. */
  stamped: { radius: number; share: number } | undefined
}

function statsOf(item: SkeletonGeometry): NeuronStats {
  const n = item.parents.length
  const kind = classifyNodes(item)
  const at = { leaf: 0, root: 0, branch: 0, slab: 0 }
  const positive: number[] = []
  let zero = 0
  for (let i = 0; i < n; i++) {
    const r = item.radii[i]!
    if (Number.isFinite(r) && r > 0) {
      positive.push(r)
      continue
    }
    zero++
    if (kind[i] === NODE_ROOT) at.root++
    else if (kind[i] === NODE_LEAF) at.leaf++
    else if (kind[i] === NODE_BRANCH) at.branch++
    else at.slab++
  }
  const stamped = stampedRadius(item, buildArbor(item, resolveRoot(item, 'source').node))
  return { id: item.id, nodes: n, zero, at, positive, stamped }
}

function fmt(x: number, digits = 1): string {
  return Number.isFinite(x) ? x.toFixed(digits) : '—'
}

function report(route: string, value: SkeletonsValue, asked: number): void {
  const stats = value.items.map(statsOf)
  const anyZero = stats.filter((s) => s.zero > 0)
  const allZero = stats.filter((s) => s.nodes > 0 && s.zero === s.nodes)
  const nodes = stats.reduce((a, s) => a + s.nodes, 0)
  const zero = stats.reduce((a, s) => a + s.zero, 0)
  const at = { leaf: 0, root: 0, branch: 0, slab: 0 }
  for (const s of stats) for (const k of Object.keys(at) as (keyof typeof at)[]) at[k] += s.at[k]
  const shares = stats.map((s) => (s.nodes ? s.zero / s.nodes : 0)).sort((a, b) => a - b)
  const positive = stats.flatMap((s) => s.positive).sort((a, b) => a - b)
  /*
   * A placeholder radius is not a measurement: a source that writes one constant on every node it
   * did not size gives electrotonic length a shape identical to geodesic, scaled. Asked through
   * `stampedRadius` itself, so this reports what the card will say.
   */
  const stamped = stats.flatMap((s) => (s.stamped ? [s.stamped] : []))
  const stampedShares = stamped.map((s) => s.share).sort((a, b) => a - b)
  const stampedRadii = [...new Set(stamped.map((s) => s.radius))].sort((a, b) => a - b)
  const distinct = new Set(positive).size

  console.error(`\n## ${route}  (units: ${value.units ?? 'unknown'})`)
  console.error(`  neurons: ${stats.length} returned of ${asked} asked; ${nodes} nodes`)
  console.error(
    `  neurons with any r<=0: ${anyZero.length}/${stats.length}` +
      `   with every r<=0: ${allZero.length}/${stats.length}`,
  )
  console.error(
    `  nodes r<=0: ${zero} (${fmt((100 * zero) / Math.max(1, nodes), 2)}%)` +
      `   per-neuron share median ${fmt(100 * quantileSorted(shares, 0.5), 2)}%` +
      ` max ${fmt(100 * (shares.at(-1) ?? NaN), 2)}%`,
  )
  console.error(
    `  where: leaf ${at.leaf}  root ${at.root}  branch ${at.branch}  slab ${at.slab}`,
  )
  console.error(
    `  positive r: p5 ${fmt(quantileSorted(positive, 0.05))}  median ${fmt(quantileSorted(positive, 0.5))}` +
      `  p95 ${fmt(quantileSorted(positive, 0.95))}   distinct values ${distinct}`,
  )
  console.error(
    `  neurons the stamped-radius note fires on: ${stamped.length}/${stats.length}` +
      (stamped.length
        ? `   share median ${fmt(100 * quantileSorted(stampedShares, 0.5))}%` +
          `  max ${fmt(100 * (stampedShares.at(-1) ?? NaN))}%  radius ${stampedRadii.join(', ')}`
        : ''),
  )
  for (const s of anyZero.slice(0, 5)) {
    console.error(`    ${s.id}: ${s.zero}/${s.nodes} zero  ${JSON.stringify(s.at)}`)
  }
}

async function attempt(route: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    console.error(`\n## ${route}\n  FAILED: ${error instanceof Error ? error.message : error}`)
  }
}

/** Spread a sample over a longer list, so it is not the first N rows of whatever order came back. */
function spread<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list]
  return Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]!)
}

// ---------------------------------------------------------------------------------------------

const NEUPRINT_TOKEN = process.env.NEUPRINT_TOKEN
if (NEUPRINT_TOKEN) {
  setNeuPrintToken(NEUPRINT_TOKEN)
  const neuprint = new NeuPrintSource()
  for (const datasetId of ['hemibrain:v1.2.1', 'manc:v1.2.1', 'male-cns:v1.0', 'optic-lobe:v1.1']) {
    await attempt(`neuPrint ${datasetId} (SWC route)`, async () => {
      const table = await neuprint.rawQuery!({
        datasetId,
        // Traced bodies across the size range: ordered by pre so the sample spans small
        // interneurons and large projection neurons rather than whichever come first.
        query:
          "MATCH (n:Neuron) WHERE n.status = 'Traced' AND n.pre > 20 " +
          'RETURN n.bodyId AS bodyId ORDER BY n.pre DESC LIMIT 2000',
      })
      const ids = spread((table.data['bodyId'] as unknown[]).map(String), SAMPLE)
      const value = await neuprint.fetchSkeletons!({
        datasetId,
        neuronIds: ids,
        skeletonSource: SKELETON_ROUTES.neuprint,
        onWarn: warn,
      })
      report(`neuPrint ${datasetId} (SWC route)`, value, ids.length)
    })
  }
} else {
  console.error('\n(neuPrint skipped: NEUPRINT_TOKEN unset)')
}

const CAVE_TOKEN = process.env.CAVE_TOKEN
if (CAVE_TOKEN) {
  setCaveToken(DEFAULT_CAVE_SERVER, CAVE_TOKEN)
  const cave = new CaveSource()
  // `undefined` is Automatic: the route `fetchSkeletons` itself prefers.
  const routes: Array<[string, SkeletonRouteId | undefined]> = [
    ['flywire_fafb_public', undefined],
    ['minnie65_public', SKELETON_ROUTES.service],
    ['minnie65_public', SKELETON_ROUTES.l2],
    ['brain_and_nerve_cord_public', SKELETON_ROUTES.l2],
  ]
  for (const [datastack, route] of routes) {
    const label = `CAVE ${datastack} (${route ?? 'automatic'})`
    await attempt(label, async () => {
      const version = (await materializationsFor(datastack, { deployment: DEFAULT_CAVE_SERVER }))[0]
      const datasetId = `${datastack}:${version}`
      const found = await cave.findNeurons({ datasetId, limit: 400 })
      // L2 skeletons are built chunk by chunk from the cache, a request per few hundred chunks;
      // a smaller sample keeps the probe to minutes.
      const ids = spread(found.data[ID_COLUMN_NAME] as string[], route === SKELETON_ROUTES.l2 ? 8 : SAMPLE)
      console.error(
        `\n(${datastack} offers: ${cave.skeletonSourcesFor!(datasetId)?.map((r) => r.id).join(', ') ?? 'not yet known'})`,
      )
      const value = await cave.fetchSkeletons!({
        datasetId,
        neuronIds: ids,
        ...(route ? { skeletonSource: route } : {}),
        onWarn: warn,
      })
      report(label, value, ids.length)
    })
  }
} else {
  console.error('\n(CAVE skipped: CAVE_TOKEN unset)')
}

await attempt('CATMAID FAFB (VFB)', async () => {
  // Anonymous: the VFB instance's published token is bundled (`publicTokens.ts`).
  const catmaid = new CatmaidSource(DEFAULT_CATMAID_SERVER, 'catmaid-probe', 'CATMAID (probe)')
  const index = await catmaid.neuronIndex!({ datasetId: '1' })
  const ids = spread(index.data[ID_COLUMN_NAME] as string[], SAMPLE)
  const value = await catmaid.fetchSkeletons({ datasetId: '1', neuronIds: ids, onWarn: warn })
  report('CATMAID FAFB (VFB)', value, ids.length)
})
