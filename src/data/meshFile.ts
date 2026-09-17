/**
 * Reading a mesh file somebody picked off their own disk.
 *
 * Three formats, one shape. `obj.ts` was here first and was written for a *fetch* — neuPrint
 * serves its region meshes as OBJ — and this is the other direction: `Upload Mesh` hands a
 * browser `File` to whichever reader its bytes call for. STL and PLY are here because those are
 * what the tools that make a custom neuropil shell write: a segmentation editor, Blender, MeshLab
 * and `trimesh.export` all default to one of the two, and neither has ever been fetchable from a
 * connectome server.
 *
 * ## The dispatch is on the bytes, not only on the name
 *
 * The extension decides where a file with one goes, because it is what the person who saved it
 * meant. A file without one — or with `.mesh`, or `.txt` — is sniffed, and the sniff is written
 * out rather than left to each reader so that "what is this" has one answer.
 *
 * **What the sniff must not do is trust `solid`.** A binary STL carries an 80-byte header that
 * some exporters fill with the word `solid` followed by a name, which is exactly how an ASCII
 * one begins — so "starts with solid" reads a binary file as ASCII, finds no `vertex` lines in
 * it, and reports an empty mesh for a file that is perfectly good. `parseStl` decides by
 * arithmetic instead; see its own note.
 *
 * ## Never throws
 *
 * `parseObj`'s rule, kept for all three: a file that is not a mesh parses to zero vertices and
 * the caller says so in terms somebody can act on. `meshFileProblem` is that sentence for an
 * upload — deliberately **not** `objProblem`, which exists to recognise an HTML error page
 * arriving over the wire with a 200. A file off a disk is never that, and quoting its first
 * eighty bytes at somebody who can see its name in a file picker helps nobody.
 */

import { parseObj } from './obj'
import type { ParsedMesh } from './parsedMesh'
import { EMPTY_MESH } from './parsedMesh'
import { parsePly } from './ply'
import { isBinaryStl, parseStl } from './stl'

/**
 * One decoder for every text read here. Construction is ~130 ns, so this is tidiness rather than
 * a measured saving — but it is also what stops `sniff` decoding the same head twice.
 */
const DECODER = new TextDecoder()

/**
 * Which reader each extension calls for.
 *
 * One table rather than a list of extensions beside a switch beside an if-ladder: those were
 * three statements of the same three-way fact, so a fourth format meant four edits.
 */
const READERS: Record<string, (bytes: Uint8Array) => ParsedMesh> = {
  '.obj': (bytes) => parseObj(DECODER.decode(bytes)),
  '.stl': parseStl,
  '.ply': parsePly,
}

/**
 * What a file picker should offer.
 *
 * The `accept` attribute matches on the *extension*, so this is the list of names rather than of
 * media types — there is no registered type for any of the three, and Chrome hides every file
 * when it is handed one it does not know.
 */
export const MESH_FILE_EXTENSIONS = Object.keys(READERS)

/** The extension, lowercased and with its dot, or `''`. */
function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  return at === -1 ? '' : name.slice(at).toLowerCase()
}

/**
 * What a mesh read out of this file is called: the name without its extension.
 *
 * Here rather than in the card that shows it, because it is the other half of one rule about mesh
 * filenames — this decides what a region is *named*, `extensionOf` decides which reader answers,
 * and both have to agree with the `accept` list above about what counts as an extension.
 */
export function stemOf(fileName: string): string {
  const at = fileName.lastIndexOf('.')
  return (at === -1 ? fileName : fileName.slice(0, at)) || fileName
}

/**
 * Which reader the bytes call for, when the name does not say.
 *
 * PLY declares itself in its first three bytes and is the one certainty here. Everything else is
 * decided by `parseStl`'s own length arithmetic, which is the only reliable test — so a file that
 * is not a PLY is offered to STL, and OBJ is what is left. Ordered that way rather than
 * text-versus-binary, because an ASCII STL and an OBJ are both text and only one of them has
 * `facet` in it.
 */
function sniff(bytes: Uint8Array): string {
  const start = DECODER.decode(bytes.subarray(0, 512)).toLowerCase()
  if (start.startsWith('ply')) return '.ply'
  if (isBinaryStl(bytes)) return '.stl'
  // `solid` is not enough on its own — see the module note — so the ASCII arm asks for the word
  // no OBJ ever carries.
  if (start.includes('facet normal') || start.includes('outer loop')) return '.stl'
  return '.obj'
}

/**
 * Read one mesh file.
 *
 * The name is used for its extension only; nothing here reads it as an identity.
 */
export function parseMeshFile(name: string, bytes: Uint8Array): ParsedMesh {
  if (bytes.byteLength === 0) return EMPTY_MESH
  return (READERS[extensionOf(name)] ?? READERS[sniff(bytes)]!)(bytes)
}

/**
 * What went wrong with a file somebody picked, or undefined when nothing did.
 *
 * Three states rather than two, because "no vertices" and "no faces" are different mistakes and
 * only one of them is likely to be a wrong file: a vertex-only PLY is a point cloud, which is a
 * real thing to have and simply not a thing this node can draw.
 */
export function meshFileProblem(mesh: ParsedMesh, name: string): string | undefined {
  if (mesh.positions.length > 0 && mesh.indices.length > 0) return undefined
  if (mesh.positions.length === 0) {
    return `"${name}" has no vertices in it — Coda reads OBJ, STL and PLY.`
  }
  return (
    `"${name}" has ${mesh.positions.length / 3} vertices and no faces, so it is a point cloud ` +
    `rather than a surface.`
  )
}
