### Drawing and export

To allow drawing tens of thousands of points, the plot renders to a canvas rather than as SVG. When you export, the output is re-drawn as vector (PDF, SVG, PNG) without loss — the file does not depend on the sample shown on screen.

Also note the `Max points` parameter: beyond that limit, the node draws a uniform sample of the table, and the caption says how many of how many. The full table still passes through to the `out` port unchanged, and a lasso selection tests against every row in the table — not just the visible sample.

### Selection and lasso

Lasso a group of points in the viewer, and they arrive at the **Selected** output port as a table. Two parameters control what that means:

- **ID column** resolves each point to a cell value — typically a neuron ID or row index. If unset, selection is unavailable; an id-less lasso returns nothing because a lasso with no id to return is misleading.
- **Selection** captures the lasso geometry in the saved file and in the graph's provenance key, exactly as [Network Viewer](#out.network)'s `Selected` output works.

```coda-params
caption: Interactive parameters
out.scatter: xLog, yLog, maxPoints
```
