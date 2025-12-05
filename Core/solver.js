/**
 * solver.js
 * Added physics update loop for Switched elements.
 */

import { SimulationMemory } from './matrix.js';
import { EType } from './topology.js';

export class Solver {
    constructor(nodes, dt) {
        this.nodes = nodes;
        this.dt = dt;
        this.mem = new SimulationMemory(nodes.length);
        this.THETA = 0.55; 
        
        for(let i=0; i<nodes.length; i++) {
            if(nodes[i].initialV) {
                this.mem.V_old[i] = nodes[i].initialV;
            }
        }
    }

    step(time) {
        const N = this.mem.N_nodes;
        
        // --- PHYSICS UPDATE ---
        // Update variable elements before building matrix
        for (let i = 0; i < N; i++) {
            const node = this.nodes[i];
            if (node.isSwitch) {
                if (node.switchType === 'INSTANT') {
                    const p = node.switchParams;
                    node.R = (time < p.tSwitch) ? p.rOpen : p.rClose;
                }
            }
        }

        // --- MATRIX POPULATION ---
        this.mem.clearMatrix();

        const diag = this.mem.diag;
        const upper1 = this.mem.upper1;
        const lower1 = this.mem.lower1;
        const upper2 = this.mem.upper2;
        const lower2 = this.mem.lower2;
        const rhs = this.mem.b_vector;

        const theta = this.THETA;
        const one_minus_theta = 1.0 - theta;

        for (let i = 0; i < N; i++) {
            const node = this.nodes[i];
            
            let rV, rI;
            if (node.type === EType.RC_GROUND) {
                rV = 2 * i + 1; 
                rI = 2 * i;     
            } else {
                rV = 2 * i;     
                rI = 2 * i + 1; 
            }

            const AV = theta * node.G + node.C / this.dt;
            const AI = theta * node.R + node.L / this.dt;

            const v_old = this.mem.V_old[i];
            const i_old = this.mem.I_old[i];
            const i_prev_old = (i > 0) ? this.mem.I_old[i-1] : 0;
            const v_next_old = (i < N-1) ? this.mem.V_old[i+1] : 0;

            // Current Equation
            this.setMatrixVal(rI, 2*i, AV); 
            this.setMatrixVal(rI, 2*i+1, theta);
            if (i > 0) this.setMatrixVal(rI, 2*i-1, -theta);

            const BV = one_minus_theta*(i_prev_old - i_old) + (node.C/this.dt - one_minus_theta*node.G)*v_old;
            rhs[rI] = BV;

            // Voltage Equation
            if (i === N - 1) {
                this.setMatrixVal(rV, 2*i+1, 1.0);
                rhs[rV] = 0.0;
            } else {
                this.setMatrixVal(rV, 2*i, theta);
                this.setMatrixVal(rV, 2*i+1, -AI);
                this.setMatrixVal(rV, 2*i+2, -theta);

                const BI = one_minus_theta*(v_next_old - v_old) - (node.L/this.dt - one_minus_theta*node.R)*i_old;
                rhs[rV] = BI;
            }
        }

        this.solvePentadiagonal();

        for(let i=0; i<N; i++) {
            this.mem.V_new[i] = rhs[2*i];
            this.mem.I_new[i] = rhs[2*i+1];
        }
        this.mem.swapTimeSteps();
    }

    setMatrixVal(row, col, val) {
        if (col === row) this.mem.diag[row] = val;
        else if (col === row + 1) this.mem.upper1[row] = val;
        else if (col === row - 1) this.mem.lower1[row] = val;
        else if (col === row + 2) this.mem.upper2[row] = val;
        else if (col === row - 2) this.mem.lower2[row] = val;
    }

    solvePentadiagonal() {
        const n = this.mem.matrixSize;
        const d = this.mem.diag;
        const u1 = this.mem.upper1;
        const l1 = this.mem.lower1;
        const u2 = this.mem.upper2;
        const l2 = this.mem.lower2;
        const b = this.mem.b_vector;

        for (let i = 0; i < n - 1; i++) {
            if (Math.abs(d[i]) < 1e-25) d[i] = 1e-25;

            if (l1[i+1] !== 0) {
                const f = l1[i+1] / d[i];
                d[i+1] -= f * u1[i];
                u1[i+1] -= f * u2[i]; 
                b[i+1] -= f * b[i];
            }

            if (i < n - 2 && l2[i+2] !== 0) {
                const f = l2[i+2] / d[i];
                l1[i+2] -= f * u1[i]; 
                d[i+2] -= f * u2[i];
                b[i+2] -= f * b[i];
            }
        }

        if (Math.abs(d[n-1]) < 1e-25) d[n-1] = 1e-25;

        b[n-1] /= d[n-1];
        b[n-2] = (b[n-2] - u1[n-2]*b[n-1]) / d[n-2];

        for (let i = n - 3; i >= 0; i--) {
            b[i] = (b[i] - u1[i]*b[i+1] - u2[i]*b[i+2]) / d[i];
        }
    }

    getValue(nodeIndex, type) {
        if (type === 'voltage') return this.mem.V_new[nodeIndex];
        return this.mem.I_new[nodeIndex];
    }
}