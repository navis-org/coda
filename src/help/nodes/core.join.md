Combines two tables into one, matching on a key — a table of cell types and a table of neurotransmitters into a single annotation table, say. The output carries all columns from both.

## The four join types

`How` controls which rows survive:

1. **Inner**: only rows appearing in both tables. The default.
2. **Left**: every row from the left table, with right columns blank where there was no match.
3. **Right**: the same with the tables swapped.
4. **Outer**: every row from both, blank on whichever side had no match.

## Column name collisions

If the right table has a column whose name already exists on the left, the right copy gets a suffix (default `_r`) rather than being silently dropped — an ugly name beats a column that quietly disappeared. A duplicated key matches only the first right row, so there is no Cartesian explosion.

See also [Stack Tables](#core.stack) — the vertical counterpart, adding rows instead of columns.

```coda-params
core.join: how, suffix
```
