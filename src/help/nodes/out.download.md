## Inputs are passed through

Inputs are passed through untouched, so it works as a tap mid-chain like the viewers — writing whatever arrives to a file (CSV, SWC, OBJ, or an upstream chart as SVG/PNG) is a side effect, not a transformation.

## What triggers a download

When a download gets triggered depends on the `On run` parameter:
- Checked (default): every time the node runs, it writes the file.
- Unchecked: Only pressing the `Download now` button on the card writes the file.

```coda-params
caption: Parameters that control what gets written
out.download: format, onRun
```
