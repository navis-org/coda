import { describe, expect, it } from 'vitest'

import '../nodes'
import { helperRegistry as pythonHelpers } from './python/registry'
import { helperRegistry as rHelpers } from './r/registry'
import { assembleHelpers, splitMembers } from './trimHelpers'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import type { CodaGraph } from '../core/graph'
import { exportNotebook, serializeNotebook } from './python/exporter'
import { exportRmd } from './r/exporter'
import type { TrimRule } from './trimHelpers'

interface Spec {
  name: string
  needs?: string[]
  source: string[]
  trim?: TrimRule
}

const registry = (specs: Spec[]) => new Map(specs.map((s) => [s.name, s]))
/** One body cell holding `text`. */
const body = (text: string) => [{ source: [text] }]

const walk: Spec = { name: 'coda_walk', source: ['def coda_walk(ids):', '    return ids'] }

const dataset: Spec = {
  name: 'Dataset',
  needs: ['coda_walk'],
  trim: 'methods',
  source: [
    'class Dataset:',
    '    """One dataset."""',
    '',
    "    KIND = 'x'",
    '',
    '    def __init__(self, server):',
    '        self.server = server',
    '',
    '    # ---- neurons ----',
    '',
    '    @property',
    '    def labels(self):',
    '        return self._types()',
    '',
    '    def _types(self):',
    '        # Private, reached only through labels.',
    '        return {}',
    '',
    '    def lookup(self, ids):',
    '        return ids',
    '',
    '    def connectivity(self, ids):',
    '        return coda_walk(ids)',
  ],
}

const methods = (source: string[]) => source.flatMap((l) => /^ {4}def (\w+)/.exec(l)?.[1] ?? [])

describe('trimming a helper to what the document refers to', () => {
  const both = registry([walk, dataset])

  it('keeps the class head and dunders, and only the methods the body calls', () => {
    const [out] = assembleHelpers(
      ['Dataset'],
      both,
      'Python',
      body('ds = Dataset(1)\nx = ds.lookup([1])'),
    )
    expect(out!.spec.name).toBe('Dataset')
    expect(methods(out!.source)).toEqual(['__init__', 'lookup'])
    expect(out!.source).toContain("    KIND = 'x'")
  })

  it('follows a kept method to the private ones it uses, with their decorators and comments', () => {
    const [out] = assembleHelpers(['Dataset'], both, 'Python', body('ds.labels'))
    expect(methods(out!.source)).toEqual(['__init__', 'labels', '_types'])
    const text = out!.source.join('\n')
    expect(text).toContain('    @property\n    def labels')
    expect(text).toContain('# Private, reached only through labels.')
  })

  it('emits a need only when a kept member names it', () => {
    const without = assembleHelpers(['Dataset'], both, 'Python', body('ds.lookup(1)'))
    expect(without.map((a) => a.spec.name)).toEqual(['Dataset'])
    const with_ = assembleHelpers(['Dataset'], both, 'Python', body('ds.connectivity(1)'))
    expect(with_.map((a) => a.spec.name)).toEqual(['coda_walk', 'Dataset'])
  })

  it('reads a reference out of a helper kept whole as well as out of the body', () => {
    const user: Spec = {
      name: 'coda_user',
      source: ['def coda_user(ds):', '    return ds.lookup(1)'],
    }
    const out = assembleHelpers(
      ['Dataset', 'coda_user'],
      registry([walk, dataset, user]),
      'Python',
      [],
    )
    expect(methods(out.find((a) => a.spec.name === 'Dataset')!.source)).toEqual([
      '__init__',
      'lookup',
    ])
  })

  it('leaves a helper without a trim rule exactly as written', () => {
    const out = assembleHelpers(['coda_walk'], both, 'Python', [])
    expect(out).toEqual([{ spec: walk, source: walk.source }])
  })

  it('splits R at its top-level functions, keeping the one named after the helper', () => {
    const r: Spec = {
      name: 'coda_ds',
      needs: ['coda_walk'],
      trim: 'functions',
      source: [
        'coda_ds <- function(server) {',
        '  list(server = server)',
        '}',
        '',
        "#' The neuron table.",
        'coda_ds_labels <- function(ds) {',
        '  coda_ds_types(ds)',
        '}',
        '',
        'coda_ds_types <- function(ds) list()',
        '',
        'coda_ds_walk <- function(ds, ids) coda_walk(ids)',
      ],
    }
    const out = assembleHelpers(
      ['coda_ds'],
      registry([walk, r]),
      'R',
      body('x <- coda_ds_labels(ds)'),
    )
    const names = out.flatMap((a) =>
      a.source.flatMap((l) => /^([.\w]+) <- function/.exec(l)?.[1] ?? []),
    )
    expect(names).toEqual(['coda_ds', 'coda_ds_labels', 'coda_ds_types'])
    expect(out[0]!.source.join('\n')).toContain("#' The neuron table.")
    // `coda_walk` is named only by the walk, which nothing calls.
    expect(out.map((a) => a.spec.name)).toEqual(['coda_ds'])
  })

  it('does not keep a member that only a comment names', () => {
    const [out] = assembleHelpers(
      ['Dataset'],
      both,
      'Python',
      body('# ds.lookup(1) would read the table\nds = Dataset(1)'),
    )
    expect(methods(out!.source)).toEqual(['__init__'])
  })

  it('tests a helper reached through a kept need against members chosen before it', () => {
    // `Outer.load` names `Inner`, so `Inner` arrives a pass later, and only `load` calls its `read`.
    const inner: Spec = {
      name: 'Inner',
      trim: 'methods',
      source: [
        'class Inner:',
        '    def read(self):',
        '        return 1',
        '',
        '    def unused(self):',
        '        return 2',
      ],
    }
    const outer: Spec = {
      name: 'Outer',
      needs: ['Inner'],
      trim: 'methods',
      source: [
        'class Outer:',
        '    def load(self):',
        '        return Inner().read()',
        '',
        '    def other(self):',
        '        return 0',
      ],
    }
    const out = assembleHelpers(['Outer'], registry([inner, outer]), 'Python', body('o.load()'))
    expect(out.map((a) => a.spec.name)).toEqual(['Inner', 'Outer'])
    expect(methods(out[0]!.source)).toEqual(['read'])
  })

  it('refuses a class with code after it, which has no member to belong to', () => {
    const tailed: Spec = { ...dataset, source: [...dataset.source, '', 'LOOSE = 1'] }
    expect(() => assembleHelpers(['Dataset'], registry([walk, tailed]), 'Python', [])).toThrow(
      /code after the class/,
    )
  })
})

/*
 * The splitter is a reading of source text, so its failure would be silent: a line given to the
 * wrong member is dropped with it. Every helper that opts in is checked as registered.
 */
describe('every trimmable helper, as registered', () => {
  const trimmed = [...pythonHelpers().values(), ...rHelpers().values()].filter((s) => s.trim)

  it('has some, in both languages', () => {
    expect(trimmed.filter((s) => s.trim === 'methods').length).toBeGreaterThan(0)
    expect(trimmed.filter((s) => s.trim === 'functions').length).toBeGreaterThan(0)
  })

  it.each(trimmed.map((s) => [s.name, s] as const))(
    '%s splits into a head and members holding every line exactly once',
    (_, spec) => {
      const { head, members } = splitMembers({ ...spec, trim: spec.trim! })
      const nonblank = (lines: string[]) => lines.filter((l) => l.trim() !== '')
      expect(nonblank([...head, ...members.flatMap((m) => m.lines)]).sort()).toEqual(
        nonblank(spec.source).sort(),
      )
      // A member holds its own body and the comments and decorators above it; a line at the
      // member's own indent that is none of those was absorbed from the class.
      if (spec.trim === 'methods') {
        // The head is what a document calling no method gets, so it must be a class with a body.
        expect(head.some((l) => /^ {4}\S/.test(l))).toBe(true)
        for (const m of members) {
          const strays = m.lines.filter((l) => /^ {4}[^ #@]/.test(l) && !/^ {4}def /.test(l))
          expect(strays, m.name).toEqual([])
        }
      }
      // R's equivalent: top-level code that is not a function, such as a shared constant, has no
      // member of its own and would leave with whichever function precedes it.
      if (spec.trim === 'functions') {
        for (const m of members) {
          const strays = m.lines.filter(
            (l) => /^[^\s#})]/.test(l) && !/^[.A-Za-z][.\w]* <- function\b/.test(l),
          )
          expect(strays, m.name).toEqual([])
        }
      }
    },
  )
})

describe('a CATMAID document carries the methods its graph calls, and nothing else', () => {
  // A one-hop partners question: the shape the wizard builds, and the case that measured 397
  // lines before trimming.
  function partners(): CodaGraph {
    let g = emptyGraph('partners')
    const at = { x: 0, y: 0 }
    g = addNode(g, { id: 'fafb', type: 'dataset.catmaid.fafb', position: at, params: {} })
    g = addNode(g, {
      id: 'ids',
      type: 'neuron.inputIds',
      position: at,
      params: { ids: '16 27' },
    })
    g = addNode(g, { id: 'conn', type: 'neuron.connectivity', position: at, params: {} })
    const wire = (from: string, out: string, to: string, into: string) => {
      g = addEdge(g, {
        id: `${from}-${to}-${into}`,
        source: from,
        sourceHandle: out,
        target: to,
        targetHandle: into,
      })
    }
    wire('fafb', 'dataset', 'ids', 'dataset')
    wire('fafb', 'dataset', 'conn', 'dataset')
    wire('ids', 'neurons', 'conn', 'neurons')
    return g
  }

  it('in the notebook: lookup, connectivity and what they use; no navis import', () => {
    const result = exportNotebook(partners())
    if (!result.ok) throw new Error(result.reason)
    const text = serializeNotebook(result.notebook)
    const code = (JSON.parse(text) as { cells: Array<{ source: string[] }> }).cells
      .map((c) => c.source.join(''))
      .join('\n')
    const defs = [...code.matchAll(/^ {4}def (\w+)\(/gm)].map((m) => m[1])
    expect(defs).toEqual(
      expect.arrayContaining(['__init__', 'labels', 'lookup', 'connectivity', '_partners']),
    )
    for (const unused of [
      'adjacency',
      'synapses',
      'synapses_between',
      'skeletons',
      'volumes',
    ]) {
      expect(defs).not.toContain(unused)
    }
    expect(code).not.toMatch(/^import navis/m)
  })

  it('in R: the same functions', () => {
    const result = exportRmd(partners())
    if (!result.ok) throw new Error(result.reason)
    const fns = [...result.source.matchAll(/^(coda_catmaid_\w+) <- function/gm)].map(
      (m) => m[1],
    )
    expect(fns).toEqual(
      expect.arrayContaining(['coda_catmaid_lookup', 'coda_catmaid_connectivity']),
    )
    for (const unused of [
      'adjacency',
      'synapses',
      'synapses_between',
      'skeletons',
      'volumes',
    ]) {
      expect(fns).not.toContain(`coda_catmaid_${unused}`)
    }
  })
})
