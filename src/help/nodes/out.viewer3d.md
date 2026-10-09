## Inputs

The 3D View draws neurons and brain regions in one scene. It has four input sockets, and you only need to fill one of them:

| Socket      | What it draws                                                | Typically comes from                |
| ----------- | ------------------------------------------------------------ | ----------------------------------- |
| `Skeletons` | the neuron's branching wire frame                            | `Skeletons`                         |
| `Meshes`    | the neuron's surface                                         | `Meshes`                            |
| `Points`    | one dot per synapse, soma, or anything else with a position | `Synapses`                          |
| `Volumes`   | neuropil shells, i.e. the brain regions around the neurons   | [`ROI Meshes`](#neuron.roiMeshes)   |

`Volumes` takes meshes just like `Meshes` does. It is a separate socket so that regions and neurons can have their own opacity and colours.

All geometry is converted to nanometres before it reaches the viewer, so a skeleton from one query and a mesh from another line up in the same place.

```coda-graph
caption: One neuron search feeds both morphology queries, so the skeletons and the synapses belong to the same cells. The regions come from the dataset alone.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
neuron.synapses as syn
neuron.roiMeshes as rois
out.viewer3d as view
ds -> find
ds -> skel:dataset
ds -> syn:dataset
ds -> rois:dataset
find:neurons -> skel:neurons
find:neurons -> syn:neurons
skel -> view:skeletons
syn:points -> view:points
rois:meshes -> view:volumes
```

## Settings

The card itself only shows the ports, the picture and the legend. To change settings, expand the card (`⤢`): all settings are in the **Style** panel on the right, with one tab per socket plus a `Scene` tab. The **Style** button in the header hides the panel again.

```coda-params
caption: The settings you are most likely to change. None of them affect anything downstream.
out.viewer3d: meshOpacity, pointSize, background
```

- **Opacity**: meshes start fully opaque (1) and volumes mostly transparent (0.12). Each has a slider in its colour row.
- **Point size** is in nanometres, not pixels, so synapses stay the same size relative to the neuron as you zoom. The default of 800 nm is larger than a real synapse so that the dots are visible next to a mesh. Zoomed out on a whole brain they shrink to specks.
- **Light intensity** scales the scene's lighting; 1 is the default. Above about 1.4 the brightest surfaces start to turn white, and at the top of the slider about a quarter of the visible surface has lost its colour.
- **Ambient occlusion** darkens creases, cavities and places where surfaces meet. 0 turns it off; at 100% a fully occluded pixel goes black, and above that the effect spreads wider instead of getting darker. Only opaque meshes and volumes cast it, so a scene with only skeletons is unaffected.
- **Background** fixes the canvas colour regardless of the app's theme. "black" is not the same as "dark", which is a very dark grey.

## Colours

Each input comes with an attribute table: one row per skeleton, mesh or point, in the same order as the geometry. Colouring works by picking a column from that table, e.g. `type` to colour neurons by cell type. Skeletons, meshes, points and volumes each have their own colour setting, so you can colour neurons by cell type and their synapses by polarity at the same time.

Skeletons and meshes start out on "a colour each", based on `neuronId`. This uses the same colour hashing as neuroglancer, so a neuron that is teal in a FlyWire neuroglancer scene is teal here too. Volumes start out in a single grey: with dozens of neuropils and eight palette colours, colours would repeat every eighth region. If the regions are what you want to look at, switch to "by category" on `roi`.

| Mode                  | Use it when                                                                    |
| --------------------- | ------------------------------------------------------------------------------ |
| "a colour each"       | the colour identifies individual neurons. There is no limit on the number of colours |
| "by category"         | the colour stands for a group, e.g. `type`, `side` or a cluster number         |
| "by value"            | the column is numeric and the order matters, e.g. cable length or synapse count |
| "single colour"       | the colour does not need to carry any information                             |
| "colours in a column" | a column upstream already contains the colours you want                        |

"by category" assigns the palette's eight colours to the most common values first and starts over after the eighth; the caption tells you when colours repeat. "a colour each" generates a colour per value and never runs out, but the colours are not checked for colourblind safety.

### Colouring by value

When the mode is "by value", the column picker only offers numeric columns, and a few extra controls appear in the same row:

| Control       | What it does                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ramp`        | Coda blue or one of matplotlib's (viridis, magma, cividis, ...). Ramps marked `centred` are diverging, with their middle colour at `centre` |
| `min` / `max` | the values at the two ends of the ramp; leave empty to use the data's range. Values outside get the end colour, and the legend says `values clipped` |
| `centre`      | centred ramps only; empty means 0. Both arms are the same length, so there is no `min`, and `max` is the distance from the centre to either end |
| `log`         | uses a log scale for the colours; the colour bar still shows the actual values. Not available on centred ramps |

If `min` is larger than `max`, the limits are ignored and the legend says `limits ignored`. The same controls exist on the [Scatter Plot](#out.scatter) and for node colours in the [Network Viewer](#out.network).

## The legend

The legend under the canvas has one entry per category for every colour setting that uses categories. You can use it to change the scene:

| Part of the entry  | What it does                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| the swatch         | opens a colour picker to change that entry's colour                                 |
| the label          | selects all neurons under it; click again to deselect                               |
| the dot after it   | hides that entry from the scene; `Alt`-click (`Option` on a Mac) shows only that entry |

Hidden neurons are not drawn at all, so you can't click them either. The caption says how many are hidden.

Synapse entries can be hidden and recoloured, but not selected, because the node's selection is a selection of neurons.

Hidden entries and custom colours are saved with the workflow. `show all` and `reset colours` appear at the end of the legend when there is something to undo.

When more than one socket is connected, the name of each group in the legend (e.g. `● skeletons`, `● volumes`) toggles that whole socket on and off. This is useful for sockets in a single colour, such as neuropil shells, which have no individual entries to hide.

> [!NOTE] The legend shows at most twelve entries
> With "a colour each" there is one entry per neuron, so the legend shows the first twelve and
> then e.g. `+28 more`. The other neurons are still drawn in their own colours; they just don't
> have an entry you can click.

## Moving around

The camera works like a trackball (the same as neuroglancer's): drag to rotate, scroll to zoom. There is no fixed "up" direction. The compass in the corner shows the current orientation, and clicking one of its axes flies to that view.

The camera centres on the scene the first time there is something to show and then stays put, even when upstream nodes re-run or you expand and collapse the card. Press **Reset view** (`⟲` in the caption) to frame the whole scene again. If you would rather have the camera re-frame every time the scene changes (e.g. when a [For Each](#flow.forEach) loop sends one neuron at a time through the viewer and the neurons are far apart), switch on `Frame each` on the `Scene` tab. Leave it off if you want a series of images at the same scale.

## Selecting neurons

Selected neurons keep their colour while everything else is dimmed to grey. Lighter colours become lighter greys, so unselected neurons can still be told apart. Colours of similar lightness (such as the eight "by category" colours) end up as similar greys. The selected neurons are sent out through the `Selected` output as a normal neuron table.

There are two ways to select:

- **Legend labels**: click a label in the legend (see above). This always works.
- **Clicking in the scene**: off by default. Switch on `Select by clicking` on the `Scene` tab, then click a skeleton or mesh to select that neuron, and click again to deselect it. Synapse points and volumes are not clickable, so a click goes through a neuropil shell to the neuron inside.

Clicking in the scene is off by default because changing the selection marks everything downstream as stale and re-runs it. With it on, a click that lands on a neurite while you are rotating the scene would do that.

`3 selected ⨯` in the caption clears the selection.

## Line width

`Line width` controls how skeletons are drawn and has three modes. New cards start on "by radius".

- "one width" draws every neurite with the same width.
- "by radius" uses each neurite's recorded radius (e.g. CATMAID's annotated radii, CAVE's level-2 chunk sizes, or the radius column of neuPrint's SWC files). The number is the width in pixels of the thickest neurites; everything thinner is scaled down in proportion, to a minimum of one pixel. The arbour looks the same at every zoom level, which suits figures about branching patterns.
- "to scale" uses the same radii, but in the scene's own units, so the number is a multiplier: at 1, a 200 nm neurite is drawn 200 nm across and gets thicker as you zoom in. Use this if the calibre itself matters. Zoomed far out, thin neurites all end up at the one-pixel minimum.

Nodes without a recorded radius are drawn as hairlines, and sources that don't publish radii fall back to "one width". Widths above 1 take more effort to draw: each segment then needs about four times as much data.

## Exporting a picture

The download button offers:

- **PNG**: the scene as it is, at twice screen resolution, without the compass.
- **PNG, no background**: the same with a transparent background, for figures.
- **CSV**: the attribute table behind the geometry (not the picture).

> [!TIP] Thicken lines for transparent exports
> On a transparent background, one-pixel lines come out pale. Increase `Line width` before exporting.

A `Download` node wired to this one can save the same PNG during a run, but only if this card is on screen while the run happens.

## Limitations

- The 3D View is not a segmentation browser. For EM image data, published scenes, or meshes loaded straight from a bucket, use `Neuroglancer`, which fetches its own data instead of taking it from a wire.
- The `ROI Viewer` (which shows where a brain region is and how well it is traced) is a separate tool, and its geometry can't be passed on. To draw the same region shells here, use [`ROI Meshes`](#neuron.roiMeshes).
- Everything the viewer draws has to be fetched first. The morphology nodes are `expensive` and capped, so the 3D View is meant for tens of neurons, not thousands.
