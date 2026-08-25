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
 * 3. **Resample** *or* **downsample**, never both. One lays nodes down at a fixed spacing and
 *    the other keeps every Nth of the ones already there; running both means resampling to a
 *    spacing and then throwing three quarters of it away. They are one enum for that reason,
 *    which is a structural way of saying "mutually exclusive" rather than two switches that
 *    can both be on.
 *
 * ## Why this is worth having
 *
 * **Resample is the step most morphometrics want in front of them.** Anything that averages a
 * quantity per node is otherwise weighted by how finely each neurite happened to be traced,
 * and node density varies tenfold within one neuron. **Smooth is the step NBLAST wants**: a
 * raw traced skeleton overstates every angle, and tangent vectors are fitted to exactly those.
 * **Downsample is the step the 3D viewer wants** — it is the one control here that makes a
 * five-hundred-neuron scene draw.
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
  checkResampleSize,
  cleanRequestFrom,
  emptiedItems,
  isNoOp,
  skeletonCleanParamsFrom,
  skeletonsFromResult,
  usesDistance,
} from '../lib/cleanOps'
import { NM_PER_UM } from '../lib/nblastOps'

export const cleanSkeletonsNode = registerNode({
  type: 'neuron.cleanSkeletons',
  label: 'Clean Skeletons',
  category: 'transform',
  description: 'Heal, smooth and re-sample skeletons before measuring or comparing them.',
  guide:
    'Four repairs a traced skeleton usually wants, in the one order they compose: reconnect ' +
    'its fragments, smooth the tracing jitter out, then either re-sample it to an even node ' +
    'spacing or keep every Nth node. Re-sampling is what most morphometrics want in front of ' +
    'them, since anything averaged per node is otherwise weighted by how finely each neurite ' +
    'was traced. Distances are micrometres, and the node count changes while the neuron count ' +
    'never does.',
  /*
   * `expensive` and not close: this runs in a Python runtime that is a ten megabyte download
   * on first use. There is no cheap path — every one of the four operations is a fastcore
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
      help:
        'Reconnect the disconnected pieces a reconstruction arrived in, by the shortest set ' +
        'of bridges that joins them. Off by default because it is a claim about the data: a ' +
        'skeleton is sometimes several fragments because it genuinely is.',
    },
    {
      id: 'healMaxDist',
      kind: 'number',
      label: 'Longest bridge (µm)',
      default: 0,
      min: 0,
      step: 1,
      visibleIf: (params) => params.heal === true,
      help:
        'Refuse to build a bridge longer than this, leaving those fragments apart. 0 means no ' +
        'limit, which will always produce one tree — including where the nearest fragment is ' +
        'a hundred micrometres away and belongs to somebody else.',
    },
    {
      id: 'smooth',
      kind: 'number',
      label: 'Smooth (µm)',
      default: 0,
      min: 0,
      step: 0.5,
      help:
        'Gaussian kernel width, measured *along* the neurite rather than through space, so ' +
        'the far arm of a hairpin does not pull on the near one. Roots, branch points and ' +
        'leaves stay put. 0 leaves the coordinates exactly as traced.',
    },
    {
      id: 'method',
      kind: 'enum',
      label: 'Node spacing',
      default: 'none',
      options: [
        { value: 'none', label: 'leave the nodes alone' },
        { value: 'resample', label: 're-sample to an even spacing' },
        { value: 'downsample', label: 'keep every Nth node' },
      ],
      help:
        'Re-sampling lays fresh nodes down at a fixed distance apart, so a neuron traced ' +
        'finely in one arbor and coarsely in another comes out even throughout. Keeping every ' +
        'Nth node is the cheap version: it pays no attention to geometry, but roots, branch ' +
        'points and leaves always survive so the tree is the same tree. One or the other — ' +
        'doing both means re-sampling and then discarding most of the result.',
    },
    {
      id: 'spacing',
      kind: 'number',
      label: 'Spacing (µm)',
      default: 1,
      min: 0,
      step: 0.5,
      visibleIf: (params) => params.method === 'resample',
      help:
        'Target distance between adjacent nodes. 1 µm is the convention NBLAST uses. Note the ' +
        'node count is total cable length divided by this, so halving it doubles the ' +
        'geometry — the node says what that comes to before it allocates it.',
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
      help:
        'Keep one node in every N along each unbranched stretch, counting from its far end. ' +
        'A factor nothing can satisfy leaves just the roots, branch points and leaves, which ' +
        'is still the same neuron — only straight.',
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
    if (isNoOp(params)) issues.push('Nothing is switched on, so this passes the skeletons through')
    if (params.method === 'resample' && params.spacing > 0 && params.spacing < 0.1) {
      // Not a refusal — `checkResampleSize` handles the case that would actually fail — but a
      // spacing this fine is nearly always a µm/nm mix-up, and saying so at edit time is
      // cheaper than saying it after the wait.
      issues.push(`Spacing is ${params.spacing} µm; this control is micrometres, not nanometres`)
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
        `${empty} of ${value.items.length} neurons came back with no nodes. They are still in ` +
          'the collection, so the attribute table still lines up — they simply draw nothing.',
      )
    }
    return { out: skeletonsFromResult(value, result) }
  },
})
