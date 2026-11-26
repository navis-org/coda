/**
 * Just enough of an ONNX file to read a network's weights and wiring: initializers and nodes.
 *
 * The hand-written assessor (`network.ts`) runs its own shaders, so it needs the numbers in the
 * file but none of ONNX Runtime. An ONNX file is a protobuf `ModelProto`, and the subset read
 * here is small enough to decode by hand rather than pull in a protobuf library for it:
 *
 * - `ModelProto.graph` (7) → `GraphProto.node` (1) and `.initializer` (5);
 * - `NodeProto`: `input` (1), `output` (2), `op_type` (4), `attribute` (5);
 * - `AttributeProto`: `name` (1), `f` (2), `i` (3), `ints` (8);
 * - `TensorProto`: `dims` (1), `data_type` (2), `float_data` (4), `name` (8), `raw_data` (9),
 *   `data_location` (14).
 *
 * Everything else is skipped by wire type, so a file carrying fields this does not know still
 * reads. A tensor it would misread — anything but float32, or weights stored outside the file
 * (`data_location` EXTERNAL), which would come back empty — is listed with `data` absent and the
 * reason in `unread`, so it is refused when somebody asks for it rather than when the file is
 * opened: a graph's int64 shape constants are not weights and must not stop it loading.
 *
 * **Tensor data is read on demand** (`OnnxTensor.data`): a view into the file's bytes where a
 * float32 view would be aligned, a fresh copy where it would not. Protobuf aligns nothing, so on
 * SEAM's export that is 97 of 108 tensors and 132 MB; copied as the file was parsed, the open
 * held about twice the file. Asked for at the moment a tensor is uploaded, one tensor's copy is
 * alive at a time. Reading through a `DataView` to avoid the copy measured slower than copying.
 */

export class OnnxReadError extends Error {}

export interface OnnxTensor {
  readonly name: string
  readonly dims: readonly number[]
  /**
   * The values: a view where the bytes are aligned, else a new copy **on every call**, so call it
   * once where the values are used and let the result go. Absent when the tensor could not be
   * read as float32; `unread` says why.
   */
  readonly data?: () => Float32Array
  readonly unread?: string
}

export interface OnnxNode {
  readonly opType: string
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
  /** `f`, `i`, `s` (as text) and `ints`. Graphs and tensors are not read. */
  readonly attributes: ReadonlyMap<string, number | string | readonly number[]>
}

export interface OnnxGraph {
  readonly initializers: ReadonlyMap<string, OnnxTensor>
  readonly nodes: readonly OnnxNode[]
}

/** ONNX's `TensorProto.DataType.FLOAT`. */
const FLOAT = 1
/** `TensorProto.DataLocation.EXTERNAL`. */
const EXTERNAL = 1

const decoder = new TextDecoder()

/** A cursor over one length-delimited message. */
class Reader {
  at: number
  readonly bytes: Uint8Array
  readonly end: number
  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes
    this.at = start
    this.end = end
  }

  get done(): boolean {
    return this.at >= this.end
  }

  /**
   * A varint as a JavaScript number. Exact to 2^53, which every length, field number and
   * dimension here is far below. A negative int64 is ten bytes of two's complement, so it is
   * read through `bigint` and narrowed, rather than summed into a large positive number.
   */
  varint(): number {
    let value = 0n
    let shift = 0n
    for (;;) {
      if (this.at >= this.end) throw new OnnxReadError('The file ends inside a number')
      const byte = this.bytes[this.at++]!
      value |= BigInt(byte & 0x7f) << shift
      if (!(byte & 0x80)) break
      shift += 7n
      if (shift > 63n) throw new OnnxReadError('A number in the file is longer than 64 bits')
    }
    return Number(BigInt.asIntN(64, value))
  }

  /** The bounds of the next length-delimited field's payload, and step past it. */
  span(): [number, number] {
    const length = this.varint()
    const start = this.at
    const end = start + length
    if (length < 0 || end > this.end) throw new OnnxReadError('A field runs past its message')
    this.at = end
    return [start, end]
  }

  string(): string {
    const [start, end] = this.span()
    return decoder.decode(this.bytes.subarray(start, end))
  }

  float32(): number {
    if (this.at + 4 > this.end) throw new OnnxReadError('The file ends inside a float')
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4)
    this.at += 4
    return view.getFloat32(0, true)
  }

  /** Step over a field of this wire type. */
  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 1) this.at += 8
    else if (wire === 2) this.span()
    else if (wire === 5) this.at += 4
    else throw new OnnxReadError(`Wire type ${wire} is not one ONNX uses`)
    if (this.at > this.end) throw new OnnxReadError('A field runs past its message')
  }

  /**
   * Each field of this message as (number, wire type). The callback reads the fields it wants
   * and ignores the rest: whatever it leaves unread is skipped here, the one place that does.
   */
  fields(read: (field: number, wire: number) => void): void {
    while (!this.done) {
      const key = this.varint()
      const wire = key & 7
      const before = this.at
      read(key >>> 3, wire)
      if (this.at === before) this.skip(wire)
    }
  }

  sub(): Reader {
    const [start, end] = this.span()
    return new Reader(this.bytes, start, end)
  }
}

/** A repeated number field, which a writer may emit packed (one span) or one value at a time. */
function repeated(
  reader: Reader,
  wire: number,
  into: number[],
  one: (r: Reader) => number,
): void {
  if (wire === 2) {
    const packed = reader.sub()
    while (!packed.done) into.push(one(packed))
  } else {
    into.push(one(reader))
  }
}
const varint = (r: Reader) => r.varint()
const float32 = (r: Reader) => r.float32()

function readTensor(reader: Reader): OnnxTensor {
  let name = ''
  const dims: number[] = []
  let dataType = 0
  let location = 0
  let raw: [number, number] | undefined
  const floats: number[] = []
  reader.fields((field, wire) => {
    if (field === 1) repeated(reader, wire, dims, varint)
    else if (field === 2) dataType = reader.varint()
    else if (field === 4) repeated(reader, wire, floats, float32)
    else if (field === 8) name = reader.string()
    else if (field === 9) raw = reader.span()
    else if (field === 14) location = reader.varint()
  })
  if (location === EXTERNAL) {
    return {
      name,
      dims,
      unread: 'it is stored outside the file, which this reader cannot follow',
    }
  }
  if (dataType !== FLOAT) {
    return { name, dims, unread: `it is ONNX type ${dataType}, and only float32 is read` }
  }
  const count = dims.reduce((n, d) => n * d, 1)
  if (raw) {
    const [start, end] = raw
    if (end - start !== count * 4) {
      throw new OnnxReadError(`${name} holds ${end - start} bytes for ${count} floats`)
    }
    return { name, dims, data: rawReader(reader.bytes, start, count) }
  }
  if (floats.length !== count) {
    throw new OnnxReadError(`${name} holds ${floats.length} floats for dims ${dims.join('×')}`)
  }
  return { name, dims, data: constant(Float32Array.from(floats)) }
}

/*
 * The two `data` readers are made here, in functions holding only what they read: a closure made
 * inside `readTensor` would share its scope with the parse locals — the `floats` array above all,
 * eight bytes or more a weight — for as long as the tensor is held (CLAUDE.md, long-lived
 * closures).
 */
function rawReader(bytes: Uint8Array, start: number, count: number): () => Float32Array {
  const offset = bytes.byteOffset + start
  // A float32 view must start on a multiple of 4; protobuf does not align anything.
  return offset % 4 === 0
    ? () => new Float32Array(bytes.buffer, offset, count)
    : () => new Float32Array(bytes.slice(start, start + count * 4).buffer)
}

function constant(values: Float32Array): () => Float32Array {
  return () => values
}

function readAttribute(reader: Reader): [string, number | string | number[] | undefined] {
  let name = ''
  let value: number | string | number[] | undefined
  const ints: number[] = []
  reader.fields((field, wire) => {
    if (field === 1) name = reader.string()
    else if (field === 2 && wire === 5) value = reader.float32()
    else if (field === 3 && wire === 0) value = reader.varint()
    else if (field === 4 && wire === 2) value = reader.string()
    else if (field === 8) repeated(reader, wire, ints, varint)
  })
  return [name, ints.length ? ints : value]
}

function readNode(reader: Reader): OnnxNode {
  const inputs: string[] = []
  const outputs: string[] = []
  let opType = ''
  const attributes = new Map<string, number | string | readonly number[]>()
  reader.fields((field) => {
    if (field === 1) inputs.push(reader.string())
    else if (field === 2) outputs.push(reader.string())
    else if (field === 4) opType = reader.string()
    else if (field === 5) {
      const [key, value] = readAttribute(reader.sub())
      if (value !== undefined) attributes.set(key, value)
    }
  })
  return { opType, inputs, outputs, attributes }
}

/** Read an ONNX model's graph: its float32 initializers by name, and its nodes in file order. */
export function readOnnx(bytes: Uint8Array): OnnxGraph {
  const model = new Reader(bytes, 0, bytes.byteLength)
  let graph: Reader | undefined
  model.fields((field, wire) => {
    if (field === 7 && wire === 2) graph = model.sub()
  })
  if (!graph) throw new OnnxReadError('The file holds no graph: it is not an ONNX model')

  const initializers = new Map<string, OnnxTensor>()
  const nodes: OnnxNode[] = []
  const g = graph
  g.fields((field, wire) => {
    if (field === 1 && wire === 2) nodes.push(readNode(g.sub()))
    else if (field === 5 && wire === 2) {
      const tensor = readTensor(g.sub())
      initializers.set(tensor.name, tensor)
    }
  })
  return { initializers, nodes }
}
