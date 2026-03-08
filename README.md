# Dino Arcade

Eight classic Atari-era games rebuilt in the visual style of the Chrome offline dinosaur — grayscale only, using the original Chrome Dino sprite sheet.

**[Play at dino.lilwg.com](https://dino.lilwg.com)**

## Games

| Game | Based on |
|------|----------|
| DinoRunner | Chrome Dino (original) |
| DinoInvaders | Space Invaders |
| DinoPong | Pong |
| DinoBreakout | Breakout |
| DinoBeamrider | Beamrider |
| DinoEnduro | Enduro |
| DinoQ\*bert | Q\*bert |
| DinoSeaquest | Seaquest |

Every game includes a rules-based AI mode and a day/night cycle.

## Style

- Background `#f7f7f7`, all game elements `#535353` — no colour
- Sprites sourced from `assets/default_100_percent/100-offline-sprite.png` (the Chrome Dino sheet)
- Night mode via `globalCompositeOperation: difference` + white fill (binary colour flip)
- Shared sound system (`dino-sounds.js`) using Web Audio API with OGG data URIs

## Running locally

```
python3 -m http.server 8765
```

Then open `http://localhost:8765`.
