Load Recording reads an electrophysiology recording from your computer and turns it into a table of its sweeps. It reads ABF files, the format Clampex saves (ABF1 from pCLAMP 9 and earlier, ABF2 from pCLAMP 10 on), and NWB files, the format DANDI and the Allen Institute publish intracellular recordings in.

Choose the file with the button on the node. The file stays in this browser rather than in the workflow, so if you share the workflow, your colleague has to choose the same file again.

## The table

The output is one long table with a row per sample per sweep:

| Column           | Contents                                                       |
| ---------------- | -------------------------------------------------------------- |
| `t`              | time within the sweep, in ms                                   |
| `sweep`          | the sweep: counted from 1 as Clampex counts them, or an NWB file's own sweep number |
| one per channel  | each recorded channel, in its own unit (such as `mV` or `pA`) |
| one per command  | each command output's waveform: rebuilt from the protocol (ABF) or as stored (NWB) |

To draw it, wire it into a [Line Chart](#out.lineChart) with `Series` set to `sweep`: you get a line per sweep. To compare it with a simulation, use [Combine Traces](#biophys:combineTraces).

The command waveform is not stored as samples in an ABF file. It is described by the protocol's epoch table (a level and a duration for each epoch, plus how they change from sweep to sweep), and Load Recording rebuilds it the same way pyABF does. If the protocol played its waveform from a separate stimulus file, that file isn't in the recording, so there is no command column and the card says so.

## NWB files

An NWB file usually holds several protocols: an Allen Institute file has a search for rheobase, long and short square pulses and a ramp, recorded at different rates and lengths, with voltage-clamp seal tests around them. Load Recording reads one at a time. Pick it with `Protocol`; the card opens on the first. To read two protocols of one file, use two Load Recording cards with the same file.

A protocol here is the set of sweeps that share a clamp mode, a sample rate and a length. It is named after the stimulus its sweeps were recorded with. Where they share no name, because the file gives every sweep its own description, it is named by its shape instead, such as "current clamp, 14 sweeps × 4 s at 10 kHz".

Each sweep has a response and the stimulus that drove it. A current-clamp sweep gives a `Vm` column in mV and an `Icmd` column in pA; a voltage-clamp sweep gives `Im` in pA and `Vcmd` in mV. NWB stores volts and amperes, so the values are converted. If the file numbers no sweeps, responses and stimuli are paired in the order the file lists them, and the card says so; each protocol's sweeps are then counted from 1. A stimulus recorded at a different rate or length from its response is left unpaired rather than drawn out of step with it, and the card counts those sweeps. Series timed by timestamps rather than a sample rate are not read.

Switching `Protocol` on the card clears `Channels` and `Sweeps`, since another protocol names its channels and numbers its sweeps its own way.

Some NWB files were converted from other formats with the wrong units, such as millivolts stored as volts. The values then come out a thousand or a trillion times off. When a trace reads values no cell gives, the card says so; the fix is in the file, so ask whoever converted it.

## Choosing what to keep

```coda-params
biophys:loadRecording: protocol, channels, sweeps, crop, windowStart, windowEnd, rezero, downsample
```

`Sweeps` takes single sweeps and ranges, such as `1-3, 7`, by the numbers in the `sweep` column. Leave it empty for every sweep.

`Crop` keeps a window of each sweep, from `From` up to, but not including, `To`. Tick `Start at 0` to count time from the start of the window rather than the start of the sweep.

`Downsample` averages each block of that many samples into one, timed at the middle of the block: 10 turns a 10 kHz recording into 1 kHz. Averaging keeps noise from folding into the trace, but it blunts a spike that is narrower than the block, so keep the factor small if you want to look at spike shapes.
