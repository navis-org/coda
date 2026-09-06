// @vitest-environment jsdom

/**
 * The Workflow Wizard's fourth question: what it opens with, and what it remembers.
 *
 * The rule itself is headless and asserted in `wizard/wizard.test.ts` — this is the wiring
 * around it, which is where the two silent failures live. A default of "everything" and a
 * remembered off-list are indistinguishable on a first visit: both draw every box ticked, and
 * the difference only shows on the *second* one. So the round trip has to be driven through the
 * store and the storage slot rather than asserted on the resolver, which would pass with nothing
 * connected at all. And the refusal to untick the last box is a click that must do **nothing**,
 * which is the one outcome a test can mistake for a test that did not click.
 *
 * `openWizard()` rather than a route: three unrelated surfaces open this dialog and none of them
 * is what is under test here.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadWizardArrange, loadWizardViewsOff } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { DEMO_DATASET } from '../../wizard/build'
import { visualisationOptions } from '../../wizard/options'
import { WizardDialog } from './WizardDialog'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  // Node 26 shadows jsdom's `localStorage`, so without this the preference silently never
  // persists — which is the whole of what this file is about.
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // The store is a module singleton and reads the slot once, at init, so a case that wrote a
    // preference would otherwise decide the next one's default by test order.
    useGraphStore.setState({ wizardViewsOff: [], wizardArrange: true, wizardDashboard: false })
    useGraphStore.getState().openWizard()
  })
})

afterEach(() => {
  act(() => useGraphStore.getState().closeWizard())
  cleanup()
})

/** The dialog, walked as far as the fourth question with the answers this file needs. */
function askThrough(analysis: string): void {
  render(<WizardDialog />)
  fireEvent.click(screen.getByRole('button', { name: /Demo Data/ }))
  fireEvent.click(screen.getByRole('button', { name: /Structured Search/ }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(analysis) }))
}

/** The fourth question's boxes, as `[label, ticked]` in the order they are offered. */
function boxes(): [string, boolean][] {
  return screen
    .getAllByRole('checkbox')
    .map((box) => [
      box.querySelector('.wizard__label')?.textContent ?? '',
      box.getAttribute('aria-checked') === 'true',
    ])
}

const tick = (label: string) =>
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(label) }))

/** The summary's checkboxes, and what each one does on the way out. */
describe('the summary', () => {
  const build = () => fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }))
  const summarise = (analysis = 'Connectivity partners') => {
    askThrough(analysis)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  }

  it('asks the canvas to arrange the workflow it just opened', () => {
    summarise()
    const before = useGraphStore.getState().arrangeRequest
    build()
    expect(useGraphStore.getState().arrangeRequest).toBe(before + 1)
  })

  /*
   * The opt-out, and the reason it is one: the row `buildWorkflow` places is arithmetic rather
   * than anybody's decision, so tidying it is the default — but somebody who has their own idea
   * of where cards go should not have to undo a pass on every workflow.
   */
  it('does not ask when the box is unticked, and remembers that', () => {
    summarise()
    fireEvent.click(screen.getByRole('checkbox', { name: /Arrange the nodes/ }))
    expect(loadWizardArrange()).toBe(false)

    const before = useGraphStore.getState().arrangeRequest
    build()
    expect(useGraphStore.getState().arrangeRequest).toBe(before)
  })

  /*
   * The half that makes `useArrange`'s mount-seeded guard something this does not have to rely
   * on: `Editor` is swapped out for the grid, so there is no canvas to answer a request, and a
   * dashboard has no card positions worth tidying anyway.
   */
  it('does not ask when the workflow is opening into the dashboard', () => {
    summarise()
    fireEvent.click(screen.getByRole('checkbox', { name: /Open as a dashboard/ }))
    const before = useGraphStore.getState().arrangeRequest
    build()
    expect(useGraphStore.getState().arrangeRequest).toBe(before)
    // And it says so where the reader can see it, rather than silently doing nothing.
    expect(useGraphStore.getState().graph.dashboard?.open).toBe(true)
  })

  it('is on until somebody says otherwise', () => {
    clearStorage()
    expect(loadWizardArrange()).toBe(true)
  })
})

describe('the fourth question', () => {
  it('opens with every viewer the analysis offers already ticked', () => {
    askThrough('Connectivity partners')
    expect(boxes()).toEqual([
      ['A table', true],
      ['A bar chart', true],
      ['A pie chart', true],
    ])
  })

  it('offers as many boxes as the option space says, for every analysis', () => {
    // A guard against the question rendering a *subset* that happens to look ticked: the count
    // on screen has to be the count `visualisationOptions` answers with.
    askThrough('Adjacency matrix')
    expect(boxes()).toHaveLength(visualisationOptions(DEMO_DATASET, 'matrix').length)
  })

  it('remembers a refusal in the profile, not the picks', () => {
    askThrough('Connectivity partners')
    tick('A pie chart')
    expect(boxes()).toEqual([
      ['A table', true],
      ['A bar chart', true],
      ['A pie chart', false],
    ])
    // The refusal, and only the refusal. A stored allow-list would read `['table', 'bar']` here
    // and would narrow every *other* analysis to whichever of those it happened to offer.
    expect(useGraphStore.getState().wizardViewsOff).toEqual(['pie'])
    expect(loadWizardViewsOff()).toEqual(['pie'])
  })

  it('comes back the way it was left, in a dialog opened again', () => {
    askThrough('Connectivity partners')
    tick('A bar chart')
    cleanup()

    askThrough('Connectivity partners')
    expect(boxes()).toEqual([
      ['A table', true],
      ['A bar chart', false],
      ['A pie chart', true],
    ])
  })

  /*
   * A refusal made about one question is a statement about that *viewer*, so it carries; a
   * question the reader never narrowed opens whole. This is the half an allow-list gets wrong.
   */
  it('carries a refusal to another analysis and narrows nothing else', () => {
    askThrough('Connectivity partners')
    tick('A table')
    cleanup()

    askThrough('Adjacency matrix')
    expect(boxes()).toEqual([
      ['A heatmap', true],
      ['A table', false],
    ])
  })

  it('re-ticking clears the refusal rather than appending a pick', () => {
    askThrough('Connectivity partners')
    tick('A pie chart')
    tick('A pie chart')
    expect(useGraphStore.getState().wizardViewsOff).toEqual([])
    // Back where it was in the offer order, not on the end — which is also where its card lands.
    expect(boxes().map(([label]) => label)).toEqual(['A table', 'A bar chart', 'A pie chart'])
  })

  it('refuses to untick the last one, and stores nothing when it does', () => {
    askThrough('Connectivity partners')
    tick('A table')
    tick('A bar chart')
    expect(boxes()).toEqual([
      ['A table', false],
      ['A bar chart', false],
      ['A pie chart', true],
    ])

    tick('A pie chart')
    // Unchanged: an empty set builds a chain with nothing on the end of it.
    expect(boxes()[2]).toEqual(['A pie chart', true])
    expect(useGraphStore.getState().wizardViewsOff).toEqual(['table', 'bar'])
  })

  /*
   * The floor `resolveVisualisations` states, reached the only way it can be: the off-list
   * accumulates across questions, and two analyses each giving up one viewer can between them
   * cover everything a third one offers. Everything, then, rather than nothing.
   */
  it('opens whole where the refusals would leave the question empty', () => {
    act(() => useGraphStore.getState().setWizardViewsOff(['heatmap', 'dendrogram']))
    askThrough('Connectivity similarity')
    expect(boxes()).toEqual([
      ['A dendrogram', true],
      ['A heatmap', true],
    ])
  })
})
