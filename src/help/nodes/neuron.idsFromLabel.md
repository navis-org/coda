Resolves labels back to the neurons carrying them — the inverse of [`Find Neurons`](#neuron.findNeurons): labels in, neurons out. Useful because neuroglancer and other viewers expect neuron IDs rather than cell type names.

### Exact matching is the default

Exact treats a label literally; regex matches the whole name, like `Find Neurons`. Exact is the default because most labels are text somebody copied, and they often contain regex metacharacters — `SMP001(a)` has parentheses, `LC4-g` a hyphen. Both are safe to paste under exact matching.

### The field picker reads any neuron column

It offers whatever columns your dataset uses to label neurons: `type`, `class`, `superclass`, `hemilineage`. The default is `type`, the same one Find Neurons searches.

### Status defaults to Traced

Set it to Any to include untraced fragments.

```coda-params
neuron.idsFromLabel: match, status
```
