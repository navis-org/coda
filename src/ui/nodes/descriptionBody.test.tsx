// @vitest-environment jsdom

/**
 * The Description card in the real editor.
 *
 * Two halves. The first is that the body is actually wired up — an unregistered body renders as a
 * bare node header and nothing throws, which is the failure mode this whole file exists to catch.
 * The second is that the render path escapes what the parser hands it: `markdown.test.ts` proves a
 * hostile blurb never becomes a link node, and this proves it never becomes an element either.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import datasets from '../../data/neuprint/__fixtures__/datasets.json'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource, DatasetInfo } from '../../data/source'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { MarkdownView } from '../MarkdownView'

/** The real published blurb, so the card is tested against what it will actually be given. */
const HEMIBRAIN: DatasetInfo = {
  id: 'hemibrain:v1.2.1',
  label: 'hemibrain',
  description: datasets['hemibrain:v1.2.1'].description,
  rois: [],
  statuses: ['Traced'],
  version: 'v1.2.1',
}

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  const base: DataSource = new MockSource({ latencyMs: 0 })
  registerSource(new MockSource({ latencyMs: 0 }))
  // Under neuPrint's own id, so the real `dataset.hemibrain` node resolves through it.
  registerSource(
    Object.assign(Object.create(base) as DataSource, {
      id: 'neuprint',
      peekDatasets: () => [HEMIBRAIN],
      peekDataset: (id: string) => (id === HEMIBRAIN.id ? HEMIBRAIN : undefined),
      listDatasets: async () => [HEMIBRAIN],
    }),
  )
})

beforeEach(() => {
  clearStorage()
  act(() => {
    const store = useGraphStore.getState()
    // The store is a module singleton: the start page renders over everything (it would be a
    // second `dialog`), and last case's graph would otherwise still be on the canvas.
    store.closeStartPage()
    store.newGraph()
  })
})

afterEach(cleanup)

function openStarter() {
  render(<App />)
  act(() => {
    useGraphStore.getState().loadStarter({
      nodeType: 'dataset.hemibrain',
      label: 'Hemibrain',
      sourceId: 'neuprint',
    })
  })
}

async function card(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('.description-body')).toBeTruthy())
  return document.querySelector('.description-body')!.closest('.coda-node') as HTMLElement
}

describe('the Description card', () => {
  it('renders the published blurb as prose, not as markdown source', async () => {
    openStarter()
    const body = await card()
    expect(body.textContent).toContain('A reconstructon of the female central complex')
    // The source text is `[Project overview](https://…)`; brackets on screen mean it did not parse.
    expect(body.textContent).not.toContain('](')
  })

  it('links the project page and the citation, opening them away from the canvas', async () => {
    openStarter()
    const body = await card()
    const overview = within(body).getByRole('link', { name: 'Project overview' })
    expect(overview.getAttribute('href')).toBe(
      'https://www.janelia.org/project-team/flyem/hemibrain',
    )
    // A new tab, because this canvas holds unsaved work; noopener because the opened page has
    // no business reaching back through `window.opener`.
    expect(overview.getAttribute('target')).toBe('_blank')
    expect(overview.getAttribute('rel')).toContain('noopener')

    expect(
      within(body).getByRole('link', { name: 'Scheffer et al. (2020)' }).getAttribute('href'),
    ).toBe('https://doi.org/10.7554/eLife.57443')
  })

  it('keeps the companion sites nested under their bullet', async () => {
    openStarter()
    const body = await card()
    const nested = body.querySelectorAll('.markdown__item > .markdown__list')
    expect(nested).toHaveLength(1)
    expect(nested[0]!.querySelectorAll('li')).toHaveLength(2)
  })

  it('is exactly as wide as the dataset card it hangs under, so the pair stacks', async () => {
    openStarter()
    const body = await card()
    const dataset = document.querySelector('.dataset-body')!.closest('.coda-node') as HTMLElement
    // jsdom does no layout, so the declaration is the only checkable artefact.
    expect(body.style.getPropertyValue('--node-width')).toBe(
      dataset.style.getPropertyValue('--node-width'),
    )
    expect(body.style.getPropertyValue('--node-width')).toBe('248px')
  })

  it('opens full size, where a long citation list has room', async () => {
    openStarter()
    const body = await card()
    fireEvent.click(within(body).getByLabelText('Expand output'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('link', { name: 'Clio' })).toBeTruthy()
  })

  it('says what is missing rather than showing an empty card', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().addNode('dataset.description', { x: 100, y: 100 })
    })
    await waitFor(() => expect(document.querySelector('.description-body')).toBeTruthy())
    expect(document.querySelector('.description-body')!.textContent).toContain(
      'Connect a dataset',
    )
  })
})

describe('what a hostile blurb renders as', () => {
  it('escapes raw HTML instead of mounting it', () => {
    const { container } = render(
      <MarkdownView source={'<img src=x onerror="alert(1)">\n\nafter'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('drops a script target to plain text, keeping the words', () => {
    const { container } = render(<MarkdownView source="[click me](javascript:alert(1))" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('click me')
  })
})
