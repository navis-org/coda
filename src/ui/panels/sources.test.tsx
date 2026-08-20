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
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  reportAuthFailure as reportAiAuthFailure,
  resetCredentials as resetAiCredentials,
  getKey,
  setKey,
  setModel,
} from '../../data/ai/credentials'
import { MockSource } from '../../data/mock/MockSource'
import { reportAuthFailure, resetCredentials } from '../../data/neuprint/credentials'
import { registerSource } from '../../data/source'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { SourcesPanel } from './SourcesPanel'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

afterEach(() => {
  cleanup()
  resetCredentials()
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

describe('source tabs', () => {
  it('shows one tab per source and opens on neuPrint', () => {
    render(<SourcesPanel />)
    open()

    expect(
      sourceTabs()
        .getAllByRole('tab')
        .map((el) => el.textContent),
    ).toEqual(['neuPrint', 'Mock connectome'])
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

  it('opens itself on an auth failure', () => {
    render(<SourcesPanel />)
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
  })
})

describe('the credential promise', () => {
  it('states where a token is kept, and where it is not', () => {
    render(<SourcesPanel />)
    open()

    const text = privacy()?.textContent ?? ''
    expect(text).toMatch(/local storage/i)
    expect(text).toMatch(/never written into a saved graph/i)
    expect(text).toMatch(/third party/i)
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

describe('the three sections', () => {
  it('offers Data sources, AI assistant and Sharing as the top level, opening on data', () => {
    render(<SourcesPanel />)
    open()

    expect(
      within(screen.getByRole('tablist', { name: 'Connection kind' }))
        .getAllByRole('tab')
        .map((el) => el.textContent),
    ).toEqual(['Data sources', 'AI assistant', 'Sharing'])
    expect(section('Data sources').getAttribute('aria-selected')).toBe('true')
  })

  it('keeps the API key out of the source list entirely', () => {
    // The point of the split: an AI provider is not a fourth connectome, so it must not appear
    // as one. The source tabs are the data backends and nothing else.
    render(<SourcesPanel />)
    open()

    expect(sourceTabs().queryByRole('tab', { name: /AI|assistant|Anthropic/i })).toBeNull()
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
     * The data-source note ends "through the same-origin proxy that request has to travel
     * through", which is true of neuPrint and false here — this one goes straight from the
     * page. Reusing that sentence would make the panel's one security claim wrong.
     */
    render(<SourcesPanel />)
    open()
    const forData = privacy()?.textContent ?? ''
    expect(forData).toMatch(/same-origin proxy/i)

    fireEvent.click(section('AI assistant'))
    const forAi = privacy()?.textContent ?? ''
    expect(forAi).not.toMatch(/proxy/i)
    expect(forAi).toMatch(/straight from this page/i)
  })

  it('says the graph is sent along with the question', () => {
    // The one thing a user cannot infer: asking the assistant uploads the canvas.
    render(<SourcesPanel />)
    open()
    fireEvent.click(section('AI assistant'))

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
      'Ollama (local)',
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

  it('keeps the promise provider-neutral, since a local model sends nothing anywhere', () => {
    // Naming one provider in the panel's single security claim would make it wrong for three.
    render(<SourcesPanel />)
    openAi()

    const text = privacy()?.textContent ?? ''
    expect(text).not.toMatch(/\bAnthropic\b/)
    expect(text).toMatch(/sends nothing off the machine/i)
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
})
