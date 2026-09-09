Common use: combining two connectivity results from different seeds, a hand-curated list added to a query result, or the same analysis run on two separate datasets.

**Rows keep input order. Duplicates are kept** — `UNION ALL`, not `UNION`. Which of two identical rows to keep is a real question with its own answer, and it belongs in a deduplication node downstream.

> [!WARNING] Type mismatches refuse
> Where two inputs hold the same column with mismatching types — text on one, a number on the
> other — the node refuses and names both inputs. Neither widening to text nor coercing to a
> number is a decision it has grounds to make. Exception: `i64` and `f64` merge silently.

**As many inputs as you need.** `Inputs` adds a socket, so there is no need to chain stacks.

**Tracking origins.** Set `sourceColumn` to add a column naming which input each row came from (`Input 1`, `Input 2`, … or your own labels, one per socket).

See also [Join](#core.join) — the horizontal counterpart, adding columns instead of rows.

```coda-params
core.stack: inputCount, sourceColumn, label1, label2
```
