/**
 * The NeuronBridge records Coda reads, and the one place they are parsed.
 *
 * The published contract is `schemas/PrecomputedMatches.json` in each data version. It is
 * generated from Janelia's Python model and versioned, so it is stable — but it is still a third
 * party's JSON arriving in a browser, and a field that moved would otherwise surface as
 * `undefined` three components away. So every record goes through a reader here that keeps what it
 * recognises and drops what it does not, and a whole file that is not the shape it claims to be is
 * refused with a sentence rather than half-rendered.
 *
 * Only the fields something here reads are typed. The files map is kept whole, because which keys
 * it carries is the answer to "does this neuron have PPPM matches" and "is there an aligned SWC".
 */

/** Relative paths (or absolute URLs) to the files behind an image or a match, plus their store. */
export type NbFiles = Readonly<Record<string, string>>

/** One image NeuronBridge indexed: an EM body's rendering, or one LM sample's channel. */
export interface NbImage {
  readonly type: 'EMImage' | 'LMImage'
  /** NeuronBridge's own id for the image — what its match files are named by. */
  readonly id: string
  /** `hemibrain:v1.2.1:1734350788` for EM; the line name (`SS02800`) for LM. */
  readonly publishedName: string
  readonly libraryName: string
  readonly alignmentSpace: string
  /** `Brain` or `VNC`. */
  readonly anatomicalArea: string
  readonly files: NbFiles
  readonly neuronType?: string
  readonly neuronInstance?: string
  readonly gender?: string
  readonly slideCode?: string
  readonly objective?: string
  readonly channel?: number
}

/** One entry of a match file: the other image, and how well it matched. */
export interface NbMatch {
  readonly type: 'CDSMatch' | 'PPPMatch'
  readonly image: NbImage
  /** The match's own files — the masked search images CDS compared, PPPM's renderings. */
  readonly files: NbFiles
  readonly mirrored: boolean
  /** CDS only. Larger is better. */
  readonly normalizedScore?: number
  /** CDS only. */
  readonly matchingPixels?: number
  /** PPPM only. Smaller is better; 0 is the best match. */
  readonly pppmRank?: number
  /** PPPM only. */
  readonly pppmScore?: number
}

/** A whole match file: what was searched with, and everything it matched. */
export interface NbMatches {
  readonly inputImage: NbImage
  readonly results: readonly NbMatch[]
}

type Json = Record<string, unknown>

/** A JSON object — not null, not an array. */
export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  // Ids arrive as strings in the current schema; a number is accepted and kept as its digits
  // rather than refused, because an image id is 19 digits and must never pass through a float.
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The string-valued entries of an object: a record's files, or a store's URL prefixes. */
export function readFiles(value: unknown): NbFiles {
  if (!isObject(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** An image record, or undefined when it lacks what makes it one. */
export function readImage(value: unknown): NbImage | undefined {
  if (!isObject(value)) return undefined
  const type = value.type
  if (type !== 'EMImage' && type !== 'LMImage') return undefined
  const id = text(value.id)
  const publishedName = text(value.publishedName)
  const libraryName = text(value.libraryName)
  if (!id || !publishedName || !libraryName) return undefined
  const optional = {
    neuronType: text(value.neuronType),
    neuronInstance: text(value.neuronInstance),
    gender: text(value.gender),
    slideCode: text(value.slideCode),
    objective: text(value.objective),
    channel: finite(value.channel),
  }
  return {
    type,
    id,
    publishedName,
    libraryName,
    alignmentSpace: text(value.alignmentSpace) ?? '',
    anatomicalArea: text(value.anatomicalArea) ?? '',
    files: readFiles(value.files),
    // Built without the absent keys rather than with explicit `undefined`s, which is what
    // `exactOptionalPropertyTypes` asks and what keeps a record structurally clonable.
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  }
}

function readMatch(value: unknown): NbMatch | undefined {
  if (!isObject(value)) return undefined
  const type = value.type
  if (type !== 'CDSMatch' && type !== 'PPPMatch') return undefined
  const image = readImage(value.image)
  if (!image) return undefined
  const scores = {
    normalizedScore: finite(value.normalizedScore),
    matchingPixels: finite(value.matchingPixels),
    pppmRank: finite(value.pppmRank),
    pppmScore: finite(value.pppmScore),
  }
  return {
    type,
    image,
    files: readFiles(value.files),
    mirrored: value.mirrored === true,
    ...Object.fromEntries(Object.entries(scores).filter(([, v]) => v !== undefined)),
  }
}

/** The `results` list of a `by_body` / `by_line` lookup. Unreadable entries are dropped. */
export function readLookup(value: unknown, url: string): NbImage[] {
  if (!isObject(value) || !Array.isArray(value.results)) {
    throw new Error(`${url} is not a NeuronBridge lookup: it has no "results" list.`)
  }
  return value.results.map(readImage).filter((image) => image !== undefined)
}

/**
 * A match file. Unreadable matches are dropped; a file with no readable input image is refused,
 * since every match in it is *relative to* that image and would be meaningless without it.
 */
export function readMatches(value: unknown, url: string): NbMatches {
  const inputImage = isObject(value) ? readImage(value.inputImage) : undefined
  if (!isObject(value) || !inputImage || !Array.isArray(value.results)) {
    throw new Error(`${url} is not a NeuronBridge match file: no input image or no results.`)
  }
  return {
    inputImage,
    results: value.results.map(readMatch).filter((match) => match !== undefined),
  }
}
