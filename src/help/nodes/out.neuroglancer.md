The Neuroglancer node shows your neurons in the dataset's own neuroglancer scene, embedded in the card. It has two outputs: `Link`, the scene's URL in the dataset's own neuroglancer, which you can open in a browser tab or send to someone, and `Selected`, the neurons the scene shows.

A dataset on its own is enough to get a scene. Wire a neuron table into `Neurons` to add those neurons to it, for example the neurons you selected in [Explore Dataset](#neuron.explore):

```coda-graph
caption: Pick neurons in Explore Dataset and look at them in neuroglancer.
neuron.explore as exp
out.neuroglancer as ngl
exp:selected -> ngl
```

Layers from Neuroglancer Source nodes can be wired into `Extra layers`; they are added after everything the dataset publishes.

## Picking neurons in neuroglancer

Double-click a neuron in the scene to add it, and double-click it again to hide it. `Selected` follows: it holds the neurons from `Neurons` that are still shown, plus any you added. Added neurons are looked up in the dataset, so they come with the same columns as the rest; a segment the dataset's neuron table does not list, such as a small fragment, comes with only its ID.

```coda-graph
caption: Add neurons in neuroglancer, then look up their partners.
neuron.findNeurons as find
out.neuroglancer as ngl
neuron.connectivity as conn
find:neurons -> ngl
ngl:selected -> conn
```

The card runs Spelunker, CAVE's neuroglancer, with its keyboard shortcuts: on CAVE datasets `m`, `c` and `f` start the merge, split and find-path tools, and `Ctrl+Shift+X` clears all neurons from the scene.

The card also remembers where you were looking: its panel layout, position and zoom are saved with the workflow, so reopening it, or opening a share link to it, starts at the same spot. Changing the dataset starts again from the dataset's own framing.

Your changes are kept on the node as `Viewer edits`, on top of whatever arrives at `Neurons`. Editing a filter upstream therefore keeps the neurons you added. Clear `Viewer edits` in the inspector to go back to the input.

By default a hidden neuron, whether double-clicked out or un-ticked in neuroglancer's segment list, leaves `Selected`, so `Selected` always matches what you see. Set `Hidden neurons` to "stay in Selected" to keep hidden neurons in the output, with a `visible` column that is `false` for them. With that setting a double-click only hides a neuron; to take one out, remove it from neuroglancer's segment list.

> [!NOTE] Only Coda's own neuroglancer reports back
> By default the card uses a copy of neuroglancer served by Coda, which is what lets it read your clicks. If you set `Viewer type` to another viewer, use the card's `From link` button instead: copy the link from that viewer and paste it there. `Link` always opens the dataset's own viewer, so it works for anyone you send it to.

## What is in the scene

This depends on the dataset:

- **neuPrint** datasets publish full neuroglancer scenes: image data, the segmentation with neuron meshes, a brain outline and sometimes synapse locations.
- **CAVE** datasets only provide image and segmentation sources, from which Coda builds a basic scene.
- **CATMAID** datasets don't work in neuroglancer at all. Use the [3D View](#out.viewer3d) node instead.

> [!WARNING] CAVE scenes sometimes don't centre on your neurons
> Use the `Center` button in the inspector to recentre the view.

A [BigClust Project](#annotation:bigclust)'s `Scene` output is a scene of its own, built from the project's settings. With `Colour` left on "the scene's own", its neurons keep the project's colours. For other datasets that option means neuroglancer gives each neuron its own colour.

## Settings

All settings are in the inspector, so the card is left for the viewer. Everything except `Interface scale` and `Layer bar` is written into the URL.

```coda-params
out.neuroglancer: layout, limit
```

- `Layout` sets the panels neuroglancer opens with: "3D only" shows just the meshes, the other two add EM sections.
- `Layers` set to "neurons only" leaves out the EM, region meshes and synapses the dataset publishes, which makes for a much shorter link.
- `Section planes` draws the EM cross-sections inside the 3D panel. It is off by default because the planes cut through the meshes.
- `Warn above` adds a warning when the scene would contain more than this many neurons. Very long links can fail to open in some browsers or deployments.
- `Viewer type` picks the neuroglancer the card shows: Coda's own (the default, and the only one that reports the neurons you pick), the dataset's viewer, or a custom deployment. For a custom one, choose which kind it is, Spelunker/mainline or Seung-lab, and enter its address in `Viewer`. It has to allow being embedded. None of this changes `Link`, which always opens the dataset's own viewer.
- `Hidden neurons` decides whether a neuron hidden in neuroglancer leaves `Selected` (the default) or stays in it with `visible` set to `false`.
- `Viewer edits` holds the neurons you added or removed inside neuroglancer. Clear it to go back to the `Neurons` input.
- `Interface scale` shrinks or enlarges neuroglancer's toolbar and panels inside the card. This is not the camera zoom.
- `Layer bar` shows neuroglancer's strip of layer chips along the top. It is off by default, in the card and in the expanded view; a link opened in a new tab always has it.
