/**
 * The page a shortcut is reached by: it sends the reader to the app with the shortcut named,
 * carries a share link's fragment along, and asks not to be indexed.
 */

import { describe, expect, it } from 'vitest'

import { SHORTCUTS } from '../src/packs/shortcuts'
import { shortcutPage } from './shortcutPages'

describe('a shortcut page', () => {
  it('redirects to the app with the shortcut named, keeping the fragment', () => {
    const page = shortcutPage('cortex')
    expect(page).toContain('location.replace("../?shortcut=cortex" + location.hash)')
    expect(page).toContain('href="../?shortcut=cortex"')
    expect(page).toContain('<meta name="robots" content="noindex" />')
  })

  it('exists for every shortcut, which is the list the build emits from', () => {
    expect(SHORTCUTS.map((s) => s.id)).toContain('cortex')
  })
})
