#!/usr/bin/env python3
"""
SAT encoder for Q*bert optimal tour.
Encodes "does a K-move solution exist?" as DIMACS CNF, solves with CaDiCaL.
Binary searches on K to find the exact optimal.

Supports: LV2 (tgt=2, no revert), LV4 (tgt=2, revert 2→1), LV5 (tgt=2, revert 2→0)
"""

import subprocess, sys, os, tempfile, time

ROWS = 7
DR = [-1, -1, 1, 1]
DC = [-1,  0, 0, 1]
DIR_NAMES = ["UL", "UR", "DL", "DR"]

# Build pyramid graph
positions = []
pos_idx = {}
for r in range(ROWS):
    for c in range(r + 1):
        idx = len(positions)
        positions.append((r, c))
        pos_idx[(r, c)] = idx
N = len(positions)  # 28

adj = [[] for _ in range(N)]
adj_dirs = [[] for _ in range(N)]
for i in range(N):
    r, c = positions[i]
    for d in range(4):
        nr, nc = r + DR[d], c + DC[d]
        if (nr, nc) in pos_idx:
            j = pos_idx[(nr, nc)]
            adj[i].append(j)
            adj_dirs[i].append(d)


class SATEncoder:
    def __init__(self):
        self.var_count = 0
        self.clauses = []

    def new_var(self):
        self.var_count += 1
        return self.var_count

    def new_vars(self, n):
        return [self.new_var() for _ in range(n)]

    def add(self, clause):
        self.clauses.append(clause)

    def add_eq_or(self, a, b, c):
        """a = b OR c"""
        self.add([b, c, -a])
        self.add([-b, a])
        self.add([-c, a])

    def add_eq_and(self, a, b, c):
        """a = b AND c"""
        self.add([-b, -c, a])
        self.add([b, -a])
        self.add([c, -a])

    def add_mux(self, a, s, c_val, b_val):
        """a = IF s THEN c_val ELSE b_val"""
        # a ↔ (s ∧ c_val) ∨ (¬s ∧ b_val)
        self.add([-a, -s, c_val])    # a ∧ s → c_val
        self.add([-a, s, b_val])     # a ∧ ¬s → b_val
        self.add([a, -s, -c_val])    # ¬a ∧ s → ¬c_val ... no
        # Wait, backward:
        # s ∧ c_val → a
        self.clauses[-1] = [a, -s, -c_val]  # wrong, redo
        # Let me redo properly
        self.clauses.pop()
        self.clauses.pop()
        self.clauses.pop()
        # Forward: A → (S?C:B)
        self.add([-a, -s, c_val])     # A ∧ S → C
        self.add([-a, s, b_val])      # A ∧ ¬S → B
        # Backward: (S?C:B) → A
        self.add([-s, -c_val, a])     # S ∧ C → A
        self.add([s, -b_val, a])      # ¬S ∧ B → A

    def encode_position_constraints(self, p, K):
        """Position one-hot + move validity for timesteps 0..K"""
        for t in range(K + 1):
            # ALO: at least one position
            self.add([p[t][i] for i in range(N)])
            # AMO: at most one position (pairwise)
            for i in range(N):
                for j in range(i + 1, N):
                    self.add([-p[t][i], -p[t][j]])

        for t in range(K):
            # Move validity: if at i, next at neighbor of i
            for i in range(N):
                self.add([-p[t][i]] + [p[t+1][j] for j in adj[i]])

    def write_dimacs(self, filename):
        with open(filename, 'w') as f:
            f.write(f"p cnf {self.var_count} {len(self.clauses)}\n")
            for c in self.clauses:
                f.write(' '.join(str(x) for x in c) + ' 0\n')


def encode_lv2(K):
    """LV2: tgt=2, no revert. Cubes go 0→1→2 monotonically."""
    enc = SATEncoder()
    p = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]
    v1 = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]
    v2 = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]

    # Initial
    enc.add([p[0][0]])
    for i in range(1, N):
        enc.add([-p[0][i]])
    for i in range(N):
        enc.add([-v1[0][i]])
        enc.add([-v2[0][i]])

    # Symmetry breaking: first move is DL (to pos 1=(1,0)), not DR (to pos 2=(1,1))
    # The pyramid is mirror-symmetric, so WLOG first move is DL.
    enc.add([p[1][1]])

    # Goal
    for i in range(N):
        enc.add([v2[K][i]])

    enc.encode_position_constraints(p, K)

    for t in range(K):
        for i in range(N):
            # v1[t+1][i] = v1[t][i] OR p[t+1][i]
            enc.add_eq_or(v1[t+1][i], v1[t][i], p[t+1][i])

            # v2[t+1][i] = v2[t][i] OR (v1[t][i] AND p[t+1][i])
            e = enc.new_var()
            enc.add_eq_and(e, v1[t][i], p[t+1][i])
            enc.add_eq_or(v2[t+1][i], v2[t][i], e)

    return enc, p


def encode_lv4(K):
    """LV4: tgt=2, revert 2→1. Cubes: 0→1→2, stepping on 2 reverts to 1."""
    enc = SATEncoder()
    p = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]
    a = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]  # activated (≥1)
    c = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]  # complete (=2)

    # Initial
    enc.add([p[0][0]])
    for i in range(1, N):
        enc.add([-p[0][i]])
    for i in range(N):
        enc.add([-a[0][i]])
        enc.add([-c[0][i]])

    # Goal
    for i in range(N):
        enc.add([c[K][i]])

    enc.encode_position_constraints(p, K)

    for t in range(K):
        for i in range(N):
            # a[t+1][i] = a[t][i] OR p[t+1][i]
            enc.add_eq_or(a[t+1][i], a[t][i], p[t+1][i])

            # c[t+1][i] = IF p[t+1][i] THEN (a[t][i] AND NOT c[t][i]) ELSE c[t][i]
            # val = a[t][i] AND NOT c[t][i]
            val = enc.new_var()
            # val ↔ (a[t][i] ∧ ¬c[t][i])
            enc.add([-a[t][i], c[t][i], val])    # a ∧ ¬c → val
            enc.add([a[t][i], -val])              # ¬a → ¬val
            enc.add([-c[t][i], -val])             # c → ¬val

            # c[t+1][i] = mux(p[t+1][i], val, c[t][i])
            enc.add_mux(c[t+1][i], p[t+1][i], val, c[t][i])

    return enc, p


def encode_lv5(K):
    """LV5: tgt=2, revert 2→0. States cycle 0→1→2→0→1→2..."""
    enc = SATEncoder()
    p = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]
    # 2-bit state per cube: b0[t][i], b1[t][i]
    # state 0 = (0,0), state 1 = (0,1), state 2 = (1,0)
    b0 = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]
    b1 = [[enc.new_var() for _ in range(N)] for _ in range(K + 1)]

    # Initial: all cubes at state 0 (b0=0, b1=0)
    enc.add([p[0][0]])
    for i in range(1, N):
        enc.add([-p[0][i]])
    for i in range(N):
        enc.add([-b0[0][i]])
        enc.add([-b1[0][i]])

    # Goal: all cubes at state 2 (b0=0, b1=1)
    for i in range(N):
        enc.add([-b0[K][i]])  # b0 = 0
        enc.add([b1[K][i]])   # b1 = 1

    enc.encode_position_constraints(p, K)

    for t in range(K):
        for i in range(N):
            # When stepped on (p[t+1][i]):
            #   0(0,0)→1(0,1): new_b0=0, new_b1=1   ... wait

            # Let me use b1=high bit, b0=low bit:
            # state 0 = b1=0,b0=0; state 1 = b1=0,b0=1; state 2 = b1=1,b0=0
            # When stepped on:
            #   0(00) → 1(01): new_b1=0, new_b0=1
            #   1(01) → 2(10): new_b1=1, new_b0=0
            #   2(10) → 0(00): new_b1=0, new_b0=0
            # new_b0 (when stepped) = NOT old_b0 AND NOT old_b1
            # new_b1 (when stepped) = old_b0 AND NOT old_b1

            # Stepped values
            step_b0 = enc.new_var()  # = ¬b0[t][i] ∧ ¬b1[t][i]
            enc.add([b0[t][i], b1[t][i], step_b0])      # ¬b0 ∧ ¬b1 → step_b0
            enc.add([-b0[t][i], -step_b0])               # b0 → ¬step_b0
            enc.add([-b1[t][i], -step_b0])               # b1 → ¬step_b0

            step_b1 = enc.new_var()  # = b0[t][i] ∧ ¬b1[t][i]
            enc.add([-b0[t][i], b1[t][i], step_b1])     # b0 ∧ ¬b1 → step_b1
            enc.add([b0[t][i], -step_b1])                # ¬b0 → ¬step_b1
            enc.add([-b1[t][i], -step_b1])               # b1 → ¬step_b1

            # b0[t+1][i] = IF p[t+1][i] THEN step_b0 ELSE b0[t][i]
            enc.add_mux(b0[t+1][i], p[t+1][i], step_b0, b0[t][i])

            # b1[t+1][i] = IF p[t+1][i] THEN step_b1 ELSE b1[t][i]
            enc.add_mux(b1[t+1][i], p[t+1][i], step_b1, b1[t][i])

    return enc, p


def solve(enc, p, K, label=""):
    """Write DIMACS, run CaDiCaL, parse solution."""
    cnf_file = f"/tmp/qbert_{label}_{K}.cnf"
    enc.write_dimacs(cnf_file)
    print(f"  K={K}: {enc.var_count} vars, {len(enc.clauses)} clauses", end="", flush=True)

    solver = os.environ.get("SAT_SOLVER", "cadical")
    timeout_sec = int(os.environ.get("SAT_TIMEOUT", "600"))
    t0 = time.time()
    result = subprocess.run(
        [solver, cnf_file],
        capture_output=True, text=True, timeout=timeout_sec
    )
    elapsed = time.time() - t0

    if result.returncode == 10:  # SAT
        # Parse solution
        vals = set()
        for line in result.stdout.splitlines():
            if line.startswith('v '):
                for tok in line[2:].split():
                    v = int(tok)
                    if v > 0:
                        vals.add(v)
        print(f" → SAT ({elapsed:.1f}s)")

        # Extract path
        path = []
        for t in range(K + 1):
            for i in range(N):
                if p[t][i] in vals:
                    path.append(i)
                    break
        # Convert to direction sequence
        dirs = []
        for t in range(K):
            src, dst = path[t], path[t+1]
            for j, nbr in enumerate(adj[src]):
                if nbr == dst:
                    dirs.append(adj_dirs[src][j])
                    break
        return True, dirs, path

    elif result.returncode == 20:  # UNSAT
        print(f" → UNSAT ({elapsed:.1f}s)")
        return False, None, None
    else:
        print(f" → ERROR ({result.returncode})")
        print(result.stderr[:500])
        return None, None, None


def find_optimal(encode_fn, label, lo, hi):
    """Search downward from hi (known SAT) until UNSAT. Much faster than binary search."""
    print(f"\n{'='*60}")
    print(f"Finding optimal {label} (search range {lo}-{hi})")
    print(f"{'='*60}")

    best_dirs = None
    best_path = None
    best_k = None

    # Start from top and go down
    for K in range(hi, lo - 1, -1):
        enc, p = encode_fn(K)
        sat, dirs, path = solve(enc, p, K, label)
        if sat:
            best_dirs = dirs
            best_path = path
            best_k = K
        elif sat is False:
            # UNSAT means K is too small, optimal is K+1
            break
        else:
            print(f"  Solver error/timeout at K={K}, stopping")
            break

    if best_dirs:
        print(f"\nOPTIMAL {label}: {best_k} moves")
        tour = [DIR_NAMES[d] for d in best_dirs]
        print(f'{label}_TOUR = {tour}')
    else:
        print(f"\nNo solution found for {label} in range!")

    return best_k, best_dirs


if __name__ == "__main__":
    # Just test specific K values
    if len(sys.argv) > 1:
        lv = sys.argv[1]
        K = int(sys.argv[2])
        encode_fn = {"LV2": encode_lv2, "LV4": encode_lv4, "LV5": encode_lv5}[lv]
        enc, p = encode_fn(K)
        sat, dirs, path = solve(enc, p, K, lv)
        if sat:
            tour = [DIR_NAMES[d] for d in dirs]
            print(f"\n{lv}_TOUR (K={K}) = {tour}")
    else:
        # Full search
        find_optimal(encode_lv2, "LV2", 62, 64)
        find_optimal(encode_lv4, "LV4", 62, 64)
        find_optimal(encode_lv5, "LV5", 72, 77)
