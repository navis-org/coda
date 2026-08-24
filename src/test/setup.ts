/**
 * Global test setup: reset the module-level state a test cannot see.
 *
 * Vitest isolates *files*, not tests within a file, so anything held at module scope is shared
 * by every test in the file that touched it. That is fine for a pure lookup table and quietly
 * poisonous for a cache: `catmaid.test.ts` already carries a note about exactly this — "a later
 * test is served the table an earlier one built and makes no request at all, which reads as a
 * routing bug" — and had to call `resetCache()` itself to avoid it.
 *
 * `geometryCache` is the same hazard and worse, because it sits under *every* skeleton and mesh
 * fetch in the app. Five tests in a row fetching neuron `16` would make one request between them
 * and four of them would be asserting on nothing. Reset here rather than in each file, so a test
 * written next year does not have to know this file exists.
 *
 * Deliberately not a dumping ground: only state that is (a) module-level, (b) a cache rather
 * than a fact, and (c) reachable from many test files belongs here. Everything else is the
 * business of the file that touches it.
 */

import { beforeEach } from 'vitest'

import { resetGeometryCache } from '../data/geometryCache'

beforeEach(resetGeometryCache)
