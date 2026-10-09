/**
 * Whether a synchronous peek should start the fetch it cannot answer — `memoPromise`'s partner.
 *
 * A peek runs from inference, on every graph mutation, so two rules decide whether it may ask
 * (`DatasetListing`'s header has the incidents). **Once, never once per peek**: a failure retried
 * from here is a request per keystroke. And **never without the credential the fetch needs**, re-
 * armed when that credential *changes*: without a token the fetch can only fail, and neuPrint's
 * client reports a missing token to the channel that opens the Connections dialog. So what is
 * remembered is the credential the last start was made under, not a flag.
 *
 * `src/data/peeks.test.ts` sweeps every peek that uses one.
 */
export class PeekGate {
  private readonly credential: (() => string | undefined) | undefined
  /** The credential the last start was made under — `''` for a fetch that needs none. */
  private startedWith: string | undefined

  /** `credential` is what the fetch needs, where it needs one. */
  constructor(credential?: () => string | undefined) {
    this.credential = credential
  }

  /** True the first time, and again after the credential changes — never while it is missing. */
  open(): boolean {
    const now = this.credential ? this.credential() : ''
    if (!now && this.credential) return false
    if (this.startedWith === now) return false
    this.startedWith = now
    return true
  }
}

/** One `PeekGate` per key, for a module that peeks about many datastacks, tables or bases. */
export class PeekGates {
  private readonly gates = new Map<string, PeekGate>()

  /** `PeekGate.open` for `key`, the gate made on first use with `credential`. */
  open(key: string, credential?: () => string | undefined): boolean {
    let gate = this.gates.get(key)
    if (!gate) this.gates.set(key, (gate = new PeekGate(credential)))
    return gate.open()
  }

  /** Test seam. */
  clear(): void {
    this.gates.clear()
  }
}
