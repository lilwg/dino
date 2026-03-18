#!/usr/bin/env python3
"""
Q*bert AI for MAME via Lua bridge.
Terminal 1: rm -rf /tmp/qbert-bridge && mame qbert -rompath ~/mame/roms -autoboot_script /Users/pat/claude/dino/qbert-mame-bridge.lua -autoboot_delay 3
Terminal 2: cd /Users/pat/claude/dino && source venv/bin/activate && python3 qbert-mame-ai.py
(Press any key twice on MAME window to wake it up)
"""
import os, time, signal, sys

BRIDGE = "/tmp/qbert-bridge"
STATE = os.path.join(BRIDGE, "state.txt")
CMD = os.path.join(BRIDGE, "cmd.txt")

def send(cmd):
    os.makedirs(BRIDGE, exist_ok=True)
    with open(CMD, 'w') as f: f.write(cmd + '\n')

def read_state():
    try:
        with open(STATE) as f: lines = f.readlines()
        d = {}
        for l in lines:
            if '=' in l:
                k, v = l.strip().split('=', 1)
                d[k] = v
        return d
    except: return None

def parse_hex(s):
    return [int(b, 16) for b in s.strip().split()]

# Q*bert pyramid helpers
def is_valid(r, c): return 0 <= r < 7 and 0 <= c <= r
def cube_idx(r, c): return r * (r + 1) // 2 + c

DIRS = {'UL': (-1,-1), 'UR': (-1,0), 'DL': (1,0), 'DR': (1,1)}

def bfs_to_uncolored(pr, pc, cubes):
    """BFS from (pr,pc) to nearest uncolored cube."""
    visited = {(pr, pc)}
    queue = [(pr, pc, None)]
    while queue:
        r, c, first = queue.pop(0)
        if first is not None and cube_idx(r, c) < len(cubes) and cubes[cube_idx(r, c)] == 0:
            return first
        for name, (dr, dc) in DIRS.items():
            nr, nc = r + dr, c + dc
            if is_valid(nr, nc) and (nr, nc) not in visited:
                visited.add((nr, nc))
                queue.append((nr, nc, first or name))
    return None

def start_game():
    """Insert coin and start."""
    print("  Starting game...")
    send("COIN")
    time.sleep(0.5)
    send("START")
    time.sleep(3)

def main():
    print("Q*bert MAME AI")
    print("=" * 40)
    print(f"Waiting for MAME bridge...")
    while not os.path.exists(STATE):
        time.sleep(0.5)
    print("Connected!\n")

    start_game()

    moves = 0
    no_progress = 0
    prev_colored = -1
    prev_cubes = None
    est_row, est_col = 0, 0
    game_active = False

    try:
        while True:
            state = read_state()
            if not state: time.sleep(0.1); continue

            # Get cube states from 0x0D00 region
            ram_hex = state.get('RAM', '')
            if not ram_hex: time.sleep(0.1); continue

            ram = parse_hex(ram_hex)
            if len(ram) < 68: time.sleep(0.1); continue

            cubes = ram[40:68]  # 28 cube states
            colored = sum(c == 1 for c in cubes)

            # Detect cube reset (new round or game restart)
            if prev_cubes and colored < prev_colored - 5:
                print(f"  Cubes reset ({prev_colored} -> {colored}) - new round or restart")
                est_row, est_col = 0, 0
                no_progress = 0

            # Detect progress
            if colored != prev_colored:
                if colored > prev_colored and prev_colored >= 0:
                    print(f"  +{colored - prev_colored} cubes! Now {colored}/28")
                no_progress = 0
            else:
                no_progress += 1

            prev_colored = colored
            prev_cubes = cubes[:]

            # If stuck for too long, restart
            if no_progress > 50:
                print(f"  No progress for 50 moves - restarting game")
                no_progress = 0
                est_row, est_col = 0, 0
                start_game()
                continue

            # All cubes colored = round complete, wait for next round
            if colored >= 28:
                print(f"  ROUND COMPLETE! All 28 cubes colored!")
                est_row, est_col = 0, 0
                time.sleep(3)
                no_progress = 0
                continue

            # Detect Q*bert position from newly colored cubes
            if prev_cubes:
                for i in range(28):
                    if prev_cubes[i] == 0 and cubes[i] == 1:
                        # This cube just got colored - Q*bert is here
                        r = 0
                        while (r + 1) * (r + 2) // 2 <= i: r += 1
                        c = i - r * (r + 1) // 2
                        est_row, est_col = r, c

            # Pick direction via BFS
            direction = bfs_to_uncolored(est_row, est_col, cubes)
            if not direction:
                # All reachable cubes colored - try going to other side
                if est_row < 6:
                    direction = 'DL' if est_col > est_row // 2 else 'DR'
                else:
                    direction = 'UL'

            send(direction)
            moves += 1

            # Predict next position (for when no cube change detected)
            dr, dc = DIRS[direction]
            nr, nc = est_row + dr, est_col + dc
            if is_valid(nr, nc):
                est_row, est_col = nr, nc
            else:
                # Jumped off edge - will respawn at apex
                est_row, est_col = 0, 0
                no_progress = 0  # reset stuck counter on death

            if moves % 5 == 0:
                print(f"  #{moves}: {direction} -> ({est_row},{est_col}) | {colored}/28 cubes")

            time.sleep(0.35)

    except KeyboardInterrupt:
        print(f"\nDone! {moves} moves")
    finally:
        send("NONE")

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))
    main()
