/**
 * The import driver, on the no-worker path.
 *
 * jsdom has no `Worker`, so this is the branch a test can reach — and it is the branch that
 * actually reads the file, which is why the fallback exists at all rather than as a courtesy.
 * The worker wrapper itself stays uncovered, on `src/pyodide`'s standing.
 */
import { describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'

import { importEdges, previewEdgeSource } from './importer'

const FILE = 'pre,post,weight\n1,2,10\n1,3,2\n4,2,5\n'

function file(text: string, name = 'edges.csv'): File {
  return new File([text], name, { type: 'text/csv' })
}

function fixture(name: string): File {
  return new File([readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))], name)
}

describe('previewEdgeSource', () => {
  it('recognises each format from the file itself, not its name', async () => {
    // Deliberately misnamed: an edge list arrives as `.txt`, `.gz`, or with no extension at all
    // from a URL, so the header is the only thing worth believing.
    const parquet = await previewEdgeSource({
      file: new File(
        [readFileSync(new URL('./__fixtures__/edges.parquet', import.meta.url))],
        'x.txt',
      ),
    })
    expect(parquet.format).toBe('parquet')
    expect(parquet.columns).toEqual(['pre_pt_root_id', 'post_pt_root_id', 'n_syn'])
    expect(parquet.suggestion).toEqual({ pre: 0, post: 1, weight: 2 })

    const feather = await previewEdgeSource({ file: fixture('edges.feather') })
    expect(feather.format).toBe('feather')
    expect(feather.rowCount).toBe(3)

    const csv = await previewEdgeSource({ file: new File([FILE], 'edges.csv') })
    expect(csv.format).toBe('delimited')
    expect(csv.delimiter).toBe(',')
    expect(csv.hasHeader).toBe(true)
  })
})

describe('importEdges', () => {
  it('reads a File end to end', async () => {
    const encoded = await importEdges({
      file: file(FILE),
      format: 'delimited',
      columns: { pre: 0, post: 1, weight: 2 },
    })
    expect(encoded.edges).toBe(3)
    expect(encoded.ids).toEqual(expect.arrayContaining(['1', '2', '3', '4']))
  })

  it('reports progress against the file’s own size', async () => {
    const onProgress = vi.fn()
    await importEdges({
      file: file(FILE),
      format: 'delimited',
      columns: { pre: 0, post: 1 },
      onProgress,
    })
    expect(onProgress).toHaveBeenCalled()
    // The last word is the compressing phase, so a long import does not sit at 99% silently.
    expect(onProgress.mock.calls.at(-1)?.[1]).toMatch(/compress/i)
  })

  it('reads a URL, and says what a bad one answered', async () => {
    const body = new Response(FILE, { headers: { 'content-length': String(FILE.length) } })
    const fetchMock = vi.fn(async () => body)
    vi.stubGlobal('fetch', fetchMock)
    const encoded = await importEdges({
      url: 'https://example.org/edges.csv',
      format: 'delimited',
      columns: { pre: 0, post: 1, weight: 2 },
    })
    expect(encoded.edges).toBe(3)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    await expect(
      importEdges({
        url: 'https://example.org/gone.csv',
        format: 'delimited',
        columns: { pre: 0, post: 1 },
      }),
    ).rejects.toThrow(/404/)
    vi.unstubAllGlobals()
  })

  it('reads a Parquet file through the same entry point', async () => {
    const encoded = await importEdges({
      file: fixture('edges.parquet'),
      format: 'parquet',
      columns: { pre: 0, post: 1, weight: 2 },
    })
    expect(encoded.edges).toBe(3)
    expect(encoded.ids).toContain('720575940628857210')
  })

  it('refuses with nothing named', async () => {
    await expect(
      importEdges({
        format: 'delimited',
        columns: { pre: 0, post: 1 },
      }),
    ).rejects.toThrow(/file or a URL/)
  })
})
