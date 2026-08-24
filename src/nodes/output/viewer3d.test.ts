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
