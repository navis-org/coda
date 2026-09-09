### Drawing and export

To draw tens of thousands of points the plot renders to a canvas rather than as SVG. Export re-draws it as vector (PDF, SVG, PNG) without loss, so the file does not depend on the sample shown on screen.

Past `Max points` the node draws a uniform sample of the table, and the caption says how many of how many. The full table still passes through to the `out` port unchanged, and a lasso tests against every row — not just the visible sample.

### Selection and lasso

Lasso a group of points and they arrive at the **Selected** output as a table. Two parameters control what that means:

- **ID column** resolves each point to a cell value, typically a neuron ID or row index. Unset, selection is unavailable: an id-less lasso would return nothing and read as a broken one.
- **Selection** captures the lasso geometry in the saved file and in the graph's provenance key, exactly as [Network Viewer](#out.network)'s does.

```coda-params
caption: Interactive parameters
out.scatter: xLog, yLog, maxPoints
```
