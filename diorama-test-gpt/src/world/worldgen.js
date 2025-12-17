import * as THREE from "three";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";

import { clamp, lerp, smoothstep } from "../utils/math.js";
import { mulberry32 } from "../utils/rng.js";

export function createWorldGen({ worldSeed, randWorld, biomeMode } = {}) {
  if (!Number.isFinite(worldSeed)) throw new Error("createWorldGen: missing worldSeed");
  if (typeof randWorld !== "function") throw new Error("createWorldGen: missing randWorld");
  const biomeModeSafe = typeof biomeMode === "string" ? biomeMode : "mainland";

  const noise = new ImprovedNoise();
  const seed = worldSeed * 0.000123 + 12.345;

  const WORLD = {
    size: 680,
    half: 340,
    terrainSeg: 260,
    waterLevel: -1.25,
    riverWidth: 10,
    riverBankWidth: 22,
    riverDepth: 2.6,
  };

  const WORLD_SPAWN_MUL = 0.93;
  function inSpawnBounds(x, z, mul = WORLD_SPAWN_MUL) {
    return Math.hypot(x, z) <= WORLD.half * mul;
  }

  function getWaterLevel() {
    return BIOME?.kind === "miniIslands" ? BIOME.seaLevel : WORLD.waterLevel;
  }

  function makeRiverProfile() {
    const amp1 = lerp(14, 28, randWorld());
    const amp2 = amp1 * lerp(0.28, 0.7, randWorld());
    const freq = lerp(0.022, 0.048, randWorld());
    const wobbleFreq = lerp(0.012, 0.028, randWorld());
    const wobbleAmp = lerp(1.5, 7.0, randWorld());
    const phase = seed * lerp(0.11, 0.24, randWorld()) + randWorld() * Math.PI * 2;
    return { amp1, amp2, freq, wobbleFreq, wobbleAmp, phase };
  }
  const RIVER_PROFILE = makeRiverProfile();

  function riverCenterX(z) {
    const wobble = noise.noise(0.0, z * RIVER_PROFILE.wobbleFreq, seed + 200) * RIVER_PROFILE.wobbleAmp;
    return (
      RIVER_PROFILE.amp1 * Math.sin(z * RIVER_PROFILE.freq + RIVER_PROFILE.phase) +
      RIVER_PROFILE.amp2 * Math.sin(z * RIVER_PROFILE.freq * 2.17 + 1.1 + RIVER_PROFILE.phase * 0.7) +
      wobble
    );
  }

  function makeBiomeProfile(mode = "mainland") {
    if (mode === "miniIslands") {
      const seaLevel = WORLD.waterLevel + lerp(0.6, 1.15, randWorld());

      const islands = [];
      const countTarget = 18 + Math.floor(randWorld() * 15); // 18..32
      let tries = 0;
      while (islands.length < countTarget && tries < 5000) {
        tries++;
        const x = lerp(-WORLD.half * 0.46, WORLD.half * 0.46, randWorld());
        const z = lerp(-WORLD.half * 0.46, WORLD.half * 0.46, randWorld());
        if (Math.hypot(x, z) > WORLD.half * 0.47) continue;

        const r = lerp(10.0, 26.0, randWorld());
        const height = lerp(3.8, 14.5, randWorld());
        const detail = lerp(0.25, 1.0, randWorld());

        let ok = true;
        for (const o of islands) {
          if (Math.hypot(o.x - x, o.z - z) < (o.r + r) * 0.78) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        islands.push({ x, z, r, height, detail, seed: randWorld() * 1000 });
      }

      // Dummy coast params kept for compatibility with code paths that won't run for this biome.
      return {
        kind: "miniIslands",
        seaLevel,
        islands,
        coastDir: new THREE.Vector2(1, 0),
        shorePos: 0,
        shoreWidth: 1,
        coastDrop: 0,
        coastWaterLevel: seaLevel,
        ponds: [],
        springIndex: -1,
        fall: null,
      };
    }

    const coastAngle = randWorld() * Math.PI * 2;
    const coastDir = new THREE.Vector2(Math.cos(coastAngle), Math.sin(coastAngle)).normalize();
    const shorePos = lerp(0.12, 0.28, randWorld()) * WORLD.half;
    const shoreWidth = lerp(18, 40, randWorld());
    const coastDrop = lerp(10, 18, randWorld());
    const coastWaterLevel = WORLD.waterLevel - lerp(0.35, 1.05, randWorld());

    const ponds = [];
    const pondCount = 2 + Math.floor(randWorld() * 3); // 2..4
    let tries = 0;
    while (ponds.length < pondCount && tries < 650) {
      tries++;
      const x = lerp(-WORLD.half * 0.42, WORLD.half * 0.42, randWorld());
      const z = lerp(-WORLD.half * 0.42, WORLD.half * 0.42, randWorld());
      const cx = riverCenterX(z);
      if (Math.abs(x - cx) < WORLD.riverBankWidth * 0.9) continue;
      const coastCoord = x * coastDir.x + z * coastDir.y;
      if (coastCoord > shorePos + shoreWidth * 0.55) continue;

      const r = lerp(6.5, 14.5, randWorld());
      const depth = lerp(1.1, 3.2, randWorld());
      const fill = lerp(0.35, 1.05, randWorld());

      let ok = true;
      for (const p of ponds) {
        if (Math.hypot(p.x - x, p.z - z) < (p.r + r) * 1.25) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      ponds.push({ x, z, r, depth, fill, level: 0 });
    }

    // Waterfall source: a small spring pond near the river but higher up
    const zW = lerp(-WORLD.half * 0.2, WORLD.half * 0.2, randWorld());
    const cxW = riverCenterX(zW);
    const side = randWorld() < 0.5 ? -1 : 1;
    const xW = cxW + side * lerp(18, 34, randWorld());
    const spring = { x: xW, z: zW, r: lerp(6.0, 10.0, randWorld()), depth: lerp(1.4, 2.8, randWorld()), fill: lerp(0.55, 1.25, randWorld()), level: 0 };
    ponds.push(spring);

    // Waterfall path from spring pond to the river at the same Z
    const fall = {
      x0: xW,
      z0: zW,
      x1: cxW,
      z1: zW,
      width: lerp(1.8, 3.3, randWorld()),
      depth: lerp(1.2, 2.6, randWorld()),
      drop: lerp(8, 14, randWorld()),
    };

    return { kind: "mainland", coastDir, shorePos, shoreWidth, coastDrop, coastWaterLevel, ponds, springIndex: ponds.length - 1, fall };
  }

  const BIOME = makeBiomeProfile(biomeModeSafe);

  function makeTerrainProfile() {
    if (BIOME.kind === "miniIslands") {
      let peakX = 0;
      let peakZ = 0;
      let peakRadius = 40;
      if (BIOME.islands?.length) {
        const big = BIOME.islands.reduce((a, b) => (a.r > b.r ? a : b));
        peakX = big.x;
        peakZ = big.z;
        peakRadius = big.r * 1.25;
      }
      return {
        style: "islands",
        warpScale: 0.0075,
        warpAmp: 16,
        baseAmp: 0,
        ridgeAmp: 0,
        microAmp: 0,
        features: [],
        ridges: [],
        terraceStep: 2,
        terraceStrength: 0,
        peak: { x: peakX, z: peakZ, r: peakRadius },
      };
    }

    const r = randWorld();
    const style = r < 0.26 ? "alpine" : r < 0.54 ? "plateau" : r < 0.78 ? "canyon" : "rolling";

    const warpScale = lerp(0.0048, 0.0092, randWorld());
    const warpAmp = lerp(10, 26, randWorld()) * (style === "alpine" ? 1.15 : style === "canyon" ? 1.05 : 0.95);

    const baseAmp = style === "canyon" ? lerp(5.0, 7.5, randWorld()) : style === "alpine" ? lerp(7.0, 10.5, randWorld()) : lerp(5.5, 9.0, randWorld());
    const ridgeAmp = style === "alpine" ? lerp(3.6, 6.4, randWorld()) : style === "plateau" ? lerp(2.2, 4.4, randWorld()) : lerp(2.6, 5.2, randWorld());
    const microAmp = lerp(0.12, 0.42, randWorld());

    const macroCount = Math.floor(lerp(3, 8, randWorld()));
    const features = [];
    for (let i = 0; i < macroCount; i++) {
      const x = lerp(-WORLD.half * 0.65, WORLD.half * 0.65, randWorld());
      const z = lerp(-WORLD.half * 0.65, WORLD.half * 0.65, randWorld());
      const r0 = lerp(18, 62, randWorld());
      let amp = lerp(5, 18, randWorld());
      if (style === "canyon" && randWorld() < 0.45) amp *= -lerp(0.6, 1.1, randWorld());
      if (style === "plateau" && randWorld() < 0.25) amp *= 0.45;
      features.push({ x, z, r: r0, amp });
    }

    // Ensure a "hero" high hill for a snowy biome (away from the coast if possible)
    let peakX = 0;
    let peakZ = 0;
    let peakOk = false;
    for (let i = 0; i < 80; i++) {
      const x = lerp(-WORLD.half * 0.55, WORLD.half * 0.55, randWorld());
      const z = lerp(-WORLD.half * 0.55, WORLD.half * 0.55, randWorld());
      const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
      if (coastCoord > BIOME.shorePos - BIOME.shoreWidth * 0.35) continue;
      peakX = x;
      peakZ = z;
      peakOk = true;
      break;
    }
    if (!peakOk) {
      peakX = lerp(-WORLD.half * 0.45, WORLD.half * 0.45, randWorld());
      peakZ = lerp(-WORLD.half * 0.45, WORLD.half * 0.45, randWorld());
    }
    features.push({
      x: peakX,
      z: peakZ,
      r: lerp(34, 56, randWorld()),
      amp: lerp(18, 32, randWorld()) * (style === "alpine" ? 1.25 : 1.0),
    });
    const peakRadius = features[features.length - 1].r;

    const ridgeCount = Math.floor(lerp(1, 3, randWorld()));
    const ridges = [];
    for (let i = 0; i < ridgeCount; i++) {
      const px = lerp(-WORLD.half * 0.55, WORLD.half * 0.55, randWorld());
      const pz = lerp(-WORLD.half * 0.55, WORLD.half * 0.55, randWorld());
      const a = randWorld() * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const width = lerp(10, 28, randWorld());
      const amp = (style === "alpine" ? 10.0 : style === "rolling" ? 7.0 : 6.0) * lerp(0.55, 1.05, randWorld());
      ridges.push({ px, pz, dx, dz, width, amp });
    }

    const terraceStep =
      style === "plateau" ? lerp(1.2, 2.8, randWorld()) : style === "canyon" ? lerp(0.9, 2.2, randWorld()) : lerp(0.6, 1.9, randWorld());
    const terraceStrength =
      style === "plateau" ? lerp(0.15, 0.55, randWorld()) : style === "canyon" ? lerp(0.08, 0.35, randWorld()) : lerp(0.05, 0.28, randWorld());

    return { style, warpScale, warpAmp, baseAmp, ridgeAmp, microAmp, features, ridges, terraceStep, terraceStrength, peak: { x: peakX, z: peakZ, r: peakRadius } };
  }
  const TERRAIN_PROFILE = makeTerrainProfile();

  const ECO = (() => {
    const rng = mulberry32(worldSeed ^ 0x6f3a2c91);

    const tmpV2 = new THREE.Vector2();

    // Pick a "volcanic" region center safely inland.
    let vx = 0;
    let vz = 0;
    let ok = false;
    for (let i = 0; i < 160; i++) {
      const x = lerp(-WORLD.half * 0.5, WORLD.half * 0.5, rng());
      const z = lerp(-WORLD.half * 0.5, WORLD.half * 0.5, rng());
      if (BIOME.kind !== "miniIslands") {
        const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
        if (coastCoord > BIOME.shorePos - BIOME.shoreWidth * 0.35) continue;
        if (Math.abs(x - riverCenterX(z)) < WORLD.riverBankWidth * 0.9) continue;
      }
      vx = x;
      vz = z;
      ok = true;
      break;
    }
    if (!ok) {
      vx = lerp(-WORLD.half * 0.35, WORLD.half * 0.35, rng());
      vz = lerp(-WORLD.half * 0.35, WORLD.half * 0.35, rng());
    }

    const volcano = { x: vx, z: vz, r: lerp(44, 70, rng()) };

    // A small "ruins" POI in a dry-ish region.
    let rx = 0;
    let rz = 0;
    ok = false;
    for (let i = 0; i < 220; i++) {
      const x = lerp(-WORLD.half * 0.55, WORLD.half * 0.55, rng());
      const z = lerp(-WORLD.half * 0.55, WORLD.half * 0.55, rng());
      if (Math.hypot(x, z) > WORLD.half * 0.46) continue;
      if (BIOME.kind !== "miniIslands") {
        const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
        if (coastCoord > BIOME.shorePos + BIOME.shoreWidth * 0.65) continue;
        if (Math.abs(x - riverCenterX(z)) < WORLD.riverBankWidth * 0.85) continue;
      }
      rx = x;
      rz = z;
      ok = true;
      break;
    }
    if (!ok) {
      rx = lerp(-WORLD.half * 0.4, WORLD.half * 0.4, rng());
      rz = lerp(-WORLD.half * 0.4, WORLD.half * 0.4, rng());
    }
    const ruins = { x: rx, z: rz, r: lerp(10, 16, rng()) };

    function n01(x, z, scale, off) {
      return clamp(noise.noise(x * scale, z * scale, seed + off) * 0.5 + 0.5, 0, 1);
    }

    function coastCoord(x, z) {
      return x * BIOME.coastDir.x + z * BIOME.coastDir.y;
    }

    function distanceToWater(x, z) {
      let best = 1e9;

      if (BIOME.kind === "miniIslands") {
        // Coastline proxy: distance to sea edge height is cheaper in shaders; here use radial bounds.
        best = Math.min(best, Math.max(0, Math.hypot(x, z) - WORLD.half * 0.46) * 0.85);
      } else {
        // River
        const dRiver = Math.max(0, Math.abs(x - riverCenterX(z)) - WORLD.riverWidth * 0.55);
        best = Math.min(best, dRiver);

        // Coast
        const dCoast = Math.abs(coastCoord(x, z) - BIOME.shorePos);
        best = Math.min(best, dCoast);
      }

      // Ponds
      for (const pond of BIOME.ponds) {
        const d = Math.max(0, Math.hypot(x - pond.x, z - pond.z) - pond.r);
        best = Math.min(best, d);
      }

      return best;
    }

    function waterProximity01(x, z) {
      const d = distanceToWater(x, z);
      return clamp(Math.exp(-(d * d) / (2 * 26 * 26)), 0, 1);
    }

    function temperature01(x, z, y) {
      // Latitude gradient + noise + altitude lapse rate
      const lat01 = clamp((z + WORLD.half) / WORLD.size, 0, 1);
      const base = 0.68 + (0.5 - lat01) * 0.28;
      const n = n01(x, z, 0.0048, 9101) * 0.24 + n01(x, z, 0.011, 9102) * 0.12;
      const alt = smoothstep(6.0, 22.0, y);
      return clamp(base + (n - 0.18) - alt * 0.42, 0, 1);
    }

    function moisture01(x, z, y) {
      const base = n01(x, z, 0.0046, 9201) * 0.65 + n01(x, z, 0.014, 9202) * 0.35;
      const water = waterProximity01(x, z) * (0.35 + 0.65 * (1.0 - smoothstep(getWaterLevel() + 1.0, getWaterLevel() + 8.0, y)));
      const ridge = Math.pow(Math.abs(noise.noise(x * 0.006, z * 0.006, seed + 9301)), 1.5);
      const rainShadow = ridge * 0.15;
      return clamp(base * 0.82 + water * 0.55 - rainShadow, 0, 1);
    }

    function geology01(x, z) {
      // 0..1: higher => more basalt/volcanic, lower => more limestone/granite/clay.
      const g = n01(x, z, 0.0052, 9401) * 0.7 + n01(x, z, 0.018, 9402) * 0.3;
      const dV = Math.hypot(x - volcano.x, z - volcano.z);
      const v = smoothstep(volcano.r * 1.15, volcano.r * 0.25, dV);
      return clamp(lerp(g, 1.0, v * 0.55), 0, 1);
    }

    function sampleTo(out, x, z, y, normalY = 1.0) {
      const t = temperature01(x, z, y);
      const m = moisture01(x, z, y);
      const g = geology01(x, z);
      const wetNear = waterProximity01(x, z);

      const slope = clamp(1.0 - normalY, 0, 1);
      const flat = clamp(Math.pow(Math.max(normalY, 0), 1.35), 0, 1);
      const alt = smoothstep(6.5, 16.0, y);

      const dryness = clamp((1.0 - m) * 0.75 + (0.5 - wetNear) * 0.15, 0, 1);
      const wetland = clamp(m * flat * (1.0 - smoothstep(getWaterLevel() + 1.4, getWaterLevel() + 8.5, y)), 0, 1);
      const alpine = clamp((1.0 - t) * 0.65 + alt * 0.55, 0, 1);
      const volcanic = clamp(smoothstep(0.64, 0.92, g) * (0.35 + 0.65 * smoothstep(volcano.r * 1.05, volcano.r * 0.22, Math.hypot(x - volcano.x, z - volcano.z))), 0, 1);
      const clay = clamp(smoothstep(0.25, 0.55, dryness) * smoothstep(0.22, 0.62, 1.0 - g) * (0.55 + 0.45 * (1.0 - slope)), 0, 1);

      const riparian = BIOME.kind === "miniIslands" ? 0 : clamp(1.0 - smoothstep(WORLD.riverWidth * 1.15, WORLD.riverBankWidth * 1.15, Math.abs(x - riverCenterX(z))), 0, 1);
      const scree = clamp(smoothstep(0.40, 0.78, slope) * smoothstep(0.40, 0.95, 1.0 - m), 0, 1);

      out.temp = t;
      out.moist = m;
      out.geo = g;
      out.dry = dryness;
      out.wetland = wetland;
      out.alpine = alpine;
      out.volcanic = volcanic;
      out.clay = clay;
      out.riparian = riparian;
      out.scree = scree;
      return out;
    }

    return { volcano, ruins, temperature01, moisture01, geology01, waterProximity01, sampleTo, coastCoord, distanceToWater };
  })();

  function terrainHeightRaw(x, z) {
    if (BIOME.kind === "miniIslands") {
      // Archipelago: mostly shallow sea with many small islands.
      const wx = noise.noise(x * 0.0065, z * 0.0065, seed + 101) * 18.0;
      const wz = noise.noise(x * 0.0065, z * 0.0065, seed + 202) * 18.0;
      const xw = x + wx;
      const zw = z + wz;

      const dune = noise.noise(xw * 0.03, zw * 0.03, seed + 901) * 0.55 + noise.noise(xw * 0.09, zw * 0.09, seed + 902) * 0.25;
      let h = lerp(-7.2, -8.6, smoothstep(WORLD.half * 0.42, WORLD.half * 0.5, Math.hypot(x, z))) + dune;

      const sea = BIOME.seaLevel;
      for (const isl of BIOME.islands) {
        const dx = xw - isl.x;
        const dz = zw - isl.z;
        const d = Math.hypot(dx, dz);
        const t = 1 - smoothstep(isl.r * 0.55, isl.r, d);
        if (t <= 0) continue;

        const n = noise.noise((xw + isl.seed) * 0.12, (zw - isl.seed) * 0.12, seed + 400) * 0.5 + 0.5;
        const shape = Math.pow(t, 1.55) * (0.78 + 0.22 * n * isl.detail);
        const beachShelf = (1 - smoothstep(isl.r * 0.72, isl.r * 1.08, d)) * 0.45;
        const target = sea - 0.55 + isl.height * shape + beachShelf;
        h = Math.max(h, target);
      }

      const edge = smoothstep(WORLD.size * 0.42, WORLD.size * 0.5, Math.hypot(x, z));
      h = lerp(h, -9.0, edge);
      return h;
    }

    const wx = noise.noise(x * TERRAIN_PROFILE.warpScale, z * TERRAIN_PROFILE.warpScale, seed + 101) * TERRAIN_PROFILE.warpAmp;
    const wz = noise.noise(x * TERRAIN_PROFILE.warpScale, z * TERRAIN_PROFILE.warpScale, seed + 202) * TERRAIN_PROFILE.warpAmp;
    const xw = x + wx;
    const zw = z + wz;

    const n0 = noise.noise(xw * 0.018, zw * 0.018, seed);
    const n1 = noise.noise(xw * 0.042, zw * 0.042, seed + 10);
    const n2 = noise.noise(xw * 0.088, zw * 0.088, seed + 20);
    const n3 = noise.noise(xw * 0.25, zw * 0.25, seed + 60);
    const base = (n0 * 1.25 + n1 * 0.75 + n2 * 0.35 + n3 * 0.12) / 2.47;

    const ridges = Math.pow(Math.abs(noise.noise(xw * 0.011, zw * 0.011, seed + 40)), 1.85);
    const micro = noise.noise(xw * 0.33, zw * 0.33, seed + 80) * TERRAIN_PROFILE.microAmp;
    let h = base * TERRAIN_PROFILE.baseAmp + ridges * TERRAIN_PROFILE.ridgeAmp + micro;

    // Macro landforms (hills / bowls)
    let macro = 0;
    for (const f of TERRAIN_PROFILE.features) {
      const dx = xw - f.x;
      const dz = zw - f.z;
      const d2 = dx * dx + dz * dz;
      const rr = f.r * f.r;
      macro += f.amp * Math.exp(-d2 / (2 * rr));
    }
    h += macro;

    // Ridge lines (rock formations / escarpments)
    let ridgeLine = 0;
    for (const r of TERRAIN_PROFILE.ridges) {
      const vx = xw - r.px;
      const vz = zw - r.pz;
      const dist = Math.abs(vx * (-r.dz) + vz * r.dx);
      const t = Math.exp(-(dist * dist) / (2 * r.width * r.width));
      ridgeLine += r.amp * t;
    }
    h += ridgeLine;

    // Terracing (subtle)
    const step = TERRAIN_PROFILE.terraceStep;
    const terr = Math.floor(h / step) * step;
    h = lerp(h, terr, TERRAIN_PROFILE.terraceStrength);

    // Sandy coast: pull one side of the world down towards sea level
    const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
    const coastT = smoothstep(BIOME.shorePos - BIOME.shoreWidth * 0.45, BIOME.shorePos + BIOME.shoreWidth, coastCoord);
    if (coastT > 0.0001) {
      const dune = noise.noise(x * 0.06, z * 0.06, seed + 901) * 1.15 + noise.noise(x * 0.12, z * 0.12, seed + 902) * 0.55;
      const seaTarget = BIOME.coastWaterLevel + dune * (0.35 + 0.65 * coastT);
      h = lerp(h, seaTarget, coastT * coastT);
      h -= coastT * BIOME.coastDrop * 0.22;
    }

    // Volcanic region: crater bowl + rim (kept subtle so river/pond logic stays stable).
    {
      const dx = xw - ECO.volcano.x;
      const dz = zw - ECO.volcano.z;
      const d = Math.hypot(dx, dz);
      const r = ECO.volcano.r;
      const bowlT = 1.0 - smoothstep(r * 0.18, r * 0.95, d);
      if (bowlT > 0.001) {
        const u = clamp(d / (r * 0.95), 0, 1);
        const bowl = (1.0 - u) * (1.0 - u);
        const rimW = r * 0.12;
        const rim = Math.exp(-((d - r * 0.55) * (d - r * 0.55)) / (2 * rimW * rimW));
        const n = noise.noise(xw * 0.06, zw * 0.06, seed + 9701) * 0.5 + 0.5;
        h += rim * (2.0 + 2.2 * n);
        h -= bowl * (4.0 + 3.0 * (1.0 - n)) * bowlT;
  	      // Basalt "steps" near volcano (very light).
  	      const stepV = 0.65;
  	      const strengthV = bowlT * 0.22;
  	      h = lerp(h, Math.floor(h / stepV) * stepV, strengthV);
  	    }
  	  }

    // Waterfall ravine from spring pond to the river
    const fall = BIOME.fall;
    if (fall) {
      const ax = fall.x0;
      const az = fall.z0;
      const bx = fall.x1;
      const bz = fall.z1;
      const abx = bx - ax;
      const abz = bz - az;
      const abLen2 = abx * abx + abz * abz + 1e-6;
      const apx = xw - ax;
      const apz = zw - az;
      const t = clamp((apx * abx + apz * abz) / abLen2, 0, 1);
      const cx = ax + abx * t;
      const cz = az + abz * t;
      const dist = Math.hypot(xw - cx, zw - cz);
      const g = Math.exp(-(dist * dist) / (2 * fall.width * fall.width));

      const carve = fall.depth * g * (0.25 + 0.75 * smoothstep(0.0, 1.0, t));
      h -= carve;

      // Extra drop near the start to create a sharp waterfall lip
      const lip = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.12, 0.22, t));
      h -= fall.drop * lip * g;
    }

    // Ponds: carve small basins (including a spring pond used for the waterfall)
    for (const pond of BIOME.ponds) {
      const dx = xw - pond.x;
      const dz = zw - pond.z;
      const d = Math.hypot(dx, dz);
      const r0 = pond.r;
      const t = Math.exp(-(d * d) / (2 * r0 * r0));
      h -= pond.depth * t;
      const rimW = r0 * 0.22;
      const rim = Math.exp(-((d - r0) * (d - r0)) / (2 * rimW * rimW));
      h += rim * pond.depth * 0.18;
    }

    const edge = smoothstep(WORLD.size * 0.42, WORLD.size * 0.5, Math.hypot(x, z));
    h = lerp(h, -9.0, edge);
    return h;
  }

  function terrainHeight(x, z) {
    let h = terrainHeightRaw(x, z);

    if (BIOME.kind === "miniIslands") return h;

    const cx = riverCenterX(z);
    const d = Math.abs(x - cx);
    if (d < WORLD.riverBankWidth) {
      const t = 1 - smoothstep(0, WORLD.riverBankWidth, d);
      const depth = WORLD.riverDepth * t * t;
      h -= depth;
      const bed = WORLD.waterLevel - 0.55;
      const channel = 1 - smoothstep(0, WORLD.riverWidth * 0.55, d);
      h = Math.min(h, lerp(h, bed, channel));
    }

    return h;
  }

  function terrainSlope(x, z) {
    const d = 1.1;
    const hx1 = terrainHeight(x - d, z);
    const hx2 = terrainHeight(x + d, z);
    const hz1 = terrainHeight(x, z - d);
    const hz2 = terrainHeight(x, z + d);
    const sx = (hx2 - hx1) / (2 * d);
    const sz = (hz2 - hz1) / (2 * d);
    return Math.hypot(sx, sz);
  }


  return {
    noise,
    seed,
    WORLD,
    BIOME,
    TERRAIN_PROFILE,
    ECO,
    RIVER_PROFILE,
    inSpawnBounds,
    riverCenterX,
    getWaterLevel,
    terrainHeightRaw,
    terrainHeight,
    terrainSlope,
  };
}
