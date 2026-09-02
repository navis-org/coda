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
 * **Except while a tour is running, where it says the same thing in the status bar instead.**
 * driver.js makes every element but the one it is spotlighting `pointer-events: none`, so a
 * dialog that arrives *during* a step cannot be typed into, dismissed or clicked away — the
 * reader is left with a form they cannot use over a tour they cannot see. Reported from the
 * dashboard tour, whose third step adds a MaleCNS node and draws a 401 out of the deployment on
 * the spot. The failure is not swallowed: `reason` is still recorded, so opening Connections by
 * hand afterwards lands on the tab that failed with the message above it, and that tour now asks
 * for a token in a step of its own before it builds anything.
 *
 * **Whether it is open lives in the store** (`sourcesOpen`). It was `useState` here while the
 * button and the failure channel were the only two ways in; a tour is the third, and it has to
 * be able to close it again from a step's `after` — which has nothing to call on a component's
 * state.
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
  getSession as getCaveSession,
  getToken as getCaveToken,
  setServer as setCaveServer,
  setToken as setCaveToken,
  subscribeAuthFailure as subscribeCaveAuthFailure,
} from '../../data/cave/credentials'
import { CaveSignInError, signInToCave } from './caveSignIn'
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
  getThinking,
  setThinking,
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
/*
 * The static half of the tour — four functions over a nullable handle, no driver.js. Importing
 * it here costs nothing and is what `tourState.ts` exists for; a static import of `tour.ts`
 * would put the library in the main chunk.
 */
import { isTourActive } from '../tour/tourState'
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
  render: (props: SourceTabProps & { onClose: () => void; onResolved: () => void }) => ReactNode
  /**
   * The auth-failure channel for *this* tab's credential store.
   *
   * On the tab rather than fanned in by the section, because the section's version repeated
   * every tab's id as a bare string literal (`onFailure(message, 'catmaid')`) in a second array
   * — two edits per backend joined by a string nothing checks. A typo or an omission is silent,
   * and what it produces is the 401 opening whichever tab was last selected rather than the one
   * holding the credential: exactly the CAVE-opens-neuPrint bug this pairing was introduced to
   * fix. Optional, since `MockTab` has no credential and so no channel.
   */
  subscribe?: (onFailure: (message: string) => void) => () => void
}

// A non-empty tuple, so the fallback below is a `SourceTab` rather than possibly undefined.
const SOURCE_TABS: readonly [SourceTab, ...SourceTab[]] = [
  {
    id: 'neuprint',
    label: 'neuPrint',
    render: (props) => <NeuPrintTab {...props} />,
    subscribe: subscribeAuthFailure,
  },
  {
    id: 'cave',
    label: 'CAVE',
    render: ({ onClose, onResolved }) => <CaveTab onSaved={onClose} onResolved={onResolved} />,
    subscribe: subscribeCaveAuthFailure,
  },
  {
    id: 'catmaid',
    label: 'CATMAID',
    render: ({ onClose }) => <CatmaidTab onSaved={onClose} />,
    subscribe: subscribeCatmaidAuthFailure,
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

/**
 * Fan a tab bar's own channels in, each naming the tab it belongs to.
 *
 * Derived from the table rather than written beside it, so a tab that declares a channel is
 * routed to itself by construction and one that does not is skipped.
 */
function subscribeTabs(
  tabs: readonly SourceTab[],
  onFailure: (message: string, tab?: string) => void,
): () => void {
  const stops = tabs.map((tab) => tab.subscribe?.((message) => onFailure(message, tab.id)))
  return () => stops.forEach((stop) => stop?.())
}

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
  /** See `Dialog`: the alert that opened this panel, dismissed by the tab that answered it. */
  onResolved: (tab: string) => void
}

/**
 * The explanation behind a `?`, for a row whose one line is the whole of what most people need.
 *
 * This panel had grown to the point where the copy *was* the interface: four paragraphs a reader
 * has to get past to reach a button they were going to press anyway. The rule this restores is
 * one line per point, with the paragraph a click away — and a `title` is the tooltip, because it
 * is what every other explain-this in this app already uses (`LayoutControls`, `Inspector`,
 * `GroupContextMenu`) and a second mechanism would be a second thing to style and dismiss.
 *
 * A button rather than a `<span>`, so it can be reached by keyboard; `aria-label` carries the
 * text, because a control announced as "question mark" tells a screen reader nothing. It is
 * deliberately **outside** every `<label>`: nested in one, the paragraph would be read as part
 * of the field's own name.
 */
function Why({ children }: { children: string }) {
  return (
    <button type="button" className="sources__why" title={children} aria-label={children}>
      ?
    </button>
  )
}

const SECTIONS: readonly [Section, ...Section[]] = [
  {
    id: 'data',
    label: 'Data sources',
    subscribe: (onFailure) => subscribeTabs(SOURCE_TABS, onFailure),
    tabs: SOURCE_TABS,
    privacy: (
      <>
        <strong>Credentials stay in this browser.</strong>
        <Why>
          {"Tokens — and a CATMAID instance's HTTP basic password, if you set one — are held in " +
            "this browser's local storage on this machine only, in the clear. They are never " +
            'written into a saved graph or an export, never sent to us, and never shared with ' +
            'any third party: each goes only to the deployment it belongs to, directly where ' +
            'that deployment allows a browser to reach it and otherwise through a same-origin ' +
            'relay.'}
        </Why>
      </>
    ),
  },
  {
    id: 'ai',
    label: 'AI assistant',
    subscribe: subscribeAiAuthFailure,
    render: ({ onClose }) => <AssistantTab onSaved={onClose} />,
    /*
     * The one section that keeps a second sentence on screen. Where a key is kept is a promise
     * about us, and a reader who does not open the `?` has lost nothing; that the question and
     * the *graph* leave the machine is a consequence for them, and it is the thing nobody can
     * infer from a key field. A consent line behind a tooltip is not a consent line.
     */
    privacy: (
      <>
        <strong>Your key, your account, your bill.</strong> Your question and the graph on your
        canvas go to the provider you pick.
        <Why>
          {"Keys are held in this browser's local storage on this machine only, are never " +
            'written into a saved graph or an export, and are never sent to us — requests go ' +
            'straight from this page to the provider you pick, with no server of ours in ' +
            'between. A local provider sends nothing off the machine at all.'}
        </Why>
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
        <strong>One token per deployment, kept in this browser.</strong>
        <Why>
          {'FlyTable and cloud.seatable.io run the same software with unrelated accounts, so ' +
            "each needs its own. Tokens are held in this browser's local storage on this " +
            'machine only, are never written into a saved graph or an export, and are never ' +
            'sent to us — each goes only to the deployment it belongs to. Coda reads bases; it ' +
            'never writes to one.'}
        </Why>
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
        <strong>Only needed to make a short link.</strong>
        <Why>
          {"The token is held in this browser's local storage on this machine only, is never " +
            'written into a saved graph or an export, and is never sent to us — it goes ' +
            'straight from this page to api.github.com. Reading a shared gist needs no token at ' +
            'all, so a link you send works for anybody. A workflow you upload becomes a gist on ' +
            'your own account, which you can delete from GitHub at any time.'}
        </Why>
      </>
    ),
  },
]

export function SourcesPanel() {
  const open = useGraphStore((s) => s.sourcesOpen)
  const openPanel = useGraphStore((s) => s.openSources)
  const closePanel = useGraphStore((s) => s.closeSources)
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
        /*
         * A tour is on screen and everything under it is inert — see the module note. The
         * message still has to arrive somewhere, and the status bar is the one surface a tour
         * leaves usable, so it goes there and the panel waits until somebody opens it.
         */
        if (isTourActive()) notify(message)
        else openPanel()
      }),
    )
    return () => stops.forEach((stop) => stop())
  }, [notify, openPanel])

  useEffect(() => {
    if (!open) return
    setTokenField(getToken() ?? '')
    setServerField(getBaseUrlOverride() ?? '')
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closePanel])

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
    closePanel()
  }, [token, server, notify, closePanel])

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        data-tour="connections"
        onClick={openPanel}
        title="Connections — data sources, API keys and sharing"
        aria-label="Connections"
      >
        <ConnectionsIcon />
      </button>
      {open && (
        <Dialog
          onClose={closePanel}
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
  onResolved,
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
        {active.render({ ...tabProps, onResolved: () => onResolved(active.id) })}
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

  /*
   * The alert is the *reason*, held locally so that it can stop being true.
   *
   * "No CAVE token" is a fact about the moment the panel opened, and the whole point of the
   * panel is to make it false — leaving it on screen above a tab that now says "Signed in as
   * …" is the panel contradicting itself. So a tab that obtains a credential dismisses it, and
   * only its own: two sources fail independently, and answering neuPrint must not clear a
   * warning about CAVE. A *new* failure re-states it, which is what the effect below is for.
   */
  const [alert, setAlert] = useState(reason)
  const onResolved = useCallback(
    (tab: string) => setAlert((current) => (current?.tab === tab ? undefined : current)),
    [],
  )

  // A failure arriving while the dialog is already open would otherwise leave the reason
  // stated above a section that has nothing to do with it.
  useEffect(() => {
    setAlert(reason)
    if (!reason) return
    setSectionId(reason.section)
    if (reason.tab) setTabId(reason.tab)
  }, [reason])

  return (
    <div className="overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="overlay__panel sources"
        /* The tour's own name for the dialog, as `inspector-panel` is for the inspector: a step
           that asks the reader to paste a token has to spotlight the form, not the button that
           opens it. */
        data-tour="connections-panel"
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

        {alert && <p className="sources__alert">{alert.message}</p>}

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

        {renderSection(section, { ...tabProps, tabId, setTabId, onClose, onResolved })}
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
        Janelia&rsquo;s connectome server (hemibrain, MANC, maleCNS, etc). Get a token from{' '}
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
      <p className="sources__hint">
        Leave this empty unless you run your own proxy.
        <Why>
          {'Empty means work it out: the deployment is tried directly, and where it sends no ' +
            `CORS headers the same-origin ${DEFAULT_PROXY_PATH} path is used instead — served ` +
            'in development by vite.config.ts, and by nothing at all in a static deploy. Naming ' +
            'a URL here overrides both, with no fallback, and applies to the default deployment ' +
            "only. Not the same thing as a dataset node's Server, which names which neuPrint " +
            'deployment to ask.'}
        </Why>
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

  /** One setter for every probe transition; `undefined` clears, which absorbs the edit case. */
  const setProbe = useCallback((key: string, probe: Probe | undefined) => {
    setProbes((current) => {
      if (!probe) {
        if (!current[key]) return current
        const next = { ...current }
        delete next[key]
        return next
      }
      return { ...current, [key]: probe }
    })
  }, [])

  const patch = useCallback(
    (key: string, change: Partial<CatmaidInstance>) => {
      setRows((current) =>
        current.map((row) => (row.key === key ? { ...row, ...change } : row)),
      )
      // A row that has been edited has not been tested, and a stale green tick beside a changed
      // token is the one thing a Test button must never show.
      setProbe(key, undefined)
    },
    [setProbe],
  )

  const test = useCallback(
    async (row: InstanceRow) => {
      setProbe(row.key, { state: 'testing' })
      const host = hostPattern(row.server)
      if (!host || host.includes('*')) {
        // A pattern names no single host, so there is nothing to call. Said rather than
        // disabled, or the button reads as broken on exactly the rows this feature is for.
        setProbe(row.key, {
          state: 'failed',
          message: host
            ? 'A wildcard covers several hosts, so there is nothing to test. Type one host to check it, then widen it again.'
            : 'Name a server first.',
        })
        return
      }
      try {
        const projects = await listProjects(`https://${host}`, {
          credentials: { ...row, server: host },
        })
        setProbe(row.key, {
          state: 'ok',
          datasets: projects.length,
          names: projects.map((project) => project.title).slice(0, 6),
        })
      } catch (error) {
        setProbe(row.key, { state: 'failed', message: errorMessage(error) })
      }
    },
    [setProbe],
  )

  return (
    <section className="sources__source">
      <p className="sources__note">
        Configure per-CATMAID instances credentials. Access to public instances (e.g. VFB) needs
        no credentials.
        <Why>
          {'Every GET is answered anonymously, but connectivity and neuron names go over POST, ' +
            'which a browser cannot send anonymously, so those need a token. Get one from your ' +
            'instance: hover your name, then “Get API token”.'}
        </Why>
      </p>

      {rows.length === 0 ? (
        <p className="sources__hint">
          None configured — Virtual Fly Brain&rsquo;s servers need none.
          <Why>
            {'They publish a read-only token per instance and Coda carries it, so ' +
              `${hostPattern(DEFAULT_CATMAID_SERVER)} and the other seven work as they are. Add ` +
              'a row for an instance that asks for a credential — or to use your own account on ' +
              'one of theirs, which takes precedence over the published token.'}
          </Why>
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
            const saved = `Saved ${stored.length} CATMAID instance${stored.length === 1 ? '' : 's'}`
            notify(
              dropped > 0
                ? `${saved} — ${dropped} incomplete row${dropped === 1 ? '' : 's'} dropped.`
                : `${saved}.`,
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

/**
 * What the server field means, in the one form both things that read it need.
 *
 * Written twice, it decides *both* which deployment is probed and which one is signed in to, and
 * the two disagreeing would be silent: a token minted at one server, tested against another.
 * `setServer` performs the same normalisation on the way to storage.
 */
function resolveServer(raw: string): string {
  return raw.trim().replace(/\/+$/, '') || DEFAULT_CAVE_SERVER
}

function CaveTab({ onSaved, onResolved }: { onSaved: () => void; onResolved: () => void }) {
  const [token, setTokenField] = useState(() => getCaveToken() ?? '')
  const [server, setServerField] = useState(() => getCaveServer())
  const [session, setSession] = useState(() => getCaveSession())
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const [signing, setSigning] = useState(false)
  /*
   * A second failure channel beside `probe`, and it renders the same markup — kept apart for
   * where it renders rather than for what it says. "Your browser blocked the sign-in window"
   * belongs beside the button that was blocked; drawn where a failed Test lands, under the
   * server field, it reads as a report about the token below it. It also clears differently, and
   * deliberately: a failed `probe` survives an edit to the field, while typing a token is a
   * visible decision to stop signing in, which makes the sign-in's complaint stale.
   */
  const [signInError, setSignInError] = useState<string | undefined>(undefined)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => fieldRef.current?.focus(), [])
  const notify = useGraphStore((s) => s.setNotice)

  /*
   * A sign-in outlives the click that started it, and can outlive the dialog: closing the panel
   * unmounts this tab while the popup is still open, and the poll and the `message` listener
   * inside `signInToCave` would then run until that window happened to be closed — which for an
   * abandoned sign-in is never. Aborting on unmount is what ends them, and aborting *first* in
   * `signIn` is what stops a second click running a second flow beside the first.
   */
  const attempt = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => attempt.current?.abort(), [])

  // With the values it is handed rather than the stored ones, so a token can be checked before
  // committing to it — `NeuPrintTab`'s rule, reached the same way. Taking them as arguments is
  // what lets the sign-in run the same check on a token that is not in the field yet: a
  // `useState` setter a line earlier has not reached this closure.
  const probeWith = useCallback(async (candidate: string, deployment: string) => {
    setProbe({ state: 'testing' })
    try {
      const base = resolveServer(deployment)
      const names = await listDatastacks(base, {
        token: candidate.trim().replace(/^Bearer\s+/i, ''),
      })
      setProbe({ state: 'ok', datasets: names.length, names: names.sort().slice(0, 6) })
    } catch (error) {
      setProbe({ state: 'failed', message: errorMessage(error) })
    }
  }, [])

  /**
   * Sign in, and — unlike anything typed into this dialog — **commit what comes back**.
   *
   * Every other field here is a draft until Save, which is right for text somebody is still
   * editing. A sign-in is not that: the user has already confirmed it at Google, in a window of
   * its own, and leaving the result sitting unsaved in a textarea means the ceremony they just
   * completed is undone by closing the panel. So the token and the deployment it belongs to are
   * stored together, and the same check the Test button runs is run on them, so that "it
   * worked" is on screen rather than assumed. The panel deliberately stays open to show it.
   */
  const signIn = useCallback(() => {
    setSignInError(undefined)
    setSigning(true)
    attempt.current?.abort()
    const cancel = (attempt.current = new AbortController())
    const base = resolveServer(server)
    // Not awaited before the call: `signInToCave` opens its window as its first act, and an
    // `await` between the click and that is exactly what a pop-up blocker looks for.
    signInToCave({ server: base, signal: cancel.signal })
      .then(async ({ token: granted, email }) => {
        const signedIn = { at: Date.now(), ...(email ? { email } : {}) }
        setTokenField(granted)
        setCaveToken(granted, signedIn)
        setCaveServer(base)
        setServerField(base)
        setSession(signedIn)
        // The panel may have opened *because* there was no token. There is one now, so the
        // banner saying there is not stops being true at this line rather than at the next reload.
        onResolved()
        await probeWith(granted, base)
      })
      .catch((error: unknown) => {
        // A cancellation is this component's own doing — an unmount, or a second click — so
        // there is either nobody to tell or a fresh attempt already saying what it is doing.
        if (error instanceof CaveSignInError && error.kind === 'cancelled') return
        setSignInError(errorMessage(error))
      })
      .finally(() => setSigning(false))
  }, [server, probeWith, onResolved])

  return (
    <section className="sources__source">
      <p className="sources__note">
        CAVE hosts e.g. FlyWire, BANC and Minnie. If you already have an CAVE account, make sure
        to use the Google account it is linked to. Signing in for the first time will create a
        new account.
        <Why>
          {'Sign in with the Google account you use for CAVE. The window that opens belongs to ' +
            "CAVE's own auth service, so Coda never sees your password — what comes back is a " +
            'token for CAVE and nothing else. This is a separate sign-in from neuPrint\u2019s, ' +
            'because the two can be different accounts. Signing in for the first time creates a ' +
            'CAVE account and asks you to choose a username before it finishes: that step is ' +
            'part of it, and the sign-in completes when you submit the form. Which datasets the ' +
            'new account may read is CAVE\u2019s to grant, so a query can still be refused ' +
            'after a sign-in that worked.'}
        </Why>
      </p>

      <div className="sources__actions">
        <button type="button" className="btn btn--primary" onClick={signIn} disabled={signing}>
          {signing ? 'Signing in…' : 'Sign in with Google'}
        </button>
        {session && (
          <span className="sources__hint">
            Signed in{session.email ? ` as ${session.email}` : ''}
            <Why>
              {`Signed in on ${new Date(session.at).toLocaleDateString()}. A CAVE sign-in lasts ` +
                'about a week; when it stops being accepted, sign in again.'}
            </Why>
          </span>
        )}
      </div>

      {signInError && (
        <p className="sources__result" data-tone="error">
          {signInError}
        </p>
      )}

      {/*
       * Behind a disclosure, because it is now the second way in rather than the only one — and
       * it stays reachable rather than being dropped, since a sign-in has exits that hand
       * nothing back (a blocked pop-up, and middle_auth's own error pages), and since anybody
       * already using CAVE from Python has a token in `~/.cloudvolume/secrets` to paste.
       */}
      <details className="sources__more">
        <summary>… or paste a token manually</summary>
        <label className="sources__field">
          <span>Token</span>
          <textarea
            ref={fieldRef}
            className="field field--area field--mono"
            rows={2}
            value={token}
            spellCheck={false}
            placeholder="a1b2c3d4…"
            onChange={(e) => {
              setTokenField(e.target.value)
              setSignInError(undefined)
            }}
          />
        </label>
        <p className="sources__hint">
          From{' '}
          <a
            href="https://global.daf-apis.com/auth/api/v1/create_token"
            target="_blank"
            rel="noreferrer"
          >
            global.daf-apis.com
          </a>
          <Why>
            {'The same token caveclient stores in ~/.cloudvolume/secrets, so if you already use ' +
              'CAVE from Python you have one. Pasting is also the way through if your browser ' +
              'blocks the sign-in window, or if that window ends on an error page.'}
          </Why>
        </p>
      </details>

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
      <p className="sources__hint">
        Leave this alone unless you use a different CAVE deployment.
        <Why>
          {'It is the service that lists datastacks and says which server holds each one; the ' +
            'server that answers the actual queries is read from that listing rather than named ' +
            'here. It is also what says where to sign in, which is why signing in saves it. Not ' +
            "the same thing as a dataset node's version, which names a materialization."}
        </Why>
      </p>

      <div className="sources__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void probeWith(token, server)}
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
            setSession(undefined)
            setProbe({ state: 'idle' })
            setSignInError(undefined)
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
            // A typed token is somebody else's, so whatever the last sign-in was labelled with
            // goes with it — `setToken` clears the session unless one is handed over, which is
            // why this is `undefined` rather than a read-back.
            setCaveToken(token)
            setCaveServer(server)
            setSession(undefined)
            if (token.trim()) onResolved()
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
  const [think, setThinkField] = useState(() => getThinking(provider.id))
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
        {/* Last, so the note reads as a summary of a page rather than around a link in it. */}
        {provider.guideUrl && (
          <>
            {' '}
            <a href={provider.guideUrl} target="_blank" rel="noreferrer">
              Full setup guide
            </a>
            .
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

      {/*
       * A speed control, so the hint states the measurement rather than describing the switch.
       * Off by default: on a reasoning model the thinking is most of the wait — 254 s against
       * 49 s for the same question — and the plans did not get worse without it.
       */}
      {provider.thinkingSwitch && (
        <div className="sources__field">
          <label className="sources__check">
            <input
              type="checkbox"
              checked={think}
              onChange={(e) => setThinkField(e.target.checked)}
            />
            <span>Let the model reason before answering</span>
          </label>
          <span className="sources__hint">
            Slower, often by a lot — one measured question took 254s with reasoning and 49s
            without, for plans that were as good. Turn it on if a request comes back wrong.
          </span>
        </div>
      )}

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
            if (provider.thinkingSwitch) setThinking(provider.id, think)
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
