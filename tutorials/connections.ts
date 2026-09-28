/**
 * "Connections": where credentials go, shown and never entered.
 *
 * Nothing is typed, pasted or signed in to. A credential on screen is a credential published, and
 * after a sign-in the dialog shows whose account it is. So the video points at each control and
 * says what it does; the recording's browser has no credentials at all.
 *
 * On an empty canvas: a dataset node would start its listing, and a refused listing is exactly
 * what opens this dialog by itself, which is not the way the video means to show it opening.
 */

import type { Tutorial } from './tutorial'

const dialog = (css: string) => `[role="dialog"] ${css}`

export const tutorial: Tutorial = {
  title: 'Connections',
  topic: 'Connections',
  music: 'Sophomore Makeout - Silent Partner.mp3',

  async setup(t) {
    await t.inPage(`
      const { emptyGraph } = await appModule('/src/core/graph.ts')
      s.getState().setGraph(emptyGraph('Connections'))
    `)
  },

  steps: [
    {
      say: 'Most connectomes need an account. Coda keeps yours in one place: Connections.',
      lead: 2.4,
      do: async (t) => {
        await t.moveTo('[data-tour="connections"]', { ms: 1400 })
      },
    },
    {
      say: 'Open it from the toolbar.',
      do: async (t) => {
        await t.click('[data-tour="connections"]')
        await t.waitFor(`!!document.querySelector('${dialog('[role="tab"]')}')`, 'the Connections dialog')
      },
    },
    {
      say: 'Credentials stay in this browser. They are never sent to us.',
      do: async (t) => {
        await t.hover({ css: dialog('*'), text: 'Credentials stay in this browser.' }, 1400)
      },
    },
    {
      say: 'For neuPrint, which serves the hemibrain, MANC and the male CNS, sign in with the Google account you use there.',
      spoken:
        'For new print, which serves the hemi brain, the man c and the male C N S, sign in with the Google account you use there.',
      do: async (t) => {
        await t.hover({ css: dialog('button'), text: 'Sign in with Google' }, 1600)
      },
    },
    {
      say: 'Or paste a token from your neuPrint account page instead.',
      spoken: 'Or paste a token from your new print account page instead.',
      do: async (t) => {
        await t.click({ css: dialog('summary'), text: '… or paste a token manually' })
        await t.pause(500)
        await t.hover({ css: dialog('a'), text: 'neuprint.janelia.org/account' }, 1400)
      },
    },
    {
      say: 'Test checks that a connection works, and Forget removes it again.',
      do: async (t) => {
        await t.hover({ css: dialog('button'), text: 'Test' }, 900)
        await t.hover({ css: dialog('button'), text: 'Forget' }, 900)
      },
    },
    {
      say: 'CAVE works the same way, for FlyWire, BANC and MICrONS: sign in, or paste a token.',
      spoken: 'Cave works the same way, for fly wire, bank and microns: sign in, or paste a token.',
      do: async (t) => {
        await t.click({ css: dialog('[role="tab"]'), text: 'CAVE' })
        await t.pause(500)
        await t.hover({ css: dialog('button'), text: 'Sign in with Google' }, 1400)
      },
    },
    {
      say: "Public CATMAID servers, like Virtual Fly Brain's, need nothing at all.",
      spoken: "Public cat maid servers, like Virtual Fly Brain's, need nothing at all.",
      do: async (t) => {
        await t.click({ css: dialog('[role="tab"]'), text: 'CATMAID' })
        await t.pause(600)
      },
    },
    {
      say: 'Once you are connected, every dataset on that server just works.',
      do: async (t) => {
        await t.pause(1200)
        await t.click(dialog('button[aria-label="Close"]'))
      },
    },
  ],
}
