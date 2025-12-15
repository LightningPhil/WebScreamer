/**
 * app.js
 * Main UI Controller.
 */

let worker = null;
let generatedFiles = [];

const btnRun = document.getElementById('btnRun');
const btnDownload = document.getElementById('btnDownload');
const editor = document.getElementById('codeEditor');
const logArea = document.getElementById('logArea');
const statusBox = document.getElementById('statusBox');
const plotDiv = document.getElementById('plotArea');
const exampleSelector = document.getElementById('exampleSelector');

const exampleDecks = {
    trline: `! Simple WebScreamer Test
! A capacitor discharging into a resistor
Time-step 1e-9
End-time 500e-9
! High resolution for TRLine accuracy
RESOLUTION-TIME 1e-11

BRANCH
! Capacitor 100nF, charged to 100kV
RCGround 1e12 100e-9
Initial VC1 100e3

! Output request for Voltage on Cap
TXT VC1

! Transmission Line (100ns, 5 Ohms)
TRLine Linear 100e-9 5.0

! Load Resistor 5 Ohms (Matched)
! Tiny C added for physical realism
RCGround 5.0 1e-13

! Output request for Load Current
TXT IIN`,
    simple: `! Simple RC Discharge
Time-step 1e-8
End-time 250e-6

BRANCH
RCGround 1e12 200e-6
Initial VC1 80000
TXT VC1

RLSeries 0 3.1e-6

RCGround 0.31 0.0
TXT IIN`,
    topbranch: `! Topbranch Example: series branch exiting across an inductor
Time-step 2e-9
End-time 600e-9
Resolution-time 1e-9

BRANCH
! Main branch capacitor charged to 60kV
RCGround 1e12 40e-9
Initial VC1 60000
TXT VC1

! Series inductor that feeds the top branch attachment
RLSeries 0.05 15e-9
Topbranch

! Downstream load on main branch
RCGround 1.5 0.0
TXT IIN

BRANCH
! Child branch attached across the inductor above
RLSeries 0.02 5e-9
RCGround 3.0 0.0
TXT IIN`,
    sidebranch: `! Side branch (Endbranch) Example: branch leaving a node
Time-step 5e-9
End-time 800e-9
Resolution-time 2e-9

BRANCH
! Main branch capacitor charged to 80kV
RCGround 1e12 60e-9
Initial VC1 80000
TXT VC1

! Series path to load
RLSeries 0.02 10e-9
Endbranch

RCGround 1.0 0.0
TXT IIN

BRANCH
! Child branch attached to previous node (Endbranch)
RCGround 4.0 0.0
RLSeries 0.01 5e-9
TXT VC1`
};

function init() {
    worker = new Worker('worker.js', { type: 'module' });
    
    worker.onmessage = (e) => {
        const { type, msg, pct, data, files } = e.data;
        
        switch(type) {
            case 'LOG':
                log(msg);
                break;
            case 'ERROR':
                log(msg, 'error');
                statusBox.textContent = 'Error';
                btnRun.disabled = false;
                break;
            case 'PROGRESS':
                statusBox.textContent = `Running: ${pct}%`;
                break;
            case 'PLOT_DATA':
                renderPlots(data);
                break;
            case 'CSV_READY':
                generatedFiles = files;
                btnDownload.disabled = false;
                statusBox.textContent = 'Done';
                btnRun.disabled = false;
                btnRun.textContent = "RUN SIMULATION";
                log(`Generated ${files.length} output files.`);
                break;
        }
    };

    Plotly.newPlot(plotDiv, [], {
        margin: { t: 20, r: 20, b: 40, l: 60 },
        showlegend: true,
        xaxis: { title: 'Time (s)', showgrid: true, zeroline: false },
        yaxis: { showgrid: true, zeroline: false },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)'
    }, { responsive: true });
}

btnRun.addEventListener('click', () => {
    if (btnRun.textContent === "STOP") {
        worker.postMessage({ command: 'STOP' });
        btnRun.textContent = "RUN SIMULATION";
        statusBox.textContent = "Stopped";
        return;
    }

    logArea.innerHTML = '';
    btnDownload.disabled = true;
    generatedFiles = [];
    btnRun.textContent = "STOP";
    statusBox.textContent = "Starting...";
    
    worker.postMessage({ 
        command: 'START', 
        payload: editor.value 
    });
});

btnDownload.addEventListener('click', () => {
    if (generatedFiles.length === 0) return;
    
    generatedFiles.forEach(file => {
        const url = URL.createObjectURL(file.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
});

exampleSelector.addEventListener('change', (e) => {
    const key = e.target.value;
    if (key && exampleDecks[key]) {
        editor.value = exampleDecks[key];
    }
});

function log(msg, type='info') {
    const div = document.createElement('div');
    div.className = 'log-line ' + (type === 'error' ? 'log-error' : 'log-success');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logArea.appendChild(div);
    logArea.scrollTop = logArea.scrollHeight;
}

function renderPlots(datasets) {
    const traces = [];
    
    Object.keys(datasets).forEach(name => {
        traces.push({
            x: datasets[name].x,
            y: datasets[name].y,
            mode: 'lines',
            name: name
        });
    });

    Plotly.react(plotDiv, traces, {
        xaxis: { title: 'Time (s)' },
        yaxis: { title: 'Magnitude' }
    });
}

init();