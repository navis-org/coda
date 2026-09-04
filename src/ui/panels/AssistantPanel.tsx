/**
 * The assistant drawer: ask for a change, and watch it happen to the graph above.
 *
 * **A plan lands immediately, and that is the design rather than a shortcut.** `applyPlan` has
 * already checked every wire against the same `checkConnection` a drag runs, the whole edit is
 * one Ctrl-Z, and the canvas is directly above — so the graph *is* the preview, and a confirm
 * step would be a click for something you can already see and reverse. What the panel owes in
 * return is an honest account of what changed, which is the summary line, the tally, and
 * anything the edit left for you to finish.
 *
 * **The heavy half is loaded on demand.** `converse.ts` carries the node catalogue and the
 * rules — the ~65k-character system prompt — and `await import()`ing it here is what keeps that
 * out of the main chunk until somebody asks a question. Same doctrine as elkjs and the
 * exporters: verify with `pnpm build` that `converse-*.js` stays its own chunk and that the
 * prompt's own text is absent from `main-*.js`.
 *
 * Note what does *not* stay out, having been measured rather than assumed: `data/ai/` is in the
 * main chunk regardless, because the Connections panel's Test button calls into it. It is one endpoint's worth of fetch and error mapping, and the
 * expensive thing was never the client.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { countPlanParams } from '../../assistant/planShape'
import {
  getModel,
  getProviderId,
  isConfigured,
  subscribeCredentials,
} from '../../data/ai/credentials'
import { providerFor } from '../../data/ai/providers'
import { errorMessage } from '../../core/errors'
import { useGraphStore } from '../../store/graphStore'
import type { ChatEntry } from '../assistantChat'
import {
  appendChat,
  chatBusy,
  chatBusySince,
  chatEntries,
  clearChat,
  setChatBusy,
  stopChat,
  subscribeChat,
} from '../assistantChat'

/**
 * How long a wait goes unnarrated.
 *
 * A cloud provider answers inside this and the line never changes, which is the point — a
 * counter on a two-second wait is noise. Past it the number is the only thing distinguishing a
 * model that is working from one that is not, and Ollama on a 27B model spends three to five
 * minutes on Coda's prompt.
 */
const NARRATE_AFTER_MS = 4000

/**
 * When a wait stops looking normal and starts looking broken.
 *
 * Not a limit and not a timeout — the request is still running and may well answer. It is the
 * point at which somebody watching deserves to be told that this is what a local model does,
 * rather than left to conclude the app has hung. Which is what happened: reported as "goes to
 * Thinking and never returns anything", against a request that would have answered.
 */
const SLOW_AFTER_MS = 45_000

/**
 * Who is about to answer, as one line.
 *
 * **A string rather than an object, which is what makes one subscription enough.** Invariant 7
 * is about *identity*: `useSyncExternalStore` compares snapshots with `Object.is`, so a getter
 * returning `{provider, model}` allocates a fresh object every render and never settles. A
 * string is compared by value, so composing it here is free — where reading the three parts
 * through three separate subscriptions and joining them in the component was three listeners
 * and three locals kept in step to reach the same sentence.
 *
 * **Generic until something can actually answer, because a declared default is not a decision**
 * — `resolveColumn`'s rule, and the one the model picker two panels over already follows when
 * it refuses to swap a name somebody chose. `getProviderId` never answers "none": it falls back
 * to `DEFAULT_PROVIDER`, so a browser that has never been configured reports Anthropic just as
 * loudly as one where it was picked. An earlier version printed that — `Anthropic — needs a key`
 * on a first-ever visit, which reads as a choice the reader made and now has to undo, and
 * quietly recommends one of four providers to somebody who has not been shown the other three.
 *
 * Nor can the store tell the two apart, and that is not an oversight to route around:
 * `setProviderId` deliberately stores *nothing* for a value equal to the default, so choosing
 * Anthropic on purpose and never opening the panel are the same bytes. Any attempt to name the
 * provider here would be right for three providers and wrong for the default one, which is a
 * worse failure than saying less — the fix is identical in every case, and the drawer's empty
 * state names all four.
 */
function describeSelection(): string {
  if (!isConfigured()) return 'No provider set'
  const id = getProviderId()
  // `providerFor` cannot miss: `getProviderId` resolves an unknown stored id to the default.
  return `${providerFor(id)!.label} · ${getModel(id)}`
}

export function AssistantPanel() {
  const open = useGraphStore((s) => s.panels.assistant)
  /*
   * Whether this opening was *asked for*, so the ask box can take focus when somebody presses
   * `/` without stealing it at startup — the drawer's open state is remembered, so a reload can
   * arrive with it already open, and a page that grabs the caret before you have looked at it
   * is worse than one extra click. Mount-seeded, the same idiom `paletteRequest` uses.
   */
  const seen = useRef(open)
  const asked = open && !seen.current
  seen.current = open

  if (!open) return null
  return <Drawer takeFocus={asked} />
}

/**
 * Seconds since the wait started, ticking.
 *
 * Reads the *start* from the chat module and counts from it here, rather than storing an
 * elapsed value that something would have to keep current: the store notifies on real events,
 * and a clock is not one. The interval exists only while a question is in flight.
 */
function useElapsed(busy: boolean): number {
  const since = useSyncExternalStore(subscribeChat, chatBusySince)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy, since])
  return since ? now - since : 0
}

/** `2:41`, so a five-minute wait does not have to be read as `321s`. */
function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function Drawer({ takeFocus }: { takeFocus: boolean }) {
  const entries = useSyncExternalStore(subscribeChat, chatEntries)
  const busy = useSyncExternalStore(subscribeChat, chatBusy)
  const elapsed = useElapsed(busy)
  const [draft, setDraft] = useState('')
  const togglePanel = useGraphStore((s) => s.togglePanel)
  const logRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (takeFocus) askRef.current?.focus()
  }, [takeFocus])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || chatBusy()) return

    setDraft('')
    appendChat({ kind: 'you', text })
    const controller = new AbortController()
    setChatBusy(true, controller)

    try {
      // Loaded here, not imported at the top: this is the module that carries the catalogue,
      // and nothing should pay for it before a question is asked.
      const { runTurn } = await import('../../assistant/converse')
      const store = useGraphStore.getState

      const outcome = await runTurn({
        request: text,
        graph: () => store().graph,
        /*
         * The editor's own inference, not a fresh one. It is the only one that carries what a
         * Pivot or a raw Cypher *actually* produced — the store folds those observations in on
         * every commit — and inferring again here would hand the model the bare answer that
         * made it leave those pickers unset.
         */
        inference: () => store().inference,
        apply: (plan) => store().applyAssistantPlan(plan),
        signal: controller.signal,
      })

      if (outcome.ok) {
        appendChat({
          kind: 'done',
          summary: outcome.plan.summary || 'Done.',
          added: outcome.plan.add.length,
          wired: outcome.plan.connect.length,
          settings: countPlanParams(outcome.plan),
          removed: outcome.plan.remove.length,
          warnings: outcome.applied.warnings,
          graph: outcome.applied.graph,
          model: outcome.model,
        })
      } else {
        appendChat({
          kind: 'failed',
          text: outcome.error,
          ...(outcome.errors ? { detail: outcome.errors } : {}),
        })
      }
    } catch (error) {
      // A cancel is not a failure, and reporting it in the error tone would be the panel
      // blaming the model for something the user did. `requestPlan` keeps it a DOMException all
      // the way up precisely so this can be told apart here.
      if (error instanceof DOMException && error.name === 'AbortError') {
        appendChat({ kind: 'stopped' })
      } else {
        appendChat({ kind: 'failed', text: errorMessage(error) })
      }
    } finally {
      setChatBusy(false)
      // After the log has grown, not before — otherwise it scrolls to where it used to end.
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      })
    }
  }, [draft])

  const ready = useSyncExternalStore(subscribeCredentials, isConfigured)
  /*
   * Who is about to answer, read as two primitives rather than one object.
   *
   * Invariant 7: `useSyncExternalStore` compares snapshots by identity, so a getter returning
   * `{provider, model}` would allocate a fresh object on every render and never settle. Both of
   * these are strings out of module state, so they are stable between real changes — and
   * `getModel()` defaults its argument to the selected provider, which is what keeps the two
   * from disagreeing about *whose* model is being named.
   */
  const using = useSyncExternalStore(subscribeCredentials, describeSelection)
  /*
   * A locked canvas refuses a plan at `applyAssistantPlan`, which is the right backstop and the
   * wrong place to *first* find out: the request has been to the model and back by then, and the
   * answer was knowable before it was sent. So the composer stands down the way it does with no
   * provider configured — same control, same explanation in the placeholder.
   */
  const locked = useGraphStore((s) => s.locked)

  return (
    <aside className="assistant" aria-label="Assistant">
      <header className="assistant__header">
        <h2 className="assistant__title">Assistant</h2>
        {/*
         * What is answering, in the slot that used to say "Describe a change to the graph." —
         * which the empty state and the input's own placeholder both already say, so the line
         * was spending the one piece of always-visible chrome on a restatement.
         *
         * `title` carries it in full because the header truncates: a model id is as long as
         * whoever named it felt like (`deepseek-v4-flash:0731-cloud`), and this sits in a flex
         * row with Clear and ✕ on the other side of a spacer.
         */}
        <span className="assistant__hint" title={using}>
          {using}
        </span>
        <div className="toolbar__spacer" />
        {entries.length > 0 && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={clearChat}
            title="Clear the conversation. The graph is untouched."
          >
            Clear
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => togglePanel('assistant')}
          aria-label="Close assistant"
        >
          ✕
        </button>
      </header>

      <div className="assistant__log" ref={logRef}>
        {entries.length === 0 && (
          <p className="assistant__empty">
            {ready ? (
              <>
                Ask for a pipeline — “find LC4 neurons and chart their strongest partners” — or
                a change to what is already here. Every edit is one undo.
              </>
            ) : (
              <>
                Pick a provider under <strong>Connections</strong> — the branch icon in the
                toolbar — Anthropic, OpenAI, Gemini, or Ollama, which runs a model on your own
                machine or fronts a free one in its cloud.
                Nothing else in Coda needs one.
              </>
            )}
          </p>
        )}
        {entries.map((entry, index) => (
          <Entry key={index} entry={entry} />
        ))}
        {busy && (
          <div className="assistant__working">
            <span>Thinking{elapsed >= NARRATE_AFTER_MS ? ` — ${clock(elapsed)}` : '…'}</span>
            <button type="button" className="btn btn--ghost" onClick={stopChat}>
              Stop
            </button>
          </div>
        )}
        {busy && elapsed >= SLOW_AFTER_MS && (
          <p className="assistant__note">
            Still going. A model running locally can take several minutes on a prompt this size
            — the whole node catalogue goes with every question.
          </p>
        )}
      </div>

      <form
        className="assistant__ask"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          ref={askRef}
          className="field"
          value={draft}
          placeholder={
            locked
              ? 'The canvas is locked — unlock it to ask for a change'
              : ready
                ? 'Ask for a change…'
                : 'Pick a provider under Connections first'
          }
          disabled={!ready || locked}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!ready || locked || busy || !draft.trim()}
        >
          Ask
        </button>
      </form>
    </aside>
  )
}

function Entry({ entry }: { entry: ChatEntry }) {
  if (entry.kind === 'you') {
    return <p className="assistant__said">{entry.text}</p>
  }

  if (entry.kind === 'stopped') {
    return <p className="assistant__note">Stopped. Nothing was changed.</p>
  }

  if (entry.kind === 'failed') {
    return (
      <div className="assistant__entry" data-tone="error">
        <p className="assistant__summary">{entry.text}</p>
        {entry.detail && (
          <ul className="assistant__detail">
            {entry.detail.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return <Applied entry={entry} />
}

function Applied({ entry }: { entry: Extract<ChatEntry, { kind: 'done' }> }) {
  /*
   * Undo is offered only while this edit is still the one on top of the stack. `undo()` is
   * global, so a button on an older message would take back whatever the user did since —
   * comparing the graph it produced by identity is the cheap, exact test for that.
   */
  const undo = useGraphStore((s) => s.undo)
  /*
   * The boolean, not the graph. `commit` mints a fresh graph object on *every* frame of a
   * pointer gesture, not only committing ones — so selecting `s.graph` re-rendered every entry
   * in the transcript at drag rate to recompute an answer that changes once in its life.
   * Invariant 7's rule, and the comparison is the question anyway.
   */
  const undoable = useGraphStore((s) => s.graph === entry.graph)

  const tally = [
    entry.added && `${entry.added} node${entry.added === 1 ? '' : 's'}`,
    entry.wired && `${entry.wired} wire${entry.wired === 1 ? '' : 's'}`,
    entry.settings && `${entry.settings} setting${entry.settings === 1 ? '' : 's'}`,
    entry.removed && `${entry.removed} removed`,
  ].filter(Boolean) as string[]

  return (
    <div className="assistant__entry">
      <p className="assistant__summary">{entry.summary}</p>
      <div className="assistant__meta">
        {tally.length > 0 && <span className="assistant__tally">{tally.join(' · ')}</span>}
        {/*
         * Which model made *this* edit. Worth its own element rather than another item in the
         * tally: the tally counts what changed, and a model name joined into that list with the
         * same separator would read as a fifth quantity.
         */}
        <span className="assistant__by">{entry.model}</span>
        <div className="toolbar__spacer" />
        {undoable && (
          <button type="button" className="btn btn--ghost" onClick={undo}>
            Undo
          </button>
        )}
      </div>
      {/*
       * What the edit left for you. An unset column picker is genuinely unknowable before the
       * graph has run — a Pivot publishes no schema until then — so it is not a failure, but
       * nothing else on screen would point at it.
       */}
      {entry.warnings.length > 0 && (
        <ul className="assistant__warnings">
          {entry.warnings.map((warning, index) => (
            <li key={index} data-severity={warning.severity}>
              <strong>{warning.label}</strong> {warning.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
