// @vitest-environment jsdom

/**
 * Apply to Compartment Model from Fit Model's card foot: the numbers land in the card wired into the
 * fit's Model socket, as Custom, in one undo step; the button then says Applied, and comes back on
 * an undo. The store is primed with the fit's output — the scheduler is not what is under test.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { addEdge, emptyGraph } from '../../core/graph'
import { makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { fittedModel } from '../../packs/biophys/fitOps'
import { build } from '../../packs/biophys/testFixtures'
import { useGraphStore } from '../../store/graphStore'
import { node } from '../../test/graph'
import { FitFooter } from './FitFooter'
import '../../packs'

afterEach(cleanup)

/** A model built at area factor 1.5, fitted to Rm 30,000, Cm 1.2, Ra 250, E leak −62, area 3. */
function fitted() {
  const start = build({ areaFactor: 1.5 })
  const membrane = { rm: 30_000.4, cm: 1.2, ra: 250, eLeak: -62, area: 3, seal: 0 }
  return fittedModel(start, {
    membrane,
    reason: 'converged',
    iterations: [{ iteration: 9, rms: 0.4, membrane }],
    startRms: 3,
    rms: 0.4,
  })
}

const OK = Object.freeze({ state: 'ok' })
const STALE = Object.freeze({ state: 'stale' })

/** `model` → `fit`, loaded into the store, with the fit's output primed; the footer rendered. */
function renderFooter(wired = true, info: object = OK) {
  let graph = emptyGraph('fit')
  graph.nodes.push(
    node('model', 'biophys:model', { areaFactor: 1.5 }),
    node('fit', 'biophys:fit'),
  )
  if (wired) {
    graph = addEdge(graph, {
      source: 'model',
      sourceHandle: 'model',
      target: 'fit',
      targetHandle: 'model',
    })
  }
  const store = useGraphStore.getState()
  store.loadGraph(graph)
  const value = fitted()
  useGraphStore.setState({
    nodeOutput: ((id: string, port: string) =>
      id === 'fit' && port === 'model' ? value : undefined) as never,
    nodeInfo: (() => info) as never,
  } as never)
  const fitNode = useGraphStore.getState().graph.nodes.find((n) => n.id === 'fit')!
  const ctx = makeInferContext(requireNodeDef('biophys:fit'), fitNode.params, {})
  return render(<FitFooter node={fitNode} ctx={ctx} setParam={() => {}} />)
}

const modelParams = () =>
  useGraphStore.getState().graph.nodes.find((n) => n.id === 'model')!.params

describe('Apply to Compartment Model', () => {
  it('writes the fitted membrane into the wired card as Custom, in one undo step', () => {
    renderFooter()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // Rounded to four figures; the fitted area factor is the card's own.
    expect(modelParams()).toMatchObject({
      preset: 'custom',
      rm: 30_000,
      cm: 1.2,
      ra: 250,
      eLeak: -62,
      areaFactor: 3,
    })
    // Applied, and pressing it again would compound nothing: it is no longer offered.
    expect(screen.getByRole('button', { name: 'Applied' })).toHaveProperty('disabled', true)
    act(() => useGraphStore.getState().undo())
    expect(modelParams().areaFactor).toBe(1.5)
    expect(modelParams().preset).not.toBe('custom')
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', false)
  })

  it('does not write a result from before the fit’s last change', () => {
    renderFooter(true, STALE)
    const button = screen.getByRole('button', { name: 'Apply' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toMatch(/run it again/)
  })

  it('offers nothing to write into where Model is not wired from a Compartment Model', () => {
    renderFooter(false)
    const button = screen.getByRole('button', { name: 'Apply' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toMatch(/Wire Model straight from a Compartment Model/)
  })
})
