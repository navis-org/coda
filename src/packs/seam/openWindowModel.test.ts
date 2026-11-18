/**
 * `openSeamModel` against a manifest the caller read already: the model opened must be the
 * version the caller's answers are labelled with (`source`), or the run refuses.
 *
 * The GPU probe is stood in for and the runtime is a fake, since what is under test is the
 * comparison of the two reads, not WebGPU.
 */

import { describe, expect, it, vi } from 'vitest'

import type { LoadedManifest, ModelManifest } from '../../ml/manifest'
import type { ModelSession } from '../../ml/session'
import type * as Support from '../../ml/support'
import { openSeamModel } from './openWindowModel'
import type { SeamManifest } from './openWindowModel'

vi.mock('../../ml/support', async (importOriginal) => ({
  ...(await importOriginal<typeof Support>()),
  gpuSupport: () => Promise.resolve({}),
}))

const MANIFEST = {
  id: 'n3_mal_mask_s0',
  task: 'merge-assessor',
  parts: ['assess'],
  signatures: {},
  files: [
    {
      variant: 'conv',
      part: 'assess',
      file: 'a.onnx',
      url: null,
      bytes: 10,
      sha256: 'a'.repeat(64),
      quantisation: { kind: 'none' },
    },
  ],
} as unknown as ModelManifest

const read = (digest: string): LoadedManifest => ({
  manifest: MANIFEST,
  url: 'https://example.invalid/manifest.json',
  digest,
})

function open(callerRead: SeamManifest<object>, workerRead: LoadedManifest) {
  const close = vi.fn(() => Promise.resolve())
  const session = { loaded: workerRead, close } as unknown as ModelSession
  const opened = openSeamModel({
    model: { id: 'n3_mal_mask_s0', label: 'The assessor', manifestUrl: '', detail: '' },
    task: 'merge-assessor',
    parse: () => ({}),
    download: true,
    downloadShare: 0.5,
    progress: () => undefined,
    manifest: callerRead,
    runtime: { variant: 'conv', open: () => Promise.resolve(session) },
  })
  return { opened, close }
}

describe('opening a model the caller has read already', () => {
  it('opens it where the worker read the same version', async () => {
    const { opened, close } = open({ loaded: read('aaaa'), config: {} }, read('aaaa'))
    await expect(opened).resolves.toMatchObject({ config: {} })
    expect(close).not.toHaveBeenCalled()
  })

  it('refuses, and closes the session, where the file was republished in between', async () => {
    const { opened, close } = open({ loaded: read('aaaa'), config: {} }, read('bbbb'))
    await expect(opened).rejects.toThrow(/republished while it was being opened/)
    expect(close).toHaveBeenCalled()
  })
})
