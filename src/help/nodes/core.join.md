Let's say you have two tables with neuron annotations - one for cell types and one for neurotransmitters. Many consumer of such annotations only want a single table. For that you can use the `Join` node to combine them into one table, matching on neuron id. The output is a single table with all columns from both tables, and rows for every neuron that appears in either table.

## The four join types
Two tables can be joined in four different ways, depending on which rows you want to keep. The `How` setting controls that:

1. **Inner**: only rows that appear in both tables are kept. This is the default, and the most common case.
2. **Left**: all rows from the left table are kept, and rows from the right table are matched to them. If a left row has no match in the right table, its right columns are filled with blanks.
3. **Right**: same as "Left" but with the tables swapped.
4. **Outer**: all rows from both tables are kept. If a row has no match in the other table, its columns from that table are filled with blanks.

## Column name collisions
If the right table has a column whose name already exists on the
left, the right copy gets a suffix (default `_r`) rather than being silently dropped. In a
scientific pipeline, an ugly name beats a column that quietly disappeared. A duplicated key
matches only the first right row — no Cartesian explosion.

See also [Stack Tables](#core.stack) — the vertical counterpart, adding rows instead of columns.

```coda-params
core.join: how, suffix
```
