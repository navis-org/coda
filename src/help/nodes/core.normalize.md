Rescale a matrix cell by dividing it against a reference value.

| Mode | Rescales each cell by |
|------|---|
| **Raw values** | No change; keeps the input as-is. |
| **Fraction of row** | Sum of its row. Each row becomes fractions that sum to 1. |
| **Fraction of column** | Sum of its column. Each column becomes fractions that sum to 1. |
| **Fraction of global max** | Largest cell in the entire matrix. All cells fall into 0–1. |
| **Log** | log₁₀(1 + x) — a logarithmic transform without normalization. |

A connectivity matrix of raw synapse counts is usually dominated by whichever cell type happens
to be numerous, so `Fraction of row` is the mode reached for most often — each row then reads as
"where does this type send its output."

> [!WARNING]
> Feeding a raw COUNT matrix into [Hierarchical Clustering](#cluster.linkage) with its distance mode set to `auto` causes it to read the counts as similarities and produce negative distances. Clustering proceeds silently with no errors, but the resulting tree renders offscreen. Normalize first — any mode except `raw values` or `log` will work.

```coda-params
caption: Example: normalizing a connectivity matrix
core.normalize: mode
```
