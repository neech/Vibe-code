# Cloud Simulation

Procedural cloudscape demo (no external dependencies). Renders volumetric clouds using a WebGL fragment shader (raymarch + noise + lighting).

## Run

- Open `cloud-simulation/index.html` in a real browser (Chrome/Firefox/Safari). IDE “preview” tabs often disable WebGL.
- Or serve locally:
  - `cd cloud-simulation`
  - `python3 -m http.server 8000`
  - Visit `http://localhost:8000`

## Controls

- Left-drag steers the sun direction
- Enable `Fly`: WASD moves, Q/E down/up, right-drag (or Shift-drag) looks around, `R` resets camera
- Enable `Power` for higher-quality clouds; `Soft shadows` is very expensive
