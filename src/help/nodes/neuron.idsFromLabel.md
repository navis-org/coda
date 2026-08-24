Let's say you have a list of cell types or any other label that your dataset uses to identify neurons and you want to visualise those. Your problem: neuroglancer and other viewers typically expect neuron IDs, not labels. That's where this node comes in: it resolves labels back to the neurons carrying them. It is the inverse of [`Find Neurons`](#neuron.findNeurons): labels in, neurons out.

### Exact matching is the default

Exact treats a label literally. Regex matches the whole name, like `Find Neurons`. Exact is the default because most labels come from text somebody copied, and they often contain regex metacharacters. For example, `SMP001(a)` has parentheses; `LC4-g` has a hyphen. Both are safe to paste under exact matching.

### The field picker reads any neuron column

The picker shows whatever columns your dataset uses to label neurons: `type`, `class`, `superclass`, `hemilineage`. The default field is type, the same one Find Neurons searches.

### Status defaults to Traced

Set to Any to include untraced fragments.

```coda-params
neuron.idsFromLabel: match, status
```
