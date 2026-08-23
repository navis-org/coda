/**
 * Reading an edge list.
 *
 * The preview cases are about the *first* thing a user sees, and a wrong guess there is a wrong
 * import. The streaming cases are about the boundaries a whole-text parser never meets — a CRLF
 * split across two chunks, a multi-byte character split across two chunks, a final row with no
 * newline after it — each of which loses or invents a row rather than failing.
 */
import { describe, expect, it, vi } from 'vitest'

import { previewEdges, readEdges } from './read'

/** A stream that hands the text over in fixed-size byte chunks, to reach the seams. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}

const read = (text: string, opts: Partial<Parameters<typeof readEdges>[1]> = {}, chunk = 8) =>
  readEdges(chunked(text, chunk), {
    delimiter: ',',
    hasHeader: true,
    columns: { pre: 0, post: 1, weight: 2 },
    ...opts,
  })

const edgesOf = (encoded: Awaited<ReturnType<typeof readEdges>>) => {
  const out: [string, string, number][] = []
  for (let n = 0; n < encoded.ids.length; n++) {
    for (let i = encoded.out.offsets[n]!; i < encoded.out.offsets[n + 1]!; i++) {
      out.push([
        encoded.ids[n]!,
        encoded.ids[encoded.out.targets[i]!]!,
        encoded.out.weights[i]!,
      ])
    }
  }
  return out.sort()
}

describe('previewEdges', () => {
  it('recognises the column names that actually occur', () => {
    const cave = previewEdges('pre_pt_root_id,post_pt_root_id,n_syn\n1,2,3\n')
    expect(cave.suggestion).toEqual({ pre: 0, post: 1, weight: 2 })

    const neuprint = previewEdges('bodyId_pre,bodyId_post,weight\n1,2,3\n')
    expect(neuprint.suggestion).toEqual({ pre: 0, post: 1, weight: 2 })
  })

  it('prefers the root id over a supervoxel column that also starts with "pre"', () => {
    // A loose /pre/ matches `pre_pt_supervoxel_id`, which is a different identifier entirely and
    // would join to nothing — the reason the candidates are an ordered list rather than a regex.
    const preview = previewEdges('pre_pt_supervoxel_id,pre_pt_root_id,post_pt_root_id\n9,1,2\n')
    expect(preview.suggestion).toMatchObject({ pre: 1, post: 2 })
  })

  it('offers positions for a headerless file and no guess for an unrecognisable one', () => {
    const bare = previewEdges('1,2,3\n4,5,6\n')
    expect(bare.hasHeader).toBe(false)
    expect(bare.suggestion).toEqual({ pre: 0, post: 1, weight: 2 })

    // Names that mean nothing to us: the panel has to ask rather than guess wrong.
    expect(previewEdges('alpha,beta,gamma\n1,2,3\n').suggestion).toBeUndefined()
  })

  it('reads tabs and semicolons, and shows the rows as text', () => {
    const tabbed = previewEdges('from\tto\tweight\n1\t2\t3\n')
    expect(tabbed.delimiter).toBe('\t')
    expect(tabbed.columns).toEqual(['from', 'to', 'weight'])
    expect(tabbed.rows[0]).toEqual(['1', '2', '3'])
  })

  it('trims a truncated sample back to its last full line', () => {
    // A 64 kB slice cuts mid-row, and both the delimiter and the header decision are judged on
    // how consistently rows split — so the ragged tail has to go before either is made.
    const preview = previewEdges('from,to,weight\n1,2,3\n4,5')
    expect(preview.rows).toEqual([['1', '2', '3']])
  })
})

describe('readEdges', () => {
  const FILE = 'pre,post,weight\n1,2,10\n1,3,2\n4,2,5\n'

  it('reads a file into an edge set', async () => {
    expect(edgesOf(await read(FILE))).toEqual([
      ['1', '2', 10],
      ['1', '3', 2],
      ['4', '2', 5],
    ])
  })

  it('reads the same file however the chunks fall', async () => {
    // Every boundary in the file, one byte at a time: a row, a field and a line ending each get
    // split by some chunk size, and any of them silently loses or invents a row.
    for (const size of [1, 2, 3, 5, 7, 16, 1024]) {
      expect(edgesOf(await read(FILE, {}, size))).toHaveLength(3)
    }
  })

  it('keeps a CRLF straddling a chunk boundary as one line ending', async () => {
    // Not by carrying state across the boundary — that was written and removed as unobservable.
    // The orphaned LF opening the next chunk ends an empty row, which `take` discards, exactly
    // as a blank line mid-file is discarded.
    const crlf = 'pre,post,weight\r\n1,2,10\r\n4,2,5\r\n'
    for (const size of [1, 2, 4, 8, 23, 24, 25]) {
      expect(edgesOf(await read(crlf, {}, size))).toEqual([
        ['1', '2', 10],
        ['4', '2', 5],
      ])
    }
  })

  it('keeps a multi-byte character split across chunks', async () => {
    // The decoder is streaming for exactly this: a label cut mid-character otherwise arrives as
    // a replacement character and becomes a second, different neuron.
    const text = 'pre,post\nLC4→a,LC4→b\n'
    const encoded = await read(text, { columns: { pre: 0, post: 1 } }, 3)
    expect(encoded.ids).toEqual(['LC4→a', 'LC4→b'])
  })

  it('keeps a final row with no trailing newline', async () => {
    expect(edgesOf(await read('pre,post,weight\n1,2,10\n4,2,5'))).toHaveLength(2)
  })

  it('weighs every edge 1 when no weight column is chosen', async () => {
    const encoded = await read('pre,post\n1,2\n4,2\n', { columns: { pre: 0, post: 1 } })
    expect(edgesOf(encoded)).toEqual([
      ['1', '2', 1],
      ['4', '2', 1],
    ])
  })

  it('drops a blank weight rather than reading it as zero', async () => {
    // `Number('')` is 0 — a zero-weight edge, which is a connection nobody recorded.
    const encoded = await read('pre,post,weight\n1,2,10\n4,2,\n')
    expect(encoded.edges).toBe(1)
    expect(encoded.report.droppedWeight).toBe(1)
  })

  it('takes the columns it was given, not the ones in the file', async () => {
    // A file whose weight sits before its ids, which is a real shape — and the reason the panel
    // asks rather than assuming a column order.
    const encoded = await read('weight,pre,post\n10,1,2\n', {
      columns: { pre: 1, post: 2, weight: 0 },
    })
    expect(edgesOf(encoded)).toEqual([['1', '2', 10]])
  })

  it('skips no row when the file has no header', async () => {
    const encoded = await read('1,2,10\n4,2,5\n', { hasHeader: false })
    expect(edgesOf(encoded)).toHaveLength(2)
  })

  it('reports progress and stops on abort', async () => {
    const onProgress = vi.fn()
    await read(FILE, { onProgress, totalBytes: FILE.length })
    // At minimum the compressing phase, so a long import never looks stalled at the end.
    expect(onProgress).toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort()
    await expect(read(FILE, { signal: controller.signal })).rejects.toThrow(/abort/i)
  })
})
