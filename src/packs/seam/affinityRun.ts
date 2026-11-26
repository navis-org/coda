/**
 * One neuron's full affinity matrix: encode once, decode in chunks.
 *
 * The encoder runs over the whole cloud and its outputs stay **held in the worker**; the decoder
 * is then called once per chunk of pairs with those held tensors fed back in by name. That split
 * is the only reason the browser budget works at all — upstream's `eval_affinity.py` re-runs the
 * 24-layer encoder once per chunk, which is ~390 GFLOP paid fifty times over.
 *
 * ## Why the chunk size is a Cancel decision
 *
 * A decode call is inside ONNX Runtime and has no interrupt point a message could reach, so the
 * signal can only be looked at **between** chunks. At N = 1024 the whole decode is ~12 seconds; a
 * chunk of 16,384 pairs is ~0.3 s measured, so that is how long Cancel takes to be seen. Making
 * the chunk the whole matrix would be marginally faster and would make Cancel mean "in twelve
 * seconds", which `limits.md`'s distance row records as the thing that had to be fixed there.
 *
 * ## Two traps, both silent
 *
 * - **A fed buffer is transferred, not copied** (`transfersOf`), so the array handed in is
 *   detached the moment it is posted. The cloud is copied before feeding, because the caller
 *   still needs those coordinates for the `Points` output — without the copy that output is a
 *   zero-length array with nothing thrown.
 * - **The decoder's pair input is found by elimination**, not by a name written here: it is the
 *   one input that is not an encoder output. A hard-coded name would be a third place the
 *   converter's choice is spelled, and the symptom of a stale one is an ONNX Runtime error about
 *   a missing feed rather than anything naming this file.
 */

import { throwIfAborted } from '../../core/slice'
import type { ModelSession } from '../../ml/session'

/**
 * How many pairs one decoder call takes: ~0.3 s, which is the Cancel latency. See the header.
 */
export const DECODE_CHUNK_PAIRS = 16_384

/** What this needs of a session, so a test can hand it a matrix it already knows. */
export type AffinityRunner = Pick<ModelSession, 'loaded' | 'run' | 'release'>

export interface AffinityRunOptions {
  readonly signal?: AbortSignal
  /** 0..1 through this neuron's pairs. Called per chunk. */
  readonly onProgress?: (fraction: number) => void
}

/**
 * Affinities between every ordered pair of `points` points, row-major `points × points`.
 *
 * `cloud` is xyz interleaved, already centred and scaled — `pointCloud.ts`' output, which is
 * exactly what the encoder was trained on. The full square including the diagonal, as upstream
 * computes it: `affinityOps.ts` never reads `a(i,i)`, and skipping it would complicate every
 * index to save one row in a thousand.
 */
export async function affinityMatrix(
  session: AffinityRunner,
  cloud: Float32Array,
  points: number,
  options: AffinityRunOptions = {},
): Promise<Float32Array> {
  const { signatures } = session.loaded.manifest
  const encoder = signatures.encoder
  const decoder = signatures.decoder
  if (!encoder || !decoder) {
    throw new Error(
      `${session.loaded.manifest.id} declares no encoder and decoder, so it cannot predict ` +
        `affinities.`,
    )
  }
  if (cloud.length !== points * 3) {
    throw new Error(`A cloud of ${points} points needs ${points * 3} coordinates`)
  }
  const [pointsInput, maskInput] = encoder.inputs
  if (!pointsInput || !maskInput) {
    throw new Error(`${session.loaded.manifest.id}'s encoder takes fewer than two inputs`)
  }
  const pairInput = decoder.inputs.find((name) => !encoder.outputs.includes(name))
  if (!pairInput) {
    throw new Error(
      `${session.loaded.manifest.id}'s decoder takes no input of its own, so there is nowhere ` +
        `to put the pairs.`,
    )
  }

  throwIfAborted(options.signal)
  await session.run({
    part: 'encoder',
    feeds: [
      // Copied: `transfersOf` detaches what it posts, and the caller still needs these.
      { name: pointsInput, type: 'float32', dims: [1, points, 3], data: cloud.slice().buffer },
      // Every point is real. Padding to a fixed width is a training-time convenience and the
      // graph's N is dynamic, so there is nothing to mask out.
      {
        name: maskInput,
        type: 'bool',
        dims: [1, points],
        data: new Uint8Array(points).fill(1).buffer,
      },
    ],
    hold: encoder.outputs,
  })

  try {
    const total = points * points
    const affinity = new Float32Array(total)
    for (let from = 0; from < total; from += DECODE_CHUNK_PAIRS) {
      throwIfAborted(options.signal)
      const count = Math.min(DECODE_CHUNK_PAIRS, total - from)
      const pairs = new BigInt64Array(count * 2)
      for (let k = 0; k < count; k++) {
        const pair = from + k
        pairs[k * 2] = BigInt((pair / points) | 0)
        pairs[k * 2 + 1] = BigInt(pair % points)
      }
      const answer = await session.run({
        part: 'decoder',
        use: encoder.outputs,
        feeds: [{ name: pairInput, type: 'int64', dims: [1, count, 2], data: pairs.buffer }],
      })
      const chunk = answer[0]
      if (!chunk) throw new Error('The decoder returned nothing')
      const values = new Float32Array(chunk.data)
      if (values.length !== count) {
        throw new Error(`The decoder answered ${values.length} of ${count} pairs`)
      }
      affinity.set(values, from)
      options.onProgress?.((from + count) / total)
    }
    return affinity
  } finally {
    // Whatever happened, the latents are ~6 MB of GPU memory with nobody left to read them. A
    // second neuron overwrites them under the same names, so this matters most on the throw.
    await session.release(encoder.outputs)
  }
}
