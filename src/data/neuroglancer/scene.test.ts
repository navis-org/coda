/**
 * Scene editing, against the shapes the live endpoint actually returns.
 *
 * The states are not uniform and the differences are load-bearing, so the fixtures here are
 * trimmed copies of real ones rather than an idealised template: hemibrain publishes bare
 * `{ layers }`, manc publishes a full curated camera, male-CNS publishes thirty-odd layers of
 * which exactly one holds neurons. Every test below pins something that would fail silently —
 * a scene that renders, just not the one anyone asked for.
 */

import { describe, expect, it } from 'vitest'

import type { NgScene } from './scene'
import {
  buildScene,
  proxiedViewer,
  spliceSegments,
  parseSceneUrl,
  sceneIdentity,
  scenePatchUrl,
  sceneUrl,
  segmentationLayerIndex,
  splitSceneUrl,
} from './scene'

/** hemibrain:v1.2.1, trimmed. No dimensions, no position, no layout — this is the whole state. */
const HEMIBRAIN: NgScene = {
  layers: [
    {
      type: 'image',
      source: 'precomputed://gs://neuroglancer-janelia-flyem-hemibrain/emdata/clahe_yz/jpeg',
      name: 'hemibrain:v1.2.1-grayscalejpeg',
    },
    {
      type: 'segmentation',
      source: 'precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.2/segmentation',
      name: 'hemibrain:v1.2.1',
    },
    {
      type: 'annotation',
      source: 'precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.2/synapses',
      name: 'hemibrain:v1.2.1-synapses',
    },
  ],
}

/** manc:v1.2.3, trimmed to the keys that matter. Note the pre-existing `segmentColors`. */
const MANC: NgScene = {
  title: 'manc-v1.2.3-neuprint-layers',
  dimensions: { x: [8e-9, 'm'], y: [8e-9, 'm'], z: [8e-9, 'm'] },
  position: [23741.26953125, 29306.5546875, 43705.33984375],
  projectionScale: 91364.04452716278,
  showSlices: false,
  layout: '3d',
  selectedLayer: { flex: 1.49, size: 426, visible: true, layer: 'manc:v1.2.3' },
  layers: [
    { type: 'image', name: 'em', source: { url: 'precomputed://gs://flyem-vnc/jpeg' } },
    {
      type: 'segmentation',
      name: 'manc:v1.2.3',
      source: [{ url: 'precomputed://gs://manc-seg-v1p2/manc-seg-v1.2' }],
      tab: 'segments',
      segments: [],
      segmentColors: { '33946': '#808080' },
    },
    {
      type: 'segmentation',
      name: 'neuropils',
      source: { url: 'precomputed://gs://roi/roi-202208' },
    },
    { type: 'annotation', name: 'presyn', source: 'precomputed://gs://manc-seg-v1p2/synapses' },
  ],
}

describe('finding the layer that holds neurons', () => {
  it('picks the layer named after the dataset, not the first segmentation layer', () => {
    // male-CNS ships thirty segmentation layers — ROI shells, nuclei, cross-dataset mesh
    // overlays. Writing body ids into `brain-shell` displays nothing, with nothing to blame.
    const scene: NgScene = {
      layers: [
        {
          type: 'segmentation',
          name: 'brain-neuropil-shell',
          source: 'precomputed://gs://b/shells',
        },
        {
          type: 'segmentation',
          name: 'male-cns:v0.9',
          source: 'precomputed://gs://b/segmentation',
        },
        { type: 'segmentation', name: 'nuclei', source: 'precomputed://gs://b/nuclei' },
      ],
    }
    expect(segmentationLayerIndex(scene, 'male-cns:v0.9')).toBe(1)
  })

  it('matches on the dataset family, so a version bump does not orphan the layer', () => {
    // The graph carries `manc:v1.2.3`; a state built for the family still has to match.
    expect(segmentationLayerIndex(MANC, 'manc:v1.2.4')).toBe(1)
  })

  it('falls back to the first segmentation layer rather than dropping every neuron', () => {
    const scene: NgScene = {
      layers: [
        { type: 'image', name: 'em', source: 'precomputed://gs://b/em' },
        { type: 'segmentation', name: 'something-else', source: 'precomputed://gs://b/seg' },
      ],
    }
    expect(segmentationLayerIndex(scene, 'unknown:v1')).toBe(1)
  })

  it('reports -1 when there is no segmentation layer at all', () => {
    expect(segmentationLayerIndex({ layers: [{ type: 'image', name: 'em' }] }, 'x')).toBe(-1)
    expect(segmentationLayerIndex({}, 'x')).toBe(-1)
  })
})

describe('pointing a scene at segments', () => {
  const layersOf = (scene: NgScene) => scene['layers'] as Array<Record<string, unknown>>

  it('writes ids as strings into the dataset layer and leaves the others alone', () => {
    // Neuroglancer keys segments by string; numeric ids would round-trip as numbers and be
    // ignored, which looks exactly like a dataset with no meshes.
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [10001, 10002] })
    expect(layersOf(scene)[1]!['segments']).toEqual(['10001', '10002'])
    expect(layersOf(scene)[2]!['segments']).toBeUndefined()
  })

  it('clears the colours the dataset shipped instead of leaving a stray one behind', () => {
    // manc publishes `segmentColors: {33946: '#808080'}`. Merging would leave one neuron
    // grey for reasons nobody could trace back to a param.
    const scene = buildScene(MANC, {
      datasetId: 'manc:v1.2.3',
      segments: [1, 2],
      segmentColors: { '1': '#3987e5' },
    })
    expect(layersOf(scene)[1]!['segmentColors']).toEqual({ '1': '#3987e5' })

    const flat = buildScene(MANC, {
      datasetId: 'manc:v1.2.3',
      segments: [1],
      segmentDefaultColor: '#3987e5',
    })
    expect(flat['layers'] && layersOf(flat)[1]!['segmentColors']).toEqual({})
    expect(layersOf(flat)[1]!['segmentDefaultColor']).toBe('#3987e5')
  })

  it('does not mutate the published scene, which is cached and shared', () => {
    const before = JSON.stringify(MANC)
    buildScene(MANC, {
      datasetId: 'manc:v1.2.3',
      segments: [7],
      segmentColors: { '7': '#fff' },
    })
    expect(JSON.stringify(MANC)).toBe(before)
  })

  it('keeps the curated camera and every context layer by default', () => {
    // The whole reason to reuse a published scene rather than build one: position,
    // projectionScale, the EM volume, the ROI meshes and the synapse layers.
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    expect(scene['position']).toEqual(MANC['position'])
    expect(scene['projectionScale']).toBe(MANC['projectionScale'])
    expect(scene['dimensions']).toEqual(MANC['dimensions'])
    expect(layersOf(scene)).toHaveLength(4)
  })

  it('can strip back to the neuron layer alone', () => {
    // male-CNS publishes 38 kB of state before a single body id is added. Worth having
    // until you want to paste the link somewhere.
    const scene = buildScene(MANC, {
      datasetId: 'manc:v1.2.3',
      segments: [1],
      layers: 'segmentation',
    })
    expect(layersOf(scene)).toHaveLength(1)
    expect(layersOf(scene)[0]!['name']).toBe('manc:v1.2.3')
  })
})

describe('defaults a published scene gets wrong for an embed', () => {
  it('turns the axis lines off, whatever the dataset published', () => {
    // Drawn through the middle of the volume, and at a glance they read as anatomy.
    expect(buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })['showAxisLines']).toBe(
      false,
    )
    expect(
      buildScene(HEMIBRAIN, { datasetId: 'hemibrain:v1.2.1', segments: [] })['showAxisLines'],
    ).toBe(false)
  })

  it('closes the layer side panel, keeping the rest of what the panel declared', () => {
    // MANC and male-CNS both publish `visible: true`, which opens a panel over a third of a
    // card that is already smaller than the browser window those states were framed for.
    const panel = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })['selectedLayer']
    expect(panel).toEqual({ flex: 1.49, size: 426, visible: false, layer: 'manc:v1.2.3' })
  })

  it('does not invent a panel for a dataset that publishes none', () => {
    // hemibrain has no `selectedLayer`, and neuroglancer's own default is closed already.
    const scene = buildScene(HEMIBRAIN, { datasetId: 'hemibrain:v1.2.1', segments: [1] })
    expect(scene['selectedLayer']).toBeUndefined()
  })

  it('leaves both out of a patch, so they are opening defaults and not a policy', () => {
    // Re-sending them on every update would slam shut a panel the user had just opened, and
    // undo their axis lines, each time anything upstream changed.
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    const patch = parseSceneUrl(scenePatchUrl(undefined, scene))!
    expect(patch['showAxisLines']).toBeUndefined()
    expect(patch['selectedLayer']).toBeUndefined()
  })

  it('does not mutate the published scene while overriding it', () => {
    const before = JSON.stringify(MANC)
    buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    expect(JSON.stringify(MANC)).toBe(before)
  })
})

describe('the keys a bare scene has to be given', () => {
  it('supplies a 3D layout and no section planes when the dataset publishes none', () => {
    // hemibrain publishes `{ layers }` and nothing else. Neuroglancer's own defaults open it
    // in 4-panel with EM planes cutting through the neurons you came to look at.
    const scene = buildScene(HEMIBRAIN, { datasetId: 'hemibrain:v1.2.1', segments: [1] })
    expect(scene['layout']).toBe('3d')
    expect(scene['showSlices']).toBe(false)
  })

  it('lets the caller override what the dataset published', () => {
    const scene = buildScene(MANC, {
      datasetId: 'manc:v1.2.3',
      segments: [1],
      layout: '4panel',
      showSlices: true,
    })
    expect(scene['layout']).toBe('4panel')
    expect(scene['showSlices']).toBe(true)
  })

  it('strips neuPrint Explorer bookkeeping that is not viewer state', () => {
    // hemibrain:v1.1 carries `badlayers`, a note about layers the Explorer knows are broken.
    const scene = buildScene(
      { ...HEMIBRAIN, badlayers: ['x'] },
      {
        datasetId: 'hemibrain:v1.1',
        segments: [1],
      },
    )
    expect(scene['badlayers']).toBeUndefined()
  })

  it('survives a dataset with no published scene at all', () => {
    const scene = buildScene(undefined, { datasetId: 'x:v1', segments: [1] })
    expect(scene['layers']).toEqual([])
    expect(scene['layout']).toBe('3d')
  })
})

describe('updating a viewer someone is already looking through', () => {
  it('carries only what this app owns, so the camera survives the merge', () => {
    // Neuroglancer resets before restoring a plain `#!`, which threw away the framing on
    // every upstream edit. `#!+` restores *over* the live state, and keys it does not
    // mention keep their current values — so the camera must not be mentioned.
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1, 2] })
    const patch = parseSceneUrl(scenePatchUrl(undefined, scene))!
    expect(Object.keys(patch)).toEqual(['layers'])
    expect(patch['position']).toBeUndefined()
    expect(patch['projectionScale']).toBeUndefined()
  })

  it('uses the merge marker, not the replacing one', () => {
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    expect(scenePatchUrl(undefined, scene)).toContain('/#!+')
    expect(sceneUrl(undefined, scene)).not.toContain('#!+')
  })

  it('sends the whole layer list, because the merge is per key and not per layer', () => {
    // A patch naming only the segmentation layer deletes the EM volume and every ROI mesh
    // beside it — verified against the deployed viewer, and the one thing here that looks
    // like it ought to work the other way.
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    const patch = parseSceneUrl(scenePatchUrl(undefined, scene))!
    expect((patch['layers'] as unknown[]).length).toBe(4)
  })

  it('reads a patch URL back, so a round-trip does not depend on which form it took', () => {
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [7] })
    const split = splitSceneUrl(scenePatchUrl('https://ng.example.org/', scene))
    expect(split?.base).toBe('https://ng.example.org')
    expect((split?.scene['layers'] as unknown[]).length).toBe(4)
  })
})

describe('editing the selection inside a state the viewer already holds', () => {
  /** What the viewer is showing after the user has been at it: a hidden layer, one of theirs. */
  const LIVE: NgScene = {
    position: [16000, 24000, 19000],
    projectionScale: 4321,
    layout: '3d',
    layers: [
      { type: 'image', name: 'em', source: 'precomputed://gs://b/em', visible: false },
      {
        type: 'segmentation',
        name: 'manc:v1.2.3',
        source: 'precomputed://gs://b/seg',
        segments: ['1'],
        segmentColors: { '1': '#3987e5' },
      },
      { type: 'segmentation', name: 'mine', source: 'precomputed://gs://b/rois' },
    ],
  }

  it('changes the selection and nothing else', () => {
    // The answer to "why can't we just change the segments": we can, but only by starting from
    // what the viewer holds. A merge sends *our* layer list, which is why it took theirs away.
    const next = buildScene(MANC, {
      datasetId: 'manc:v1.2.3',
      segments: [7, 8],
      segmentColors: { '7': '#d95926', '8': '#199e70' },
    })
    const merged = spliceSegments(LIVE, next)!
    const layers = merged['layers'] as Array<Record<string, unknown>>

    expect(layers.map((l) => l['name'])).toEqual(['em', 'manc:v1.2.3', 'mine'])
    expect(layers[0]!['visible']).toBe(false)
    expect(layers[1]!['segments']).toEqual(['7', '8'])
    expect(layers[1]!['segmentColors']).toEqual({ '7': '#d95926', '8': '#199e70' })
    expect(merged['position']).toEqual([16000, 24000, 19000])
    expect(merged['projectionScale']).toBe(4321)
  })

  it('clears a colour field the new selection no longer sets', () => {
    // Switching to "neuroglancer's own" leaves no colour keys; a copy that only assigns would
    // leave the previous palette behind, pinned to ids that are no longer shown.
    const live: NgScene = {
      layers: [
        {
          type: 'segmentation',
          name: 'manc:v1.2.3',
          segments: ['1'],
          segmentDefaultColor: '#fff',
        },
      ],
    }
    const next = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [2] })
    const layers = spliceSegments(live, next)!['layers'] as Array<Record<string, unknown>>
    expect(layers[0]!['segmentDefaultColor']).toBeUndefined()
    expect(layers[0]!['segments']).toEqual(['2'])
  })

  it('does not mutate the state it was handed', () => {
    const before = JSON.stringify(LIVE)
    spliceSegments(LIVE, buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [9] }))
    expect(JSON.stringify(LIVE)).toBe(before)
  })

  it('declines when the user has removed the layer', () => {
    // Re-adding a layer someone deleted is a worse answer than starting the scene over.
    const live: NgScene = { layers: [{ type: 'image', name: 'em' }] }
    const next = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    expect(spliceSegments(live, next)).toBeUndefined()
  })
})

describe('serving the viewer same-origin', () => {
  it('maps the default instance onto the configured proxy path', () => {
    // Reading the embed's state is only possible same-origin, and that is the whole reason the
    // proxy exists — neuroglancer frames fine cross-origin.
    expect(proxiedViewer(undefined)).toBe('/ng')
    expect(proxiedViewer('https://neuroglancer-demo.appspot.com/')).toBe('/ng')
  })

  it('has none for an instance someone named themselves', () => {
    // No proxy rule can exist for it, so that embed falls back to merging.
    expect(proxiedViewer('https://ng.example.org')).toBeUndefined()
  })
})

describe('when a merge is not safe', () => {
  it('reads the same identity for two selections of the same dataset', () => {
    const one = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    const two = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [2, 3] })
    // Only the layers differ, and those are what a patch carries — so this is mergeable.
    expect(sceneIdentity(one)).toBe(sceneIdentity(two))
  })

  it('reads a different identity when the layout changes', () => {
    /*
     * `layout` is deliberately not patchable. Restoring it in the same pass that rebuilds
     * every layer is what neuroglancer was reported erroring on, and the failure named this
     * exact property. Changing it re-navigates instead — which costs the camera, but only on
     * a structural change nobody makes mid-flow.
     */
    const threeD = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    const panels = buildScene(MANC, {
      datasetId: 'manc:v1.2.3',
      segments: [1],
      layout: '4panel',
    })
    expect(sceneIdentity(threeD)).not.toBe(sceneIdentity(panels))
  })

  it('reads a different identity for a different dataset', () => {
    // Merging into one would keep a camera framed on the old volume, which lands you in
    // empty space beside the one you asked for.
    const manc = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1] })
    const hemibrain = buildScene(HEMIBRAIN, { datasetId: 'hemibrain:v1.2.1', segments: [1] })
    expect(sceneIdentity(manc)).not.toBe(sceneIdentity(hemibrain))
  })

  it('does not depend on key order', () => {
    const a = buildScene({ ...MANC, title: 'x' }, { datasetId: 'manc:v1.2.3', segments: [1] })
    const reordered: Record<string, unknown> = {}
    for (const key of Object.keys(MANC).reverse())
      reordered[key] = (MANC as Record<string, unknown>)[key]
    const b = buildScene(
      { ...reordered, title: 'x' },
      { datasetId: 'manc:v1.2.3', segments: [1] },
    )
    expect(sceneIdentity(a)).toBe(sceneIdentity(b))
  })
})

describe('the URL', () => {
  it('round-trips the scene through the fragment', () => {
    // The state never reaches a server: neuroglancer reads it out of the fragment, which is
    // why this needs no backend and no CORS.
    const scene = buildScene(MANC, { datasetId: 'manc:v1.2.3', segments: [1, 2] })
    const url = sceneUrl(undefined, scene)
    expect(url.startsWith('https://neuroglancer-demo.appspot.com/#!')).toBe(true)
    expect(parseSceneUrl(url)).toEqual(scene)
  })

  it('percent-encodes, because every colour in the state contains a #', () => {
    const url = sceneUrl(
      undefined,
      buildScene(MANC, {
        datasetId: 'manc:v1.2.3',
        segments: [1],
        segmentColors: { '1': '#3987e5' },
      }),
    )
    // Exactly one '#', the fragment marker. A raw '#' inside would truncate the state.
    expect(url.split('#')).toHaveLength(2)
    expect(parseSceneUrl(url)).toBeDefined()
  })

  it('normalises whatever shape the viewer base is given in', () => {
    const scene = buildScene(undefined, { datasetId: 'x', segments: [] })
    for (const base of [
      'https://ng.example.org',
      'https://ng.example.org/',
      'https://ng.example.org/#!{}',
    ]) {
      expect(sceneUrl(base, scene).startsWith('https://ng.example.org/#!')).toBe(true)
    }
    expect(sceneUrl('  ', scene).startsWith('https://neuroglancer-demo.appspot.com/#!')).toBe(
      true,
    )
  })

  it('returns nothing for a URL that carries no scene', () => {
    expect(parseSceneUrl('https://ng.example.org/')).toBeUndefined()
    expect(parseSceneUrl('https://ng.example.org/#!not-json')).toBeUndefined()
  })
})
