## What VFB Expression Images does

VFB Expression Images lists the registered light-microscopy images [Virtual Fly Brain](https://virtualflybrain.org) holds for each driver line: one row per image, with the specimen, the template it is registered to, its dataset and licence, and the URLs of its files. Wire it after [VFB Driver Lines](#vfb:lines), and on to [VFB Load Expression](#vfb:expression) to draw the images in 3D.

```coda-graph
caption: From the driver lines of a set of neurons' types to their images.
vfb:neurons as vn
vfb:lines as dl
vfb:images as img
out.table as tbl
vn -> dl:types
dl -> img:lines
img -> tbl
```

## Settings

```coda-params
vfb:images: lineColumn, templates, fragments
```

- `Templates` picks which registrations to list. A line imaged in the brain and the nerve cord has one in each, so "JRC2018U brain" and "JRC2018U VNC" are both ticked by default. Only "JRC2018U brain" lines up with EM neurons: that is the space [Transform Neurons](#neuron.xform) takes an EM dataset to.
- `Include fragments` adds partial images of each line: high-magnification tiles and single-neuron images. These can be several times as many rows.

## The output

`thumbnail`, `obj` and `nrrd` are links to the image's files: a preview, the point cloud [VFB Load Expression](#vfb:expression) reads, and the full image stack. `license` is the image's licence. Check it before reusing an image; many FlyLight images are CC-BY-NC-SA.

> [!NOTE] Not every image has a point cloud
> Roughly half of VFB's registered images have only an image stack, no point cloud. They are listed, with an empty `obj`, and the card counts them; VFB Load Expression leaves them out.
