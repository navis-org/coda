/**
 * The half of a browser probe that is not about the thing being probed.
 *
 * jsdom performs no layout and has no WebGL, so anything in this repo that is about pixels has to
 * be measured in a real browser. Each such probe needs the same handful of things before it can
 * measure anything: find Chrome, start it headless with a device profile, attach to the DevTools
 * protocol, evaluate expressions in the page, poll until something appears, keep a screenshot, and
 * exit on a tally of failures. Only the measurements and the assertions differ, and those stay in
 * the scripts.
 *
 * It exists for the reason `pyodideProbe.mjs` gives about itself: the second one was written by
 * copying the first. That copy had already diverged before this was written — the two `waitFor`
 * loops polled a different number of times, and only one of them killed Chrome on the way out of a
 * *failing* run, which is why the other's next run silently attached to the previous run's browser
 * and measured the state that run had left. Both notes were earned once and one file had them.
 *
 * What deliberately does **not** live here is anything about Coda's own shell — dismissing the
 * launch sequence, finding a card, reading a toolbar. Those are facts about the app that each
 * probe states for itself, and a shared version would be a second place for a class rename to
 * break a probe nobody is running.
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Launch headless Chrome and attach to its first page.
 *
 * `profile` is wiped first and the browser is killed on **any** exit, including a throw. Both
 * halves matter together: the launch sequence, the autosave and the open-document set all persist
 * per profile, so a run that leaves Chrome alive leaves the profile locked *and* the debugging
 * port taken — and the next run's `rmSync` then deletes files under a live browser while
 * `firstPage` attaches to the old one. That failure presents as the *next* probe measuring
 * something impossible, which is a bad afternoon.
 */
export async function launchChrome({ port, profile, width = 1600, height = 1000, dpr = 1 }) {
  if (!existsSync(CHROME)) {
    console.error(`No Chrome at ${CHROME}. Set CHROME_PATH.`)
    process.exit(2)
  }
  rmSync(profile, { recursive: true, force: true })

  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      '--headless=new',
      '--no-first-run',
      `--window-size=${width},${height}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const bye = () => {
    try {
      chrome.kill()
    } catch {
      // Already gone.
    }
  }
  process.on('exit', bye)
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (error) => {
      console.error(error)
      process.exit(1)
    })
  }

  const page = await firstPage(port)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  let nextId = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const settle = pending.get(message.id)
    if (settle) {
      pending.delete(message.id)
      settle(message)
    }
  }

  /** One DevTools command. Resolves with the whole reply, errors included. */
  const send = (method, params = {}) => {
    const id = ++nextId
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve) => pending.set(id, resolve))
  }

  /** Evaluate in the page and get the value back. Throws what the page threw. */
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    const failed = reply.result?.exceptionDetails
    if (failed) throw new Error(failed.exception?.description ?? failed.text)
    return reply.result?.result?.value
  }

  /**
   * Poll an expression until it answers truthily.
   *
   * Beats a fixed sleep on both ends: a fast machine does not wait, a slow one is not measured
   * half-built. `what` is the sentence the timeout throws, so make it name the thing waited for.
   */
  const waitFor = async (expression, what, { tries = 150, every = 100 } = {}) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(expression)) return
      await sleep(every)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  /** Write a PNG into the temp dir — never the working directory, which is the repo root. */
  const screenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const file = join(tmpdir(), `${name}.png`)
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    return file
  }

  /**
   * Tell the page it is a device of this size.
   *
   * Separate from the launch so one browser can walk several devices, which is what
   * `probe-mobile.mjs` does and what the numbers in its header were taken with. `mobile` is
   * derived from the width against the same 744 threshold the tablet control sits above.
   */
  const setDevice = (w, h, scale = 1) =>
    send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: scale,
      mobile: w < 744,
      screenWidth: w,
      screenHeight: h,
    })

  await send('Page.enable')
  await send('Runtime.enable')
  await setDevice(width, height, dpr)

  return {
    send,
    evaluate,
    waitFor,
    screenshot,
    setDevice,
    close() {
      ws.close()
      bye()
    },
  }
}

/** The DevTools page target, once Chrome is listening. */
async function firstPage(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  throw new Error('Chrome never opened a page target')
}

/** `--url`, `--keep` and friends, spelled once. */
export function probeArgs(argv = process.argv.slice(2)) {
  return {
    all: argv,
    keep: argv.includes('--keep'),
    value(flag) {
      const at = argv.indexOf(flag)
      return at >= 0 ? argv[at + 1] : undefined
    },
  }
}

/**
 * A pass/fail tally that exits non-zero, so a probe can be a check and not only a reading.
 *
 * `pyodideProbe.mjs` has its own `probeReport` rather than sharing this one: its `finish` prints a
 * Pyodide heap figure, which is a fact about that runtime and not about a browser.
 */
export function probeReport() {
  let failures = 0
  return {
    check(ok, line) {
      if (!ok) failures++
      console.log(`${ok ? '✓' : '✗'} ${line}`)
    },
    get failures() {
      return failures
    },
    finish(note) {
      if (failures === 0) return
      console.error(`\n${failures} propert${failures === 1 ? 'y' : 'ies'} failed.${note ? ` ${note}` : ''}`)
      process.exit(1)
    },
  }
}
