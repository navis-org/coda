/**
 * The Workflow Wizard: four questions, then a graph.
 *
 * What it replaced were four bundled example graphs. Those answered "show me what a pipeline
 * looks like" and could not answer "give me one for *my* dataset" — the reply was always "open
 * this one and swap the dataset node", which teaches the app rather than answering the question.
 * Four answers produce a graph pointed where the reader is going, and every combination is held
 * to the standard the examples were (`wizard.test.ts`).
 *
 * ## Why picking an answer advances
 *
 * Each question is a list of two to five options and every option is a complete answer, so a
 * Next button would be a second click confirming the first. Back is always there, the summary
 * comes before anything is built, and Escape leaves without touching the canvas — those three
 * are what make an immediate advance safe rather than hasty.
 *
 * ## Why the summary exists
 *
 * It is the only screen that can show the *consequence* of four answers, which is a chain of
 * nodes, and it is where the two things that are not questions live: whether notes come with it,
 * and the replace-graph confirmation. Building on the fourth click would have to ask about
 * replacing a graph in the middle of a question, which is where a reader is least able to judge
 * it.
 *
 * ## Two rules the option lists follow
 *
 * **The answers narrow as they go** (`options.ts`), so a source that cannot be browsed never
 * offers Explore and a synthetic dataset never offers Neuroglancer. **An answer that is no longer
 * available is replaced rather than kept**: going back and switching to a dataset that has no
 * skeletons cannot leave "morphology" selected underneath, which would build a graph nobody could
 * have asked for. That is `resolveOption`, applied on the way *out* of the state rather than as a
 * repair on the way in — so it cannot be skipped by a path that forgot to repair.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { useDismissOnOutside } from '../useDismiss'
import { datasetGlyph } from '../nodes/DatasetPreview'
import { BACKENDS } from '../../nodes/lib/datasetFamilies'
import { GlyphSvg } from './startGlyphs'
import { buildWorkflow } from '../../wizard/build'
import type { AnalysisId, StartId, VisualisationId } from '../../wizard/options'
import {
  WIZARD_LABEL,
  analysisOptions,
  datasetOptions,
  resolveOption,
  startOptions,
  visualisationOptions,
} from '../../wizard/options'
import { isAnnotation, requireNodeDef } from '../../core/registry'
import { plural } from '../format'
import type { CodaGraph } from '../../core/graph'

export function WizardDialog() {
  const open = useGraphStore((s) => s.wizardOpen)
  if (!open) return null
  return <Dialog />
}

/** How many questions there are. The summary is the step after the last of them. */
const QUESTIONS = 4

function Dialog() {
  const close = useGraphStore((s) => s.closeWizard)
  const openDocument = useGraphStore((s) => s.openDocument)
  const notes = useGraphStore((s) => s.wizardNotes)
  const setNotes = useGraphStore((s) => s.setWizardNotes)
  const dashboard = useGraphStore((s) => s.wizardDashboard)
  const setDashboard = useGraphStore((s) => s.setWizardDashboard)

  const datasets = useMemo(() => datasetOptions(), [])
  const [dataset, setDataset] = useState(() => datasets[0]?.key ?? '')
  /*
   * Browsing is the default way in: it is the answer that needs nothing typed and shows the reader
   * what is in the dataset before asking them to name anything. A source that cannot be browsed
   * has no `browse` option, and `resolveOption` moves the answer to the first one it does have.
   */
  const [chosenStart, setStart] = useState<StartId>('browse')
  const [chosenAnalysis, setAnalysis] = useState<AnalysisId>('partners')
  /*
   * A set, because a reader may want a table *and* a chart of the same thing — two viewers off
   * one chain rather than two workflows. Order is the order they were ticked, which is the order
   * they are stacked on the canvas.
   */
  const [chosenViews, setViews] = useState<VisualisationId[]>(['table'])
  const [step, setStep] = useState(0)

  const panelRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(panelRef, close, { onEscape: true })
  const starts = useMemo(() => startOptions(dataset), [dataset])
  const analyses = useMemo(() => analysisOptions(dataset), [dataset])

  /*
   * The answers, **resolved rather than repaired**.
   *
   * The rule is that an answer the new dataset cannot support is replaced and never kept: going
   * back and switching to a dataset with no skeletons must not leave "morphology" selected
   * underneath, which would build a graph the wizard never offered and whose origin is two
   * screens back. Written as a repair inside the click handlers, that rule had to anticipate the
   * *next* dataset — so it re-ran all three option functions by hand and lived entirely in JSX,
   * where `wizard.test.ts` could not reach it. Resolved on the way out it cannot be skipped, and
   * `resolveOption` is headless.
   */
  const start = resolveOption(starts, chosenStart, 'browse')
  const analysis = resolveOption(analyses, chosenAnalysis, 'neurons')
  const views = useMemo(() => visualisationOptions(dataset, analysis), [dataset, analysis])
  /*
   * The ticked viewers this analysis can actually end on, and never none: switching analysis
   * drops the viewers the new one does not offer, and if that empties the set the first viewer it
   * *does* offer stands in — the same rule `resolveOption` applies to the single answers, which a
   * set has to state for itself.
   */
  const offered = chosenViews.filter((id) => views.some((option) => option.id === id))
  const visualisations = offered.length ? offered : [resolveOption(views, 'table', 'table')]

  const pick = {
    dataset: (key: string) => {
      setDataset(key)
      setStep(1)
    },
    start: (id: StartId) => {
      setStart(id)
      setStep(2)
    },
    analysis: (id: AnalysisId) => {
      setAnalysis(id)
      setStep(3)
    },
    /**
     * Tick or untick one viewer, and stay on the question.
     *
     * The other three questions advance on the answer, because each of them *is* one answer. This
     * one is a set, so it needs somewhere to stop — the footer's Continue — and unticking the last
     * one is refused rather than allowed: an empty set builds a chain with nothing on the end of
     * it, and the reader who wanted that wants a different analysis.
     */
    visualisation: (id: VisualisationId) => {
      setViews((current) => {
        const without = current.filter((one) => one !== id)
        if (!current.includes(id)) return [...current, id]
        return without.length ? without : current
      })
    },
  }

  /*
   * Built once, and the same object the summary lists and the button loads.
   *
   * Keyed on the five answers rather than on the object holding them, which is minted fresh on
   * every render — so the memo it was written as never hit, and `buildWorkflow` ran again on
   * every checkbox toggle *and* a second time inside `create`.
   */
  /*
   * The viewers key the memo by their *contents*: `visualisations` is derived on every render, so
   * a fresh array holding the same ids is the same answer and must not rebuild the graph. Hoisted
   * into a variable because a dependency array cannot hold an expression and be checked.
   */
  const viewKey = visualisations.join(',')
  const graph = useMemo(
    () =>
      buildWorkflow({
        dataset,
        start,
        analysis,
        visualisations: viewKey.split(',') as VisualisationId[],
        notes,
        dashboard,
      }),
    [dataset, start, analysis, viewKey, notes, dashboard],
  )

  // Nothing is asked first: a generated workflow opens in a document of its own, so whatever was
  // on the canvas is still open beside it. This used to arm a replace-confirm on the summary.
  const create = () => {
    openDocument(graph)
    close()
  }

  const back = () => {
    if (step === 0) close()
    else setStep(step - 1)
  }

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panelRef}
        className="overlay__panel wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
      >
        <header className="sources__header">
          <h2 id="wizard-title">{WIZARD_LABEL}</h2>
          <button type="button" className="btn btn--ghost" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="wizard__body">
          {step === 0 && (
            <Question
              title="Which dataset?"
              hint="Pick the dataset you want to work with. You can change it on the canvas afterwards."
            >
              {datasets.map((family) => (
                <Option
                  key={family.key}
                  selected={family.key === dataset}
                  label={family.label}
                  /*
                   * Which backend serves it, beside the name — two datasets can look alike and
                   * answer very differently, and the backend is what decides that. Read through
                   * `BACKENDS` rather than the source id, so both CATMAID servers say CATMAID.
                   * Blank for the synthetic family, whose label in that table is deliberately
                   * empty: `Demo Data (Mock)` is the name a rule produces when nobody checked it
                   * against the values.
                   */
                  where={BACKENDS[family.backend]?.label}
                  blurb={family.description}
                  onPick={() => pick.dataset(family.key)}
                  glyph={
                    <GlyphSvg className="wizard__glyph" viewBox="0 0 52 46">
                      {datasetGlyph(family.glyph)}
                    </GlyphSvg>
                  }
                />
              ))}
            </Question>
          )}

          {step === 1 && (
            <Question
              title="Which neurons?"
              hint="How you want to define the set of neurons you want to work with."
            >
              {starts.map((option) => (
                <Option
                  key={option.id}
                  selected={option.id === start}
                  label={option.label}
                  blurb={option.blurb}
                  onPick={() => pick.start(option.id)}
                />
              ))}
            </Question>
          )}

          {step === 2 && (
            <Question
              title="What do you want to know or do?"
              hint="The question the workflow is supposed to answer."
            >
              {analyses.map((option) => (
                <Option
                  key={option.id}
                  selected={option.id === analysis}
                  label={option.label}
                  blurb={option.blurb}
                  onPick={() => pick.analysis(option.id)}
                />
              ))}
            </Question>
          )}

          {step === 3 && (
            <Question
              title="How should it look?"
              hint="What ends the chain — tick as many as you want. Viewers pass their input through, so you can add more after them."
            >
              {views.map((option) => (
                <Option
                  key={option.id}
                  selected={visualisations.includes(option.id)}
                  multiple
                  label={option.label}
                  blurb={option.blurb}
                  onPick={() => pick.visualisation(option.id)}
                />
              ))}
            </Question>
          )}

          {step === QUESTIONS && (
            <Summary
              graph={graph}
              notes={notes}
              onNotes={setNotes}
              dashboard={dashboard}
              onDashboard={setDashboard}
            />
          )}
        </div>

        <div className="wizard__foot">
          <span className="wizard__progress">
            {step < QUESTIONS ? `Question ${step + 1} of ${QUESTIONS}` : 'Ready to build'}
          </span>
          <span className="toolbar__spacer" />
          <button type="button" className="btn" onClick={back}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {/* The multi-select question is the one that cannot advance on a click — see `pick`. */}
          {step === QUESTIONS - 1 && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setStep(QUESTIONS)}
            >
              Continue
            </button>
          )}
          {step === QUESTIONS && (
            <button type="button" className="btn btn--primary" onClick={create}>
              Create workflow
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Question({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <section className="wizard__question">
      <h3>{title}</h3>
      <p className="wizard__hint">{hint}</p>
      <ul className="wizard__options">{children}</ul>
    </section>
  )
}

function Option({
  label,
  where,
  blurb,
  selected,
  multiple,
  glyph,
  onPick,
}: {
  label: string
  /** A qualifier after the name — the backend a dataset is served by. */
  where?: string
  blurb: string
  selected: boolean
  /** One of several, rather than one of many: draws a checkbox and does not advance. */
  multiple?: boolean
  glyph?: React.ReactNode
  onPick: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  // The answer already given, so Enter repeats it and a reader coming Back sees where they were.
  useEffect(() => {
    if (selected) ref.current?.focus()
  }, [selected])

  return (
    <li>
      <button
        type="button"
        ref={ref}
        className="wizard__option"
        data-selected={selected ? '' : undefined}
        /* A checkbox for the question that takes a set, so the row says what a click will do
           before it is clicked — and reads as one to a screen reader, which `aria-pressed` on a
           button that also advances would not. */
        {...(multiple ? { role: 'checkbox', 'aria-checked': selected } : {})}
        onClick={onPick}
      >
        {glyph}
        <span className="wizard__text">
          <span className="wizard__label">
            {label}
            {/* A real space, not a margin: the margin is what the eye reads, and the space is
                what a screen reader and a copy-paste read. */}
            {where ? (
              <>
                {' '}
                <span className="wizard__where">({where})</span>
              </>
            ) : null}
          </span>
          <span className="wizard__blurb">{blurb}</span>
        </span>
        {multiple && (
          <span className="wizard__tick" aria-hidden="true">
            {selected ? '✓' : ''}
          </span>
        )}
      </button>
    </li>
  )
}

/**
 * What will be built, as the chain of cards it is.
 *
 * Read off **the graph that will be loaded**, rather than described a second time or built a
 * second time: `buildWorkflow` is the only thing that knows a partners workflow is five nodes, a
 * summary listing them from its own table would be a second answer to that question, and one
 * building its own copy would be showing a chain that is merely *like* the one the button loads.
 * Notes are dropped from the list rather than from the build, so the count cannot differ from
 * what lands on the canvas.
 */
function Summary({
  graph,
  notes,
  onNotes,
  dashboard,
  onDashboard,
}: {
  graph: CodaGraph
  notes: boolean
  onNotes: (enabled: boolean) => void
  dashboard: boolean
  onDashboard: (enabled: boolean) => void
}) {
  const chain = useMemo(
    () =>
      graph.nodes
        .filter((node) => !isAnnotation(node.type))
        .map((node) => requireNodeDef(node.type).label),
    [graph],
  )

  /*
   * Read off the layout the graph is carrying rather than counted from the answers: `dashboardFor`
   * decides which nodes are worth a cell, and a second count here would be a second opinion about
   * that — wrong on the day it changes, in the one place the reader is deciding whether to press
   * the button.
   */
  const cells = graph.dashboard?.cells.length ?? 0
  const controls = graph.dashboard?.cells[0]
    ? requireNodeDef(graph.nodes.find((n) => n.id === graph.dashboard!.cells[0]!.nodeId)!.type)
        .label
    : ''

  return (
    <section className="wizard__question">
      <h3>Ready to build</h3>
      <p className="wizard__hint">
        Every node is an ordinary one — change anything, add anything, delete what you do not
        need.
      </p>

      <ol className="wizard__chain">
        {chain.map((label, index) => (
          <li key={`${label}-${index}`}>{label}</li>
        ))}
      </ol>

      {/*
       * The two things on this screen that are not answers to a question: what comes with the
       * workflow, and which view it lands in. Both are remembered, because both are statements
       * about how this reader likes to be handed a workflow rather than about the workflow.
       */}
      <label className="wizard__notes">
        <input type="checkbox" checked={notes} onChange={(e) => onNotes(e.target.checked)} />
        <span>
          Add explanatory notes to the canvas
          <em>Remembered for next time.</em>
        </span>
      </label>

      <label className="wizard__notes">
        <input
          type="checkbox"
          checked={dashboard}
          onChange={(e) => onDashboard(e.target.checked)}
        />
        <span>
          Open as a dashboard
          <em>
            {cells > 1
              ? `A grid of ${cells} cells — the ${controls} and the ${plural(cells - 1, 'view')}. The canvas is a click away.`
              : 'Shows the result on its own grid. The canvas is a click away.'}
          </em>
        </span>
      </label>
    </section>
  )
}
