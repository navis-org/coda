### Keep

Which row of a repeated set survives:

- **first**: The first row in sort order (sort upstream if a different order matters).
- **last**: The last row in sort order.
- **none**: No duplicates at all—the conservative read for conflicts. Keeps only rows whose comparison columns appear in no other row in the input. All other kept columns must agree across the set for it to survive; if other columns disagree, all copies are dropped. This leaves only "the rows nobody disagrees about."

```coda-params
core.dedupe: columns, keep
```
