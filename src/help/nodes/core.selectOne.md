The manual counterpart to a `For Each` loop: it walks a collection by hand — forward, back — and emits one element at a time. [Explore Dataset](#neuron.explore) → Select One → Skeletons → 3D View is the shape it exists for.

```coda-graph
 caption: Load skeletons and visualise them one at a time.
 neuron.skeletons as sk
 core.selectOne as s
 out.viewer3d as v
 sk:skeletons -> s
 s -> v
 ```

### Selection by index, not identity

It chooses by position in the collection, not by an id column, so it works on anything iterable — a table, skeletons, meshes, even a groupBy roll-up with no id column.

> [!WARNING] Re-sorting upstream moves what the index points at
> An index past the end of the collection gives an empty output rather than clamping to the last
> element, so an upstream filter that shrinks the collection does not silently show you the wrong
> one.

### Browsing and committing are separate acts

1. The _Showing_ field (presentational) is what the card displays.
2. The _Emitting_ field is what the output port carries.

Pressing "Use this" commits the choice and re-runs downstream. The _Live_ toggle couples them: off, the arrows move only _Showing_; on, they move both.

This is the pattern [Neuron Profile](#out.profile) uses for its pager and pin. On a cheap chain `Live` on gives immediate feedback; on an expensive one, `Live` off is where you browse for free and commit when you have found what you want.

```coda-params
core.selectOne: live, selected
```
