#!/usr/bin/env node
/**
 * Write the model manifest for SEAM's geometric ranker, from the forest and SEAM's own pipeline.
 *
 *   node scripts/make-ranker-manifest.mjs <model.txt> <fixture.json> [out-dir]
 *
 * `model.txt` is LightGBM's dump — `pipeline.search.ranker.model_file` in a published suggestion
 * set. `fixture.json` is that set's manifest, which is where the numbers the forest was fitted
 * with are stated. The output directory gets `manifest.json` and a copy of `model.txt`, which is
 * the whole thing to upload: `fileUrl` resolves a file against the manifest's own address, so the
 * pair works at any host without being rewritten.
 *
 * ## Why this is a script and not a hand-written file
 *
 * Every field below is **taken** rather than typed. The sha256 and the byte count have to be the
 * file's or `loadWeights` refuses it; the eleven feature names have to be in the order the forest
 * numbers its columns, and nothing downstream can check that — LightGBM wrote its own names as
 * `Column_0 … Column_10`, so a transcription slip would score every candidate against the wrong
 * numbers and still rank. Reading them out of the set that fitted the forest is the only place
 * the order is stated by something that knows it.
 *
 * It also checks the two together: a forest whose `max_feature_idx` is not one less than the
 * feature list's length is a mismatched pair, and that is the one failure this can catch here
 * rather than in a browser three stages later.
 *
 * Reads and writes files given on the command line. Fetches nothing, uploads nothing.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A constant read out of the source that declares it, rather than copied here.
 *
 * `scripts/make-assessor-manifest.py` makes the same argument about the same schema number: a
 * hard-coded copy goes stale silently, and the manifest it wrote would be refused at load with
 * nothing in-repo catching it — the fixture this script also writes is no check, being its own
 * output. Four lines, and it cannot go stale at all. The bargain `src/packs/seam/patchBox.ts`
 * makes with the vendored Python.
 */
function declared(file, pattern, what) {
  const found = new RegExp(pattern, 'm').exec(readFileSync(join(REPO, file), 'utf8'))
  if (!found) {
    console.error(`${file} no longer declares ${what}`)
    process.exit(1)
  }
  return found[1]
}

const [modelPath, fixturePath, outDir = 'ranker-manifest'] = process.argv.slice(2)
if (!modelPath || !fixturePath) {
  console.error('usage: node scripts/make-ranker-manifest.mjs <model.txt> <fixture.json> [out]')
  process.exit(2)
}

const model = readFileSync(modelPath)
const text = model.toString('utf8')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

const search = fixture?.pipeline?.search
const ranker = search?.ranker
if (!ranker?.features?.length) {
  console.error(`${fixturePath} has no pipeline.search.ranker.features`)
  process.exit(1)
}

/*
 * The forest's own column count, against the list's. LightGBM states `max_feature_idx` as the
 * highest index it will read, so a list of eleven means ten. This is the one half of the pairing
 * that can be checked at all — the *order* cannot, which is why the list is read from the set.
 */
const maxIdx = /^max_feature_idx=(\d+)/m.exec(text)
if (!maxIdx) {
  console.error(`${modelPath} has no max_feature_idx: it is not a LightGBM text dump`)
  process.exit(1)
}
if (Number(maxIdx[1]) !== ranker.features.length - 1) {
  console.error(
    `${modelPath} reads ${Number(maxIdx[1]) + 1} features and ${fixturePath} names ` +
      `${ranker.features.length}. They are not the same fit.`,
  )
  process.exit(1)
}

const number = (block, field) => {
  const value = block?.[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    console.error(`${fixturePath} has no numeric ${field}`)
    process.exit(1)
  }
  return value
}

const file = basename(modelPath)
const manifest = {
  id: 'trees_sizes_tip',
  manifestSchema: Number(
    declared('src/ml/manifest.ts', String.raw`^export const MANIFEST_SCHEMA = (\d+)`, 'MANIFEST_SCHEMA'),
  ),
  task: declared(
    'src/packs/seam/models.ts',
    String.raw`^export const MERGE_RANKER_TASK = '([^']+)'`,
    'MERGE_RANKER_TASK',
  ),
  parts: ['ranker'],
  datasets: [fixture.dataset ?? 'aedes_h1'],
  license: 'MIT',
  citation:
    'SEAM, Drosophila Connectomics group; geometric candidate ranker fitted on the Aedes ' +
    "reconstruction's edit history",
  source: 'https://github.com/flyconnectome/SEAM',
  upstreamCommit: fixture.commit ?? null,
  randomWeights: false,
  /*
   * `config` is the pack's (`docs/ml.md`), and `rankerConfig.ts` is what reads it. Everything the
   * search is run with is here, so the weights and the numbers they were fitted with are one
   * version — which is the whole reason this moved out of the suggestion set.
   */
  config: {
    features: ranker.features,
    cutout_half_width_um: number(search, 'cutout_half_width_um'),
    cutout_xy_nm: number(search, 'cutout_xy_nm'),
    pool_max_dist_um: number(search, 'pool_max_dist_um'),
    top_k: number(search, 'top_k'),
    own_um: number(fixture.pipeline?.own_tip, 'own_um'),
    fitted_on: ranker.fitted_on ?? null,
  },
  /*
   * `src/ml` requires a signature per part, and this one is honest rather than a placeholder: the
   * forest takes one feature matrix and emits one score per row. What the eleven columns *mean*
   * is `config.features`, which is the pack's half of the split.
   */
  signatures: { ranker: { inputs: ['features'], outputs: ['geo_score'] } },
  files: [
    {
      variant: 'text',
      part: 'ranker',
      file,
      url: null,
      bytes: model.byteLength,
      sha256: createHash('sha256').update(model).digest('hex'),
      // Not a quantised graph, and nothing runs on a GPU. Stated rather than left out, because
      // `preferredVariant` reads an absent `emits` as "refuse" and a reader of this file should
      // see why that never applies here.
      quantisation: { kind: 'none', io: 'float64', quantises: [], emits: [] },
    },
  ],
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)
copyFileSync(modelPath, join(outDir, file))

const trees = (text.match(/^Tree=/gm) ?? []).length
console.log(
  `${outDir}/manifest.json + ${file}: ${trees} trees on ${ranker.features.length} features, ` +
    `${(model.byteLength / 1024).toFixed(0)} KiB.`,
)
console.log(`Upload both to the address in MERGE_RANKER_MODELS (src/packs/seam/models.ts).`)
