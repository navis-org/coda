/**
 * What crosses between the editor and the Python runtime.
 *
 * The protocol is deliberately about *calling a function*, not about NBLAST. One Pyodide
 * instance is shared by everything — it is a module-level singleton in `engine.ts`, so the
 * tenth capability costs the same nothing the second does — and each capability contributes a
 * Python file and a typed wrapper rather than a new message type. `nblast.ts` is the first of
 * those wrappers and the shape to copy.
 *
 * Two conventions make that work, and both were established against the runtime rather than
 * assumed (`scripts/probe-nblast.mjs` exercises them):
 *
 * - **Arguments go over as they are.** A JS object arrives in Python as a dict through
 *   `.to_py()`, and a typed array nested inside one arrives as a buffer `np.frombuffer` reads
 *   directly. So a call passes one request object and the Python side unpacks it — no
 *   marshalling layer, and the buffers can still be transferred rather than copied.
 * - **Results are a flat dict.** Every value is a scalar or a **one-dimensional** array, with
 *   any shape carried as its own scalar entry. That restriction is the load-bearing part: a
 *   2-D numpy array does not fail to convert, it converts to a nested plain `Array` — 160,000
 *   boxed numbers for a 400 x 400 matrix, with nothing to say it went wrong.
 */

/** Anything a call may carry. Structured-clone safe, so it survives `postMessage`. */
export type PyArg =
  | number
  | string
  | boolean
  | null
  | undefined
  | Float32Array
  | Float64Array
  | Int32Array
  | PyArg[]
  | { [key: string]: PyArg }

/**
 * What a Python function hands back: scalars and flat typed arrays, by name.
 *
 * Untyped on purpose — the typed wrapper for each capability narrows it, which is where the
 * knowledge of what that function returns belongs. `numberFrom`/`float64From` are the readers.
 */
export type PyResult = Record<string, unknown>

export interface PyCall {
  /** Which Python file to make sure is loaded. See `MODULES` in `runtime.ts`. */
  module: string
  /** A global function in it. Takes its arguments, then `report` last. */
  fn: string
  args: PyArg[]
}

/** Main thread to worker. */
export interface WorkerRequest {
  id: number
  call: PyCall
}

/** Worker to main thread. */
export type WorkerReply =
  | { id: number; kind: 'progress'; fraction: number; note?: string }
  | { id: number; kind: 'done'; result: PyResult }
  | { id: number; kind: 'error'; message: string }

/** Read a number a Python function promised, failing by name rather than as a `NaN`. */
export function numberFrom(result: PyResult, key: string): number {
  const value = result[key]
  if (typeof value !== 'number') {
    throw new Error(`Python returned no number called "${key}" (got ${typeof value})`)
  }
  return value
}

/** Read an int32 array a Python function promised. */
export function int32From(result: PyResult, key: string): Int32Array {
  const value = result[key]
  if (!(value instanceof Int32Array)) {
    // A `BigInt64Array` here is a numpy int64 that nobody cast on the way out. It converts
    // without complaint and then compares equal to nothing on this side.
    throw new Error(
      `Python returned no flat int32 array called "${key}" ` +
        `(got ${value instanceof BigInt64Array ? 'int64 — cast it to int32' : typeof value})`,
    )
  }
  return value
}

/**
 * Read a float32 array a Python function promised.
 *
 * A numpy float32 array crosses as a `Float32Array` — checked against the runtime rather than
 * assumed, in `scripts/probe-transform.mjs`, because it is the same class of thing
 * `float64From`'s note is about. Worth using wherever the values are going straight into
 * geometry buffers, which are float32 already: float64 out would double the transfer to
 * deliver precision the destination cannot hold.
 */
export function float32From(result: PyResult, key: string): Float32Array {
  const value = result[key]
  if (!(value instanceof Float32Array)) {
    throw new Error(
      `Python returned no flat float32 array called "${key}" ` +
        `(got ${Array.isArray(value) ? 'a nested Array — ravel it' : typeof value})`,
    )
  }
  return value
}

/** Read a float64 array a Python function promised. */
export function float64From(result: PyResult, key: string): Float64Array {
  const value = result[key]
  if (!(value instanceof Float64Array)) {
    // An `Array` here is the flat-result convention broken: a 2-D numpy array converts to
    // nested plain arrays rather than failing, so this is where that shows up.
    throw new Error(
      `Python returned no flat float64 array called "${key}" ` +
        `(got ${Array.isArray(value) ? 'a nested Array — ravel it' : typeof value})`,
    )
  }
  return value
}
