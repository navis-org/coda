/**
 * "Recipes": save a set of cards, delete them, and put them back attached to a dataset.
 *
 * On MICrONS, as in the screencast it was written from: a CAVE table reading the volume-wide cell
 * types, feeding a Table. The recipe is those two cards; what makes it a recipe rather than a
 * copy is that it remembers the wire from the dataset, so it comes back attached.
 *
 * Needs a CAVE token (`signIn: 'cave'`). Setup builds the three cards and runs them off camera,
 * so the CAVE table is already loaded when the video starts and loads from cache when it returns.
 */

import type { Tutorial } from './tutorial'

const DATASET = 'dataset.minnie65'
const CAVE_TABLE = 'annotation.caveTable'
const TABLE = 'out.table'
const NAME = 'Cell types'

export const tutorial: Tutorial = {
  title: 'Recipes',
  topic: 'Recipes',
  music: 'Sophomore Makeout - Silent Partner.mp3',
  signIn: 'cave',

  async setup(t) {
    await t.inPage(`
      const { emptyGraph } = await appModule('/src/core/graph.ts')
      const st = s.getState()
      st.setGraph(emptyGraph('Recipes'))
      const ds = st.addNode('${DATASET}', { x: 60, y: 0 })
      // The Description companion arrives with a dataset; this video is not about it.
      const desc = s.getState().graph.nodes.find((n) => n.type === 'dataset.description')
      if (desc) s.getState().deleteNodes([desc.id])
      const ct = st.addNode('${CAVE_TABLE}', { x: 480, y: 0 })
      st.connect({ source: ds, sourceHandle: 'dataset', target: ct, targetHandle: 'dataset' })
      st.setParam(ct, 'table', 'aibs_metamodel_celltypes_v661')
      const tb = st.addNode('${TABLE}', { x: 900, y: 0 })
      st.connect({ source: ct, sourceHandle: 'annotations', target: tb, targetHandle: 'in' })
    `)
    await t.waitForResult(TABLE)
    await t.frame([DATASET, CAVE_TABLE, TABLE], 0.8)
  },

  steps: [
    {
      say: 'A recipe saves a set of cards you use together, so you can put them back in one step.',
      lead: 1.8,
      do: async (t) => {
        await t.moveTo({ node: CAVE_TABLE, at: [0.5, 2.2] }, { ms: 1400 })
      },
    },
    {
      say: 'Select the cards: click one, and command-click the other.',
      spoken: 'Select the cards: click one, and command click the other.',
      do: async (t) => {
        await t.click({ node: CAVE_TABLE, css: '.coda-node__title' })
        await t.pause(400)
        await t.click({ node: TABLE, css: '.coda-node__title' }, { holding: 'Meta' })
      },
    },
    {
      say: 'Right-click, and choose Save as Recipe.',
      do: async (t) => {
        await t.rightClick({ node: TABLE, css: '.coda-node__title' })
        await t.pause(500)
        await t.click({ css: '.context-menu__item', text: 'Save as Recipe…' })
      },
    },
    {
      say: 'Give it a name. Coda also remembers what the cards were wired to.',
      do: async (t) => {
        await t.type('.recipe-dialog input.field', NAME)
        await t.pause(700)
        await t.hover('.recipe-dialog .sources__note', 1200)
        await t.click({ css: '.recipe-dialog button', text: 'Save' })
      },
    },
    {
      say: 'Now delete them. The recipe is kept, here in your browser.',
      do: async (t) => {
        await t.press('Backspace')
        await t.pause(600)
        await t.frame([DATASET], 0.8)
      },
    },
    {
      say: 'To bring it back, select the dataset, press Space, and search for the recipe.',
      do: async (t) => {
        await t.click({ node: DATASET, css: '.coda-node__title' })
        await t.pause(300)
        // The palette opens at the pointer and the cards land where it opened: clear canvas.
        await t.moveTo({ node: DATASET, css: '.coda-node', at: [2.4, 0.2] })
        await t.pause(300)
        await t.press('Space')
        await t.pause(500)
        await t.type('.add-menu__search', NAME)
      },
    },
    {
      say: 'The cards come back wired to the dataset you selected, and load straight away.',
      do: async (t) => {
        await t.click({ css: '.add-menu__item', text: NAME })
        await t.waitForResult(TABLE)
        await t.frame([DATASET, CAVE_TABLE, TABLE], 0.8)
      },
    },
    {
      say: 'Your recipes are also in the plus menu, under a button of their own, and in the list that opens when you drop a wire.',
      do: async (t) => {
        await t.click('.add-fab')
        await t.pause(600)
        await t.click('.fab-menu__cat[data-cat="recipes"]')
        await t.pause(500)
        await t.hover({ css: '.fab-menu__band .fab-menu__node', text: NAME }, 2200)
        await t.click('.add-fab')
      },
    },
    {
      say: 'To rename one, delete it, or download it as a file to share, open Manage Recipes from the palette.',
      do: async (t) => {
        await t.moveTo({ css: '.react-flow__pane', at: [0.5, 0.75] })
        await t.press('Space')
        await t.pause(400)
        await t.type('.add-menu__search', 'Manage rec')
        await t.pause(300)
        await t.click({ css: '.add-menu__item', text: 'Manage Recipes…' })
        await t.waitFor(`!!document.querySelector('.recipe-dialog')`, 'the Recipes dialog')
        await t.hover(`[aria-label="Rename ${NAME}"]`, 900)
        await t.hover(`[aria-label="Download ${NAME}"]`, 900)
        await t.hover(`[aria-label="Delete ${NAME}"]`, 900)
        await t.hover({ css: '.recipe-dialog button', text: 'Import a recipe file…' }, 1200)
        await t.click('.recipe-dialog button[aria-label="Close"]')
      },
    },
  ],
}
