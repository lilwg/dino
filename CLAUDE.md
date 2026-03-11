# CLAUDE.md — Dino Arcade

## Project Overview

Dino Arcade is an interactive web platform recreating classic arcade games (DinoRunner, DinoInvaders, DinoPong, DinoBreakout, DinoAsteroids, DinoQbert) in the visual style of Chrome's offline dinosaur game. It serves as an educational exploration of AI techniques for game-playing, from rule-based systems to neural networks.

**Live site:** https://dino.lilwg.com
**Deployed on:** Cloudflare Pages (static files, no server-side processing)

## Architecture

### Zero-dependency static site

- **No build system, no package manager, no framework.** All files are vanilla HTML/JS/CSS served directly.
- No `package.json`, no `node_modules`, no TypeScript, no bundler.
- All code uses IIFEs for namespace isolation; no ES modules or import/export.
- Dependencies are shared via the `window` global object.

### Rendering

- All games use the **Canvas API** for 2D rendering (no DOM-based game rendering).
- Graphics come from Chrome Dino sprite sheets in `assets/default_{100,200}_percent/`.
- Color palette is grayscale only: `#f7f7f7` background, `#535353` game elements.
- Night mode uses `globalCompositeOperation: 'difference'` with white fill for binary color inversion.

### Audio

- Sound effects are base64-encoded OGG data URIs embedded inline.
- Playback via Web Audio API (`dino-sounds.js`).

## File Structure

```
├── index.html              Landing page with game cards
├── app.html                Educational AI demo platform (DinoRunner)
├── dino-runner.html        DinoRunner game
├── dino-invaders.html      Space Invaders variant
├── dino-pong.html          Pong variant
├── dino-breakout.html      Breakout variant
├── dino-asteroids.html     Asteroids variant
├── dino-qbert.html         Q*bert variant
│
├── runner.js               Core DinoRunner engine (~2900 lines, from Chromium source)
├── ai-agent.js             Simulation-based hand-crafted AI
├── rl-agent.js             Neuroevolution agent (50-population ES training)
├── q-learning.js           Tabular Q-Learning (192 discrete states)
├── decision-tree.js        CART decision tree classifier
├── logistic-agent.js       Logistic regression model (12→3 softmax)
├── space-invaders.js       Space Invaders game logic
├── ghost-trex.js           Lightweight physics-only T-Rex clones for parallel RL
├── sim-visualizer.js       Visual AI decision explanation
├── breakout-worker.js      Web Worker for deep lookahead search
├── dino-sounds.js          Web Audio API sound system
│
├── app.css                 Educational platform styling
├── runner.css              Game canvas/UI styling
├── rl-styles.css           AI visualization styling
├── si-styles.css           Space Invaders styling
│
├── *.json                  Pre-trained neural network weight files
├── precomputed-data.js     Serialized trained neural network
├── presaved-gameplay.js    Historical gameplay data
├── cached-weights.js       Weight caching
│
├── assets/
│   ├── default_100_percent/100-offline-sprite.png
│   └── default_200_percent/200-offline-sprite.png
│
├── _headers                Cloudflare Pages cache headers (no-cache on all files)
└── .gitignore
```

## Key Conventions

### Code style
- Vanilla ES5-compatible JavaScript (no TypeScript, no modern module syntax).
- IIFE pattern wraps each file for namespace isolation.
- No linter or formatter is configured — maintain consistency with surrounding code.
- Each AI approach is self-contained in a single file.

### Game physics
- Deterministic: uses seeded PRNG (`mulberry32`) for reproducible obstacle generation.
- Game state is imperative and mutable (no immutable state patterns).

### Adding a new game
1. Create `dino-<game>.html` with canvas and UI markup.
2. Embed or link game logic (inline `<script>` or separate `.js` file).
3. Use sprites from `assets/default_100_percent/100-offline-sprite.png`.
4. Add a card entry to `index.html`.
5. Match the grayscale visual style of existing games.

## Development Workflow

### Running locally
Open any `.html` file directly in a browser, or use any static file server:
```bash
python3 -m http.server 8000
# or
npx serve .
```

### Testing
No automated tests exist. Testing is manual/visual in the browser. Verify:
- Game plays correctly at various speeds.
- AI agents make reasonable decisions.
- No console errors.
- Responsive layout works on different screen sizes.

### Deployment
Push to `master` — Cloudflare Pages auto-deploys static files. The `_headers` file disables caching on all resources.

### Git conventions
- Commit messages follow: `<GameName>: <description>` (e.g., `DinoAsteroids: fix broken rock shapes`).
- Legacy/standalone scripts are listed in `.gitignore` and should not be re-added.

## AI Modules Summary

| Module | Approach | Key Detail |
|--------|----------|------------|
| `ai-agent.js` | Forward simulation | Tests actions by simulating future frames |
| `rl-agent.js` | Neuroevolution (ES) | 50-population evolutionary strategy |
| `q-learning.js` | Tabular Q-Learning | 192 discrete states |
| `decision-tree.js` | CART classifier | Trained on gameplay data |
| `logistic-agent.js` | Logistic regression | 12→3 softmax, 39 parameters |
| `breakout-worker.js` | Lookahead search | Web Worker for deep search |

## Common Pitfalls

- **No module system**: All inter-file communication is through `window` globals. Check existing patterns before adding new globals.
- **runner.js is adapted Chromium code**: Avoid large structural refactors; prefer surgical edits.
- **Weight files are large JSON**: Don't regenerate or modify them unless retraining models.
- **Sprite coordinates are pixel-exact**: Changing sprite sheet dimensions will break all games.
- **Base64 audio is embedded in HTML files**: Sound changes require re-encoding to base64 data URIs.
