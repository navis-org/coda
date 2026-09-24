/**
 * What a node type id may look like, and which pack one belongs to.
 *
 * A type id is persisted in every saved file, share link and Zoo entry, so it is the one name in
 * the registry that can never be changed quietly. Two spellings:
 *
 * - **Built in**: `family.name`, optionally with further dotted parts — `core.filterTable`,
 *   `dataset.catmaid.l1`. The family is a grouping, not an owner.
 * - **From a pack**: `pack:name`, optionally dotted further — `zapbench:traces`. The pack *is* the
 *   family, so the local part needs no dot of its own. The colon is what makes a pack's types
 *   unable to collide with a built-in one or with another pack's, whatever families either side
 *   invents later, and what lets a placeholder say *which pack* a workflow needs rather than only
 *   which type it could not find.
 *
 * Checked by `registerNode`, so an id outside the grammar fails the moment its module is imported
 * rather than the first time somebody saves a file carrying it.
 */

const PACK_SEPARATOR = ':'
// Hyphens only between runs, so `a-` and `a--b` are not ids: each would fold to another's key.
const PACK_ID_SOURCE = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*'
const NAME_SOURCE = '[a-z][a-zA-Z0-9]*'
const DOTTED_SOURCE = '(?:\\.[a-zA-Z0-9]+)'
const PACK_ID = new RegExp(`^${PACK_ID_SOURCE}$`)
const BUILT_IN_TYPE = new RegExp(`^${NAME_SOURCE}${DOTTED_SOURCE}+$`)
const PACK_LOCAL_TYPE = new RegExp(`^${NAME_SOURCE}${DOTTED_SOURCE}*$`)

/**
 * The grammar as an unanchored pattern, for a parser that has to *find* a type id inside a line —
 * the help figures. Built from the same pieces as the checks, so a parser cannot accept a
 * narrower set of ids than `registerNode` does (a hyphenated pack id, say) by keeping its own
 * character class.
 */
export const NODE_TYPE_PATTERN = `(?:${PACK_ID_SOURCE}${PACK_SEPARATOR}${NAME_SOURCE}${DOTTED_SOURCE}*|${NAME_SOURCE}${DOTTED_SOURCE}+)`

/** A type id cut at the pack separator: the pack as written, if any, and the rest. */
function splitType(type: string): { pack?: string; local: string } {
  const cut = type.indexOf(PACK_SEPARATOR)
  return cut === -1 ? { local: type } : { pack: type.slice(0, cut), local: type.slice(cut + 1) }
}

/** Why this string cannot be a node type id, or undefined when it can. */
export function nodeTypeProblem(type: string): string | undefined {
  const { pack, local } = splitType(type)
  if (pack === undefined) {
    return BUILT_IN_TYPE.test(local)
      ? undefined
      : `"${local}" must be dotted, like "family.name", in letters and digits`
  }
  const problem = packIdProblem(pack)
  if (problem) return problem
  return PACK_LOCAL_TYPE.test(local)
    ? undefined
    : `"${local}" must be a name in letters and digits, like "${pack}:traces"`
}

/** Why this string cannot be a pack id, or undefined when it can. Checked by `registerPack`. */
export function packIdProblem(id: string): string | undefined {
  return PACK_ID.test(id)
    ? undefined
    : 'a pack id is lower case letters and digits, starting with a letter, with single hyphens between'
}

/**
 * A type id with every run of punctuation folded to `-`: `node-guide` anchors are made of this,
 * and `registerNode` refuses two live types that share one. The fold is deliberately lossy — it is
 * what keeps `zapbench.traces` and `zapbench:traces` on one anchor across the rename.
 */
export function typeKey(type: string): string {
  return type.replace(/[^a-zA-Z0-9]+/g, '-')
}

/**
 * The part of a type id that names the node rather than where it lives: `filterTable` for
 * `core.filterTable`, `traces` for `zapbench:traces`. For a readable node id, never for identity.
 */
export function typeStem(type: string): string {
  const { pack, local } = splitType(type)
  return pack === undefined ? local.slice(local.indexOf('.') + 1) : local
}

/**
 * The pack a node type belongs to, or undefined for a built-in one.
 *
 * Read off the id rather than looked up, because the question is asked about types this build has
 * never registered — that is the case where the answer matters.
 */
export function packOf(type: string): string | undefined {
  const { pack } = splitType(type)
  return pack !== undefined && PACK_ID.test(pack) ? pack : undefined
}
