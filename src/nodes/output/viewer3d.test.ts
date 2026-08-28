/**
 * The 3D node's shape, as opposed to its drawing.
 *
 * Everything here is a decision that lives in the definition and shows up somewhere far away —
 * on a card, in a saved file, in the provenance key — so it is exactly the kind of thing a
 * later edit changes without noticing. The drawing itself is `viewer3dScene.test.ts`, and the
 * pixels are a browser's job.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams } from '../../core/node'
import type { ParamDef } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { CONSTANT_COLOR_OPTIONS } from '../lib/encodingParams'
import '../index'

const def = () => requireNodeDef('out.viewer3d')
const param = (id: string): ParamDef => {
  const found = (def().params ?? []).find((p) => p.id === id)
  if (!found) throw new Error(`no param ${id}`)
  return found
}

describe('the card stays a picture', () => {
  it('shows no parameter rows at all', () => {
    /*
     * Every param `advanced`, which is a deliberate reversal of the note on `out.network`: a
     * card with no rows loses its `☰` fold and reads as a node with nothing to set. On a viewer
     * whose whole face *is* the picture the trade goes the other way — twelve rows of pickers
     * above a scene is a settings panel with a thumbnail attached.
     */
    const onCard = (def().params ?? []).filter((p) => !p.advanced)
    expect(onCard.map((p) => p.id)).toEqual([])
  })

  it('keeps them reachable in the inspector, which is what makes that safe', () => {
    /*
     * `advanced` hides from the card, not from everywhere. What the inspector shows is the set
     * whose `visibleIf` currently passes, so this is the real claim: an empty card is a card
     * with nothing *on* it, not a node with nothing to set.
     */
    const params = defaultParams(def())
    const inPanel = (def().params ?? []).filter((p) => !p.visibleIf || p.visibleIf(params))
    expect(inPanel.length).toBeGreaterThan(10)
    for (const id of ['skeletonColorMode', 'skeletonWidth', 'background', 'meshOpacity']) {
      expect(inPanel.map((p) => p.id), id).toContain(id)
    }
  })
})

describe('the styling panel', () => {
  /*
   * The tabs are what turn fourteen params from a band of pickers across the top of the scene
   * into a panel — and, because a tabbed panel is the shape that comes with the header's
   * `Style` toggle, they are also the only way to put the controls away entirely. The panel's
   * own admission rule is checked once over every grouped node in
   * `ui/params/paramGroups.test.ts`; what belongs here is the arrangement this node chose.
   */
  it('has a tab per socket, plus one for the scene', () => {
    expect(def().paramGroups?.map((g) => g.id)).toEqual([
      'skeletons',
      'meshes',
      'points',
      'volumes',
      'scene',
    ])
  })

  it('declares no tab that changes data, because none of these do', () => {
    // `affectsData` puts a warning above the tab. A viewer that needed one would be a viewer
    // whose styling stales the graph.
    expect(def().paramGroups?.some((g) => g.affectsData)).toBe(false)
  })

  it('files each control under the socket it acts on', () => {
    const groupOf = (id: string) => param(id).group
    expect(groupOf('showSkeletons')).toBe('skeletons')
    expect(groupOf('skeletonColorMode')).toBe('skeletons')
    expect(groupOf('skeletonWidth')).toBe('skeletons')
    expect(groupOf('meshOpacity')).toBe('meshes')
    expect(groupOf('pointSize')).toBe('points')
    expect(groupOf('volumeOpacity')).toBe('volumes')
    expect(groupOf('background')).toBe('scene')
    // The legend writes these two, and they belong beside the colour they qualify rather than
    // in the trailing "Other" tab an ungrouped param falls into.
    expect(groupOf('skeletonHidden')).toBe('skeletons')
    expect(groupOf('meshColorOverrides')).toBe('meshes')
  })

  it('leaves the selection out of it, by not being presentational', () => {
    // The one param here that is *not* styling: it feeds the `Selected` port, so it belongs to
    // the graph rather than to a panel that promises to change nothing.
    expect(param('selection').presentational).toBeUndefined()
    expect(param('selection').group).toBeUndefined()
  })
})

describe('colour defaults', () => {
  it('gives every neuron its own colour, by hashing the id it already has', () => {
    /*
     * `hash` rather than `categorical`, and the two halves of this matter separately.
     *
     * The mode: a categorical encoding has eight validated slots and folds the ninth value
     * into grey, so a scene of twenty neurons drew twelve of them identically — the palette
     * answering a question about *identity* that it was built to answer about *series*.
     *
     * The column: `defaultColumn: ''` means "first compatible column", which resolves to
     * `neuronId` today and would stop the day a source publishes a different first one.
     */
    for (const prefix of ['skeleton', 'mesh']) {
      expect(param(`${prefix}ColorMode`).default, prefix).toBe('hash')
      expect(param(`${prefix}ColorBy`).default, prefix).toBe('neuronId')
    }
  })

  it('offers the mode wherever it defaults to it, or the way back is missing', () => {
    for (const prefix of ['skeleton', 'mesh', 'point', 'volume']) {
      const mode = param(`${prefix}ColorMode`)
      if (mode.kind !== 'enum' || typeof mode.options === 'function') {
        throw new Error('expected static options')
      }
      expect(mode.options.map((o) => o.value), prefix).toContain('hash')
      expect(mode.options.map((o) => o.value), prefix).toContain('categorical')
    }
  })

  it('leaves synapses categorical, where the useful columns are groups', () => {
    // Polarity, partner type, region: four values, and hashing them would spend the mode's one
    // advantage on a column that has no individuals in it.
    expect(param('pointColorMode').default).toBe('categorical')
  })

  it('leaves volumes a single quiet colour, because a shell is the room', () => {
    // Categorical over 63 neuropils is eight hues plus grey, which reads as a claim that eight
    // of them are special.
    expect(param('volumeColorMode').default).toBe('constant')
    expect(param('volumeColor').default).toBe('muted')
  })

  it('offers the two achromatic extremes for a figure', () => {
    const values = CONSTANT_COLOR_OPTIONS.map((o) => o.value)
    expect(values).toContain('black')
    expect(values).toContain('white')
  })
})

describe('opacity rides in the colour row', () => {
  it('is a facet of the colour rather than a control beside it', () => {
    for (const prefix of ['mesh', 'volume']) {
      const opacity = param(`${prefix}Opacity`)
      expect(opacity.composite?.key, prefix).toBe(`${prefix}Color`)
      expect(opacity.composite?.role, prefix).toBe('extra')
    }
  })

  it('is a slider, since it is a proportion somebody sets by eye', () => {
    const opacity = param('meshOpacity')
    if (opacity.kind !== 'number') throw new Error('expected a number')
    expect(opacity.slider).toBe(true)
    // A slider without both ends would render as a field, silently.
    expect(opacity.min).toBeDefined()
    expect(opacity.max).toBeDefined()
  })

  it('starts opaque for a mesh and nearly clear for a shell', () => {
    expect(param('meshOpacity').default).toBe(1)
    expect(param('volumeOpacity').default).toBe(0.12)
  })
})

describe('the rest of the surface', () => {
  it('offers black as its own background, distinct from the dark theme', () => {
    const background = param('background')
    if (background.kind !== 'enum' || typeof background.options === 'function') {
      throw new Error('expected static options')
    }
    expect(background.options.map((o) => o.value)).toEqual(['theme', 'dark', 'light', 'black'])
  })

  it('keeps Line width, and starts at the width that costs nothing', () => {
    // 1 is the hairline path; above it every segment becomes a camera-facing quad.
    const width = param('skeletonWidth')
    if (width.kind !== 'number') throw new Error('expected a number')
    expect(width.default).toBe(1)
    expect(width.min).toBe(1)
  })

  it('starts on one width, so a saved graph draws what it drew before', () => {
    const mode = param('skeletonWidthMode')
    if (mode.kind !== 'enum' || typeof mode.options === 'function') {
      throw new Error('expected static options')
    }
    expect(mode.default).toBe('uniform')
    expect(mode.options.map((o) => o.value)).toEqual(['uniform', 'radius', 'world'])
  })

  it('shows one width control at a time, and they are one row', () => {
    /*
     * Two stored params made exclusive by `visibleIf` — the shape a colour already uses for
     * its column picker and its swatch. They cannot share one param because they are not the
     * same number: "3 pixels everywhere" and "3 pixels at the thickest" have different
     * defaults, and a mode that silently reinterprets a stored width is how a graph reopens
     * looking different.
     */
    const shown: Record<string, string> = {
      uniform: 'skeletonWidth',
      radius: 'skeletonRadiusWidth',
      world: 'skeletonWorldWidth',
    }
    for (const [mode, visible] of Object.entries(shown)) {
      for (const id of Object.values(shown)) {
        expect(param(id).visibleIf?.({ skeletonWidthMode: mode }), `${id} under ${mode}`).toBe(
          id === visible,
        )
      }
    }

    // A graph saved before the mode existed has no key for it, and must land on `uniform`.
    expect(param('skeletonWidth').visibleIf?.({})).toBe(true)
    expect(param('skeletonRadiusWidth').visibleIf?.({})).toBe(false)
    expect(param('skeletonWorldWidth').visibleIf?.({})).toBe(false)

    for (const id of ['skeletonWidthMode', ...Object.values(shown)]) {
      expect(param(id).composite?.key, id).toBe('skeletonLineWidth')
    }
  })

  it('opens to scale at the calibre the source published, not a flattering one', () => {
    /*
     * The one width param that is a *multiplier* rather than a width, and it defaults to 1
     * because the mode's whole claim is that the picture is to scale. Anything else would put
     * a factor between the data and the figure by default — and this is the mode somebody
     * would measure a neurite off.
     */
    const width = param('skeletonWorldWidth')
    if (width.kind !== 'number') throw new Error('expected a number')
    expect(width.default).toBe(1)
    expect(width.min).toBeGreaterThan(0)
  })

  it('opens by radius wide enough to show a taper', () => {
    /*
     * The reason this is its own param rather than the uniform width reused. `Line width` is
     * the width of the *thickest* neurites here, and everything thinner is proportional down
     * to a one-pixel floor — so at the uniform default of 1 every node would clamp to the
     * floor and the mode would look like it had done nothing.
     */
    const width = param('skeletonRadiusWidth')
    if (width.kind !== 'number') throw new Error('expected a number')
    expect(width.default).toBe(4)
    expect(width.min).toBe(1)
  })

  it('keeps both width params presentational, like everything else on this node', () => {
    // Width changes the picture and not the `Selected` table, so it must not stale anything
    // downstream — the same rule the colour encodings and the show switches follow.
    for (const id of [
      'skeletonWidthMode',
      'skeletonWidth',
      'skeletonRadiusWidth',
      'skeletonWorldWidth',
    ]) {
      expect(param(id).presentational, id).toBe(true)
      expect(param(id).group, id).toBe('skeletons')
    }
  })

  it('opens the lights at the calibrated pair, and never at black', () => {
    /*
     * Floored above 0, which is the difference from the occlusion slider beside it: 0 there is
     * a well-defined "no darkening", and 0 here is a black canvas reachable by dragging a
     * handle to its end — a setting indistinguishable from a viewer that failed to load.
     */
    const light = param('lightIntensity')
    if (light.kind !== 'number') throw new Error('expected a number')
    expect(light.default).toBe(1)
    expect(light.min).toBeGreaterThan(0)
    expect(light.slider).toBe(true)
    // Presentational, like every other setting on this node: it changes how a surface is lit,
    // not what the `Selected` table says.
    expect(light.presentational).toBe(true)
    expect(light.group).toBe('scene')
  })

  it('warns about the clipping ceiling rather than refusing to reach it', () => {
    /*
     * `NoToneMapping` clips at 1.0 where a curve would roll off, so the top of this range
     * genuinely costs something — measured at 23.1% of surface pixels saturated at 2, against
     * 0% anywhere up to 1.4. A limit warns and does not refuse, so the range keeps its top and
     * the help carries the number.
     */
    const light = param('lightIntensity')
    if (light.kind !== 'number') throw new Error('expected a number')
    expect(light.max).toBe(2)
    expect(light.help).toMatch(/clip/i)
  })

  it('shades surfaces by default, which costs nothing on a scene with none', () => {
    /*
     * On by default, and what licenses that is `wantsAmbientOcclusion` rather than the pass
     * being cheap: a skeleton scene never mounts a composer at all, because `GTAOPass` hides
     * lines and points before it renders its normal buffer. Measured on an M3 Max with 21
     * meshes at 2× device scale, a scene that *does* mount one holds 60fps either way.
     */
    const ao = param('ambientOcclusion')
    if (ao.kind !== 'number') throw new Error('expected a number')
    expect(ao.default).toBe(1)
    expect(ao.presentational).toBe(true)
    expect(ao.group).toBe('scene')
  })

  it('carries the off state in the strength rather than in a second control', () => {
    /*
     * One number, not a toggle plus a slider. `GTAOPass`'s blend is `mix(vec3(1.), ao,
     * intensity)`, so 0 already means "no darkening" exactly — a checkbox beside it would be a
     * second spelling of `strength === 0`, and two controls that can disagree end up showing a
     * scene with no occlusion in it and a box insisting the effect is on.
     */
    const ao = param('ambientOcclusion')
    if (ao.kind !== 'number') throw new Error('expected a number')
    expect(ao.min).toBe(0)
    /*
     * Runs to 2, which octarine's `intensity` does not. 1 is where a *fully* occluded pixel
     * reaches black, so past it the effect widens rather than deepens — it pulls the
     * mid-occluded range down too. Safe rather than merely tolerated: the blend is multiply, so
     * an extrapolated negative clamps at the framebuffer, and three selects the linear branch
     * of the sRGB transfer with a `bvec` — a select, not a lerp — so the `pow` of a negative
     * never reaches the output as NaN.
     */
    expect(ao.max).toBe(2)
    // A proportion set by feel, which is what `NumberParam.slider` is for.
    expect(ao.slider).toBe(true)
  })

  it('does not pick on a click until somebody asks it to', () => {
    /*
     * Off by default, and the default is the point. Picking writes `selection`, which is the
     * one param on this node that is *not* presentational — a stray click while turning the
     * scene marks everything downstream stale and re-runs it. The toggle itself is
     * presentational: it decides whether a gesture can write that param, not what the param
     * means once written.
     */
    const pick = param('selectByClick')
    expect(pick.kind).toBe('boolean')
    expect(pick.default).toBe(false)
    expect(pick.presentational).toBe(true)
    expect(pick.group).toBe('scene')
  })

  it('can switch off each socket whole, which the legend cannot always do', () => {
    /*
     * A peer of the legend's per-key eye, not a duplicate. Keys exist only where an encoding
     * is categorical, and volumes ship on a *constant* colour — so before this there was no
     * control anywhere that could take a neuropil shell out of the picture.
     */
    for (const id of ['showSkeletons', 'showMeshes', 'showPoints', 'showVolumes']) {
      const show = param(id)
      expect(show.kind, id).toBe('boolean')
      expect(show.default, id).toBe(true)
      // Presentational: what is drawn changes, what `Selected` carries does not. A scene turned
      // down to see behind it must not stale everything downstream.
      expect(show.presentational, id).toBe(true)
    }
  })

  it('has a default for every param, or a fresh card is a card with holes', () => {
    const params = defaultParams(def())
    for (const p of def().params ?? []) {
      expect(params[p.id], p.id).toBeDefined()
    }
  })
})
