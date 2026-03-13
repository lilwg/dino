/*
 * Exact optimal tour solver for Q*bert pyramid using IDA* with MST heuristic.
 *
 * Solves LV1 (tgt=1, simple) and LV3 (tgt=1, toggle).
 * State: (position:5bits, cube_mask:28bits) packed into uint64.
 *
 * LV1: cubes go 0→1 (monotonic). mask = set of completed cubes. Goal: all set.
 * LV3: cubes toggle 0→1→0. mask = current cube states. Goal: all set.
 *
 * Heuristic: MST of remaining incomplete cubes + dist to nearest, using
 *            precomputed BFS distances on the pyramid graph.
 *
 * Compile: gcc -O3 -o tsp-exact tsp-exact.c -lm
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

/* Directions: UL, UR, DL, DR */
static const int DR[4] = {-1, -1, 1, 1};
static const int DC[4] = {-1,  0, 0, 1};
static const char *DIR_NAMES[4] = {"UL", "UR", "DL", "DR"};

/* Position mapping */
static int pos_r[N], pos_c[N];
static int pos_idx[ROWS][ROWS]; /* pos_idx[r][c] = index, -1 if invalid */
static int adj[N][4];           /* adj[i][d] = neighbor index, -1 if none */
static int adj_dir[N][4];       /* direction index for each neighbor */
static int nadj[N];             /* number of valid neighbors */
static int bfs_dist[N][N];      /* all-pairs BFS distances */

/* Solution tracking */
static int best_solution[200];
static int best_len;
static uint64_t nodes_expanded;

/* Transposition table */
#define TT_SIZE (1 << 26)  /* 64M entries */
#define TT_MASK (TT_SIZE - 1)
typedef struct {
    uint64_t key;
    int depth;    /* g when this state was visited */
    int bound;    /* f-limit when visited */
} TTEntry;
static TTEntry *tt;

static void init_graph(void) {
    int idx = 0;
    memset(pos_idx, -1, sizeof(pos_idx));
    for (int r = 0; r < ROWS; r++) {
        for (int c = 0; c <= r; c++) {
            pos_r[idx] = r;
            pos_c[idx] = c;
            pos_idx[r][c] = idx;
            idx++;
        }
    }

    for (int i = 0; i < N; i++) {
        nadj[i] = 0;
        for (int d = 0; d < 4; d++) {
            int nr = pos_r[i] + DR[d];
            int nc = pos_c[i] + DC[d];
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc <= nr) {
                adj[i][nadj[i]] = pos_idx[nr][nc];
                adj_dir[i][nadj[i]] = d;
                nadj[i]++;
            }
        }
    }

    /* BFS all-pairs */
    for (int src = 0; src < N; src++) {
        for (int j = 0; j < N; j++) bfs_dist[src][j] = -1;
        bfs_dist[src][src] = 0;
        int q[N], head = 0, tail = 0;
        q[tail++] = src;
        while (head < tail) {
            int u = q[head++];
            for (int k = 0; k < nadj[u]; k++) {
                int v = adj[u][k];
                if (bfs_dist[src][v] < 0) {
                    bfs_dist[src][v] = bfs_dist[src][u] + 1;
                    q[tail++] = v;
                }
            }
        }
    }
}

/* MST heuristic: lower bound on moves needed to visit all incomplete cubes.
 * Computes MST of {current_pos} ∪ {incomplete cubes} using BFS distances.
 * The MST cost is a lower bound on the walk length.
 */
static int mst_heuristic(int pos, uint32_t mask) {
    uint32_t remaining = ALL_MASK & ~mask;
    if (remaining == 0) return 0;

    /* Collect nodes: current position + all incomplete cubes */
    int nodes[N + 1], nn = 0;
    nodes[nn++] = pos;
    for (int i = 0; i < N; i++) {
        if (remaining & (1u << i)) {
            nodes[nn++] = i;
        }
    }

    /* Prim's MST */
    int in_mst[N + 1];
    int min_edge[N + 1];
    memset(in_mst, 0, sizeof(int) * nn);
    for (int i = 0; i < nn; i++) min_edge[i] = INF;

    in_mst[0] = 1;
    for (int i = 1; i < nn; i++)
        min_edge[i] = bfs_dist[nodes[0]][nodes[i]];

    int total = 0;
    for (int added = 1; added < nn; added++) {
        int best = -1, best_cost = INF;
        for (int i = 1; i < nn; i++) {
            if (!in_mst[i] && min_edge[i] < best_cost) {
                best_cost = min_edge[i];
                best = i;
            }
        }
        if (best < 0) break;
        in_mst[best] = 1;
        total += best_cost;
        for (int i = 1; i < nn; i++) {
            if (!in_mst[i]) {
                int d = bfs_dist[nodes[best]][nodes[i]];
                if (d < min_edge[i]) min_edge[i] = d;
            }
        }
    }
    return total;
}

/* --- LV1: simple (0→1, monotonic) --- */

static int path_lv1[200];

static int ida_search_lv1(int pos, uint32_t mask, int g, int threshold) {
    int h = mst_heuristic(pos, mask);
    int f = g + h;
    if (f > threshold) return f;
    if (mask == ALL_MASK) {
        /* Found solution */
        if (g < best_len) {
            best_len = g;
            memcpy(best_solution, path_lv1, g * sizeof(int));
            printf("  Found: %d moves (nodes expanded: %llu)\n", g, (unsigned long long)nodes_expanded);
        }
        return -1; /* FOUND */
    }

    nodes_expanded++;
    if ((nodes_expanded & 0xFFFFFFF) == 0)
        printf("  ... %llu nodes, g=%d, threshold=%d\n",
               (unsigned long long)nodes_expanded, g, threshold);

    /* Transposition table check */
    uint64_t key = ((uint64_t)mask << 5) | pos;
    uint64_t hash = (key * 0x9E3779B97F4A7C15ULL) >> 38;
    TTEntry *entry = &tt[hash & TT_MASK];
    if (entry->key == key && entry->depth <= g && entry->bound >= threshold) {
        return threshold + 1; /* already explored with same or better parameters */
    }

    int min_next = INF;
    for (int k = 0; k < nadj[pos]; k++) {
        int npos = adj[pos][k];
        int dir = adj_dir[pos][k];
        uint32_t new_mask = mask | (1u << npos);

        path_lv1[g] = dir;
        int result = ida_search_lv1(npos, new_mask, g + 1, threshold);
        if (result == -1) return -1; /* FOUND */
        if (result < min_next) min_next = result;
    }

    /* Store in TT */
    entry->key = key;
    entry->depth = g;
    entry->bound = threshold;

    return min_next;
}

static void solve_lv1(void) {
    printf("=== LV1: tgt=1, simple (exact IDA*) ===\n");
    uint32_t start_mask = 0; /* (0,0) not pre-colored */
    int start_pos = 0;

    best_len = INF;
    nodes_expanded = 0;
    memset(tt, 0, TT_SIZE * sizeof(TTEntry));

    int threshold = mst_heuristic(start_pos, start_mask);
    printf("Initial threshold (MST lower bound): %d\n", threshold);

    clock_t t0 = clock();
    while (threshold < 50 && threshold != -1) {
        printf("Threshold: %d\n", threshold);
        nodes_expanded = 0;
        memset(tt, 0, TT_SIZE * sizeof(TTEntry));
        threshold = ida_search_lv1(start_pos, start_mask, 0, threshold);
        printf("  Nodes expanded: %llu\n", (unsigned long long)nodes_expanded);
    }
    double elapsed = (double)(clock() - t0) / CLOCKS_PER_SEC;
    printf("Time: %.2f seconds\n", elapsed);

    if (best_len < INF) {
        printf("OPTIMAL LV1: %d moves\n", best_len);
        printf("LV1_TOUR = [");
        for (int i = 0; i < best_len; i++) {
            if (i > 0) printf(",");
            printf("\"%s\"", DIR_NAMES[best_solution[i]]);
        }
        printf("]\n");
    } else {
        printf("No solution found!\n");
    }
}

/* --- LV3: toggle (0→1→0→1...) --- */

static int path_lv3[200];

static int ida_search_lv3(int pos, uint32_t mask, int g, int threshold) {
    int h = mst_heuristic(pos, mask);
    int f = g + h;
    if (f > threshold) return f;
    if (mask == ALL_MASK) {
        if (g < best_len) {
            best_len = g;
            memcpy(best_solution, path_lv3, g * sizeof(int));
            printf("  Found: %d moves (nodes expanded: %llu)\n", g, (unsigned long long)nodes_expanded);
        }
        return -1;
    }

    nodes_expanded++;
    if ((nodes_expanded & 0xFFFFFFF) == 0)
        printf("  ... %llu nodes, g=%d, threshold=%d\n",
               (unsigned long long)nodes_expanded, g, threshold);

    uint64_t key = ((uint64_t)mask << 5) | pos;
    uint64_t hash = (key * 0x9E3779B97F4A7C15ULL) >> 38;
    TTEntry *entry = &tt[hash & TT_MASK];
    if (entry->key == key && entry->depth <= g && entry->bound >= threshold) {
        return threshold + 1;
    }

    int min_next = INF;
    for (int k = 0; k < nadj[pos]; k++) {
        int npos = adj[pos][k];
        int dir = adj_dir[pos][k];
        /* Toggle: flip bit npos */
        uint32_t new_mask = mask ^ (1u << npos);

        path_lv3[g] = dir;
        int result = ida_search_lv3(npos, new_mask, g + 1, threshold);
        if (result == -1) return -1;
        if (result < min_next) min_next = result;
    }

    entry->key = key;
    entry->depth = g;
    entry->bound = threshold;

    return min_next;
}

static void solve_lv3(void) {
    printf("\n=== LV3: tgt=1, toggle (exact IDA*) ===\n");
    uint32_t start_mask = 0;
    int start_pos = 0;

    best_len = INF;
    nodes_expanded = 0;
    memset(tt, 0, TT_SIZE * sizeof(TTEntry));

    int threshold = mst_heuristic(start_pos, start_mask);
    printf("Initial threshold (MST lower bound): %d\n", threshold);

    clock_t t0 = clock();
    while (threshold < 60 && threshold != -1) {
        printf("Threshold: %d\n", threshold);
        nodes_expanded = 0;
        memset(tt, 0, TT_SIZE * sizeof(TTEntry));
        threshold = ida_search_lv3(start_pos, start_mask, 0, threshold);
        printf("  Nodes expanded: %llu\n", (unsigned long long)nodes_expanded);
    }
    double elapsed = (double)(clock() - t0) / CLOCKS_PER_SEC;
    printf("Time: %.2f seconds\n", elapsed);

    if (best_len < INF) {
        printf("OPTIMAL LV3: %d moves\n", best_len);
        printf("LV3_TOUR = [");
        for (int i = 0; i < best_len; i++) {
            if (i > 0) printf(",");
            printf("\"%s\"", DIR_NAMES[best_solution[i]]);
        }
        printf("]\n");
    } else {
        printf("No solution found!\n");
    }
}

int main(void) {
    init_graph();

    /* Allocate transposition table */
    tt = (TTEntry *)calloc(TT_SIZE, sizeof(TTEntry));
    if (!tt) {
        fprintf(stderr, "Failed to allocate transposition table\n");
        return 1;
    }

    printf("Q*bert pyramid: %d positions, max BFS distance: ", N);
    int maxd = 0;
    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++)
            if (bfs_dist[i][j] > maxd) maxd = bfs_dist[i][j];
    printf("%d\n", maxd);

    /* Print adjacency for verification */
    printf("Node (0,0) [idx 0] neighbors: ");
    for (int k = 0; k < nadj[0]; k++)
        printf("(%d,%d) ", pos_r[adj[0][k]], pos_c[adj[0][k]]);
    printf("\n\n");

    solve_lv1();
    solve_lv3();

    free(tt);
    return 0;
}
