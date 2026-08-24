## Have it your way

This node offers 4 distinct strategies to draw samples from your data:

**Top** takes the first N rows — useful for seeing the strongest results after a Sort.

**Bottom** takes the last N rows — the inverse of Top.

**Every Nth** keeps one row in N across the entire table, starting with the first. This preserves the overall shape of the data rather than truncating it; a scatter of 165,000 neurons thinned this way stays recognizable, whereas taking just the first N would not.

**Random** draws N rows at random. This is the only mode that answers whether a result is an artefact of how the table happens to be ordered — use it to check whether a pattern is real or an accident of row order.

> [!WARNING]
> The seed parameter only applies in Random mode. In the other three modes, changing the seed has no effect and costs nothing. Setting a seed while in Top, Bottom, or Every Nth mode silently does nothing.

```coda-params
core.sample: mode, seed
```
