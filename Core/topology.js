/**
 * topology.js
 * Update: Added support for 'SWITCH Instant' command.
 */

export const EType = {
    RC_GROUND: 0,
    RL_SERIES: 1,
    TR_LINE: 2,
    BRANCH_START: 3,
    BRANCH_END: 4
};

export class CircuitCompiler {
    constructor() {
        this.nodes = [];
        this.outputRequests = [];
        this.dt = 1e-9;
        this.t_end = 100e-9;
        this.globalResolution = 1e-9; 
        this.trLineResolution = null; 
        this.blocks = []; 
    }

    compile(scriptText) {
        this.nodes = [];
        this.outputRequests = [];
        this.blocks = [];
        
        const usedLabels = new Set();
        const lines = scriptText.split('\n');
        let nodeId = 0;

        // Branch handling (limited Topbranch support)
        let mainBranchStarted = false;
        const pendingTopbranches = [];
        let activeTopbranchAnchor = null;

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('!')) continue;

            const parts = line.split(/\s+/);
            const cmd = parts[0].toUpperCase();

            const currentBlockStart = nodeId;
            let currentBlockType = null;

            // --- Branch markers ---
            if (cmd === 'BRANCH') {
                if (!mainBranchStarted) {
                    mainBranchStarted = true;
                }
                else if (pendingTopbranches.length > 0) {
                    activeTopbranchAnchor = pendingTopbranches.shift();
                }
                continue;
            }

            if (cmd === 'TOPBRANCH') {
                // Record the last real series element as the anchor.
                let anchorIndex = -1;
                for (let i = this.nodes.length - 1; i >= 0; i--) {
                    const n = this.nodes[i];
                    if (n.type === EType.RL_SERIES && !n.isPhantom) {
                        anchorIndex = i;
                        break;
                    }
                }

                if (anchorIndex === -1) {
                    throw new Error('Topbranch requires a previous series element to attach to.');
                }

                pendingTopbranches.push(anchorIndex);
                continue;
            }

            // If we are inside a pending Topbranch definition, combine the
            // first encountered element in parallel with its anchor and skip
            // normal node creation. This is a limited approximation that
            // treats the child branch as a direct shunt between the anchor
            // nodes.
            if (activeTopbranchAnchor !== null) {
                const anchorNode = this.nodes[activeTopbranchAnchor];

                const combineParallel = (a, b) => {
                    if (a === 0 || b === 0) return 0;
                    if (!isFinite(a)) return b;
                    if (!isFinite(b)) return a;
                    return 1.0 / (1.0 / a + 1.0 / b);
                };

                if (cmd.startsWith('RCG')) {
                    const branchR = parseFloat(parts[1]);
                    const branchC = parts.length > 2 ? parseFloat(parts[2]) : 0.0;
                    anchorNode.R = combineParallel(anchorNode.R, branchR);
                    anchorNode.L = combineParallel(anchorNode.L, 0);
                    anchorNode.C += branchC; // accumulate shunt capacitance
                    activeTopbranchAnchor = null;
                    continue;
                }

                if (cmd.startsWith('RLS')) {
                    const branchR = parseFloat(parts[1]);
                    const branchL = parts.length > 2 ? parseFloat(parts[2]) : 0.0;
                    anchorNode.R = combineParallel(anchorNode.R, branchR);
                    anchorNode.L = combineParallel(anchorNode.L, branchL);
                    activeTopbranchAnchor = null;
                    continue;
                }
            }

            if (cmd.startsWith('TIME-STEP')) {
                this.dt = parseFloat(parts[1]);
            }
            else if (cmd.startsWith('END-TIME')) {
                this.t_end = parseFloat(parts[1]);
            }
            else if (cmd.startsWith('RESOLUTION-TIME')) {
                this.globalResolution = parseFloat(parts[1]);
            }
            else if (cmd.startsWith('TRLINE-RESOLUTION')) {
                this.trLineResolution = parseFloat(parts[1]);
            }

            // RCGround
            else if (cmd.startsWith('RCG')) {
                currentBlockType = 'RCG';
                const R = parseFloat(parts[1]);
                const C = parts.length > 2 ? parseFloat(parts[2]) : 0.0;
                
                const G = (R === 0) ? 1e9 : 1.0/R;

                this.nodes.push({
                    id: nodeId++, type: EType.RC_GROUND,
                    R: 0, L: 0, G: G, C: C, isPhantom: false
                });
                
                this.nodes.push({
                    id: nodeId++, type: EType.RL_SERIES,
                    R: 1e-7, L: 1e-11, G: 0, C: 0, isPhantom: true
                });
            }

            // RLSeries
            else if (cmd.startsWith('RLS')) {
                currentBlockType = 'RLS';
                const R = parseFloat(parts[1]);
                const L = parts.length > 2 ? parseFloat(parts[2]) : 0.0;

                this.nodes.push({
                    id: nodeId++, type: EType.RC_GROUND,
                    R: 0, L: 0, G: 0, C: 0, isPhantom: true
                });
                this.nodes.push({
                    id: nodeId++, type: EType.RL_SERIES,
                    R: R, L: L, G: 0, C: 0, isPhantom: false
                });
            }

            // --- SWITCH (New) ---
            // Format:
            //   SWITCH Instant R_open R_close T_switch
            //   SWITCH Exponential R1 R2 k_decay T_switch
            else if (cmd.startsWith('SWITCH')) {
                currentBlockType = 'SWITCH';
                const type = parts[1].toUpperCase(); // INSTANT | EXPONENTIAL

                let rOpen, rClose, tSwitch, kDecay;
                if (type === 'INSTANT') {
                    rOpen = parseFloat(parts[2]);
                    rClose = parseFloat(parts[3]);
                    tSwitch = parseFloat(parts[4]);
                }
                else if (type === 'EXPONENTIAL') {
                    rOpen = parseFloat(parts[2]);
                    rClose = parseFloat(parts[3]);
                    kDecay = parseFloat(parts[4]);
                    tSwitch = parseFloat(parts[5]);
                }
                else {
                    throw new Error(`Unknown SWITCH type: ${type}`);
                }

                // A Switch is an RLSeries where R varies.
                // It needs the standard Phantom RCG preamble.
                
                // 1. Phantom RCG
                this.nodes.push({
                    id: nodeId++, type: EType.RC_GROUND,
                    R: 0, L: 0, G: 0, C: 0, isPhantom: true
                });

                // 2. Real RLSeries (Variable Resistor)
                // Initialize with R_open (t=0 state)
                // L is assumed 0 (ideal switch) or small parasitic
                const initialR = (type === 'EXPONENTIAL') ? (rOpen + rClose) : rOpen;
                this.nodes.push({
                    id: nodeId++, type: EType.RL_SERIES,
                    R: initialR, L: 1e-9, // 1nH parasitic inductance
                    G: 0, C: 0,
                    isPhantom: false,
                    isSwitch: true,
                    switchType: type,
                    switchParams: { rOpen, rClose, tSwitch, kDecay }
                });
            }

            // TRLine
            else if (cmd.startsWith('TRL')) {
                currentBlockType = 'TRL';
                const delay = parseFloat(parts[2]);
                const Z = parseFloat(parts[3]);
                
                let resolution;
                if (parts.length > 4 && !isNaN(parseFloat(parts[4]))) {
                    resolution = parseFloat(parts[4]);
                } else if (this.trLineResolution !== null) {
                    resolution = this.trLineResolution;
                } else {
                    resolution = this.globalResolution / 2.0;
                }

                const segments = Math.max(1, Math.round(delay / resolution));
                const L_seg = (Z * delay) / segments;
                const C_seg = (delay / Z) / segments;
                
                // const R_seg = 1e-4 * Z; 

                for(let i=0; i<segments; i++) {
                    this.nodes.push({
                        id: nodeId++, type: EType.RC_GROUND,
                        R: 0, L: 0, G: 0, C: C_seg, isPhantom: false
                    });
                    
                    this.nodes.push({
                        id: nodeId++, type: EType.RL_SERIES,
                        R: 1e-7, L: 0, G: 0, C: 0, isPhantom: true
                    });

                    this.nodes.push({
                        id: nodeId++, type: EType.RC_GROUND,
                        R: 0, L: 0, 
                        G: 1e-9, 
                        C: 0, 
                        isPhantom: true
                    });

                    this.nodes.push({
                        id: nodeId++, type: EType.RL_SERIES,
                        R: 0, L: L_seg, G: 0, C: 0, isPhantom: false
                    });
                }
            }

            if (currentBlockType) {
                this.blocks.push({
                    type: currentBlockType,
                    startNode: currentBlockStart,
                    endNode: nodeId - 1
                });
            }

            else if (cmd.startsWith('INITIAL')) {
                const val = parseFloat(parts[2]);
                const targetBlock = this.blocks[this.blocks.length - 1];
                if (targetBlock) {
                    if (targetBlock.type === 'TRL') {
                        for(let i=targetBlock.startNode; i<=targetBlock.endNode; i++) {
                            if (this.nodes[i].initialV === undefined) { 
                                this.nodes[i].initialV = val;
                            }
                        }
                    } else {
                        for(let i=targetBlock.endNode; i>=targetBlock.startNode; i--) {
                            if (this.nodes[i].type === EType.RC_GROUND && !this.nodes[i].isPhantom) {
                                this.nodes[i].initialV = val;
                                let k = i + 1;
                                while(k < this.nodes.length && this.nodes[k].isPhantom) {
                                    this.nodes[k].initialV = val;
                                    k++;
                                }
                                break;
                            }
                        }
                    }
                }
            }

            else if (cmd.startsWith('TXT')) {
                const target = parts[1];
                const targetBlock = this.blocks[this.blocks.length - 1];
                let probeIndex = this.nodes.length - 1; 

                if (targetBlock) {
                    if (target.startsWith('I')) {
                        if (targetBlock.startNode > 0) {
                            probeIndex = targetBlock.startNode - 1;
                        } else {
                            probeIndex = 0;
                        }
                    } 
                    else if (target.startsWith('V')) {
                        for(let k=targetBlock.endNode; k>=targetBlock.startNode; k--) {
                            if (!this.nodes[k].isPhantom) {
                                probeIndex = k;
                                break;
                            }
                        }
                    }
                }

                let uniqueLabel = target;
                let counter = 1;
                while (usedLabels.has(uniqueLabel)) {
                    uniqueLabel = `${target}_${counter}`;
                    counter++;
                }
                usedLabels.add(uniqueLabel);

                this.outputRequests.push({
                    type: target.startsWith('V') ? 'voltage' : 'current',
                    nodeIndex: Math.max(0, probeIndex),
                    label: uniqueLabel
                });
            }
        }

        return {
            nodes: this.nodes,
            outputRequests: this.outputRequests,
            dt: this.dt,
            t_end: this.t_end
        };
    }
}