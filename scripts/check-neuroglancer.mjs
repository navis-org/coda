/**
 * Is the bundled neuroglancer still the tip of Spelunker? Flagged as an issue when it is not.
 *
 * `neuroglancer.html` bundles Spelunker, `seung-lab/neuroglancer`'s `spelunker` branch, built into
 * `vendor/neuroglancer.tgz` by `scripts/build-neuroglancer.mjs`; `vendor/neuroglancer.json` records
 * the commit. Nothing else would notice when that branch moves on, so `.github/workflows/
 * neuroglancer-freshness.yml` runs this weekly.
 *
 * The branch is **rebased**, not appended to: CAVE's commits are replayed onto Google's master, so
 * every commit gets a new sha and one committer date. A count of commits behind therefore means
 * nothing after a rebase, and this compares the tip with the pinned commit and reports the tip's date
 * and newest commit messages instead.
 *
 * It flags rather than updates, because the update is a person's job: the build runs neuroglancer's
 * own toolchain, and the result wants `pnpm probe:neuroglancer-select` and a CAVE dataset checked by
 * hand before it ships. So: one issue, found again by a marker in its body, updated only when the
 * tip moves, and closed with a comment once the bundle matches the tip again.
 *
 *   node scripts/check-neuroglancer.mjs              # in Actions: GITHUB_TOKEN, GITHUB_REPOSITORY
 *   node scripts/check-neuroglancer.mjs --dry-run    # print what it would do, touch no issue
 *
 * Needs nothing installed: Node's own `fetch`, and the GitHub REST API.
 */
import { readFileSync } from 'node:fs'

const UPSTREAM = 'seung-lab/neuroglancer'
const BRANCH = 'spelunker'
/** How the issue is found again; the tip it describes rides on it, so a re-run with no move is silent. */
const MARKER = 'coda:spelunker-freshness'
const TITLE = 'Bundled Spelunker is behind the spelunker branch'
/** The newest commits listed in the issue: enough to judge whether an update is worth it. */
const LISTED = 15

const dryRun = process.argv.includes('--dry-run')
const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY ?? 'navis-org/coda'

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

const pinned = JSON.parse(readFileSync(new URL('../vendor/neuroglancer.json', import.meta.url), 'utf8'))
const branch = await github(`repos/${UPSTREAM}/branches/${BRANCH}`)
const tip = { sha: branch.commit.sha, date: branch.commit.commit.committer.date }

const open = (await github(`repos/${repo}/issues?state=open&per_page=100`)).filter(
  (issue) => !issue.pull_request && issue.body?.includes(`<!-- ${MARKER}`),
)

if (tip.sha === pinned.commit) {
  console.log(`Up to date: the bundle is ${BRANCH}'s tip, ${tip.sha.slice(0, 12)} (${tip.date}).`)
  for (const issue of open) {
    console.log(`Closing #${issue.number}: the bundle matches the tip again.`)
    if (dryRun) continue
    await github(`repos/${repo}/issues/${issue.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body: `The bundle is ${BRANCH}'s tip again (\`${tip.sha.slice(0, 12)}\`), so closing.`,
      }),
    })
    await github(`repos/${repo}/issues/${issue.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    })
  }
  process.exit(0)
}

// What the tip has that the bundle does not: counted by the comparison, and listed from the
// branch's own history, newest first, down to the bundled commit. Not from the comparison's list,
// which stops at 250 commits counted from the oldest — a rebase onto months of Google's master
// passes that, and its "newest" would then be old ones. After a rebase none of the tip's commits is
// the bundled one, so the list simply stops at LISTED.
const compare = await github(`repos/${UPSTREAM}/compare/${pinned.commit}...${tip.sha}`)
const history = await github(`repos/${UPSTREAM}/commits?sha=${tip.sha}&per_page=${LISTED}`)
const until = history.findIndex((c) => c.sha === pinned.commit)
const newest = until === -1 ? history : history.slice(0, until)
const relation =
  compare.status === 'ahead'
    ? `${compare.ahead_by} new commit${compare.ahead_by === 1 ? '' : 's'} on top of the bundled one`
    : compare.status === 'diverged'
      ? 'rebased since the bundle was built (so a commit count says nothing)'
      : compare.status

const body = `<!-- ${MARKER} tip=${tip.sha} -->
\`${BRANCH}\` on [${UPSTREAM}](https://github.com/${UPSTREAM}/tree/${BRANCH}) has moved on from the neuroglancer bundled in \`vendor/neuroglancer.tgz\`: ${relation}.

| | Commit | Committed |
| --- | --- | --- |
| Bundled | [\`${pinned.commit.slice(0, 12)}\`](https://github.com/${UPSTREAM}/commit/${pinned.commit}) | ${pinned.committed} |
| Tip | [\`${tip.sha.slice(0, 12)}\`](https://github.com/${UPSTREAM}/commit/${tip.sha}) | ${tip.date} |

Newest commits on the tip that the bundle does not have:

${newest.map((c) => `- [\`${c.sha.slice(0, 8)}\`](${c.html_url}) ${c.commit.message.split('\n')[0]}`).join('\n')}
${compare.ahead_by > newest.length ? `\n…and ${compare.ahead_by - newest.length} more. [Full comparison](${compare.html_url}).\n` : ''}
### Updating

1. \`node scripts/build-neuroglancer.mjs\` — builds the tip into \`vendor/\`.
2. \`pnpm install\`, then \`pnpm dev --force\` once: a dependency cache built before the update can serve the old copy.
3. \`pnpm probe:neuroglancer-select\` with a neuPrint token, and open a CAVE dataset by hand (sign-in, segmentation, a double-click into Selected).

This issue is updated when the tip moves again and closed once the bundle matches it. Raised by \`scripts/check-neuroglancer.mjs\` (\`.github/workflows/neuroglancer-freshness.yml\`).
`

const current = open[0]
if (current?.body?.includes(`tip=${tip.sha}`)) {
  console.log(`Behind, already flagged for this tip in #${current.number}.`)
} else if (current) {
  console.log(`Behind; the tip moved again, updating #${current.number}.`)
  if (!dryRun) {
    await github(`repos/${repo}/issues/${current.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    })
  }
} else {
  console.log(`Behind; opening an issue.`)
  if (!dryRun) {
    const created = await github(`repos/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: TITLE, body }),
    })
    console.log(`Opened #${created.number}.`)
  }
}
if (dryRun) console.log(`\n--- issue body ---\n${body}`)
