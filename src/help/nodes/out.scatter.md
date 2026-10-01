### Drawing and export

Every row is drawn, whatever the size of the table — a whole-dataset embedding of over a hundred thousand neurons pans smoothly. With more than 10,000 points in view the marks are drawn as pixels; zoom in past that and they become exact shapes again.

Export re-draws the current view (SVG, PDF, PNG). With more than 10,000 points in view the exported marks are one high-resolution image inside an otherwise vector file, because a file of a hundred thousand vector marks opens in almost nothing. Tick `"Vector marks"` for every mark as a shape regardless.

### Selection and lasso

Lasso a group of points and they arrive at the **Selected** output as a table. Two parameters control what that means:

- **ID column** resolves each point to a cell value, typically a neuron ID or row index. Unset, selection is unavailable: an id-less lasso would return nothing and read as a broken one.
- **Selection** captures the lasso geometry in the saved file and in the graph's provenance key, exactly as [Network Viewer](#out.network)'s does.

```coda-params
caption: Interactive parameters
out.scatter: xLog, yLog, vectorMarks
```
