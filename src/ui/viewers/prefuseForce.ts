/**
 * Prefuse's force simulation, ported.
 *
 * The layout Cytoscape ships as "Prefuse Force Directed" — three forces integrated by
 * Runge-Kutta under an annealing schedule. It is here because ForceAtlas2 cannot draw a
 * **fragmented** graph and this can, which is a difference in the force law rather than in
 * the tuning:
 *
 * - FA2's repulsion falls off as 1/r and it pulls everything towards a gravity well, so two
 *   components with no edge between them have nothing holding them apart and every component
 *   ends up interleaved with every other. Measured on a real 36k-node correspondence graph
 *   (11,936 components, largest 39 nodes), FA2 scored 0.047 on `neighbourPurity` after 25
 *   iterations and *0.034* after 1,000 — it converges, and what it converges to is a pile.
 * - Prefuse repels as 1/r², has no gravity at all, and bleeds energy through a drag term. A
 *   component drifts away from its neighbours and stops. See {@link docs/viewers.md}.
 *
 * Everything here is index-based arithmetic over typed arrays with no renderer in sight, for
 * the reason `networkStyle.ts` is: sigma needs WebGL and jsdom has none.
 *
 * **Faithful to prefuse's constants**, which are not arbitrary — they are what Cytoscape's
 * output was judged against. `NBodyForce(-1, -1, 0.9)`, `SpringForce(1e-4, 50)`,
 * `DragForce(0.01)`, `RungeKuttaIntegrator`, speed limit 1, and the annealing schedule from
 * `ForceDirectedLayout.run()`. The one number from Cytoscape rather than prefuse is the node
 * mass of 3, which is `ForceDirectedLayoutContext.defaultNodeMass`.
 */

export interface PrefuseSettings {
  /** Passes of the annealing schedule. Cytoscape's default is 100. */
  iterations: number
  /** Hooke coefficient. Larger pulls linked nodes together harder. */
  springCoefficient: number
  /** Rest length of a link, in layout units. */
  springLength: number
  /** Per-node mass; divides the force, so larger is more sluggish. */
  nodeMass: number
  /** N-body constant. **Negative repels** — this is prefuse's sign convention. */
  gravConstant: number
  /** Velocity damping. This is what lets the simulation come to rest. */
  dragCoefficient: number
  /** Barnes-Hut opening angle. Larger is faster and coarser. */
  theta: number
  /** Ceiling on speed, which is what stops a close pair exploding. */
  speedLimit: number
}

export const PREFUSE_DEFAULTS: PrefuseSettings = {
  iterations: 100,
  springCoefficient: 1e-4,
  springLength: 50,
  nodeMass: 3,
  gravConstant: -1,
  dragCoefficient: 0.01,
  theta: 0.9,
  speedLimit: 1,
}

/**
 * Below this many nodes the n-body sum is direct rather than approximated.
 *
 * Not a deviation from prefuse so much as the exact answer to the sum its quadtree
 * approximates: at these sizes building the tree costs more than the pairs it saves, and a
 * component of six nodes has no far field to lump together. Above it the quadtree is what
 * keeps the whole-graph mode from being quadratic.
 */
const DIRECT_BELOW = 96

/** Guard on quadtree depth, since coincident points would otherwise subdivide forever. */
const MAX_DEPTH = 24

/**
 * Deterministic jitter, standing in for prefuse's `Math.random()`.
 *
 * Prefuse breaks a zero separation with a random nudge. Random is not available here: a layout
 * recomputed whenever the styling panel is touched must land in the same place twice, or every
 * unrelated edit reshuffles the picture. Keyed on the *edge*, so two coincident pairs still get
 * different nudges — which is the whole point of the nudge.
 */
function jitter(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return (x - Math.floor(x) - 0.5) / 50
}

/**
 * A Barnes-Hut quadtree over the current positions, rebuilt every force evaluation.
 *
 * Flat arrays rather than objects: this is rebuilt four times per iteration (Runge-Kutta
 * evaluates the forces four times) and a hundred iterations of allocating 36,000 objects is
 * the difference between a layout and a garbage-collection pause.
 *
 * A leaf holds a *chain* of points rather than prefuse's single one. Prefuse subdivides until
 * two coincident points separate, which they never do; it survives on float precision running
 * out. Chaining says the same thing without the cliff — points that cannot be separated share
 * a centre of mass, which is exactly what the approximation would have done with them anyway.
 */
interface Quadtree {
  /** Child slot `4 * node + quadrant`, or -1. */
  children: Int32Array
  comX: Float64Array
  comY: Float64Array
  mass: Float64Array
  /** Head of this leaf's point chain, or -1. */
  value: Int32Array
  /** Next point in a leaf's chain, indexed by point, or -1. */
  nextPoint: Int32Array
  hasChildren: Uint8Array
  size: number
  span: number
  rootX: number
  rootY: number
}

function buildTree(n: number, x: Float64Array, y: Float64Array, mass: number): Quadtree {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    if (x[i]! < minX) minX = x[i]!
    if (x[i]! > maxX) maxX = x[i]!
    if (y[i]! < minY) minY = y[i]!
    if (y[i]! > maxY) maxY = y[i]!
  }
  // Squarified, as prefuse does. The opening criterion compares a box *width* against a
  // distance, so an oblong box would make theta mean something different on each axis.
  const span = Math.max(maxX - minX, maxY - minY) || 1

  let cap = Math.max(16, n * 2)
  const tree: Quadtree = {
    children: new Int32Array(cap * 4).fill(-1),
    comX: new Float64Array(cap),
    comY: new Float64Array(cap),
    mass: new Float64Array(cap),
    value: new Int32Array(cap).fill(-1),
    nextPoint: new Int32Array(n).fill(-1),
    hasChildren: new Uint8Array(cap),
    size: 1,
    span,
    rootX: minX,
    rootY: minY,
  }

  /**
   * Double every parallel array at once.
   *
   * The tree's node count is not bounded by `2n` — clumped points subdivide deep — and a safe
   * up-front bound of `n * MAX_DEPTH` would be ~55 MB of `children` alone at 36,000 nodes, for
   * a tree rebuilt four times per iteration. So it grows. Writing the realloc once rather than
   * once per field is what stops a field added to `Quadtree` later from being missed by one of
   * them.
   */
  const wider = <A extends Int32Array | Float64Array | Uint8Array>(
    old: A,
    length: number,
    fill = 0,
  ): A => {
    const next = new (old.constructor as new (n: number) => A)(length)
    if (fill !== 0) next.fill(fill)
    next.set(old as never)
    return next
  }

  const grow = () => {
    if (tree.size < cap) return
    cap *= 2
    tree.children = wider(tree.children, cap * 4, -1)
    tree.value = wider(tree.value, cap, -1)
    tree.comX = wider(tree.comX, cap)
    tree.comY = wider(tree.comY, cap)
    tree.mass = wider(tree.mass, cap)
    tree.hasChildren = wider(tree.hasChildren, cap)
  }

  const insert = (
    point: number,
    node: number,
    bx: number,
    by: number,
    size: number,
    depth: number,
  ): void => {
    const half = size / 2
    if (tree.hasChildren[node] === 0) {
      const sitting = tree.value[node]!
      if (sitting === -1) {
        tree.value[node] = point
        return
      }
      // Out of depth, or the two points are indistinguishable: chain them and stop dividing.
      if (depth >= MAX_DEPTH || (x[sitting] === x[point] && y[sitting] === y[point])) {
        tree.nextPoint[point] = sitting
        tree.value[node] = point
        return
      }
      /*
       * Otherwise evict the tenant into a child and fall through to place the newcomer, which
       * may land in the same child and divide again.
       *
       * The eviction is always **exactly one level deep**, and that is what makes this pair of
       * functions terminate: `node` had no children, so all four slots are `-1`, the tenant
       * lands in a fresh empty child and returns immediately at `sitting === -1`. Only the
       * newcomer can recurse further.
       */
      tree.value[node] = -1
      tree.hasChildren[node] = 1
      insertChild(sitting, node, bx, by, half, depth)
    }
    insertChild(point, node, bx, by, half, depth)
  }

  const insertChild = (
    point: number,
    node: number,
    bx: number,
    by: number,
    half: number,
    depth: number,
  ): void => {
    const east = x[point]! >= bx + half ? 1 : 0
    const south = y[point]! >= by + half ? 1 : 0
    let child = tree.children[node * 4 + south * 2 + east]!
    if (child === -1) {
      grow()
      child = tree.size++
      tree.children[node * 4 + south * 2 + east] = child
    }
    tree.hasChildren[node] = 1
    insert(point, child, bx + east * half, by + south * half, half, depth + 1)
  }

  for (let i = 0; i < n; i++) insert(i, 0, minX, minY, span, 0)

  /*
   * Centres of mass, bottom-up — and the traversal that used to be here was unnecessary.
   * Every child is allocated by `tree.size++` *after* the parent that points at it, so a
   * child's index always exceeds its parent's and descending index order is already a valid
   * bottom-up order. That deletes an explicit stack and two `tree.size`-length allocations
   * from a function the comment above notes runs four times per iteration.
   */
  for (let node = tree.size - 1; node >= 0; node--) {
    let m = 0
    let cx = 0
    let cy = 0
    for (let q = 0; q < 4; q++) {
      const child = tree.children[node * 4 + q]!
      if (child === -1) continue
      m += tree.mass[child]!
      cx += tree.mass[child]! * tree.comX[child]!
      cy += tree.mass[child]! * tree.comY[child]!
    }
    for (let p = tree.value[node]!; p !== -1; p = tree.nextPoint[p]!) {
      m += mass
      cx += mass * x[p]!
      cy += mass * y[p]!
    }
    tree.mass[node] = m
    tree.comX[node] = m === 0 ? 0 : cx / m
    tree.comY[node] = m === 0 ? 0 : cy / m
  }
  return tree
}

/** Working state for one simulation, so the arrays are allocated once rather than per step. */
interface Sim {
  n: number
  x: Float64Array
  y: Float64Array
  vx: Float64Array
  vy: Float64Array
  fx: Float64Array
  fy: Float64Array
  /** Runge-Kutta stage values: position deltas `k` and velocity deltas `l`, stage-major. */
  kx: Float64Array
  ky: Float64Array
  lx: Float64Array
  ly: Float64Array
  px: Float64Array
  py: Float64Array
  edges: ReadonlyArray<readonly [number, number]>
  settings: PrefuseSettings
}

/**
 * The n-body term, added into `fx`/`fy`.
 *
 * Exported for one test, and it is the test this module most needs. `approximate` picks
 * between summing every pair and walking a Barnes-Hut quadtree, and the two are supposed to
 * be the same answer to within theta's tolerance. A quadtree that is subtly wrong — a
 * mis-signed quadrant, a centre of mass that forgets a leaf's chain — still returns plausible
 * numbers and still produces a layout, just a layout that is quietly not the one prefuse
 * would draw. Nothing about the picture would say so; `prefuseForce.test.ts` does.
 */
export function addRepulsion(
  n: number,
  x: Float64Array,
  y: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
  mass: number,
  gravConstant: number,
  theta: number,
  approximate: boolean,
): void {
  if (!approximate) {
    // Exact pairwise. Below `DIRECT_BELOW` this is both faster than building the tree and the
    // precise answer the tree approximates — a component of six nodes has no far field to lump.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = x[j]! - x[i]!
        const dy = y[j]! - y[i]!
        const r = Math.sqrt(dx * dx + dy * dy)
        if (r === 0) continue
        const v = (gravConstant * mass * mass) / (r * r * r)
        fx[i]! += v * dx
        fy[i]! += v * dy
        fx[j]! -= v * dx
        fy[j]! -= v * dy
      }
    }
    return
  }

  const tree = buildTree(n, x, y, mass)
  // Depth-bounded, so the walk's stack is a fixed allocation rather than a growing array.
  const stackNode = new Int32Array(MAX_DEPTH * 4 + 8)
  const stackSize = new Float64Array(MAX_DEPTH * 4 + 8)
  for (let i = 0; i < n; i++) {
    let top = 0
    stackNode[top] = 0
    stackSize[top] = tree.span
    top++
    while (top > 0) {
      top--
      const node = stackNode[top]!
      const size = stackSize[top]!
      if (tree.mass[node] === 0) continue
      const dx = tree.comX[node]! - x[i]!
      const dy = tree.comY[node]! - y[i]!
      const r = Math.sqrt(dx * dx + dy * dy)
      // r === 0 is prefuse's `same`: the box is this item, or is centred exactly on it, and
      // prefuse takes no force from it either way.
      if (r === 0) continue
      if (tree.hasChildren[node] === 0 || size / r < theta) {
        const v = (gravConstant * mass * tree.mass[node]!) / (r * r * r)
        fx[i]! += v * dx
        fy[i]! += v * dy
        continue
      }
      for (let q = 0; q < 4; q++) {
        const child = tree.children[node * 4 + q]!
        if (child === -1) continue
        stackNode[top] = child
        stackSize[top] = size / 2
        top++
      }
    }
  }
}

/**
 * One force evaluation: n-body, then drag, then the springs.
 *
 * The order is prefuse's `ForceSimulator.accumulate` — item forces first with the force array
 * zeroed, springs after. It matters only in that the springs must not be cleared by it.
 */
function accumulate(sim: Sim): void {
  const { n, x, y, vx, vy, fx, fy, settings } = sim
  const {
    gravConstant: g,
    nodeMass: mass,
    dragCoefficient: drag,
    theta,
    springCoefficient,
    springLength,
  } = settings

  fx.fill(0)
  fy.fill(0)
  addRepulsion(n, x, y, fx, fy, mass, g, theta, n >= DIRECT_BELOW)

  for (let i = 0; i < n; i++) {
    fx[i]! -= drag * vx[i]!
    fy[i]! -= drag * vy[i]!
  }

  for (let e = 0; e < sim.edges.length; e++) {
    const [a, b] = sim.edges[e]!
    let dx = x[b]! - x[a]!
    let dy = y[b]! - y[a]!
    let r = Math.sqrt(dx * dx + dy * dy)
    if (r === 0) {
      dx = jitter(e + 1)
      dy = jitter(e + 7919)
      r = Math.sqrt(dx * dx + dy * dy) || 1e-6
    }
    const coeff = (springCoefficient * (r - springLength)) / r
    fx[a]! += coeff * dx
    fy[a]! += coeff * dy
    fx[b]! -= coeff * dx
    fy[b]! -= coeff * dy
  }
}

/** Prefuse's `RungeKuttaIntegrator`, which is what makes this converge rather than oscillate. */
function integrate(sim: Sim, timestep: number): void {
  const { n, x, y, vx, vy, fx, fy, kx, ky, lx, ly, px, py } = sim
  const limit = sim.settings.speedLimit
  const coeff = timestep / sim.settings.nodeMass

  for (let i = 0; i < n; i++) {
    px[i] = x[i]!
    py[i] = y[i]!
    kx[i] = timestep * vx[i]!
    ky[i] = timestep * vy[i]!
    lx[i] = coeff * fx[i]!
    ly[i] = coeff * fy[i]!
    x[i]! += 0.5 * kx[i]!
    y[i]! += 0.5 * ky[i]!
  }

  /*
   * Stages 2 and 3 of the classic tableau. The two factors are *not* the same number and
   * collapsing them into one is the easy way to get a plausible-looking integrator that is
   * not RK4: both stages evaluate the derivative half a step along (`blend`), but stage 3
   * leaves the trial position a **whole** step along (`advance`) so that stage 4 is sampled
   * at the end of the interval.
   */
  for (let stage = 1; stage <= 2; stage++) {
    accumulate(sim)
    const prev = (stage - 1) * n
    const here = stage * n
    const blend = 0.5
    const advance = stage === 1 ? 0.5 : 1
    for (let i = 0; i < n; i++) {
      let sx = vx[i]! + blend * lx[prev + i]!
      let sy = vy[i]! + blend * ly[prev + i]!
      const speed = Math.sqrt(sx * sx + sy * sy)
      if (speed > limit) {
        sx = (limit * sx) / speed
        sy = (limit * sy) / speed
      }
      kx[here + i] = timestep * sx
      ky[here + i] = timestep * sy
      lx[here + i] = coeff * fx[i]!
      ly[here + i] = coeff * fy[i]!
      x[i] = px[i]! + advance * kx[here + i]!
      y[i] = py[i]! + advance * ky[here + i]!
    }
  }

  accumulate(sim)
  const two = 2 * n
  const three = 3 * n
  for (let i = 0; i < n; i++) {
    let sx = vx[i]! + lx[two + i]!
    let sy = vy[i]! + ly[two + i]!
    const speed = Math.sqrt(sx * sx + sy * sy)
    if (speed > limit) {
      sx = (limit * sx) / speed
      sy = (limit * sy) / speed
    }
    kx[three + i] = timestep * sx
    ky[three + i] = timestep * sy
    lx[three + i] = coeff * fx[i]!
    ly[three + i] = coeff * fy[i]!

    x[i] = px[i]! + (kx[i]! + kx[three + i]!) / 6 + (kx[n + i]! + kx[two + i]!) / 3
    y[i] = py[i]! + (ky[i]! + ky[three + i]!) / 6 + (ky[n + i]! + ky[two + i]!) / 3

    let dvx = (lx[i]! + lx[three + i]!) / 6 + (lx[n + i]! + lx[two + i]!) / 3
    let dvy = (ly[i]! + ly[three + i]!) / 6 + (ly[n + i]! + ly[two + i]!) / 3
    const dv = Math.sqrt(dvx * dvx + dvy * dvy)
    if (dv > limit) {
      dvx = (limit * dvx) / dv
      dvy = (limit * dvy) / dv
    }
    vx[i]! += dvx
    vy[i]! += dvy
  }
}

/**
 * Where the simulation starts.
 *
 * Prefuse's run-once mode drops every node on the anchor point and lets the spring force's
 * random nudge break the symmetry. That is not available here — a layout recomputed whenever
 * the styling panel is touched has to land in the same place twice, or every unrelated edit
 * reshuffles the picture — and a node with no links would never move at all. A phyllotactic
 * spiral instead: deterministic, no two nodes coincident, and no ring artefact for the
 * repulsion to have to undo.
 */
export function spiralSeed(n: number, radius: number): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const r = radius * Math.sqrt((i + 0.5) / n)
    x[i] = r * Math.cos(i * golden)
    y[i] = r * Math.sin(i * golden)
  }
  return { x, y }
}

/**
 * A simulation that can be run a few passes at a time.
 *
 * The whole reason this exists rather than one blocking loop: a single connected component is
 * *not* interruptible by the component-level yield in `prefusePositions`, and an ordinary
 * connectome is one component. Measured at 100 passes: 1,000 nodes 432ms, 2,000 992ms, 5,000
 * 2,914ms — a freeze rather than a wait, and freezing is what made ForceAtlas2 worth moving to
 * a worker in the first place. Slicing lets the caller hand the thread back mid-component.
 */
export interface PrefuseRun {
  /** Live positions, mutated in place as the run advances. */
  positions: { x: Float64Array; y: Float64Array }
  /** Run up to `passes` more. Returns true once the schedule is spent. */
  advance(passes: number): boolean
}

/**
 * Set a simulation up without running it.
 *
 * The annealing schedule is carried on the run rather than recomputed, because it is
 * *stateful*: `timestep *= (1 - i / total)` compounds, so a slice has to resume the product
 * where the last one left it. Restarting it per slice would re-heat the simulation every time
 * the thread was handed back, and the layout would never settle.
 */
export function prefuseRun(
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
  settings: PrefuseSettings = PREFUSE_DEFAULTS,
  seed?: { x: Float64Array; y: Float64Array },
): PrefuseRun {
  const start = seed ?? spiralSeed(n, Math.max(50, settings.springLength * Math.sqrt(n)))
  // A lone node has nothing to repel from and nothing to pull it, so its seed *is* its layout;
  // an empty one has nothing at all. Both before the working arrays exist, because on the graph
  // this was built for most components are tiny and thousands of them are single nodes.
  if (n <= 1) return { positions: start, advance: () => true }

  const sim: Sim = {
    n,
    x: start.x,
    y: start.y,
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    fx: new Float64Array(n),
    fy: new Float64Array(n),
    kx: new Float64Array(n * 4),
    ky: new Float64Array(n * 4),
    lx: new Float64Array(n * 4),
    ly: new Float64Array(n * 4),
    px: new Float64Array(n),
    py: new Float64Array(n),
    edges: edges.filter(([a, b]) => a !== b),
    settings,
  }

  const total = Math.max(1, Math.floor(settings.iterations))
  let done = 0
  let timestep = 1000
  return {
    positions: { x: sim.x, y: sim.y },
    advance(passes: number): boolean {
      const until = Math.min(total, done + Math.max(1, passes))
      for (; done < until; done++) {
        timestep *= 1 - done / total
        accumulate(sim)
        integrate(sim, timestep + 50)
      }
      return done >= total
    },
  }
}

/**
 * Run the simulation to completion and return the settled positions.
 *
 * The annealing schedule is prefuse's own, straight out of `ForceDirectedLayout.run()`:
 * `timestep *= (1 - i/iterations)` compounding from 1000, with a floor of 50 added to each
 * step. It decays fast — by a third of the way through, the step is essentially the floor —
 * which is what turns a hot, rearranging simulation into a cooling, settling one.
 */
export function prefuseLayout(
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
  settings: PrefuseSettings = PREFUSE_DEFAULTS,
  /**
   * Asked between passes; `true` lands on wherever it has got to.
   *
   * A clock is not arithmetic and does not belong in this module, so what crosses the seam is
   * a predicate — which is also what makes the budget testable with a counter rather than a
   * stopwatch. Stopping early leaves a partly-annealed layout, which is a worse picture but
   * still a picture; the alternative on a large connected graph is a locked tab.
   */
  stop?: () => boolean,
  /** Starting positions. Production never passes one; the tests do, to place a pair exactly. */
  seed?: { x: Float64Array; y: Float64Array },
): { x: Float64Array; y: Float64Array } {
  if (n === 0) return { x: new Float64Array(0), y: new Float64Array(0) }
  const run = prefuseRun(n, edges, settings, seed)
  for (;;) {
    if (stop?.()) break
    if (run.advance(1)) break
  }
  return run.positions
}
