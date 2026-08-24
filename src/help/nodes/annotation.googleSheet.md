Chains with [CAVE table](#annotation.caveTable), [FlyTable](#annotation.flyTable), and
[SeaTable](#annotation.seaTable) via an optional Annotations input, the same way those three
chain with each other — later sources win name collisions.

> [!WARNING] Tab selection uses gid, not name
> A tab name typed wrong returns the sheet's first tab (HTTP 200) rather than an error — a
> silent wrong-tab failure. The numeric gid from the URL's `#gid=` value is what the **Tab**
> field actually reads, and it's the only way to be sure which tab you get.

```coda-params
annotation.googleSheet: sheet, idColumn, columns, gid
```
