## What Select One does

Select One lets you step through a collection (a table, skeletons or meshes) and passes on one element at a time. Think of it as a manual version of a [For Each](#flow.forEach) loop: instead of running everything downstream once per element, you flip through the elements with the arrows on the card and look at each in turn.

A typical use is going through a list of neurons one by one, e.g. [Explore Dataset](#neuron.explore) → Select One → [Skeletons](#neuron.skeletons) → [3D View](#out.viewer3d), or like this:

```coda-graph
caption: Load skeletons and look at them one at a time.
neuron.skeletons as sk
core.selectOne as s
out.viewer3d as v
sk:skeletons -> s
s -> v
```

Elements are picked by their position in the collection, not by an id. That means Select One works on anything you can step through, including tables without an id column, such as the output of a [Group By](#core.groupBy).

## Browsing and committing

The card keeps track of two positions:

- `Showing` is the element the card currently displays.
- `Emitting` is the element that is actually passed on through the `Item` output.

Pressing "Use this" sets `Emitting` to whatever you are looking at and re-runs everything downstream. With the arrows alone you can browse as much as you like without triggering anything.

```coda-params
core.selectOne: live, selected
```

Turn on `Live` to couple the two, so the arrows change the output directly. Whether you want that depends on what comes after: with only cheap nodes downstream, `Live` gives you immediate feedback. With an expensive node downstream (e.g. a fetch from a server), leave `Live` off, browse to the element you want, and then press "Use this". [Neuron Profile](#out.profile) uses the same pattern for its pager.

> [!WARNING] Changes upstream move what the position points at
> If something upstream re-sorts or filters the collection, the same position now refers to a
> different element. If the collection gets shorter than the chosen position, the output is
> empty rather than the last element, so you don't silently end up looking at the wrong one.
