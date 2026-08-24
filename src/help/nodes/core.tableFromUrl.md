### Refresh triggers a re-fetch

Cache keys are provenance, so `evaluate` must be deterministic. A file at a fixed URL can change underneath one. The `refresh` parameter is a nonce — bump it to fetch again. This is the same pattern the Dataset node uses: **hidden mutable state requires an explicit parameter** for anything to know when a re-run is needed.

```coda-params
core.tableFromUrl: url
```
