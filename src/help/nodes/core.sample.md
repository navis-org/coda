## What Sample does

Sample keeps a subset of a table's rows. It is useful for cutting a large table down to something you can plot or inspect, or for trying out an expensive analysis on a few neurons before running it on all of them. Columns are left alone, so a sampled neuron table is still a neuron table.

```coda-params
core.sample: mode, seed
```

## Modes

| Mode | Keeps |
| --- | --- |
| "Top N" | the first `Rows` rows |
| "Bottom N" | the last `Rows` rows |
| "Every Nth" | one row in every `Every` rows, starting with the first |
| "Random" | `Rows` rows drawn at random |

`Rows` is a maximum: a table with fewer rows comes through whole.

"Top N" and "Bottom N" depend on the order of the table, so they are mostly useful after a Sort node, e.g. to get the 20 strongest partners. "Every Nth" thins out the whole table evenly instead of taking one end of it, which keeps the overall shape of the data. A scatter plot of 165,000 neurons thinned this way still looks the same, just less crowded.

"Random" is the one to use if you want to check that a pattern is real and not an artefact of how the table happens to be ordered. The sampled rows keep their original order.

## Seed

`Seed` only appears in "Random" mode. The same seed always draws the same rows, so a figure made from a random sample can be reproduced. Change it to get a different draw.
