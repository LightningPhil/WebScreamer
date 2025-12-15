# PRD: SCREAMER-Style Branching (Topbranch + Endbranch) for WebScreamer

## 1) Purpose

Add SCREAMER-compatible **branching** to WebScreamer so that an input deck can define:

* a **main (Level-1 / L1) branch** and additional branches (L2, L3, …),
* with branches that “exit” from a parent branch as either:

  * **End branches** (parallel branch from a single node), or
  * **Top branches** (series branch across a series element, i.e., between two adjacent nodes).

The implementation must follow the SCREAMER manual/report definitions for:

* **deck syntax** (`Branch`, `Topbranch`, `Endbranch`) 
* **topological restrictions** (no reconnection; end-branch not allowed from last block of main branch)
* **mathematical coupling constraints** for end/top branches in the implicit solve

This PRD describes *how it should be done* (design + requirements), not code.

---

## 2) Background and key concepts

### 2.1 SCREAMER’s branch types

SCREAMER’s core topology is a **linear series “branch”** of π-section nodes, with optional side branches that can connect to:

* **any single node** (End branch), or
* **any pair of adjacent nodes** (Top branch).

Branches **may never reconnect** to any branch. 

SCREAMER’s deck explicitly marks branch structure using:

* `Branch` — begins a new branch definition
* `Topbranch` — declares that a new branch exits the *previous block* at its **last two nodes**
* `Endbranch` — declares that a new branch exits the *previous block* at its **last node** (and may not attach to the last block of the main branch) 

Branches are **defined later in the deck in the order they are called**.

### 2.2 Why branching affects the solver

SCREAMER solves a **fully-implicit, second-order** discretization of its node equations (voltage drop + KCL). The resulting linear system is essentially **block-tridiagonal** for a pure series branch, but branching introduces a few **off-diagonal couplings**. 

The SCREAMER V4 report lays out explicit matrix population rules for **End branch** coupling and **Top branch** coupling and shows example full matrices.

---

## 3) Goals, non-goals, success metrics

### 3.1 Goals

1. **Parse SCREAMER branch syntax** (`Branch`, `Topbranch`, `Endbranch`) and build a branch tree (L1/L2/L3…).
2. **Compile each branch into solver nodes** and correctly identify attachment points (“last node” / “last two nodes” of previous block).
3. Extend the implicit solve to enforce SCREAMER’s **coupling constraints**:

   * End branch: (V_{\text{child},1} = V_{\text{parent},i}) and parent KCL includes child first-current term
   * Top branch: (V_{\text{child},1} = V_{\text{parent},i} - V_{\text{parent},i+1}) and equal/opposite current injections into the two parent nodes
4. Support **branches in branches** at least through L3 (consistent with SCREAMER V4.x user guide).

### 3.2 Non-goals

* Implementing new circuit element types beyond what WebScreamer already supports.
* Perfect runtime parity with Fortran SCREAMER for very large decks on day one (we will design for a path to optimize).
* Supporting reconnection / mesh networks (explicitly disallowed by SCREAMER topology). 

### 3.3 Success metrics

* Correctness: reproduce the **matrix structure** (non-zero pattern and coupling signs) of the V4 report’s sample “single end branch” and “single top branch” examples.
* Usability: branch decks from the SCREAMER user guide parse and run with clear error messages when invalid.
* Stability: solver remains stable when first branch-series coefficients are near-zero (handle the known “AI₁ ≈ 0” issue safely). 

---

## 4) Terminology and data model

### 4.1 Terms

* **Branch**: an ordered series chain of nodes (L1 main branch, L2 child branches, etc.).
* **Block**: one input-deck element statement that expands into one or more solver nodes (e.g., TRLine becomes many).
* **Attachment / Branch call**: a `Topbranch` or `Endbranch` marker that creates a new child-branch slot tied to a specific parent location.
* **Attachment node(s)**:

  * End branch attaches at a **single parent node i**.
  * Top branch attaches between **parent nodes i and i+1** (adjacent). 

### 4.2 Core runtime objects (conceptual)

**Circuit**

* `branches: Branch[]` (branch 1 is main)
* `attachments: Attachment[]`
* `outputs: Probe[]`
* `dt`, `t_end`, other timing fields

**Branch**

* `id` (1-based)
* `level` (1 for main, 2/3 for children)
* `blocks: Block[]` (in branch-local order)
* `nodes: Node[]` (solver nodes, branch-local indexing)
* `globalNodeOffset` (prefix sum used when flattening to a global solve)

**Attachment**

* `type: "END" | "TOP"`
* `parentBranchId`
* `parentAnchor`:

  * END: `parentNodeIndex`
  * TOP: `parentNodeIndexLeft`, `parentNodeIndexRight` (adjacent)
* `childBranchId` (the branch definition that fulfills this call)

**Node**

* parameters required by your implicit scheme (R/L/G/C and any “phantom” flags)
* storage for previous/new V/I states (by global index in flattened vectors)

---

## 5) Deck parsing and branch construction requirements

### 5.1 Syntax support

Add support for these SCREAMER structure lines (case-insensitive):

* `Branch`
* `Topbranch`
* `Endbranch` 

These lines are **structural**, not elements. They do not directly add R/L/G/C; they affect topology.

### 5.2 Ordering rule: “called order == defined order”

When parsing:

* `Topbranch` / `Endbranch` inside a branch body **declares a new child branch is needed**.
* The **subsequent** `Branch` sections in the file **define** those child branches **in exactly the order they were called**.

**PRD requirement:** implement this using a **queue of pending branch calls**:

1. Start reading Branch #1 when the first `Branch` line is seen.
2. Each `Topbranch` / `Endbranch` encountered enqueues a pending call with its parent anchor location.
3. When a new `Branch` line is seen (after the first), it must dequeue the **next pending call** and bind that new branch definition to it.
4. EOF validation: pending-call queue must be empty, otherwise error “branch call(s) not defined”.

### 5.3 Attachment anchor definition: “previous block’s last node(s)”

Per manual:

* `Topbranch` exits the **previous block** at the **last two nodes** of that block.
* `Endbranch` exits the **previous block** at the **last node** of that block. 

**PRD requirement:** the compiler must track, for every parsed block:

* the set of solver nodes it created and which are considered “real” versus phantom,
* and expose “block tail anchors”:

  * `endAnchorNode` (last physical node of that block)
  * `topAnchorNodes` (last two physical nodes of that block)

If your internal representation currently expands a block into alternating “RC nodes” and “RL nodes”, you must define a consistent rule for “physical node”. The recommended approach (to match SCREAMER math) is:

> Define a *SCREAMER node* as the location where a node voltage (V_i) is defined and where KCL is applied (the node that carries the shunt G/C in the π formulation). Branch anchors should always reference these KCL/voltage nodes, not intermediate phantom series-only helper nodes.

This keeps branch-current injections aligned with the KCL equation that explicitly contains the branch-current term (I_B). 

### 5.4 Topology restrictions / validation

Enforce:

* Branches **never reconnect** to any branch. (In deck terms: there is no syntax for reconnection; but ensure internal model never creates it.) 
* An `Endbranch` **may not attach to the last block of the main branch**. 
* A `Topbranch` must attach across **adjacent** parent nodes (i, i+1). (This is intrinsic if you derive anchors from “last two nodes”.) 
* Support at least **L3** branches (“branches in branches”).

Error messages must include line number and a human-readable explanation (e.g., “Endbranch cannot be attached to final block of main branch”).

---

## 6) Solver formulation: how branching is enforced

### 6.1 Global unknown ordering

Use SCREAMER’s natural ordering when constructing the global linear system:

[\nx = [V_1^{(1)}, I_1^{(1)}, V_2^{(1)}, I_2^{(1)}, \dots, V_{n_1}^{(1)}, I_{n_1}^{(1)}, V_1^{(2)}, I_1^{(2)}, \dots]\n]

i.e., concatenate all branches in branch-id order. 

This makes branch coupling easy because the report defines branch offsets in terms of prefix sums of node counts.

### 6.2 Base (non-branch) equations

SCREAMER’s continuous node equations are:

* voltage drop between nodes,
* KCL at node including a branch-current term (I_B) if present. 

In the V4 report’s matrix population (scaled form), interior-node equations are written as:

* Current/KCL row (includes optional branch term):
  [\n  -I_{i-1} + 2AV_i V_i + I_i + I_{1,\text{child}} = 2BV_i\n  ]
* Voltage-drop row:
  [\n  V_i - 2AI_i I_i - V_{i+1} = -2BI_i\n  ]

(with special handling at first/last nodes). 

**PRD requirement:** keep your existing implicit discretization (theta-method/Crank-Nicolson equivalent) but structure the matrix assembly so that:

* each branch produces a block-tridiagonal (in 2×2 sense) contribution,
* then attachments add sparse couplings/constraints.

### 6.3 End branch coupling (parallel from one parent node)

SCREAMER’s end-branch assumptions:

* input voltage to the child branch equals parent node voltage,
* current leaving the parent into the child equals child branch first current. 

**Matrix implications (conceptual):**

1. **Parent KCL row coupling**
   In the parent node’s KCL equation, add an off-diagonal coefficient multiplying the child branch’s first current unknown (I_1^{(\text{child})}). The report shows this as a “+1” coupling term in the parent KCL row. 

2. **Voltage continuity constraint row**
   Add (or repurpose) a row to enforce:
   [\n   V_1^{(\text{child})} - V_i^{(\text{parent})} = 0\n   ]
   The report’s example shows this implemented by placing a “-1” in the parent’s voltage column and ensuring the RHS entry is 0.

**Important structural rule:**
The V4 report notes the **first row(s) of a branch are special**; in particular, the branch start must be compatible with the solver’s matrix structure (it notes constraints on having an RCG at the first branch node in that legacy formulation). 
**PRD requirement:** the web solver must treat the **first node of every branch** as “attachment-defined” (at least for its voltage relation), not purely “normal interior-node”.

### 6.4 Top branch coupling (series across a parent series element)

SCREAMER’s top-branch relationships:

* child’s first node voltage equals the parent voltage difference across adjacent nodes,
* branch current leaves node i and returns at node i+1, meaning equal and opposite injections.

**Matrix implications (conceptual):**

1. **Two parent KCL row couplings**

   * In parent node i KCL row: add (+I_1^{(\text{child})}) coupling.
   * In parent node i+1 KCL row: add (-I_1^{(\text{child})}) coupling.
     (These are the “+1” and “-1” off-diagonal couplings shown in the report’s example.) 

2. **Voltage difference constraint row**
   Enforce:
   [\n   V_1^{(\text{child})} - V_i^{(\text{parent})} + V_{i+1}^{(\text{parent})} = 0\n   ]
   Implemented as a sparse row linking three voltage unknowns, RHS = 0.

---

## 7) Solver architecture changes in WebScreamer

### 7.1 Why the current pentadiagonal solver must change

Your current solver assumes a single chain that can be stored as a pentadiagonal band. Branch couplings introduce **far off-diagonal non-zeros**, which breaks that assumption (the manual explicitly describes the system as a block-tridiagonal matrix with “a few off-diagonal elements” when branches exist). 

### 7.2 Required solver capability

**PRD requirement:** introduce a solver backend that can handle:

* sparse off-diagonal couplings from branch currents,
* constraint rows linking voltages across branches,
* numerical stability when certain diagonal terms are small/zero (notably the “first AI in a branch” issue described in the report). 

### 7.3 Two-phase backend plan (recommended)

To keep delivery feasible while staying faithful to SCREAMER:

**Phase A (Correctness-first): General sparse direct solve**

* Build a sparse matrix in a standard structure (triplets/COO → CSR).
* Solve using a robust sparse LU (with partial pivoting) or a dense fallback for small systems.
* Target: correctness and moderate sizes.

**Phase B (Performance parity path): SCREAMER-structure solver**

* Implement a specialized elimination that exploits:

  * block-tridiagonal structure within branches,
  * small number of extra couplings per attachment,
  * branch prefix-sum offsets (as in SCREAMER’s internal indexing).
* The report indicates the legacy approach scales ~O(N) for this structured problem and describes key numerical caveats. 

This PRD does not require Phase B immediately, but requires designing interfaces so it can be added without rewriting topology parsing again.

---

## 8) Numerical stability requirements

### 8.1 Branch-start diagonal handling

The V4 report documents a known issue: the first series coefficient (AI) at the start of branches is often ~0 (especially due to phantom series elements), and SCREAMER historically inserts a small floor (e.g., (10^{-6})) to avoid solver breakdown. 

**PRD requirements:**

* Detect near-zero diagonal pivots in branch-start equations.
* Apply a consistent stabilization policy:

  * either a small floor (with a warning),
  * or pivoting/row-reordering robust enough to avoid needing the floor.
* Log when stabilization occurs so results are interpretable.

### 8.2 Branch termination condition

The report notes that the last row in any branch effectively forces the final current to zero (no current flows past the terminal phantom series element). 

**PRD requirement:** treat each branch’s terminal condition independently (each branch has its own “end current = 0” boundary).

---

## 9) Probing/output requirements for branched circuits

WebScreamer currently interprets `TXT` relative to “most recent block”. With multiple branches, “most recent block” becomes ambiguous across branch definitions.

**PRD requirement:** define deterministic probe scoping:

* Default: `TXT` applies to the **current branch being parsed** (i.e., within the active `Branch` section).
* Optional extension (recommended): allow an explicit branch selector, e.g. `TXT BRANCH 3 VC1` (syntax up to you), to probe across branches without moving the statement.

This keeps decks readable and avoids accidental probes binding to the wrong branch.

---

## 10) Validation and error handling

### 10.1 Compile-time validation

Must detect and report:

* `Topbranch` / `Endbranch` without a “previous block” in the current branch.
* Missing branch definitions (pending call queue non-empty at EOF).
* Extra `Branch` definitions (branch definition encountered when pending queue empty).
* Endbranch attached to last block of main branch. 
* Topbranch anchor that cannot produce two adjacent physical nodes.

### 10.2 Runtime validation

At runtime (during assembly/solve):

* Detect singular or ill-conditioned matrices (or solver failure).
* Provide actionable error: which branch/node likely caused it (branch id + local node index).

---

## 11) Test plan and acceptance criteria

### 11.1 Unit tests (matrix population)

Implement golden tests that build matrices and compare:

* **Single End branch** matrix structure matches the report’s example (non-zero pattern and coupling placement).
* **Single Top branch** matrix structure matches the report’s example (two KCL couplings ± and the voltage-difference constraint row).

### 11.2 Parser tests (deck structure)

Use the SCREAMER manual’s branch structure example and verify:

* branch ids are assigned in appearance order,
* branch definitions bind to calls in called-order. 

Use the “branch in branch” sample to verify L3 handling. 

### 11.3 Integration tests (simulation)

* Regression: existing non-branch decks produce identical traces as before.
* Branch decks: run stable, generate expected signals, and the worker remains responsive.

### 11.4 Acceptance criteria

* A deck with one top branch and one end branch runs end-to-end, with probes on both main and child branches, and no topology ambiguity.
* The coupling sign conventions match SCREAMER’s definitions (top branch injects equal/opposite current at the two parent nodes). 
* Invalid decks fail with clear, line-numbered diagnostics.

---

## 12) Risks and mitigations

1. **Anchor mismatch due to internal node representation**
   Mitigation: define “physical node” explicitly (KCL node), derive anchors only from those nodes, and keep a map from block → physical tail nodes.

2. **Solver instability for branch-start near-zero diagonals**
   Mitigation: choose pivoting or consistent diagonal flooring with warnings, per the report’s documented issue. 

3. **Performance regressions from general sparse LU in JS**
   Mitigation: implement Phase A for correctness, but structure the matrix and indices so a SCREAMER-structure solver can be slotted in later (Phase B).

---

# Engineering Design Spec: Branching (Topbranch + Endbranch) for WebScreamer

This spec defines **exact index conventions**, **matrix row/column edits**, and **deck → topology → solver** integration needed to implement SCREAMER-style branching in WebScreamer, including **branches-in-branches (L3+)**. It is written to be self-contained, and references the SCREAMER User’s Guide and V4 solver report for the canonical coupling rules and indexing.

---

## 0) Scope and constraints

### In scope

* Parse structural lines: `Branch`, `Topbranch`, `Endbranch` (case-insensitive).
* Construct a **branch tree** where each child branch is attached to a parent anchor defined by “previous block tail node(s)”.
* Assemble and solve a linear system that enforces:

  * **End branch**: voltage continuity at attachment node + current coupling into parent KCL.
  * **Top branch**: branch voltage equals parent node voltage difference + equal/opposite current injection into two parent KCL rows.
* Support **L3** branches (and beyond, structurally), consistent with SCREAMER V4.0/4.1 behavior and ordering restrictions.

### Out of scope

* Implementing new element physics not already present.
* Reconnection/mesh topologies (explicitly not part of SCREAMER’s branching model). 

---

## 1) Existing WebScreamer architecture touchpoints

Current repo components (from zip):

* `Core/topology.js`: deck compiler → node list
* `Core/matrix.js`: **pentadiagonal** banded storage (diag, upper1, lower1, upper2, lower2)
* `Core/solver.js`: builds banded matrix and runs pentadiagonal elimination

**Key implication:** branching introduces off-band couplings and constraint rows, so you must introduce a non-banded storage/solve path (sparse or dense). The SCREAMER V4 report explicitly discusses “off pentadiagonal components” when branches are present.

---

## 2) Canonical SCREAMER rules you must match

### 2.1 Deck structure and branch definition order

* `Branch` begins a branch definition.
* `Topbranch`/`Endbranch` appear *inside* a branch definition and **call** a new branch.
* Branch definitions must appear **later in the file in exactly the order they are called**.

Levels:

* Branch #1 is L1 main.
* Branches called from L1 are L2.
* Branches called from L2 are L3 (and so on).

### 2.2 Attachment anchors

* `Topbranch`: exits the **previous block** at the **last two nodes** of that block.
* `Endbranch`: exits the **previous block** at the **last node** of that block, and **may not be attached to the last block of the main branch**.

### 2.3 Coupling constraints (math)

End branch assumptions: input voltage equals parent node voltage; branch current equals current leaving parent into branch.

Top branch assumptions: branch voltage equals parent voltage difference across a series element; branch current leaves at node *i* and returns at node *i+1* (equal and opposite injection).

---

## 3) Data model (compile-time topology)

### 3.1 Core objects

**Branch**

* `id: number` (1..nb, in file order)
* `level: number` (computed from call nesting)
* `blocks: Block[]`
* `nodes: Node[]` (solver nodes, *KCL/voltage nodes*, not “helper” nodes)
* `nodeOffset: number` (prefix sum of node counts in all earlier branches)

**Attachment**

* `type: "END" | "TOP"`
* `parentBranchId: number`
* `parentBlockIndex: number` (1-based within parent branch)
* `parentNodeIndex`:

  * END: `i`
  * TOP: `i` meaning pair `(i, i+1)`
* `childBranchId: number` (assigned when child branch definition is parsed)

### 3.2 The “pending branch calls” queue (required)

During parsing:

* When `Topbranch`/`Endbranch` is seen inside a branch, push an `Attachment` with its parent anchor info onto `pendingCalls`.
* When `Branch` starts a new branch definition (after the first), pop the next `pendingCalls[0]` and assign `childBranchId` to that attachment.
* EOF validation: `pendingCalls` must be empty, else error “called branch not defined”.

This directly implements the “called order == defined order” rule.

---

## 4) “Physical node” definition and block tail anchors

### 4.1 Required definition

A **physical node** is a node where:

* a voltage unknown (V_i) exists, and
* a KCL/current equation row is written for that node (this is where SCREAMER adds the branch-current term).

You must ensure your block expansion reports tail anchors in terms of these physical nodes.

### 4.2 Tail anchor API (per block)

Every compiled `Block` must expose:

* `tailNode: number` → local physical node index of the last node created/owned by that block
* `tailNodePair: [number, number] | null` → the last two physical node indices (required for Topbranch)

If a block only has one physical node at its end, `tailNodePair` is `null`.

### 4.3 Resolving anchors for branch calls

When parsing a `Topbranch` or `Endbranch`, reference the **previous block** in that branch:

* `Endbranch` anchor = `prevBlock.tailNode`
* `Topbranch` anchor pair = `prevBlock.tailNodePair`

If missing, it is a compile-time error:

* “Endbranch has no previous block”
* “Topbranch requires previous block to provide two tail nodes”

---

## 5) Global unknown ordering and index formulas

### 5.1 Unknown vector layout (WebScreamer-compatible)

WebScreamer currently uses:
[\nx = [V_0, I_0, V_1, I_1, \dots]\n]
(0-based node indices)

Adopt the same but with **all branches concatenated by branch id** (1..nb). This matches SCREAMER’s branch ordering restriction that the child branch’s first unknown must occur after its parent’s unknowns.

### 5.2 Prefix sums / offsets

Let:

* `nr[k]` = number of physical nodes in branch k (1-based)
* `offset[k] = Σ_{j<k} nr[j]` (0-based node offset into the flattened global node list)

Then the global physical node index for branch k local node i (1-based local) is:

* `g = offset[k] + (i - 1)` (0-based global node index)

### 5.3 Row/column indices

For any global physical node `g`:

* `colV(g) = 2*g`
* `colI(g) = 2*g + 1`
* Use the same for row indices:

  * `rowV(g) = colV(g)`  (KCL/current-equation row)
  * `rowI(g) = colI(g)`  (voltage-drop equation row)

This matches the SCREAMER report’s 1-based rule that row `(2*i - 1)` is the node’s “current equation” and row `(2*i)` is the “voltage equation”, just shifted to 0-based indexing.

### 5.4 SCREAMER-equivalent “nadd_array”

If you later implement a structured solver, maintain an array:

* `nadd[branchId] = offset[branchId]` (0-based)

Then the SCREAMER report’s first-node row index:

* 1-based: `2*nadd + 1`
* 0-based: `2*nadd`

The report’s solver uses `i = 2*nadd_array(ib)+1` in 1-based Fortran indexing to locate the first node of each branch.

---

## 6) Matrix assembly strategy

### 6.1 Two-stage assembly (recommended)

1. Assemble base equations for all branches as if no branches exist (just series chains).
2. Apply each attachment as a **small set of sparse edits**:

   * off-diagonal current couplings into parent KCL row(s)
   * overwrite the child branch’s first KCL row with the attachment constraint

This matches the SCREAMER report statement that the matrix structure for a branch is the same as a normal branch “except for the first node”.

### 6.2 Important: constraint row is not an extra row

Do **not** add an additional equation row (that would overdetermine the system unless you also add a new unknown). SCREAMER’s examples indicate the coupling “impacts… the row of the first node (voltage) of the end branch”, i.e., you **replace/overwrite** that row.

So:

* The child branch node-1 **KCL row** (`rowV(child,1)`) becomes a constraint row.
* The child branch node-1 voltage-drop row (`rowI(child,1)`) remains the branch’s normal first voltage-drop row.

---

## 7) Exact coupling edits for each branch type

Below, “parent” is branch k, “child” is branch l, and the child’s first node is local i=1.

Let:

* `gp_i` = global node index of parent attachment node i
* `gc_1` = global node index of child node 1
* `K` = coupling coefficient factor used in your KCL row (see §7.3)

### 7.1 End branch edits (parallel at one parent node)

#### 7.1.1 Parent KCL row: add off-diagonal coupling to child first current

Edit:

* `A[rowV(gp_i), colI(gc_1)] += +K`

This is the “+1 off diagonal element multiplies the first current element in the branch” behavior described in the V4 report.

#### 7.1.2 Child first KCL row: overwrite with voltage continuity constraint

Overwrite row `rowV(gc_1)` to enforce:
[\nV_{child,1} = V_{parent,i}\n]

Implementation as a linear row:

* Set all entries in that row to 0
* Set:

  * `A[rowV(gc_1), colV(gc_1)] = +1`
  * `A[rowV(gc_1), colV(gp_i)] = -1`
* Set RHS:

  * `b[rowV(gc_1)] = 0`

The report explicitly notes placing the parent voltage term into the child’s first-node row and forcing the RHS entry to 0.

### 7.2 Top branch edits (series across two adjacent parent nodes)

Top branch exits across a series element: parent nodes are `i` (left) and `i+1` (right). 

Let:

* `gp_L = gp_i`
* `gp_R = gp_{i+1}`

#### 7.2.1 Parent KCL rows: equal/opposite injections

Edits:

* `A[rowV(gp_L), colI(gc_1)] += +K`
* `A[rowV(gp_R), colI(gc_1)] += -K`

This matches the report’s example where the node-i equation couples with +1 and the node-(i+1) equation couples with -1 to the same child-current column.

#### 7.2.2 Child first KCL row: overwrite with voltage-difference constraint

Overwrite row `rowV(gc_1)` to enforce:
[\nV_{child,1} = V_{parent,i} - V_{parent,i+1}\n]

Linear row form:

* Set row to 0
* Set:

  * `A[rowV(gc_1), colV(gc_1)] = +1`
  * `A[rowV(gc_1), colV(gp_L)] = -1`
  * `A[rowV(gc_1), colV(gp_R)] = +1`
* RHS:

  * `b[rowV(gc_1)] = 0`

(Sign-flipped equivalents are also valid since RHS is 0, but this convention keeps the diagonal +1.)

### 7.3 What is K?

SCREAMER’s discrete KCL equation appears as either:

* unscaled form with `0.5 * I_branch` term (Eq. 3.13), or
* scaled-by-2 interior form with `+ I_branch` term (Eq. 3.15).

**Design requirement:** define `K` to match whatever scalar multiple your implementation uses for the KCL row at that node.

* If your row is in “scaled interior form”, use `K = 1`.
* If you keep the “0.5” factors (common in theta/CN forms), use `K = 0.5`.
* If you have per-row scaling (first/last handled differently), compute `K(row)` consistently from the same logic.

This ensures branch coupling has the correct magnitude relative to the rest of the KCL row.

---

## 8) Compatibility rule: first node of a branch and shunt elements

The V4 report states that “the first node in the lth branch cannot have an RCG element” because it would introduce a non-zero constant term in that first-node equation that is not compatible with the planned matrix implementation once the row is being used for the voltage constraint.

**Engineering decision (recommended for SCREAMER compatibility):**

* Enforce (compile-time) that the **first physical node** of any child branch does not include a shunt G/C contribution that would otherwise require using the original KCL equation at that node.
* If violated, produce an error such as:

  * “Branch X begins with an RCG/PI/element that contributes to node-1 KCL; SCREAMER-style branching requires node-1 KCL row to be replaced by an attachment constraint.” 

If you prefer to be more permissive than SCREAMER, you *can* support it by moving that shunt contribution to a new node (auto-insert a series zero-length element), but that becomes a deliberate behavioral divergence and should be opt-in.

---

## 9) Branch termination boundary condition

The report notes SCREAMER forces the final current in any branch to 0 by special handling of the last row/phantom block (“always forces the current from the final node of all branches to be 0”).

**Design requirement:**

* Keep a consistent, explicit terminal condition for each branch end (whether by a terminal `RCground` / phantom block model in your compiler or a direct boundary row edit).
* The key outcome is: **no current flows past the last node** of that branch.

---

## 10) Solver/storage requirements (what must change)

### 10.1 Why pentadiagonal is insufficient

End branches and top branches add matrix entries far outside the `±2` bands (they couple a parent node row to a child branch column that may be thousands of indices away). This cannot be represented by the current `diag/upper1/lower1/upper2/lower2` arrays.

### 10.2 Minimal required solver interface

Define an abstract “linear system builder” with:

* `set(row, col, value)` and `add(row, col, delta)`
* `zeroRow(row)` (or `overwriteRow(row, entries...)`)
* `solve(A, b) -> x` (or in-place b)

### 10.3 Suggested implementation path

* **Correctness-first:** build a sparse COO/CSR and solve with a robust sparse method (or dense for small N).
* **Future optimization:** structured solver (like the report’s modified Gaussian elimination) can be added later; it relies on branch offsets and ordering constraints.

### 10.4 Ordering constraint for embedded branches

If branch `kl` is connected to branch `km`, then the child’s unknowns must appear *after* the parent’s unknowns in the global vector. The report calls this the key restriction for the direct solver. 

This is naturally satisfied if you:

* enforce “called order == defined order”, and
* concatenate branches by branch id (file order).

---

## 11) Validation rules (compile-time)

### 11.1 Structural

* Every `Topbranch` / `Endbranch` must have a previous block in that branch.
* Every branch call must be matched by exactly one later `Branch` definition (pending queue empties at EOF). 
* A `Branch` definition encountered when no pending call exists is an error (extra branch definition).

### 11.2 Anchor feasibility

* `Topbranch` requires two adjacent physical tail nodes from the previous block.
* `Endbranch` requires one physical tail node.

### 11.3 SCREAMER restriction

* `Endbranch` cannot attach to the last block of the main branch. Implement by recording `parentBlockIndex` for the call and, after branch-1 parse completes, checking whether any end-branch call references `blockIndex == blocks.length`.

---

## 12) Worked index example (sanity check)

### Example: end branch leaving main branch node 2

SCREAMER report example: main branch has 3 nodes, end branch has 2 nodes. The report says the leaving-node KCL row gets an off-diagonal `+1` into the child first-current column, and the child first-node row gets a `-1` in the parent voltage column and RHS forced to 0.

Using this spec’s indexing:

* Main branch nodes: global g=0,1,2
* Child branch nodes: global g=3,4

Parent attachment node is main local i=2 → global `gp_i = 1`
Child first node is `gc_1 = 3`

Edits:

1. Parent KCL row coupling:

* `rowV(gp_i)=rowV(1)=2`
* `colI(gc_1)=colI(3)=7`
* set `A[2,7] += +K`

2. Child constraint row overwrite:

* `rowV(gc_1)=rowV(3)=6`
* `colV(gc_1)=6`
* `colV(gp_i)=colV(1)=2`
* row becomes: `(+1)*V_child1 + (-1)*V_parent2 = 0`
* RHS `b[6]=0`

That is exactly the same structural effect described in the report (just 0-based).

---

## 13) Implementation checklist (engineering)

1. **Parser**

* Add recognition of `BRANCH`, `TOPBRANCH`, `ENDBRANCH`. 
* Maintain `currentBranchId` and `pendingCalls` queue.
* Record `parentBlockIndex` + tail anchor nodes at time of call.

2. **Compiler**

* Expand blocks into physical nodes and record each block’s `tailNode` / `tailNodePair`.
* Compute `nr[k]`, `offset[k]`, global node indices.

3. **Matrix assembly**

* Base assembly for all branch nodes.
* For each attachment:

  * add parent KCL coupling(s) to `I_child1`
  * overwrite `rowV(child1)` with constraint row
* Apply terminal boundary rules per branch end (final current forced to 0 or equivalent).

4. **Solver**

* Replace/extend pentadiagonal solve with sparse/dense solve to support off-band elements.
* Keep hooks for a future structured solver using `nadd[]` offsets.

-----------------------------

## Matrix population map

This is a **stencil-level** map of which matrix entries must be non-zero for each row type in SCREAMER’s formulation (including Topbranch / Endbranch couplings). It’s written so you can implement matrix assembly deterministically without rereading the report each time.

The canonical equations and scaling choices come from SCREAMER V4’s matrix derivation (Eqs. 3.13–3.16) and the worked population examples.

---

# 1) Global indexing conventions (recommended)

### Unknown ordering (global vector `x`)

Flatten **all branches in branch-id order** (this is required by the SCREAMER restriction (k<l) for parent/child branch indices).

For each physical node `g` (global, 0-based), store:

* `V(g)` then `I(g)`

So:

* `colV(g) = 2*g`
* `colI(g) = 2*g + 1`

Use the same indices for rows:

* `rowKCL(g) = 2*g`   (current/KCL equation row)
* `rowVdrop(g) = 2*g + 1` (voltage-drop equation row)

### Branch-local → global node mapping

Let branch `k` have `nr[k]` physical nodes, and `offset[k] = sum_{j<k} nr[j]`.

If local node index is `i` (1…nr[k]) then:

* `g(k,i) = offset[k] + (i-1)`

---

# 2) Coefficient symbols (matches SCREAMER derivation)

SCREAMER forms four per-node constants:

* `AV(i)` and `AI(i)` populate the **matrix**
* `BV(i)` and `BI(i)` populate the **RHS**
  Defined in the report and IEEE paper; they depend on timestep, element values, and previous-step state.

I’ll write them as `AV[k,i]`, `AI[k,i]`, `BV[k,i]`, `BI[k,i]`.

---

# 3) Base (no-branch) row stencils

SCREAMER uses:

* **Unscaled boundary form** at the **first and last node** of each branch (Eqs. 3.13–3.14).
* **Scaled interior form** for nodes `1<i<nr` (Eqs. 3.15–3.16).

That is why the report repeatedly notes “the first two rows are not scaled by 2” (and similarly for the last node rows).

Below, `g = g(k,i)`.

---

## 3.1 First node of a branch: i = 1 (unscaled)

### Row: KCL/current equation at node 1 (Eq. 3.13 with no (I_{0}))

`r = rowKCL(g)`

Non-zeros:

* `A[r, colV(g)] += AV[k,1]`
* `A[r, colI(g)] += +0.5`
* (optional) branch-exit terms: see §4

RHS:

* `b[r] = BV[k,1]`

This corresponds to the “first row has no current from the prior node” statement.

### Row: V-drop/voltage equation at node 1 (Eq. 3.14)

`r = rowVdrop(g)`

Non-zeros:

* `A[r, colV(g)] += -0.5`
* `A[r, colI(g)] += AI[k,1]`
* `A[r, colV(g(k,2))] += +0.5`  (only if `nr[k] >= 2`)

RHS:

* `b[r] = BI[k,1]`

---

## 3.2 Interior node of a branch: 1 < i < nr (scaled)

The interior equations are the scaled forms (Eqs. 3.15–3.16).

Let `g_prev = g(k,i-1)`, `g_next = g(k,i+1)`.

### Row: KCL/current equation (Eq. 3.15)

`r = rowKCL(g)`

Non-zeros:

* `A[r, colI(g_prev)] += -1`
* `A[r, colV(g)]     += +2*AV[k,i]`
* `A[r, colI(g)]     += +1`
* (optional) branch-exit terms: see §4

RHS:

* `b[r] = 2*BV[k,i]`

### Row: V-drop/voltage equation (Eq. 3.16)

`r = rowVdrop(g)`

Non-zeros:

* `A[r, colV(g)]     += +1`
* `A[r, colI(g)]     += -2*AI[k,i]`
* `A[r, colV(g_next)]+= -1`

RHS:

* `b[r] = -2*BI[k,i]`

This is exactly the pattern shown in the report’s 3-node example matrix (pentadiagonal in the no-branch case).

---

## 3.3 Last node of a branch: i = nr (unscaled boundary)

Let `g_prev = g(k,nr-1)` if `nr>1`.

### Row: KCL/current equation at last node (Eq. 3.13 with no “following-node” special-case needed)

`r = rowKCL(g)`

Non-zeros (for `nr>1`):

* `A[r, colI(g_prev)] += -0.5`
* `A[r, colV(g)]      += AV[k,nr]`
* `A[r, colI(g)]      += +0.5`
* (optional) branch-exit terms: see §4

RHS:

* `b[r] = BV[k,nr]`

### Row: V-drop equation at last node (Eq. 3.14 with no (V_{nr+1}))

`r = rowVdrop(g)`

Non-zeros:

* `A[r, colV(g)] += -0.5`
* `A[r, colI(g)] += AI[k,nr]`
* (no `+0.5*V_{next}` term)

RHS:

* `b[r] = BI[k,nr]`

**Practical SCREAMER note:** SCREAMER commonly uses a terminal phantom RLSeries so the last node’s equation effectively forces `I_last = 0` (by setting the last `AI`/row accordingly). The report explains this as “always forces the final current of ANY branch to be 0.”

---

# 4) Branch coupling population map

Branching affects:

1. **parent KCL rows** (by adding off-diagonal terms in the child’s first-current column), and
2. **child branch node-1 KCL row**, which is **overwritten** to become a constraint row.

The coupling assumptions and equations are spelled out in the report:

* End branch: (V_{\text{in,child}} = V_{\text{parent}}), (I_{\text{branch}} = I_{\text{child},1}).
* Top branch: child input voltage equals parent voltage difference across adjacent nodes; currents inject with opposite signs at the two parent nodes.

## 4.1 Branch-coupling coefficient `K(row)`

Because SCREAMER uses:

* **0.5** factors in boundary KCL rows (Eq. 3.13), and
* **1.0** factors in interior KCL rows (Eq. 3.15),

the coefficient that multiplies a branch-current term in a parent KCL row is:

* If parent node is **first or last** in its branch: `K = 0.5`
* If parent node is **interior**: `K = 1.0`

(General rule: match whatever scaling you used for that specific parent KCL row.)

---

## 4.2 End branch coupling map (Endbranch)

### Given

* Parent branch `k`, attachment at parent node `i` (single node).
* Child branch `l`, its first node is `i=1`.

Let:

* `gp = g(k,i)` (parent global node)
* `gc = g(l,1)` (child first global node)

### 4.2.1 Parent edit: add child-current term into parent KCL row

Row: `rP = rowKCL(gp)`
Col: `cChildI = colI(gc)`

Stencil edit:

* `A[rP, cChildI] += +K(parentRow)`

This is the direct matrix expression of “branch current leaving the main branch equals branch current at the first node of the end branch.”

### 4.2.2 Child edit: overwrite child node-1 KCL row with voltage continuity

Overwrite row: `rC = rowKCL(gc)` with:

Constraint:
[\nV_{l,1} - V_{k,i} = 0\n]

Stencil (replace entire row contents):

* `A[rC, colV(gc)] = +1`
* `A[rC, colV(gp)] = -1`
* all other `A[rC, *] = 0`
* `b[rC] = 0`

This matches the report’s description that the end branch’s first-row differs from a normal branch because its input voltage is taken from the parent node.

---

## 4.3 Top branch coupling map (Topbranch)

### Given

* Parent branch `k`, attachment across adjacent nodes `(i, i+1)`.
* Child branch `l`, first node is `i=1`.

Let:

* `gL = g(k,i)` and `gR = g(k,i+1)`
* `gc = g(l,1)`

### 4.3.1 Parent edits: equal and opposite injections in two parent KCL rows

Left parent node KCL row:

* `A[rowKCL(gL), colI(gc)] += +K(rowKCL(gL))`

Right parent node KCL row:

* `A[rowKCL(gR), colI(gc)] += -K(rowKCL(gR))`

This enforces the “current leaves node i and returns at node i+1” behavior the report describes for top branches.

### 4.3.2 Child edit: overwrite child node-1 KCL row with a voltage-difference constraint

Overwrite row: `rC = rowKCL(gc)` with:

Constraint:
[\nV_{l,1} - V_{k,i} + V_{k,i+1} = 0\n]

Stencil:

* `A[rC, colV(gc)] = +1`
* `A[rC, colV(gL)] = -1`
* `A[rC, colV(gR)] = +1`
* all other `A[rC, *] = 0`
* `b[rC] = 0`

---

## 4.4 Multiple branches exiting the same parent location

SCREAMER’s KCL equation at a node simply includes the sum of branch currents that leave that node; matrix-wise this means:

* For each **end branch** exiting node `gp`, add another off-diagonal:

  * `A[rowKCL(gp), colI(gc_m)] += +K(...)`

* For each **top branch** across `(gL,gR)`, apply the ± pair edits for each child.

This is consistent with the report’s statement that “the presence of a branch at the ith node only shows up in the ith current equation… (leading to a sparse matrix)”.

---

# 5) Special-case map: “first node of child branch cannot use normal KCL row”

Because you **overwrite** the child’s node-1 KCL row, SCREAMER notes an important practical restriction: branch starts often include a phantom RLSeries whose `AI1` is effectively zero, and the solver historically floors it. The report discusses this as the main computational issue.

For your population map, the takeaway is:

* **Child branch node-1 KCL row is never assembled from Eq. 3.13/3.15** when it is attached; it is assembled as the constraint row above.
* Child branch node-1 V-drop row (`rowVdrop(gc)`) is still assembled normally (from Eq. 3.14 if it’s the first node; and it will include `+0.5*V2` if present).

---

# 6) Quick reference: row stencils by node type

Let node be `(k,i)` with global `g=g(k,i)`.

### KCL row (`rowKCL(g)`)

* **First node (i=1):**

  * `V(g): AV`
  * `I(g): +0.5`
  * `I(child1): +0.5` (per exiting branch, if any)
  * RHS `= BV`

* **Interior (1<i<nr):**

  * `I(prev): -1`
  * `V(g): +2AV`
  * `I(g): +1`
  * `I(child1): +1` (per exiting branch, if any)
  * RHS `= 2BV`

* **Last (i=nr):**

  * `I(prev): -0.5`
  * `V(g): AV`
  * `I(g): +0.5`
  * `I(child1): +0.5` (per exiting branch, if any — though topologically the “final branch” cannot have exiting branches per report logic)
  * RHS `= BV`

* **Child node-1 KCL row when attached: overwritten constraint row**

  * End: `V(child1): +1`, `V(parent): -1`, RHS 0
  * Top: `V(child1): +1`, `V(parentL): -1`, `V(parentR): +1`, RHS 0

### V-drop row (`rowVdrop(g)`)

* **First node (i=1):**

  * `V(g): -0.5`
  * `I(g): AI`
  * `V(next): +0.5`
  * RHS `= BI`

* **Interior (1<i<nr):**

  * `V(g): +1`
  * `I(g): -2AI`
  * `V(next): -1`
  * RHS `= -2BI`

* **Last node (i=nr):**

  * `V(g): -0.5`
  * `I(g): AI`
  * (no `V(next)` term)
  * RHS `= BI`
