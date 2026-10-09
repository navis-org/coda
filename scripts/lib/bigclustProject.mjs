/**
 * A BigClust project's first embedding and one meta column, as the scatter probes read them — the
 * layout BigClust writes (`data/bigclust/info.ts` is the full reading; this is the slice a probe
 * needs, with the meta column optional because not every project carries it).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

export async function readFirstEmbedding(dir, metaColumn) {
  const info = JSON.parse(readFileSync(join(dir, 'info'), 'utf8'))
  const entry = Array.isArray(info.embeddings) ? info.embeddings[0] : info.embeddings
  const xy = await parquetReadObjects({
    file: await asyncBufferFromFile(join(dir, entry?.file ?? 'embeddings_0.parquet')),
    columns: ['x', 'y'],
  })
  const metaFile = join(dir, info.meta?.file ?? 'meta.parquet')
  const meta = existsSync(metaFile)
    ? await parquetReadObjects({ file: await asyncBufferFromFile(metaFile), columns: [metaColumn] })
    : []
  return {
    source: `${dir} (${entry?.name ?? 'first embedding'})`,
    x: xy.map((r) => r.x),
    y: xy.map((r) => r.y),
    type: xy.map((_, i) => meta[i]?.[metaColumn] ?? null),
  }
}
