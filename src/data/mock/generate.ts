/**
 * Deterministic synthetic connectomes.
 *
 * The point is not biological accuracy — it's *structure*. Type-level wiring rules mean
 * a group-by on partner type produces a recognisable answer and an adjacency matrix has
 * visible block structure, so the demo graphs exercise the UI the way real data will.
 * Everything is seeded, so a given dataset id always produces byte-identical output and
 * cache keys stay stable across reloads.
 */

export interface MockNeuron {
  neuronId: number
  type: string
  instance: string
  status: string
  /** Voxel count. */
  size: number
  pre: number
  post: number
}

export interface MockConnection {
  /** Presynaptic (upstream) neuron id. */
  pre: number
  /** Postsynaptic (downstream) neuron id. */
  post: number
  weight: number
}

export interface MockRoiCount {
  neuronId: number
  roi: string
  pre: number
  post: number
}

export interface MockConnectome {
  id: string
  label: string
  description: string
  species: string
  version: string
  rois: string[]
  statuses: string[]
  neurons: MockNeuron[]
  connections: MockConnection[]
  roiCounts: MockRoiCount[]
  /** neuronId -> neuron */
  byId: Map<number, MockNeuron>
  /** neuronId -> outgoing connections */
  out: Map<number, MockConnection[]>
  /** neuronId -> incoming connections */
  in: Map<number, MockConnection[]>
}

interface TypeSpec {
  type: string
  count: number
  /** ROI innervation preference; weights are relative. */
  rois: Array<[string, number]>
  /** Mean voxel size. */
  size: number
}

interface RuleSpec {
  /** Source type, or a prefix pattern ending in `*`. */
  from: string
  to: string
  /** Mean synapse weight per connected pair. */
  weight: number
  /** Probability a given (source, target) neuron pair is connected at all. */
  prob: number
}

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

/**
 * Seeded PRNG, shared with `morphology.ts`.
 *
 * Both modules generate from the same seed and both suites assert determinism, so two copies
 * would each pass their own tests while the neuron table and the morphology drawn for one
 * seed quietly stopped agreeing.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Positive-skewed draw around `mean`; synapse counts are never negative. */
function skewed(rand: () => number, mean: number): number {
  const u = Math.max(1e-9, rand())
  const v = Math.max(1e-9, rand())
  const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return Math.max(1, Math.round(mean * (1 + 0.45 * gauss)))
}

// ---------------------------------------------------------------------------
// Dataset definitions
// ---------------------------------------------------------------------------

/**
 * The one synthetic connectome.
 *
 * **The id stays `optic-lobe-mini` while the label reads `Demo Data`,** and the split is
 * deliberate: the id is what a saved graph, a share link and every cache key carry, so renaming
 * it would break files that already exist to say something only a person reads. The label is the
 * name — there is one synthetic dataset now, and calling it after the lobe it happens to model
 * asked a beginner to know what an optic lobe is before they could press Run.
 */
const OPTIC_LOBE: {
  meta: Pick<MockConnectome, 'id' | 'label' | 'description' | 'species' | 'version' | 'rois'>
  types: TypeSpec[]
  rules: RuleSpec[]
} = {
  meta: {
    id: 'optic-lobe-mini',
    label: 'Demo Data',
    description:
      'Synthetic right optic lobe: lamina → medulla → T4/T5 → lobula plate, plus LC projection neurons into the central brain.',
    species: 'Drosophila melanogaster',
    version: 'mock-1.0',
    rois: ['ME(R)', 'LO(R)', 'LOP(R)', 'AOTU(R)', 'PVLP(R)', 'PLP(R)'],
  },
  types: [
    { type: 'L1', count: 14, rois: [['ME(R)', 1]], size: 180_000 },
    { type: 'L2', count: 14, rois: [['ME(R)', 1]], size: 175_000 },
    { type: 'L3', count: 12, rois: [['ME(R)', 1]], size: 160_000 },
    { type: 'L5', count: 10, rois: [['ME(R)', 1]], size: 150_000 },
    { type: 'Mi1', count: 20, rois: [['ME(R)', 1]], size: 240_000 },
    {
      type: 'Tm1',
      count: 16,
      rois: [
        ['ME(R)', 3],
        ['LO(R)', 2],
      ],
      size: 260_000,
    },
    {
      type: 'Tm3',
      count: 20,
      rois: [
        ['ME(R)', 3],
        ['LO(R)', 2],
      ],
      size: 265_000,
    },
    {
      type: 'Tm9',
      count: 16,
      rois: [
        ['ME(R)', 3],
        ['LO(R)', 2],
      ],
      size: 250_000,
    },
    { type: 'Dm8', count: 14, rois: [['ME(R)', 1]], size: 130_000 },
    { type: 'Dm9', count: 10, rois: [['ME(R)', 1]], size: 125_000 },
    {
      type: 'C2',
      count: 6,
      rois: [
        ['ME(R)', 2],
        ['LO(R)', 1],
      ],
      size: 120_000,
    },
    {
      type: 'C3',
      count: 6,
      rois: [
        ['ME(R)', 2],
        ['LO(R)', 1],
      ],
      size: 118_000,
    },
    { type: 'Pm2', count: 8, rois: [['ME(R)', 1]], size: 110_000 },
    {
      type: 'T4a',
      count: 18,
      rois: [
        ['ME(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 210_000,
    },
    {
      type: 'T4b',
      count: 18,
      rois: [
        ['ME(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 208_000,
    },
    {
      type: 'T4c',
      count: 18,
      rois: [
        ['ME(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 212_000,
    },
    {
      type: 'T4d',
      count: 18,
      rois: [
        ['ME(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 206_000,
    },
    {
      type: 'T5a',
      count: 18,
      rois: [
        ['LO(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 205_000,
    },
    {
      type: 'T5b',
      count: 18,
      rois: [
        ['LO(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 204_000,
    },
    {
      type: 'T5c',
      count: 18,
      rois: [
        ['LO(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 207_000,
    },
    {
      type: 'T5d',
      count: 18,
      rois: [
        ['LO(R)', 2],
        ['LOP(R)', 3],
      ],
      size: 203_000,
    },
    {
      type: 'LC4',
      count: 12,
      rois: [
        ['LO(R)', 3],
        ['PVLP(R)', 2],
      ],
      size: 420_000,
    },
    {
      type: 'LC6',
      count: 10,
      rois: [
        ['LO(R)', 3],
        ['PVLP(R)', 2],
      ],
      size: 400_000,
    },
    {
      type: 'LC9',
      count: 12,
      rois: [
        ['LO(R)', 3],
        ['AOTU(R)', 2],
      ],
      size: 410_000,
    },
    {
      type: 'LC11',
      count: 10,
      rois: [
        ['LO(R)', 3],
        ['PLP(R)', 2],
      ],
      size: 380_000,
    },
    {
      type: 'LPLC1',
      count: 8,
      rois: [
        ['LOP(R)', 3],
        ['PLP(R)', 2],
      ],
      size: 450_000,
    },
    {
      type: 'LPLC2',
      count: 12,
      rois: [
        ['LOP(R)', 3],
        ['PVLP(R)', 2],
      ],
      size: 460_000,
    },
    {
      type: 'LT1',
      count: 4,
      rois: [
        ['LO(R)', 2],
        ['PLP(R)', 2],
      ],
      size: 500_000,
    },
    { type: 'PVLP002', count: 6, rois: [['PVLP(R)', 4]], size: 620_000 },
    { type: 'PVLP008', count: 4, rois: [['PVLP(R)', 4]], size: 590_000 },
    { type: 'PLP003', count: 5, rois: [['PLP(R)', 4]], size: 610_000 },
    { type: 'AOTU008', count: 4, rois: [['AOTU(R)', 4]], size: 570_000 },
    {
      type: 'DNp02',
      count: 2,
      rois: [
        ['PVLP(R)', 2],
        ['PLP(R)', 1],
      ],
      size: 980_000,
    },
    {
      type: 'DNp11',
      count: 2,
      rois: [
        ['PVLP(R)', 2],
        ['PLP(R)', 1],
      ],
      size: 950_000,
    },
  ],
  rules: [
    { from: 'L1', to: 'Mi1', weight: 22, prob: 0.35 },
    { from: 'L1', to: 'Tm3', weight: 14, prob: 0.3 },
    { from: 'L2', to: 'Tm1', weight: 20, prob: 0.35 },
    { from: 'L2', to: 'Tm9', weight: 10, prob: 0.25 },
    { from: 'L3', to: 'Tm9', weight: 16, prob: 0.3 },
    { from: 'L3', to: 'Dm8', weight: 12, prob: 0.28 },
    { from: 'L5', to: 'Mi1', weight: 8, prob: 0.2 },
    { from: 'Dm9', to: 'Tm3', weight: 6, prob: 0.18 },
    { from: 'Mi1', to: 'T4*', weight: 18, prob: 0.3 },
    { from: 'Tm3', to: 'T4*', weight: 12, prob: 0.26 },
    { from: 'Tm9', to: 'T5*', weight: 16, prob: 0.28 },
    { from: 'Tm1', to: 'T5*', weight: 14, prob: 0.26 },
    { from: 'C2', to: 'Mi1', weight: 5, prob: 0.15 },
    { from: 'C3', to: 'Tm3', weight: 5, prob: 0.15 },
    { from: 'Pm2', to: 'Mi1', weight: 4, prob: 0.12 },
    { from: 'T4*', to: 'LPLC1', weight: 9, prob: 0.22 },
    { from: 'T4*', to: 'LPLC2', weight: 11, prob: 0.24 },
    { from: 'T5*', to: 'LPLC1', weight: 10, prob: 0.22 },
    { from: 'T5*', to: 'LPLC2', weight: 8, prob: 0.2 },
    { from: 'Tm3', to: 'LC4', weight: 7, prob: 0.2 },
    { from: 'Tm9', to: 'LC4', weight: 6, prob: 0.18 },
    { from: 'Tm1', to: 'LC6', weight: 6, prob: 0.18 },
    { from: 'Tm9', to: 'LC9', weight: 7, prob: 0.2 },
    { from: 'Dm8', to: 'LC11', weight: 5, prob: 0.16 },
    { from: 'T5*', to: 'LC11', weight: 4, prob: 0.12 },
    // LC / LPLC projections into the central brain — the interesting output side.
    { from: 'LC4', to: 'DNp02', weight: 34, prob: 0.85 },
    { from: 'LC4', to: 'DNp11', weight: 12, prob: 0.5 },
    { from: 'LC4', to: 'PVLP002', weight: 24, prob: 0.7 },
    { from: 'LC6', to: 'PVLP008', weight: 28, prob: 0.75 },
    { from: 'LC6', to: 'PLP003', weight: 15, prob: 0.55 },
    { from: 'LC6', to: 'DNp11', weight: 9, prob: 0.4 },
    { from: 'LC9', to: 'AOTU008', weight: 31, prob: 0.8 },
    { from: 'LC9', to: 'PVLP002', weight: 11, prob: 0.45 },
    { from: 'LC11', to: 'PLP003', weight: 26, prob: 0.72 },
    { from: 'LC11', to: 'PVLP008', weight: 13, prob: 0.5 },
    { from: 'LPLC2', to: 'DNp02', weight: 29, prob: 0.8 },
    { from: 'LPLC2', to: 'DNp11', weight: 22, prob: 0.7 },
    { from: 'LPLC1', to: 'DNp11', weight: 18, prob: 0.6 },
    { from: 'LPLC1', to: 'PLP003', weight: 8, prob: 0.35 },
    { from: 'LT1', to: 'PLP003', weight: 14, prob: 0.5 },
    { from: 'LC4', to: 'LT1', weight: 6, prob: 0.3 },
  ],
}

const DEFINITIONS = [OPTIC_LOBE]

const STATUSES = ['Traced', 'Anchor', 'Assign']

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function matchesType(pattern: string, type: string): boolean {
  if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

function build(def: (typeof DEFINITIONS)[number]): MockConnectome {
  const rand = mulberry32(hashSeed(def.meta.id))

  // --- neurons -------------------------------------------------------------
  const neurons: MockNeuron[] = []
  const byType = new Map<string, MockNeuron[]>()
  let idCursor = 1_000_000_000 + (hashSeed(def.meta.id) % 100_000_000)

  for (const spec of def.types) {
    const group: MockNeuron[] = []
    for (let i = 0; i < spec.count; i++) {
      idCursor += 1 + Math.floor(rand() * 900)
      // Mostly Traced; a minority in other states, as in a real release.
      const statusRoll = rand()
      const status = statusRoll < 0.88 ? 'Traced' : statusRoll < 0.96 ? 'Anchor' : 'Assign'
      const neuron: MockNeuron = {
        neuronId: idCursor,
        type: spec.type,
        instance: `${spec.type}_${String(i + 1).padStart(2, '0')}(R)`,
        status,
        size: Math.round(spec.size * (0.75 + rand() * 0.5)),
        pre: 0,
        post: 0,
      }
      neurons.push(neuron)
      group.push(neuron)
    }
    byType.set(spec.type, group)
  }

  // --- connections ---------------------------------------------------------
  const connections: MockConnection[] = []
  for (const rule of def.rules) {
    const sourceTypes = def.types.filter((t) => matchesType(rule.from, t.type))
    const targetTypes = def.types.filter((t) => matchesType(rule.to, t.type))
    for (const st of sourceTypes) {
      for (const tt of targetTypes) {
        const sources = byType.get(st.type) ?? []
        const targets = byType.get(tt.type) ?? []
        for (const a of sources) {
          for (const b of targets) {
            if (a.neuronId === b.neuronId) continue
            if (rand() >= rule.prob) continue
            connections.push({
              pre: a.neuronId,
              post: b.neuronId,
              weight: skewed(rand, rule.weight),
            })
          }
        }
      }
    }
  }

  // --- indices + synapse totals -------------------------------------------
  const byId = new Map<number, MockNeuron>(neurons.map((n) => [n.neuronId, n]))
  const out = new Map<number, MockConnection[]>()
  const inn = new Map<number, MockConnection[]>()
  const push = (map: Map<number, MockConnection[]>, key: number, c: MockConnection): void => {
    const list = map.get(key)
    if (list) list.push(c)
    else map.set(key, [c])
  }
  for (const c of connections) {
    push(out, c.pre, c)
    push(inn, c.post, c)
    const pre = byId.get(c.pre)
    const post = byId.get(c.post)
    if (pre) pre.pre += c.weight
    if (post) post.post += c.weight
  }

  // --- per-ROI counts ------------------------------------------------------
  const roiPrefs = new Map(def.types.map((t) => [t.type, t.rois]))
  const roiCounts: MockRoiCount[] = []
  for (const n of neurons) {
    const prefs = roiPrefs.get(n.type) ?? []
    const total = prefs.reduce((sum, [, w]) => sum + w, 0) || 1
    let assignedPre = 0
    let assignedPost = 0
    prefs.forEach(([roi, w], idx) => {
      const share = w / total
      const last = idx === prefs.length - 1
      // Jitter the split, but make the last ROI absorb the remainder so per-ROI
      // counts always sum exactly to the neuron's totals.
      const pre = last ? n.pre - assignedPre : Math.round(n.pre * share * (0.85 + rand() * 0.3))
      const post = last
        ? n.post - assignedPost
        : Math.round(n.post * share * (0.85 + rand() * 0.3))
      assignedPre += pre
      assignedPost += post
      roiCounts.push({
        neuronId: n.neuronId,
        roi,
        pre: Math.max(0, pre),
        post: Math.max(0, post),
      })
    })
  }

  return {
    ...def.meta,
    statuses: STATUSES,
    neurons,
    connections,
    roiCounts,
    byId,
    out,
    in: inn,
  }
}

const cache = new Map<string, MockConnectome>()

export function getConnectome(datasetId: string): MockConnectome | undefined {
  const cached = cache.get(datasetId)
  if (cached) return cached
  const def = DEFINITIONS.find((d) => d.meta.id === datasetId)
  if (!def) return undefined
  const built = build(def)
  cache.set(datasetId, built)
  return built
}

export function mockDatasetIds(): string[] {
  return DEFINITIONS.map((d) => d.meta.id)
}

export function mockDatasetMeta(datasetId: string) {
  return DEFINITIONS.find((d) => d.meta.id === datasetId)?.meta
}
