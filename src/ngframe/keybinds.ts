/**
 * Spelunker's keybindings, set before neuroglancer loads. Its deployment injects them at build time
 * as the global `NEUROGLANCER_CUSTOM_INPUT_BINDINGS`, which `ui/default_viewer_setup.js` reads once,
 * as the module is evaluated — so `main.ts` imports this first (ES modules evaluate in import
 * order). A runtime global rather than a vite `define`, which would have to reach into a dependency
 * under the dev server. The file is vendored from the bundled commit (`build-neuroglancer.mjs`).
 */

import bindings from '../../vendor/neuroglancer-keybinds.json'

;(
  globalThis as { NEUROGLANCER_CUSTOM_INPUT_BINDINGS?: unknown }
).NEUROGLANCER_CUSTOM_INPUT_BINDINGS = bindings
