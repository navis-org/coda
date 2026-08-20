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
 * rules — the ~28k-character system prompt — and `await import()`ing it here is what keeps that
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
import { isConfigured, subscribeCredentials } from '../../data/ai/credentials'
import { errorMessage } from '../../core/errors'
import { useGraphStore } from '../../store/graphStore'
import type { ChatEntry } from '../assistantChat'
import {
  appendChat,
  chatBusy,
  chatEntries,
  clearChat,
  setChatBusy,
  subscribeChat,
} from '../assistantChat'

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

function Drawer({ takeFocus }: { takeFocus: boolean }) {
  const entries = useSyncExternalStore(subscribeChat, chatEntries)
  const busy = useSyncExternalStore(subscribeChat, chatBusy)
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
    setChatBusy(true)

    try {
      // Loaded here, not imported at the top: this is the module that carries the catalogue,
      // and nothing should pay for it before a question is asked.
      const { runTurn } = await import('../../assistant/converse')
      const store = useGraphStore.getState

      const outcome = await runTurn({
        request: text,
        graph: () => store().graph,
        apply: (plan) => store().applyAssistantPlan(plan),
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
        })
      } else {
        appendChat({
          kind: 'failed',
          text: outcome.error,
          ...(outcome.errors ? { detail: outcome.errors } : {}),
        })
      }
    } catch (error) {
      appendChat({ kind: 'failed', text: errorMessage(error) })
    } finally {
      setChatBusy(false)
      // After the log has grown, not before — otherwise it scrolls to where it used to end.
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      })
    }
  }, [draft])

  const ready = useSyncExternalStore(subscribeCredentials, isConfigured)

  return (
    <aside className="assistant" aria-label="Assistant">
      <header className="assistant__header">
        <h2 className="assistant__title">Assistant</h2>
        <span className="assistant__hint">
          {ready ? 'Describe a change to the graph.' : 'Needs a provider.'}
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
                toolbar — Anthropic, OpenAI, Gemini, or a model running locally under Ollama.
                Nothing else in Coda needs one.
              </>
            )}
          </p>
        )}
        {entries.map((entry, index) => (
          <Entry key={index} entry={entry} />
        ))}
        {busy && <p className="assistant__working">Thinking…</p>}
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
          placeholder={ready ? 'Ask for a change…' : 'Pick a provider under Connections first'}
          disabled={!ready}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!ready || busy || !draft.trim()}
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
