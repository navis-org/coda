### GitHub links are read from the raw file

Paste either GitHub link for a file — the file page (`github.com/org/repo/blob/main/table.tsv`) or its **Raw** button — and this node fetches `raw.githubusercontent.com` instead. Both original links fail in ways that are hard to recognise: the file page answers with the *HTML of the page*, which parses into a table of markup, and the Raw link is a redirect the browser blocks on cross-origin grounds before it ever arrives.

The URL you typed is what stays in the graph, and what an exported notebook or R Markdown document reads is the raw address, with a comment saying so.

### Refresh triggers a re-fetch

Cache keys are provenance, so `evaluate` must be deterministic. A file at a fixed URL can change underneath one. The `refresh` parameter is a nonce — bump it to fetch again. This is the same pattern the Dataset node uses: **hidden mutable state requires an explicit parameter** for anything to know when a re-run is needed.

```coda-params
core.tableFromUrl: url
```
