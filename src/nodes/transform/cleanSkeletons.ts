/**
 * Clean Skeletons: heal, smooth and re-sample a reconstruction before measuring it.
 *
 * Four operations that are almost always wanted together and are only ever wanted in one
 * order, so they are one node rather than four. The order is the part that is easy to get
 * wrong, and each step changes what the next one sees:
 *
 * 1. **Heal.** A skeleton from CATMAID or a segmentation is routinely several disconnected
 *    fragments, and `SkeletonsValue` has no way to say so — a forest and a tree are the same
 *    array of parents with a different number of `-1`s in it. Everything below walks the tree,
 *    so this goes first.
 * 2. **Smooth.** A Gaussian along the neurite, which takes the tracing jitter out without
 *    moving a branch point. Before resampling rather than after, because the kernel is a
 *    *distance* and so gives the same answer at any node density.
 * 3. **Resample** to an even node spacing.
 *
 * It used to offer **downsample** (keep every Nth node) as the other value of that last enum,
 * one field holding one of three values being the structural way of saying the two could not
 * both run. Downsampling now lives on Simplify Skeletons, beside the twig pruning and the two
 * geometry-aware methods it belongs with: removing nodes and moving them are different
 * questions, and only the first can carry a computed split through. The option is still here
 * **for a file that already chose it** — declared `retired`, so offered only while it is the
 * stored value, run exactly as before, and flagged on the card — so an old workflow keeps its
 * result rather than quietly becoming a pass-through.
 *
 * ## Why this is worth having
 *
 * **Resample is the step most morphometrics want in front of them.** Anything that averages a
 * quantity per node is otherwise weighted by how finely each neurite happened to be traced,
 * and node density varies tenfold within one neuron. **Smooth is the step NBLAST wants**: a
 * raw traced skeleton overstates every angle, and tangent vectors are fitted to exactly those.
 *
 * ## What it does not do
 *
 * **It never changes how many neurons there are.** A skeleton that cannot be resampled comes
 * back as it went in, and one that was empty stays empty — `SkeletonsValue` promises one
 * attribute row per item in the same order, so dropping one would put every label after it on
 * the wrong neuron. The node says how many came back empty rather than hiding it.
 *
 * **It does not re-root.** `heal_skeleton` picks a root when it joins fragments and this keeps
 * whichever it picked; re-rooting at a soma is a separate claim about the data that needs a
 * soma column nothing here has.
 *
 * **The radii survive but are only approximately right after a resample.** A new node's radius
 * is interpolated along the edge it landed on, which is exact for a linear taper and wrong by
 * however much the real profile is not one. navis has the same gap.
 */

import { registerNode } from '../../core/registry'
import { T, attributeSchema } from '../../core/types'
import { isSkeletonsValue } from '../../core/values'
import { runCleanSkeletons } from '../../pyodide/skeletons'
import {
  checkCleanUnits,
  micrometreMixup,
  checkResampleSize,
  cleanRequestFrom,
  emptiedItems,
  isNoOp,
  skeletonCleanParamsFrom,
  skeletonsFromResult,
  usesDistance,
} from '../lib/cleanOps'
import { NM_PER_UM } from '../../data/units'

registerNode({
  type: 'neuron.cleanSkeletons',
  label: 'Clean Skeletons',
  category: 'transform',
  description: 'Heal, smooth and re-sample skeletons before measuring or comparing them.',
  guide:
    'Heal, smooth and re-sample traced skeletons, in that order: reconnect fragments, take ' +
    'out tracing jitter, then lay the nodes out at an even spacing. Re-sample before NBLAST or ' +
    'any measurement that averages per node. Distances are in micrometres; the number of ' +
    'neurons never changes.',
  /*
   * `expensive` and not close: this runs in a Python runtime that is a ten megabyte download
   * on first use. There is no cheap path — every one of the operations is a fastcore
   * call — and `cheap` would fire the whole pipeline on each keystroke of a spacing field.
   */
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Skeletons', type: T.skeletons() }],
  outputs: [{ id: 'out', label: 'Skeletons', type: T.skeletons() }],
  params: [
    {
      id: 'heal',
      kind: 'boolean',
      label: 'Heal fragments',
      default: false,
      help: 'Join disconnected fragments with the shortest bridges. Off by default because some skeletons genuinely are several pieces.',
    },
    {
      id: 'healMethod',
      kind: 'enum',
      label: 'Bridge from',
      default: 'ALL',
      // Added after the node shipped, and the stored absence means what the card used to do.
      absentMeans: 'ALL',
      options: [
        { value: 'ALL', label: 'any node — the shortest bridge there is' },
        { value: 'LEAFS', label: 'leaves and roots only — a fragment joins end to end' },
      ],
      visibleIf: (params) => params.heal === true,
      help: 'Where a bridge may land. Any node finds the shortest join, which can attach a fragment sideways onto the middle of another. Leaves and roots only joins the loose ends to each other, which is usually what a broken neurite wants.',
    },
    {
      id: 'healMaxDist',
      kind: 'number',
      label: 'Longest bridge (µm)',
      default: 0,
      min: 0,
      step: 1,
      visibleIf: (params) => params.heal === true,
      help: 'Leave fragments further apart than this unjoined. 0 means no limit: you always get one tree, even if that joins a fragment of another neuron.',
    },
    {
      id: 'smooth',
      kind: 'number',
      label: 'Smooth (µm)',
      default: 0,
      min: 0,
      step: 0.5,
      help: 'Width of the Gaussian smoothing, measured along the neurite. Roots, branch points and leaves stay put; 0 turns smoothing off.',
    },
    {
      id: 'method',
      kind: 'enum',
      label: 'Node spacing',
      default: 'none',
      options: [
        { value: 'none', label: 'leave the nodes alone' },
        { value: 'resample', label: 're-sample to an even spacing' },
        // Offered only to a card that already holds it — see the header.
        {
          value: 'downsample',
          label: 'keep every Nth node',
          retired: 'moved to Simplify Skeletons',
        },
      ],
      help: '"re-sample to an even spacing" places new nodes a fixed distance apart. To keep fewer nodes instead, use Simplify Skeletons.',
    },
    {
      id: 'spacing',
      kind: 'number',
      label: 'Spacing (µm)',
      default: 1,
      min: 0,
      step: 0.5,
      visibleIf: (params) => params.method === 'resample',
      help: 'Distance between adjacent nodes; 1 µm is the convention for NBLAST. Halving it doubles the node count.',
    },
    {
      id: 'factor',
      kind: 'int',
      label: 'Keep every',
      default: 2,
      min: 2,
      max: 100,
      step: 1,
      visibleIf: (params) => params.method === 'downsample',
      help: 'Keep one node in every N along each unbranched stretch. Roots, branch points and leaves are always kept.',
    },
  ],

  /*
   * Kind and schema straight through: this changes where the nodes are and how many, and
   * touches no column. Same answer `neuron.xform` gives, and the reason neither has a schema
   * pair in its ops file to keep in step.
   */
  inferOutputs: (ctx) => ({ out: T.skeletons(attributeSchema(ctx.inputs.in, 'nodes')) }),

  validate: (ctx) => {
    const params = skeletonCleanParamsFrom(ctx.params)
    const issues: string[] = []
    if (isNoOp(params))
      issues.push('No cleaning step is switched on, so the skeletons pass through unchanged.')
    if (params.method === 'downsample') {
      issues.push(
        '`Keep every Nth node` has moved to Simplify Skeletons, which also keeps the soma and ' +
          'any axon/dendrite split. This card still runs it so the workflow gives the same ' +
          'result; to switch, set `Node spacing` to "leave the nodes alone" and add Simplify ' +
          'Skeletons after it.',
      )
    }
    if (params.method === 'resample' && params.spacing > 0 && params.spacing < 0.1) {
      // Not a refusal — `checkResampleSize` handles the case that would actually fail — but a
      // spacing this fine is nearly always a µm/nm mix-up, and saying so at edit time is
      // cheaper than saying it after the wait.
      issues.push(micrometreMixup('Spacing (µm)', params.spacing))
    }
    return issues
  },

  evaluate: async (ctx) => {
    const value = ctx.input('in')
    if (!isSkeletonsValue(value)) throw new Error('Clean Skeletons takes a set of skeletons.')
    if (value.items.length === 0) throw new Error('No skeletons on the input')

    const params = skeletonCleanParamsFrom(ctx.params)
    // A pass-through rather than a refusal. Unlike `neuron.xform`, a node that has been wired
    // in and not yet configured is the ordinary state here — every control defaults to off —
    // so refusing would put an error on a card the user is still filling in.
    if (isNoOp(params)) return { out: value }

    checkCleanUnits(value, usesDistance(params))
    if (params.method === 'resample') {
      checkResampleSize(ctx, value, params.spacing * NM_PER_UM)
    }

    ctx.progress(0.01, `${value.items.length} neurons`)
    const result = await runCleanSkeletons(cleanRequestFrom(value, params), {
      onProgress: ctx.progress,
      signal: ctx.signal,
    })

    /*
     * An emptied neuron is possible and is reported rather than removed. It is rare — nothing
     * here drops the last node of a skeleton that had one — but a set that arrived with an
     * empty item keeps it, and a reader looking at "12 skeletons" in the footer deserves to
     * know that two of them draw nothing.
     */
    const empty = emptiedItems(result.offsets)
    if (empty > 0) {
      ctx.warn(
        `${empty} of ${value.items.length} neurons came back with no nodes. They stay in ` +
          `the collection so the attribute table lines up, but draw nothing.`,
      )
    }
    // Said out loud, since `skeletonsFromResult` drops it: an arbour that stops shading is not.
    const computed = value.items.filter((item) => item.split || item.nodeValues).length
    if (computed > 0) {
      ctx.warn(
        `${computed} of ${value.items.length} neurons carried an axon/dendrite split or per-node ` +
          `values, which cleaning discards because it renumbers the nodes. Split after cleaning instead.`,
      )
    }
    return { out: skeletonsFromResult(value, result) }
  },
})
