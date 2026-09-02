# Probe fixtures

## `celegans_edgelist.csv`

`InfluenceCalculator/data/celegans_edgelist.csv`, copied verbatim from
[DrugowitschLab/ConnectomeInfluenceCalculator](https://github.com/DrugowitschLab/ConnectomeInfluenceCalculator)
(BSD-3-Clause). 300 neurons, 3,539 edges, columns `pre, post, count, norm`.

It is here rather than fetched because `pnpm probe:influence` is a claim about *this* edge list:
the whole point is that Coda's bounded traversal and the package's exact solve are given
identically the same numbers, and a fixture that could change under the probe would make a
disagreement unattributable. `norm` is the package's own precomputed
`count / sum(count) per post` — the probe checks that identity rather than trusting it, since it
is the definition Coda's denominator has to match.
