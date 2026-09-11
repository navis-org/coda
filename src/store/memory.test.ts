// @vitest-environment jsdom

/**
 * What each open workflow's results hold, and dropping them — the store half of the memory readout.
 *
 * The case worth building a fixture for is the duplicate. `duplicateDocument` adopts its original's
 * cache whole (`Scheduler.adoptResults`), so two workflows hold the very same tables, and a readout
 * summing them per workflow would report twice the memory that is in use — to somebody deciding
 * what to close because they are near a ceiling. So the copy must read as nothing while the
 * original holds the results, and as everything once the original lets go: that second half is
 * also what "Drop results" on the original actually frees, which is none of it.
 */

import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ByteLedger } from '../core/valueBytes'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { resetDocuments } from '../test/storeReset'
import { demoWorkflow } from '../wizard/build'
import { useGraphStore } from './graphStore'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
  installStorageStub()
})

beforeEach(() => {
  clearStorage()
  resetDocuments()
})

const store = () => useGraphStore.getState()
const report = () => store().workflowMemory(new ByteLedger())
const of = (id: string) => report().find((workflow) => workflow.id === id)!

describe('memory held by each workflow', () => {
  it('charges a duplicate’s shared results once, and drops a background workflow’s', async () => {
    store().openDocument(demoWorkflow('partners'))
    const original = store().activeTabId
    await store().runAll()

    const alone = of(original)
    expect(alone.results).toBeGreaterThan(0)
    expect(alone.bytes).toBeGreaterThan(0)
    expect(alone.byCategory.tables).toBeGreaterThan(0)

    store().duplicateDocument(original)
    const copy = store().tabs.find((tab) => tab.id !== original)!.id
    expect(of(copy).results).toBe(alone.results)
    expect(of(copy).bytes).toBe(0)
    expect(of(original).bytes).toBe(alone.bytes)

    if (store().activeTabId === original) store().switchDocument(copy)
    store().clearResults(original)
    expect(of(original).results).toBe(0)
    expect(of(copy).bytes).toBe(alone.bytes)

    // Coming back finds work to do rather than badges left over from the results it lost.
    store().switchDocument(original)
    expect(store().graph.nodes.some((node) => store().needsRun(node.id))).toBe(true)
  })

  it('drops the open workflow’s results', async () => {
    store().openDocument(demoWorkflow('partners'))
    await store().runAll()
    const id = store().activeTabId
    expect(of(id).results).toBeGreaterThan(0)
    store().clearResults(id)
    expect(of(id).results).toBe(0)
    expect(of(id).bytes).toBe(0)
  })
})
