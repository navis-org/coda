/**
 * VFB Line Gallery: driver-line images as thumbnails, one tile per line, to pick from.
 *
 * Reads Expression Images' table and draws each line at its first whole-line image, with the line's
 * other images behind a `+N`. A ☆ pins an image, and `Pinned` is the input's rows for the pinned
 * images — so the usual route is `Expression Images → Line Gallery → (Pinned) → Load Expression`,
 * loading only the lines somebody looked at and chose, which is what keeps a dozen-line 3D View
 * from becoming a hundred-line download.
 *
 * It shares NeuronBridge's tile (`ui/viewers/ImageTile.tsx`) and that card's two rules:
 * **`cheap`, and `evaluate` never fetches** — the thumbnails are `<img>`s the card loads, so a Run
 * costs nothing — and **pinning is a param**, so `Pinned` is built from params and the input
 * alone. **Browsing is presentational**, NeuronBridge's other rule: the step size and the large
 * view's mode and template are params that change no output, so they persist with the workflow and
 * key nothing.
 */

import { packNode } from '../../core/registry'
import { T, schemaOf, isTabular } from '../../core/types'
import { isTableValue } from '../../core/values'
import { GALLERY_VIEWS, IMAGES_SCHEMA, pinnedImagesTable } from './ops'

export const galleryNode = packNode({
  type: 'vfb:gallery',
  label: 'VFB Line Gallery',
  category: 'visualisation',
  description:
    'Browse driver-line images as thumbnails, one per line, and pin the ones to load.',
  guide:
    'Shows the images from VFB Expression Images as thumbnails, one tile per driver line, and ' +
    'the one you open in a large view: its projection, or slices through its image stack. Pin ' +
    'an image with ☆ and it comes out of Pinned, ready for VFB Load Expression, so only the ' +
    'lines you chose are downloaded and drawn. Running the node fetches nothing.',
  cost: 'cheap',
  defaultSize: { width: 620, height: 560 },

  inputs: [{ id: 'images', label: 'Images', type: T.table() }],
  outputs: [
    { id: 'out', label: 'Images', type: T.table() },
    { id: 'pinned', label: 'Pinned', type: T.table(IMAGES_SCHEMA) },
  ],

  params: [
    {
      id: 'tiles',
      kind: 'int',
      label: 'Lines per step',
      help: 'How many lines the card shows at first, and how many more each "Show more" adds.',
      default: 24,
      min: 6,
      max: 200,
      step: 6,
      presentational: true,
      advanced: true,
    },
    {
      id: 'view',
      kind: 'enum',
      label: 'View',
      help: 'The large view: the maximum projection, or slices through the image stack (which downloads it, up to 26 MB).',
      default: 'projection',
      options: GALLERY_VIEWS.map((v) => ({ value: v.id, label: v.label })),
      presentational: true,
      advanced: true,
    },
    {
      id: 'withTemplate',
      kind: 'boolean',
      label: 'Show template',
      help: 'Draw VFB’s projection over the template brain or VNC, or, unticked, the image stack’s own projection, which holds the signal alone (downloads the stack, up to 26 MB).',
      default: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'pins',
      kind: 'ids',
      label: 'Pinned',
      noun: 'images',
      help: 'The images the Pinned output emits. Set with the ☆ on each tile.',
      default: [],
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.images
    const schema = isTabular(input) ? schemaOf(input) : undefined
    return { out: T.table(schema), pinned: T.table(schema ?? IMAGES_SCHEMA) }
  },

  evaluate: (ctx) => {
    const images = ctx.input('images')
    if (!isTableValue(images)) throw new Error('Images input is not a table')
    const pins = ctx.params.pins as string[]
    return { out: images, pinned: pinnedImagesTable(images, pins) }
  },
})
