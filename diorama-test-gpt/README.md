# Diorama Test (Three.js r182)

Small Three.js `r182` diorama with:

- Procedural terrain + meandering river
- Wind-driven grass and tree leaves
- 3D clouds drifting with wind
- Weather modes (auto/clear/windy/rain/snow)
- Snow accumulation + melting
- Dynamic time of day (sun + sky)

## Run

From `/Users/allan/Downloads/test code`:

```bash
cd diorama-test-gpt
python3 -m http.server 8000
```

Open `http://localhost:8000/`.

Note: don’t open `index.html` via `file://` (module scripts/import maps are blocked by CORS in Chromium-based browsers).

## Controls

- Mouse/touch: orbit, zoom, pan (right-drag)
- `R`: reset camera
- UI panel: quality preset, season, biome, camera mode (tilt-shift), weather, precipitation, wind, time controls, pause/reset
