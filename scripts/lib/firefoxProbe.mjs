/**
 * Firefox for a browser probe, over WebDriver BiDi — the half `browserProbe.mjs` has for Chrome.
 *
 * Every other probe here speaks CDP, which only Chrome answers, so a finding about "the browser"
 * rested on Chrome alone. The one that needed Firefox was the assessor: 27 ms a patch in Chrome
 * against 98 in Firefox, put down to "Chrome is more optimised" because nothing could look
 * inside Firefox. Looking showed something else entirely — every wait for the GPU there costs
 * ~100 ms whatever the work (`docs/seam-assessor-speed.md` §16).
 *
 * BiDi needs no package: Firefox serves it on `--remote-debugging-port`, and Node's own
 * `WebSocket` speaks it. The shape returned is the part of `launchChrome`'s a probe needs to
 * drive either browser — `evaluate`, `callFunction`, `waitFor`, `navigate`, `reload`, `close` —
 * and `launchBrowser` picks one by name.
 *
 * ## What is easy to get wrong
 *
 * - **Headless Firefox offers no WebGPU adapter** (Firefox 160, macOS): `requestAdapter()`
 *   answers null. A GPU probe passes `headful`, and a window opens for the length of the run.
 * - **The "listening" line is on stdout**, not stderr, so a launcher watching only stderr waits
 *   forever.
 * - **Kill the process group, not the process.** Firefox starts a tree of content and GPU
 *   processes; killing the parent alone left one holding the debugging port, and the next run
 *   failed to listen ("NS_ERROR_SOCKET_ADDRESS_IN_USE").
 * - **`performance.now()` is coarsened to 1 ms** in a page that is not cross-origin isolated, so
 *   time sub-millisecond work in batches.
 * - `script.evaluate` hands back a serialised remote value, not JSON; a page script that returns
 *   `JSON.stringify(...)` gets a plain string back.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { killOnExit, launchChrome, pollUntil } from './browserProbe.mjs'

const FIREFOX = process.env.FIREFOX_PATH ?? '/Applications/Firefox.app/Contents/MacOS/firefox'

/** Prefs for a run nobody is sitting at: no first-run pages, no default-browser question. */
const PREFS = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'browser.startup.homepage_override.mstone': 'ignore',
}

/**
 * Launch Firefox on a wiped profile and attach to its first tab.
 *
 * Killed on any exit, as `launchChrome` is, and for the same reason: a browser left alive keeps
 * the port, and the next run attaches to it or fails to listen.
 */
export async function launchFirefox({ port, profile, headful = false }) {
  if (!existsSync(FIREFOX)) {
    console.error(`No Firefox at ${FIREFOX}. Set FIREFOX_PATH.`)
    process.exit(2)
  }
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'user.js'),
    Object.entries(PREFS)
      .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
      .join('\n'),
  )
  const firefox = spawn(
    FIREFOX,
    [
      '-no-remote',
      '-profile',
      profile,
      '--remote-debugging-port',
      String(port),
      ...(headful ? [] : ['--headless']),
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  const bye = killOnExit(() => process.kill(-firefox.pid, 'SIGKILL'))

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox never started WebDriver BiDi')), 30_000)
    const watch = (data) => {
      if (String(data).includes('WebDriver BiDi listening')) {
        clearTimeout(timer)
        resolve()
      }
    }
    firefox.stdout.on('data', watch)
    firefox.stderr.on('data', watch)
  })

  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  // A crash or a closed connection fails every command still waiting, rather than hanging the
  // probe until somebody kills it.
  ws.onclose = () => {
    for (const settle of pending.values()) {
      settle({ type: 'error', error: 'closed', message: 'the connection to Firefox closed' })
    }
    pending.clear()
  }
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const settle = message.id == null ? undefined : pending.get(message.id)
    if (settle) {
      pending.delete(message.id)
      settle(message)
    }
  }
  /** One BiDi command. Throws what the protocol refused. */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, (message) =>
        message.type === 'error'
          ? reject(new Error(`${method}: ${message.error}: ${message.message}`))
          : resolve(message.result),
      )
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('session.new', { capabilities: {} })
  const { contexts } = await send('browsingContext.getTree', {})
  const context = contexts[0].context

  /**
   * Evaluate in the page and get the value back — primitives only, so return a string (JSON)
   * for anything larger. Throws what the page threw. BiDi has no evaluation timeout, so the
   * second argument `launchChrome`'s takes is accepted and ignored.
   */
  const evaluate = async (expression) => {
    const reply = await send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
    })
    if (reply.type === 'exception') {
      throw new Error(`the page threw: ${reply.exceptionDetails?.text ?? 'an exception'}`)
    }
    return reply.result?.value
  }

  const waitFor = (expression, what, options) => pollUntil(evaluate, expression, what, options)

  /**
   * Call a page-side function, given as source, with string arguments — for a credential, which
   * goes in as an argument and never into an expression, a log or a file.
   */
  const callFunction = async (source, ...values) => {
    const reply = await send('script.callFunction', {
      functionDeclaration: source,
      arguments: values.map((value) => ({ type: 'string', value })),
      target: { context },
      awaitPromise: true,
    })
    if (reply.type === 'exception') throw new Error('the page threw')
    return reply.result?.value
  }

  const navigate = (url) => send('browsingContext.navigate', { context, url, wait: 'complete' })
  const reload = () => send('browsingContext.reload', { context, wait: 'complete' })

  const close = () => {
    try {
      ws.close()
    } catch {
      // Already closed.
    }
    bye()
  }

  return { evaluate, callFunction, waitFor, navigate, reload, close }
}

/**
 * Either browser by name, with what a GPU probe needs: Chrome on Metal (headless Chrome falls
 * back to SwiftShader otherwise), Firefox with a window (headless, it offers no WebGPU adapter).
 * Both answer `evaluate(expression, timeout)`, `callFunction`, `waitFor`, `navigate`, `reload`
 * and `close`.
 */
export function launchBrowser(name, { port, profile }) {
  if (name === 'firefox') return launchFirefox({ port, profile, headful: true })
  if (name === 'chrome') {
    return launchChrome({
      port,
      profile,
      args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
    })
  }
  console.error(`No browser called ${name}: chrome or firefox`)
  process.exit(2)
}
