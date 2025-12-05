/**
 * matrix.js
 * Manages the linear memory arrays for the simulation.
 * Replaces Fortran COMMON blocks.
 */

export class SimulationMemory {
    constructor(totalNodes) {
        // N is the number of spatial nodes.
        // The matrix size is 2*N because we solve for V and I at every node.
        this.N_nodes = totalNodes;
        this.matrixSize = totalNodes * 2;

        // --- The Matrix (Pentadiagonal Banded Storage) ---
        // SCREAMER solves Ax = b. 
        // A is pentadiagonal. We store diagonals as flat arrays.
        // Indices correspond to equation number (0 to 2N-1).
        
        // Main Diagonal A(i,i)
        this.diag = new Float64Array(this.matrixSize);
        
        // Upper Diagonal 1 A(i, i+1)
        this.upper1 = new Float64Array(this.matrixSize);
        
        // Lower Diagonal 1 A(i, i-1)
        this.lower1 = new Float64Array(this.matrixSize);
        
        // Upper Diagonal 2 A(i, i+2) - From Row Flipping
        this.upper2 = new Float64Array(this.matrixSize);
        
        // Lower Diagonal 2 A(i, i-2) - From Row Flipping
        this.lower2 = new Float64Array(this.matrixSize);

        // --- State Vectors (Voltage and Current) ---
        // We use double buffering to store Previous (Old) and Current (New) states.
        // V[0] is Node 1 Voltage, I[0] is Node 1 Current (Branch flow).
        this.V_old = new Float64Array(this.N_nodes);
        this.I_old = new Float64Array(this.N_nodes);
        
        this.V_new = new Float64Array(this.N_nodes);
        this.I_new = new Float64Array(this.N_nodes);

        // --- Solver Auxiliary Vectors ---
        this.b_vector = new Float64Array(this.matrixSize); // RHS
        
        // Branch Couplings (Sparse elements far off-diagonal)
        // Stores { row: index, col: index, val: number }
        // Used when branches connect back to parents.
        this.sparseElements = [];
    }

    /**
     * Swaps the time step buffers.
     * New becomes Old. Old becomes recycled buffer.
     * This is a zero-copy pointer swap.
     */
    swapTimeSteps() {
        let tempV = this.V_old;
        this.V_old = this.V_new;
        this.V_new = tempV;

        let tempI = this.I_old;
        this.I_old = this.I_new;
        this.I_new = tempI;
    }

    /**
     * Resets matrix to zero before repopulating coefficients.
     * Essential because coefficients change if dt changes or non-linear elements update.
     */
    clearMatrix() {
        this.diag.fill(0);
        this.upper1.fill(0);
        this.lower1.fill(0);
        this.upper2.fill(0);
        this.lower2.fill(0);
        this.b_vector.fill(0);
        this.sparseElements = [];
    }
}