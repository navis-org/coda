import { describe, expect, it } from 'vitest'

import type { PackageLoader } from './loadPackages'
import { loadPackagesOrThrow } from './loadPackages'

type Outcome = 'ok' | 'fails' | 'mismatch' | 'silent' | 'fails-then-notice'

/** Pyodide's loader as it behaves: it resolves whatever happened, and says so on a stream. */
function loader(outcomes: Outcome[]) {
  const asked: string[][] = []
  const waits: number[] = []
  const loaded: Record<string, string> = {}
  const py: PackageLoader = {
    loadedPackages: loaded,
    loadPackage: async (names, options) => {
      const outcome = outcomes[asked.length] ?? 'ok'
      asked.push(names)
      if (outcome === 'fails' || outcome === 'fails-then-notice') {
        options.messageCallback?.('Failed to load pandas')
        options.errorCallback?.('The following error occurred while loading pandas:')
        options.errorCallback?.('Failed to fetch')
        if (outcome === 'fails-then-notice') {
          options.errorCallback?.('URI mismatch, attempting to load package x from a …')
        }
        for (const name of names) if (name !== 'pandas') loaded[name] = 'default channel'
        return []
      }
      if (outcome === 'mismatch') options.errorCallback?.('URI mismatch, attempting to load …')
      // `silent`: nothing on either stream, and nothing installed.
      if (outcome !== 'silent') for (const name of names) loaded[name] = 'default channel'
      return []
    },
  }
  const notes: string[] = []
  const logged: string[] = []
  const load = (names: string[], label = names.join(' · ')) =>
    loadPackagesOrThrow(py, names, label, {
      wait: async (ms) => {
        waits.push(ms)
      },
      note: (text) => notes.push(text),
      log: (line) => logged.push(line),
    })
  return { load, asked, waits, notes, logged }
}

describe('loading a Python module’s packages', () => {
  it('asks once where everything arrives', async () => {
    const { load, asked, waits } = loader(['ok'])
    await load(['numpy', 'pandas'])
    expect(asked).toEqual([['numpy', 'pandas']])
    expect(waits).toEqual([])
  })

  it('asks again, after a pause, where a package failed — and goes on if that lands', async () => {
    const { load, asked, waits, notes } = loader(['fails', 'ok'])
    await load(['numpy', 'pandas'], 'numpy · pandas')
    expect(asked).toHaveLength(2)
    expect(waits).toHaveLength(1)
    // And says so, or the card sits on its label for a second download with no word why.
    expect(notes).toEqual(['numpy · pandas — a download failed, trying again'])
  })

  it('throws with Pyodide’s own reason where it fails twice', async () => {
    // The thing this exists for: the loader *resolved*, so without this the module ran, was kept
    // for the session, and every later call died inside Python naming `micropip`.
    const { load, asked } = loader(['fails', 'fails'])
    await expect(load(['numpy', 'pandas'], 'numpy · pandas')).rejects.toThrow(
      /could not load what this needs \(numpy · pandas\)\. The following error occurred while loading pandas: Failed to fetch This is usually/,
    )
    expect(asked).toHaveLength(2)
  })

  it('gives the failure’s own reason, not whatever else was on the error stream', async () => {
    const { load } = loader(['fails-then-notice', 'fails-then-notice'])
    await expect(load(['pandas'])).rejects.toThrow(/Failed to fetch This is usually/)
    await expect(
      loader(['fails-then-notice', 'fails-then-notice']).load(['pandas']),
    ).rejects.not.toThrow(/URI mismatch/)
  })

  it('does not take a notice on the error stream for a failure — and still lets it be seen', async () => {
    const { load, asked, logged } = loader(['mismatch'])
    await load(['x'])
    expect(asked).toHaveLength(1)
    // Reading the stream must not swallow it: this line used to reach the console.
    expect(logged).toEqual(['URI mismatch, attempting to load …'])
  })

  it('still notices where Pyodide says nothing at all and the package is not there', async () => {
    // The sentence is Pyodide's wording, read off one build. If an upgrade rewords it, the
    // outcome is still checked: a package named from the lock file must be installed afterwards.
    const { load, asked } = loader(['silent', 'silent'])
    await expect(load(['numpy', 'pandas'])).rejects.toThrow(
      /Not installed afterwards: numpy, pandas\./,
    )
    expect(asked).toHaveLength(2)
  })

  it('reads a package’s name as Pyodide’s lock file does, and leaves a wheel by URL unchecked', async () => {
    const { load } = loader(['ok'])
    // Installed under whatever name the wheel declares, which this cannot know.
    await load(['Python_Dateutil', 'https://files.example/navis_fastcore-1.0-py3-none-any.whl'])
    const quiet = loader(['silent', 'silent'])
    await expect(
      quiet.load(['https://files.example/navis_fastcore-1.0-py3-none-any.whl']),
    ).resolves.toBeUndefined()
  })
})
