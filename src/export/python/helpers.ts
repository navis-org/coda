/**
 * Generated Python helpers.
 *
 * The parts of a workflow with no equivalent in pandas, neuprint-python or navis, written
 * into the notebook so it stands on those three and nothing else. Each one mirrors a
 * specific piece of `src/nodes/lib`, and the pairing is the thing to keep true — a helper
 * that has quietly stopped agreeing with the TypeScript it was ported from is worse than no
 * helper at all, because the notebook still runs and still answers.
 */

import { registerHelper } from './registry'

/**
 * Coda's own PRNG, and it has to be Coda's own.
 *
 * `df.sample(random_state=n)` is a Mersenne Twister; this is mulberry32. Same seed, entirely
 * different rows — so a notebook using pandas' sampler would disagree with the canvas it was
 * exported from while looking perfectly reasonable, which is the failure mode the seed param
 * exists to prevent. The arithmetic is JavaScript's `Math.imul` and `>>>` written out in
 * 32-bit masks; `sample_rows.test.ts` checks the two streams agree rather than trusting that
 * the transcription is right.
 */
registerHelper({
  name: 'coda_sample_rows',
  source: [
    'def _coda_rng(seed):',
    '    """mulberry32, the generator behind Coda\'s Sample node."""',
    '    a = int(seed) & 0xFFFFFFFF',
    '',
    '    def rand():',
    '        nonlocal a',
    '        a = (a + 0x6D2B79F5) & 0xFFFFFFFF',
    '        t = a',
    '        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF',
    '        t = (t ^ (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF))) & 0xFFFFFFFF',
    '        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296',
    '',
    '    return rand',
    '',
    '',
    'def coda_sample_rows(length, count, seed):',
    '    """Row positions for a seeded draw, ascending.',
    '',
    '    Partial Fisher-Yates over `count` draws, then sorted: this samples rather than',
    '    shuffles, so a random subset of a sorted table stays sorted.',
    '    """',
    '    length = max(0, int(length))',
    '    count = max(0, min(length, int(count)))',
    '    idx = list(range(length))',
    '    rand = _coda_rng(seed)',
    '    for i in range(count):',
    '        j = i + int(rand() * (length - i))',
    '        idx[i], idx[j] = idx[j], idx[i]',
    '    return sorted(idx[:count])',
  ],
})

/**
 * neuprint-python's `bodyId` → Coda's `neuronId`.
 *
 * The counterpart of R's `coda_neurons`, and it exists for the same reason one seam over:
 * **Coda calls the id column `neuronId` on every source**, because it is the one column every
 * node addresses by name and so the one that has to be Coda's vocabulary rather than a
 * backend's. neuprint-python publishes `bodyId`, which is neuPrint's property name.
 *
 * Every frame that comes back from `fetch_neurons` goes through this, or the next cell — a
 * Filter, a Group By, anything carrying a column param — addresses `neuronId` on a frame that
 * has no such column and raises a `KeyError` a long way from the cause.
 *
 * Note the asymmetry that makes this readable rather than confusing: the *argument* stays
 * neuPrint's, so a call reads `NeuronCriteria(bodyId=df['neuronId'].tolist())`. Coda's column
 * goes in, neuPrint's parameter takes it.
 *
 * Left alone when the frame already carries `neuronId`, so a table from an upload or an
 * aliased Cypher query passes through untouched.
 */
registerHelper({
  name: 'coda_neurons',
  source: [
    'def coda_neurons(df):',
    '    """Rename neuprint-python\'s `bodyId` to the `neuronId` every Coda table uses."""',
    "    if df is None or 'bodyId' not in df.columns or 'neuronId' in df.columns:",
    '        return df',
    "    return df.rename(columns={'bodyId': 'neuronId'})",
  ],
})
