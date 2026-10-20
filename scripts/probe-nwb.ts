/**
 * `pnpm probe:nwb <file.nwb>`: read every group of an NWB file with Coda's reader, write what it
 * read — each group's summary, every channel and command of every sweep — and run `probe-nwb.py`
 * to hold it against pynwb (`PYTHON=…` for an interpreter that has it). The file is never copied
 * anywhere; pass a path to one of your own or one downloaded from DANDI.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { readRecording } from '../src/data/ephys/recording'

const path = process.argv[2]
if (!path) throw new Error('Usage: pnpm probe:nwb <file.nwb>')
const bytes = readFileSync(path)
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const t0 = performance.now()
const first = await readRecording(buffer, path)
const names = (first.summary.protocols ?? [first.summary]).map((s) => s.protocol)
const groups = []
for (const name of names) {
  const rec = await readRecording(buffer, path, first.summary.protocols ? name : undefined)
  const { summary } = rec
  const sweeps = Array.from({ length: summary.sweeps }, (_, s) => s)
  groups.push({
    summary: { ...summary, protocols: undefined },
    channels: sweeps.map((s) => Array.from(rec.channel(0, s))),
    commands: summary.commands.length
      ? sweeps.map((s) => Array.from(rec.command(0, s), (v) => (Number.isNaN(v) ? null : v)))
      : [],
  })
}
const ms = performance.now() - t0
writeFileSync('/tmp/coda-nwb-probe.json', JSON.stringify({ groups, ms }))
// The Python half: any interpreter with pynwb, `PYTHON` to name one.
execFileSync(process.env.PYTHON ?? 'python3', ['scripts/probe-nwb.py', path], { stdio: 'inherit' })
