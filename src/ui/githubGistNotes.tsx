/**
 * The two things every surface writing a gist has to say, said once.
 *
 * The Share dialog said them first and the Cytoscape Web dialog copied them, and the copies had
 * drifted within a day — an em dash for a colon, and the clause about profile and search dropped.
 * The unlisted wording is the one that matters: "secret" reads as "private", and somebody will
 * otherwise put something in a gist they should not.
 */

/** A secret gist's visibility, in the words `WriteGistOptions.secret` asks for. */
export const UNLISTED_GIST =
  'Unlisted, not private — anyone with the link can read it, and it will not appear on your ' +
  'profile or in search.'

/** Where a GitHub token goes, for a surface that needs one and has none. */
export function WhereTheTokenGoes() {
  return (
    <>
      Add one in <strong>Connections ▸ Sharing</strong> — the branch icon in the toolbar. It
      needs the <code>gist</code> scope and nothing else.
    </>
  )
}
