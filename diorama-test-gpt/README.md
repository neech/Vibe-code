# Diorama Test (Three.js r182)

Small Three.js `r182` diorama with:

- Procedural terrain + meandering river
- Wind-driven grass and tree leaves
- 3D clouds drifting with wind
- Weather modes (auto/clear/windy/rain/snow)
- Snow accumulation + melting
- Dynamic time of day (sun + sky)

## Run

From the repo root:

```bash
cd diorama-test-gpt
python3 -m http.server 8000
```

Open `http://localhost:8000/`.

Note: don’t open `index.html` via `file://` (module scripts/import maps are blocked by CORS in Chromium-based browsers).

## Structure

- `main.js`: entrypoint (imports app)
- `src/app/app.js`: app bootstrap/orchestrator
- `src/render/postprocessing.js`: postprocessing pipeline
- `src/world/worldgen.js`: world generation helpers/data
- `src/`: shared modules (UI/settings, utilities, engine setup)

## Controls

- Mouse/touch: orbit, zoom, pan (right-drag)
- `R`: reset camera
- `H`: hide/show menu
- UI panel: quality preset, season, biome, camera mode (tilt-shift/first person), weather, precipitation, wind, time controls, new world, pause/reset
