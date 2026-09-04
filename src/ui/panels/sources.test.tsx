// @vitest-environment jsdom

/**
 * The Connections dialog: two levels of tab, and the promise each half makes about credentials.
 *
 * Three things are worth pinning. A tab bar that renders but does not *switch* looks finished
 * from a screenshot, so the copy behind each has to be absent until it is picked. The privacy
 * note is the answer to "where does my key go?" — stated above the field that asks for one, so
 * its position is part of what it says, and it now differs by section because the honest answer
 * does. And an auth failure has to land on the *right* half: there are two credential stores
 * and two channels, and routing an Anthropic 401 to the neuPrint token field would be worse
 * than not opening at all.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The one thing in this dialog that cannot happen in jsdom: a sign-in is a popup and a
 * cross-document message, and neither exists here. What is under test is not that flow — it has
 * its own suite — but what the *panel* does when it lands, so the flow is stood in for.
 */
const signIn = vi.hoisted(() => ({ toCave: vi.fn() }))
vi.mock('./caveSignIn', async (importOriginal) => ({
  ...(await importOriginal<typeof CaveSignIn>()),
  signInToCave: signIn.toCave,
}))

import {
  reportAuthFailure as reportAiAuthFailure,
  resetCredentials as resetAiCredentials,
  getKey,
  getThinking,
  setKey,
  setModel,
} from '../../data/ai/credentials'
import { MockSource } from '../../data/mock/MockSource'
import {
  reportAuthFailure as reportCaveAuthFailure,
  resetCredentials as resetCaveCredentials,
} from '../../data/cave/credentials'
import {
  listInstances as listCatmaidInstances,
  reportAuthFailure as reportCatmaidAuthFailure,
  resetCredentials as resetCatmaidCredentials,
  setInstances as setCatmaidInstances,
} from '../../data/catmaid/credentials'
import { reportAuthFailure, resetCredentials } from '../../data/neuprint/credentials'
import { registerSource } from '../../data/source'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { useGraphStore } from '../../store/graphStore'
import { setTourHandle } from '../tour/tourState'
import type * as CaveSignIn from './caveSignIn'
import { SourcesPanel } from './SourcesPanel'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

/*
 * Whether the dialog is open is store state now, and the store is a module singleton that
 * outlives a `cleanup()` — so a case that opened it would otherwise decide the next one's
 * starting position. The same reason `startPage.test.tsx` pins its own flags.
 */
beforeEach(() => {
  act(() => {
    useGraphStore.setState({ sourcesOpen: false, notice: undefined })
  })
  setTourHandle(undefined)
})

afterEach(() => {
  cleanup()
  setTourHandle(undefined)
  resetCredentials()
  resetCaveCredentials()
  resetCatmaidCredentials()
  resetAiCredentials()
  vi.unstubAllGlobals()
})

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Connections' }))
/** Scoped, because the section bar is a tablist too and both hold a tab called by a name. */
const sourceTabs = () => within(screen.getByRole('tablist', { name: 'Data sources' }))
const tab = (name: string) => sourceTabs().getByRole('tab', { name })
const section = (name: string) =>
  within(screen.getByRole('tablist', { name: 'Connection kind' })).getByRole('tab', { name })
const keyField = () => screen.queryByLabelText('API key')
const tokenField = () => screen.queryByRole('textbox', { name: /Token/ })
const privacy = () => document.querySelector('.sources__privacy')
/*
 * Everything the promise says — the line on screen plus what its `?` holds.
 *
 * The panel's copy moved behind `?` buttons when four paragraphs of it turned out to be the
 * first thing between a reader and the button they came to press. These tests are about which
 * claims are *made*, not where they render (`is above the tabs` is the one that pins position),
 * so they read both halves. It matters most for the negative ones: "does not claim a proxy" has
 * to keep meaning "nowhere in this section", tooltip included.
 */
const promise = () => {
  const el = privacy()
  const behind = el?.querySelector('.sources__why')?.getAttribute('title') ?? ''
  return `${el?.textContent ?? ''} ${behind}`
}

describe('source tabs', () => {
  it('shows one tab per source and opens on neuPrint', () => {
    render(<SourcesPanel />)
    open()

    expect(
      sourceTabs()
        .getAllByRole('tab')
        .map((el) => el.textContent),
    ).toEqual(['neuPrint', 'CAVE', 'CATMAID', 'Mock connectome'])
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
    expect(tokenField()).not.toBeNull()
  })

  it('switches panels rather than only restyling the bar', () => {
    render(<SourcesPanel />)
    open()

    fireEvent.click(tab('Mock connectome'))
    expect(tab('Mock connectome').getAttribute('aria-selected')).toBe('true')
    // The credential form belongs to the tab that was left, not to the dialog.
    expect(tokenField()).toBeNull()
    expect(screen.getByRole('tabpanel').textContent).toMatch(/no token, no network/i)

    fireEvent.click(tab('neuPrint'))
    expect(tokenField()).not.toBeNull()
  })

  it('lands on the tab an auth failure is about, even when already open elsewhere', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(tab('Mock connectome'))

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))

    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/rejected the token/)).not.toBeNull()
    // The reason is worth nothing without the field that answers it.
    expect(tokenField()).not.toBeNull()
  })

  /*
   * The routing used to be one `authTab` on the section, hardcoded to neuPrint. That was
   * harmless for exactly as long as neuPrint was the only credentialed backend: with CAVE
   * registered it would open the neuPrint tab and ask for the wrong token, which reads as the
   * token being rejected rather than as the panel being on the wrong page. Removing the tab
   * argument from either `subscribe` fails this.
   */
  it('routes a CAVE failure to the CAVE tab, not to neuPrint', () => {
    render(<SourcesPanel />)

    act(() => reportCaveAuthFailure('CAVE rejected the token (401)'))

    expect(tab('CAVE').getAttribute('aria-selected')).toBe('true')
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByText(/CAVE rejected the token/)).not.toBeNull()
    // Two credentialed sources now, so the field on screen has to be the one asked for.
    expect(screen.getByText(/global.daf-apis.com/)).not.toBeNull()
  })

  /*
   * Signing in is what the CAVE tab leads with now, and the field beneath it is not a leftover:
   * a pop-up the browser blocks and middle_auth's own error pages both end a sign-in with
   * nothing handed back, and anybody already using CAVE from Python has a token to paste.
   */
  it('leads with a CAVE sign-in and folds the paste field behind a toggle', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(tab('CAVE'))

    expect(screen.getByRole('button', { name: 'Sign in with Google' })).not.toBeNull()
    // Still there — a sign-in has exits that hand nothing back — but closed, since it is the
    // second way in rather than the only one.
    const disclosure = tokenField()?.closest('details')
    expect(disclosure?.open).toBe(false)
    expect(within(disclosure!).getByText(/paste a token manually/)).not.toBeNull()
  })

  /*
   * The copy was the interface: four paragraphs to get past to reach a button you were going to
   * press anyway. What keeps that from growing back is that the explanations have somewhere else
   * to be — so this asserts both halves, that the paragraph is *not* on screen and that it is
   * still reachable.
   */
  it('keeps the CAVE explanations on the ? rather than in the panel', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(tab('CAVE'))

    expect(screen.getByRole('tabpanel').textContent).not.toMatch(/never sees your password/)
    expect(screen.getByLabelText(/never sees your password/)).not.toBeNull()
  })

  /*
   * The alert that opened the panel is a fact about the moment it opened, and the panel exists
   * to make it false. Leaving "No CAVE token" above a tab that now says "Signed in as …" is the
   * dialog contradicting itself.
   */
  it('drops the "no token" alert once a sign-in lands', async () => {
    signIn.toCave.mockResolvedValue({ token: 'tok-1', email: 'a@example.org' })
    // The confirmation probe that follows: it has no bearing on the alert, and a real request
    // from a test that is not about one is worse than a refused one.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    render(<SourcesPanel />)

    act(() => reportCaveAuthFailure('No CAVE token. Add one in Connections.'))
    expect(screen.getByText(/No CAVE token/)).not.toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))
    })

    expect(screen.queryByText(/No CAVE token/)).toBeNull()
    expect(screen.getByRole('tabpanel').textContent).toMatch(/Signed in as a@example.org/)
  })

  it('leaves an alert about another source standing', async () => {
    signIn.toCave.mockResolvedValue({ token: 'tok-1' })
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    render(<SourcesPanel />)

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))
    fireEvent.click(tab('CAVE'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))
    })

    // Two sources fail independently: answering one says nothing about the other.
    expect(screen.getByText(/neuPrint rejected the token/)).not.toBeNull()
  })

  it('opens itself on an auth failure', () => {
    render(<SourcesPanel />)
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
  })

  /*
   * The one case where opening itself is the wrong move. driver.js makes every element but the
   * one it is spotlighting `pointer-events: none`, so a dialog that arrives mid-step can be
   * neither filled in nor dismissed: the reader is stuck behind a form. Reported from the
   * dashboard tour, whose third step adds a MaleCNS node and draws a 401 on the spot.
   *
   * The failure is not swallowed — it goes to the status bar, and the reason is still recorded,
   * so opening Connections by hand afterwards lands on the tab that failed with the message
   * above it.
   */
  it('holds back while a tour is running, and says it in the status bar instead', () => {
    render(<SourcesPanel />)
    setTourHandle({ refresh: () => {} })

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))

    expect(screen.queryByRole('dialog'), 'a modal the tour has made inert').toBeNull()
    expect(useGraphStore.getState().notice).toContain('rejected the token')

    // And the reason is kept, so opening it by hand still lands on the right tab.
    setTourHandle(undefined)
    open()
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/rejected the token/)).not.toBeNull()
  })
})

describe('the credential promise', () => {
  it('states where a token is kept, and where it is not', () => {
    render(<SourcesPanel />)
    open()

    const text = promise()
    expect(text).toMatch(/local storage/i)
    expect(text).toMatch(/never written into a saved graph/i)
    expect(text).toMatch(/third party/i)
    // The headline itself stays on screen: a promise entirely behind a tooltip is one nobody
    // reading the panel has been told.
    expect(privacy()?.textContent ?? '').toMatch(/stay in this browser/i)
  })

  it('is above the tabs, so it is read before a source is chosen', () => {
    render(<SourcesPanel />)
    open()

    const note = privacy()
    const tabs = document.querySelector('.sources__tabs')
    expect(note).not.toBeNull()
    expect(note?.compareDocumentPosition(tabs as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('is not repeated inside the tab that asks for the token', () => {
    // It was per-source copy before; two statements of the same promise is how one of them
    // goes stale without anyone noticing.
    render(<SourcesPanel />)
    open()

    expect(screen.getByRole('tabpanel').textContent).not.toMatch(/local storage/i)
  })
})

describe('the sections', () => {
  it('offers each kind of connection as the top level, opening on data', () => {
    render(<SourcesPanel />)
    open()

    expect(
      within(screen.getByRole('tablist', { name: 'Connection kind' }))
        .getAllByRole('tab')
        .map((el) => el.textContent),
    ).toEqual(['Data sources', 'AI assistant', 'Annotations', 'Sharing'])
    expect(section('Data sources').getAttribute('aria-selected')).toBe('true')
  })

  /*
   * The same split the API key gets, and for the same reason: an annotation base is somebody's
   * spreadsheet of labels joined onto a connectome, not a fourth backend you could query for
   * neurons. Filing FlyTable under Data sources would say it was one.
   */
  it('keeps the annotation deployments out of the source list', () => {
    render(<SourcesPanel />)
    open()
    expect(
      sourceTabs()
        .getAllByRole('tab')
        .map((el) => el.textContent),
    ).not.toContain('FlyTable')

    fireEvent.click(section('Annotations'))
    expect(
      within(screen.getByRole('tablist', { name: 'Annotations' }))
        .getAllByRole('tab')
        .map((el) => el.textContent),
    ).toEqual(['FlyTable', 'SeaTable'])
  })

  it('keeps the API key out of the source list entirely', () => {
    // The point of the split: an AI provider is not a fourth connectome, so it must not appear
    // as one. The source tabs are the data backends and nothing else.
    render(<SourcesPanel />)
    open()

    // `\bAI\b` rather than `AI`: an unanchored one matches "cATMAId", so this passed for the
    // wrong reason the moment a CATMAID tab existed — it would have gone on "finding" an AI tab
    // in the source list forever.
    expect(sourceTabs().queryByRole('tab', { name: /\bAI\b|assistant|Anthropic/i })).toBeNull()
    expect(keyField()).toBeNull()
  })

  it('swaps the whole body when the section changes', () => {
    render(<SourcesPanel />)
    open()
    expect(tokenField()).not.toBeNull()

    fireEvent.click(section('AI assistant'))

    expect(keyField()).not.toBeNull()
    // The source tab bar belongs to the section that was left, not to the dialog.
    expect(screen.queryByRole('tablist', { name: 'Data sources' })).toBeNull()
    expect(tokenField()).toBeNull()
  })

  it('holds the key in a password field, so it is not readable over a shoulder', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    expect(keyField()?.getAttribute('type')).toBe('password')
  })

  it('saves the key and says so', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    fireEvent.change(keyField() as Element, { target: { value: '  sk-ant-test  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Trimmed on the way in — the obvious thing to do with a key is paste the clipboard.
    expect(getKey('anthropic')).toBe('sk-ant-test')
  })

  it('forgets the key without needing a save', () => {
    setKey('anthropic', 'sk-ant-existing')
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }))
    expect(getKey('anthropic')).toBeUndefined()
  })
})

describe('routing a failure to the half it is about', () => {
  it('opens on the AI section when the assistant key is rejected', () => {
    render(<SourcesPanel />)
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => reportAiAuthFailure('Anthropic rejected the key (401).'))

    expect(section('AI assistant').getAttribute('aria-selected')).toBe('true')
    expect(keyField()).not.toBeNull()
    // Not the neuPrint token field, which answers a different question entirely.
    expect(tokenField()).toBeNull()
  })

  it('moves to the AI section even when already open on a data source', () => {
    render(<SourcesPanel />)
    open()
    expect(tokenField()).not.toBeNull()

    act(() => reportAiAuthFailure('Anthropic rejected the key (401).'))

    expect(section('AI assistant').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/rejected the key/)).not.toBeNull()
  })

  it('sends a neuPrint failure back to the data section, not the AI one', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))

    expect(section('Data sources').getAttribute('aria-selected')).toBe('true')
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
  })
})

describe('what each half promises about a credential', () => {
  it('does not claim a proxy relays the Anthropic request, because none does', () => {
    /*
     * The data-source note says a credential may travel through a same-origin relay, which is
     * true of neuPrint and of an anonymous CATMAID POST, and false here — this one goes straight
     * from the page. Reusing that sentence would make the panel's one security claim wrong.
     *
     * Matched on "relay|proxy" rather than on the exact phrase: the note had to stop saying
     * *every* data-source request is relayed once CAVE and CATMAID arrived, both of which reach
     * their servers directly, and a test pinned to the old wording fails on a correction.
     */
    render(<SourcesPanel />)
    open()
    const forData = promise()
    expect(forData).toMatch(/same-origin (relay|proxy)/i)

    fireEvent.click(section('AI assistant'))
    const forAi = promise()
    expect(forAi).not.toMatch(/proxy/i)
    expect(forAi).toMatch(/straight from this page/i)
  })

  it('says the graph is sent along with the question', () => {
    // The one thing a user cannot infer: asking the assistant uploads the canvas.
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    // On screen rather than behind the `?`, deliberately: see the section's own comment.
    expect(privacy()?.textContent ?? '').toMatch(/graph on your canvas/i)
  })

  it('says whose account is billed', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    expect(privacy()?.textContent ?? '').toMatch(/your key, your account, your bill/i)
  })
})

describe('saving the key', () => {
  it('closes the dialog, since the confirmation lands behind it', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    fireEvent.change(keyField() as Element, { target: { value: 'sk-ant-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('choosing a provider', () => {
  const providerPicker = () => screen.getByLabelText('Provider') as HTMLSelectElement
  const modelPicker = () => screen.getByLabelText('Model') as HTMLSelectElement
  const openAi = () => {
    open()
    fireEvent.click(section('AI assistant'))
  }

  it('offers every provider, defaulting to Anthropic', () => {
    render(<SourcesPanel />)
    openAi()

    expect([...providerPicker().options].map((o) => o.textContent)).toEqual([
      'Anthropic',
      'OpenAI',
      'Google Gemini',
      'Ollama',
    ])
    expect(providerPicker().value).toBe('anthropic')
  })

  it('swaps the model list with the provider, since an id from one means nothing to another', () => {
    render(<SourcesPanel />)
    openAi()
    expect(modelPicker().value).toMatch(/^claude-/)

    fireEvent.change(providerPicker(), { target: { value: 'openai' } })
    expect(modelPicker().value).toMatch(/^gpt-/)
  })

  it('drops the key field for a local provider, and offers a server instead', () => {
    // Ollama needs no account. Asking for a key would imply one exists.
    render(<SourcesPanel />)
    openAi()
    expect(keyField()).not.toBeNull()

    fireEvent.change(providerPicker(), { target: { value: 'ollama' } })
    expect(keyField()).toBeNull()
    expect(screen.getByLabelText('Server')).not.toBeNull()
  })

  it('brings back a key already saved for a provider you return to', () => {
    // Trying another provider must not cost you the key you already pasted.
    setKey('anthropic', 'sk-ant-saved')
    render(<SourcesPanel />)
    openAi()
    expect((keyField() as HTMLInputElement).value).toBe('sk-ant-saved')

    fireEvent.change(providerPicker(), { target: { value: 'openai' } })
    expect((keyField() as HTMLInputElement).value).toBe('')

    fireEvent.change(providerPicker(), { target: { value: 'anthropic' } })
    expect((keyField() as HTMLInputElement).value).toBe('sk-ant-saved')
  })

  it('saves the key against the provider it was typed for, and selects it', () => {
    render(<SourcesPanel />)
    openAi()

    fireEvent.change(providerPicker(), { target: { value: 'openai' } })
    fireEvent.change(keyField() as Element, { target: { value: 'sk-oai-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(getKey('openai')).toBe('sk-oai-test')
    expect(getKey('anthropic')).toBeUndefined()
  })

  it('lets a local provider be tested with no key at all', () => {
    render(<SourcesPanel />)
    openAi()
    fireEvent.change(providerPicker(), { target: { value: 'ollama' } })

    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(false)
  })

  it('keeps the promise provider-neutral, and names the one model that is not local', () => {
    /*
     * Naming one provider in the panel's single security claim would make it wrong for three —
     * hence no `Anthropic`. The second half is the newer trap: "a local provider sends nothing
     * off the machine" was flatly true until an Ollama model whose name ends in `-cloud` could
     * be picked from the same dropdown, and a privacy claim that is right about the default and
     * wrong about one setting is worse than no claim, because it is the one people quote. So the
     * exception has to be *in* the promise, not a footnote in a guide.
     */
    render(<SourcesPanel />)
    openAi()

    const text = promise()
    expect(text).not.toMatch(/\bAnthropic\b/)
    expect(text).toMatch(/sends nothing off it at all/i)
    expect(text).toMatch(/-cloud/)
    expect(text).toMatch(/ollama\.com/)
  })
})

describe('the models a local server actually has', () => {
  /*
   * A hardcoded shortlist is a guess about somebody else's machine, and every name in a dropdown
   * reads as one you can pick — so a list of five models nobody had pulled was five wrong
   * answers presented as the only choices. Ollama can be *asked*, so it is.
   */
  const providerPicker = () => screen.getByLabelText('Provider') as HTMLSelectElement
  const modelPicker = () => screen.getByLabelText('Model') as HTMLSelectElement
  const optionsOf = () => [...modelPicker().options].map((o) => o.textContent)
  const refresh = () => screen.getByRole('button', { name: 'Refresh model list' })

  /** Answer `/api/tags` with these names; anything else fails, as an unreachable server would. */
  function serverHas(...names: string[]): { calls: number } {
    const state = { calls: 0 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!String(url).includes('/api/tags')) throw new TypeError('Failed to fetch')
        state.calls += 1
        return new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    return state
  }

  /** Open the AI half and switch to Ollama, letting the listing land. */
  async function openOllama() {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))
    await act(async () => {
      fireEvent.change(providerPicker(), { target: { value: 'ollama' } })
    })
  }

  it('lists what is pulled, apart from what would have to be pulled first', async () => {
    serverHas('qwen3.8:27b-mlx', 'qwen3.8:latest')
    await openOllama()

    const installed = modelPicker().querySelector('optgroup[label="On this machine"]')
    expect([...installed!.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'qwen3.8:27b-mlx',
      'qwen3.8:latest',
    ])
    // The declared shortlist survives, under a heading that says what it is.
    expect(modelPicker().querySelector('optgroup[label="Available to pull"]')).not.toBeNull()
  })

  it('gives up a default nobody pulled for one that is actually there', async () => {
    // A declared default was never a decision — the rule `resolveColumn` follows. Leaving it
    // selected means the first question goes to a model this machine does not have.
    serverHas('qwen3.8:27b-mlx', 'qwen3.8:latest')
    await openOllama()

    expect(modelPicker().value).toBe('qwen3.8:27b-mlx')
  })

  it('keeps a model somebody chose, and marks it rather than swapping it', async () => {
    /*
     * The other half of the same rule: a stored value is a decision, so it stands. It is a name
     * this provider has never heard of — a *shortlisted* model that is merely not installed is
     * already covered by the "Available to pull" heading, which says it more precisely.
     */
    setModel('ollama', 'deepseek-r1:70b')
    serverHas('qwen3.8:latest')
    await openOllama()

    expect(modelPicker().value).toBe('deepseek-r1:70b')
    expect(optionsOf()).toContain('deepseek-r1:70b — not pulled')
  })

  it('leaves a chosen model unmarked while no listing has arrived', async () => {
    // "Not pulled" is a claim about a machine that answered. Said over silence it blames a
    // server nobody started for a model that may well be sitting on it.
    setModel('ollama', 'deepseek-r1:70b')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await openOllama()

    expect(optionsOf()).toContain('deepseek-r1:70b')
    expect(optionsOf().join()).not.toContain('not pulled')
  })

  it('re-asks when refreshed, so pulling a model does not need a reload', async () => {
    const server = serverHas('qwen3.8:latest')
    await openOllama()
    expect(server.calls).toBe(1)
    expect(optionsOf()).not.toContain('gemma2:9b')

    serverHas('qwen3.8:latest', 'gemma2:9b')
    await act(async () => {
      fireEvent.click(refresh())
    })
    expect(optionsOf()).toContain('gemma2:9b')
  })

  it('says nothing when a server nobody started fails to answer on open', async () => {
    /*
     * Opening the panel is not a claim to be using Ollama. Reporting the failure here puts an
     * error in front of somebody configuring a different provider entirely — Test is where
     * reachability is answered, because pressing it is asking.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await openOllama()

    expect(document.querySelector('.sources__result')).toBeNull()
    // The declared shortlist stands rather than the dropdown emptying out.
    expect(optionsOf().length).toBeGreaterThan(1)
  })

  it('answers when the refresh is pressed, because pressing it is asking', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await openOllama()

    await act(async () => {
      fireEvent.click(refresh())
    })
    expect(document.querySelector('.sources__result')!.textContent).toMatch(/Could not reach/)
  })

  it('offers no refresh for a provider whose catalogue is not a fact about this machine', async () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    expect(screen.queryByRole('button', { name: 'Refresh model list' })).toBeNull()
    expect(modelPicker().querySelector('optgroup')).toBeNull()
  })

  /*
   * Reasoning is a *speed* control, and only for a provider that takes a per-request switch.
   * Measured: the same question took 254 s with reasoning and 49 s without, on a warm model,
   * for plans that were as good — so it is off, and offered rather than decided.
   */
  const reasoning = () =>
    screen.queryByLabelText('Let the model reason before answering') as HTMLInputElement | null

  it('links the setup guide, because the setup is longer than a note', async () => {
    /*
     * Ollama is the only provider whose setup is more than pasting a key — a runtime to
     * install, a model to pick by its context window, and an origin to allow. The note cannot
     * carry that, and a note that tried would grow every time somebody found a new way for it
     * not to work.
     */
    serverHas('qwen3.8:latest')
    await openOllama()

    const link = screen.getByRole('link', { name: 'Full setup guide' }) as HTMLAnchorElement
    expect(link.href).toBe('https://github.com/navis-org/coda/blob/main/docs/ollama.md')
    // Opens away from the page: the panel holds unsaved edits, and navigating loses them.
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noreferrer')
  })

  it('offers no guide where there is nothing to set up', async () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    expect(screen.queryByRole('link', { name: 'Full setup guide' })).toBeNull()
  })

  it('offers reasoning, off, for the provider that takes the switch', async () => {
    serverHas('qwen3.8:latest')
    await openOllama()

    expect(reasoning()).not.toBeNull()
    expect(reasoning()!.checked).toBe(false)
  })

  it('does not offer it where reasoning is not a per-request boolean', async () => {
    // Anthropic's is adaptive and inside a `max_tokens` the provider already sets. A checkbox
    // there would be a control over something else entirely, wearing the same words.
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

    expect(reasoning()).toBeNull()
  })

  it('stores it on Save and not before', async () => {
    // Same rule the key and the model follow: the panel is a draft until Save. A checkbox that
    // took effect on click would change what the assistant does while somebody is still reading
    // the sentence under it.
    serverHas('qwen3.8:latest')
    await openOllama()

    fireEvent.click(reasoning()!)
    expect(getThinking('ollama')).toBe(false)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(getThinking('ollama')).toBe(true)
  })
})

/**
 * The CATMAID tab, which is the only one holding *several* credentials.
 *
 * A token there is per user **and** per instance, so the thing worth pinning is that the list is
 * a list — that a second instance can be added without displacing the first, and that a row with
 * nothing in it does not survive a save as an empty entry somebody has to clear later.
 */
describe('the CATMAID tab', () => {
  const openCatmaid = () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(tab('CATMAID'))
  }
  const serverFields = () => screen.getAllByLabelText('Server')
  const tokenFields = () => screen.getAllByLabelText('API token')

  it('starts empty and says reading still works without a credential', () => {
    openCatmaid()
    expect(screen.queryAllByLabelText('Server')).toHaveLength(0)
    expect(screen.getByText(/None configured/)).toBeTruthy()
  })

  it('adds a row prefilled with the instance Coda ships a node for', () => {
    openCatmaid()
    fireEvent.click(screen.getByRole('button', { name: '+ Add instance' }))
    expect((serverFields()[0] as HTMLInputElement).value).toBe(
      'catmaid-fafb.virtualflybrain.org',
    )
    // Only the first: a second row is for somewhere else by definition.
    fireEvent.click(screen.getByRole('button', { name: '+ Add instance' }))
    expect((serverFields()[1] as HTMLInputElement).value).toBe('')
  })

  it('keeps several instances rather than replacing one with the next', () => {
    openCatmaid()
    fireEvent.click(screen.getByRole('button', { name: '+ Add instance' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add instance' }))
    fireEvent.change(tokenFields()[0]!, { target: { value: 'vfb-token' } })
    fireEvent.change(serverFields()[1]!, { target: { value: 'https://catmaid.lab.example/' } })
    fireEvent.change(tokenFields()[1]!, { target: { value: 'lab-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(listCatmaidInstances()).toEqual([
      { server: 'catmaid-fafb.virtualflybrain.org', token: 'vfb-token' },
      // Normalised on the way in, so a pasted address bar and a bare host are one instance.
      { server: 'catmaid.lab.example', token: 'lab-token' },
    ])
  })

  it('carries HTTP basic auth beside the token rather than instead of it', () => {
    openCatmaid()
    fireEvent.click(screen.getByRole('button', { name: '+ Add instance' }))
    fireEvent.change(tokenFields()[0]!, { target: { value: 'tok' } })
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(listCatmaidInstances()[0]).toEqual({
      server: 'catmaid-fafb.virtualflybrain.org',
      token: 'tok',
      httpUser: 'alice',
      httpPassword: 'secret',
    })
  })

  it('drops a row with no credential rather than storing an empty one', () => {
    openCatmaid()
    fireEvent.click(screen.getByRole('button', { name: '+ Add instance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(listCatmaidInstances()).toEqual([])
  })

  it('removes the row it was asked to, not the last one', () => {
    setCatmaidInstances([
      { server: 'a.example.org', token: 'a' },
      { server: 'b.example.org', token: 'b' },
    ])
    openCatmaid()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(listCatmaidInstances().map((entry) => entry.server)).toEqual(['b.example.org'])
  })

  it('opens on this tab when CATMAID reports an auth failure', () => {
    render(<SourcesPanel />)
    act(() => reportCatmaidAuthFailure('CATMAID rejected the token.'))
    expect(tab('CATMAID').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('CATMAID rejected the token.')).toBeTruthy()
  })
})
