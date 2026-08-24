Common use: combining two connectivity results from different seeds, a hand-curated list added to a query
result or the same analysis run on two separate datasets.

**Rows keep input order. Duplicates are kept** — `UNION ALL`, not `UNION`. Which of two identical rows to keep is a real question with its own answer, and it belongs in a deduplication node downstream.

> [!WARNING] Type mismatches
> If both tables contain the same column but with mismatching types - e.g. a string above and a number below - the node refuses to merge them. Neither widening to text nor coercing to a number is a decision this node has grounds to make. Exception: `i64` and `f64` merge silently (they're the same kind of thing).

**Tracking origins.** Set `sourceColumn` to add a column naming which input each row came from
(Top or Bottom, or your own labels). Chaining a third table in wants either a distinct name per
level or labels set at each one, since the column can only distinguish the two inputs of one
stack.

See also [Join](#core.join) — the horizontal counterpart, adding columns instead of rows.

```coda-params
core.stack: sourceColumn, topLabel, bottomLabel
```
