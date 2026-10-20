Fit Model Passive adjusts the passive membrane of a [Compartment Model](#biophys:model) until it reproduces a current-clamp recording from [Load Recording](#biophys:loadRecording). It returns the fitted model, the fitted values with their standard errors, and the recorded and fitted traces side by side.

Each sweep is simulated with the current that was actually injected into the cell: the recorded command is played into the model's soma sample by sample. The model's voltage at the soma is then compared with the recorded voltage, and the parameters are adjusted by least squares (Levenberg–Marquardt) until the difference stops shrinking.

## What is fitted

| Parameter   | Unit   | What it is                                                             |
| ----------- | ------ | ---------------------------------------------------------------------- |
| Rm          | Ω·cm²  | specific membrane resistance                                           |
| Cm          | µF/cm² | specific membrane capacitance                                          |
| Ra          | Ω·cm   | axial resistivity                                                      |
| E leak      | mV     | reversal potential of the leak, which is the passive resting potential |
| Area factor | ×      | how much more membrane the cell has than the reconstruction            |
| Seal        | nS     | the recording electrode's seal: a leak at the soma to 0 mV             |

```coda-params
biophys:fit: fitRm, fitCm, fitRa, fitELeak, fitArea, fitSeal, seal
```

An unticked parameter stays at the model's value. The fit only changes the membrane: the compartments, and therefore the morphology, stay the ones the model was built with.

The area factor accounts for membrane the reconstruction misses, such as spines and fine branches. It scales capacitance and leak together, so the model only ever sees Cm × area and area ÷ Rm. That means Cm, Rm and the area factor can't all be fitted at once. The usual approach is to fix Cm at 1 µF/cm² and fit the area factor instead.

### The seal

A whole-cell recording adds a leak of its own: current escapes through the seal between the electrode and the membrane, and the bath it escapes to is at 0 mV. The cell does not have this leak, but the recording does. Left out of the model, the fit explains it with the cell's membrane: `E leak` comes out depolarised and `Rm` low (Gouwens & Wilson 2009).

`Seal (nS)` puts it in, at the soma. It is 0 by default, which leaves it out. Set it if you know your seal conductance, or tick `Fit Seal` to fit it, starting from that value; Günay et al. (2015) fitted 0.2 nS on a *Drosophila* motoneuron. The seal belongs to the electrode, so the fitted `Model` leaves it behind: the model you simulate is the cell without the electrode.

> [!NOTE] A model with channels is fitted without them
> The fit treats the cell as passive and leaves the model's voltage-gated channels out. The fitted model keeps the channels at their densities, so a fitted area factor gives them more membrane to sit on. The fit describes the membrane where those channels are closed, so fit hyperpolarising or small sweeps.

## The recording

```coda-params
biophys:fit: voltage, command, crop, windowStart, windowEnd, skipAfterSteps
```

`Voltage` and `Current` list the columns in a voltage unit (mV or V) and a current unit (pA or nA). If the recording has only one of each, it's used without asking. If it has several, the card asks you to pick. A Clampex file often records the amplifier's current monitor in pA next to the command, for example, and the command is the one to fit: the monitor is noisy, and it makes every sweep a simulation of its own. If a column has no unit, or a wrong one, set `Voltage unit` or `Current unit` under the advanced controls; the picker then lists every column.

Choose which sweeps to fit in Load Recording. The fit uses every sweep that reaches it.

The model replays each sweep's command from its first sample, starting from where a passive cell settles under that sample's current. A holding current is therefore already in place when the sweep begins, as it was in the recording, with no settling transient.

`Fit window` restricts the comparison to part of each sweep; the replay still covers the whole sweep. `Skip after steps` leaves out a short stretch after every step in the injected current, where recordings carry the bridge-balance and capacitance-compensation artefact. If the current changes at nearly every sample, it is a measured current rather than a command, there are no steps to skip after, and the card says so.

If you crop in Load Recording, start the crop where the current has been constant for a while, since the model assumes the cell had settled there. If you're not sure, leave the sweep whole and use `Fit window` instead.

## Reading the result

The `Parameters` table has a row per parameter: the fitted value, its standard error, the starting value, and whether it was free or ended on a bound. A standard error says how far the parameter could move before the fit got noticeably worse. A large one means the recording says little about that parameter. A recording from the soma typically constrains Rm and E leak well and Ra poorly.

The card warns when a parameter ends on its bound, is poorly constrained, or trades off against another one. A parameter on its bound is not a measurement: the data wanted a value outside the allowed range. If Ra or Cm ends on a bound, the reconstruction's geometry probably doesn't match the recorded cell.

After a run, the card says how the fit ended: "Settled after 12 iterations", "Stalled", or "Stopped at" the iteration limit, with the error at the start and at the end. Expand the card (⤢) to see the recorded and fitted voltage one sweep at a time, the parameters with their errors, and how the error fell over the iterations.

`Traces` is a long table with `t`, `sweep`, `recorded` and `fitted`. Wire it into a [Line Chart](#out.lineChart) with `Series` set to `sweep` to plot it yourself. `Iterations` has the error and every parameter at each step of the fit.

Wire the fitted `Model` into [Simulate Model](#biophys:simulate) to run the fitted cell.

## Applying the fit

`Apply` on the card's foot, or `Apply to Compartment Model` in the expanded view, writes the fitted values into the Compartment Model wired into `Model`: the preset becomes "Custom" with the fitted `Rm`, `Cm`, `Ra` and `E leak`, and the fitted area factor becomes its `Area factor`. The area factor the fit reports is that same number, the card's own, so a model built at 1.5 starts the fit at 1.5. Applying is one edit, so one undo takes it back. The button says "Applied" once the card holds the fitted values. It only works when `Model` is wired straight from a Compartment Model, since through anything else it isn't clear which card the values belong to, and only on a current result: after you change the fit or its inputs, run it again first.

The card rebuilt from the applied values can differ a little from the fitted `Model`: it is cut into compartments again for the new membrane, and a channel placed as a total per cell keeps its total, where on the fitted `Model` it grew with the area.

> [!NOTE] Applying makes the fit out of date
> The Compartment Model is the fit's input, so after applying, the fit needs running again. Run it and it starts at the fitted values, and settles almost at once.

Unlike the fitted `Model`, which keeps the compartments the model was cut into, an applied model is rebuilt, so `d_lambda` cuts it for the new membrane.

## Speed

Sweeps whose currents are scaled copies of one another, such as the steps of an I–V protocol, share one simulation, because a passive cell responds linearly. Each step of the fit runs one simulation per free parameter, spread over your computer's cores.

```coda-params
biophys:fit: dt, maxIterations
```

The fit uses a `dt` of 0.1 ms by default, coarser than Simulate Model's, because a passive membrane changes slowly. A finer step costs proportionally more time and rarely changes the answer.
