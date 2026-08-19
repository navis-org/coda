/**
 * Connection settings for remote data sources.
 *
 * Exists because neuPrint needs two things Coda cannot infer: a token, and a same-origin
 * URL to reach it through. Both are per-machine, neither belongs in a saved graph, so this
 * is the one piece of app state that lives outside the document.
 *
 * It opens itself on an auth failure. A 401 surfaced only as red text on a node is a dead
 * end — the fix is a token, and the token field should be in front of you when you learn
 * that. Subscribing to the failure channel rather than sniffing error messages keeps that
 * working when the message text changes.
 *
 * One tab per source, from `SOURCE_TABS` rather than a switch: a backend is added by
 * implementing `DataSource`, and its settings should arrive the same way — as an entry.
 * Stacked sections were fine at two and stop being fine at four, where the one you came to
 * configure is below the fold behind sources you have never used.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { fetchDatasets } from '../../data/neuprint/client'
import {
  DEFAULT_BASE_URL,
  forgetToken,
  getBaseUrl,
  getToken,
  setBaseUrl,
  setToken,
  subscribeAuthFailure,
} from '../../data/neuprint/credentials'
import { getSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { errorMessage } from '../../core/errors'

type Probe =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; datasets: number; names: string[] }
  | { state: 'failed'; message: string }

/**
 * What every tab is handed. A source needing no credentials ignores it — the alternative,
 * a per-tab prop type, buys nothing while there is one credentialed source and costs the
 * uniform registry above.
 */
interface SourceTabProps {
  token: string
  server: string
  probe: Probe
  onToken: (value: string) => void
  onServer: (value: string) => void
  onTest: () => void
  onSave: () => void
  onForget: () => void
}

interface SourceTab {
  id: string
  label: string
  render: (props: SourceTabProps) => ReactNode
}

// A non-empty tuple, so the fallback below is a `SourceTab` rather than possibly undefined.
const SOURCE_TABS: readonly [SourceTab, ...SourceTab[]] = [
  { id: 'neuprint', label: 'neuPrint', render: (props) => <NeuPrintTab {...props} /> },
  { id: 'mock', label: 'Mock connectome', render: () => <MockTab /> },
]

/**
 * The tab the auth-failure channel is about. That channel carries a message and no source
 * id — it lives in `neuprint/credentials` — so the mapping is stated here rather than
 * guessed at from the text of the failure.
 */
const AUTH_FAILURE_TAB = 'neuprint'

export function SourcesPanel() {
  const [open, setOpen] = useState(false)
  const [token, setTokenField] = useState(() => getToken() ?? '')
  const [server, setServerField] = useState(() => getBaseUrl())
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const [reason, setReason] = useState<string | undefined>(undefined)
  const notify = useGraphStore((s) => s.setNotice)

  // The store outlives this component, but the failure channel does not replay — a
  // subscription started at mount only ever sees failures from now on, which is what we
  // want. Without the open-guard a second failure while open would re-run the effect.
  useEffect(
    () =>
      subscribeAuthFailure((message) => {
        setReason(message)
        setOpen(true)
      }),
    [],
  )

  useEffect(() => {
    if (!open) return
    setTokenField(getToken() ?? '')
    setServerField(getBaseUrl())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const test = useCallback(async () => {
    setProbe({ state: 'testing' })
    try {
      // Tested with the values in the fields, not the stored ones — otherwise you cannot
      // check a token before committing to it.
      const raw = await fetchDatasets({
        token: token.trim().replace(/^Bearer\s+/i, ''),
        baseUrl: server.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
      })
      const names = Object.keys(raw).sort()
      setProbe({ state: 'ok', datasets: names.length, names: names.slice(0, 6) })
    } catch (error) {
      setProbe({
        state: 'failed',
        message: errorMessage(error),
      })
    }
  }, [token, server])

  const save = useCallback(() => {
    setToken(token)
    setBaseUrl(server)
    setReason(undefined)
    // Re-list so the dataset picker and the ROI/status enums populate without a reload.
    void getSource('neuprint')
      ?.listDatasets()
      .then((datasets) => notify(`neuPrint connected — ${datasets.length} datasets`))
      .catch(() => undefined)
    setOpen(false)
  }, [token, server, notify])

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setOpen(true)}
        title="Data sources and credentials"
      >
        Sources
      </button>
      {open && (
        <Dialog
          onClose={() => setOpen(false)}
          reason={reason}
          token={token}
          server={server}
          probe={probe}
          onToken={setTokenField}
          onServer={setServerField}
          onTest={() => void test()}
          onSave={save}
          onForget={() => {
            forgetToken()
            setTokenField('')
            setProbe({ state: 'idle' })
          }}
        />
      )}
    </>
  )
}

interface DialogProps extends SourceTabProps {
  onClose: () => void
  reason: string | undefined
}

function Dialog({ onClose, reason, ...tabProps }: DialogProps) {
  // Tab state lives here rather than in `SourcesPanel` because the dialog is unmounted when
  // closed, so every opening starts on the source you are most likely to have come for.
  const [tabId, setTabId] = useState(reason ? AUTH_FAILURE_TAB : SOURCE_TABS[0].id)
  const active = SOURCE_TABS.find((tab) => tab.id === tabId) ?? SOURCE_TABS[0]

  // A failure arriving while the dialog is already open would otherwise leave the reason
  // stated above a tab that has nothing to do with it.
  useEffect(() => {
    if (reason) setTabId(AUTH_FAILURE_TAB)
  }, [reason])

  return (
    <div className="overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="overlay__panel sources"
        role="dialog"
        aria-modal="true"
        aria-label="Data sources"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sources__header">
          <h2>Data sources</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {reason && <p className="sources__alert">{reason}</p>}

        {/*
         * Said once, at the top, rather than per source: a credential is being asked for and
         * the honest answer to "where does this go?" is short. The clause about the proxy is
         * not a hedge — the request really is relayed by whatever serves this page, and a
         * flat "never leaves your browser" would be the one part of this that is untrue.
         */}
        <p className="sources__privacy">
          <strong>Credentials stay in this browser.</strong> Tokens are held in this
          browser&rsquo;s local storage on this machine only. They are never written into a
          saved graph or an export, never sent to us, and never shared with any third party —
          they go only to the service they authenticate, through the same-origin proxy that
          request has to travel through.
        </p>

        <div className="sources__tabs" role="tablist" aria-label="Data sources">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="sources__tab"
              aria-selected={tab.id === active.id}
              onClick={() => setTabId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Keyed by tab so switching remounts — which is what re-runs the token field's focus. */}
        <div
          key={active.id}
          className="sources__body"
          role="tabpanel"
          aria-label={active.label}
        >
          {active.render(tabProps)}
        </div>
      </div>
    </div>
  )
}

function NeuPrintTab({
  token,
  server,
  probe,
  onToken,
  onServer,
  onTest,
  onSave,
  onForget,
}: SourceTabProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => fieldRef.current?.focus(), [])

  return (
    <section className="sources__source">
      <p className="sources__note">
        Janelia&rsquo;s connectome server. Get a token from{' '}
        <a href="https://neuprint.janelia.org/account" target="_blank" rel="noreferrer">
          neuprint.janelia.org/account
        </a>{' '}
        and paste it below.
      </p>

      <label className="sources__field">
        <span>Token</span>
        <textarea
          ref={fieldRef}
          className="field field--area field--mono"
          rows={3}
          value={token}
          spellCheck={false}
          placeholder="eyJhbGciOi…"
          onChange={(e) => onToken(e.target.value)}
        />
      </label>

      <label className="sources__field">
        <span>Proxy path</span>
        <input
          className="field field--mono"
          value={server}
          spellCheck={false}
          onChange={(e) => onServer(e.target.value)}
        />
      </label>
      <p className="sources__note sources__note--tight">
        Not the same thing as a dataset node&rsquo;s <em>Server</em>, which names a neuPrint{' '}
        <em>deployment</em>. This is the <strong>same-origin path</strong> the browser actually
        fetches: neuPrint sends no CORS headers, so a direct request is blocked before it is
        sent. In development it is <code>{DEFAULT_BASE_URL}</code>, served by the proxy in{' '}
        <code>vite.config.ts</code>. Pointing it at <code>https://neuprint.janelia.org</code>{' '}
        will not work however valid the token.
      </p>

      <div className="sources__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onTest}
          disabled={!token.trim() || probe.state === 'testing'}
        >
          {probe.state === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onForget} disabled={!token}>
          Forget
        </button>
        <div className="toolbar__spacer" />
        <button type="button" className="btn btn--primary" onClick={onSave}>
          Save
        </button>
      </div>

      {probe.state === 'ok' && (
        <p className="sources__result" data-tone="ok">
          Connected — {probe.datasets} datasets ({probe.names.join(', ')}
          {probe.datasets > probe.names.length ? ', …' : ''})
        </p>
      )}
      {probe.state === 'failed' && (
        <p className="sources__result" data-tone="error">
          {probe.message}
        </p>
      )}
    </section>
  )
}

function MockTab() {
  return (
    <section className="sources__source">
      <p className="sources__note">
        Synthetic and deterministic, generated in the browser. Always available — no token, no
        network, nothing to configure. The examples use it.
      </p>
    </section>
  )
}
