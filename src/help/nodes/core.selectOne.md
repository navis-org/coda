The manual counterpart to a `For each` loop. Where a `For each` would apply a sub-workflow to every element and collect the results, `Select One` walks a collection by hand — forward, back — and emits one element at a time. [Explore](#neuron.explore) → Select One → Skeletons → 3D View is the shape it exists for: browsing the neurons of a result one by one.

```coda-graph
 caption: Load skeletons and visualise them one at a time.
 neuron.skeletons as sk
 core.selectOne as s
 out.viewer3d as v
 sk:skeletons -> s
 s -> v
 ```

### Selection by index, not identity

`Select One` chooses by position in the collection, not by an id column. This works on anything iterable — a table, skeletons, meshes, even a groupBy roll-up with no id column.

> ![WARNING]
> If something upstream re-sorts the collection, the same index now points at a different element. If the index lands past the end of the collection, the output is empty rather than clamped to the last valid element — this avoids silently showing you the wrong element when an upstream filter shrinks the collection.

### Browsing and committing are separate acts

1. The _Showing_ field (presentational) is what the card displays.
2. The _Emitting_ field (the parameter that matters) is what the output port carries.

Pressing "Use this" commits the choice and re-runs downstream.

The _Live_ toggle couples them:

- `Off`: the arrows move only _Showing_
- `On`: they move both at once.

This is the same pattern [Profile](#out.profile) uses for its pager and pin. On a cheap chain, `Live` on is what you want — immediate feedback. On an expensive chain with a slow node downstream, `Live` off is where you browse for free and only commit when you have found what you are looking for.

```coda-params
core.selectOne: live, selected
```
