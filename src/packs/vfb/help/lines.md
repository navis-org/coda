## What VFB Driver Lines does

VFB Driver Lines lists the split-GAL4, GAL4 and LexA lines that [Virtual Fly Brain](https://virtualflybrain.org) records as labelling each cell type in a table: one row per type and line. Wire it after [VFB Neurons](#vfb:neurons), which adds the `fbbtId` column it reads, and on to [VFB Expression Images](#vfb:images) to see what each line looks like.

```coda-graph
caption: Driver lines for a set of FlyWire neurons' types.
dataset.flywire as ds "FlyWire"
neuron.findNeurons as fn
vfb:neurons as vn
vfb:lines as dl
out.table as tbl
ds -> fn:dataset
ds -> vn:dataset
fn -> vn:neurons
vn -> dl:types
dl -> tbl
```

## Settings

```coda-params
vfb:lines: typeColumn, kinds, maxTargets
```

- `Drivers` picks which kinds of line to list. Split-GAL4 lines are usually the ones you want for genetic access to a single type.
- `Max types labelled` drops lines that label more than this many cell types in all. Set it to 1 to keep only lines VFB records for your type alone.

## The output

For each type, split lines come first, then the lines that label the fewest other types, then the best-imaged:

- `line`: the line's name, e.g. `MB074C` or `R15B01`.
- `driver`: "split", "GAL4", "LexA" or "other".
- `targets`: how many cell types VFB records the line as labelling. MB074C labels MBON01, MBON02 and MBON03, so it reads 3 on each of them.
- `images`: how many whole-line images VFB holds, in any template.
- `construct` and `lineId`: FlyBase's construct name and the VFB id that [VFB Expression Images](#vfb:images) reads.

> [!NOTE] What "labels" means
> A line is listed for a type when VFB records it as labelling neurons of that type, either from a curated annotation or from a single-neuron image of the line that VFB has typed. It says nothing about how strongly or how cleanly the line expresses, which is what the images are for.
