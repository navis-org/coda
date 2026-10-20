## What VFB Load Expression does

VFB Load Expression downloads each image's point cloud from [Virtual Fly Brain](https://virtualflybrain.org), so you can draw a driver line's expression in a [3D View](#out.viewer3d) next to EM neurons. Wire it after [VFB Expression Images](#vfb:images).

VFB keeps each light-microscopy image as the voxels above a threshold, each with its intensity. Images registered to JRC2018U brain come out in Coda's common space, so [Transform Neurons](#neuron.xform) the EM side to JRC2018U and wire both into one 3D View.

```coda-graph
caption: FlyWire neurons transformed to JRC2018U, beside the expression of a set of driver lines.
dataset.flywire as ds "FlyWire"
neuron.skeletons as sk
neuron.xform as xf
vfb:images as img
vfb:expression as ex
out.viewer3d as v3d
ds -> sk:dataset
sk -> xf:in
xf -> v3d:skeletons
img -> ex:images
ex -> v3d:points
```

The images come from [VFB Expression Images](#vfb:images), usually after [VFB Neurons](#vfb:neurons) and [VFB Driver Lines](#vfb:lines) on the same neurons.

## Settings

```coda-params
vfb:expression: objColumn, pointsPerImage, minIntensity
```

- `Points per image` thins each image evenly to at most this many points. One image holds anything from 16,000 to half a million points (1 to 28 MB to download), so the default of 50,000 keeps a dozen lines drawable. Set it to 0 to keep every point.
- `Min intensity` drops points below an intensity from 0 to 1. VFB has thresholded its images already, so 0 keeps what VFB kept.

## The output

One point per voxel, carrying `imageId`, `line` and `intensity`, so a 3D View can colour by line or by intensity. Rows without a point cloud on Virtual Fly Brain's file server are left out and counted, as are images that could not be downloaded.

> [!NOTE] Only JRC2018U brain lines up
> Images registered to another template come out with no space, and do not line up with EM neurons. If the images come from different templates, no space is set at all.
