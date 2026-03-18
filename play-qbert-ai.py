#!/usr/bin/env python3
"""Q*bert AI player using Gymnasium/ALE with RAM-based game state reading."""

import ale_py
import gymnasium as gym
import numpy as np
import time

gym.register_envs(ale_py)

# ─── Q*bert Atari 2600 RAM Map (discovered experimentally) ─────────────────
# The Atari 2600 Q*bert has 128 bytes of RAM.
# We'll discover key addresses by watching RAM changes during gameplay.

# Action mapping: Atari joystick → Q*bert pyramid directions
# The joystick is rotated 45° on the pyramid
ACT_NOOP  = 0
ACT_FIRE  = 1
ACT_UP    = 2  # Up-Right on pyramid (UR)
ACT_RIGHT = 3  # Down-Right on pyramid (DR)
ACT_LEFT  = 4  # Up-Left on pyramid (UL)
ACT_DOWN  = 5  # Down-Left on pyramid (DL)

# Map our AI direction names to Atari actions
DIR_TO_ACTION = {
    'UL': ACT_LEFT,   # Left joystick = Up-Left on pyramid
    'UR': ACT_UP,     # Up joystick = Up-Right on pyramid
    'DL': ACT_DOWN,   # Down joystick = Down-Left on pyramid
    'DR': ACT_RIGHT,  # Right joystick = Down-Right on pyramid
}

# ─── RAM Address Discovery ──────────────────────────────────────────────────
def discover_ram_addresses(env):
    """Play a few moves and identify RAM addresses for key game state."""
    obs, info = env.reset()

    # Wait for game to start
    for _ in range(60):
        obs, r, term, trunc, info = env.step(ACT_NOOP)

    ram_before = env.unwrapped.ale.getRAM().copy()

    # Make a move
    for _ in range(10):
        obs, r, term, trunc, info = env.step(ACT_RIGHT)  # Move down-right
    for _ in range(20):
        obs, r, term, trunc, info = env.step(ACT_NOOP)  # Wait for hop

    ram_after = env.unwrapped.ale.getRAM().copy()

    changed = []
    for i in range(128):
        if ram_before[i] != ram_after[i]:
            changed.append((i, int(ram_before[i]), int(ram_after[i])))

    print("RAM changes after first move:")
    for addr, before, after in changed:
        print(f"  [{addr:3d}] 0x{addr:02x}: {before:3d} -> {after:3d}")

    return changed


# ─── Simple AI Strategy ────────────────────────────────────────────────────
class QbertAI:
    """Simple Q*bert AI that tries to color all cubes efficiently."""

    def __init__(self):
        self.move_count = 0
        self.last_reward_move = 0
        self.total_reward = 0
        self.direction_idx = 0
        # Directions to cycle through for coverage
        self.coverage_pattern = ['DR', 'DL', 'DR', 'DL', 'DR', 'DR', 'UL', 'DL', 'DL', 'DR']

    def pick_direction(self, ram, reward):
        """Pick next direction based on game state."""
        self.total_reward += reward

        if reward > 0:
            self.last_reward_move = self.move_count

        # Simple strategy: follow a coverage pattern down the pyramid
        # If we haven't scored in a while, change strategy
        moves_since_reward = self.move_count - self.last_reward_move

        if moves_since_reward > 10:
            # We're probably stuck or all visible cubes are colored
            # Go back up and try a different path
            dirs = ['UL', 'UR']
            d = dirs[self.move_count % 2]
        else:
            # Follow coverage pattern
            d = self.coverage_pattern[self.direction_idx % len(self.coverage_pattern)]
            self.direction_idx += 1

        self.move_count += 1
        return d

    def get_action(self, ram, reward):
        d = self.pick_direction(ram, reward)
        return DIR_TO_ACTION[d], d


# ─── Main Game Loop ─────────────────────────────────────────────────────────
def play_qbert(render=True, max_steps=10000):
    """Play Q*bert with the AI."""
    render_mode = 'human' if render else None
    env = gym.make('ALE/Qbert-v5', render_mode=render_mode, frameskip=1)
    obs, info = env.reset()

    ai = QbertAI()
    total_reward = 0
    lives = info.get('lives', 4)
    step = 0
    hop_cooldown = 0

    print("Q*bert AI starting!")
    print(f"Actions: {env.unwrapped.get_action_meanings()}")

    while step < max_steps:
        ram = env.unwrapped.ale.getRAM()

        if hop_cooldown > 0:
            # Wait between hops (Q*bert needs time to land)
            action = ACT_NOOP
            hop_cooldown -= 1
            dir_name = "wait"
        else:
            action, dir_name = ai.get_action(ram, 0)
            hop_cooldown = 8  # Wait ~8 frames between hops

        obs, reward, terminated, truncated, info = env.step(action)
        total_reward += reward
        step += 1

        new_lives = info.get('lives', lives)
        if new_lives < lives:
            print(f"  DIED! Lives: {lives} -> {new_lives} (step {step})")
            lives = new_lives
            hop_cooldown = 30  # Wait after respawn

        if reward > 0:
            ai.total_reward = total_reward
            ai.last_reward_move = ai.move_count
            print(f"  +{reward} points! Total: {total_reward} (step {step}, move #{ai.move_count})")

        if terminated or truncated:
            print(f"\nGame Over! Score: {total_reward}, Steps: {step}")
            obs, info = env.reset()
            break

    env.close()
    return total_reward


if __name__ == '__main__':
    import sys

    if '--discover' in sys.argv:
        env = gym.make('ALE/Qbert-v5', render_mode='human')
        discover_ram_addresses(env)
        env.close()
    else:
        score = play_qbert(render=True, max_steps=20000)
        print(f"Final score: {score}")
