/**
 * "AI assistant": choose a model, ask for a pipeline in plain words, get ordinary cards back.
 *
 * On MaleCNS (a neuPrint token, `signIn`), with Ollama's `gemma4:31b-cloud`, chosen off camera in
 * setup: provider and model are stored settings, and the video shows where they are rather than
 * picking them through two native selects a headless capture cannot draw open.
 *
 * **Every take is a different answer.** The model is not deterministic, so the cards, their count
 * and the chart differ from take to take, and a take can come back with a warning on a card. The
 * script waits on what any sensible answer has — an entry in the drawer, then every card settled —
 * and names nothing the model chose. Watch the take, and record again if one is not clean.
 */

import type { Tutorial } from './tutorial'

const DATASET = 'dataset.malecns'
const QUESTION = 'Find the CT1 neurons and chart their top downstream partner types.'
const dialog = (css: string) => `[role="dialog"] ${css}`

export const tutorial: Tutorial = {
  title: 'AI assistant',
  topic: 'AI assistant',
  music: 'Sophomore Makeout - Silent Partner.mp3',
  signIn: 'neuprint',

  async setup(t) {
    await t.inPage(`
      const ai = await appModule('/src/data/ai/credentials.ts')
      ai.setProviderId('ollama')
      ai.setModel('ollama', 'gemma4:31b-cloud')
      const { emptyGraph } = await appModule('/src/core/graph.ts')
      const st = s.getState()
      st.setGraph(emptyGraph('Assistant'))
      st.addNode('${DATASET}', { x: 60, y: 0 })
      const desc = s.getState().graph.nodes.find((n) => n.type === 'dataset.description')
      if (desc) s.getState().deleteNodes([desc.id])
      // Folded: with the drawer open, the four cards the answer brings fill the width, and the
      // open list sat over the dataset card.
      if (document.querySelector('.wf-tabs__header[aria-expanded="true"]')) st.togglePanel('workflows')
    `)
    await t.frame([DATASET], 0.9)
  },

  steps: [
    {
      say: 'Coda has an AI assistant built in. Describe what you want, and it builds the workflow for you.',
      lead: 2.6,
      do: async (t) => {
        await t.moveTo({ node: DATASET, css: '.coda-node', at: [1.6, 0.5] }, { ms: 1400 })
      },
    },
    {
      say: 'First, choose a model: under Connections, AI assistant.',
      do: async (t) => {
        await t.click('[data-tour="connections"]')
        await t.waitFor(`!!document.querySelector('${dialog('[role="tab"]')}')`, 'the Connections dialog')
        await t.pause(300)
        await t.click({ css: dialog('[role="tab"]'), text: 'AI assistant' })
      },
    },
    {
      say: 'Anthropic, OpenAI and Gemini take a key of your own. Ollama runs models on your own machine, or on its cloud. Here, Gemma, through Ollama.',
      spoken:
        'Anthropic, Open A I and Gemini take a key of your own. O llama runs models on your own machine, or on its cloud. Here, Gemma, through O llama.',
      do: async (t) => {
        await t.hover({ css: dialog('select'), at: [0.5, 0.5] }, 2600)
        await t.hover({ css: dialog('select:last-of-type'), at: [0.5, 0.5] }, 2400)
      },
    },
    {
      say: 'Then open the assistant from the toolbar, and ask in plain words.',
      do: async (t) => {
        await t.click(dialog('button[aria-label="Close"]'))
        await t.pause(300)
        await t.click('[data-tour="assistant"]')
        await t.pause(500)
      },
    },
    {
      say: 'Find the CT1 neurons, and chart their top downstream partner types.',
      spoken: 'Find the C T one neurons, and chart their top downstream partner types.',
      lead: 0.1,
      do: async (t) => {
        await t.type('.assistant__ask input', QUESTION)
        await t.pause(300)
        await t.click('.assistant__ask button[type="submit"]')
      },
    },
    {
      say: 'It answers with a plan, and puts it on the canvas as ordinary cards you can change.',
      do: async (t) => {
        await t.waitFor(`!!document.querySelector('.assistant__entry') && !document.querySelector('.assistant__working')`, 'the answer')
        // A take is only as good as the answer: one whose plan left a warning on a card (a column
        // that does not exist, say) is refused here, so it is recorded again rather than rendered.
        const warning = await t.inPage<string | null>(
          `return document.querySelector('.assistant__warnings')?.textContent ?? null`,
        )
        if (warning) throw new Error(`the answer came back with a warning, record again: ${warning}`)
        await t.inPage(`s.getState().setSelection([])`)
        await t.frameAll(0.8)
      },
    },
    {
      say: 'The whole change is one undo.',
      do: async (t) => {
        await t.hover({ css: '.assistant__entry button', text: 'Undo' }, 1400)
      },
    },
    {
      say: 'And it runs like any other workflow: here, the partner types of CT1, straight from the connectome.',
      spoken: 'And it runs like any other workflow: here, the partner types of C T one, straight from the connectome.',
      do: async (t) => {
        await t.waitSettled()
        await t.frameAll(0.8)
        // Whichever viewer the model chose: the header carries the node's category.
        await t.moveTo({ css: '.canvas-area .coda-node__header[data-category="visualisation"]', at: [0.35, 9] })
      },
    },
  ],
}
