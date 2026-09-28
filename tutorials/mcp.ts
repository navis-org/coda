/**
 * "MCP server": a workflow built by an outside AI client, opened and run in Coda.
 *
 * The first half is not Coda at all — it is a screen recording of Claude, made by hand, since a
 * headless browser cannot film another application. It is cut to start after the message is sent
 * (the greeting above the empty chat names the account), cropped to the chat column, and the tool
 * calls are sped up under the narration. The second half is the workflow Claude's link describes,
 * opened in the recording's own browser off camera while the answer is on screen. It runs as it
 * loads, Auto-run being on as it is for anybody following a link — whatever Claude's answer says
 * about pressing Run.
 *
 * The link is resolved when the video is made: the MCP server's short link redirects to a
 * `#!…` fragment that holds the graph, and the fragment is what the dev server is handed.
 */

import type { Tutorial } from './tutorial'

const RECORDING = '/Users/philipps/Desktop/recordings/Screen Recording 2026-09-28 at 13.41.04.mov'
/** The chat column: the title, the question and the answer, 16:9 in the recording's own pixels. */
const CHAT: [number, number, number, number] = [393, 76, 2200, 1238]
const LINK = 'https://flyem.mrc-lmb.cam.ac.uk/coda-mcp/w/ZBv_ZzHlkHgB_mraTIT5rC'

/** The graph the short link stands for, as the `#!…` fragment its redirect carries. */
async function workflowFragment(): Promise<string> {
  const reply = await fetch(LINK, { redirect: 'manual' })
  const target = reply.headers.get('location')
  if (!target) throw new Error(`${LINK} did not redirect (HTTP ${reply.status})`)
  return new URL(target).hash
}

export const tutorial: Tutorial = {
  title: 'MCP server',
  topic: 'MCP server',
  music: 'Sophomore Makeout - Silent Partner.mp3',
  signIn: 'neuprint',

  async setup(t) {
    await t.inPage(`
      const { emptyGraph } = await appModule('/src/core/graph.ts')
      s.getState().setGraph(emptyGraph('MCP'))
    `)
  },

  steps: [
    {
      say: "You can also build Coda workflows from your own AI client, like Claude, through Coda's MCP server.",
      spoken: "You can also build Coda workflows from your own AI client, like Claude, through Coda's, M C P server.",
      clip: { file: RECORDING, from: 3.0, to: 8.0, crop: CHAT },
    },
    {
      say: "Ask for what you want in plain words. Claude reads Coda's catalogue of nodes, builds the workflow, and checks it.",
      clip: { file: RECORDING, from: 8.0, to: 31.3, speed: 4, crop: CHAT },
    },
    {
      say: 'Then it hands you a link, and says what it built.',
      clip: { file: RECORDING, from: 31.3, to: 35.3, crop: CHAT },
      do: async (t) => {
        // Off camera: the footage is on screen while the link loads.
        await t.navigate(await workflowFragment())
        await t.inPage(`
          if (document.querySelector('.wf-tabs__header[aria-expanded="true"]')) s.getState().togglePanel('workflows')
          s.getState().setSelection([])
          // The link's own positions put the Table and the Bar Chart on top of one another; the
          // canvas's arrange is the one-click fix anybody opening it would reach for.
          s.getState().requestArrange()
        `)
        await t.pause(1500)
        await t.frameAll(0.8)
      },
    },
    {
      // Auto-run is on, as it is for anybody opening a link: the workflow starts as it loads.
      say: 'Open the link, and the workflow loads in Coda, and runs.',
      do: async (t) => {
        await t.moveTo({ css: '.react-flow__pane', at: [0.5, 0.5] }, { ms: 1200 })
        await t.waitSettled()
        // Again, now the Table has rows: the first arrange measured it before it grew.
        await t.inPage(`s.getState().requestArrange()`)
        await t.pause(1200)
        await t.frameAll(0.8)
      },
    },
    {
      say: 'Here, the downstream partners of CT1, summed by type.',
      spoken: 'Here, the downstream partners of C T one, summed by type.',
      do: async (t) => {
        await t.moveTo({ node: 'out.barChart', css: '.coda-node', at: [0.45, 0.7] })
        await t.pause(800)
      },
    },
    {
      say: 'These are ordinary cards, so you can change anything, or keep building from here.',
      do: async (t) => {
        await t.pause(1500)
      },
    },
    {
      say: 'To connect your own client, open the MCP guide: under the question mark, Documentation.',
      spoken: 'To connect your own client, open the M C P guide: under the question mark, Documentation.',
      do: async (t) => {
        await t.click('[data-tour="help"] > button')
        await t.hover({ css: '.dropdown__item--parent', text: 'Documentation' }, 900)
        // Sideways into the flyout first, then down it, as a hand would: the straight diagonal to
        // MCP Server leaves the Documentation row over the menu's lower rows, and the flyout
        // closes before the pointer reaches it.
        await t.moveTo({ css: '.dropdown__flyout .dropdown__item', text: 'Overview' }, { ms: 500 })
        await t.clickOpensTab({ css: '.dropdown__flyout .dropdown__item', text: 'MCP Server' })
        // The item opens a new tab, which this recording cannot follow: this is the cut to it.
        await t.navigate('mcp.html')
      },
    },
    {
      say: "Add Coda's server address wherever your client keeps its MCP servers. There is nothing to install, and it needs no key.",
      spoken:
        "Add Coda's server address wherever your client keeps its, M C P servers. There is nothing to install, and it needs no key.",
      do: async (t) => {
        await t.scrollTo({ css: 'h2', text: 'Connect it' })
        await t.hover('.endpoint b', 1800)
        await t.hover({ css: '.client h3', text: 'Claude' }, 1000)
      },
    },
  ],
}
