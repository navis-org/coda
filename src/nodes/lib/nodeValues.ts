/**
 * The per-node values Coda computes (`SkeletonGeometry.nodeValues`), and what each is called where
 * somebody picks one — the 3D View's "by node value" list. A fixed list rather than discovery,
 * because that picker is drawn at edit time and a type carries no geometry to discover them from.
 *
 * **Built in, and from packs.** A value a pack's node writes is declared in that pack's
 * `src/packs/<id>/nodeValues.ts`, found by glob as its glyphs and See also groups are, so the core
 * list never names a pack's node. Like those files it imports types only: it is read wherever the
 * 3D View's params are declared, which must not drag the pack's nodes in behind it. A name declared
 * twice is refused, a second declaration of one value being two sources claiming one array.
 */

/** One per-node value: its key in `nodeValues`, the picker's word for it, and where it comes from. */
export interface NodeValueDef {
  readonly value: string
  readonly label: string
  /** Where the value comes from — so a picker can say it without naming nodes itself. */
  readonly source: string
  /** The pack that declares it, from its file's path: offered only while that pack is. */
  readonly pack?: string
}

/** The values built-in nodes write: Split Axon/Dendrite's two. */
export const BUILT_IN_NODE_VALUES = [
  {
    value: 'flow',
    label: 'synapse flow (fraction of peak)',
    source: 'Split Axon/Dendrite, with Write synapse flow on',
  },
  {
    value: 'axonProbability',
    label: 'compartment probability (label propagation)',
    source: 'Split Axon/Dendrite by label propagation, with Write probability on',
  },
] as const satisfies readonly NodeValueDef[]

const PACK_NODE_VALUES = import.meta.glob('../../packs/*/nodeValues.ts', {
  eager: true,
  import: 'default',
}) as Record<string, readonly NodeValueDef[]>

/** Every value the 3D View can colour by: the built-in ones first, then each pack's. */
export const NODE_VALUES: readonly NodeValueDef[] = (() => {
  const merged: NodeValueDef[] = [...BUILT_IN_NODE_VALUES]
  for (const [path, defs] of Object.entries(PACK_NODE_VALUES)) {
    const pack = /packs\/([^/]+)\/nodeValues\.ts$/.exec(path)?.[1]
    for (const def of defs) {
      if (merged.some((known) => known.value === def.value)) {
        throw new Error(
          `${path} declares the node value "${def.value}", which is already declared`,
        )
      }
      merged.push(pack ? { ...def, pack } : def)
    }
  }
  return merged
})()
