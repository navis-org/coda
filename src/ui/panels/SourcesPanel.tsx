/**
 * Everything Coda needs a credential for: the data sources, and the assistant's API key.
 *
 * Exists because neuPrint needs two things Coda cannot infer — a token, and a same-origin URL
 * to reach it through — and the assistant needs a third, the user's own Anthropic key. All are
 * per-machine, none belongs in a saved graph, so this is the app state that lives outside the
 * document.
 *
 * **Two levels of tab, and the split is the point.** A data source, an AI provider and a
 * sharing token are not the same kind of thing: one answers questions about a connectome, one
 * writes graphs, one publishes them, and only the first is reached through a proxy. Putting the
 * API key in the source list would file it as a fourth connectome. So the top level is *what
 * kind of connection*, and `SOURCE_TABS` stays the second level within Data sources — a backend
 * is still added by implementing `DataSource` and arriving as an entry.
 *
 * **`SECTIONS` is a table, not a set of ids to branch on.** Each entry carries its own body
 * (`render`, the same shape `SOURCE_TABS` already used), its own auth-failure channel
 * (`subscribe`) and, where it has a second level, which tab a failure opens (`authTab`). The
 * third section arrived as an id union widened, an entry added, a hand-wired `subscribe` and a
 * third arm of a `section.id === …` ternary — four edits, three of which fail silently when the
 * id is mistyped. It is one entry now.
 *
 * It opens itself on an auth failure, on whichever section failed. A 401 surfaced only as red
 * text on a node is a dead end — the fix is a credential, and the field should be in front of
 * you when you learn that. One channel per credential store; each section names its own, which
 * is why nothing here has to guess from the text of the failure.
 *
 * The wart this does *not* fix: `reportAuthFailure` still carries no source id, so `authTab`
 * hardcodes that a data-source failure is neuPrint's. That is the thing to fix when a second
 * credentialed backend arrives — the channel would grow an id, the way `reportSourceLearned`
 * already carries one.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { ConnectionsIcon } from '../Icons'

import { fetchDatasets, forgetRoutes } from '../../data/neuprint/client'
import {
  forgetToken,
  getBaseUrlOverride,
  getToken,
  setBaseUrl,
  setToken,
  subscribeAuthFailure,
} from '../../data/neuprint/credentials'
import { DEFAULT_PROXY_PATH } from '../../data/neuprint/servers'
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
import {
  forgetGithubToken,
  getGithubToken,
  setGithubLogin,
  setGithubToken,
  subscribeGithubAuthFailure,
} from '../../data/share/credentials'
import { githubLogin } from '../../data/share/gist'
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

type SectionId = 'data' | 'ai' | 'sharing'

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
  /**
   * The section's own body, the same shape `SOURCE_TABS` already uses.
   *
   * A `render` member rather than a chain of `section.id === …` checks in the JSX: with the id
   * chain, adding the third section meant widening the union, adding the entry, adding a
   * subscription and adding a ternary arm — four edits, three of which fail silently if the id
   * is typed wrong. `aria-label` comes off `label`, so a section's name is stated once.
   */
  render: (props: SectionProps) => ReactNode
  /**
   * The auth-failure channel that opens the dialog *on this section*.
   *
   * One per credential store, and each store knows which section it belongs to, so nothing here
   * reads the text of a failure to work out where to go. Note the wart this does not fix:
   * `reportAuthFailure` still carries no source id, so `authTab` below hardcodes which tab
   * within Data sources a failure lands on.
   */
  subscribe: (onFailure: (message: string) => void) => () => void
  /** For Data sources only: which tab a failure on this section's channel opens. */
  authTab?: string
}

/** What a section body is handed. Every one ignores most of it; see `SourceTabProps`. */
interface SectionProps extends SourceTabProps {
  tabId: string
  setTabId: (id: string) => void
  onClose: () => void
}

const SECTIONS: readonly [Section, ...Section[]] = [
  {
    id: 'data',
    label: 'Data sources',
    subscribe: subscribeAuthFailure,
    authTab: 'neuprint',
    render: ({ tabId, setTabId, ...tabProps }) => (
      <DataSourceTabs {...{ tabId, setTabId }} {...tabProps} />
    ),
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
    subscribe: subscribeAiAuthFailure,
    render: ({ onClose }) => <AssistantTab onSaved={onClose} />,
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
  {
    id: 'sharing',
    label: 'Sharing',
    subscribe: subscribeGithubAuthFailure,
    render: ({ onClose }) => <SharingTab onSaved={onClose} />,
    privacy: (
      <>
        <strong>Only needed to make a short link.</strong> The token is held in this
        browser&rsquo;s local storage on this machine only, is never written into a saved graph
        or an export, and is never sent to us — it goes straight from this page to
        <code> api.github.com</code>. Reading a shared gist needs no token at all, so a link you
        send works for anybody. A workflow you upload becomes a gist on your own account, which
        you can delete from GitHub at any time.
      </>
    ),
  },
]

export function SourcesPanel() {
  const [open, setOpen] = useState(false)
  const [token, setTokenField] = useState(() => getToken() ?? '')
  const [server, setServerField] = useState(() => getBaseUrlOverride() ?? '')
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const [reason, setReason] = useState<{ section: SectionId; message: string } | undefined>(
    undefined,
  )
  const notify = useGraphStore((s) => s.setNotice)

  // The store outlives this component, but no failure channel replays — a subscription started
  // at mount only ever sees failures from now on, which is what we want. One channel per
  // credential store, read off the section table so adding a fourth is one entry rather than a
  // fourth hand-wired subscribe that fails silently if its id is mistyped.
  useEffect(() => {
    const stops = SECTIONS.map((section) =>
      section.subscribe((message) => {
        setReason({ section: section.id, message })
        setOpen(true)
      }),
    )
    return () => stops.forEach((stop) => stop())
  }, [])

  useEffect(() => {
    if (!open) return
    setTokenField(getToken() ?? '')
    setServerField(getBaseUrlOverride() ?? '')
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
      // check a token before committing to it. An empty field is the real "work it out"
      // case rather than a stand-in for the proxy path, so it is tested by *doing* that,
      // from a clean slate: Test means re-probe, and a remembered route is exactly what
      // somebody pressing it may be trying to get out of.
      const base = server.trim().replace(/\/+$/, '')
      forgetRoutes()
      const raw = await fetchDatasets({
        token: token.trim().replace(/^Bearer\s+/i, ''),
        ...(base ? { baseUrl: base } : {}),
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
        className="btn btn--ghost btn--icon"
        onClick={() => setOpen(true)}
        title="Connections — data sources, API keys and sharing"
        aria-label="Connections"
      >
        <ConnectionsIcon />
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

/**
 * The Data sources section: a tab bar over the registered backends, and the active one's body.
 *
 * Its own component because it is the one section with a second level; the other two are a
 * single form. Keyed by tab so switching remounts, which re-runs the token field's focus.
 */
function DataSourceTabs({ tabId, setTabId, ...tabProps }: Omit<SectionProps, 'onClose'>) {
  const active = SOURCE_TABS.find((tab) => tab.id === tabId) ?? SOURCE_TABS[0]
  return (
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
      <div key={active.id} className="sources__body" role="tabpanel" aria-label={active.label}>
        {active.render(tabProps)}
      </div>
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
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]
  const [tabId, setTabId] = useState(
    (reason && SECTIONS.find((s) => s.id === reason.section)?.authTab) ?? SOURCE_TABS[0].id,
  )

  // A failure arriving while the dialog is already open would otherwise leave the reason
  // stated above a section that has nothing to do with it.
  useEffect(() => {
    if (!reason) return
    setSectionId(reason.section)
    const tab = SECTIONS.find((s) => s.id === reason.section)?.authTab
    if (tab) setTabId(tab)
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

        {section.authTab ? (
          section.render({ ...tabProps, tabId, setTabId, onClose })
        ) : (
          <div className="sources__body" role="tabpanel" aria-label={section.label}>
            {section.render({ ...tabProps, tabId, setTabId, onClose })}
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
        <span>Base URL</span>
        <input
          className="field field--mono"
          value={server}
          spellCheck={false}
          onChange={(e) => onServer(e.target.value)}
        />
      </label>
      <p className="sources__note sources__note--tight">
        <strong>Leave this empty unless you run your own proxy.</strong> Empty means work it
        out: the deployment is tried directly, and where it sends no CORS headers the
        same-origin <code>{DEFAULT_PROXY_PATH}</code> path is used instead — served in
        development by <code>vite.config.ts</code>, and by nothing at all in a static deploy.
        Naming a URL here overrides both, with no fallback, and applies to the default
        deployment only. Not the same thing as a dataset node&rsquo;s <em>Server</em>, which
        names which neuPrint <em>deployment</em> to ask.
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

/**
 * The GitHub token, for putting a workflow in a gist.
 *
 * Its own state rather than the shared `SourceTabProps` bundle, the same call `AssistantTab`
 * makes: that bundle is a token, a proxy path and a dataset probe, and threading a third
 * unrelated credential through it would make every data source carry fields belonging to none
 * of them.
 *
 * **Test is `GET /user`**, which is the smallest thing a token can be asked and answers the
 * only question worth asking here — whose account this is, so the share dialog can tell
 * "update the gist this workflow came from" from "that one is somebody else's". The answer is
 * stored on success rather than discarded, because the dialog would otherwise ask again.
 */
function SharingTab({ onSaved }: { onSaved: () => void }) {
  const [token, setTokenField] = useState(() => getGithubToken() ?? '')
  const [probe, setProbe] = useState<Probe<{ login: string }>>({ state: 'idle' })
  const fieldRef = useRef<HTMLInputElement>(null)
  useEffect(() => fieldRef.current?.focus(), [])

  const test = useCallback(async () => {
    setProbe({ state: 'testing' })
    /*
     * Tested with the value in the field, not the stored one — otherwise a token cannot be
     * checked before committing to it. Written first and rolled back on failure, because
     * `githubLogin` reads the store: the alternative is a second code path taking a token as
     * an argument, which is how the tested request and the real one come to differ.
     */
    const previous = getGithubToken()
    setGithubToken(token)
    try {
      const login = await githubLogin()
      if (!login) throw new Error('GitHub named no account for that token.')
      setProbe({ state: 'ok', login })
    } catch (error) {
      setGithubToken(previous)
      setProbe({ state: 'failed', message: errorMessage(error) })
    }
  }, [token])

  return (
    <section className="sources__source">
      <p className="sources__note">
        Optional. A workflow link normally carries the whole graph, which needs nothing at all —
        this is for the case where that link gets too long to paste, and Coda uploads the
        workflow to a gist instead. Make a token at{' '}
        <a
          href="https://github.com/settings/tokens/new?scopes=gist&description=Coda%20workflow%20sharing"
          target="_blank"
          rel="noreferrer"
        >
          github.com/settings/tokens
        </a>
        .
      </p>

      <label className="sources__field">
        <span>GitHub token</span>
        <input
          ref={fieldRef}
          className="field field--mono"
          value={token}
          spellCheck={false}
          placeholder="ghp_…"
          onChange={(e) => setTokenField(e.target.value)}
        />
      </label>
      <p className="sources__note sources__note--tight">
        <strong>
          The <code>gist</code> scope, and nothing else.
        </strong>{' '}
        A classic token carrying only that cannot read a repository, cannot push and cannot see
        private code; a fine-grained one needs Gists set to read-and-write. The link above
        pre-selects the right scope.
      </p>

      <div className="sources__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void test()}
          disabled={!token.trim() || probe.state === 'testing'}
        >
          {probe.state === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            forgetGithubToken()
            setTokenField('')
            setProbe({ state: 'idle' })
          }}
          disabled={!token}
        >
          Forget
        </button>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setGithubToken(token)
            // `setGithubToken` drops the cached login whenever the token changes, so a probe
            // that already learned it is put back rather than re-fetched on the next share.
            if (probe.state === 'ok') setGithubLogin(probe.login)
            onSaved()
          }}
        >
          Save
        </button>
      </div>

      {probe.state === 'ok' && (
        <p className="sources__result" data-tone="ok">
          Signed in as {probe.login}.
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
