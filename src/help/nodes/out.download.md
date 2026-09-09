## Inputs are passed through

Inputs pass through untouched, so this works as a tap mid-chain like the viewers. Writing whatever arrives to a file — CSV, SWC, OBJ, or an upstream chart as SVG/PNG — is a side effect, not a transformation.

## What triggers a download

The `On run` parameter decides:

- Checked (default): every time the node runs, it writes the file.
- Unchecked: only the `Download now` button on the card writes it.

```coda-params
caption: Parameters that control what gets written
out.download: format, onRun
```
