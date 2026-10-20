## What VFB Info does

VFB Info shows [Virtual Fly Brain](https://virtualflybrain.org)'s page for each term in a table, one term at a time. Wire it after [VFB Neurons](#vfb:neurons) to read the FBbt cell types it adds, and step through them with ‹ and ›.

```coda-graph
caption: Read up on the cell types of a set of FlyWire neurons.
dataset.flywire as ds "FlyWire"
neuron.findNeurons as fn
vfb:neurons as vn
vfb:info as info
ds -> fn:dataset
ds -> vn:dataset
fn -> vn:neurons
vn -> info:terms
```

Each page shows:

- the term's name, symbol and tags, and VFB's definition and comment
- the types it is a kind of, and its relationships, e.g. where its cell body lies or which neurons it receives input from
- the name each connectome gives the type, e.g. its `male-cns` or `banc` name, which is how to look the same type up in another dataset
- other names it is known by
- a few example images, the brain template's first
- the papers VFB cites for it, with DOI and PubMed links, and records of it elsewhere

Terms named on the page are links to VFB. Rest the pointer on one to see what it is without leaving the page.

## Settings

```coda-params
vfb:info: termColumn
```

`Term column` picks the column of ids to show. Each distinct id is one page, in the order the ids first appear. It is `fbbtId` by default, but any column of VFB ids works, e.g. `vfbId` for the individual neurons themselves rather than their types.

The card asks Virtual Fly Brain for the term on screen only, and asks for each term once per session. Running the node fetches nothing; it passes its input through unchanged.
