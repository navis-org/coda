/**
 * Every node pack, registered in one place.
 *
 * A pack is a directory here. Its `index.ts` exports a `PackDefinition` — the nodes, registered
 * together under the pack's id — and this list is the one place that names it, explicit rather
 * than globbed for the reason `nodes/index.ts` gives: the bundle stays analysable and the
 * registration order stays deterministic. `packs.test.ts` fails a directory missing from it.
 *
 * Everything else a pack brings is a file in its directory that a surface finds for itself:
 *
 * - `glyphs.ts` — the pack's card drawings, merged into `NODE_GLYPHS` by `ui/glyphs.ts`;
 * - `seeAlso.ts` — its "See also" groups, merged by `help/seeAlso.ts`;
 * - `wizard.ts` — its Workflow Wizard answers, merged by `wizard/contribute.ts`;
 * - `help/<name>.md` — the document for `<pack>:<name>`, found by `help/registry.ts`.
 *
 * Found by glob rather than listed, because the glyph table is drawn by `nodes.html`, which has no
 * node definitions in it at all — importing this module there would pull every node in behind a
 * static page. A glob keeps each surface reading exactly the file it needs, which is also the
 * help registry's standing rule: a document exists because its file does.
 */

import { registerPack } from '../core/registry'
import type { PackDefinition } from '../core/registry'
import { catmaid } from './catmaid'
import { cave } from './cave'
import { connectome } from './connectome'
import { cortex } from './cortex'
import { neuprint } from './neuprint'
import { zapbench } from './zapbench'

// A pack is listed after the packs it `requires` and its `parent`: `registerPack` refuses one
// arriving first.
export const PACKS: readonly PackDefinition[] = [
  connectome,
  neuprint,
  cave,
  catmaid,
  zapbench,
  cortex,
]

for (const pack of PACKS) registerPack(pack)
