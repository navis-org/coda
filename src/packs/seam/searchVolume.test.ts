/**
 * One supervoxel lookup, shared between the reads that want it.
 *
 * `SearchVolume.roots` fills on completion, which is enough while one box is read at a time and
 * wrong the moment two are: neighbouring boxes of one neuron are mostly the same supervoxels, so
 * two reads in flight would each find the shared ones missing and ask the chunkedgraph for all
 * of them twice. **Nothing downstream could notice** — the duplicate answers the same thing — so
 * the cost is requests at a shared public server (SEAM's invariant 8) and wall clock, and a test
 * is the only thing that can see it.
 *
 * It is pinned here rather than through `labelledBox` because the property is about *when* two
 * calls interleave, and reaching it through the box would mean serving voxels this has no
 * opinion about. The wire format of the lookup itself is `rootIds.test.ts`'.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as RootIds from '../../data/cave/rootIds'
import type { CaveRequestOptions } from '../../data/cave/client'
import type { RootLookup } from './searchVolume'
import { forgetRoots, resolveRoots } from './searchVolume'

const rootsAtInstant = vi.hoisted(() => vi.fn())
vi.mock('../../data/cave/rootIds', async (importActual) => ({
  ...(await importActual<typeof RootIds>()),
  rootsAtInstant,
}))

const OPTIONS: CaveRequestOptions = { deployment: 'https://global.example.org' }

/**
 * The four fields `resolveRoots` reads, and nothing else.
 *
 * No cast: the function takes a `Pick` of the volume rather than the whole of it, so this *is*
 * its parameter. It used to take a whole `SearchVolume` and this had to go through `unknown` —
 * the type system pointing out that the chunk cache and the eviction plan have nothing to do
 * with resolving a supervoxel.
 */
function volumeStub(): RootLookup {
  return {
    graphene: {
      server: 'https://cave.example.org',
      table: 't',
      base: 'https://cave.example.org/t',
    },
    at: 1_700_000_000_000,
    roots: new Map<bigint, bigint>(),
    asking: new Map<bigint, Promise<void>>(),
  }
}

const ids = (...of: number[]) => BigUint64Array.from(of.map(BigInt))

/** A lookup the test releases by hand, so two calls can be made to overlap on purpose. */
function gated() {
  const waiting: Array<() => void> = []
  const asked: bigint[][] = []
  rootsAtInstant.mockImplementation((_graphene, _at, supervoxels: BigUint64Array) => {
    asked.push([...supervoxels])
    return new Promise((resolve) =>
      // Every supervoxel's root is itself plus a thousand, so an answer is checkable.
      waiting.push(() => resolve(BigUint64Array.from(supervoxels, (id) => id + 1000n))),
    )
  })
  return {
    asked,
    release: () => {
      for (const go of waiting.splice(0)) go()
    },
  }
}

describe('resolving a box’s supervoxels', () => {
  beforeEach(() => {
    rootsAtInstant.mockReset()
  })

  it('asks for the ones it does not know, and writes what comes back', async () => {
    const gate = gated()
    const volume = volumeStub()
    const done = resolveRoots(volume, ids(1, 2, 3), OPTIONS)
    gate.release()
    await done
    expect(gate.asked).toEqual([[1n, 2n, 3n]])
    expect(volume.roots.get(2n)).toBe(1002n)
  })

  it('asks nothing for supervoxels it already has', async () => {
    const gate = gated()
    const volume = volumeStub()
    volume.roots.set(1n, 99n)
    volume.roots.set(2n, 98n)
    const done = resolveRoots(volume, ids(1, 2), OPTIONS)
    await done
    expect(gate.asked).toEqual([])
  })

  /**
   * **The one this exists for.** Two reads in flight over overlapping boxes: the second must ask
   * only for what the first is not already asking about, and must still come back with every
   * root it needs.
   */
  it('shares a lookup in flight rather than asking for the same supervoxel twice', async () => {
    const gate = gated()
    const volume = volumeStub()
    const first = resolveRoots(volume, ids(1, 2, 3), OPTIONS)
    // Started before the first has answered — which is the whole case.
    const second = resolveRoots(volume, ids(2, 3, 4), OPTIONS)
    expect(gate.asked).toEqual([[1n, 2n, 3n], [4n]])
    gate.release()
    await Promise.all([first, second])
    for (const id of [1n, 2n, 3n, 4n]) expect(volume.roots.get(id)).toBe(id + 1000n)
  })

  /**
   * A joiner must not be resumed before the lookup it joined has written. Without that,
   * `labelledBox` builds its `roots` array from `volume.roots.get(id)!` and puts `undefined`
   * into a `BigUint64Array` for every shared supervoxel.
   */
  it('does not finish a read before the lookup it joined has landed', async () => {
    const gate = gated()
    const volume = volumeStub()
    const first = resolveRoots(volume, ids(1, 2), OPTIONS)
    let secondDone = false
    const second = resolveRoots(volume, ids(1, 2), OPTIONS).then(() => {
      secondDone = true
    })
    // The second asked for nothing at all, every supervoxel being covered already.
    expect(gate.asked).toEqual([[1n, 2n]])
    await Promise.resolve()
    expect(secondDone).toBe(false)
    gate.release()
    await Promise.all([first, second])
    expect(secondDone).toBe(true)
    expect(volume.roots.get(1n)).toBe(1001n)
  })

  /**
   * **A failed lookup must leave nothing registered**, or every later read of those supervoxels
   * joins a promise that has already rejected and the neuron can never recover — a failure that
   * would present as "one request failed and then everything did".
   */
  it('leaves nothing behind when a lookup fails, so the next read really asks again', async () => {
    rootsAtInstant.mockRejectedValueOnce(new Error('503'))
    const volume = volumeStub()
    await expect(resolveRoots(volume, ids(1, 2), OPTIONS)).rejects.toThrow('503')
    expect(volume.asking.size).toBe(0)

    const gate = gated()
    const again = resolveRoots(volume, ids(1, 2), OPTIONS)
    gate.release()
    await again
    expect(gate.asked).toEqual([[1n, 2n]])
    expect(volume.roots.get(1n)).toBe(1001n)
  })

  /** A joiner sees the failure too: it has no answer either, and silently returning is worse. */
  it('fails the read that joined a lookup that failed', async () => {
    let refuse: ((error: Error) => void) | undefined
    rootsAtInstant.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (refuse = reject)),
    )
    const volume = volumeStub()
    const first = resolveRoots(volume, ids(1, 2), OPTIONS)
    const second = resolveRoots(volume, ids(1, 2), OPTIONS)
    refuse!(new Error('503'))
    await expect(first).rejects.toThrow('503')
    await expect(second).rejects.toThrow('503')
    expect(volume.asking.size).toBe(0)
  })

  /**
   * **A cancelled caller stops waiting; it does not cancel the lookup.** The request is shared,
   * so aborting it would take the root out from under the other read in flight — which, under
   * `oneAhead`, is a different end of the same neuron. `sharedRequestOptions` keeps the signal
   * off the wire and `untilAborted` is what lets the caller leave.
   */
  it('lets a cancelled caller stop waiting without stopping the lookup', async () => {
    const gate = gated()
    const volume = volumeStub()
    const stop = new AbortController()
    const leaving = resolveRoots(volume, ids(1, 2), { ...OPTIONS, signal: stop.signal })
    const staying = resolveRoots(volume, ids(1, 2), OPTIONS)
    stop.abort(new Error('cancelled'))
    await expect(leaving).rejects.toThrow('cancelled')
    // The lookup was never aborted, so the other reader still gets its answer.
    gate.release()
    await staying
    expect(volume.roots.get(1n)).toBe(1001n)
  })

  /**
   * `forgetRoots` is called between neurons and deliberately does not touch `asking` — an entry
   * removes itself when its lookup settles, so a non-empty map there would mean writes still
   * coming. Pinned because the obvious "tidy up both" edit is wrong and looks right.
   */
  it('keeps a lookup in flight across forgetting the previous neuron’s roots', async () => {
    const gate = gated()
    const volume = volumeStub()
    const done = resolveRoots(volume, ids(1, 2), OPTIONS)
    forgetRoots(volume)
    expect(volume.asking.size).toBe(2)
    gate.release()
    await done
    expect(volume.roots.get(1n)).toBe(1001n)
  })
})
