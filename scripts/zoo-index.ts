/**
 * Validate a Zoo checkout and write its `index.json`.
 *
 *     pnpm zoo:index ../coda-zoo            # validate and rewrite index.json
 *     pnpm zoo:index ../coda-zoo --check    # validate, and fail if index.json is out of date
 *
 * Run through `vite-node`, which is pinned in `package.json` to the version vitest already
 * depends on. That pin is the whole reason the dev dependency costs three lines of lockfile
 * rather than four hundred: unpinned, pnpm installs the latest, which brings its own copy of
 * Vite alongside the one this repository already has.
 *
 * This is the program `navis-org/coda-zoo`'s CI runs against a checkout of Coda. Everything it
 * knows lives in `src/data/zoo/publish.ts`; what is here is the filesystem, git, and an exit
 * code — deliberately, so the rules are unit-testable without a directory tree.
 *
 * **`--check` is the pull-request gate and the drift alarm at once.** On a contributor's PR it
 * says "you changed a workflow and did not regenerate". On the scheduled run against an
 * untouched zoo it says "Coda changed underneath these workflows" — a node renamed a param, a
 * type went away — which is the failure this whole arrangement exists to catch, because its
 * other form is a card that opens onto a graph with a hole in the middle and nothing anywhere
 * saying so. Both need `index.json` to be a pure function of `workflows/`, which is why
 * `ZooIndex.updatedAt` is derived from the entries rather than stamped from a clock.
 *
 * The two registration lines are load-bearing and easy to mistake for tidying. Without
 * `import '../src/nodes'` every node type is unregistered, so every graph "fails validation"
 * with every node dropped and the script cheerfully reports that the entire zoo is broken.
 * Without `registerBuiltinSources()` the same thing happens one level in: the nodes resolve,
 * and then every dataset node reports "Data source is not registered" as an inference issue.
 * Both failures are total, both read as a contributor problem, and neither is one.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// Side effect: registers every node definition. See the module note.
import '../src/nodes'
import { registerBuiltinSources } from '../src/data/builtins'
import type { ZooEntry, ZooIndex } from '../src/data/zoo/format'
import { ZOO_INDEX_VERSION } from '../src/data/zoo/format'
import type { ZooProblem } from '../src/data/zoo/publish'
import { buildEntry } from '../src/data/zoo/publish'

const WORKFLOWS_DIR = 'workflows'
const GRAPH_FILE = 'graph.coda.json'
const META_FILE = 'meta.json'
const README_FILE = 'README.md'
const INDEX_FILE = 'index.json'

interface Args {
  root: string
  check: boolean
}

function parseArgs(argv: string[]): Args {
  const rest = argv.filter((arg) => arg !== '--check')
  const root = rest[0]
  if (!root) {
    console.error('usage: zoo-index <path-to-coda-zoo> [--check]')
    process.exit(2)
  }
  return { root: resolve(root), check: argv.includes('--check') }
}

/**
 * When each entry was last touched, from git: slug → ISO 8601.
 *
 * **One `git log` for the whole tree, not one per entry.** Per entry it was a process spawn each,
 * which at a hundred workflows is a hundred forks on every pull request and every weekly drift
 * run. `--name-only` walks the history once and names the files each commit touched, so the
 * first commit to mention a slug is that slug's date.
 *
 * Committer date rather than author date: a rebased or cherry-picked contribution keeps an author
 * date from whenever it was first written, which would sort a workflow that landed today into
 * last spring.
 *
 * An empty map outside a repository — a shallow clone or a tarball is a legitimate way to run
 * this, and an entry with no date is a card without a date rather than a failed build.
 */
function lastCommitDates(root: string): Map<string, string> {
  const dates = new Map<string, string>()
  let log: string
  try {
    log = execFileSync('git', ['log', '--format=@%cI', '--name-only', '--', WORKFLOWS_DIR], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return dates
  }

  // Newest first, so the first date seen for a slug is the one that stands.
  let current = ''
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) {
      current = line.slice(1)
      continue
    }
    const slug = line.split('/')[1]
    if (!slug || !line.startsWith(`${WORKFLOWS_DIR}/`)) continue
    if (!dates.has(slug)) dates.set(slug, current)
  }
  return dates
}

function readJson(path: string): { value?: unknown; error?: string } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { error: (err as Error).message }
  }
  try {
    return { value: JSON.parse(text) }
  } catch (err) {
    return { error: `${path} is not valid JSON: ${(err as Error).message}` }
  }
}

function report(slug: string, problems: ZooProblem[]): void {
  for (const problem of problems) {
    const prefix = problem.level === 'error' ? 'ERROR' : 'warn '
    console.error(`  ${prefix}  ${slug}: ${problem.message}`)
  }
}

/**
 * Render the index.
 *
 * Pretty-printed, except that a `layout` tuple stays on one line. Both halves of that matter:
 * this file is committed, so a diff has to be readable by whoever reviews the pull request, and
 * it is downloaded by every visitor, so `JSON.stringify(…, null, 2)` spending five lines and
 * sixty bytes of indentation on `[476, 80, "neuron.findNeurons"]` is not free. One line per
 * node reads better *and* is smaller — the rare case where there is nothing to trade off.
 *
 * Done by parking the tuples behind a token during serialisation and putting them back after,
 * rather than by hand-writing a renderer for `ZooIndex`: a hand-written one is a second
 * statement of the shape, and it would go quietly out of date the first time a field is added.
 */
function render(index: ZooIndex): string {
  const parked: string[] = []
  const json = JSON.stringify(
    index,
    (_key, value: unknown) => {
      // Depth is what identifies a tuple here: a layout entry is an array whose members are all
      // primitives. `tags` and `requires` are string arrays too, and they read fine on one line
      // as well — so this deliberately catches those, and `workflows` (arrays of objects) not.
      if (
        Array.isArray(value) &&
        value.every((item) => item === null || typeof item !== 'object')
      ) {
        // Joined by hand rather than `JSON.stringify(value)` so the commas get a space after
        // them; a global replace on the serialised form would also hit commas inside strings.
        parked.push(`[${value.map((item) => JSON.stringify(item)).join(', ')}]`)
        return `@@${parked.length - 1}@@`
      }
      return value
    },
    2,
  )
  return `${json.replace(/"@@(\d+)@@"/g, (_match, i: string) => parked[Number(i)]!)}\n`
}

function main(): void {
  const { root, check } = parseArgs(process.argv.slice(2))
  registerBuiltinSources({ mockLatencyMs: 0 })
  const updated = lastCommitDates(root)
  const workflowsRoot = join(root, WORKFLOWS_DIR)

  if (!existsSync(workflowsRoot)) {
    console.error(`No ${WORKFLOWS_DIR}/ directory under ${root}. Is that a Zoo checkout?`)
    process.exit(2)
  }

  const slugs = readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
    .map((item) => item.name)
    .sort()

  const entries: ZooEntry[] = []
  let errors = 0
  let warnings = 0

  for (const slug of slugs) {
    const dir = join(workflowsRoot, slug)
    const graphPath = join(dir, GRAPH_FILE)
    const metaPath = join(dir, META_FILE)
    const readmePath = join(dir, README_FILE)

    if (!existsSync(graphPath) || !existsSync(metaPath)) {
      report(slug, [{ level: 'error', message: `needs both ${GRAPH_FILE} and ${META_FILE}` }])
      errors += 1
      continue
    }

    const meta = readJson(metaPath)
    if (meta.error || !meta.value || typeof meta.value !== 'object') {
      report(slug, [{ level: 'error', message: meta.error ?? `${META_FILE} is not an object` }])
      errors += 1
      continue
    }

    const built = buildEntry({
      slug,
      meta: meta.value,
      graphText: readFileSync(graphPath, 'utf8'),
      // Posix separators regardless of the platform this runs on: these become URL paths.
      graphPath: relative(root, graphPath).split(/[\\/]/).join('/'),
      readmePath: existsSync(readmePath)
        ? relative(root, readmePath).split(/[\\/]/).join('/')
        : undefined,
      updatedAt: updated.get(slug) ?? '',
    })

    report(slug, built.problems)
    errors += built.problems.filter((problem) => problem.level === 'error').length
    warnings += built.problems.filter((problem) => problem.level === 'warning').length
    if (built.entry) entries.push(built.entry)
  }

  if (errors > 0) {
    console.error(
      `\n${errors} error${errors === 1 ? '' : 's'} across ${slugs.length} workflows.`,
    )
    process.exit(1)
  }

  const index: ZooIndex = {
    version: ZOO_INDEX_VERSION,
    // The newest entry's date. Derived, so the file is stable across reruns — see the note above.
    updatedAt:
      entries
        .map((entry) => entry.updatedAt)
        .sort()
        .at(-1) ?? '',
    // Sorted by slug rather than by date: a generated file that every merge reorders produces a
    // diff nobody can read, and the browser sorts for display anyway.
    workflows: entries,
  }

  const rendered = render(index)
  const indexPath = join(root, INDEX_FILE)

  if (check) {
    const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : ''
    if (current !== rendered) {
      console.error(
        `\n${INDEX_FILE} is out of date. Run \`pnpm zoo:index <zoo>\` against a Coda checkout and commit the result.`,
      )
      process.exit(1)
    }
    console.error(
      `${INDEX_FILE} is up to date: ${entries.length} workflows, ${warnings} warnings.`,
    )
    return
  }

  writeFileSync(indexPath, rendered)
  console.error(`Wrote ${INDEX_FILE}: ${entries.length} workflows, ${warnings} warnings.`)
}

main()
