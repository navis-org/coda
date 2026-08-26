/**
 * The Explore query language.
 *
 * Worth testing hard because two things depend on it agreeing with itself: the widget's live
 * list and the node's `evaluate`. A divergence would show as a list that disagrees with the
 * table it feeds, which is the kind of bug nobody thinks to look for.
 *
 * The behaviours pinned here that were found on real data rather than reasoned out:
 *   - fuzzy is a *fallback*, because always-on subsequence matching reported 4,389 hits for
 *     `DNp01` against male-CNS instead of 2;
 *   - ranking covers every hit via bucket partition, because cutting it off above a threshold
 *     buried the good matches in the fuzzy tail.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import {
  completeSearch,
  fieldValues,
  isSubsequence,
  parseSearch,
  rankStrings,
  runSearch,
  searchIndexFor,
  tokenizeSearch,
  validateSearch,
} from './neuronSearch'

const SCHEMA = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('instance', 'str'),
  column('status', 'str'),
  column('class', 'str'),
  column('post', 'i64', 'synapses'),
)

/**
 * A deliberately awkward little dataset: a null type, a null class, a value with a space, and
 * types that share prefixes so the ranking tiers are all reachable.
 */
const NEURONS: TableValue = tableFromRows(
  SCHEMA,
  [
    {
      neuronId: 10,
      type: 'DNp01',
      instance: 'DNp01_L',
      status: 'Traced',
      class: 'descending',
      post: 1200,
    },
    {
      neuronId: 20,
      type: 'DNp17',
      instance: 'DNp17_R',
      status: 'Traced',
      class: 'descending',
      post: 300,
    },
    {
      neuronId: 30,
      type: 'LC4',
      instance: 'LC4_R',
      status: 'Traced',
      class: 'visual projection',
      post: 90,
    },
    {
      neuronId: 40,
      type: 'LC6',
      instance: 'LC6_L',
      status: 'Anchor',
      class: 'visual projection',
      post: 40,
    },
    { neuronId: 50, type: 'KCg', instance: 'KCg_x', status: 'Traced', class: null, post: 7 },
    {
      neuronId: 60,
      type: null,
      instance: 'unnamed',
      status: null,
      class: 'descending',
      post: 0,
    },
    {
      neuronId: 70,
      type: 'aDNp01x',
      instance: 'weird',
      status: 'Traced',
      class: 'descending',
      post: 5,
    },
  ],
  'neurons',
)

const INDEX = searchIndexFor(NEURONS)

function search(query: string) {
  return runSearch(NEURONS, INDEX, parseSearch(query))
}

function types(query: string): Array<string | null> {
  return search(query).rows.map((row) => NEURONS.data['type']![row] as string | null)
}

function ids(query: string): number[] {
  return search(query).rows.map((row) => NEURONS.data['neuronId']![row] as number)
}

// ---------------------------------------------------------------------------

describe('tokenizeSearch', () => {
  it('splits on whitespace and reports offsets', () => {
    expect(tokenizeSearch('LC4  post>10')).toEqual([
      { text: 'LC4', from: 0, to: 3 },
      { text: 'post>10', from: 5, to: 12 },
    ])
  })

  it('keeps a quoted run together', () => {
    expect(tokenizeSearch('class=="visual projection"').map((t) => t.text)).toEqual([
      'class=="visual projection"',
    ])
  })

  it('still yields a token for an unterminated quote', () => {
    // This is the state of the query for as long as someone is typing one, so it must not
    // collapse to nothing — the completion popup reads the token under the caret.
    expect(tokenizeSearch('class=="visual pro').map((t) => t.text)).toEqual([
      'class=="visual pro',
    ])
  })
})

describe('parseSearch', () => {
  it('reads a bare term as lowercase free text', () => {
    expect(parseSearch('LC4').terms).toEqual([{ kind: 'text', value: 'lc4', negate: false }])
  })

  it('accepts either negation prefix', () => {
    expect(parseSearch('!LC4').terms[0]).toMatchObject({ negate: true, value: 'lc4' })
    expect(parseSearch('-LC4').terms[0]).toMatchObject({ negate: true, value: 'lc4' })
  })

  it('does not treat a lone dash as a negation', () => {
    // Otherwise typing "-" then "LC4" silently excludes what you just asked for.
    expect(parseSearch('-').terms).toEqual([{ kind: 'text', value: '-', negate: false }])
  })

  it('reads every comparison operator', () => {
    const ops = [
      'type==LC4',
      'type!=LC4',
      'post>10',
      'post<10',
      'post>=10',
      'post<=10',
      'type~LC',
    ]
    // `ignoreCase: true` on every one of them: a search box is insensitive, and the flag is
    // written out at the construction site rather than defaulted — see `FieldTerm.ignoreCase`.
    const insensitive = { negate: false, ignoreCase: true }
    expect(ops.map((q) => parseSearch(q).terms[0])).toEqual([
      { kind: 'field', field: 'type', op: 'eq', value: 'LC4', ...insensitive },
      { kind: 'field', field: 'type', op: 'ne', value: 'LC4', ...insensitive },
      { kind: 'field', field: 'post', op: 'gt', value: '10', ...insensitive },
      { kind: 'field', field: 'post', op: 'lt', value: '10', ...insensitive },
      { kind: 'field', field: 'post', op: 'ge', value: '10', ...insensitive },
      { kind: 'field', field: 'post', op: 'le', value: '10', ...insensitive },
      { kind: 'field', field: 'type', op: 'match', value: 'LC', ...insensitive },
    ])
  })

  it('treats a single = as ==', () => {
    expect(parseSearch('type=LC4').terms[0]).toMatchObject({ op: 'eq', value: 'LC4' })
  })

  it('strips quotes from a field value', () => {
    expect(parseSearch('class=="visual projection"').terms[0]).toMatchObject({
      field: 'class',
      value: 'visual projection',
    })
  })

  it('ignores an operator with no value yet', () => {
    // Every query passes through this state while being typed; flagging it would flash an
    // error on the node between "class==" and "class==descending".
    expect(parseSearch('class==').terms).toEqual([])
    expect(parseSearch('class==').errors).toEqual([])
  })

  it('reports an unparseable regex instead of throwing', () => {
    const parsed = parseSearch('type~[')
    expect(parsed.terms).toEqual([])
    expect(parsed.errors[0]).toContain('Invalid regex')
  })

  it('does not mistake a bare term containing punctuation for a field', () => {
    expect(parseSearch('>10').terms[0]).toMatchObject({ kind: 'text' })
  })
})

describe('runSearch', () => {
  it('returns every row for an empty query, in table order', () => {
    expect(ids('')).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(search('').fuzzy).toBe(false)
  })

  it('matches a substring in any field, case-insensitively', () => {
    expect(ids('anchor')).toEqual([40])
    expect(ids('kcg')).toEqual([50])
  })

  it('ANDs multiple terms', () => {
    expect(ids('traced descending')).toEqual([10, 20, 70])
  })

  it('excludes with a negated term', () => {
    // Row 70's type is 'aDNp01x', which contains 'DNp' — so it is excluded too. Negation is
    // substring-based like the positive case, not a whole-field comparison.
    expect(ids('descending !DNp')).toEqual([60])
  })

  it('compares numeric fields numerically, not lexically', () => {
    // '90' > '1200' as strings, so a lexical compare would put LC4 in and DNp01 out.
    expect(ids('post>100')).toEqual([10, 20])
    expect(ids('post<=7')).toEqual([50, 60, 70])
  })

  it('matches a field exactly rather than by substring', () => {
    // 'aDNp01x' contains 'DNp01' but is not equal to it.
    expect(ids('type==DNp01')).toEqual([10])
    expect(ids('DNp01')).toEqual([10, 70])
  })

  it('applies a regex unanchored', () => {
    // Deliberately unlike neuPrint's `=~`, which anchors at both ends. This search is local,
    // so there is no server semantic to match and anchoring would surprise everyone.
    expect(ids('type~^LC')).toEqual([30, 40])
    expect(ids('type~C')).toEqual([30, 40, 50])
  })

  it('treats a missing value as matching no positive term', () => {
    expect(ids('class==descending')).toEqual([10, 20, 60, 70])
    expect(ids('type==LC4')).toEqual([30])
  })

  it('includes missing values in a negated comparison', () => {
    // status!=Traced returns the untraced *and* the unlabelled: someone hunting for gaps
    // wants both, where SQL's three-valued logic would silently drop row 60.
    expect(ids('status!=Traced')).toEqual([40, 60])
  })

  it('finds nothing for an unknown field', () => {
    expect(ids('nosuchfield==x')).toEqual([])
  })
})

describe('fuzzy fallback', () => {
  it('does not fire when the query matches exactly', () => {
    const result = search('LC4')
    expect(result.fuzzy).toBe(false)
    expect(result.rows).toHaveLength(1)
  })

  it('fires only when nothing matches, and says so', () => {
    // 'dscnding' is not a substring of anything but is a subsequence of 'descending'.
    const result = search('dscnding')
    expect(result.fuzzy).toBe(true)
    expect(result.rows.map((r) => NEURONS.data['neuronId']![r])).toEqual([10, 20, 60, 70])
  })

  it('stays exact when a substring hit exists, however few', () => {
    // The whole point of the fallback: `DNp01` must report 2 hits, not every row whose
    // concatenated text happens to contain d-n-p-0-1 in order.
    expect(search('DNp01').rows).toHaveLength(2)
  })

  it('does not retry a pure field query that matched nothing', () => {
    const result = search('post>99999')
    expect(result.rows).toEqual([])
    expect(result.fuzzy).toBe(false)
  })

  it('reports no fuzzy flag when even the fallback finds nothing', () => {
    const result = search('zzzzqqqq')
    expect(result.rows).toEqual([])
    expect(result.fuzzy).toBe(false)
  })
})

describe('ranking', () => {
  it('puts an exact type match first', () => {
    expect(types('lc4')).toEqual(['LC4'])
  })

  it('prefers a prefix hit in type over a hit elsewhere', () => {
    // 'DNp01' is a prefix of row 10's type and merely contained in row 70's.
    expect(types('dnp01')).toEqual(['DNp01', 'aDNp01x'])
  })

  it('searches neuron ids as text, so pasting an id finds its neuron', () => {
    expect(ids('10')).toEqual([10])
  })

  it('does not fold non-id numeric columns into free-text search', () => {
    // Row 10 has post=1200, and searching "1200" should not find it: a free-text hit on a
    // synapse count is never what anyone meant, and it would make every count searchable
    // noise. Numeric fields are reachable through `post==1200` instead.
    expect(ids('1200')).toEqual([])
    expect(ids('post==1200')).toEqual([10])
  })

  it('ranks primary-field hits above hits in other fields', () => {
    // 'descending' is a class value for 10/20/60/70; none has it in type or instance, so the
    // order is the table's own — this pins that ranking never *reorders* an equal-tier set.
    expect(ids('descending')).toEqual([10, 20, 60, 70])
  })

  it('ranks every hit rather than giving up on a large set', () => {
    // Regression: an earlier version skipped ranking above a hit threshold, which on real
    // data left the actual DNp01 neurons thousands of rows deep in a fuzzy result set.
    const result = search('traced')
    expect(result.rows.length).toBeGreaterThan(4)
    expect(result.rows).toEqual([...result.rows].sort((a, b) => a - b))
  })
})

describe('isSubsequence', () => {
  it('accepts characters in order with gaps', () => {
    expect(isSubsequence('dnp1', 'dnp01')).toBe(true)
    expect(isSubsequence('', 'anything')).toBe(true)
  })

  it('rejects out-of-order and over-long needles', () => {
    expect(isSubsequence('1pnd', 'dnp01')).toBe(false)
    expect(isSubsequence('dnp01x', 'dnp01')).toBe(false)
  })
})

describe('validateSearch', () => {
  it('reports an unknown field, because an empty result looks the same as no such neurons', () => {
    expect(validateSearch(SCHEMA, parseSearch('superclas==x'))).toEqual([
      'No field "superclas" in this dataset',
    ])
  })

  it('accepts a field whose case differs', () => {
    expect(validateSearch(SCHEMA, parseSearch('Type==LC4'))).toEqual([])
  })

  it('passes regex errors through', () => {
    expect(validateSearch(SCHEMA, parseSearch('type~('))[0]).toContain('Invalid regex')
  })

  it('reports each unknown field once', () => {
    expect(validateSearch(SCHEMA, parseSearch('zz==1 zz==2'))).toHaveLength(1)
  })
})

describe('fieldValues', () => {
  it('returns distinct non-null values, sorted', () => {
    expect(fieldValues(NEURONS, 'class')).toEqual(['descending', 'visual projection'])
  })

  it('is memoised per table', () => {
    expect(fieldValues(NEURONS, 'type')).toBe(fieldValues(NEURONS, 'type'))
  })
})

describe('completeSearch', () => {
  function labels(text: string, caret = text.length) {
    return completeSearch(NEURONS, text, caret).items.map((i) => i.label)
  }

  it('completes field names, with the operator attached', () => {
    expect(labels('clas')).toEqual(['class=='])
  })

  it('completes values once a field and operator are present', () => {
    expect(labels('class==desc')).toEqual(['descending'])
  })

  it('quotes a value containing a space', () => {
    const item = completeSearch(NEURONS, 'class==visual', 13).items[0]
    expect(item?.text).toBe('class=="visual projection"')
  })

  it('keeps a negation prefix when completing', () => {
    expect(completeSearch(NEURONS, '!clas', 5).items[0]?.text).toBe('!class==')
  })

  it('offers no value completions for a numeric field', () => {
    // A list of every distinct synapse count is not help.
    expect(labels('post==1')).toEqual([])
  })

  it('offers nothing for an empty token', () => {
    // A popup that appears on every space is noise.
    expect(labels('LC4 ')).toEqual([])
  })

  it('replaces only the token under the caret', () => {
    const result = completeSearch(NEURONS, 'traced clas', 11)
    expect([result.from, result.to]).toEqual([7, 11])
  })

  it('does not offer neuronId as a field', () => {
    // Neuron ids are found by typing the number; completing them is meaningless.
    expect(labels('body')).toEqual([])
  })
})

describe('rankStrings', () => {
  it('orders exact, prefix, substring, subsequence', () => {
    expect(rankStrings('lc4', ['xLC4y', 'LC4', 'LC4b', 'L_C_4'], 10)).toEqual([
      'LC4',
      'LC4b',
      'xLC4y',
      'L_C_4',
    ])
  })

  it('prefers the shorter candidate within a tier', () => {
    expect(rankStrings('lc', ['LC4_complex', 'LC4'], 10)).toEqual(['LC4', 'LC4_complex'])
  })

  it('honours the limit and returns the head of the list when the query is empty', () => {
    expect(rankStrings('', ['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })
})

/**
 * Keeping a column *shown* without letting it be *searched*.
 *
 * Explore's `Search tags` opt-out. Free-form community text is exactly the thing somebody might
 * not want folded into a hit count they then quote — and it is exactly the thing somebody else
 * wants to find neurons by, which is why the default is on and this is a control rather than a
 * rule.
 */
describe('excluding a column from the free-text haystack', () => {
  const SCHEMA = tableSchema(
    column('neuronId', 'str'),
    column('type', 'str'),
    column('community', 'str'),
  )
  const table = () =>
    tableFromRows(SCHEMA, [
      { neuronId: '1', type: 'DNp01', community: 'putative giant fibre' },
      { neuronId: '2', type: 'LC4', community: 'checked' },
    ])

  const hits = (query: string, exclude: string[] = []) =>
    runSearch(table(), searchIndexFor(table(), exclude), parseSearch(query)).rows

  it('matches the column by default', () => {
    expect(hits('giant')).toEqual([0])
  })

  it('stops matching it once excluded, and leaves every other column alone', () => {
    expect(hits('giant', ['community'])).toEqual([])
    expect(hits('DNp01', ['community'])).toEqual([0])
  })

  it('still answers a field term naming the column', () => {
    /*
     * The exclusion is the *free-text* half only. Asking for a column by name is an explicit
     * act rather than a stray word in a search box, and `prepareFieldTerms` reads the table
     * rather than this index — so the opt-out costs nothing anybody deliberately asked for.
     */
    expect(hits('community~giant', ['community'])).toEqual([0])
  })

  it('does not serve one exclusion’s index to another', () => {
    // The memo is per table *and* per exclusion: one entry per table would hand the widget the
    // index a node built without the exclusion, and the list would show rows Hits does not.
    const t = table()
    expect(searchIndexFor(t).searched).toContain('community')
    expect(searchIndexFor(t, ['community']).searched).not.toContain('community')
    // And back again, from the same cached table.
    expect(searchIndexFor(t).searched).toContain('community')
  })
})
