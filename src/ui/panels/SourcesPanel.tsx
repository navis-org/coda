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
 * (`subscribe`) and whether it draws a second level of tabs (`tabbed`). The third section
 * arrived as an id union widened, an entry added, a hand-wired `subscribe` and a third arm of a
 * `section.id === …` ternary — four edits, three of which fail silently when the id is
 * mistyped. It is one entry now.
 *
 * It opens itself on an auth failure, on whichever section failed. A 401 surfaced only as red
 * text on a node is a dead end — the fix is a credential, and the field should be in front of
 * you when you learn that. One channel per credential store; each section names its own, which
 * is why nothing here has to guess from the text of the failure.
 *
 * Within Data sources the *tab* is named by whoever subscribes, because `reportAuthFailure`
 * carries no source id and there is one channel per credential store. It used to be a single
 * `authTab` on the section, hardcoded to neuPrint — harmless while neuPrint was the only
 * credentialed backend, and wrong the moment CAVE arrived, since a CAVE 401 would open the
 * neuPrint tab and ask for the wrong token.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { ConnectionsIcon } from '../Icons'

import { listBases } from '../../data/annotations'
import {
  SEATABLE_HOSTS,
  getToken as getSeaTableToken,
  setToken as setSeaTableToken,
  subscribeAuthFailure as subscribeSeaTableAuthFailure,
} from '../../data/annotations/credentials'
import { listProjects } from '../../data/catmaid/api'
import type { CatmaidInstance } from '../../data/catmaid/credentials'
import {
  DEFAULT_CATMAID_SERVER,
  hostPattern,
  listInstances,
  setInstances,
  subscribeAuthFailure as subscribeCatmaidAuthFailure,
} from '../../data/catmaid/credentials'
import { listDatastacks } from '../../data/cave/api'
import {
  DEFAULT_CAVE_SERVER,
  getServer as getCaveServer,
  getToken as getCaveToken,
  setServer as setCaveServer,
  setToken as setCaveToken,
  subscribeAuthFailure as subscribeCaveAuthFailure,
} from '../../data/cave/credentials'
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
  /**
   * The credential bundle plus `onClose`, and nothing about the tab bar itself.
   *
   * A tab that keeps its own credential state (see `CaveTab`) ignores every field except
   * `onClose`, because saving should close the dialog exactly as the shared form's Save does —
   * a second, subtly different dismissal is how one tab comes to behave unlike its neighbour.
   * Deliberately not the whole `SectionProps`: a tab has no business reading `tabId`/`setTabId`,
   * which are the bar's own state and belong to the thing drawing it.
   */
  render: (props: SourceTabProps & { onClose: () => void }) => ReactNode
}

// A non-empty tuple, so the fallback below is a `SourceTab` rather than possibly undefined.
const SOURCE_TABS: readonly [SourceTab, ...SourceTab[]] = [
  { id: 'neuprint', label: 'neuPrint', render: (props) => <NeuPrintTab {...props} /> },
  { id: 'cave', label: 'CAVE', render: ({ onClose }) => <CaveTab onSaved={onClose} /> },
  {
    id: 'catmaid',
    label: 'CATMAID',
    render: ({ onClose }) => <CatmaidTab onSaved={onClose} />,
  },
  { id: 'mock', label: 'Mock connectome', render: () => <MockTab /> },
]

/**
 * The annotation deployments, as a tab bar over one form.
 *
 * A section of its own rather than two more entries under Data sources, because the top level
 * there is *what kind of connection* and an annotation base is not a connectome — it is
 * somebody's spreadsheet of labels, joined onto one. Filing it under the sources would make
 * FlyTable read as a fourth backend you could query for neurons.
 */
const ANNOTATION_TABS: readonly [SourceTab, ...SourceTab[]] = [
  {
    id: 'flytable',
    label: 'FlyTable',
    render: ({ onClose }) => (
      <SeaTableTab
        key="flytable"
        host={SEATABLE_HOSTS.flytable}
        note="The LMB&rsquo;s SeaTable deployment, and where FlyWire&rsquo;s live cell typing lives."
        onSaved={onClose}
      />
    ),
  },
  {
    id: 'seatable',
    label: 'SeaTable',
    render: ({ onClose }) => (
      <SeaTableTab
        key="seatable"
        host={SEATABLE_HOSTS.seatable}
        note="The hosted service at cloud.seatable.io, for a base of your own."
        onSaved={onClose}
      />
    ),
  },
]

type SectionId = 'data' | 'ai' | 'annotations' | 'sharing'

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
   * The section's own body, for a section that is one page.
   *
   * A `render` member rather than a chain of `section.id === …` checks in the JSX: with the id
   * chain, adding the third section meant widening the union, adding the entry, adding a
   * subscription and adding a ternary arm — four edits, three of which fail silently if the id
   * is typed wrong. `aria-label` comes off `label`, so a section's name is stated once.
   *
   * Exactly one of this and `tabs`.
   */
  render?: (props: SectionProps) => ReactNode
  /**
   * …or the tabs it is a bar over, for a section that is several pages.
   *
   * The list itself rather than a `tabbed: true` flag beside a `render` that draws the bar. That
   * flag existed only to say "this body supplies its own `tabpanel`", which is a fact about
   * *having tabs* — so it was derivable, and a section that gained tabs without remembering it
   * would have been wrapped twice, with two elements claiming the same role. The label is the
   * section's own, rather than a second string passed to the bar.
   */
  tabs?: readonly [SourceTab, ...SourceTab[]]
  /**
   * The auth-failure channel that opens the dialog *on this section*.
   *
   * One per credential store, and each store knows which section it belongs to, so nothing here
   * reads the text of a failure to work out where to go.
   *
   * A section with tabs names the tab as it subscribes, rather than declaring one `authTab` for
   * the whole section. That used to be a stated wart and became a real one the moment CAVE
   * arrived: `reportAuthFailure` carries no source id, so a CAVE 401 opened the neuPrint tab
   * and asked for the wrong credential — a failure that reads as the token being rejected
   * rather than as the panel being on the wrong page.
   */
  subscribe: (onFailure: (message: string, tab?: string) => void) => () => void
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
    subscribe: (onFailure) => {
      const stops = [
        subscribeAuthFailure((message) => onFailure(message, 'neuprint')),
        subscribeCaveAuthFailure((message) => onFailure(message, 'cave')),
        subscribeCatmaidAuthFailure((message) => onFailure(message, 'catmaid')),
      ]
      return () => stops.forEach((stop) => stop())
    },
    tabs: SOURCE_TABS,
    privacy: (
      <>
        <strong>Credentials stay in this browser.</strong> Tokens — and a CATMAID
        instance&rsquo;s HTTP basic password, if you set one — are held in this browser&rsquo;s
        local storage on this machine only, in the clear. They are never written into a saved
        graph or an export, never sent to us, and never shared with any third party: each goes
        only to the deployment it belongs to, directly where that deployment allows a browser to
        reach it and otherwise through a same-origin relay. A password is worth more care than a
        scoped API token, so prefer a token where the instance offers one.
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
    id: 'annotations',
    label: 'Annotations',
    subscribe: (onFailure) =>
      subscribeSeaTableAuthFailure((message) =>
        // Which *tab* is decided by the host the failure names, because one channel serves both
        // deployments — they are the same software and share a client.
        onFailure(message, message.includes('seatable.io') ? 'seatable' : 'flytable'),
      ),
    tabs: ANNOTATION_TABS,
    privacy: (
      <>
        <strong>One token per deployment, kept in this browser.</strong> FlyTable and
        cloud.seatable.io run the same software with unrelated accounts, so each needs its own.
        Tokens are held in this browser&rsquo;s local storage on this machine only, are never
        written into a saved graph or an export, and are never sent to us — each goes only to
        the deployment it belongs to. Coda reads bases; it never writes to one.
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
  const [reason, setReason] = useState<
    { section: SectionId; message: string; tab?: string } | undefined
  >(undefined)
  const notify = useGraphStore((s) => s.setNotice)

  // The store outlives this component, but no failure channel replays — a subscription started
  // at mount only ever sees failures from now on, which is what we want. One channel per
  // credential store, read off the section table so adding a fourth is one entry rather than a
  // fourth hand-wired subscribe that fails silently if its id is mistyped.
  useEffect(() => {
    const stops = SECTIONS.map((section) =>
      section.subscribe((message, tab) => {
        setReason({ section: section.id, message, ...(tab ? { tab } : {}) })
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
 * A section's second level: a tab bar and the active tab's body.
 *
 * One component for both sections, because the a11y contract — the `tablist`, the `aria-selected`
 * on each button, the `tabpanel` keyed by the active id — is the part worth stating once. The
 * two copies had already diverged on the one thing `SourceTab.render` documents: which props a
 * tab may see.
 *
 * `tabId`/`setTabId` are destructured away and **not** forwarded, because a tab "has no business
 * reading the tab bar's own state" — the rule the render signature states.
 */
function TabBar({
  tabs,
  label,
  tabId,
  setTabId,
  ...tabProps
}: SectionProps & { tabs: readonly [SourceTab, ...SourceTab[]]; label: string }) {
  const active = tabs.find((tab) => tab.id === tabId) ?? tabs[0]
  return (
    <>
      <div className="sources__tabs" role="tablist" aria-label={label}>
        {tabs.map((tab) => (
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
  reason: { section: SectionId; message: string; tab?: string } | undefined
}

function Dialog({ onClose, reason, ...tabProps }: DialogProps) {
  // Tab state lives here rather than in `SourcesPanel` because the dialog is unmounted when
  // closed, so every opening starts on the connection you are most likely to have come for.
  const [sectionId, setSectionId] = useState<SectionId>(reason?.section ?? SECTIONS[0].id)
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]
  const [tabId, setTabId] = useState(reason?.tab ?? SOURCE_TABS[0].id)

  // A failure arriving while the dialog is already open would otherwise leave the reason
  // stated above a section that has nothing to do with it.
  useEffect(() => {
    if (!reason) return
    setSectionId(reason.section)
    if (reason.tab) setTabId(reason.tab)
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

        {renderSection(section, { ...tabProps, tabId, setTabId, onClose })}
      </div>
    </div>
  )
}

/**
 * A section's body: its own tab bar, or one page wrapped in a `tabpanel`.
 *
 * Written once for the reason the ternary this replaced was not — as two arms it was two
 * identical four-key literals that had to be kept in step. A tab bar supplies its own panel, so
 * a wrapper here would be a second element claiming the same role.
 */
function renderSection(section: Section, props: SectionProps): ReactNode {
  if (section.tabs) return <TabBar tabs={section.tabs} label={section.label} {...props} />
  return (
    <div className="sources__body" role="tabpanel" aria-label={section.label}>
      {section.render?.(props)}
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

/**
 * The CAVE token.
 *
 * Its own state rather than the shared `SourceTabProps` bundle, the call `SharingTab` and
 * `AssistantTab` already make and the one that bundle's own comment anticipated: it was written
 * "while there is one credentialed source", and there are two now. Threading a second token and
 * a second server through it would give the mock tab four fields belonging to nothing it does.
 *
 * There is no Base URL here, and its absence is the finding rather than an omission. neuPrint's
 * field exists because that deployment historically sent no CORS headers and had to be relayed;
 * every CAVE service Coda calls answers a browser directly, 401s included. What *is* here is a
 * global server, which is a different thing entirely — CAVE splits into one service that knows
 * which datastacks exist and a per-datastack server that answers queries, and only the first is
 * ever named. The second is discovered.
 */
/**
 * CATMAID: a list of instances rather than one credential, which is the shape the backend forces.
 *
 * Every other tab here holds one token, because neuPrint has a canonical deployment and CAVE has
 * a global service. CATMAID is *software* — VFB, the LMB's instances, a lab server — and a token
 * is per user **and** per instance, so a single field would send whichever was saved last to all
 * of them. Hence a list, and hence `server` being a *pattern*: one deployment often answers on
 * several hostnames, and `*.virtualflybrain.org` is one row rather than five.
 *
 * Two credentials per row, and they are not alternatives. `Token` is CATMAID's own, on
 * `X-Authorization`; the HTTP-basic pair is the *web server's*, on `Authorization`. CATMAID
 * picked a non-standard header precisely so both fit on one request — its middleware says so —
 * and an instance behind nginx auth needs both.
 */
interface InstanceRow extends CatmaidInstance {
  /** Local only. Rows are added and removed, so an index is not a stable React key. */
  key: string
}

let nextRowKey = 0
const withKey = (entry: CatmaidInstance): InstanceRow => ({
  ...entry,
  key: `row-${nextRowKey++}`,
})

function CatmaidTab({ onSaved }: { onSaved: () => void }) {
  const [rows, setRows] = useState<InstanceRow[]>(() => listInstances().map(withKey))
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const notify = useGraphStore((s) => s.setNotice)

  const patch = useCallback((key: string, change: Partial<CatmaidInstance>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)))
    // A row that has been edited has not been tested, and a stale green tick beside a changed
    // token is the one thing a Test button must never show.
    setProbes((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }, [])

  const test = useCallback(async (row: InstanceRow) => {
    setProbes((current) => ({ ...current, [row.key]: { state: 'testing' } }))
    const host = hostPattern(row.server)
    if (!host || host.includes('*')) {
      setProbes((current) => ({
        ...current,
        [row.key]: {
          state: 'failed',
          // A pattern names no single host, so there is nothing to call. Said rather than
          // disabled, or the button reads as broken on exactly the rows this feature is for.
          message: host
            ? 'A wildcard covers several hosts, so there is nothing to test. Type one host to check it, then widen it again.'
            : 'Name a server first.',
        },
      }))
      return
    }
    try {
      const projects = await listProjects(`https://${host}`, {
        credentials: { ...row, server: host },
      })
      setProbes((current) => ({
        ...current,
        [row.key]: {
          state: 'ok',
          datasets: projects.length,
          names: projects.map((project) => project.title).slice(0, 6),
        },
      }))
    } catch (error) {
      setProbes((current) => ({
        ...current,
        [row.key]: { state: 'failed', message: errorMessage(error) },
      }))
    }
  }, [])

  return (
    <section className="sources__source">
      <p className="sources__note">
        CATMAID instances. Reading a public one needs no credentials at all — every{' '}
        <code>GET</code> is answered anonymously — but connectivity and neuron names go over{' '}
        <code>POST</code>, which a browser cannot send anonymously, so those need a token. Get
        one from your instance: hover your name, then <em>Get API token</em>.
      </p>

      {rows.length === 0 ? (
        <p className="sources__hint">
          No instances configured. Coda still reads{' '}
          <code>{hostPattern(DEFAULT_CATMAID_SERVER)}</code> without one; add a row when an
          instance asks for a credential.
        </p>
      ) : null}

      <ul className="sources__list">
        {rows.map((row) => {
          const probe = probes[row.key] ?? { state: 'idle' as const }
          return (
            <li key={row.key} className="sources__row">
              <label className="sources__field">
                <span>Server</span>
                <input
                  className="field field--mono"
                  value={row.server}
                  spellCheck={false}
                  placeholder="catmaid.example.org  or  *.example.org"
                  onChange={(e) => patch(row.key, { server: e.target.value })}
                />
              </label>

              <label className="sources__field">
                <span>API token</span>
                <input
                  className="field field--mono"
                  type="password"
                  value={row.token ?? ''}
                  spellCheck={false}
                  placeholder="9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
                  onChange={(e) => patch(row.key, { token: e.target.value })}
                />
              </label>

              <details className="sources__more">
                <summary>HTTP basic auth (only if the server asks for it)</summary>
                <p className="sources__hint">
                  The <em>web server&rsquo;s</em> login, not CATMAID&rsquo;s — the browser
                  dialog some instances show before CATMAID loads. It is sent alongside the
                  token rather than instead of it.
                </p>
                <label className="sources__field">
                  <span>User</span>
                  <input
                    className="field field--mono"
                    value={row.httpUser ?? ''}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => patch(row.key, { httpUser: e.target.value })}
                  />
                </label>
                <label className="sources__field">
                  <span>Password</span>
                  <input
                    className="field field--mono"
                    type="password"
                    value={row.httpPassword ?? ''}
                    autoComplete="off"
                    onChange={(e) => patch(row.key, { httpPassword: e.target.value })}
                  />
                </label>
              </details>

              <div className="sources__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void test(row)}
                  disabled={probe.state === 'testing'}
                >
                  {probe.state === 'testing' ? 'Testing…' : 'Test'}
                </button>
                <div className="toolbar__spacer" />
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  Remove
                </button>
              </div>

              {probe.state === 'ok' ? (
                <p className="sources__result" data-tone="ok">
                  Reached it — {probe.datasets} project{probe.datasets === 1 ? '' : 's'}
                  {probe.names.length ? `: ${probe.names.join(', ')}` : ''}
                </p>
              ) : null}
              {probe.state === 'failed' ? (
                <p className="sources__result" data-tone="error">
                  {probe.message}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="sources__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() =>
            setRows((current) => [
              ...current,
              // Prefilled with VFB's host on the first row only: it is the instance Coda ships a
              // dataset node for, and typing a hostname from memory is the step people get wrong.
              withKey({ server: current.length ? '' : hostPattern(DEFAULT_CATMAID_SERVER) }),
            ])
          }
        >
          + Add instance
        </button>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setInstances(rows)
            // Re-read, because `setInstances` drops rows with no host or no credential — showing
            // the stored list is what makes that visible rather than silent.
            const stored = listInstances()
            const dropped = rows.length - stored.length
            notify(
              dropped > 0
                ? `Saved ${stored.length} CATMAID instance${stored.length === 1 ? '' : 's'} — ${dropped} incomplete row${dropped === 1 ? '' : 's'} dropped.`
                : `Saved ${stored.length} CATMAID instance${stored.length === 1 ? '' : 's'}.`,
            )
            onSaved()
          }}
        >
          Save
        </button>
      </div>
    </section>
  )
}

function CaveTab({ onSaved }: { onSaved: () => void }) {
  const [token, setTokenField] = useState(() => getCaveToken() ?? '')
  const [server, setServerField] = useState(() => getCaveServer())
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => fieldRef.current?.focus(), [])
  const notify = useGraphStore((s) => s.setNotice)

  const test = useCallback(async () => {
    setProbe({ state: 'testing' })
    try {
      // With the values in the fields rather than the stored ones, so a token can be checked
      // before committing to it — `NeuPrintTab`'s rule, reached the same way.
      const base = server.trim().replace(/\/+$/, '') || DEFAULT_CAVE_SERVER
      const names = await listDatastacks(base, {
        token: token.trim().replace(/^Bearer\s+/i, ''),
      })
      setProbe({ state: 'ok', datasets: names.length, names: names.sort().slice(0, 6) })
    } catch (error) {
      setProbe({ state: 'failed', message: errorMessage(error) })
    }
  }, [token, server])

  return (
    <section className="sources__source">
      <p className="sources__note">
        FlyWire and other CAVE-hosted connectomes. Get a token from{' '}
        <a
          href="https://global.daf-apis.com/auth/api/v1/create_token"
          target="_blank"
          rel="noreferrer"
        >
          global.daf-apis.com
        </a>{' '}
        — the same token <code>caveclient</code> stores in <code>~/.cloudvolume/secrets</code>,
        so if you already use CAVE from Python you have one.
      </p>

      <label className="sources__field">
        <span>Token</span>
        <textarea
          ref={fieldRef}
          className="field field--area field--mono"
          rows={2}
          value={token}
          spellCheck={false}
          placeholder="a1b2c3d4…"
          onChange={(e) => setTokenField(e.target.value)}
        />
      </label>

      <label className="sources__field">
        <span>Global server</span>
        <input
          className="field field--mono"
          value={server}
          spellCheck={false}
          placeholder={DEFAULT_CAVE_SERVER}
          onChange={(e) => setServerField(e.target.value)}
        />
      </label>
      <p className="sources__note sources__note--tight">
        <strong>Leave this alone unless you use a different CAVE deployment.</strong> It is the
        service that lists datastacks and says which server holds each one; the server that
        answers the actual queries is read from that listing rather than named here. Not the
        same thing as a dataset node&rsquo;s version, which names a <em>materialization</em>.
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
            setCaveToken(undefined)
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
            setCaveToken(token)
            setCaveServer(server)
            // Re-list so the dataset picker fills in without a reload, exactly as saving a
            // neuPrint token does. Swallowed: the 401 has its own channel back to this panel.
            void getSource('cave')
              ?.listDatasets()
              .then((datasets) => notify(`CAVE connected — ${datasets.length} datasets`))
              .catch(() => undefined)
            onSaved()
          }}
        >
          Save
        </button>
      </div>

      {probe.state === 'ok' && (
        <p className="sources__result" data-tone="ok">
          Connected — {probe.datasets} datastacks ({probe.names.join(', ')}
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
 * One SeaTable deployment's token.
 *
 * Its own state, the call `CaveTab` and `SharingTab` already make. What it tests with is the
 * *base listing*, which is the useful probe here rather than a bare ping: it proves the token
 * works and shows what it can reach, and "which bases can I see" is the question somebody
 * configuring one of these nodes is about to ask anyway.
 */
function SeaTableTab({
  host,
  note,
  onSaved,
}: {
  host: string
  note: string
  onSaved: () => void
}) {
  const [token, setTokenField] = useState(() => getSeaTableToken(host) ?? '')
  const [probe, setProbe] = useState<Probe<{ bases: number; names: string[] }>>({
    state: 'idle',
  })
  const fieldRef = useRef<HTMLInputElement>(null)
  useEffect(() => fieldRef.current?.focus(), [])

  const test = useCallback(async () => {
    setProbe({ state: 'testing' })
    /*
     * Written first and rolled back on failure, because `listBases` reads the store — the
     * alternative is a second code path taking a token as an argument, which is how the tested
     * request and the real one come to differ. `SharingTab`'s trade exactly.
     */
    const previous = getSeaTableToken(host)
    setSeaTableToken(host, token)
    try {
      const bases = await listBases(host)
      setProbe({
        state: 'ok',
        bases: bases.length,
        names: bases.slice(0, 6).map((b) => b.name),
      })
    } catch (error) {
      setSeaTableToken(host, previous)
      setProbe({ state: 'failed', message: errorMessage(error) })
    }
  }, [host, token])

  return (
    <section className="sources__source">
      <p className="sources__note">
        {note} Get an <strong>account</strong> token from your profile at{' '}
        <a href={host} target="_blank" rel="noreferrer">
          {new URL(host).host}
        </a>
        .
      </p>

      <label className="sources__field">
        <span>Account token</span>
        <input
          ref={fieldRef}
          className="field field--mono"
          value={token}
          spellCheck={false}
          placeholder="a1b2c3…"
          onChange={(e) => setTokenField(e.target.value)}
        />
      </label>
      <p className="sources__note sources__note--tight">
        <strong>An account token, not a base API token.</strong> The two look alike and only one
        works: a base token is minted for a single base and is refused by the listing this
        needs, with a message that blames the token rather than its kind. An account token
        reaches every base the account can see.
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
            setSeaTableToken(host, undefined)
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
            setSeaTableToken(host, token)
            onSaved()
          }}
        >
          Save
        </button>
      </div>

      {probe.state === 'ok' && (
        <p className="sources__result" data-tone="ok">
          Connected — {probe.bases} bases ({probe.names.join(', ')}
          {probe.bases > probe.names.length ? ', …' : ''})
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
