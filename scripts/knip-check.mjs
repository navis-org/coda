/**
 * Dead code, held to a baseline: `pnpm knip:check`, and `pnpm knip:update` to accept the result.
 *
 * knip lists files, exports, types and dependencies nothing reaches. Some are kept on purpose — a
 * test seam, a canary, an alias a suite depends on — so the check is not "none" but "none
 * unrecorded": the report is flattened to one line per finding and compared with
 * `knip-baseline.txt`, and any difference fails, the way `zoo-index --check` byte-compares its
 * index. A new finding fails until it is used, deleted or accepted on purpose; a fixed one fails
 * until the baseline is refreshed, so the file only ever describes the tree it sits in.
 *
 * Lines carry no line numbers, or every unrelated edit above an accepted finding would move it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BASELINE = new URL('../knip-baseline.txt', import.meta.url)

function findings() {
  let raw
  try {
    raw = execFileSync(
      'pnpm',
      ['exec', 'knip', '--reporter', 'json', '--no-progress', '--no-exit-code'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
  } catch (err) {
    raw = err.stdout
  }
  const report = JSON.parse(raw)
  const lines = (report.files ?? []).map((file) => `file\t${file}`)
  for (const issue of report.issues ?? []) {
    for (const [kind, found] of Object.entries(issue)) {
      // Most kinds are a list; enum and class members are lists keyed by their parent.
      const items = Array.isArray(found)
        ? found
        : found && typeof found === 'object'
          ? Object.values(found).flat()
          : []
      for (const item of items) {
        // A duplicate is a group of names for one export.
        const name = Array.isArray(item) ? item.map((i) => i.name).join(' = ') : item.name
        lines.push(`${kind}\t${issue.file}\t${name}`)
      }
    }
  }
  return [...new Set(lines)].sort()
}

const found = findings()

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, found.length ? `${found.join('\n')}\n` : '')
  console.log(`knip baseline: ${found.length} accepted finding(s)`)
} else {
  let baseline = ''
  try {
    baseline = readFileSync(BASELINE, 'utf8')
  } catch {
    // No baseline yet: every finding is new.
  }
  const accepted = new Set(baseline.split('\n').filter(Boolean))
  const current = new Set(found)
  const added = found.filter((line) => !accepted.has(line))
  const fixed = [...accepted].filter((line) => !current.has(line))
  if (added.length || fixed.length) {
    for (const line of added) console.error(`new    ${line}`)
    for (const line of fixed) console.error(`fixed  ${line}`)
    console.error(
      '\nDead-code findings differ from knip-baseline.txt. Use, delete or accept what is new, ' +
        'then run `pnpm knip:update` to record the result.',
    )
    process.exit(1)
  }
  console.log(`knip: ${found.length} finding(s), all in the baseline`)
}
