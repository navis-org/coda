/**
 * `pnpm probe:abf <file.abf>`: read a recording with Coda's reader, write what it read — the
 * summary, every channel and command of every sweep — and run `probe-abf.py` to hold it against
 * pyABF (`PYTHON=…` for an interpreter that has it). The file is never copied anywhere; pass a path to one of your own.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { readRecording } from '../src/data/ephys/recording'

const path = process.argv[2]
if (!path) throw new Error('Usage: pnpm probe:abf <file.abf>')
const bytes = readFileSync(path)
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const t0 = performance.now()
const rec = await readRecording(buffer, path)
const { summary } = rec
const channels = summary.channels.map((_, c) =>
  Array.from({ length: summary.sweeps }, (_, s) => Array.from(rec.channel(c, s))),
)
const commands = summary.commands.map((_, d) =>
  Array.from({ length: summary.sweeps }, (_, s) =>
    Array.from(rec.command(d, s), (v) => (Number.isNaN(v) ? null : v)),
  ),
)
const ms = performance.now() - t0
writeFileSync('/tmp/coda-abf-probe.json', JSON.stringify({ summary, channels, commands, ms }))
// The Python half: any interpreter with pyABF, `PYTHON` to name one.
execFileSync(process.env.PYTHON ?? 'python3', ['scripts/probe-abf.py', path], { stdio: 'inherit' })
