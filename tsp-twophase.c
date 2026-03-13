/*
 * Two-phase exact solver for Q*bert LV2 and LV4.
 *
 * LV2 (tgt=2, no revert):  Phase1(LV1) + Phase2(LV1 from end_pos)
 * LV4 (tgt=2, revert 2→1): Phase1(LV1) + Phase2(LV3 from end_pos)
 *
 * Strategy:
 *   1. Solve Phase 2 from all 28 starting positions (both LV1-type and LV3-type)
 *   2. Use combined heuristic in Phase 1 IDA*:
 *      h = MST(remaining) + min(phase2_cost)  for non-goal states
 *      h = phase2_cost[pos]                    for goal states (all visited)
 *      This finds the optimal Phase1+Phase2 total.
 *
 * Compile: gcc -O3 -o tsp-twophase tsp-twophase.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#define ROWS 7
#define N 28
#define ALL_MASK ((1u << N) - 1)
#define INF 9999

static const int DR[4] = {-1, -1, 1, 1};
static const int DC[4] = {-1,  0, 0, 1};
static const char *DIR_NAMES[4] = {"UL", "UR", "DL", "DR"};

static int pos_r[N], pos_c[N];
static int pos_idx[ROWS][ROWS];
static int adj[N][4], adj_dir[N][4], nadj[N];
static int bfs_dist[N][N];

/* Transposition table */
#define TT_SIZE (1 << 26)
#define TT_MASK (TT_SIZE - 1)
typedef struct { uint64_t key; int depth; int bound; } TTEntry;
static TTEntry *tt;

/* Solution tracking */
static int path_buf[200];
static int best_solution[200];
static int best_len;
static uint64_t nodes_expanded;

/* Phase 2 results */
static int phase2_simple_cost[N];   /* LV1-type from each start */
static int phase2_toggle_cost[N];   /* LV3-type from each start */
static int phase2_simple_path[N][100];
static int phase2_toggle_path[N][100];

static void init_graph(void) {
    int idx = 0;
    memset(pos_idx, -1, sizeof(pos_idx));
    for (int r = 0; r < ROWS; r++)
        for (int c = 0; c <= r; c++) {
            pos_r[idx] = r; pos_c[idx] = c;
            pos_idx[r][c] = idx++;
        }
    for (int i = 0; i < N; i++) {
        nadj[i] = 0;
        for (int d = 0; d < 4; d++) {
            int nr = pos_r[i] + DR[d], nc = pos_c[i] + DC[d];
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc <= nr) {
                adj[i][nadj[i]] = pos_idx[nr][nc];
                adj_dir[i][nadj[i]] = d;
                nadj[i]++;
            }
        }
    }
    for (int s = 0; s < N; s++) {
        for (int j = 0; j < N; j++) bfs_dist[s][j] = -1;
        bfs_dist[s][s] = 0;
        int q[N], h = 0, t = 0;
        q[t++] = s;
        while (h < t) {
            int u = q[h++];
            for (int k = 0; k < nadj[u]; k++) {
                int v = adj[u][k];
                if (bfs_dist[s][v] < 0) { bfs_dist[s][v] = bfs_dist[s][u] + 1; q[t++] = v; }
            }
        }
    }
}

static int mst_heuristic(int pos, uint32_t mask) {
    uint32_t remaining = ALL_MASK & ~mask;
    if (remaining == 0) return 0;
    int nodes[N+1], nn = 0;
    nodes[nn++] = pos;
    for (int i = 0; i < N; i++)
        if (remaining & (1u << i)) nodes[nn++] = i;
    int in_mst[N+1], min_edge[N+1];
    memset(in_mst, 0, sizeof(int)*nn);
    for (int i = 0; i < nn; i++) min_edge[i] = INF;
    in_mst[0] = 1;
    for (int i = 1; i < nn; i++) min_edge[i] = bfs_dist[nodes[0]][nodes[i]];
    int total = 0;
    for (int added = 1; added < nn; added++) {
        int best = -1, bc = INF;
        for (int i = 1; i < nn; i++)
            if (!in_mst[i] && min_edge[i] < bc) { bc = min_edge[i]; best = i; }
        if (best < 0) break;
        in_mst[best] = 1; total += bc;
        for (int i = 1; i < nn; i++)
            if (!in_mst[i]) {
                int d = bfs_dist[nodes[best]][nodes[i]];
                if (d < min_edge[i]) min_edge[i] = d;
            }
    }
    return total;
}

/* ================================================================
 * Generic IDA* for "visit all cubes" problems
 * mode=0: simple (0→1 monotonic, like LV1)
 * mode=1: toggle (0↔1, like LV3)
 * ================================================================ */

static int ida_search(int pos, uint32_t mask, int g, int threshold, int mode) {
    int h = mst_heuristic(pos, mask);
    int f = g + h;
    if (f > threshold) return f;
    if (mask == ALL_MASK) {
        if (g < best_len) {
            best_len = g;
            memcpy(best_solution, path_buf, g * sizeof(int));
        }
        return -1;
    }
    nodes_expanded++;

    uint64_t key = ((uint64_t)mask << 5) | pos;
    uint64_t hash = (key * 0x9E3779B97F4A7C15ULL) >> 38;
    TTEntry *e = &tt[hash & TT_MASK];
    if (e->key == key && e->depth <= g && e->bound >= threshold) return threshold + 1;

    int min_next = INF;
    for (int k = 0; k < nadj[pos]; k++) {
        int npos = adj[pos][k], dir = adj_dir[pos][k];
        uint32_t new_mask = (mode == 0) ? (mask | (1u << npos)) : (mask ^ (1u << npos));
        path_buf[g] = dir;
        int result = ida_search(npos, new_mask, g + 1, threshold, mode);
        if (result == -1) return -1;
        if (result < min_next) min_next = result;
    }
    e->key = key; e->depth = g; e->bound = threshold;
    return min_next;
}

static int solve_single(int start_pos, int mode, int *out_path) {
    best_len = INF;
    nodes_expanded = 0;
    memset(tt, 0, TT_SIZE * sizeof(TTEntry));
    int threshold = mst_heuristic(start_pos, 0);
    int max_t = (mode == 0) ? 50 : 60;
    while (threshold < max_t && threshold != -1) {
        nodes_expanded = 0;
        memset(tt, 0, TT_SIZE * sizeof(TTEntry));
        threshold = ida_search(start_pos, 0, 0, threshold, mode);
    }
    if (best_len < INF && out_path)
        memcpy(out_path, best_solution, best_len * sizeof(int));
    return best_len;
}

/* ================================================================
 * Combined Phase 1 IDA* with Phase 2 lookahead
 * Heuristic includes phase2 cost to find optimal total
 * ================================================================ */

static int *p2_costs;     /* pointer to phase2 cost array */
static int p2_min_cost;   /* minimum phase2 cost over all positions */

static int combined_search(int pos, uint32_t mask, int g, int threshold) {
    if (mask == ALL_MASK) {
        int total = g + p2_costs[pos];
        if (total <= threshold && total < best_len) {
            best_len = total;
            memcpy(best_solution, path_buf, g * sizeof(int));
            /* Store ending position in best_solution[g] for retrieval */
            best_solution[g] = pos;
            printf("  Found total=%d (phase1=%d + phase2[%d]=%d)\n",
                   total, g, pos, p2_costs[pos]);
        }
        return (total <= threshold) ? -1 : total;
    }

    int h = mst_heuristic(pos, mask) + p2_min_cost;
    int f = g + h;
    if (f > threshold) return f;

    nodes_expanded++;
    if ((nodes_expanded & 0xFFFFFFF) == 0)
        printf("  ... %llu nodes\n", (unsigned long long)nodes_expanded);

    uint64_t key = ((uint64_t)mask << 5) | pos;
    uint64_t hash = (key * 0x9E3779B97F4A7C15ULL) >> 38;
    TTEntry *e = &tt[hash & TT_MASK];
    if (e->key == key && e->depth <= g && e->bound >= threshold) return threshold + 1;

    int min_next = INF;
    for (int k = 0; k < nadj[pos]; k++) {
        int npos = adj[pos][k], dir = adj_dir[pos][k];
        uint32_t new_mask = mask | (1u << npos);  /* Phase 1 is always simple */
        path_buf[g] = dir;
        int result = combined_search(npos, new_mask, g + 1, threshold);
        if (result == -1) return -1;
        if (result < min_next) min_next = result;
    }
    e->key = key; e->depth = g; e->bound = threshold;
    return min_next;
}

static void solve_combined(const char *label, int *phase2_costs, int *phase2_paths) {
    printf("\n=== %s: Combined Phase1+Phase2 IDA* ===\n", label);

    p2_costs = phase2_costs;
    p2_min_cost = INF;
    for (int i = 0; i < N; i++) {
        printf("  Phase2 from pos %d (%d,%d): %d moves\n", i, pos_r[i], pos_c[i], phase2_costs[i]);
        if (phase2_costs[i] < p2_min_cost) p2_min_cost = phase2_costs[i];
    }
    printf("  Min phase2 cost: %d\n", p2_min_cost);

    best_len = INF;
    nodes_expanded = 0;
    int threshold = mst_heuristic(0, 0) + p2_min_cost;
    printf("  Initial threshold: %d\n", threshold);

    clock_t t0 = clock();
    while (threshold < 90 && threshold != -1) {
        printf("  Threshold: %d\n", threshold);
        nodes_expanded = 0;
        memset(tt, 0, TT_SIZE * sizeof(TTEntry));
        threshold = combined_search(0, 0, 0, threshold);
        printf("    Nodes: %llu\n", (unsigned long long)nodes_expanded);
    }
    double elapsed = (double)(clock() - t0) / CLOCKS_PER_SEC;
    printf("  Time: %.2f seconds\n", elapsed);

    if (best_len < INF) {
        /* Retrieve Phase 1 ending position */
        int p1_len = best_len - phase2_costs[best_solution[/* find end pos */0]];
        /* Actually, best_solution stores the Phase 1 path + end_pos at index p1_len */
        /* Find Phase 1 length by checking all positions */
        int end_pos = -1;
        for (int p1 = 0; p1 <= best_len; p1++) {
            for (int i = 0; i < N; i++) {
                if (p1 + phase2_costs[i] == best_len) {
                    /* Verify by tracing path */
                    end_pos = best_solution[p1]; /* stored by combined_search */
                    if (end_pos >= 0 && end_pos < N && p1 + phase2_costs[end_pos] == best_len) {
                        p1_len = p1;
                        goto found;
                    }
                }
            }
        }
        found:
        printf("\n  OPTIMAL %s: %d total moves (phase1=%d + phase2=%d)\n",
               label, best_len, p1_len, phase2_costs[end_pos]);

        /* Print combined tour */
        printf("  TOUR = [");
        for (int i = 0; i < p1_len; i++) {
            if (i > 0) printf(",");
            printf("\"%s\"", DIR_NAMES[best_solution[i]]);
        }
        /* Append Phase 2 path */
        int *p2path = &phase2_paths[end_pos * 100];
        for (int i = 0; i < phase2_costs[end_pos]; i++) {
            if (p1_len > 0 || i > 0) printf(",");
            printf("\"%s\"", DIR_NAMES[p2path[i]]);
        }
        printf("]\n");
    } else {
        printf("  No solution found!\n");
    }
}

int main(void) {
    init_graph();
    tt = (TTEntry *)calloc(TT_SIZE, sizeof(TTEntry));
    if (!tt) { fprintf(stderr, "OOM\n"); return 1; }

    /* Step 1: Solve Phase 2 (LV1-type) from all 28 positions */
    printf("=== Phase 2 (simple/LV1-type) from all positions ===\n");
    clock_t t0 = clock();
    for (int i = 0; i < N; i++) {
        phase2_simple_cost[i] = solve_single(i, 0, phase2_simple_path[i]);
        printf("  pos %2d (%d,%d): %d moves\n", i, pos_r[i], pos_c[i], phase2_simple_cost[i]);
    }
    printf("  Time: %.2f sec\n\n", (double)(clock()-t0)/CLOCKS_PER_SEC);

    /* Step 2: Solve Phase 2 (LV3-type/toggle) from all 28 positions */
    printf("=== Phase 2 (toggle/LV3-type) from all positions ===\n");
    t0 = clock();
    for (int i = 0; i < N; i++) {
        phase2_toggle_cost[i] = solve_single(i, 1, phase2_toggle_path[i]);
        printf("  pos %2d (%d,%d): %d moves\n", i, pos_r[i], pos_c[i], phase2_toggle_cost[i]);
    }
    printf("  Time: %.2f sec\n", (double)(clock()-t0)/CLOCKS_PER_SEC);

    /* Step 3: Combined optimization */
    solve_combined("LV2", phase2_simple_cost, (int*)phase2_simple_path);
    solve_combined("LV4", phase2_toggle_cost, (int*)phase2_toggle_path);

    free(tt);
    return 0;
}
