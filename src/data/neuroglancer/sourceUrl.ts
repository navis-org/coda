/**
 * Neuroglancer source specs, in every spelling somebody pastes.
 *
 * One string names three things at once — a **format**, a **location** and (in the newer
 * syntax) a bag of options — and neuroglancer accepts at least three ways of writing them:
 *
 *     precomputed://gs://flyem-male-cns/v1.0/segmentation/       legacy scheme prefix
 *     gs://flyem-male-cns/v1.0/segmentation/|neuroglancer-precomputed:   the current one
 *     gs://flyem-male-cns/v1.0/segmentation/                     what people actually copy
 *
 * All three name the same directory, and a user pasting one out of a viewer's layer panel has
 * no reason to know which they got. So this parses all of them into the same triple, and the
 * node above it never sees the difference.
 *
 * **The location keeps its own scheme.** `gs://bucket/path` is not turned into an HTTP URL
 * until somebody asks for `url`, because the object-store form is what a neuroglancer layer's
 * `source` field wants back — `canonical` is the spelling that goes into a scene, and it must
 * survive the round trip unchanged or a layer built from a parsed source points at a bucket
 * through a proxy hostname nobody configured.
 *
 * **A bare location is read as `precomputed`.** Neuroglancer itself would refuse it; this is
 * the one place that guesses, and it guesses the format every connectome bucket in reach
 * actually publishes. Anything else has to be said, which is what the pipe syntax is for.
 */

import { objectStoreUrl } from '../precomputed/transport'

/**
 * Schemes that name **where** something is rather than **what** it is.
 *
 * The whole of what separates `precomputed://gs://…` from `gs://…`: the first `://` in a source
 * spec is the format's only when what precedes it is not one of these. Without the distinction
 * a bare bucket URL parses as a format called `gs` with no location at all.
 */
const LOCATION_SCHEMES: ReadonlySet<string> = new Set(['gs', 's3', 'http', 'https'])

/**
 * Format ids as the pipe syntax spells them, mapped onto the legacy scheme names.
 *
 * Only the ones that can name a directory of geometry. A format absent from this is carried
 * through under its own name rather than rejected here — refusing belongs to whoever tries to
 * *read* it, which can say what it wanted instead.
 */
const FORMATS: Readonly<Record<string, string>> = {
  'neuroglancer-precomputed': 'precomputed',
  precomputed: 'precomputed',
  zarr: 'zarr',
  zarr2: 'zarr',
  zarr3: 'zarr',
  n5: 'n5',
}

/** The format Coda can actually read. Everything else parses and is refused with its name. */
export const PRECOMPUTED = 'precomputed'

export interface NgSourceRef {
  /**
   * Data format, normalised onto the legacy scheme names — `precomputed`, `zarr`, `n5`,
   * `graphene`, `dvid`. `precomputed` when the spec named none, which is the guess documented
   * in the header.
   */
  scheme: string
  /** Location with its own scheme intact and no trailing slash: `gs://bucket/path`. */
  location: string
  /** `scheme://location` — the spelling a neuroglancer layer's `source` field takes. */
  canonical: string
  /**
   * Whether the spec *said* what format it is, rather than being read as `precomputed`.
   *
   * Carried because one caller may not guess: `meshCandidateUrl` in `neuprint/nglayers.ts`
   * filters the candidate layers of a published state, where a `source` field with no format is
   * not a precomputed one — it is a string nobody wrote as a source at all.
   */
  stated: boolean
  /**
   * A URL a browser can `fetch`, when the location is one Coda knows how to reach.
   *
   * Undefined for `dvid://`, `brainmaps://` and anything else whose location is not an object
   * store or a plain HTTP path. Undefined is a refusal, not an omission — see `objectStoreUrl`,
   * where guessing a host produced 404s that read as missing neurons.
   */
  url?: string
}

/**
 * Parse a source spec. Undefined only for a string with nothing in it.
 *
 * Note what this does *not* do: it never says whether the format is one anything here can read,
 * and it never says whether the location exists. Both are somebody else's answer — the first
 * `PrecomputedSource`'s and the second the network's — and folding either in here would make a
 * pure function that a card cannot call while somebody is still typing.
 */
export function parseNgSource(text: string): NgSourceRef | undefined {
  const held = PARSED.get(text)
  if (held !== undefined || PARSED.has(text)) return held
  const ref = parse(text)
  // Bounded only by how many distinct strings somebody types, and each is one small object. The
  // reason it is worth having at all: two of this node's three readers run on *every* graph
  // mutation, and a pure function of a string is the cheapest possible thing to remember.
  if (PARSED.size > 512) PARSED.clear()
  PARSED.set(text, ref)
  return ref
}

const PARSED = new Map<string, NgSourceRef | undefined>()

function parse(text: string): NgSourceRef | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined

  /*
   * The pipe syntax, which is `location|format:options` and may carry more than one format
   * segment. The first segment naming a format this understands wins; an unrecognised one is
   * skipped rather than adopted, because the options half of a segment can itself contain a
   * colon and a bare `:` is not a format name.
   */
  const parts = trimmed.split('|')
  let location = (parts[0] ?? '').trim()
  let scheme: string | undefined
  for (const part of parts.slice(1)) {
    const name = part.split(':')[0]?.trim().toLowerCase()
    if (name && FORMATS[name]) {
      scheme = FORMATS[name]
      break
    }
  }

  // The legacy prefix, read only when it is not itself a location scheme.
  const at = location.indexOf('://')
  if (at > 0) {
    const head = location.slice(0, at).toLowerCase()
    if (!LOCATION_SCHEMES.has(head.replace(/^middleauth\+/, ''))) {
      scheme ??= FORMATS[head] ?? head
      location = location.slice(at + 3)
    }
  }

  /*
   * `middleauth+` is an authentication instruction to spelunker, not part of the address — see
   * `scene.ts`, where the two viewer flavours disagree about whether it belongs. Stripped here
   * so a graphene source pasted out of one viewer does not become a different location from the
   * same source pasted out of the other.
   */
  location = location.replace(/^middleauth\+/, '').replace(/\/+$/, '')
  if (!location) return undefined
  const stated = scheme !== undefined
  scheme ??= PRECOMPUTED

  const url = fetchableUrl(location)
  return {
    scheme,
    location,
    canonical: `${scheme}://${location}`,
    stated,
    ...(url ? { url } : {}),
  }
}

/**
 * The location as something `fetch` accepts, or undefined where Coda cannot reach it.
 *
 * `objectStoreUrl` owns which schemes are buckets and already answers undefined for anything
 * else rather than guessing a host — so asking it *is* the test, and a regex here would be a
 * second place to update when a scheme is added to it.
 */
function fetchableUrl(location: string): string | undefined {
  const bucket = objectStoreUrl(location)
  if (bucket) return bucket
  // Trailing slashes are already gone: the caller strips them before canonicalising.
  return /^https?:\/\//i.test(location) ? location : undefined
}
