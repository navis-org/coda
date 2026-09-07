Common use: combining two connectivity results from different seeds, a hand-curated list added to a query
result or the same analysis run on two separate datasets.

**Rows keep input order. Duplicates are kept** — `UNION ALL`, not `UNION`. Which of two identical rows to keep is a real question with its own answer, and it belongs in a deduplication node downstream.

> [!WARNING] Type mismatches
> If two inputs contain the same column but with mismatching types - e.g. a string on one and a number on another - the node refuses to merge them, naming both inputs. Neither widening to text nor coercing to a number is a decision this node has grounds to make. Exception: `i64` and `f64` merge silently (they're the same kind of thing).

**As many inputs as you need.** `Inputs` adds a socket. There is no need to chain stacks — and
chaining used to cost the source column its meaning, since each card could only name *its own*
two inputs.

**Tracking origins.** Set `sourceColumn` to add a column naming which input each row came from
(`Input 1`, `Input 2`, … or your own labels, one per socket).

See also [Join](#core.join) — the horizontal counterpart, adding columns instead of rows.

```coda-params
core.stack: inputCount, sourceColumn, topLabel, bottomLabel
```
