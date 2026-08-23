/**
 * Reading Parquet and Feather, against files a real toolchain wrote.
 *
 * The fixtures are `pandas.to_parquet` and `pyarrow.feather.write_feather` on their **defaults**
 * — snappy and lz4 — because the defaults are what a user's file will be, and both were failure
 * cases before this: arrow-js ships no lz4 codec at all, and a Parquet reader that only handled
 * uncompressed would refuse the format pandas actually writes.
 *
 * The load-bearing assertion in every case is the id. These are eighteen digits, which is where
 * a format that stores them as anything but an integer or text quietly hands back a different
 * neuron.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { previewBinary, readBinary } from './binary'
import { SNIFF_BYTES, sniffEdgeFormat } from './formats'

const WIDE = '720575940628857210'
const HERE = new URL('./__fixtures__/', import.meta.url)

/** A `File` over a fixture, which is what the panel hands the reader. */
function fixture(name: string): File {
  const bytes = readFileSync(new URL(name, HERE))
  return new File([bytes], name)
}

const edgesOf = (encoded: Awaited<ReturnType<typeof readBinary>>) => {
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

describe('sniffEdgeFormat', () => {
  it('recognises both binary formats from their own header', async () => {
    for (const [name, format] of [
      ['edges.parquet', 'parquet'],
      ['edges.feather', 'feather'],
    ] as const) {
      const head = new Uint8Array(await fixture(name).slice(0, SNIFF_BYTES).arrayBuffer())
      expect(sniffEdgeFormat(head)).toBe(format)
    }
  })

  it('reads anything else as delimited', () => {
    // The right default rather than a shrug: a text reader on a binary file fails with something
    // actionable, where a binary reader on a text file fails inside a decompressor.
    expect(sniffEdgeFormat(new TextEncoder().encode('pre,post\n1,2\n'))).toBe('delimited')
    expect(sniffEdgeFormat(new Uint8Array(0))).toBe('delimited')
  })
})

describe.each([
  ['parquet', 'edges.parquet'],
  ['feather', 'edges.feather'],
] as const)('%s', (format, name) => {
  it('previews its columns, types and first rows', async () => {
    const preview = await previewBinary(format, { file: fixture(name) })
    expect(preview.columns).toEqual(['pre_pt_root_id', 'post_pt_root_id', 'n_syn'])
    expect(preview.rowCount).toBe(3)
    // The id has to survive the *preview* too — it is what the panel shows somebody to confirm
    // they picked the right column.
    expect(preview.rows[0]?.[0]).toBe(WIDE)
  })

  it('reads an eighteen-digit id exactly', async () => {
    const encoded = await readBinary(
      format,
      { file: fixture(name) },
      {
        pre: 0,
        post: 1,
        weight: 2,
      },
    )
    expect(encoded.ids).toContain(WIDE)
    expect(edgesOf(encoded)).toEqual([
      [WIDE, '720575940628857211', 10],
      [WIDE, '720575940628857212', 2],
      ['720575940628857211', WIDE, 5],
    ])
  })

  it('weighs every edge 1 with no weight column chosen', async () => {
    const encoded = await readBinary(format, { file: fixture(name) }, { pre: 0, post: 1 })
    expect(edgesOf(encoded).map((e) => e[2])).toEqual([1, 1, 1])
  })

  it('reports progress', async () => {
    const notes: string[] = []
    await readBinary(
      format,
      { file: fixture(name) },
      { pre: 0, post: 1 },
      {
        onProgress: (_, note) => note && notes.push(note),
      },
    )
    expect(notes.at(-1)).toMatch(/compress/i)
  })
})

describe('a file whose ids were already rounded', () => {
  it('is refused by name rather than read', async () => {
    // 720575940628857210 cannot be held in a double, so a DOUBLE id column has already lost it
    // before we open the file. Nothing downstream can recover that, and the only other symptom
    // would be every row joining to nothing.
    await expect(
      readBinary('parquet', { file: fixture('float-ids.parquet') }, { pre: 0, post: 1 }),
    ).rejects.toThrow(/rounded when the file was written/)
  })
})
