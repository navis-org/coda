#!/usr/bin/env node
/**
 * Cut `summarize_cutout` and its helper out of SEAM's `negatives.py`, byte for byte.
 *
 *   node scripts/vendor-seam-cutout.mjs           # check the vendored copy against SEAM
 *   node scripts/vendor-seam-cutout.mjs --write   # re-cut it after updating the commit
 *
 * **Why a slice and not a whole-file copy.** `canonical.py` and `scan.py` are byte-identical
 * copies of whole SEAM modules, which is what `VENDORED.md` argues for and what SEAM's
 * invariant 11 is designed to allow. `negatives.py` cannot be one: it imports `cave`, `paths`
 * and `pre_edit`, which reach the network. The two functions Coda needs out of it are numpy and
 * scipy only, and sit in one contiguous run of the file.
 *
 * So this takes that run **without editing a character of it**, and this script is what makes
 * that claim checkable — the same job the sha256 table in `VENDORED.md` does for a whole file.
 * A copy that has drifted is the one failure neither repository's tests can see.
 *
 * The right long-term answer is for SEAM to put these two functions in a numpy-only module of
 * their own, as `canonical.py` and `scan.py` already are; then this script goes and the file
 * joins the sha256 table. That ask is recorded in `docs/seam-suggestions-plan.md`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SEAM = process.env.SEAM_PATH ?? join(homedir(), 'Github/SEAM')
const SOURCE = join(SEAM, 'seam/negatives.py')
const TARGET = new URL('../src/pyodide/seam/cutout.py', import.meta.url)

/** The run to take, named by the markers that bound it rather than by line number. */
const FROM = '\ndef summarize_cutout('
const UNTIL = '\ndef label_final('
/** Constants the run reads from its module's top level, taken with it. */
const CONSTANTS = ['MIN_LOCAL_VOXELS']

const HEADER = `"""Vendored from SEAM: \`seam/negatives.py\`, the two functions that summarise a
supervoxel cutout. **Not edited** — see \`VENDORED.md\` and
\`scripts/vendor-seam-cutout.mjs\`, which re-cuts this file and byte-compares it.

A slice rather than a whole-file copy because \`negatives.py\` also imports
\`cave\`, \`paths\` and \`pre_edit\`, which reach the network. Everything below
is numpy, scipy and pandas only.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

`

function cut() {
  let source
  try {
    source = readFileSync(SOURCE, 'utf8')
  } catch {
    console.error(`No SEAM at ${SEAM}. Set SEAM_PATH to a checkout of it.`)
    process.exit(2)
  }
  const from = source.indexOf(FROM)
  const until = source.indexOf(UNTIL, from)
  if (from < 0 || until < 0) {
    console.error(
      `negatives.py no longer holds the run this takes (${FROM.trim()} … ${UNTIL.trim()}). ` +
        'SEAM has moved these functions; re-read it before re-cutting.',
    )
    process.exit(2)
  }
  const taken = []
  for (const name of CONSTANTS) {
    const line = source.split('\n').find((one) => one.startsWith(`${name} =`))
    if (!line) {
      console.error(`negatives.py no longer defines ${name}.`)
      process.exit(2)
    }
    taken.push(line)
  }
  return `${HEADER}${taken.join('\n')}\n\n${source.slice(from + 1, until)}`
}

const wanted = cut()
if (process.argv.includes('--write')) {
  writeFileSync(TARGET, wanted)
  console.log(`Re-cut ${TARGET.pathname} from ${SOURCE} (${wanted.split('\n').length} lines).`)
} else {
  const held = readFileSync(TARGET, 'utf8')
  if (held === wanted) {
    console.log(`✓ src/pyodide/seam/cutout.py is SEAM's own text, unedited.`)
  } else {
    console.error(
      `✗ src/pyodide/seam/cutout.py differs from ${SOURCE}.\n` +
        '  Either SEAM changed (re-cut with --write, and re-run the probes: a changed summary ' +
        'means the ranker was fitted on different features), or this copy was edited, which it ' +
        'must not be.',
    )
    process.exit(1)
  }
}
