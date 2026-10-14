/**
 * VFB Info: what Virtual Fly Brain says about each term in a table, one page per term.
 *
 * The page the table viewer's term hover is a preview of; what it shows is the card's
 * (`ui/vfb/VfbInfoViewer.tsx`). Reads `fbbtId` by default, so `VFB Neurons → VFB Info` needs
 * nothing set, and any column of VFB ids works, an individual's `vfbId` included.
 *
 * It follows NeuronBridge's card in two rules: **`cheap`, and `evaluate` never fetches** — the card
 * asks VFB for the page on screen only, so a Run costs nothing — and **paging is presentational**,
 * so stepping through terms re-runs nothing.
 */

import { packNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { FBBT_ID_COLUMN, pickedColumn, vfbColumnParam } from './ops'

export const infoNode = packNode({
  type: 'vfb:info',
  label: 'VFB Info',
  category: 'visualisation',
  description: 'What Virtual Fly Brain says about each term in a table, one page per term.',
  guide:
    'Shows Virtual Fly Brain’s page for each term in a table, one term at a time: its definition, ' +
    'the types it is a kind of, its relationships, the name each connectome gives it, example ' +
    'images, and the papers that describe it. Wire it after VFB Neurons to read its FBbt types, or ' +
    'pick any column of VFB ids. The card asks VFB for the term on screen only; running the node ' +
    'fetches nothing.',
  cost: 'cheap',
  defaultSize: { width: 520, height: 620 },

  inputs: [{ id: 'terms', label: 'Terms', type: T.table() }],
  outputs: [{ id: 'out', label: 'Terms', type: T.table() }],

  params: [
    vfbColumnParam({
      id: 'termColumn',
      label: 'Term column',
      from: 'terms',
      default: FBBT_ID_COLUMN,
      help: 'Which column holds the VFB or FBbt ids to show, such as the fbbtId column VFB Neurons adds. Each distinct id is one page.',
    }),
    {
      id: 'page',
      kind: 'int',
      label: 'Term',
      help: 'Which term of the incoming table is shown. Browsing re-runs nothing.',
      default: 0,
      min: 0,
      presentational: true,
      advanced: true,
      internal: true,
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.terms
    return { out: T.table(isTabular(input) ? schemaOf(input) : undefined) }
  },

  evaluate: (ctx) => {
    const terms = ctx.input('terms')
    if (!isTableValue(terms)) throw new Error('Terms input is not a table')
    pickedColumn(ctx, 'termColumn', 'VFB or FBbt term ids')
    return { out: terms }
  },
})
