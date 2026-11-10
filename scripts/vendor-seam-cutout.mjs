#!/usr/bin/env node
/**
 * Cut the runs Coda needs out of SEAM's own modules, byte for byte.
 *
 *   node scripts/vendor-seam-cutout.mjs           # check the vendored copies against SEAM
 *   node scripts/vendor-seam-cutout.mjs --write   # re-cut them after updating the commit
 *
 * **Why slices and not whole-file copies.** `canonical.py` and `scan.py` are byte-identical
 * copies of whole SEAM modules, which is what `VENDORED.md` argues for and what SEAM's
 * invariant 11 is designed to allow. Neither of the two modules here can be one: `negatives.py`
 * imports `cave`, `paths` and `pre_edit`, and `candidates.py` imports `paths`. What Coda needs
 * out of each is numpy, scipy and pandas only, and sits in one contiguous run.
 *
 * So this takes those runs **without editing a character of them**, and this script is what
 * makes that claim checkable — the job the sha256 table in `VENDORED.md` does for a whole file.
 * A copy that has drifted is the one failure neither repository's tests can see.
 *
 * **What it does not catch:** a run that acquires a *new* module-level dependency upstream is
 * cut away silently and surfaces as a `NameError` in a browser. `pnpm probe:cutout-summary`'s
 * CPython leg is what notices, because it imports both cut files on their own.
 *
 * The right long-term answer is for SEAM to put each run in a numpy-only module of its own, as
 * `canonical.py` and `scan.py` already are; then the slices become ordinary hash-pinned copies
 * and this script goes. That ask is in `docs/seam-suggestions-plan.md`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SEAM = process.env.SEAM_PATH ?? join(homedir(), 'Github/SEAM')
/**
 * The runs to take, each named by the markers that bound it rather than by line number.
 *
 * Two of them, and the second is why this is a table: `pool_features` and `GeometricRanker`
 * turn a cutout summary into the eight features a fitted ranker scores, and they drift the same
 * way `summarize_cutout` would — a feature computed slightly differently still *ranks*, which is
 * the failure nothing downstream can see.
 */
const SLICES = [
  {
    file: 'cutout.py',
    source: 'seam/negatives.py',
    from: '\ndef summarize_cutout(',
    until: '\ndef label_final(',
    constants: ['MIN_LOCAL_VOXELS'],
    imports: 'import numpy as np\nimport pandas as pd\n',
    what: 'the two functions that summarise a supervoxel cutout',
    needs: '`cave`, `paths` and `pre_edit`, which reach the network',
    only: 'numpy, scipy and pandas only',
  },
  {
    file: 'candidates.py',
    source: 'seam/candidates.py',
    from: '\nTIE_SEEDS',
    until: '\ndef placement_tag(',
    constants: [],
    imports: 'import dataclasses\n\nimport numpy as np\nimport pandas as pd\n',
    what: "the pool's features and the geometric ranker that scores them",
    needs: '`paths`, which reaches the filesystem',
    only: 'numpy and pandas only',
  },
]

/**
 * Which SEAM the checkout is at, for the message.
 *
 * Printed rather than enforced: the commit belongs in `VENDORED.md` beside the hashes, and a
 * clean ✓ against a dirty or differently-branched checkout would otherwise be indistinguishable
 * from a real one.
 */
function seamCommit() {
  try {
    const head = execFileSync('git', ['-C', SEAM, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const dirty = execFileSync(
      'git',
      ['-C', SEAM, 'status', '--porcelain', '--', ...SLICES.map((one) => one.source)],
      { encoding: 'utf8' },
    ).trim()
    return dirty ? `${head} (a vendored source is modified locally)` : head
  } catch {
    return 'unknown'
  }
}

const header = (slice) => `"""Vendored from SEAM: \`${slice.source}\`, ${slice.what}.
**Not edited** — see \`VENDORED.md\` and \`scripts/vendor-seam-cutout.mjs\`, which re-cuts
this file and byte-compares.

A slice rather than a whole-file copy because that module also imports
${slice.needs}. Everything below is ${slice.only}.
"""

from __future__ import annotations

${slice.imports}
`

function cut(slice) {
  const path = join(SEAM, slice.source)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    console.error(`No SEAM at ${SEAM}. Set SEAM_PATH to a checkout of it.`)
    process.exit(2)
  }
  const from = source.indexOf(slice.from)
  const until = source.indexOf(slice.until, from)
  if (from < 0 || until < 0) {
    console.error(
      `${slice.source} no longer holds the run this takes (${slice.from.trim()} … ` +
        `${slice.until.trim()}). SEAM has moved it; re-read it before re-cutting.`,
    )
    process.exit(2)
  }
  const lines = source.split('\n')
  const taken = slice.constants.map((name) => {
    const line = lines.find((one) => one.startsWith(`${name} =`))
    if (!line) {
      console.error(`${slice.source} no longer defines ${name}.`)
      process.exit(2)
    }
    return line
  })
  const preamble = taken.length > 0 ? `${taken.join('\n')}\n\n` : ''
  return `${header(slice)}${preamble}${source.slice(from + 1, until)}`
}

const writing = process.argv.includes('--write')
let differed = 0
for (const slice of SLICES) {
  const target = new URL(`../src/pyodide/seam/${slice.file}`, import.meta.url)
  const wanted = cut(slice)
  if (writing) {
    writeFileSync(target, wanted)
    console.log(`Re-cut src/pyodide/seam/${slice.file} (${wanted.split('\n').length} lines).`)
    continue
  }
  let held = ''
  try {
    held = readFileSync(target, 'utf8')
  } catch {
    held = ''
  }
  if (held === wanted) {
    console.log(`✓ src/pyodide/seam/${slice.file} is SEAM's own text, unedited.`)
  } else {
    differed += 1
    console.error(
      `✗ src/pyodide/seam/${slice.file} differs from ${slice.source}.\n` +
        '  Either SEAM changed (re-cut with --write), or this copy was edited, which it must ' +
        'not be. Either way re-run `pnpm probe:candidate-search`: a changed feature or summary ' +
        'means the ranker is scoring something it was not fitted on.',
    )
  }
}
console.log(`SEAM ${seamCommit()}`)
if (writing) {
  console.log(
    'Record that commit in VENDORED.md, and run `pnpm probe:cutout-summary` — its CPython leg ' +
      'is what notices a run that has grown a dependency the cut left behind.',
  )
}
if (differed > 0) process.exit(1)
