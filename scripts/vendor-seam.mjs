#!/usr/bin/env node
/**
 * Every file Coda vendors from SEAM, checked against SEAM itself.
 *
 *   node scripts/vendor-seam.mjs           # check the vendored copies against SEAM
 *   node scripts/vendor-seam.mjs --write   # re-copy and re-cut them after moving the commit
 *
 * **Two kinds, and the difference is upstream's imports.** `canonical.py`, `scan.py` and
 * `patches.py` are whole-file copies, which is what `VENDORED.md` argues for and what SEAM's
 * invariant 11 is designed to allow: each is numpy-only and can simply be copied. The other two
 * cannot be — `negatives.py` imports `cave`, `paths` and `pre_edit`, and `candidates.py`
 * imports `paths` — so what Coda needs is taken as a *run*, bounded by the markers in `SLICES`.
 *
 * Either way **not a character is edited**, and this script is what makes that claim checkable.
 * A copy that has drifted is the one failure neither repository's tests can see — a window built
 * slightly differently, a feature computed slightly differently, still scores and still ranks.
 *
 * It also checks the sha256 table in `VENDORED.md` against the files on disk. That table is for
 * a reader with no SEAM checkout, and a hand-kept hash would otherwise go stale the first time
 * a copy was refreshed — the manual `shasum` the doc used to prescribe. It is **checked, never
 * rewritten**: the line to paste is printed instead, because a regex that edits the prose is a
 * worse failure than one that reports it. Slices carry no hash, deliberately: theirs would pin
 * one state of a subset of a file, which is a second check that can disagree with this one.
 *
 * **What it does not catch:** a run that acquires a *new* module-level dependency upstream is
 * cut away silently and surfaces as a `NameError` in a browser. `pnpm probe:cutout-summary`'s
 * CPython leg is what notices, because it imports both cut files on their own.
 *
 * The right long-term answer is for SEAM to put each run in a numpy-only module of its own, as
 * the three copies already are; then the slices become ordinary hash-pinned copies and the
 * `SLICES` half of this goes. That ask is in `docs/seam-suggestions-plan.md`.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SEAM = process.env.SEAM_PATH ?? join(homedir(), 'Github/SEAM')
/**
 * The whole files, copied byte for byte — the shape `VENDORED.md` argues every vendored file
 * should have, and the one SEAM's invariant 11 exists to make possible.
 *
 * `patches.py` says so in its own docstring ("Coda's browser scorer vendors it whole"), which is
 * the upstream half of this bargain: the assessor's input is built by one numpy-only function,
 * so training and a browser cut the same 129³ patch or the checkpoint is being fed something it
 * was not trained on. That failure is silent — a patch cut half a voxel over still scores.
 */
const COPIES = [
  { file: 'canonical.py', source: 'seam/canonical.py', what: 'the model input, built one way' },
  { file: 'scan.py', source: 'seam/scan.py', what: 'the windows a surface is tiled into' },
  /*
   * A slice until 2026-11-10, when SEAM moved `summarize_cutout` out of `negatives.py` into a
   * module of its own for exactly this reason — its docstring names this copy. So the check
   * that found the move is the check that stopped needing to make it: this is now an ordinary
   * hash-pinned file, and `SLICES` is down to one.
   */
  {
    file: 'cutout.py',
    source: 'seam/cutout.py',
    what: 'what is in a supervoxel cutout, and the local shape near a point',
  },
  {
    file: 'patches.py',
    source: 'seam/segclr/patches.py',
    what: "the assessor's 129³ patches, and the box labelling under them",
  },
]
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
    file: 'candidates.py',
    source: 'seam/candidates.py',
    from: '\nTIE_SEEDS',
    until: '\ndef placement_tag(',
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
      ['-C', SEAM, 'status', '--porcelain', '--', ...[...COPIES, ...SLICES].map((x) => x.source)],
      { encoding: 'utf8' },
    ).trim()
    return dirty ? `${head} (a vendored source is modified locally)` : head
  } catch {
    return 'unknown'
  }
}

const header = (slice) => `"""Vendored from SEAM: \`${slice.source}\`, ${slice.what}.
**Not edited** — see \`VENDORED.md\` and \`scripts/vendor-seam.mjs\`, which re-cuts
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
  return `${header(slice)}${source.slice(from + 1, until)}`
}

const writing = process.argv.includes('--write')
let differed = 0
/* Hashed as each copy is read, rather than opening every file a second time below. */
const hashes = new Map()

/**
 * The whole-file half: read both, compare, and on `--write` copy.
 *
 * `readFileSync` without an encoding, so the comparison is over bytes rather than over a decoded
 * string — a file that differs only in its line endings or in an invisible byte order mark is a
 * file that differs, and a `utf8` read of both would call those equal.
 */
for (const copy of COPIES) {
  const target = new URL(`../src/pyodide/seam/${copy.file}`, import.meta.url)
  let theirs
  try {
    theirs = readFileSync(join(SEAM, copy.source))
  } catch {
    console.error(`No ${copy.source} at ${SEAM}. Set SEAM_PATH to a checkout of it.`)
    process.exit(2)
  }
  if (writing) {
    writeFileSync(target, theirs)
    hashes.set(copy.file, createHash('sha256').update(theirs).digest('hex'))
    console.log(`Copied src/pyodide/seam/${copy.file} (${theirs.length} bytes).`)
    continue
  }
  let held
  try {
    held = readFileSync(target)
  } catch {
    held = Buffer.alloc(0)
  }
  if (held.equals(theirs)) {
    console.log(`✓ src/pyodide/seam/${copy.file} is SEAM's own file, byte for byte.`)
    hashes.set(copy.file, createHash('sha256').update(held).digest('hex'))
  } else {
    differed += 1
    console.error(
      `✗ src/pyodide/seam/${copy.file} differs from ${copy.source} — ${copy.what}.\n` +
        '  Either SEAM changed (re-copy with --write), or this copy was edited, which it must ' +
        'not be.',
    )
  }
}

/*
 * And the table in VENDORED.md, which is the same claim for a reader with no SEAM checkout.
 * Checked against the files on disk — not against SEAM — so that it says what this repository
 * actually holds even when the two have diverged, and so that the two checks cannot disagree
 * about which thing they are pinning.
 */
const doc = new URL('../src/pyodide/seam/VENDORED.md', import.meta.url)
const prose = readFileSync(doc, 'utf8')
for (const copy of COPIES) {
  const sha = hashes.get(copy.file)
  if (!sha || prose.includes(sha)) continue
  differed += 1
  console.error(
    `✗ VENDORED.md does not carry ${copy.file}'s sha256. The row is:\n` +
      `  | \`${copy.file}\` | \`${sha}\` |`,
  )
}

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
