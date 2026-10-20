Combine Traces puts traces from several tables on one time axis, side by side, so you can plot them together. The typical use is a recording from [Load Recording](#biophys:loadRecording) next to the `Traces` output of [Simulate Model](#biophys:simulate).

The tables rarely share sample times: a recording at 10 kHz and a simulation sampled every 0.1 ms, say. So each input is linearly interpolated onto one grid. Where a grid time falls outside an input's own time range, that input's columns are empty there; nothing is extrapolated. A missing value is treated as a gap, and the trace is not interpolated across it.

## The grid

```coda-params
biophys:combineTraces: inputs, grid, gridStep
```

"The first input's times" keeps the first input exactly as it was sampled. "The finest input's step" uses the step of the most finely sampled input, so nothing is lost from it. "A fixed step" is useful for a figure. The last two cover the time range of every input.

## The inputs

Each input has a tab with its own settings:

- `Time` is the column of times, in ms. Both Load Recording and Simulate Model call it `t`.
- `Sweep`, for a long table such as a recording's, is the column naming each row's sweep. Each sweep becomes a column of its own, such as `Vm_prime 3`; a single sweep keeps the plain name. Simulate Model's traces have no such column.
- `Columns` picks which columns to bring along. Leave it empty for every numeric column.
- `Shift` is added to the input's times. Use it to line up the stimulus: if the recorded current step starts at 1000 ms and the simulated one at 10 ms, give the recording a shift of −990.
- `Name` goes in front of the input's column names, as in `recorded: Vm_prime`. Left empty, a name is only added where two inputs have a column of the same name.

The recording's command column and Simulate Model's `injected` column both describe the stimulus, so they are an easy way to check the shift lines the two up.

> [!NOTE] Columns appear after a run
> When an input is spread into sweeps, the output's columns depend on which sweeps are in the data. Column pickers downstream fill in once Combine Traces has run.
