/**
 * The transform registry, and the manifest it is generated from.
 *
 * Two kinds of check here, and the split matters. Most of this file asserts the *shape* of
 * `manifest.json` — which nothing else can, because the module casts it once at the boundary
 * (see `spaces.ts`) and TypeScript then believes whatever the cast said. A manifest regenerated
 * against a changed `gen-transforms.py` would satisfy the compiler and fail here, which is the
 * whole point of the arrangement.
 *
 * The rest asserts the two lookups and the parser. Nothing here touches Python, Pyodide or a
 * landmark file over the network: `parseLandmarks` is given text directly, and the fetch path
 * is exercised with a stubbed `fetch`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { spaceLabel } from '../../core/values'
import {
  COMMON_SPACE,
  allSpaces,
  geometryFrame,
  spaceById,
  spaceForDataset,
  spaceName,
} from './spaces'
import {
  landmarkUrl,
  loadLandmarks,
  mirrorFor,
  parseLandmarks,
  resetLandmarks,
  toCommonFor,
} from './landmarks'

const UNITS = ['nm', 'um']

describe('the generated manifest', () => {
  it('describes the five spaces Coda has datasets in, by name', () => {
    /*
     * Named rather than counted. A count passes whatever the generator emitted, which is the
     * assertion-against-the-expression-it-is-built-from that `starterFamilies`' tests avoid —
     * and the failure this should catch is a space silently *dropping out* of the manifest
     * because its landmark file went missing, which a count would only catch by luck.
     */
    expect(allSpaces().map((s) => s.id).sort()).toEqual([
      'FAFB14',
      'FLYWIRE',
      'JRCFIB2018F',
      'JRCFIB2022M',
      'MANC',
    ])
  })

  it('names JRC2018U as the common space, in micrometres', () => {
    expect(COMMON_SPACE.id).toBe('JRC2018U')
    expect(COMMON_SPACE.units).toBe('um')
    // The VNC placement is a layout rather than a registration, and the note is where a reader
    // of a share link finds that out. See `COMMON_SPACE`.
    expect(COMMON_SPACE.note).toMatch(/layout rather than a registration/)
  })

  it('gives every space a direct mirror and a route to the common space', () => {
    for (const space of allSpaces()) {
      expect(space.mirror, `${space.id} mirror`).toBeDefined()
      expect(space.toCommon, `${space.id} toCommon`).toBeDefined()
    }
  })

  it('gives every landmark set three source and three target columns', () => {
    // The one thing the boundary cast in `spaces.ts` cannot promise: TypeScript reads a JSON
    // array as `string[]`, so a two-column entry would type-check and then index `undefined`
    // into a coordinate.
    for (const space of allSpaces()) {
      for (const [what, spec] of [
        ['mirror', space.mirror],
        ['toCommon', space.toCommon],
      ] as const) {
        if (!spec) continue
        expect(spec.sourceColumns, `${space.id} ${what} source`).toHaveLength(3)
        expect(spec.targetColumns, `${space.id} ${what} target`).toHaveLength(3)
        expect(UNITS).toContain(spec.sourceUnits)
        expect(UNITS).toContain(spec.targetUnits)
        expect(spec.landmarks).toBeGreaterThan(4) // a 3-D TPS needs four
        expect(spec.file).toMatch(/\.csv$/)
      }
    }
  })

  it('flips about a real axis, at a positive coordinate', () => {
    for (const space of allSpaces()) {
      const mirror = space.mirror!
      expect(['x', 'y', 'z']).toContain(mirror.axis)
      // Every fly template's bounding box sits in the positive octant, so `min + max` is
      // positive. A zero here is the signature of a bounding box that was never read.
      expect(mirror.flipAt, space.id).toBeGreaterThan(0)
    }
  })

  it('carries the flip constant navis derives, for the two spaces sharing a volume', () => {
    /*
     * FlyWire and FAFB14 are the same EM volume realigned, and flybrains gives them the same
     * bounding box — so an equal `flipAt` is evidence the constant came from that bounding box
     * rather than from somebody typing. The value itself is `bbox.x.min + bbox.x.max` =
     * 192200 + 853686, which is the number `navis.mirror_brain` would use.
     */
    expect(spaceById('FLYWIRE')!.mirror!.flipAt).toBe(1045886)
    expect(spaceById('FAFB14')!.mirror!.flipAt).toBe(1045886)
    // The hemibrain's box starts at zero, so its constant is simply its x extent.
    expect(spaceById('JRCFIB2018F')!.mirror!.flipAt).toBe(275456)
  })

  it('accounts for every landmark in a region', () => {
    for (const space of allSpaces()) {
      const spec = space.toCommon!
      const summed = Object.values(spec.regions).reduce((a, b) => a + b, 0)
      expect(summed, space.id).toBe(spec.landmarks)
    }
  })

  it('sends nerve cords through the placed-VNC route and brains directly', () => {
    // Which half a space contributes is a fact about the animal, and it is what decides
    // whether the common-space coordinates are a registration or a layout.
    expect(Object.keys(spaceById('MANC')!.toCommon!.regions)).toEqual(['vnc'])
    expect(Object.keys(spaceById('JRCFIB2018F')!.toCommon!.regions)).toEqual(['brain'])
    expect(Object.keys(spaceById('JRCFIB2022M')!.toCommon!.regions).sort()).toEqual([
      'brain',
      'vnc',
    ])
  })

  it('publishes the common space in micrometres and every dataset space in nanometres', () => {
    for (const space of allSpaces()) {
      expect(space.units, space.id).toBe('nm')
      expect(space.mirror!.sourceUnits).toBe('nm')
      expect(space.mirror!.targetUnits).toBe('nm')
      expect(space.toCommon!.sourceUnits).toBe('nm')
      expect(space.toCommon!.targetUnits).toBe('um')
    }
  })
})

describe('which space a dataset is in', () => {
  it('reads a neuPrint dataset by family, ignoring the version', () => {
    expect(spaceForDataset('neuprint', 'hemibrain:v1.2.1')).toBe('JRCFIB2018F')
    expect(spaceForDataset('neuprint', 'hemibrain:v1.1')).toBe('JRCFIB2018F')
    expect(spaceForDataset('neuprint', 'male-cns:v1.0')).toBe('JRCFIB2022M')
    expect(spaceForDataset('neuprint', 'manc:v1.2.3')).toBe('MANC')
  })

  it('answers the same for a non-default neuPrint deployment', () => {
    // A neuPrint dataset id is a *name* — `hemibrain` is the same volume whoever serves it —
    // so the binding is on the backend rather than on the deployment.
    expect(spaceForDataset('neuprint:https://neuprint.example.org', 'hemibrain:v1.2.1')).toBe(
      'JRCFIB2018F',
    )
  })

  it('reads a CAVE datastack by its materialization-free half', () => {
    expect(spaceForDataset('cave', 'flywire_fafb_public:783')).toBe('FLYWIRE')
  })

  it('binds CATMAID project 1 to Virtual Fly Brain and to nothing else', () => {
    /*
     * The distinction that makes this whole binding table two-shaped: a CATMAID project id is
     * *positional*, so `1` is FAFB on VFB's deployment and whatever a lab numbered first
     * anywhere else. Answering FAFB14 for a lab server would put somebody's neurons through a
     * mirror fitted for a different animal.
     */
    expect(spaceForDataset('catmaid', '1')).toBe('FAFB14')
    expect(spaceForDataset('catmaid:https://catmaid.example.org', '1')).toBeUndefined()
  })

  it('says nothing for a dataset with no registration anywhere', () => {
    // Unknown is a real answer and a third thing from wrong — the rule `capabilityOf` keeps.
    expect(spaceForDataset('neuprint', 'optic-lobe:v1.1')).toBeUndefined()
    expect(spaceForDataset('neuprint', 'fib19:v1.0')).toBeUndefined()
    expect(spaceForDataset('neuprint', 'mushroombody')).toBeUndefined()
    expect(spaceForDataset('mock', 'optic-lobe-mini')).toBeUndefined()
  })

  it('binds every space in the manifest to at least one dataset', () => {
    // A landmark set nothing can reach is 100 kB nobody will ever download and a mirror nobody
    // can run. Catches a binding removed without its manifest entry, and vice versa.
    const bound = new Set(
      [
        spaceForDataset('neuprint', 'hemibrain:v1.2.1'),
        spaceForDataset('neuprint', 'male-cns:v1.0'),
        spaceForDataset('neuprint', 'manc:v1.0'),
        spaceForDataset('cave', 'flywire_fafb_public:783'),
        spaceForDataset('catmaid', '1'),
      ].filter(Boolean),
    )
    for (const space of allSpaces()) expect([...bound]).toContain(space.id)
  })
})

describe('units and space travel together', () => {
  it('claims the space when the coordinates are nanometres', () => {
    expect(geometryFrame('neuprint', 'hemibrain:v1.2.1', 'nm')).toEqual({
      units: 'nm',
      space: 'JRCFIB2018F',
    })
  })

  it('withholds the space when the scale was never established', () => {
    /*
     * The load-bearing case. `JRCFIB2018F` is defined in nanometres; the same skeleton in raw
     * 8 nm voxels is in `JRCFIB2018Fraw`, which Coda has no landmarks for. Naming the space
     * anyway would let a mirror run on coordinates eight times too small.
     */
    expect(geometryFrame('neuprint', 'hemibrain:v1.2.1', 'voxels')).toEqual({ units: 'voxels' })
  })

  it('omits the key rather than setting it undefined', () => {
    // These values are structure-cloned into IndexedDB and compared by the scheduler, where an
    // absent key and a present-but-undefined one are not the same round trip.
    expect('space' in geometryFrame('neuprint', 'optic-lobe:v1.1', 'nm')).toBe(false)
    expect('space' in geometryFrame('neuprint', 'hemibrain:v1.2.1', 'voxels')).toBe(false)
  })
})

describe('naming a space', () => {
  it('prints the id in a footer and the prose name in a sentence', () => {
    // Two meanings, two functions. A footer reading "Hemibrain" could not tell `JRCFIB2018F`
    // from `JRCFIB2018Fraw`, which is a factor of eight.
    expect(spaceLabel('JRCFIB2018F')).toBe('JRCFIB2018F')
    expect(spaceName('JRCFIB2018F')).toBe('Hemibrain')
  })

  it('says unknown rather than nothing when a value carries no space', () => {
    expect(spaceLabel(undefined)).toBe('space unknown')
    expect(spaceName(undefined)).toBe('an unknown space')
  })

  it('falls back to the id for a space nothing in the manifest names', () => {
    expect(spaceName('JRC2018Ucns')).toBe('JRC2018Ucns')
  })
})

describe('the two lookups', () => {
  it('finds a direct mirror, and only a direct one', () => {
    expect(mirrorFor('FLYWIRE')?.file).toBe('FLYWIRE_mirror.csv')
    // No `via`: a space Coda ships no mirror landmarks for has no mirror, full stop. navis
    // would route through another template; that needs registrations a browser cannot run.
    expect(mirrorFor('JRC2018U')).toBeUndefined()
    expect(mirrorFor(undefined)).toBeUndefined()
  })

  it('finds the one edge to the common space', () => {
    expect(toCommonFor('MANC')?.file).toBe('MANC_JRC2018U.csv')
    expect(toCommonFor('nonsense')).toBeUndefined()
  })
})

describe('reading a landmark file', () => {
  const spec = {
    file: 'test.csv',
    landmarks: 2,
    sourceColumns: ['x', 'y', 'z'] as const,
    targetColumns: ['tx', 'ty', 'tz'] as const,
    sourceUnits: 'nm' as const,
    targetUnits: 'nm' as const,
  }

  it('reads pairs into interleaved buffers', () => {
    const pairs = parseLandmarks('x,y,z,tx,ty,tz\n1,2,3,4,5,6\n7,8,9,10,11,12\n', spec, 'test.csv')
    expect(pairs.count).toBe(2)
    expect([...pairs.source]).toEqual([1, 2, 3, 7, 8, 9])
    expect([...pairs.target]).toEqual([4, 5, 6, 10, 11, 12])
  })

  it('reads columns by name rather than by position', () => {
    // The generator writes source-then-target; nothing guarantees a hand-made file will.
    const pairs = parseLandmarks('tz,z,ty,y,tx,x\n6,3,5,2,4,1\n', { ...spec, landmarks: 1 }, 'f')
    expect([...pairs.source]).toEqual([1, 2, 3])
    expect([...pairs.target]).toEqual([4, 5, 6])
  })

  it('converts a micrometre side to nanometres, exactly', () => {
    /*
     * Exact because a 3-D thin-plate spline's kernel is `U(r) = r`, homogeneous of degree one,
     * so scaling either side scales the result and changes nothing else — measured against
     * fastcore at 1.3e-9 on values of order 1e5. This is what keeps `GeometryUnits` from ever
     * needing a third member for JRC2018U's micrometres.
     */
    const um = { ...spec, landmarks: 1, targetUnits: 'um' as const }
    const pairs = parseLandmarks('x,y,z,tx,ty,tz\n1,2,3,4,5,6\n', um, 'f')
    expect([...pairs.target]).toEqual([4000, 5000, 6000])
  })

  it('names the missing column and what did arrive', () => {
    // The usual cause is a 200 carrying somebody's error page, where "no column x" reads as a
    // broken file rather than as a broken fetch.
    expect(() => parseLandmarks('a,b,c\n1,2,3\n', spec, 'test.csv')).toThrow(
      /no "x" column.*a, b, c/s,
    )
  })

  it('refuses a file that disagrees with the manifest about its own size', () => {
    // A stale CSV against a fresh manifest still fits and still runs — on the wrong landmarks.
    expect(() =>
      parseLandmarks('x,y,z,tx,ty,tz\n1,2,3,4,5,6\n', spec, 'test.csv'),
    ).toThrow(/1 landmarks; the manifest says 2/)
  })

  it('refuses a non-numeric cell rather than writing a NaN into a coordinate', () => {
    expect(() =>
      parseLandmarks('x,y,z,tx,ty,tz\n1,2,3,4,5,6\n7,oops,9,10,11,12\n', spec, 'f'),
    ).toThrow(/non-numeric value on line 3/)
  })
})

describe('fetching a landmark file', () => {
  afterEach(() => {
    resetLandmarks()
    vi.unstubAllGlobals()
  })

  const spec = {
    file: 'one.csv',
    landmarks: 1,
    sourceColumns: ['x', 'y', 'z'] as const,
    targetColumns: ['tx', 'ty', 'tz'] as const,
    sourceUnits: 'nm' as const,
    targetUnits: 'nm' as const,
  }
  const body = 'x,y,z,tx,ty,tz\n1,2,3,4,5,6\n'

  it('resolves against BASE_URL rather than the site root', () => {
    // `base` is './' in the build, so an absolute path 404s on the subpath GitHub Pages serves
    // this from. Same rule as the start page's backdrop.
    expect(landmarkUrl('FLYWIRE_mirror.csv')).toBe(
      `${import.meta.env.BASE_URL}transforms/FLYWIRE_mirror.csv`,
    )
  })

  it('fetches once however many callers ask at the same time', () => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const both = Promise.all([loadLandmarks(spec), loadLandmarks(spec)])
    return both.then(([a, b]) => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(a).toBe(b)
    })
  })

  it('lets a later call retry after a failure', async () => {
    /*
     * A rejected promise left in the map would make every later run fail for the rest of the
     * session over one dropped request — the rule the Pyodide and ELK engines both keep.
     */
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadLandmarks(spec)).rejects.toThrow(/503/)
    await expect(loadLandmarks(spec)).resolves.toMatchObject({ count: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('names the file and the URL when the server refuses', () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    return expect(loadLandmarks(spec)).rejects.toThrow(/one\.csv.*404.*transforms\/one\.csv/s)
  })
})

describe('the drift tripwire', () => {
  /**
   * Every source that builds geometry, and the one call it must make to do so.
   *
   * The failure this exists for is a *new* fetch method — the fifth backend, or a sixth
   * geometry kind on an existing one — written by copying a neighbour and stamping
   * `units: 'nm'` directly. It compiles, it runs, the footer looks right, and the value it
   * returns simply cannot be mirrored or refused because nothing ever said what frame it is
   * in. `geometryFrame` is the only place that pairing is decided, and this is what makes
   * going around it visible.
   *
   * Reading the source rather than exercising the methods, deliberately: the point is to catch
   * a method **nobody has written a test for**, which no behavioural assertion can do. Same
   * shape as the exporter's `coverage.test.ts`, and the same admission — a tripwire is what you
   * write when the thing to check is an absence.
   */
  const SOURCES = [
    'src/data/neuprint/NeuPrintSource.ts',
    'src/data/cave/CaveSource.ts',
    'src/data/catmaid/CatmaidSource.ts',
    'src/data/mock/MockSource.ts',
  ]

  it.each(SOURCES)('%s stamps no units without a space', (file) => {
    const text = readFileSync(join(process.cwd(), file), 'utf8')
    // Object-literal form only. `units !== 'nm'` and prose in a comment are not this.
    const bare = [...text.matchAll(/^\s*units: '(nm|voxels)',/gm)]
    expect(
      bare.map((m) => m[0].trim()),
      `${file}: build the pair with geometryFrame() and spread it, so a value cannot carry ` +
        'units without the frame those units are in.',
    ).toEqual([])
  })

  it('checks files that exist and actually build geometry', () => {
    // A path typo would make the assertion above vacuous, and a source that stopped returning
    // geometry should leave this list rather than sit in it passing for the wrong reason.
    for (const file of SOURCES) {
      const text = readFileSync(join(process.cwd(), file), 'utf8')
      expect(text, file).toContain('geometryFrame')
      expect(text, file).toMatch(/kind: '(skeletons|meshes|points)'/)
    }
  })
})
