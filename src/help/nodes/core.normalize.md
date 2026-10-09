## What Normalize does

Normalize rescales the values in a matrix, typically a connectivity matrix coming out of a [Pivot](#core.pivot). `Mode` picks the rescaling:

| Mode | Each cell is |
| --- | --- |
| "raw values" | left as it is |
| "fraction of row total" | divided by the sum of its row, so each row sums to 1 |
| "fraction of column total" | divided by the sum of its column, so each column sums to 1 |
| "fraction of global max" | divided by the largest value in the matrix, so all cells fall between 0 and 1 |
| "log10(1 + x)" | log-transformed, without any normalisation |

```coda-params
core.normalize: mode
```

In a matrix of raw synapse counts, whichever cell types have the most neurons tend to dominate the picture. "fraction of row total" is therefore the mode you will want most often: if rows are presynaptic types, each row then tells you what fraction of that type's output goes to each target.

> [!TIP] Normalise counts before clustering
> [Linkage](#cluster.linkage) reads a matrix it knows nothing about as similarities, which raw
> synapse counts are not, and refuses to run on them. Put a Normalize with one of the fraction
> modes in front of it.

## Negative values and empty rows

Most of the time you will be normalising counts, but signed matrices (e.g. [NBLAST](#neuron.nblast) scores, or cosine and Pearson similarities from a [Similarity Matrix](#core.similarity)) work too:

- A row or column that is all zeros stays all zeros.
- A row or column that contains values but sums to zero or less has no meaningful fraction. Its cells are left empty (a [Heatmap](#out.heatmap) draws them as unrecorded) and the node tells you how many there were.
- "fraction of global max" divides by the largest absolute value, so negative values keep their sign and everything ends up between -1 and 1.
- With "log10(1 + x)", cells at or below -1 have no logarithm. They are left empty, again with a warning.
