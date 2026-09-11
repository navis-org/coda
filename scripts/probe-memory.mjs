#!/usr/bin/env node
/**
 * What Chrome's `performance.memory` counts, and what its limit binds. `pnpm probe:memory`.
 *
 * The memory readout (`src/ui/memoryReadout.ts`) and the estimate behind it
 * (`src/core/valueBytes.ts`) rest on three measurements, and none of them can be taken in jsdom,
 * which has no `performance.memory` at all:
 *
 * - `cells`   — bytes per table cell by column shape, as a heap delta over a million cells arriving
 *               through `JSON.parse` (which is how every backend's rows arrive). The model in
 *               `valueBytes.ts` is these numbers.
 * - `buffers` — whether typed arrays are held to `jsHeapSizeLimit`. They are not: they count
 *               towards `usedJSHeapSize` and go past the limit without complaint, which is why the
 *               readout's share subtracts them.
 * - `ceiling` — what happens when ordinary objects reach the limit, which is the sentence the
 *               dialog says about it.
 *
 * Served from a local http origin rather than `about:blank`, deliberately: on `about:blank` the
 * figure does not move at all, and a probe run there concludes the API reports nothing.
 *
 *   pnpm probe:memory             # all three
 *   pnpm probe:memory -- cells
 *
 * Chrome is launched with its default flags — `--enable-precise-memory-info` was measured to
 * change nothing, so what this reads is what a visitor's browser reads.
 */

import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome } from './lib/browserProbe.mjs'

const MB = 1024 * 1024
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const modes = wanted.length > 0 ? wanted : ['cells', 'buffers', 'ceiling']

const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>memory probe</title>')
}).listen(0)
const url = `http://localhost:${server.address().port}/`

/** A fresh browser per mode: the ceiling crashes its tab, and a delta wants nothing left over. */
async function page(mode, port) {
  const probe = await launchChrome({ port, profile: `/tmp/coda-probe-memory-${mode}` })
  await probe.send('Page.navigate', { url })
  await probe.waitFor(`document.title === 'memory probe'`, 'the probe page')
  return probe
}

const used = (evaluate) => evaluate('performance.memory.usedJSHeapSize')

async function cells() {
  const { evaluate } = await page('cells', 9441)
  const N = 1_000_000
  const cases = {
    'integers below 2^30': `i`,
    'doubles': `i + 0.5`,
    'doubles, one null in four': `i % 4 ? i + 0.5 : null`,
    '18-digit ids as text': `String(720575940000000000n + BigInt(i))`,
    'three type names, repeated': `['LC4', 'LC6', 'T4a'][i % 3]`,
    'three long names, repeated': `['LC4_left_lobula_col', 'LC6_right_lobula', 'T4a_medulla_l10'][i % 3]`,
  }
  console.log('Bytes per cell, JSON.parse of a million:')
  for (const [label, cell] of Object.entries(cases)) {
    await evaluate(`window.__text = JSON.stringify(Array.from({ length: ${N} }, (_, i) => ${cell})); true`)
    // Settled either side, so a collection in between does not credit one case with the last's garbage.
    await sleep(3000)
    const before = await used(evaluate)
    await evaluate(`window[${JSON.stringify(label)}] = JSON.parse(window.__text); window.__text = null; true`)
    await sleep(3000)
    const after = await used(evaluate)
    console.log(`  ${label.padEnd(30)} ${((after - before) / N).toFixed(1)} B`)
  }
}

async function buffers() {
  const { evaluate } = await page('buffers', 9442)
  const limit = await evaluate('performance.memory.jsHeapSizeLimit')
  console.log(`Typed arrays against a ${(limit / MB).toFixed(0)} MB limit, 512 MB at a time:`)
  await evaluate('window.bufs = []; true')
  for (let i = 1; i <= 12; i++) {
    const outcome = await evaluate(`(() => {
      try { const b = new Float32Array(128 * 1024 * 1024); b.fill(1); window.bufs.push(b); return 'ok' }
      catch (e) { return String(e) }
    })()`)
    const u = await used(evaluate)
    console.log(`  ${String(i * 512).padStart(5)} MB  ${outcome.padEnd(10)} used ${(u / MB).toFixed(0)} MB (${((u / limit) * 100).toFixed(0)}% of limit)`)
    if (outcome !== 'ok') break
  }
}

async function ceiling() {
  const { evaluate } = await page('ceiling', 9443)
  const limit = await evaluate('performance.memory.jsHeapSizeLimit')
  console.log(`Plain arrays of doubles against a ${(limit / MB).toFixed(0)} MB limit, 256 MB at a time:`)
  await evaluate('window.arrs = []; true')
  let last = 0
  for (let i = 1; i <= 40; i++) {
    // A crashed renderer never answers, so each step races a timeout rather than hanging the probe.
    const step = evaluate(`(() => {
      try { const a = new Array(32 * 1024 * 1024).fill(0.5); window.arrs.push(a); return 'ok' }
      catch (e) { return String(e) }
    })()`).then(
      (outcome) => outcome,
      (error) => `threw: ${String(error.message ?? error).slice(0, 80)}`,
    )
    const outcome = await Promise.race([step, sleep(30_000).then(() => 'no answer (tab gone)')])
    if (outcome !== 'ok') {
      console.log(`  after ${(last / MB).toFixed(0)} MB used (${((last / limit) * 100).toFixed(0)}% of limit): ${outcome}`)
      return
    }
    last = await Promise.race([used(evaluate), sleep(10_000).then(() => last)])
    console.log(`  ${String(i * 256).padStart(5)} MB  used ${(last / MB).toFixed(0)} MB (${((last / limit) * 100).toFixed(0)}% of limit)`)
  }
}

const RUN = { cells, buffers, ceiling }
for (const mode of modes) {
  if (!RUN[mode]) {
    console.error(`No mode "${mode}". Try: ${Object.keys(RUN).join(', ')}`)
    process.exit(2)
  }
  await RUN[mode]()
}
process.exit(0)
