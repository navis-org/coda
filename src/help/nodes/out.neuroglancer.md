The Neuroglancer node shows your neurons in the dataset's own neuroglancer scene, embedded in the card. Its output is the scene's URL, which you can also open in a browser tab or send to someone.

A dataset on its own is enough to get a scene. Wire a neuron table into `Neurons` to add those neurons to it, for example the neurons you selected in [Explore Dataset](#neuron.explore):

```coda-graph
caption: Pick neurons in Explore Dataset and look at them in neuroglancer.
neuron.explore as exp
out.neuroglancer as ngl
exp:selected -> ngl
```

Layers from Neuroglancer Source nodes can be wired into `Extra layers`; they are added after everything the dataset publishes.

## What is in the scene

This depends on the dataset:

- **neuPrint** datasets publish full neuroglancer scenes: image data, the segmentation with neuron meshes, a brain outline and sometimes synapse locations.
- **CAVE** datasets only provide image and segmentation sources, from which Coda builds a basic scene.
- **CATMAID** datasets don't work in neuroglancer at all. Use the [3D View](#out.viewer3d) node instead.

> [!WARNING] CAVE scenes sometimes don't centre on your neurons
> Use the `Center` button in the inspector to recentre the view.

A [BigClust Project](#annotation:bigclust)'s `Scene` output is a scene of its own, built from the project's settings. With `Colour` left on "the scene's own", its neurons keep the project's colours. For other datasets that option means neuroglancer gives each neuron its own colour.

## Settings

All settings are in the inspector, so the card is left for the viewer. Everything except `Interface scale` is written into the URL.

```coda-params
out.neuroglancer: layout, limit
```

- `Layout` sets the panels neuroglancer opens with: "3D only" shows just the meshes, the other two add EM sections.
- `Layers` set to "neurons only" leaves out the EM, region meshes and synapses the dataset publishes, which makes for a much shorter link.
- `Section planes` draws the EM cross-sections inside the 3D panel. It is off by default because the planes cut through the meshes.
- `Warn above` adds a warning when the scene would contain more than this many neurons. Very long links can fail to open in some browsers or deployments.
- `Viewer` picks a different neuroglancer deployment. Leave it empty to use the one the dataset names. The deployment has to allow being embedded.
- `Interface scale` shrinks or enlarges neuroglancer's toolbar and panels inside the card. This is not the camera zoom.
