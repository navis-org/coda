/**
 * Build the neuroglancer that `neuroglancer.html` bundles — Spelunker, CAVE's build — into
 * `vendor/neuroglancer.tgz`, which `package.json` names.
 *
 * Spelunker is `seung-lab/neuroglancer`'s `spelunker` branch: Google's master with CAVE's commits
 * rebased on top (terms-of-service-aware middleauth, graphene tools, keybindings). Nobody
 * publishes it as a package, and the branch is force-pushed, so a commit pinned in `package.json`
 * as a git dependency can stop existing — and installing one would run neuroglancer's whole build
 * on every install and in CI. So the package is built here, once per update, by the same
 * `npm pack` that produces the npm releases (its `prepack` builds `lib/` in place), and the
 * tarball is committed. Installs never touch GitHub.
 *
 *   node scripts/build-neuroglancer.mjs                 # the branch's current tip
 *   node scripts/build-neuroglancer.mjs --commit <sha>  # a particular commit, by its full sha
 *   then: pnpm install, pnpm probe:neuroglancer-select, and check a CAVE dataset by hand
 *
 * `vendor/neuroglancer-keybinds.json` is Spelunker's keybindings, which its deployment injects at
 * build time (`config/custom-keybinds.json` as `NEUROGLANCER_CUSTOM_INPUT_BINDINGS`) and which the
 * package therefore does not carry; `src/ngframe/keybinds.ts` sets them from this copy.
 *
 * `vendor/neuroglancer.json` records which commit the tarball is, since the version inside it is
 * whatever the branch's `package.json` says (it still reads 2.41.2) and names nothing.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeArgs } from './lib/browserProbe.mjs'

const REPO = 'https://github.com/seung-lab/neuroglancer.git'
const BRANCH = 'spelunker'
const root = new URL('..', import.meta.url).pathname
const vendor = join(root, 'vendor')

const run = (cmd, cmdArgs, cwd) =>
  execFileSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })

const commit =
  probeArgs().value('--commit') ??
  run('git', ['ls-remote', REPO, `refs/heads/${BRANCH}`]).split(/\s/)[0]
// The full sha: GitHub serves a shallow fetch of a commit only by its whole name.
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`No commit to build: give the full 40-character sha (got ${JSON.stringify(commit)}).`)
  process.exit(2)
}

// A clean directory of its own, outside the repo: this is somebody else's build running.
const work = join(tmpdir(), `coda-neuroglancer-${commit.slice(0, 12)}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
console.log(`Building ${REPO} at ${commit} in ${work}`)
run('git', ['init', '--quiet'], work)
run('git', ['fetch', '--quiet', '--depth', '1', REPO, commit], work)
run('git', ['checkout', '--quiet', 'FETCH_HEAD'], work)
const full = run('git', ['rev-parse', 'HEAD'], work).trim()
const date = run('git', ['show', '-s', '--format=%cI', 'HEAD'], work).trim()

// Taken from the same commit as the package, so the two cannot disagree about a tool's name.
const keybinds = join(work, 'config', 'custom-keybinds.json')
mkdirSync(vendor, { recursive: true })
if (existsSync(keybinds)) copyFileSync(keybinds, join(vendor, 'neuroglancer-keybinds.json'))
else writeFileSync(join(vendor, 'neuroglancer-keybinds.json'), '{}\n')

run('npm', ['ci', '--no-audit', '--no-fund'], work)
const packed = run('npm', ['pack', '--pack-destination', vendor], work).trim().split('\n').pop()

// One fixed name, so `package.json` (`file:vendor/neuroglancer.tgz`) never changes on an update;
// which commit it is lives in `neuroglancer.json`, beside it.
const name = 'neuroglancer.tgz'
renameSync(join(vendor, packed), join(vendor, name))
writeFileSync(
  join(vendor, 'neuroglancer.json'),
  `${JSON.stringify({ repo: REPO, branch: BRANCH, commit: full, committed: date }, null, 2)}\n`,
)
rmSync(work, { recursive: true, force: true })

console.log(`\nvendor/${name} (${full.slice(0, 12)}, committed ${date})`)
console.log('Next: pnpm install, then pnpm probe:neuroglancer-select and a CAVE dataset by hand.')
