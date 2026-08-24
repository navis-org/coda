> [!WARNING] CAVE-only
> It's in the name but just to be extra clear: this node only works with CAVE datasets!

## CAVE Table

Reads a CAVE annotation table directly and publishes neuron labels for a Dataset. The table must carry a root id column; CAVE's built-in cell typing (keyed through a reference table) becomes the Dataset's labels when no annotation source is wired.

### Long Tables and Pivoting

For a table in one row per (neuron, kind, value) format, set **Pivot on** to the column naming the annotation kind — its distinct values become new columns. **Value column** names the column holding the annotation itself. Empty `Pivot on` means the table is already one row per neuron.

### Chaining Annotation Sources

This node chains with [FlyTable](#annotation.flyTable), [SeaTable](#annotation.seaTable), and Google Sheets via optional Annotations inputs. Later sources win name collisions: wire them in series, and order on the canvas means something. The output is ordinary neuron table data, so Filter or Sort can edit the chain.

```coda-params
caption: Unpivoting long tables
annotation.caveTable: pivotOn, valueColumn
```
