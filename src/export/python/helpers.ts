/**
 * Generated Python helpers.
 *
 * The parts of a workflow with no equivalent in pandas, neuprint-python or navis, written
 * into the notebook so it stands on those three and nothing else. Each one mirrors a
 * specific piece of `src/nodes/lib`, and the pairing is the thing to keep true — a helper
 * that has quietly stopped agreeing with the TypeScript it was ported from is worse than no
 * helper at all, because the notebook still runs and still answers.
 *
 * `caveHelpers.ts` is the same thing for the other backend, kept apart because it mirrors
 * `src/data/cave` and `src/data/annotations` rather than `src/nodes/lib` — and because a
 * neuPrint notebook should carry none of it.
 */

import { JOIN_SEPARATOR } from '../../core/values'
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

/**
 * Coda's Combine Columns node, both halves.
 *
 * `df[columns].bfill(axis=1).iloc[:, 0]` is the obvious pandas spelling and is a *different
 * rule*: it reads an empty string as a value, so a blank cell stops the search where Coda reads
 * null and blank as one absence. On a real annotation dump that is most of the difference —
 * FlyWire's published TSV writes an unset `cell_type` as a blank field rather than as nothing.
 *
 * `source=True` answers which column each value came from. One function rather than two,
 * because the loop and — the part that matters — the *absence rule* are identical; two copies is
 * two places for "what counts as a value" to drift, and a drifted pair puts a source name beside
 * a blank or a value beside no source.
 */
registerHelper({
  name: 'coda_combine',
  requires: [['pandas']],
  source: [
    'def coda_combine(df, columns, source=False):',
    '    """The first of `columns` holding a value per row, or which column that was."""',
    '    out = pd.Series([None] * len(df), index=df.index, dtype=object)',
    '    for name in columns:',
    '        if name not in df.columns:',
    '            continue',
    '        col = df[name]',
    '        # Null and the empty string are one absence: a blank must not stop the search.',
    "        have = col.notna() & (col.astype(str) != '')",
    '        out = out.mask(out.isna() & have, name if source else col)',
    '    return out',
  ],
})

/**
 * Coda's `join` aggregation.
 *
 * `', '.join(...)` is the obvious spelling and is a different rule four ways: it raises on a
 * NaN, it keeps empty strings — which Coda reads as absences, the same call `coda_combine`
 * makes — it keeps repeats, and it answers `''` for a group with nothing in it where Coda
 * answers null. The
 * separator is spliced from `JOIN_SEPARATOR`, so the notebook and the canvas cannot disagree
 * about where one value ends and the next begins.
 *
 * `dict.fromkeys` rather than a `set`: it deduplicates *and* keeps first-appearance order,
 * which a set does not promise in Python.
 */
registerHelper({
  name: 'coda_join',
  requires: [['pandas']],
  source: [
    'def coda_join(values):',
    '    """Coda\'s `join` aggregation: distinct, first-appearance order, absences skipped."""',
    "    kept = dict.fromkeys(str(v) for v in values.dropna() if str(v) != '')",
    `    return ${JSON.stringify(JOIN_SEPARATOR)}.join(kept) if kept else None`,
  ],
})

/**
 * A shared Google Sheet as a Coda neuron table.
 *
 * `data/annotations/googleSheet.ts` is what this mirrors, and the two rules worth transcribing
 * exactly are the ones that produce a plausible wrong table rather than an error.
 *
 * **The id column is read as text rather than guessed.** pandas types a column of
 * eighteen-digit root ids as `int64` — exact — and then as `float64` the moment one row is
 * blank, at which point `720575940628857210` comes back as `720575940628857216` — a *different*
 * neuron, with every later comparison wrong about a value nothing flagged. Measured rather than
 * reasoned: removing the `dtype=` below and re-running `pnpm probe:helpers` collapses two
 * adjacent ids in the probe's fixture onto one value. That is `coda_int64`'s finding at a
 * different seam, and `dtype=` is the cheap way to never form the float at all.
 * Coda's own reader arrives at the same column by a different route — `inferDType` refuses a
 * numeric reading of any value that would not survive a round trip through a double.
 *
 * **A column named but not present is dropped rather than filled with NaN**, which is what the
 * node does; the canvas says so in a warning on the card, and here the frame simply lacks it.
 *
 * `coda_annotation_columns` does the rest — see `caveHelpers.ts`, where it lives because
 * `coda_seatable` wanted it first. It is not a CAVE helper: it is `annotationColumn`, which
 * every annotation source in the tree renames through.
 */
registerHelper({
  name: 'coda_google_sheet',
  needs: ['coda_annotation_columns'],
  requires: [['pandas']],
  source: [
    "def coda_google_sheet(url, id_column='root_id', columns=None):",
    '    """A shared Google Sheet, read through its CSV export URL."""',
    '    # `dtype=` rather than a cast afterwards: a float64 id is already the wrong neuron by',
    '    # the time you could cast it back.',
    "    df = pd.read_csv(url, dtype={id_column: 'string'})",
    '    if id_column not in df.columns:',
    '        raise KeyError(',
    '            f"{id_column!r} is not a column of that tab. It has: {list(df.columns)}"',
    '        )',
    '    if columns:',
    '        keep = [c for c in columns if c in df.columns and c != id_column]',
    '    else:',
    '        # Empty means every column but the id, which is how a sheet says "all of it".',
    '        keep = [c for c in df.columns if c != id_column]',
    '    return coda_annotation_columns(df[[id_column] + keep], id_column)',
  ],
})
