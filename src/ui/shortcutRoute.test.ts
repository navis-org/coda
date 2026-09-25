// @vitest-environment jsdom
/**
 * `coda.science/cortex` arrives as `?shortcut=cortex` (the page the build emits at `cortex/`
 * redirects there): the main entry follows it once and takes it back out of the address, so a
 * reload or a copied link does not follow it again — and a share link riding in the fragment
 * survives.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import '../nodes'
import { useGraphStore } from '../store/graphStore'
import { loadPackChoices } from '../store/persistence'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { resetPackSwitchesForTest } from './packSwitches'
import { followShortcutParam } from './shortcutRoute'

beforeAll(() => installStorageStub())

beforeEach(() => {
  clearStorage()
  resetPackSwitchesForTest()
  useGraphStore.getState().setNotice(undefined)
})

describe('following a shortcut from the address', () => {
  it('switches the Cortex pack on, and takes the parameter out, keeping the rest', () => {
    window.history.replaceState(null, '', '/?shortcut=cortex&keep=1#!share')
    followShortcutParam()
    expect(loadPackChoices()).toMatchObject({ cortex: true })
    expect(useGraphStore.getState().notice).toMatch(/Switched on for you: .*Cortex/)
    expect(window.location.search).toBe('?keep=1')
    expect(window.location.hash).toBe('#!share')
  })

  it('leaves an address without one alone', () => {
    window.history.replaceState(null, '', '/?keep=1')
    followShortcutParam()
    expect(window.location.search).toBe('?keep=1')
    expect(loadPackChoices()).toEqual({})
  })

  it('does nothing but tidy the address for a shortcut this build does not know', () => {
    window.history.replaceState(null, '', '/?shortcut=nowhere')
    followShortcutParam()
    expect(window.location.search).toBe('')
    expect(loadPackChoices()).toEqual({})
    expect(useGraphStore.getState().notice).toBeUndefined()
  })
})
