### Keep

Which row of a repeated set survives:

- **first** — the first in sort order. Sort upstream if a different order matters.
- **last** — the last in sort order.
- **none** — the conservative read for conflicts. Only rows whose comparison columns appear nowhere else in the input survive, and every other kept column must agree across the set; where they disagree, all copies are dropped. What is left is the rows nobody disagrees about.

```coda-params
core.dedupe: columns, keep
```
