# WebScreamer: Pulsed Power Simulator

WebScreamer is a browser-based reimplementation of Sandia's SCREAMER pulsed-power circuit simulator. It lets you author a simple text-based "input deck" describing lumped elements, transmission lines, switches, time steps, and probe points, then runs the transient solution entirely inside a Web Worker while the main page renders Plotly charts and prepares a CSV export.

## Project layout

- `index.html` defines the single-page UI with an input editor, run/download buttons, and a Plotly plot/log pane.
- `app.js` is the front-end controller: it launches the worker, forwards the input deck, streams log/progress events, and renders plots/export links.
- `worker.js` hosts the simulation loop so the UI stays responsive. It compiles the deck, marches through time in chunks, down-samples data for plotting, and emits a CSV blob when finished.
- `core/topology.js` parses the input deck into a list of nodes (resistors/inductors/capacitors/switches/transmission lines) plus requested output probes and timing parameters.
- `core/solver.js` advances the solution using a banded pentadiagonal solve each time step, updating switch resistances as time-dependent elements.
- `core/matrix.js` holds the dense Float64Array buffers for the solver and exposes reset/swapping helpers.

## Running locally

Because `app.js` and `worker.js` are ES modules, open the app via a local web server rather than a `file://` URL. The simplest option with Python installed:

```bash
cd WebScreamer
python -m http.server 8000
```

Then browse to <http://localhost:8000/> and click **RUN SIMULATION**. Use the **Download CSV** button after a run to save the recorded signals.

## Input deck quick reference

The editor accepts one command per line; lines starting with `!` are comments. The interpreter is case-insensitive. Key statements include:

- **Simulation timing**: `Time-step <dt_seconds>`, `End-time <t_seconds>`, optional `Resolution-time <seconds>` for transmission-line defaults, and `TRLine-Resolution <seconds>` to override.
- **Elements** (each creates a new block in series order):
  - `RCGround <R_ohms> [C_farads]` — resistor and optional capacitor to ground. A large R approximates open-circuit; R=0 becomes a near-short.
  - `RLSeries <R_ohms> [L_henries]` — series resistor/inductor segment.
  - `SWITCH Instant <R_open> <R_close> <t_switch>` — ideal time-controlled switch implemented as a variable resistor with small parasitic L.
  - `TRLine Linear <delay_seconds> <Z_ohms> [resolution]` — lossless transmission line subdivided into LC sections based on delay and resolution.
- **Initial conditions**: `Initial <target_label> <volts>` assigns starting voltage to the most recent block (for TRLine, every section).
- **Probes**: `TXT VC1` requests a voltage trace for the most recent block; `TXT IIN` records current entering the block (multiple labels auto-suffix to stay unique).

## Workflow and data products

1. The main thread sends the input deck to the worker and resets the log/plot state.
2. The worker compiles nodes and output requests, then calculates the required steps from `Time-step` and `End-time`.
3. During the run it records the initial `t=0` state, advances the solver in chunks, trapezoid-averages values for smooth plots, and down-samples for responsiveness.
4. When finished, it posts plot data back to the UI and assembles a CSV with `Time(s)` plus each requested signal for download.

## Examples

Use the **Load Example** dropdown to insert starter decks:

- **Simple LCR** discharges a charged capacitor through an inductor and load resistor.
- **Transmission Line** models a matched line with high-resolution segmentation, illustrating TRLine behavior.

You can modify these templates or paste your own decks to explore different pulsed-power topologies.
