/**
 * Build a directory of merge-suggestion sets, ready to copy to a web server.
 *
 * `seam:suggestions` reads a directory through an **index**, because a browser cannot list an
 * HTTP directory — there is no portable way, and the host this is meant for answers `403` to a
 * directory request. So something has to write that index. Eventually that is SEAM's pipeline,
 * depositing each run as it finishes; until then it is this, which is the same job done by hand.
 *
 * It copies each set's three files into `<out>/<id>/` and writes `<out>/index.json` describing
 * them. The entries carry what the card's dropdown shows — datastack, snapshot, counts — so
 * choosing a set costs one fetch rather than one per set.
 *
 * **Nothing is computed here.** The counts come from each set's own manifest, which SEAM checked
 * against the files when it wrote them; this only copies and lists. A set whose manifest and
 * files disagree is caught by the node at read time, which is where it belongs.
 *
 * Usage:
 *   node scripts/seam-suggestion-dir.mjs --out ~/seam-suggestions \
 *     --set rv2=~/Github/SEAM/data/fixtures/coda_rv2
 *
 * `--set` is repeatable: `id=directory`, the id being what a card pins and what the files land
 * under. Add `--trim` to write the committed test set instead of a full one.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The files a set is made of. The node reads the first three; nothing reads the rest. */
const FILES = ['fixture.json', 'tips.parquet', 'candidates.parquet']

const argv = process.argv.slice(2)
const sets = []
let out = ''
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const next = () => argv[++i] ?? ''
  if (arg === '--out') out = next()
  else if (arg === '--set') {
    const [id, ...rest] = next().split('=')
    if (!id || rest.length === 0) {
      console.error(`--set takes id=directory, not ${argv[i]}`)
      process.exit(2)
    }
    sets.push({ id, dir: expand(rest.join('=')) })
  } else {
    console.error(`unknown argument ${arg}`)
    process.exit(2)
  }
}
if (!out || sets.length === 0) {
  console.error('usage: --out <directory> --set <id>=<a set’s directory> [--set ...]')
  process.exit(2)
}
out = expand(out)

/** `~` is the shell's, and this script is run with paths typed by hand. */
function expand(path) {
  return resolve(path.startsWith('~') ? join(homedir(), path.slice(1)) : path)
}

mkdirSync(out, { recursive: true })
const entries = []
for (const { id, dir } of sets) {
  const manifest = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  if (!manifest.counts || !Array.isArray(manifest.neurons)) {
    console.error(`${dir}/fixture.json has no counts or neurons; it is not a suggestion set.`)
    process.exit(2)
  }
  const into = join(out, id)
  mkdirSync(into, { recursive: true })
  let bytes = 0
  for (const file of FILES) {
    const from = join(dir, file)
    copyFileSync(from, join(into, file))
    bytes += statSync(from).size
  }
  entries.push({
    id,
    // Relative to the index, which is what the node resolves it against. The parquet files are
    // in turn relative to the manifest, so a set keeps its own folder.
    path: `${id}/fixture.json`,
    label: id,
    dataset: manifest.dataset,
    datastack: manifest.datastack,
    snapshot: manifest.snapshot,
    commit: manifest.commit,
    neurons: manifest.neurons.length,
    counts: manifest.counts,
  })
  console.log(
    `${id}: ${manifest.counts.tips.toLocaleString()} tips, ` +
      `${manifest.counts.shown.toLocaleString()} shown, ` +
      `${manifest.counts.candidates.toLocaleString()} candidates, ` +
      `${(bytes / 1e6).toFixed(1)} MB`,
  )
}

writeFileSync(
  join(out, 'index.json'),
  `${JSON.stringify(
    {
      what: "SEAM's merge-candidate suggestion sets, for Coda's Merge Suggestions node",
      sets: entries,
    },
    null,
    1,
  )}\n`,
)
console.log(`\nwrote ${join(out, 'index.json')} with ${entries.length} set(s)`)
console.log(
  `\nCopy ${out} to the server. The host must answer HEAD and honour Range on the parquet\n` +
    `files, and send access-control-allow-origin — nginx on flyemdev already does all three.`,
)
