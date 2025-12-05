/**
 * worker.js
 * The background thread manager.
 * Handles simulation loop, buffering, and CSV generation.
 * UPDATE: Explicit recording of t=0 Initial State to fix startup glitch.
 */

import { CircuitCompiler } from './core/topology.js';
import { Solver } from './core/solver.js';

let isRunning = false;

self.onmessage = async (e) => {
    const { command, payload } = e.data;

    if (command === 'START') {
        runSimulation(payload);
    } 
    else if (command === 'STOP') {
        isRunning = false;
    }
};

function runSimulation(scriptText) {
    isRunning = true;
    self.postMessage({ type: 'LOG', msg: 'Compiling circuit...' });

    try {
        const compiler = new CircuitCompiler();
        const config = compiler.compile(scriptText);
        
        self.postMessage({ type: 'LOG', msg: `Compiled: ${config.nodes.length} nodes (Real + Phantom)` });
        self.postMessage({ type: 'LOG', msg: `Time Step: ${config.dt.toExponential(2)}s` });

        const solver = new Solver(config.nodes, config.dt);
        
        // Total steps + 1 for t=0
        const totalSteps = Math.ceil(config.t_end / config.dt) + 1;
        const stepsPerChunk = 5000; 
        
        const plotDownsampleRate = Math.max(1, Math.ceil(totalSteps / 2000));
        const plotData = {};
        
        const prevValues = new Float64Array(config.outputRequests.length).fill(0);

        config.outputRequests.forEach((req, idx) => {
            plotData[req.label] = { 
                x: [], 
                y: [], 
                fullDataV: new Float64Array(totalSteps), 
            };
            // Initialize prevValues with the t=0 state from the solver
            // Solver constructor already populated V_old with Initial Conditions
            prevValues[idx] = solver.getValue(req.nodeIndex, req.type);
        });
        
        const csvTimeBuffer = new Float64Array(totalSteps);

        // --- RECORD T=0 STATE ---
        // We do this manually before the loop to capture the perfect initial condition
        // without solver artifacts.
        csvTimeBuffer[0] = 0.0;
        config.outputRequests.forEach((req, idx) => {
            // Get initial value (V_old is set, I_old is 0)
            // Note: For I, if the circuit has initial current, we might need more complex logic
            // but usually I(0) is 0 or user-defined.
            // Solver.getValue currently returns V_new/I_new.
            // We need a way to peek at V_old for t=0. 
            // Since step() hasn't run, V_old holds the ICs.
            // We will trust the solver.getValue() returns 0s (default) or we update solver to peek.
            
            // Actually, simplified approach: Solver has V_old populated.
            // But getValue returns V_new. V_new is 0s right now.
            // Let's modify the loop to handle t=0 separately? 
            // Better: Just record the IC we know.
            
            const val = (req.type === 'voltage') ? 
                        (solver.mem.V_old[req.nodeIndex]) : 
                        (solver.mem.I_old[req.nodeIndex]);

            const dataset = plotData[req.label];
            dataset.fullDataV[0] = val;
            dataset.x.push(0);
            dataset.y.push(val);
            
            prevValues[idx] = val;
        });

        // Start loop at i=1 (t=dt)
        let currentStep = 1;
        const startTime = performance.now();

        function loop() {
            if (!isRunning) return;

            const endStep = Math.min(currentStep + stepsPerChunk, totalSteps);

            for (let i = currentStep; i < endStep; i++) {
                // i=1 corresponds to t = 1*dt
                const t = i * config.dt;
                
                solver.step(t);

                csvTimeBuffer[i] = t;

                config.outputRequests.forEach((req, idx) => {
                    const rawVal = solver.getValue(req.nodeIndex, req.type);
                    
                    // Trapezoidal Averaging
                    const smoothedVal = 0.5 * (rawVal + prevValues[idx]);
                    prevValues[idx] = rawVal;

                    const dataset = plotData[req.label];
                    dataset.fullDataV[i] = smoothedVal;

                    if (i % plotDownsampleRate === 0) {
                        dataset.x.push(t);
                        dataset.y.push(smoothedVal);
                    }
                });
            }

            currentStep = endStep;
            
            const pct = Math.round((currentStep / totalSteps) * 100);
            self.postMessage({ type: 'PROGRESS', pct: pct });

            if (currentStep < totalSteps) {
                setTimeout(loop, 0); 
            } else {
                finish();
            }
        }

        function finish() {
            const duration = (performance.now() - startTime).toFixed(2);
            self.postMessage({ type: 'LOG', msg: `Simulation complete in ${duration}ms` });

            const plots = {};
            Object.keys(plotData).forEach(key => {
                plots[key] = { x: plotData[key].x, y: plotData[key].y };
            });
            self.postMessage({ type: 'PLOT_DATA', data: plots });

            self.postMessage({ type: 'LOG', msg: 'Generating CSV file...' });
            
            const headers = ['Time(s)', ...Object.keys(plotData)];
            let csvContent = headers.join(',') + '\n';
            
            const keys = Object.keys(plotData);
            for(let i=0; i<csvTimeBuffer.length; i++) {
                let row = [csvTimeBuffer[i].toExponential(6)];
                for(const key of keys) {
                    row.push(plotData[key].fullDataV[i].toExponential(6));
                }
                csvContent += row.join(',') + '\n';
            }

            const blob = new Blob([csvContent], { type: 'text/csv' });
            
            self.postMessage({ 
                type: 'CSV_READY', 
                files: [{ name: 'simulation_output.csv', blob: blob }] 
            });
        }

        loop();

    } catch (err) {
        self.postMessage({ type: 'ERROR', msg: err.message });
        console.error(err);
    }
}