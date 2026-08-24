> [!WARNING] neuPrint-only
> NeuPrint is the only backend that provides ROI completness.

## Primary ROIs

ROI lists can be nested: for example, the MaleCNS has:
- super ROIS such as "central brain" or "optic lobe"
- primary ROIs such as "AL(R)" or "ME(R)"
- sub-ROIs such as "AL-DA1(R)" or "ME-C1(R)"

By default, this node shows only the primary ROIs, which are the ones that tile the volume without overlapping. Switching `Primary regions only` off will show all ROIs.

```coda-params
neuron.roiCompleteness: primaryOnly
```
