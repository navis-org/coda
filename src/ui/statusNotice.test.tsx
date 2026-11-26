// @vitest-environment jsdom

/**
 * The notice's fix button (`noticeFix`): drawn beside a run's failure notice while the notice is
 * still that sentence, and pressing it ticks the param and runs the node. On a dashboard this is
 * the only place the reader can say yes to a model download — the box is on the hidden canvas.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FixableError } from '../core/errors'
import { addNode, emptyGraph } from '../core/graph'
import { registerNode } from '../core/registry'
import { T, tableSchema } from '../core/types'
import { emptyTable } from '../core/values'
import '../nodes'
import { useGraphStore } from '../store/graphStore'
import { node } from '../test/graph'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { StatusNotice } from './StatusNotice'

const store = () => useGraphStore.getState()

beforeAll(() => {
  installStorageStub()
  registerNode({
    type: 'test.notice.consent',
    label: 'Consent',
    category: 'analysis',
    cost: 'expensive',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    params: [{ id: 'allow', kind: 'boolean', label: 'Allow', default: false }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => {
      if (ctx.params.allow !== true) {
        throw new FixableError('Not allowed.', {
          label: 'Allow it',
          action: 'tickAndRun',
          param: 'allow',
        })
      }
      return { out: emptyTable(tableSchema()) }
    },
  })
})

beforeEach(async () => {
  clearStorage()
  act(() => {
    store().newGraph()
    store().loadGraph(addNode(emptyGraph('one card'), node('n', 'test.notice.consent')))
  })
  await act(async () => {
    await store().runNode('n')
  })
})

afterEach(cleanup)

describe('a failure notice with a fix', () => {
  it('draws the button, and pressing it allows and runs the node', async () => {
    render(<StatusNotice />)
    expect(screen.getByRole('status').textContent).toContain('Consent failed: Not allowed.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow it' }))
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(store().graph.nodes[0]!.params['allow']).toBe(true)
    expect(store().nodeInfo('n').state).toBe('ok')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('draws no button once another notice has replaced the sentence', () => {
    render(<StatusNotice />)
    act(() => store().setNotice('Saved.'))
    expect(screen.getByRole('status').textContent).toBe('Saved.×')
    expect(screen.queryByRole('button', { name: 'Allow it' })).toBeNull()
  })
})
