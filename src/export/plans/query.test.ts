/**
 * The query and dataset exports' decisions, asked of the plans directly.
 *
 * The fixture names a dataset, a query and a sheet on every such node, so the goldens take none of
 * the refusals, never a pasted list that does not parse, and never the published skeleton layer.
 * Which note a "Latest" dataset carries depends on whether a listing has landed, so it is pinned
 * against the node's own `resolveDatasetId` rather than against either answer.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import type { ParamValues } from '../../core/node'
import { sheetConfigFrom } from '../../data/annotations'
import { DEFAULT_SERVER } from '../../data/neuprint/servers'
import { SKELETON_ROUTES } from '../../data/skeletonRoutes'
import { DATASET_FAMILIES, resolveDatasetId } from '../../nodes/lib/datasetFamilies'
import { parseIdList } from '../../nodes/lib/idList'
import { SKELETON_SOURCE_PARAM } from '../../nodes/lib/skeletonParams'
import {
  datasetFamilyPlan,
  datasetNodePlan,
  googleSheetPlan,
  inputIdsPlan,
  neuprintNodePlan,
  rawCypherPlan,
  skeletonsPlan,
} from './query'
import { fakeNeutralContext } from './testContext'

const FAMILY = DATASET_FAMILIES[0]!

describe('the dataset plans', () => {
  it('refuse a family nobody registered, and a node naming no dataset', () => {
    expect(datasetFamilyPlan('nowhere', {}).refusal).toBe('Unknown dataset family "nowhere".')
    expect(neuprintNodePlan({ dataset: '' }).refusal).toBe(
      'This neuPrint node names no dataset.',
    )
    expect(datasetNodePlan({ dataset: '' }).refusal).toBe('This Dataset node names no dataset.')
  })

  it('pin a stated version without a note, and say which way "Latest" went', () => {
    expect(datasetFamilyPlan(FAMILY.key, { version: 'v9.9', server: '' })).toEqual({
      datasetId: resolveDatasetId(FAMILY, 'v9.9'),
      server: DEFAULT_SERVER,
      notes: [],
    })
    const resolved = resolveDatasetId(FAMILY, '')
    expect(datasetFamilyPlan(FAMILY.key, { version: '' })).toMatchObject({
      datasetId: resolved ?? FAMILY.family,
      notes: [resolved ? 'pinnedLatest' : 'unresolvedLatest'],
    })
  })

  it('reads the Custom node’s own server, and the old picker the default one', () => {
    expect(neuprintNodePlan({ dataset: 'cns', server: 'https://example.org' })).toEqual({
      datasetId: 'cns',
      server: 'https://example.org',
      notes: [],
    })
    expect(datasetNodePlan({ dataset: 'cns' })).toEqual({
      datasetId: 'cns',
      server: DEFAULT_SERVER,
      notes: [],
    })
  })
})

describe('inputIdsPlan', () => {
  const plan = (params: ParamValues, wires: Record<string, string> = {}) =>
    inputIdsPlan(fakeNeutralContext({ type: 'neuron.inputIds', params, wires }))

  const IDS_ALONE = {
    note: 'No Dataset is wired, so this is the ids alone — exactly what the node emits.',
  }

  it('refuses a list that does not parse only when no id table is wired', () => {
    const bad = 'bodyId 101'
    expect(plan({ ids: bad }).refusal).toBe(
      `The pasted id list is not valid: ${parseIdList(bad).error}`,
    )
    expect(plan({ ids: bad }, { ids: 'upstream' })).toEqual({
      ids: [],
      from: 'upstream',
      column: ID_COLUMN_NAME,
      dataset: IDS_ALONE,
    })
  })

  it('keeps the pasted ids as text', () => {
    expect(plan({ ids: '720575940628857210, 101', column: 'root' })).toEqual({
      ids: ['720575940628857210', '101'],
      column: 'root',
      dataset: IDS_ALONE,
    })
  })

  it('reads the optional Dataset port, where the ids-alone note is both documents’ answer', () => {
    expect(plan({ ids: '101' }, { dataset: 'conn' })).toMatchObject({
      dataset: { connection: 'conn' },
    })
  })
})

describe('the other readers', () => {
  it('refuse a blank query and a sheet that names nothing', () => {
    expect(rawCypherPlan({ query: '  \n ' }).refusal).toBe('This Raw Cypher node has no query.')
    expect(rawCypherPlan({ query: ' MATCH (n) RETURN n ' })).toEqual({
      query: 'MATCH (n) RETURN n',
    })
    expect(googleSheetPlan({ sheet: '' }).refusal).toBe('This node names no sheet.')
  })

  it('refuses an unreadable sheet in the sentence the card shows', () => {
    const error = sheetConfigFrom({ sheet: 'not a sheet' }).error
    expect(error).toBeTruthy()
    expect(googleSheetPlan({ sheet: 'not a sheet' }).refusal).toBe(error)
  })

  it('notes the published skeleton layer and nothing else', () => {
    expect(
      skeletonsPlan({ [SKELETON_SOURCE_PARAM]: SKELETON_ROUTES.published, limit: 5 }),
    ).toEqual({ limit: 5, notes: ['publishedLayer'] })
    expect(skeletonsPlan({ [SKELETON_SOURCE_PARAM]: 'automatic', limit: 0 }).notes).toEqual([])
  })
})
