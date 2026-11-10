## What Table to Points does

Table to Points reads three columns of a table as x, y and z, and gives back a point cloud. Anything else you name comes along as an attribute of each point, so a `neuronId`, a label or a score can colour the cloud or be read off a point you click.

It is the way into everything that treats positions as geometry: drawing them in 3D, asking Points in Volumes which region each one is in, or measuring depth.

```coda-graph
caption: A table of positions, drawn in 3D.
core.uploadTable as upload
core.tablePoints as points
out.viewer3d as view
upload -> points:in
points -> view:points
```

## Say what the numbers are

`Nanometres per unit` is the one setting you should not skip. A column of numbers is not nanometres until somebody says so, and the same table is a perfectly good cloud read at any scale — the readings differ by a factor that nothing downstream can detect.

Put `1, 1, 1` if the columns are already nanometres, or the voxel size if they are not: `4, 4, 40` for a table of 4x4x40 nm voxels. The cloud that comes out is nanometres either way, which is what everything that measures a distance expects.

## Rows without a position

A row whose three coordinates are not all numbers has no position, so it is left out and the node says how many. That covers a blank cell, a `null` from a join that missed, and text that is not a number.

> [!NOTE]
> **Blank is not zero**
> It would be easy to read an empty cell as 0 and put the point at the origin. That is a cluster of points nobody put there, in a cloud that otherwise looks right, and nothing would fail. So those rows are dropped instead.

## Every point knows its row

Each point carries a `row` column saying which row of the table it came from, whether or not you carried anything else. It is there so a point can be joined back to the table it came from — and the rows that were left out for having no position are the numbers missing from it.

## The coordinate columns are the geometry now

They are not carried into the attributes unless you name them under `Carry`. Keeping them would leave two spellings of one fact — the position, and three columns that say the same thing — which drift apart the moment anything transforms the cloud.

## Picking the columns

The three pickers start empty rather than guessing. A picker with a default resolves to the first compatible column when the one it names is missing, and on this node that would mean some unrelated numeric column read as a coordinate — a cloud in the wrong place, drawn without complaint. Empty asks you instead.
