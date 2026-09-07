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
import { GLYPH_STROKE_WIDTH, GLYPH_VIEWBOX, SPECIMEN_VIEWBOX } from '../glyphs'
import { GlyphSvg } from './startGlyphs'
import { nodeGlyph } from './NodeThumbnail'
import { buildWorkflow } from '../../wizard/build'
import type { AnalysisId, StartId, VisualisationId } from '../../wizard/options'
import {
  MULTI_DATASET,
  WIZARD_LABEL,
  analysisOptions,
  datasetOptions,
  glyphNodeOf,
  maxWizardDatasets,
  multiDatasetOptions,
  resolveOption,
  resolveVisualisations,
  startOptions,
  visualisationOptions,
} from '../../wizard/options'
import { getNodeDef, isAnnotation, requireNodeDef } from '../../core/registry'
import { plural } from '../format'
import type { CodaGraph } from '../../core/graph'

export function WizardDialog() {
  const open = useGraphStore((s) => s.wizardOpen)
  if (!open) return null
  return <Dialog />
}

/**
 * The questions, in order — **a list rather than a count**, because there are four or five of
 * them and which depends on the first answer.
 *
 * `QUESTIONS = 4` and a scattering of `step === 2` was the shape this replaced, and it does not
 * survive an inserted question: every literal after the insertion point means a different screen
 * depending on an answer two of them cannot see. A list makes "which screen is this" one lookup
 * and "how many are there" one length, and the summary stays the step after the last of them.
 */
type StepId = 'dataset' | 'datasets' | 'start' | 'analysis' | 'views'

const STEPS: readonly StepId[] = ['dataset', 'start', 'analysis', 'views']

/**
 * The cross-dataset path **inserts one screen** after the first and moves nothing else — derived
 * from `STEPS` rather than written out again, so the two orders cannot drift apart.
 */
const MULTI_STEPS: readonly StepId[] = [STEPS[0]!, 'datasets', ...STEPS.slice(1)]

function stepsFor(multi: boolean): readonly StepId[] {
  return multi ? MULTI_STEPS : STEPS
}

/**
 * Why the datasets question cannot be left yet, or the empty string.
 *
 * Both floors in one sentence, because they are the same refusal from the reader's side: this
 * screen has not yet produced a set that anything can be asked of. The second is the one no other
 * question has — `analysisOptions` intersects over every ticked dataset, so a pair with no shared
 * capability leaves it empty, and an empty third question is a wizard that offers nothing and then
 * builds something anyway.
 *
 * Out of the render body and taking only what it reads, so the rule is one function rather than a
 * three-deep conditional whose two empty results mean different things.
 */
function blockedReason(
  at: StepId | undefined,
  ticked: readonly string[],
  analyses: readonly unknown[],
): string {
  if (at !== 'datasets') return ''
  if (ticked.length < 2) return 'Tick at least two datasets'
  if (analyses.length === 0) return 'These datasets have no analysis in common'
  return ''
}

function Dialog() {
  const close = useGraphStore((s) => s.closeWizard)
  const openDocument = useGraphStore((s) => s.openDocument)
  const notes = useGraphStore((s) => s.wizardNotes)
  const setNotes = useGraphStore((s) => s.setWizardNotes)
  const dashboard = useGraphStore((s) => s.wizardDashboard)
  const setDashboard = useGraphStore((s) => s.setWizardDashboard)
  /*
   * The viewers turned off, remembered per profile beside the notes and dashboard checkboxes.
   * A plain field read straight out, never a derived array — invariant 7: the store is compared
   * by identity, so a selector that filtered here would re-render on every unrelated set.
   */
  const viewsOff = useGraphStore((s) => s.wizardViewsOff)
  const setViewsOff = useGraphStore((s) => s.setWizardViewsOff)
  const arrange = useGraphStore((s) => s.wizardArrange)
  const setArrange = useGraphStore((s) => s.setWizardArrange)
  const requestArrange = useGraphStore((s) => s.requestArrange)

  const families = useMemo(() => datasetOptions(), [])
  const [dataset, setDataset] = useState(() => families[0]?.key ?? '')
  /*
   * The cross-dataset path: whether the reader took it, and which connectomes they ticked.
   *
   * Two pieces of state and no third saying "this is a comparison" — `datasets` below is the
   * answer, `isMulti` reads its length, and `WizardAnswers` carries nothing else. The boolean
   * here is about the *dialog* (which screens there are), not about the workflow, which is why
   * it does not travel: a `multi: true` that outlived a Back to the first question would build a
   * comparison out of one dataset.
   */
  const [multi, setMulti] = useState(false)
  const [ticked, setTicked] = useState<string[]>([])
  /*
   * Browsing is the default way in: it is the answer that needs nothing typed and shows the reader
   * what is in the dataset before asking them to name anything. A source that cannot be browsed
   * has no `browse` option, and `resolveOption` moves the answer to the first one it does have.
   */
  const [chosenStart, setStart] = useState<StartId>('browse')
  const [chosenAnalysis, setAnalysis] = useState<AnalysisId>('partners')
  const [step, setStep] = useState(0)

  const panelRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(panelRef, close, { onEscape: true })

  const steps = stepsFor(multi)
  const questions = steps.length
  const at = steps[step]

  /*
   * The answer to the first question (or the first two), and the only place the two paths meet.
   * Everything below asks this rather than `multi`, so a question narrowing against "the chosen
   * datasets" is one code path at both arities — which is `available`'s rule on the other side
   * of the seam.
   */
  const datasets = useMemo(() => (multi ? ticked : [dataset]), [multi, ticked, dataset])
  const multiFamilies = useMemo(() => multiDatasetOptions(), [])
  // Memoised like its two neighbours: the ceiling is a fact about the node definitions, and this
  // dialog re-renders on any of a dozen store subscriptions.
  const maxDatasets = useMemo(() => maxWizardDatasets(), [])

  const starts = useMemo(() => startOptions(datasets), [datasets])
  const analyses = useMemo(() => analysisOptions(datasets), [datasets])

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
  /*
   * The fallback follows the path, because the two option lists are disjoint: `neurons` is a
   * single-dataset answer and would build a chain reading one connectome out of a comparison of
   * three. It is only ever reached where `analyses` is empty, which the datasets question
   * refuses to continue past — but a fallback that is wrong in the unreachable case is a
   * fallback that is wrong the day the guard moves.
   */
  const analysis = resolveOption(analyses, chosenAnalysis, multi ? 'compare' : 'neurons')
  const views = useMemo(() => visualisationOptions(datasets, analysis), [datasets, analysis])
  /*
   * A set, because a reader may want a table *and* a chart of the same thing — two viewers off
   * one chain rather than two workflows. **Everything this analysis offers, minus what has been
   * turned off**, which is the whole of the state: there is no ticked-set of our own to keep in
   * step with a question whose options change under it, and switching analysis therefore needs
   * no repair. `resolveVisualisations` is headless and states the "never none" floor.
   *
   * Order is the option list's rather than the order boxes were ticked, which is also the order
   * the cards are placed in — a reader who unticks and re-ticks the bar chart gets it back where
   * it was rather than on the end.
   */
  const visualisations = resolveVisualisations(views, viewsOff)

  const pick = {
    dataset: (key: string) => {
      setDataset(key)
      // Leaving the cross-dataset path is what picking a single dataset *means*, and it has to
      // happen here rather than being repaired later: a stale `multi` puts a five-question
      // sequence behind a one-dataset answer, and the screen that would show it is behind us.
      setMulti(false)
      setStep(1)
    },
    /**
     * Take the cross-dataset path. It does not answer the dataset question — it replaces it with
     * a different one — so it advances to that rather than past it.
     */
    multiple: () => {
      setMulti(true)
      setStep(1)
    },
    /**
     * Tick or untick one connectome, and stay on the question.
     *
     * A set, like the viewers, and bounded at both ends for different reasons. The floor is two,
     * because one dataset is the other path and none is no workflow — but unlike the viewers
     * this question *opens* below its floor, so the refusal is on Continue rather than on the
     * click, and the footer says what is missing. The ceiling is the arity the nodes declare
     * (`maxWizardDatasets`), and a click past it is refused the way the last viewer's untick is:
     * the box does not move, because a silently ignored click reads as a broken checkbox.
     */
    datasets: (key: string) => {
      const on = ticked.includes(key)
      if (!on && ticked.length >= maxDatasets) return
      setTicked(on ? ticked.filter((one) => one !== key) : [...ticked, key])
    },
    start: (id: StartId) => {
      setStart(id)
      setStep(step + 1)
    },
    analysis: (id: AnalysisId) => {
      setAnalysis(id)
      setStep(step + 1)
    },
    /**
     * Tick or untick one viewer, and stay on the question.
     *
     * The other three questions advance on the answer, because each of them *is* one answer. This
     * one is a set, so it needs somewhere to stop — the footer's Continue — and unticking the last
     * one is refused rather than allowed: an empty set builds a chain with nothing on the end of
     * it, and the reader who wanted that wants a different analysis.
     *
     * **What is written down is the refusal.** Every viewer arrives ticked, so a click that
     * matters is one that turns something off, and that is the statement worth carrying to the
     * next question and the next session — see `resolveVisualisations`. It also means the
     * remembered value stays empty for a reader who never changes anything, so the default can
     * move later without a stored answer nobody gave standing in its way.
     */
    visualisation: (id: VisualisationId) => {
      const ticked = visualisations.includes(id)
      // Refused rather than ignored silently: the box the pointer is on stays ticked, which is
      // the same feedback the old ticked-set version gave.
      if (ticked && visualisations.length === 1) return
      setViewsOff(ticked ? [...viewsOff, id] : viewsOff.filter((one) => one !== id))
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
  /*
   * The datasets key the memo by their contents for `viewKey`'s reason: `datasets` is derived on
   * every render, so a fresh array holding the same keys is the same answer and must not rebuild
   * the graph.
   */
  const datasetKey = datasets.join(',')
  const graph = useMemo(
    () =>
      buildWorkflow({
        datasets: datasetKey.split(',').filter(Boolean),
        start,
        analysis,
        visualisations: viewKey.split(',') as VisualisationId[],
        notes,
        dashboard,
      }),
    [datasetKey, start, analysis, viewKey, notes, dashboard],
  )

  /*
   * Nothing is asked first: a generated workflow opens in a document of its own, so whatever was
   * on the canvas is still open beside it. This used to arm a replace-confirm on the summary.
   *
   * The arrange is asked for **after** the open and only when the canvas is what it is opening
   * onto. `buildWorkflow` places a row of columns, which is legible at four cards and a long
   * thin strip at nine — and a strip is what the fit `loadGraph` fires zooms out to frame. It
   * cannot be done in the builder: a layout pass needs each card's real size, which only React
   * Flow knows (`GraphState.arrangeRequest`). And a request made with the grid up would be
   * dropped by the canvas's mount-seeded guard, so this does not pretend to make one — a
   * dashboard is a graph whose positions nobody is looking at.
   */
  const create = () => {
    openDocument(graph)
    if (arrange && !dashboard) requestArrange()
    close()
  }

  const back = () => {
    if (step === 0) close()
    else setStep(step - 1)
  }

  const blocked = blockedReason(at, ticked, analyses)

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
          {at === 'dataset' && (
            <Question
              title="Which dataset?"
              hint="Pick the dataset you want to work with. You can change it on the canvas afterwards."
            >
              {families.map((family) => (
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
                    <GlyphSvg className="wizard__glyph" viewBox={SPECIMEN_VIEWBOX}>
                      {datasetGlyph(family.glyph)}
                    </GlyphSvg>
                  }
                />
              ))}
              {/*
               * Last, and it is the one row here that is not a dataset: it answers this question
               * by replacing it with a different one. Its copy is `options.ts`' like every other
               * answer's, and it wears a node's drawing like every other answer — the mapper,
               * which is the card that could not exist in a single-dataset workflow at all.
               */}
              <Option
                key={MULTI_DATASET.id}
                selected={multi}
                label={MULTI_DATASET.label}
                blurb={MULTI_DATASET.blurb}
                glyph={<OptionGlyph option={MULTI_DATASET} />}
                onPick={pick.multiple}
              />
            </Question>
          )}

          {at === 'datasets' && (
            <Question
              title="Which datasets?"
              hint={`Tick two or more connectomes to compare — up to ${maxDatasets}. The order is the order they appear in the workflow.`}
            >
              {multiFamilies.map((family) => (
                <Option
                  key={family.key}
                  selected={ticked.includes(family.key)}
                  multiple
                  label={family.label}
                  where={BACKENDS[family.backend]?.label}
                  blurb={family.description}
                  onPick={() => pick.datasets(family.key)}
                  glyph={
                    <GlyphSvg className="wizard__glyph" viewBox={SPECIMEN_VIEWBOX}>
                      {datasetGlyph(family.glyph)}
                    </GlyphSvg>
                  }
                />
              ))}
            </Question>
          )}

          {at === 'start' && (
            <Question
              title="Which neurons?"
              hint="How you want to define the set of neurons you want to work on."
            >
              {starts.map((option) => (
                <Option
                  key={option.id}
                  selected={option.id === start}
                  label={option.label}
                  blurb={option.blurb}
                  glyph={<OptionGlyph option={option} />}
                  onPick={() => pick.start(option.id)}
                />
              ))}
            </Question>
          )}

          {at === 'analysis' && (
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
                  glyph={<OptionGlyph option={option} />}
                  onPick={() => pick.analysis(option.id)}
                />
              ))}
            </Question>
          )}

          {at === 'views' && (
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
                  glyph={<OptionGlyph option={option} />}
                  onPick={() => pick.visualisation(option.id)}
                />
              ))}
            </Question>
          )}

          {step === questions && (
            <Summary
              graph={graph}
              notes={notes}
              onNotes={setNotes}
              dashboard={dashboard}
              onDashboard={setDashboard}
              arrange={arrange}
              onArrange={setArrange}
            />
          )}
        </div>

        <div className="wizard__foot">
          {/*
           * The position, and — on the one question that can refuse to be left — why. Both,
           * rather than the reason replacing the counter: a reader who cannot press Continue
           * needs to know what is missing *and* still needs to know where they are, and a
           * counter that disappears on one screen reads as a screen outside the sequence.
           */}
          <span className="wizard__progress">
            {step < questions ? `Question ${step + 1} of ${questions}` : 'Ready to build'}
            {blocked ? ` · ${blocked}` : ''}
          </span>
          <span className="toolbar__spacer" />
          <button type="button" className="btn" onClick={back}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {/*
           * The two multi-select questions are the ones that cannot advance on a click — see
           * `pick`. The datasets question can also be *unanswerable*, which no other question
           * can be: two connectomes that share no capability share no analysis, so Continue is
           * refused and the footer says which rather than opening a question with nothing in it.
           */}
          {(at === 'datasets' || at === 'views') && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={Boolean(blocked)}
              onClick={() => setStep(step + 1)}
            >
              Continue
            </button>
          )}
          {step === questions && (
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

/**
 * The picture on an answer's row: the drawing of the node that answer is about.
 *
 * **Derived from the registry rather than drawn for the wizard**, which is the rule the start
 * page's tiles and the add-menu's band already follow — the one hand-drawn set in the app is
 * `startGlyphs.tsx`, and its header says why it is the exception (a rail of tours and dialogs has
 * no node to derive from). Here every answer does have one: a viewer *is* a node, and a start or
 * an analysis is a chain whose subject is a card in it. So a node whose drawing changes takes the
 * wizard's rows with it, and a viewer added to `VIEWS` next month arrives with a picture.
 *
 * `getNodeDef` rather than `requireNodeDef`: a row with no picture is a cosmetic loss, and
 * throwing out of a dialog somebody is halfway through is not the way to report a typo.
 * `wizard.test.ts` reports it instead, where the fix is free.
 *
 * `GLYPH_STROKE_WIDTH` and the 24-unit box, not `GlyphSvg`'s default 1.4 in the specimen box:
 * that function's own header records that a node glyph drawn at 1.4 comes out light beside the
 * ones `NodeThumbnail` draws.
 */
function OptionGlyph({ option }: { option: { id: string; glyph?: string } }) {
  const type = glyphNodeOf(option)
  const def = type ? getNodeDef(type) : undefined
  if (!def) return null
  return (
    <GlyphSvg
      className="wizard__glyph"
      viewBox={GLYPH_VIEWBOX}
      strokeWidth={GLYPH_STROKE_WIDTH}
    >
      {nodeGlyph(def.type, def.category)}
    </GlyphSvg>
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
  arrange,
  onArrange,
}: {
  graph: CodaGraph
  notes: boolean
  onNotes: (enabled: boolean) => void
  dashboard: boolean
  onDashboard: (enabled: boolean) => void
  arrange: boolean
  onArrange: (enabled: boolean) => void
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

      {/*
        An opt-out rather than an offer, which is why it is worded as the thing it does and not
        as a question. The row a workflow is built as is arithmetic — column index times a
        constant — and tidy only while the chain is short; the pass that fixes it is the Arrange
        button's, so somebody who turns this off has not lost anything, they have kept the press.
      */}
      <label className="wizard__notes">
        <input
          type="checkbox"
          checked={arrange}
          onChange={(e) => onArrange(e.target.checked)}
        />
        <span>
          Arrange the nodes on the canvas
          <em>
            {dashboard
              ? 'Only when it opens on the canvas — a dashboard has no card positions to tidy.'
              : 'Tidies the generated row into a layout. Remembered for next time.'}
          </em>
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
