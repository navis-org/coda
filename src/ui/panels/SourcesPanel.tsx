/**
 * Everything Coda needs a credential for: the data sources, and the assistant's API key.
 *
 * Exists because neuPrint needs two things Coda cannot infer — a token, and a same-origin URL
 * to reach it through — and the assistant needs a third, the user's own Anthropic key. All are
 * per-machine, none belongs in a saved graph, so this is the app state that lives outside the
 * document.
 *
 * **Two levels of tab, and the split is the point.** A data source and an AI provider are not
 * the same kind of thing: one answers questions about a connectome, the other writes graphs,
 * and only one of them is reached through a proxy. Putting the API key in the source list
 * would file it as a fourth connectome. So the top level is *what kind of connection*, and
 * `SOURCE_TABS` stays the second level within Data sources — a backend is still added by
 * implementing `DataSource` and arriving as an entry.
 *
 * It opens itself on an auth failure, on whichever half failed. A 401 surfaced only as red
 * text on a node is a dead end — the fix is a credential, and the field should be in front of
 * you when you learn that. There are two failure channels because there are two credential
 * stores; each names the section it is about, which is why nothing here has to guess from the
 * text of the failure.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

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
import {
  forgetKey,
  getBaseUrl as getAiBaseUrl,
  getKey,
  getModel,
  getProviderId,
  setBaseUrl as setAiBaseUrl,
  setKey,
  setModel,
  setProviderId,
  subscribeAuthFailure as subscribeAiAuthFailure,
} from '../../data/ai/credentials'
import { PROVIDERS, providerFor, verify } from '../../data/ai/registry'
import type { AiProvider, ModelOption } from '../../data/ai/types'
import { getSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { errorMessage } from '../../core/errors'

/**
 * A credential being checked. `Ok` is what a successful check found, which differs by what is
 * being checked — a data source counts datasets, a provider names a model.
 */
type Probe<Ok = { datasets: number; names: string[] }> =
  | { state: 'idle' }
  | { state: 'testing' }
  | ({ state: 'ok' } & Ok)
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

type SectionId = 'data' | 'ai'

interface Section {
  id: SectionId
  label: string
  /**
   * Where a credential typed into this section actually goes. Per section rather than said
   * once at the top, because the honest answer differs: neuPrint is unreachable from a page
   * without a same-origin proxy relaying the request, while the Anthropic API allows direct
   * browser access and is called straight from here. One sentence covering both would have to
   * be vague about the only part anybody is asking about.
   */
  privacy: ReactNode
}

const SECTIONS: readonly [Section, ...Section[]] = [
  {
    id: 'data',
    label: 'Data sources',
    privacy: (
      <>
        <strong>Credentials stay in this browser.</strong> Tokens are held in this
        browser&rsquo;s local storage on this machine only. They are never written into a saved
        graph or an export, never sent to us, and never shared with any third party — they go
        only to the service they authenticate, through the same-origin proxy that request has to
        travel through.
      </>
    ),
  },
  {
    id: 'ai',
    label: 'AI assistant',
    privacy: (
      <>
        <strong>Your key, your account, your bill.</strong> Keys are held in this
        browser&rsquo;s local storage on this machine only, are never written into a saved graph
        or an export, and are never sent to us — requests go straight from this page to the
        provider you pick, with no server of ours in between. Whatever you ask the assistant,
        and the graph on your canvas when you ask, are sent to that provider as part of the
        request. A local provider sends nothing off the machine at all.
      </>
    ),
  },
]

/**
 * The section each failure channel is about.
 *
 * There are two channels because there are two credential stores, and neither carries an id —
 * so the mapping is stated here rather than guessed at from the text of the failure. Note this
 * still hardcodes *which source tab* within Data sources, which is fine while neuPrint is the
 * only credentialed one and is the thing to fix when a second arrives: `reportAuthFailure`
 * would grow a source id, the way `reportSourceLearned` already carries one.
 */
const AUTH_FAILURE_TAB = 'neuprint'

export function SourcesPanel() {
  const [open, setOpen] = useState(false)
  const [token, setTokenField] = useState(() => getToken() ?? '')
  const [server, setServerField] = useState(() => getBaseUrl())
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const [reason, setReason] = useState<{ section: SectionId; message: string } | undefined>(
    undefined,
  )
  const notify = useGraphStore((s) => s.setNotice)

  // The store outlives this component, but neither failure channel replays — a subscription
  // started at mount only ever sees failures from now on, which is what we want. Two channels
  // because there are two credential stores; each knows which section it is about, so nothing
  // here has to read the message to find out.
  useEffect(() => {
    const stopData = subscribeAuthFailure((message) => {
      setReason({ section: 'data', message })
      setOpen(true)
    })
    const stopAi = subscribeAiAuthFailure((message) => {
      setReason({ section: 'ai', message })
      setOpen(true)
    })
    return () => {
      stopData()
      stopAi()
    }
  }, [])

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
        title="Data sources and API keys"
      >
        Connections
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
  reason: { section: SectionId; message: string } | undefined
}

function Dialog({ onClose, reason, ...tabProps }: DialogProps) {
  // Tab state lives here rather than in `SourcesPanel` because the dialog is unmounted when
  // closed, so every opening starts on the connection you are most likely to have come for.
  const [sectionId, setSectionId] = useState<SectionId>(reason?.section ?? SECTIONS[0].id)
  const [tabId, setTabId] = useState(reason ? AUTH_FAILURE_TAB : SOURCE_TABS[0].id)
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]
  const active = SOURCE_TABS.find((tab) => tab.id === tabId) ?? SOURCE_TABS[0]

  // A failure arriving while the dialog is already open would otherwise leave the reason
  // stated above a section that has nothing to do with it.
  useEffect(() => {
    if (!reason) return
    setSectionId(reason.section)
    if (reason.section === 'data') setTabId(AUTH_FAILURE_TAB)
  }, [reason])

  return (
    <div className="overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="overlay__panel sources"
        role="dialog"
        aria-modal="true"
        aria-label="Connections"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sources__header">
          <h2>Connections</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {reason && <p className="sources__alert">{reason.message}</p>}

        <div className="sources__sections" role="tablist" aria-label="Connection kind">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="sources__section"
              aria-selected={entry.id === section.id}
              onClick={() => setSectionId(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/*
         * Above the field that asks for the credential, and per section rather than once at
         * the top: "where does this go?" has two different honest answers here, and the one
         * about the proxy is not a hedge — a neuPrint request really is relayed by whatever
         * serves this page, while an Anthropic one is not relayed at all.
         */}
        <p className="sources__privacy">{section.privacy}</p>

        {section.id === 'data' ? (
          <>
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

            {/* Keyed by tab so switching remounts — which re-runs the token field's focus. */}
            <div
              key={active.id}
              className="sources__body"
              role="tabpanel"
              aria-label={active.label}
            >
              {active.render(tabProps)}
            </div>
          </>
        ) : (
          <div className="sources__body" role="tabpanel" aria-label="AI assistant">
            <AssistantTab onSaved={onClose} />
          </div>
        )}
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

/**
 * The assistant's provider, credential and model.
 *
 * Its own state rather than the shared `SourceTabProps` bundle: that bundle is a token, a proxy
 * path and a probe, which is what a *data source* needs, and threading a second unrelated
 * credential through it would make every source tab carry fields belonging to none of them.
 *
 * Everything is kept **per provider**, so trying Gemini and coming back does not cost you the
 * key you already pasted. Switching the picker therefore re-reads rather than clearing.
 */
function AssistantTab({ onSaved }: { onSaved: () => void }) {
  const [providerId, setProvider] = useState(() => getProviderId())
  const provider = providerFor(providerId) ?? PROVIDERS[0]!
  /*
   * Keyed, so switching provider *remounts* the form and every field re-reads from storage.
   * Replaying the reads by hand — one `setXField(getX(next.id))` per field — meant the initial
   * read and the on-switch read were the same four lines written twice, and a fifth field added
   * to one and not the other would leave the previous provider's value in the box, silently.
   * The same trick `Dialog` uses above for the source tabs, for the same reason.
   */
  return (
    <ProviderForm
      key={provider.id}
      provider={provider}
      onChoose={setProvider}
      onSaved={onSaved}
    />
  )
}

function ProviderForm({
  provider,
  onChoose,
  onSaved,
}: {
  provider: AiProvider
  onChoose: (id: string) => void
  onSaved: () => void
}) {
  const [key, setKeyField] = useState(() => getKey(provider.id) ?? '')
  const [model, setModelField] = useState(() => getModel(provider.id))
  const [base, setBaseField] = useState(() => getAiBaseUrl(provider.id))
  const [probe, setProbe] = useState<
    Probe<{ label: string; context: number; warning?: string | undefined }>
  >({ state: 'idle' })
  const fieldRef = useRef<HTMLInputElement>(null)
  const notify = useGraphStore((s) => s.setNotice)
  const modelId = useId()
  useEffect(() => fieldRef.current?.focus(), [])

  /*
   * What the provider says is actually available, where it can say.
   *
   * `undefined` means nobody has asked or the asking failed, which is not the same as an empty
   * answer — a provider that answered and has nothing pulled is a fact worth printing, and one
   * that never answered must leave the declared shortlist standing rather than replacing it with
   * an empty dropdown.
   */
  const [installed, setInstalled] = useState<readonly ModelOption[] | undefined>(undefined)
  const [listing, setListing] = useState(false)

  const discover = useCallback(
    async (explicit: boolean) => {
      if (!provider.listModels) return
      setListing(true)
      try {
        const found = await provider.listModels({ apiKey: key.trim(), baseUrl: base.trim() })
        setInstalled(found)
        /*
         * A declared default was never a decision — the same rule `resolveColumn` follows — so a
         * default naming a model this machine has not pulled gives way to one it has. Anything
         * the user actually chose is left alone even when it is missing, and the dropdown marks
         * it rather than swapping it silently.
         */
        setModelField((current) =>
          current === provider.defaultModel &&
          found.length > 0 &&
          !found.some((option) => option.id === current)
            ? found[0]!.id
            : current,
        )
      } catch (error) {
        // A background listing stays quiet: Test is where reachability is reported, and a panel
        // that opens with an error on it blames the user for not having started a server they
        // may not even be using. An explicit press has asked, so it answers.
        if (explicit) setProbe({ state: 'failed', message: errorMessage(error) })
      } finally {
        setListing(false)
      }
    },
    // `key`/`base` are read at call time from the fields; the effect below runs once per mount,
    // and the ↻ is what re-asks after either is edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider],
  )

  // The form is keyed by provider, so a mount is exactly "this provider was opened".
  useEffect(() => void discover(false), [discover])

  // Tested with the values in the fields, not the stored ones — otherwise a key cannot be
  // checked before committing to it, which is the whole point of a Test button.
  const test = async () => {
    setProbe({ state: 'testing' })
    try {
      const check = await verify({
        providerId: provider.id,
        apiKey: key.trim(),
        model,
        baseUrl: base.trim(),
      })
      setProbe({
        state: 'ok',
        label: check.label,
        context: check.context,
        warning: check.warning,
      })
    } catch (error) {
      setProbe({ state: 'failed', message: errorMessage(error) })
    }
  }

  /*
   * What the dropdown offers, in at most three groups.
   *
   * The distinction is the whole point of this control: a name that is on the machine can be
   * picked right now, where a name that is merely *known to the provider* has to be pulled
   * first. Flattening the two is what made a list of five models nobody had look exactly like a
   * list of five models they did. Where nothing was discovered there is no distinction to draw
   * and the list stays flat, which is every cloud provider.
   */
  const groups: Array<{ label?: string; options: ModelOption[] }> = []
  if (installed) {
    if (installed.length > 0) groups.push({ label: 'On this machine', options: [...installed] })
    const missing = provider.models.filter((o) => !installed.some((m) => m.id === o.id))
    if (missing.length > 0) groups.push({ label: 'Available to pull', options: [...missing] })
  } else {
    groups.push({ options: [...provider.models] })
  }
  /*
   * The current value is always offered, so a model set by a previous build — or by hand in
   * storage — round-trips instead of being silently swapped for whatever sorts first. It is
   * marked only once a listing has actually arrived, since "not pulled" is a claim about a
   * machine that answered.
   */
  if (model && !groups.some((g) => g.options.some((o) => o.id === model))) {
    groups.unshift({
      options: [{ id: model, label: installed ? `${model} — not pulled` : model }],
    })
  }

  return (
    <section className="sources__source">
      <label className="sources__field">
        <span>Provider</span>
        <select
          className="field"
          value={provider.id}
          onChange={(e) => onChoose(e.target.value)}
        >
          {PROVIDERS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <p className="sources__note sources__note--tight">
        {provider.note}
        {provider.keyUrl && (
          <>
            {' '}
            Key from{' '}
            <a href={provider.keyUrl} target="_blank" rel="noreferrer">
              {new URL(provider.keyUrl).host}
            </a>
            ; usage is billed to your account.
          </>
        )}
      </p>

      {provider.needsKey && (
        <label className="sources__field">
          <span>API key</span>
          <input
            ref={fieldRef}
            className="field field--mono"
            type="password"
            value={key}
            spellCheck={false}
            placeholder="sk-…"
            onChange={(e) => setKeyField(e.target.value)}
          />
        </label>
      )}

      {provider.editableBaseUrl && (
        <label className="sources__field">
          <span>Server</span>
          <input
            className="field field--mono"
            value={base}
            spellCheck={false}
            onChange={(e) => setBaseField(e.target.value)}
          />
        </label>
      )}

      <div className="sources__field">
        <span id={`${modelId}-label`}>Model</span>
        <div className="sources__inline">
          <select
            id={modelId}
            aria-labelledby={`${modelId}-label`}
            className="field"
            value={model}
            onChange={(e) => {
              setModelField(e.target.value)
              setProbe({ state: 'idle' })
            }}
          >
            {groups.map((group, i) =>
              group.label ? (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ) : (
                group.options.map((option) => (
                  <option key={`${i}:${option.id}`} value={option.id}>
                    {option.label}
                  </option>
                ))
              ),
            )}
          </select>
          {provider.listModels && (
            <button
              type="button"
              className="btn btn--ghost sources__refresh"
              onClick={() => void discover(true)}
              disabled={listing}
              title="Ask the server which models are installed"
              aria-label="Refresh model list"
            >
              {listing ? '\u2026' : '\u21bb'}
            </button>
          )}
        </div>
        {installed?.length === 0 && (
          <span className="sources__hint">
            Nothing pulled yet — run <code>ollama pull {provider.defaultModel}</code>, then
            refresh.
          </span>
        )}
      </div>

      <div className="sources__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void test()}
          disabled={(provider.needsKey && !key.trim()) || probe.state === 'testing'}
        >
          {probe.state === 'testing' ? 'Testing…' : 'Test'}
        </button>
        {provider.needsKey && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              forgetKey(provider.id)
              setKeyField('')
              setProbe({ state: 'idle' })
            }}
            disabled={!key}
          >
            Forget
          </button>
        )}
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setProviderId(provider.id)
            setKey(provider.id, key)
            setModel(provider.id, model)
            if (provider.editableBaseUrl) setAiBaseUrl(provider.id, base)
            // Closes, like the neuPrint tab's Save: the confirmation lands in the status bar,
            // which is behind this dialog, so staying open would report nothing at all.
            notify(`Assistant set to ${provider.label}`)
            onSaved()
          }}
        >
          Save
        </button>
      </div>

      {probe.state === 'ok' && (
        <>
          <p className="sources__result" data-tone="ok">
            Works — {probe.label}
            {probe.context ? `, ${Math.round(probe.context / 1000)}k context` : ''}
          </p>
          {/* Beside the success, not instead of it: the setting works, the answers may not. */}
          {probe.warning && (
            <p className="sources__result" data-tone="warn">
              {probe.warning}
            </p>
          )}
        </>
      )}
      {probe.state === 'failed' && (
        <p className="sources__result" data-tone="error">
          {probe.message}
        </p>
      )}
    </section>
  )
}
