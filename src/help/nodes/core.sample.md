## The four modes

**Top** takes the first N rows. **Bottom** takes the last N.

**Every Nth** keeps one row in N across the whole table, starting with the first. This preserves the shape of the data rather than truncating it: a scatter of 165,000 neurons thinned this way stays recognisable.

**Random** draws N rows at random. The only mode that answers whether a pattern is real or an accident of row order.

> [!WARNING] Seed applies to Random only
> In the other three modes changing it has no effect.

```coda-params
core.sample: mode, seed
```
