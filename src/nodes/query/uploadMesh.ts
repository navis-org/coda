/**
 * Neuropil shells somebody drew themselves.
 *
 * `ROI Meshes`' local counterpart, and `Upload Table`'s: the regions a dataset publishes are the
 * regions its curators named, and a great many questions are about a volume nobody has published
 * — a glomerulus somebody segmented last week, a template-space shell from another lab, one
 * hemisphere of a structure a connectome only lists whole. This reads those off disk.
 *
 * ## Interchangeable with `ROI Meshes`, deliberately
 *
 * The output is a `MeshesValue` carrying `ROI Meshes`' own two columns plus one, so every
 * downstream node behaves identically: the 3D View's `Volumes` socket takes it, `Points in
 * Volumes` reads `roi` with no configuration, `Download` writes it back out as OBJ. That is the
 * whole point of the node — a custom region should not be a second kind of thing.
 *
 * ## The graph carries a reference, not the geometry
 *
 * `data/uploads.ts`' arrangement, shared with `Upload Table` down to the store: `dataId` is a
 * content address and the whole of this node's contribution to the provenance key, and the
 * meshes live in IndexedDB. Read that module's note first. Its cost is the same and is equally
 * deliberate: **a `.coda.json` sent to somebody else arrives without the geometry**, the card
 * names the files, and `evaluate` throws so everything after it is `blocked` rather than running
 * on an empty scene.
 *
 * ## Units are applied here, not at the upload
 *
 * The stored geometry is in the file's own numbers. `Units` scales in `evaluate`, so getting it
 * wrong costs a re-run rather than a re-pick — and so the stored bytes are still what the file
 * said, which is the only form a second look at them can be checked against. It is the one param
 * that changes an output, and it is in the key.
 *
 * Filed under `query/`, which is where the geometry-producing nodes live — it is the only one
 * there that reaches no `DataSource`, but `table/` would be actively misleading about what it
 * emits and a `geometry/` directory for one file would strand `morphology.ts` and `roiMeshes.ts`.
 * Its sibling relationship is carried by `seeAlso.ts`, `uploads.ts` and `ui/nodes/uploadCard.tsx`.
 */

import { registerNode } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import { boundsOf, makeTable } from '../../core/values'
import type { MeshGeometry } from '../../core/values'
import { scalePositions } from '../../data/units'
import {
  getMeshUpload,
  peekMeshUpload,
  uploadMissingBadge,
  uploadMissingReason,
  uploadPeekSettled,
} from '../../data/uploads'
import type { StoredMesh } from '../../data/uploads'

/**
 * What an uploaded shell says about itself.
 *
 * `ROI_MESH_SCHEMA`'s two columns and one more, **written out rather than spread from it** — and
 * the reason is invariant 3 rather than layering, since `roiMeshes.ts` imports that constant from
 * `data/source.ts` one file away and `connectivityOps.ts` imports a column name from it too. The
 * seam's own doc says "a source with more to say may add columns", so it is explicitly
 * extensible: written `tableSchema(...ROI_MESH_SCHEMA.columns, column('file', 'str'))`, the day a
 * source adds a column the schema half would gain one the value half below does not fill, and
 * `makeTable` validates nothing. Three columns spelled here sit adjacent to the three
 * `stored.map(...)` arrays that fill them, which is what invariant 3 asks for. What has to agree
 * is the *names*, and `uploadMesh.test.ts` pins that against the constant.
 *
 * `primary` is true throughout, for the reason the precomputed and CATMAID sources give: it is
 * the licence to sum, nothing in a pile of files says which shells nest, and a source that cannot
 * distinguish has no grounds to withhold it from some rows and not others.
 *
 * `file` is the column a fetch has no counterpart for. A mesh's `roi` is its file's stem, so two
 * directories holding `LO.obj` produce two regions called `LO` and nothing else would say which
 * is which.
 */
export const UPLOADED_MESH_SCHEMA = tableSchema(
  column('roi', 'str'),
  column('primary', 'bool'),
  column('file', 'str'),
)

/**
 * What one unit of the file is worth in nanometres, and what to call it.
 *
 * Three, because those are the three anybody's mesh is actually in: a connectome exports
 * nanometres, a template-space or light-level surface is conventionally microns, and a
 * whole-brain surface out of an MRI pipeline is millimetres. Not voxels — a voxel is not a unit
 * without a dataset to ask, and the factor differs per axis, which is a transform rather than a
 * scale.
 *
 * One table, because there are three readers: the param's options, this node's `evaluate`, and
 * both exporters, which have to emit the same factor under the same word. Written out three
 * times, a corrected factor reaches the canvas and leaves two documents quietly scaling by the
 * old one.
 */
export const UPLOAD_MESH_UNITS: Record<string, { nm: number; label: string }> = {
  nm: { nm: 1, label: 'nanometres' },
  um: { nm: 1_000, label: 'microns' },
  mm: { nm: 1_000_000, label: 'millimetres' },
}

/**
 * The entry for a stored value, falling back to nanometres.
 *
 * One fallback rather than four. Both emitters read the record directly and spelled `?? 1` and
 * `?? 'another unit'` of their own, which is invariant 4's "a `?? literal` beside it is a second
 * copy that drifts" — the table was shared and the lookup was not, and the lookup is the half
 * that decides what a document multiplies by.
 */
export function uploadMeshUnit(units: unknown): { nm: number; label: string } {
  return UPLOAD_MESH_UNITS[String(units)] ?? UPLOAD_MESH_UNITS['nm']!
}

registerNode({
  type: 'core.uploadMesh',
  label: 'Upload Mesh',
  category: 'utility',
  // The status line is a sentence — the "not in this browser" state has to be readable without a
  // tooltip, since it is what a colleague opening a shared graph sees. `Upload Table`'s width.
  cardWidth: 300,
  description:
    'Bring in your own region meshes — OBJ, STL or PLY — as Volumes the 3D View can draw.',
  guide:
    'Your own neuropil shells: OBJ, STL or PLY, one mesh per file and named after it. The output is the same Volumes ROI Meshes produces, so everything downstream takes it unchanged. Set Units to whatever the file is in. Meshes live in this browser rather than in the graph, so a workflow sent to a colleague arrives without them.',
  // No network and no parse: `evaluate` is one IndexedDB read of already-parsed geometry.
  cost: 'cheap',
  inputs: [],
  // "Volumes", matching the socket it is nearly always wired to and `ROI Meshes`' own label.
  outputs: [{ id: 'meshes', label: 'Volumes', type: T.meshes(UPLOADED_MESH_SCHEMA) }],
  params: [
    /*
     * Both written by the node's own body, never typed — `Upload Table`'s arrangement and its
     * reasoning. `advanced` keeps them off the card, where the body draws the file picker
     * instead, while leaving them visible in the inspector, which is the only place the
     * reference behind a card is inspectable at all.
     */
    { id: 'dataId', kind: 'string', label: 'Data', default: '', advanced: true },
    /*
     * `presentational`, for `fileName`'s reason: it cannot change a byte of what `evaluate`
     * returns, since `dataId` decides that and two people picking one file under two labels hold
     * identical geometry. In the key it would re-run the node — and everything downstream of it
     * — for a change nobody could see.
     */
    {
      id: 'fileName',
      kind: 'string',
      label: 'Files',
      default: '',
      advanced: true,
      presentational: true,
      // What the share dialog names when a link is about to go out without the file.
      browserStored: 'uploaded meshes',
    },
    {
      id: 'units',
      kind: 'enum',
      label: 'Units',
      default: 'nm',
      options: Object.entries(UPLOAD_MESH_UNITS).map(([value, unit]) => ({
        value,
        // Sentence case in the picker, lower case in the table, because the exporters quote it
        // mid-sentence — one spelling of the word, one place that capitalises it.
        label: unit.label[0]!.toUpperCase() + unit.label.slice(1),
      })),
      help: 'What one unit in the file means. Everything in Coda is nanometres, so a file in microns drawn as nanometres sits a thousand times too small beside your neurons — with nothing failing, because it is internally consistent.',
    },
  ],

  /*
   * Constant, like `ROI Meshes`'. The columns do not depend on what was picked, so a colour
   * picker downstream populates the moment the wire is made rather than after a file is chosen —
   * and unlike `Upload Table` there is nothing here a peek could add.
   */
  inferOutputs: () => ({ meshes: T.meshes(UPLOADED_MESH_SCHEMA) }),

  /**
   * Two things, both about the files rather than the controls.
   *
   * Nothing is reported while the peek has not settled: "not in this browser" over a node that
   * is about to fill itself in is the false alarm that stops a real one being read, and it would
   * fire on every graph load. `uploadPeekSettled` starts the read it cannot answer, which is what
   * makes that true here — this node's output shape is constant, so unlike `Upload Table` nothing
   * else on the edit path would ever start it.
   */
  validate: (ctx) => {
    const dataId = String(ctx.params.dataId)
    if (!dataId) return ['No mesh chosen — use the button on the node']
    if (!uploadPeekSettled(dataId) || peekMeshUpload(dataId)) return []
    return [uploadMissingBadge(String(ctx.params.fileName), 'meshes')]
  },

  evaluate: async (ctx) => {
    const dataId = String(ctx.params.dataId)
    if (!dataId) {
      throw new Error('No mesh chosen. Use the button on the node to pick an OBJ, STL or PLY.')
    }

    const stored = await getMeshUpload(dataId)
    /*
     * The message names the files rather than the id, because the id is a hash nobody can act on
     * and a filename is the thing to go and find. This is the state a graph opened on another
     * machine lands in, so it has to read as an instruction and not as a fault.
     */
    if (!stored || stored.length === 0) {
      throw new Error(uploadMissingReason(String(ctx.params.fileName), 'meshes', 'node'))
    }

    const scale = uploadMeshUnit(ctx.params.units).nm
    const items = stored.map((mesh) => scaled(mesh, scale))
    return {
      meshes: {
        kind: 'meshes' as const,
        items,
        attributes: makeTable(UPLOADED_MESH_SCHEMA, {
          roi: stored.map((mesh) => mesh.name),
          primary: stored.map(() => true),
          file: stored.map((mesh) => mesh.file),
        }),
        bounds: boundsOf(items.map((item) => item.positions)),
        // Nanometres by construction: `scale` is what makes that true, which is the whole of what
        // the Units param buys. No `space` — a file off a disk says nothing about registration,
        // and claiming one would let a cross-dataset comparison run on coordinates nobody checked.
        units: 'nm' as const,
      },
    }
  },
})

/**
 * One stored mesh at its nanometre scale.
 *
 * **Handed back by reference at scale 1**, which is the default and so the common path. The copy
 * was defended as protecting a buffer the viewer holds — but `getMeshUpload` is a plain
 * IndexedDB `get`, which deserialises a fresh structured clone on every call, so there is nothing
 * to alias: the `StoredMesh` wrapper is discarded when `evaluate` returns and only `positions`
 * survives into the cached value. The copy cost 25 ms and 120 MB per run on a ten-million-vertex
 * set, to multiply by one.
 *
 * `scalePositions` rather than a loop of our own — the one place that knows this codebase is
 * nanometres, and the same call `fetchRoiMeshes` makes on the way out of neuPrint.
 */
function scaled(mesh: StoredMesh, scale: number): MeshGeometry {
  if (scale === 1) return { id: mesh.name, positions: mesh.positions, indices: mesh.indices }
  return {
    id: mesh.name,
    // A fresh array first: `scalePositions` works in place, and the stored clone is about to be
    // held by whatever draws it. `new Float32Array(…)` rather than `.from`, which is 2.2 ms
    // against 0.8 ms on ten million floats — and microns and millimetres are two of the three
    // options, so this is not the rare path.
    positions: scalePositions(new Float32Array(mesh.positions), [scale, scale, scale]),
    indices: mesh.indices,
  }
}
