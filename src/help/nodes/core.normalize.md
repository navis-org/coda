Rescale a matrix cell by dividing it against a reference value.

| Mode | Rescales each cell by |
|------|---|
| **Raw values** | No change; keeps the input as-is. |
| **Fraction of row** | Sum of its row. Each row becomes fractions that sum to 1. |
| **Fraction of column** | Sum of its column. Each column becomes fractions that sum to 1. |
| **Fraction of global max** | Largest cell in the entire matrix. All cells fall into 0–1. |
| **Log** | log₁₀(1 + x) — a logarithmic transform without normalisation. |

A connectivity matrix of raw synapse counts is usually dominated by whichever cell type happens to be numerous, so `Fraction of row` is the mode reached for most often — each row then reads as "where does this type send its output".

> [!WARNING] Clustering a raw count matrix fails silently
> Feeding one into [Hierarchical Clustering](#cluster.linkage) with `Distance` on `auto` reads the
> counts as similarities and produces negative distances. The clustering proceeds with no error
> and the resulting tree renders offscreen. Normalise first — any mode but `raw values` or `log`.

```coda-params
caption: Example: normalising a connectivity matrix
core.normalize: mode
```
