Load Recording reads an electrophysiology recording from your computer and turns it into a table of its sweeps. It reads ABF files, the format Clampex (pCLAMP 10 and later) saves.

Choose the file with the button on the node. The file stays in this browser rather than in the workflow, so if you share the workflow, your colleague has to choose the same file again.

## The table

The output is one long table with a row per sample per sweep:

| Column           | Contents                                                       |
| ---------------- | -------------------------------------------------------------- |
| `t`              | time within the sweep, in ms                                   |
| `sweep`          | the sweep, counted from 1 as Clampex counts them               |
| one per channel  | each recorded channel, in its own unit (such as `mV` or `pA`) |
| one per command  | each command output's waveform, rebuilt from the protocol     |

To draw it, wire it into a [Line Chart](#out.lineChart) with `Series` set to `sweep`: you get a line per sweep. To compare it with a simulation, use [Combine Traces](#biophys:combineTraces).

The command waveform is not stored as samples in an ABF file. It is described by the protocol's epoch table (a level and a duration for each epoch, plus how they change from sweep to sweep), and Load Recording rebuilds it the same way pyABF does. If the protocol played its waveform from a separate stimulus file, that file isn't in the recording, so there is no command column and the card says so.

## Choosing what to keep

```coda-params
biophys:loadRecording: channels, sweeps, crop, windowStart, windowEnd, rezero, downsample
```

`Sweeps` takes single sweeps and ranges, such as `1-3, 7`. Leave it empty for every sweep.

`Crop` keeps a window of each sweep, from `From` up to, but not including, `To`. Tick `Start at 0` to count time from the start of the window rather than the start of the sweep.

`Downsample` averages each block of that many samples into one, timed at the middle of the block: 10 turns a 10 kHz recording into 1 kHz. Averaging keeps noise from folding into the trace, but it blunts a spike that is narrower than the block, so keep the factor small if you want to look at spike shapes.

> [!NOTE] Older ABF files
> ABF1 files, saved by pCLAMP 9 and earlier, are not read yet. Clampfit can open one and save it as ABF2.
