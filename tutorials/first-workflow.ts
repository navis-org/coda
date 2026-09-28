/**
 * "Your first workflow": MaleCNS, Explore Dataset, two viewers, a dashboard, a share link, and
 * where to go next. Written from `first-workflow-script.md`.
 *
 * It runs on the real MaleCNS dataset, so it needs a neuPrint token (`signIn`), and what the
 * cards show is whatever the server answers on the day. The narration claims nothing about the
 * neurons beyond their names, so a later release changes numbers on screen and nothing said.
 *
 * Explore Dataset downloads the whole neuron table (167k rows, about 15 s) the moment it is
 * added. Setup loads it once off camera, so on camera the card fills in about a second: the
 * table is cached per dataset for the session, whatever node or workflow asks for it next.
 */

import type { Tutorial } from './tutorial'

const DATASET = 'dataset.malecns'
const DESCRIPTION = 'dataset.description'
const EXPLORE = 'neuron.explore'
const NEUROGLANCER = 'out.neuroglancer'
const PROFILE = 'out.profile'

/**
 * Where the video says the link goes. The recording runs on the dev server, so the dialog would
 * otherwise show a `localhost` link and a notice that it opens only on this machine.
 */
const SITE = 'https://coda.science'

/** A picker in the full-size viewer, which is a dialog over the canvas. */
const inDialog = (css: string) => `[role="dialog"] ${css}`

export const tutorial: Tutorial = {
  title: 'Your first workflow',
  // YouTube Audio Library, no attribution required. Not in the repository (tutorials/music/ is
  // gitignored); with the file missing, record with `--music none` or name another track with
  // `--music <file>`.
  music: 'Sophomore Makeout - Silent Partner.mp3',
  signIn: 'neuprint',

  async setup(t) {
    // The pre-load: the same two nodes the video adds, run until the table is in, then cleared.
    await t.inPage(`
      const st = s.getState()
      const ds = st.addNode('${DATASET}', { x: 60, y: 0 })
      const ex = st.addNode('${EXPLORE}', { x: 600, y: 0 })
      st.connect({ source: ds, sourceHandle: 'dataset', target: ex, targetHandle: 'dataset' })
    `)
    await t.waitForResult(EXPLORE)
    await t.inPage(`
      const { emptyGraph } = await appModule('/src/core/graph.ts')
      s.getState().setGraph(emptyGraph('My first workflow'))
    `)
    await t.pause(500)
  },

  steps: [
    {
      chapter: 'Building a workflow',
      say: 'This is Coda.',
      // The comma is for the voice alone: it puts the weight on the name.
      spoken: 'This is, Coda.',
    },
    {
      say: 'A node editor for exploring and analysing connectomes, right in your browser.',
      // On this half rather than the first: the first is shorter than the glide, and a step lasts
      // as long as its actions, so the pause between the two would stretch to nearly two seconds.
      // Late in the line, so the cursor reaches the middle only once the title card has gone.
      lead: 2.0,
      do: async (t) => {
        await t.moveTo({ css: '.react-flow__pane', at: [0.5, 0.45] }, { ms: 1400 })
      },
    },
    {
      say: 'Every workflow starts with a dataset node.',
    },
    {
      say: 'To add a node, click the plus button, and open a category.',
      gapBefore: 0.5,
      do: async (t) => {
        await t.click('.add-fab')
        await t.pause(500)
        await t.click('.fab-menu__cat[data-cat="dataset"]')
        await t.pause(1200)
      },
    },
    {
      say: 'You can also search for nodes by name.',
      do: async (t) => {
        await t.click('.fab-menu__cat[aria-label="Browse all nodes"]')
      },
    },
    {
      say: "Let's add the Male CNS: the connectome of a fruit fly's entire central nervous system.",
      spoken: "Let's add the male C N S: the connectome of a fruit fly's entire central nervous system.",
      do: async (t) => {
        await t.type('.node-browser__input', 'Male')
        await t.pause(500)
        await t.click({ css: '.node-row', text: 'MaleCNS (neuPrint)' })
        await t.pause(600)
        await t.frame([DATASET, DESCRIPTION], 0.9)
      },
    },
    {
      say: 'The card below it came along automatically. It credits the team that built the connectome, and the papers to cite.',
      do: async (t) => {
        await t.hover({ node: DESCRIPTION, css: '.coda-node__body', at: [0.5, 0.3] }, 1500)
      },
    },
    {
      say: 'Next, we need a way to find neurons.',
    },
    {
      say: "There are several, but let's start with Explore Dataset.",
      do: async (t) => {
        await t.click('.add-fab')
        await t.pause(500)
        await t.click('.fab-menu__cat[data-cat="query"]')
        await t.pause(800)
        await t.click({ css: '.fab-menu__band .fab-menu__node', text: 'Explore Dataset' })
      },
    },
    {
      say: 'Coda wired the new node to the dataset for you. Drag it by its header to wherever you like.',
      lead: 1.0,
      do: async (t) => {
        await t.placeRightOf(EXPLORE, DATASET)
        await t.frame([DATASET, DESCRIPTION, EXPLORE], 0.8)
        await t.waitForResult(EXPLORE)
      },
    },
    {
      say: 'Many nodes can be opened full size, to show more.',
      do: async (t) => {
        await t.click({ node: EXPLORE, css: '[aria-label="Expand output"]' })
        await t.waitFor(`!!document.querySelector('${inDialog('.explore__input')}:not(:disabled)')`, 'the search box')
      },
    },
    {
      say: "Let's look for a specific neuron. You can type a free-form, fuzzy search, or search one field, like type==CT1.",
      spoken:
        "Let's look for a specific neuron. You can type a free-form, fuzzy search, or search one field: here, type equals C T one.",
      do: async (t) => {
        await t.type(inDialog('.explore__input'), 'type==CT1', { enter: true })
        await t.waitFor(`document.querySelectorAll('${inDialog('.explore-row')}').length === 2`, 'the two CT1 rows')
      },
    },
    {
      say: 'Hover over a thumbnail for a rotating preview.',
      do: async (t) => {
        await t.hover(inDialog('.explore-thumb-slot'), 2600)
      },
    },
    {
      say: 'To select neurons, tick their checkboxes, or use the controls at the bottom right.',
      do: async (t) => {
        await t.click({ css: inDialog('.explore__link'), text: '+ all' })
        await t.pause(900)
        await t.click('[aria-label="Close viewer"]')
      },
    },
    {
      chapter: 'Viewing the neurons',
      say: "Now let's see them in 3D, with a Neuroglancer node.",
      // Run together, `say` mispronounces it; as two words it comes out right.
      spoken: "Now let's see them in 3D, with a neuro glancer node.",
      do: async (t) => {
        await t.frame([DATASET, EXPLORE], 0.62)
      },
    },
    {
      say: 'You can also add a node by dragging a wire from a socket and dropping it on the canvas.',
      gapBefore: 1,
      lead: 1.5,
      do: async (t) => {
        // Towards the socket while the gesture is described, so the next line starts on it.
        await t.moveTo({ node: EXPLORE, handle: 'selected' }, { ms: 1600 })
      },
    },
    {
      say: 'Here, we drag the Selected output and connect it to a Neuroglancer node.',
      spoken: 'Here, we drag the Selected output and connect it to a neuro glancer node.',
      lead: 0.6,
      do: async (t) => {
        // Slow on purpose, so the wire being drawn out is the thing on screen while it is named.
        await t.drag(
          { node: EXPLORE, handle: 'selected' },
          { node: EXPLORE, css: '.coda-node', at: [1.25, 0.05] },
          { approach: 200, dwell: 500, ms: 2600 },
        )
        await t.type('.add-menu__search', 'Neuroglancer')
        await t.pause(400)
        await t.click({ css: '.add-menu__item', text: 'Neuroglancer' })
        await t.waitForResult(NEUROGLANCER)
      },
    },
    {
      say: 'Neuron Profile gives a high-level summary of the neurons you selected. Same move: a wire from Selected, dropped below.',
      do: async (t) => {
        await t.drag(
          { node: EXPLORE, handle: 'selected' },
          { node: EXPLORE, css: '.coda-node', at: [1.25, 1.35] },
        )
        await t.type('.add-menu__search', 'Neuron Profile')
        await t.pause(400)
        await t.click({ css: '.add-menu__item', text: 'Neuron Profile' })
        await t.waitForResult(PROFILE)
        await t.frame([DATASET, DESCRIPTION, EXPLORE, NEUROGLANCER, PROFILE], 0.8)
      },
    },
    {
      chapter: 'Dashboards and sharing',
      say: "Once you've built a workflow, you can turn it into a dashboard, which puts the parts that matter most side by side.",
      gapBefore: 1,
      do: async (t) => {
        await t.click('[aria-label="Dashboard"]')
        await t.pause(800)
        // Explore Dataset first, so it takes the left column and Neuron Profile the right.
        await t.click({ css: '.dashboard__add > button', text: '+ Add node' })
        await t.click({ css: '.dashboard__addMenu .dropdown__item', text: 'Explore Dataset' })
        await t.pause(600)
        await t.drag('.dash-cell__resize', { css: '.dash-cell__resize', offset: [0, 520] })
        await t.pause(500)
        await t.click({ css: '.dashboard__add > button', text: '+ Add node' })
        await t.click({ css: '.dashboard__addMenu .dropdown__item', text: 'Neuron Profile' })
        await t.pause(600)
        await t.drag('.dash-cell:last-of-type .dash-cell__resize', {
          css: '.dash-cell:last-of-type .dash-cell__resize',
          offset: [0, 520],
        })
        await t.pause(1500)
      },
    },
    {
      say: 'Workflows, including dashboard views, can be easily shared: just copy the link and send it to your colleagues.',
      do: async (t) => {
        /*
         * For the recording only: the link box shows the deployed origin and the localhost notice
         * is hidden. The fragment — the graph itself — is untouched, so this is exactly the link
         * the deployed site gives for this workflow. Installed before the click, so no frame
         * catches the dialog before the rewrite.
         */
        await t.inPage(`
          const rewrite = () => {
            const input = document.querySelector('.share__link input[aria-label="Shareable link"]')
            if (input && input.value.startsWith(location.origin)) {
              input.value = '${SITE}' + input.value.slice(location.origin.length)
            }
            for (const p of document.querySelectorAll('.share__advisory')) {
              if (p.textContent.includes('only opens where Coda is running now')) p.style.display = 'none'
            }
          }
          new MutationObserver(rewrite).observe(document.body, { childList: true, subtree: true })
        `)
        await t.click('[aria-label="Share workflow"]')
        await t.pause(600)
        await t.hover({ css: '.share__link button.btn', text: 'Copy' }, 2000)
        await t.click('.share .modal__header button[aria-label="Close"]')
        await t.pause(400)
        await t.click({ css: '.dashboard button.btn', text: '← Canvas' })
      },
    },
    {
      chapter: 'Where next',
      say: "That's the basics, and we've barely scratched the surface: there are many more nodes to explore.",
      do: async (t) => {
        await t.moveTo({ css: '.react-flow__pane', at: [0.55, 0.5] }, { ms: 1200 })
      },
    },
    {
      say: 'Do try the Workflow Wizard. It builds workflows for common tasks from a few simple questions.',
      do: async (t) => {
        // Off camera, and before the wizard builds anything: its Shortest paths workflow would
        // otherwise run Paths (an expensive node) before anybody has ticked a neuron, and open on
        // a red card and a "1 node failed" toast. Not from the start, because Explore Dataset is
        // expensive too, and the two viewers above sit blocked on its Selected output without it.
        await t.inPage('s.getState().setAutoRun(false)')
        await t.click('[data-tour="new"] > button')
        await t.click({ css: '.dropdown__item', text: 'Workflow Wizard…' })
        await t.pause(700)
        await t.click({ css: '.wizard__option', text: 'MaleCNS (neuPrint)' })
        await t.pause(500)
        await t.clickIf({ css: '.wizard__foot .btn--primary', text: 'Continue' })
        await t.pause(700)
        await t.click({ css: '.wizard__option', text: 'Interactive Search with Thumbnails' })
        await t.pause(700)
        await t.click({ css: '.wizard__option', text: 'Shortest paths' })
        await t.pause(900)
        await t.click({ css: '.wizard__foot .btn--primary', text: 'Continue' })
        await t.pause(900)
        await t.click({ css: '.wizard__foot .btn--primary', text: 'Create workflow' })
        await t.pause(1800)
      },
    },
    {
      say: 'If you get stuck, the guides and the documentation are one click away.',
      do: async (t) => {
        await t.click('[data-tour="help"] > button')
        await t.hover({ css: '.dropdown__item--parent', text: 'Guides' }, 1200)
        await t.hover({ css: '.dropdown__item--parent', text: 'Documentation' }, 1200)
      },
    },
    {
      say: 'Now go explore, and let us know what you think!',
      do: async (t) => {
        await t.hover({ css: '.dropdown__item', text: 'Give Feedback' }, 1500)
      },
    },
  ],
}
