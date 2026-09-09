> [!WARNING] neuPrint-only
> neuPrint is the only backend that provides ROI completeness.

## Primary ROIs

ROI lists nest. MaleCNS, for example, has:

- super-ROIs such as "central brain" or "optic lobe"
- primary ROIs such as "AL(R)" or "ME(R)"
- sub-ROIs such as "AL-DA1(R)" or "ME-C1(R)"

By default this node shows only the primary ROIs, the ones that tile the volume without overlapping. Switch `Primary regions only` off to show all of them.

```coda-params
neuron.roiCompleteness: primaryOnly
```
