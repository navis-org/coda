## What ROI Completeness does

ROI Completeness tells you how completely each region of a dataset has been reconstructed: for each region, how many of its pre- and postsynapses belong to traced neurons, out of all synapses in that region. All it needs is a Dataset.

This is worth checking before you interpret connectivity: in the hemibrain, for example, 91% of presynapses are assigned to reconstructed neurons but only 39% of postsynapses, and completeness varies a lot from region to region.

> [!WARNING] neuPrint only
> neuPrint is the only backend that provides ROI completeness.

## Output

One row per region:

| Column                                 | What it is                                             |
| -------------------------------------- | ------------------------------------------------------ |
| `roi`                                  | the region's name                                      |
| `pre`, `post`                          | pre- and postsynapses that belong to traced neurons    |
| `totalPre`, `totalPost`                | all pre- and postsynapses in the region                |
| `preCompleteness`, `postCompleteness`  | the fraction of the two (0 to 1)                       |
| `primary`                              | whether the region is a primary region (see below)     |

## Primary regions

Region lists are nested. The male CNS, for example, has:

- super-regions such as "central brain" or "optic lobe"
- primary regions such as `AL(R)` or `ME(R)`
- sub-regions such as `AL-DA1(R)` or `ME-C1(R)`

By default this node returns only the primary regions, i.e. the ones that tile the volume without overlapping. Switch `Primary regions only` off to get all of them.

```coda-params
neuron.roiCompleteness: primaryOnly
```

If you do, keep in mind that each synapse is then counted in several rows, so adding up the full table gives you far too many synapses (about 2.2 times the true number for the hemibrain).
