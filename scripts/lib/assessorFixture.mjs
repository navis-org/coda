/**
 * The assessor probes' test data: SEAM's fixture lists cut to patches, and the plain Conv export
 * beside the MatMul one Coda's fixture manifest names.
 *
 * Shared by `probe:gpu-assessor` and `probe:gpu-browsers`, because the second was a copy of the
 * first and had already lost a guard: without the `convFile === matmul.file` check, an export
 * named otherwise lists the MatMul file as `conv`, which then fails as "it may be the MatMul
 * rewrite" — a sentence about the model, not about the probe's lookup.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the lists, the cut patches and the written manifest go. */
export const ASSESSOR_WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-gpu-assessor')

/**
 * Cut the chosen ends' patches (`seam_assessor.py lists`, needing `CODA_PYTHON` with pandas) and
 * find the plain export. Exits 2 where there is none. `manifest` is freshly parsed, so a caller
 * may rewrite it.
 */
export function assessorFixture(exported, ends) {
  execFileSync(
    process.env.CODA_PYTHON ?? 'python3',
    ['-I', 'scripts/lib/seam_assessor.py', 'lists', exported, ASSESSOR_WORK, ...ends],
    { stdio: 'inherit' },
  )
  const fixture = JSON.parse(readFileSync(join(ASSESSOR_WORK, 'lists.json'), 'utf8'))
  const manifest = JSON.parse(
    readFileSync('src/packs/seam/__fixtures__/assessorManifest.json', 'utf8'),
  )
  const matmul = manifest.files.find((file) => file.variant === 'matmul')
  // The plain export's name is the MatMul one's without `_mm_`.
  const convFile = matmul.file.replace('_mm_', '_')
  if (convFile === matmul.file || !existsSync(join(exported, convFile))) {
    console.error(`No plain Conv export beside ${matmul.file} in ${exported} (looked for ${convFile})`)
    process.exit(2)
  }
  const lists = fixture.lists.map((one) => ({ end: one.end_uid, patches: one.patches, size: one.size }))
  return { fixture, manifest, matmul, convFile, lists }
}
