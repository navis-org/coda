### GitHub links are read from the raw file

Paste either GitHub link for a file — the file page (`github.com/org/repo/blob/main/table.tsv`) or its **Raw** button — and this node fetches `raw.githubusercontent.com` instead. Both original links fail in ways that are hard to recognise: the file page answers with the *HTML of the page*, which parses into a table of markup, and the Raw link is a redirect the browser blocks on cross-origin grounds before it arrives.

The URL you typed is what stays in the graph; an exported notebook or R Markdown document reads the raw address, with a comment saying so.

### Refresh triggers a re-fetch

A file at a fixed URL can change underneath a cached result. `refresh` is a nonce — bump it to fetch again.

```coda-params
core.tableFromUrl: url
```
