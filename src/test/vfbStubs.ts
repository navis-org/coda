/**
 * Virtual Fly Brain's PDB as tests see it: one transactional-endpoint answer, in the shape
 * `data/vfb/pdb.ts` reads (`results[0].columns` and a `row` per record). One copy, so the data
 * layer's tests and the pack's agree with the reader rather than with each other.
 */

/** The PDB's answer to one statement: these columns, these rows, no errors. */
export function pdbAnswer(columns: readonly string[], rows: readonly unknown[][]): Response {
  return Response.json({
    results: [{ columns, data: rows.map((row) => ({ row })) }],
    errors: [],
  })
}
