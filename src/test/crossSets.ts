/**
 * The dataset sets the Workflow Wizard's cross-dataset rules are asked of.
 *
 * Hand-written rather than combinatorial, and each is here for a reason the others do not cover:
 * two neuPrint volumes that can do everything, a CAVE dataset whose typing arrives through an
 * annotation chain beside one whose typing is on the neuron, two chained families (which is the
 * id-collision case), a dataset with no template space (which must drop the geometry arms), and
 * the arity ceiling. Walking every pair of every family instead would be a hundred-odd graphs per
 * rule for no coverage these six do not already give.
 *
 * **Here rather than in `wizard.test.ts`** because two suites walk them and a suite cannot import
 * another suite: `placeGuards.test.ts` checks that no card lands on another over exactly these
 * shapes, which are the only ones the wizard lays out on more than one row. Written out twice,
 * the two lists stop matching the day a family is renamed and neither one fails.
 *
 * Family keys rather than `DatasetFamily` objects, because that is what `WizardAnswers.datasets`
 * carries and what every option-space function takes.
 */
export const CROSS_SETS: readonly string[][] = [
  ['hemibrain', 'malecns'],
  ['flywire', 'hemibrain'],
  ['flywire', 'banc'],
  ['mock.opticlobe', 'hemibrain'],
  ['hemibrain', 'malecns', 'manc'],
  ['hemibrain', 'malecns', 'manc', 'flywire'],
]

/**
 * The same datasets at two, three and four — the rules that are about **arity** rather than about
 * which families are involved, so that what varies between the cases is only how many.
 *
 * Derived from `CROSS_SETS` rather than listed again, which is the whole point of this file one
 * level down: a family renamed there renames it here too.
 */
export const GROWING_CROSS_SETS: readonly string[][] = CROSS_SETS.filter(
  (set) => set[0] === 'hemibrain' && set[1] === 'malecns',
)
