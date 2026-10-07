## What Neuron Dendrogram does

Neuron Dendrogram draws one neuron's arbour flat, with its synapses marked along the branches. Distance from the root runs along the drawing, so you can read off how far out on a branch the inputs from a given partner sit. Click any point on the arbour and the card lists every input and output beyond it.

```coda-graph
caption: Find some neurons and draw them one at a time.
dataset.hemibrain as hb
neuron.findNeurons as find
out.neuronDendrogram as dendro
hb -> find
find -> dendro
hb -> dendro
```

The card fetches the skeleton and synapses for the neuron on screen as you page through the incoming table, the same way [Neuron Profile](#out.profile) does. Nothing needs to run for the drawing.

## Layouts

`Layout` picks how the arbour is laid out:

- "Dendrogram" puts distance from the root on the horizontal axis and stacks the branch ends top to bottom. This is the one to use if you want to compare distances by eye.
- "Radial" is the same picture wrapped around the root, which fits large neurons onto a card more comfortably.
- "Subway" is navis's `plot_flat(layout='subway')`: the longest path runs straight to the right and every other branch leaves it at an angle. Branches are drawn at their true length but can overlap.
- "Unrooted" draws every branch at its true length and spreads the subtrees out so that none of them cross. It looks the most like the neuron itself.

```coda-params
out.neuronDendrogram: layout, order, minTwig
```

`Hide twigs under` leaves short end branches out of the drawing, which helps on a neuron with thousands of small twigs. It only affects the drawing: distances and the counts on the Distal tab still include every branch.

## Distance

`Distance` switches between geodesic distance (cable length, in µm) and electrotonic distance. Electrotonic distance divides each stretch of cable by its length constant, λ = √(Rm · r / 2Ri), so a thin branch counts as electrically "longer" than a thick one of the same length. The result is in units of λ.

```coda-params
out.neuronDendrogram: metric, rm, ri
```

The default constants are those Gouwens & Wilson (2009) fitted for Drosophila projection neurons. If you are working on mammalian neurons, change `Membrane resistance` and `Axial resistivity` to values that suit your cells.

> [!WARNING] Radii
> Electrotonic distance needs a radius on every node. CATMAID skeletons usually have none, and
> the card falls back to geodesic distance and says why. On MANC, the male CNS and the optic lobe,
> most radii are a fixed 256 nm, so electrotonic distance comes out close to geodesic distance
> scaled; the card points this out too.

## Synapses

Each synapse is a short tick across its branch. Outputs point to one side and inputs to the other, so you can tell them apart even when the ticks are coloured by something else. Hover a tick to see its partner, whether it is an input or an output and how far it is from the root.

`Colour synapses by` colours the ticks by "Input / output", by "Partner type", or by any other column of the dataset's synapse table (e.g. a confidence score). The Partners tab works as in Neuron Topology: pick one or more partners and their synapses are lit while the rest fade.

```coda-params
out.neuronDendrogram: colorBy, synapseSize, unlitOpacity
```

> [!NOTE] neuPrint
> neuPrint's synapse table does not say who is on the other side of a synapse. The card asks for
> that separately when you first need it: when you light a partner, hover a tick, colour by
> partner type or open the Distal tab. On a large neuron this can take a few seconds.

## Colouring branches

`Colour branches by` colours the arbour itself:

- "Strahler order" shows the branching hierarchy, with the main neurite at the top of the range.
- "Synapse flow centrality" is navis's `synapse_flow_centrality`: the number of input-to-output paths that pass through each stretch of cable. It tends to light up the cable that links the dendrite to the axon. It is drawn on a square-root scale because the values span several orders of magnitude.
- "Distance to root" uses whichever distance the card is showing.

Strahler order and flow centrality are computed with the root you chose, so both change when you change `Root`.

```coda-params
out.neuronDendrogram: branchColor, branchPalette, widthBy, lineWidth
```

`Branch width` set to "By radius" draws each stretch of cable as wide as its radius. The 95th percentile radius is drawn at twice `Line width`, so a large soma does not squash everything else to a hairline.

## Clicking a branch

Click any point on the arbour to open the Distal tab. It lists the inputs and outputs beyond that point, grouped by partner type, with the nearest, median and farthest distance from the point for each. "Make root" re-roots the neuron at that point, which is useful when the dataset roots it somewhere unhelpful.

```coda-params
out.neuronDendrogram: root
```

`Root` decides which way is "out": "Soma" uses the soma where the dataset labels one and otherwise falls back to the root the skeleton came with.

The `Points` output carries the synapses beyond the clicked point, with two extra columns, `distanceFromPoint` and `distanceFromRoot` (both in µm). Unlike the drawing, this needs a Run: clicking a new point or changing `Root` marks the output stale. You can feed it into a [3D View](#out.viewer3d) to see where those synapses sit on the neuron.

## Fragmented skeletons

Skeletons generated from a segmentation sometimes come in several pieces. The card joins them with navis's `heal_skeleton` before drawing (this downloads the Python runtime the first time) and draws the joins as dashed lines, since they are cable nobody traced.

## Downloading

The ⤓ button saves the current drawing as SVG or PNG, including the scale bar and the colour key. The SVG is editable in e.g. Illustrator or Inkscape.
