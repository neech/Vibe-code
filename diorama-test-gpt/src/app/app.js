import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

import { createEngine } from "../core/engine.js";
import { clamp, fmt01, fmt1, lerp, smoothstep } from "../utils/math.js";
import { mulberry32, resolveWorldSeed } from "../utils/rng.js";
import { ensureVertexColorAttribute } from "../utils/three.js";
import { getDom } from "../ui/dom.js";
import {
  applySavedSettingsToDom,
  loadSettings as loadSettingsFromStorage,
  saveSettings as saveSettingsToStorage,
  setupUi,
  syncSimFromDom,
} from "../ui/settings.js";
import { createPostProcessing } from "../render/postprocessing.js";
import { createWorldGen } from "../world/worldgen.js";
import { createFirstPersonController } from "../controls/firstPerson.js";

const WORLD_SEED = resolveWorldSeed();
const randWorld = mulberry32(WORLD_SEED ^ 0x9e3779b9);
const randSim = mulberry32((WORLD_SEED + 0x6d2b79f5) ^ 0x85ebca6b);

const dom = getDom();

const sharedUniforms = {
  uTime: { value: 0 },
  uRealTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
  uWindStrength: { value: 1 },
  uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
  uSunDirWorld: { value: new THREE.Vector3(0, 1, 0) },
  uSnow: { value: 0 },
  uRainWetness: { value: 0 },
  uSnowColor: { value: new THREE.Color("#f6f9ff") },
  uSnowHeightMin: { value: -2.0 },
  uSnowHeightMax: { value: 6.0 },
  uPeakCenter: { value: new THREE.Vector2(0, 0) },
  uPeakRadius: { value: 48.0 },
  uPeakSnow: { value: 0.85 },
};

const sunDir = new THREE.Vector3();

function addMaterialPatch(material, key, patch) {
  const patches = material.userData.__patches ?? [];
  if (!material.userData.__patches) material.userData.__patches = patches;
  patches.push(key);

  material.customProgramCacheKey = () => patches.join("|");

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    prev?.(shader);
    patch(shader);
  };

  material.needsUpdate = true;
}

const sim = {
  paused: false,
  timeOfDay: Number(dom.time.value),
  timeSpeedHoursPerMinute: Number(dom.timeSpeed.value),
  qualityMode: dom.quality?.value ?? "auto",
  seasonMode: dom.season?.value ?? "auto",
  biomeMode: dom.biome?.value ?? "mainland",
  weatherMode: dom.weather.value,
  precip: Number(dom.precip.value),
  windUser: Number(dom.wind.value),
  cameraMode: dom.cameraMode?.value ?? "normal",
  tiltFocus: Number(dom.tiltFocus?.value ?? 0.56),
  mood: "normal", // "normal" | "golden" | "storm"
  windGust: 0,
  snowCover: 0,
  cloudiness: 0.25,
  activeWeather: "clear",
  autoWeatherTimer: 0,
  autoWeatherTarget: "clear",
  groundWetness: 0,
  rainbow: { t: 0, show: 0 },
  prevWeather: "clear",
  afterRainMist: 0,
  manualTimeDrag: false,
};

let seasonPhase = ((WORLD_SEED >>> 0) % 1000) / 1000;
let seasonState = { name: "summer", snowSimFactor: 0, peakSnow: 0 };

const savedSettings = loadSettingsFromStorage();
if (savedSettings) {
  applySavedSettingsToDom(savedSettings, dom);
  syncSimFromDom(sim, dom);
}

setupUi(dom, sim, {
  save: () => saveSettingsToStorage(sim),
  applyQualityPreset,
  updateSeason,
  resetSim,
  resetCamera,
  newWorld: () => {
    const seedArr = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(seedArr);
    else seedArr[0] = (Math.random() * 0xffffffff) >>> 0;
    const nextSeed = seedArr[0] >>> 0;
    const url = new URL(location.href);
    url.searchParams.set("seed", String(nextSeed));
    location.href = url.toString();
  },
  reload: () => location.reload(),
});

let pixelRatioCap = 2;
const { renderer, scene, camera, controls } = createEngine({ dom, pixelRatioCap });

const firstPerson = createFirstPersonController({ camera, domElement: dom.canvas });
let cameraModeApplied = null;

let waterRTScale = 0.65;
function makeWaterRenderTarget(scale = waterRTScale) {
  const pr = Math.min(window.devicePixelRatio || 1, pixelRatioCap);
  const w = Math.max(2, Math.floor(window.innerWidth * pr * scale));
  const h = Math.max(2, Math.floor(window.innerHeight * pr * scale));
  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    depthBuffer: true,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.depthTexture = new THREE.DepthTexture(w, h);
  rt.depthTexture.format = THREE.DepthFormat;
  rt.depthTexture.type = renderer.capabilities.isWebGL2 ? THREE.UnsignedIntType : THREE.UnsignedShortType;
  return rt;
}
let waterRT = makeWaterRenderTarget();
function resizeWaterRT(scale = waterRTScale) {
  waterRTScale = scale;
  waterRT.dispose();
  waterRT = makeWaterRenderTarget(scale);
}
const waterMeshes = [];
const waterVisCache = [];
function registerWaterMesh(mesh) {
  if (!mesh) return;
  waterMeshes.push(mesh);
}

function resetCamera() {
  camera.position.set(96, 64, 116);
  controls.target.set(0, 10, 0);
  controls.update();
  firstPerson.syncRotationFromCamera();
}

const post = createPostProcessing({ renderer, scene, camera, sim, sunDir, pixelRatioCap });
const starsScene = post.starsScene;

function resetSim() {
  sim.paused = false;
  dom.pause.textContent = "Pause";

  simTime = 0;
  sharedUniforms.uTime.value = 0;

  sim.timeOfDay = 14;
  sim.timeSpeedHoursPerMinute = 2;
  sim.weatherMode = "auto";
  sim.activeWeather = "clear";
  sim.autoWeatherTimer = 0;
  sim.autoWeatherTarget = "clear";
  sim.precip = 0.65;
  sim.windUser = 1;
  sim.cloudiness = 0.25;
  sim.snowCover = 0;

  dom.time.value = String(sim.timeOfDay);
  dom.timeSpeed.value = String(sim.timeSpeedHoursPerMinute);
  dom.weather.value = sim.weatherMode;
  dom.precip.value = String(sim.precip);
  dom.wind.value = String(sim.windUser);

  sharedUniforms.uSnow.value = sim.snowCover;
  sharedUniforms.uWindStrength.value = sim.windUser;
  updateTerrainSnowVolume(terrain, 0, true);
}

function applyCameraMode(mode) {
  const next = mode === "firstperson" ? "firstperson" : "orbit";
  if (cameraModeApplied === next) return;
  cameraModeApplied = next;

  if (next === "firstperson") {
    controls.enabled = false;
    firstPerson.syncRotationFromCamera();
    firstPerson.setEnabled(true);
  } else {
    const wasLocked = firstPerson.isLocked();
    firstPerson.setEnabled(false);
    controls.enabled = true;
    if (wasLocked) {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      controls.target.copy(camera.position).addScaledVector(fwd, 10);
      controls.update();
    }
  }
}

window.addEventListener("resize", () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.setSize(w, h, false);
  resizeWaterRT(waterRTScale);
  syncWaterUniformsNow();
  post.resizeTargets();
});

const hemiLight = new THREE.HemisphereLight(0xcfe9ff, 0x1b2133, 0.55);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff2d5, 1.6);
sunLight.position.set(120, 140, 30);
sunLight.target.position.set(0, 0, 0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
sunLight.shadow.camera.near = 20;
sunLight.shadow.camera.far = 1200;
sunLight.shadow.camera.left = -360;
sunLight.shadow.camera.right = 360;
sunLight.shadow.camera.top = 360;
sunLight.shadow.camera.bottom = -360;
sunLight.shadow.bias = -0.0002;
scene.add(sunLight);
scene.add(sunLight.target);

const COLOR_NIGHT = new THREE.Color("#7aa7ff");
const COLOR_SUNSET = new THREE.Color("#ffb070");
const COLOR_DAY = new THREE.Color("#fff2d5");
const COLOR_HEMI_SKY_NIGHT = new THREE.Color("#89a6ff");
const COLOR_HEMI_SKY_DAY = new THREE.Color("#cfe9ff");
const COLOR_HEMI_GROUND_NIGHT = new THREE.Color("#090d18");
const COLOR_HEMI_GROUND_DAY = new THREE.Color("#1b2133");
const COLOR_FOG_NIGHT = new THREE.Color("#0b1328");
const COLOR_FOG_DAY = new THREE.Color("#a7d0ff");
const COLOR_FOG_CLOUD = new THREE.Color("#d6e6ff");
const COLOR_FOG_SWAMP = new THREE.Color("#4f6b55");
const COLOR_FOG_DUST = new THREE.Color("#d6b18c");
const COLOR_FOG_ASH = new THREE.Color("#6a6d77");
const tmpSunColor = new THREE.Color();
const tmpFogColor = new THREE.Color();
const tmpSkyEco = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };

const sky = new Sky();
sky.scale.setScalar(1500);
sky.material.depthWrite = false;
sky.material.depthTest = false;
// Important: don't apply scene fog to the Sky dome, otherwise the fog color/density dominates and
// "clear" weather can look washed-out/white while overcast can look bluish (fog-tinted).
sky.material.fog = false;
sky.material.needsUpdate = true;
sky.renderOrder = -2;
scene.add(sky);

const skyUniforms = sky.material.uniforms;
skyUniforms.turbidity.value = 8;
skyUniforms.rayleigh.value = 2.2;
skyUniforms.mieCoefficient.value = 0.004;
skyUniforms.mieDirectionalG.value = 0.82;

function createStarField({
  radius = 1500,
  starCount = 12000,
  milkyWayCount = 4200,
  galaxySpriteCount = 2,
  shootingStarMax = 2,
} = {}) {
  const group = new THREE.Group();
  group.frustumCulled = false;
  group.renderOrder = 10;

  const rand = randWorld;

  function makeStarSegmentsGeometry(count, posArr, magArr, colArr, { lenMin = 0.6, lenMax = 2.2, brighten = 1.0 } = {}) {
    const geo = new THREE.BufferGeometry();
    const segPos = new Float32Array(count * 2 * 3);
    const segCol = new Float32Array(count * 2 * 3);

    const p = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const r = new THREE.Vector3();
    const off = new THREE.Vector3();
    const c = new THREE.Color();

    for (let i = 0; i < count; i++) {
      p.set(posArr[i * 3 + 0], posArr[i * 3 + 1], posArr[i * 3 + 2]);
      dir.copy(p).normalize();

      // Tangent basis around the sphere direction.
      // We use a random reference vector and cross to get a stable tangent.
      r.copy(randomUnitVec3());
      a.crossVectors(dir, r);
      if (a.lengthSq() < 1e-6) a.crossVectors(dir, new THREE.Vector3(0, 1, 0));
      a.normalize();
      b.crossVectors(dir, a).normalize();

      const ang = rand() * Math.PI * 2;
      const t = Math.cos(ang);
      const u = Math.sin(ang);

      const mag = magArr ? magArr[i] : 0.5;
      const lumW = magArr ? lerp(0.10, 1.0, 1.0 - mag) : 0.55;
      const len = lerp(lenMin, lenMax, lumW);
      off.copy(a).multiplyScalar(t).addScaledVector(b, u).multiplyScalar(len * 0.5);

      // endpoints
      segPos[(i * 2 + 0) * 3 + 0] = p.x - off.x;
      segPos[(i * 2 + 0) * 3 + 1] = p.y - off.y;
      segPos[(i * 2 + 0) * 3 + 2] = p.z - off.z;
      segPos[(i * 2 + 1) * 3 + 0] = p.x + off.x;
      segPos[(i * 2 + 1) * 3 + 1] = p.y + off.y;
      segPos[(i * 2 + 1) * 3 + 2] = p.z + off.z;

      // per-star brightness baked into color (LineBasicMaterial has only global opacity)
      if (colArr) c.setRGB(colArr[i * 3 + 0], colArr[i * 3 + 1], colArr[i * 3 + 2]);
      else c.setRGB(0.9, 0.95, 1.0);

      const intensity = clamp((0.12 + 0.98 * lumW) * brighten, 0.0, 1.65);
      c.multiplyScalar(intensity);

      segCol[(i * 2 + 0) * 3 + 0] = c.r;
      segCol[(i * 2 + 0) * 3 + 1] = c.g;
      segCol[(i * 2 + 0) * 3 + 2] = c.b;
      segCol[(i * 2 + 1) * 3 + 0] = c.r;
      segCol[(i * 2 + 1) * 3 + 1] = c.g;
      segCol[(i * 2 + 1) * 3 + 2] = c.b;
    }

    geo.setAttribute("position", new THREE.BufferAttribute(segPos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(segCol, 3));
    return geo;
  }

  function randomUnitVec3() {
    const u = rand();
    const v = rand();
    const z = lerp(-1, 1, u);
    const a = v * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return new THREE.Vector3(r * Math.cos(a), z, r * Math.sin(a));
  }

  // --- Base starfield
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(starCount * 3);
  const starMag = new Float32Array(starCount);
  const starSeed = new Float32Array(starCount);
  const starCol = new Float32Array(starCount * 3);

  const c = new THREE.Color();
  const tmp = new THREE.Vector3();
  const brightIndices = [];
  for (let i = 0; i < starCount; i++) {
    tmp.copy(randomUnitVec3());
    // Slight bias toward upper hemisphere (more stars visible above ground)
    if (tmp.y < -0.25) tmp.y = lerp(-0.25, 1.0, rand());
    tmp.normalize().multiplyScalar(radius);

    starPos[i * 3 + 0] = tmp.x;
    starPos[i * 3 + 1] = tmp.y;
    starPos[i * 3 + 2] = tmp.z;

    // Magnitude distribution: many dim, few bright
    const m = Math.pow(rand(), 7.0);
    starMag[i] = m;
    starSeed[i] = rand() * 1000;

    // Star color temperature mix: warm / neutral / cool
    const t = rand();
    const hue = t < 0.18 ? lerp(0.07, 0.11, rand()) : t < 0.8 ? lerp(0.52, 0.62, rand()) : lerp(0.58, 0.68, rand());
    const sat = t < 0.18 ? lerp(0.18, 0.45, rand()) : lerp(0.01, 0.14, rand());
    const lum = lerp(0.55, 0.96, 1 - m);
    c.setHSL(hue, sat, lum);
    starCol[i * 3 + 0] = c.r;
    starCol[i * 3 + 1] = c.g;
    starCol[i * 3 + 2] = c.b;

    if (m < 0.08 && tmp.y > 0.05) brightIndices.push(i);
  }

  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute("aMag", new THREE.BufferAttribute(starMag, 1));
  starGeo.setAttribute("aSeed", new THREE.BufferAttribute(starSeed, 1));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starCol, 3));

  // Stars rendered as line segments (same approach as constellations) for maximum driver reliability.
  const starSegGeo = makeStarSegmentsGeometry(starCount, starPos, starMag, starCol, { lenMin: 0.55, lenMax: 2.0, brighten: 1.1 });
  const starsMat = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.0,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const stars = new THREE.LineSegments(starSegGeo, starsMat);
  stars.frustumCulled = false;
  stars.renderOrder = 10;
  group.add(stars);
  group.userData.stars = stars;

  // A small set of bigger bright stars (helps readability of the night sky)
  const brightCount = Math.min(220, brightIndices.length);
  if (brightCount > 0) {
    const bPos = new Float32Array(brightCount * 3);
    const bCol = new Float32Array(brightCount * 3);
    const bMag = new Float32Array(brightCount);
    for (let i = 0; i < brightCount; i++) {
      const idx = brightIndices[Math.floor(rand() * brightIndices.length)];
      bPos[i * 3 + 0] = starPos[idx * 3 + 0];
      bPos[i * 3 + 1] = starPos[idx * 3 + 1];
      bPos[i * 3 + 2] = starPos[idx * 3 + 2];
      bMag[i] = Math.min(0.18, starMag[idx] * 0.55);
      // Slightly bluish-white
      bCol[i * 3 + 0] = 0.85;
      bCol[i * 3 + 1] = 0.92;
      bCol[i * 3 + 2] = 1.0;
    }
    const bGeo = makeStarSegmentsGeometry(brightCount, bPos, bMag, bCol, { lenMin: 1.2, lenMax: 3.8, brighten: 1.45 });
    const bMat = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.0,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const brightStars = new THREE.LineSegments(bGeo, bMat);
    brightStars.frustumCulled = false;
    brightStars.renderOrder = 10;
    group.add(brightStars);
    group.userData.brightStars = brightStars;
  }

  // --- Milky Way band (colored dust / faint galaxies)
  const mwGeo = new THREE.BufferGeometry();
  const mwPos = new Float32Array(milkyWayCount * 3);
  const mwSeed = new Float32Array(milkyWayCount);
  const mwCol = new Float32Array(milkyWayCount * 3);
  const mwMag = new Float32Array(milkyWayCount);

  const bandNormal = randomUnitVec3().normalize();
  const bandX = new THREE.Vector3(0, 1, 0).cross(bandNormal);
  if (bandX.lengthSq() < 1e-4) bandX.set(1, 0, 0).cross(bandNormal);
  bandX.normalize();
  const bandY = new THREE.Vector3().crossVectors(bandNormal, bandX).normalize();

  for (let i = 0; i < milkyWayCount; i++) {
    const a = rand() * Math.PI * 2;
    const lat = (rand() - 0.5) * (0.24 + 0.55 * Math.pow(rand(), 2.2));
    tmp.copy(bandX).multiplyScalar(Math.cos(a)).addScaledVector(bandY, Math.sin(a));
    tmp.addScaledVector(bandNormal, lat).normalize().multiplyScalar(radius * 0.995);

    mwPos[i * 3 + 0] = tmp.x;
    mwPos[i * 3 + 1] = tmp.y;
    mwPos[i * 3 + 2] = tmp.z;
    mwSeed[i] = rand() * 1000;

    const m = Math.pow(rand(), 5.0);
    mwMag[i] = m;

    // Purples/blues with some warm dust
    const t = rand();
    const hue = t < 0.65 ? lerp(0.56, 0.70, rand()) : lerp(0.03, 0.10, rand());
    const sat = t < 0.65 ? lerp(0.20, 0.65, rand()) : lerp(0.25, 0.55, rand());
    const lum = t < 0.65 ? lerp(0.08, 0.24, 1 - m) : lerp(0.10, 0.22, 1 - m);
    c.setHSL(hue, sat, lum);
    mwCol[i * 3 + 0] = c.r;
    mwCol[i * 3 + 1] = c.g;
    mwCol[i * 3 + 2] = c.b;
  }
  mwGeo.setAttribute("position", new THREE.BufferAttribute(mwPos, 3));
  mwGeo.setAttribute("aMag", new THREE.BufferAttribute(mwMag, 1));
  mwGeo.setAttribute("aSeed", new THREE.BufferAttribute(mwSeed, 1));
  mwGeo.setAttribute("color", new THREE.BufferAttribute(mwCol, 3));

  const mwSegGeo = makeStarSegmentsGeometry(milkyWayCount, mwPos, mwMag, mwCol, { lenMin: 0.8, lenMax: 3.6, brighten: 0.9 });
  const mwMat = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.0,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const milkyWay = new THREE.LineSegments(mwSegGeo, mwMat);
  milkyWay.frustumCulled = false;
  milkyWay.renderOrder = 10;
  group.add(milkyWay);

  // --- Constellations (a few subtle lines between bright stars)
  const constellationGeo = new THREE.BufferGeometry();
  const segPos = [];
  const getStar = (idx) => new THREE.Vector3(starPos[idx * 3 + 0], starPos[idx * 3 + 1], starPos[idx * 3 + 2]);

  const constellationCount = 6;
  const maxSegPerConst = 8;
  const maxAngle = THREE.MathUtils.degToRad(14);

  const used = new Set();
  for (let k = 0; k < constellationCount; k++) {
    if (brightIndices.length < 18) break;
    let start = brightIndices[Math.floor(rand() * brightIndices.length)];
    let guard = 0;
    while (used.has(start) && guard++ < 20) start = brightIndices[Math.floor(rand() * brightIndices.length)];
    used.add(start);

    const chain = [start];
    for (let s = 0; s < maxSegPerConst; s++) {
      const last = chain[chain.length - 1];
      const aPos = getStar(last).clone().normalize();
      let best = -1;
      let bestDot = -1;
      for (let i = 0; i < brightIndices.length; i++) {
        const cand = brightIndices[i];
        if (cand === last) continue;
        if (used.has(cand) && rand() > 0.15) continue;
        const bPos = getStar(cand).clone().normalize();
        const dot = aPos.dot(bPos);
        if (dot < Math.cos(maxAngle)) continue;
        if (dot > bestDot) {
          bestDot = dot;
          best = cand;
        }
      }
      if (best === -1) break;
      used.add(best);
      chain.push(best);
    }

    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const av = getStar(a);
      const bv = getStar(b);
      segPos.push(av.x, av.y, av.z, bv.x, bv.y, bv.z);
    }
  }

  if (segPos.length > 0) {
    constellationGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segPos), 3));
  } else {
    constellationGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  }

  const constellationMat = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.0,
    color: new THREE.Color("#b9cfff"),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });

  const constellations = new THREE.LineSegments(constellationGeo, constellationMat);
  constellations.frustumCulled = false;
  constellations.renderOrder = 10;
  group.add(constellations);

  // --- Galaxy sprites (faint blobs)
	  function makeRadialTexture() {
	    const size = 128;
	    const canvas = document.createElement("canvas");
	    canvas.width = size;
	    canvas.height = size;
	    const ctx = canvas.getContext("2d");
	    const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	    // Important: use *black* at the fully transparent edge so additive blending never produces visible squares
	    // on GPUs/drivers that leak RGB in near-zero alpha texels.
	    grd.addColorStop(0.0, "rgba(255,255,255,0.85)");
	    grd.addColorStop(0.2, "rgba(255,255,255,0.28)");
	    grd.addColorStop(0.55, "rgba(255,255,255,0.06)");
	    grd.addColorStop(1.0, "rgba(0,0,0,0.0)");
	    ctx.fillStyle = grd;
	    ctx.fillRect(0, 0, size, size);
	    const tex = new THREE.CanvasTexture(canvas);
	    tex.colorSpace = THREE.NoColorSpace;
	    tex.generateMipmaps = false;
	    tex.minFilter = THREE.LinearFilter;
	    tex.magFilter = THREE.LinearFilter;
	    return tex;
	  }

  const galaxyTex = makeRadialTexture();
  const galaxySprites = [];
  for (let i = 0; i < galaxySpriteCount; i++) {
    const sprMat = new THREE.SpriteMaterial({
      map: galaxyTex,
      color: new THREE.Color().setHSL(lerp(0.55, 0.75, rand()), lerp(0.25, 0.55, rand()), lerp(0.55, 0.95, rand())),
      transparent: true,
      opacity: 0.0,
      alphaTest: 0.01,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const spr = new THREE.Sprite(sprMat);
    const d = randomUnitVec3();
    d.y = Math.abs(d.y);
	    spr.position.copy(d.normalize().multiplyScalar(radius * 0.985));
	    const size = lerp(4.0, 12.0, rand());
	    const ax = lerp(0.65, 1.25, rand());
	    const ay = lerp(0.65, 1.35, rand());
	    spr.scale.set(size * ax, size * ay, 1);
    spr.material.rotation = rand() * Math.PI * 2;
    spr.frustumCulled = false;
    spr.renderOrder = 10;
    galaxySprites.push(spr);
    group.add(spr);
  }

  // --- Shooting stars
  const shooting = [];
  const shootingGroup = new THREE.Group();
  shootingGroup.frustumCulled = false;
  shootingGroup.renderOrder = 10;
  group.add(shootingGroup);

  function spawnShootingStar() {
    if (shooting.length >= shootingStarMax) return;
    const startDir = randomUnitVec3();
    startDir.y = Math.abs(startDir.y);
    startDir.normalize();

    const axis = randomUnitVec3().normalize();
    const angle = lerp(THREE.MathUtils.degToRad(8), THREE.MathUtils.degToRad(18), rand());
    const velAxis = axis.clone().cross(startDir);
    if (velAxis.lengthSq() < 1e-4) velAxis.set(0, 1, 0).cross(startDir);
    velAxis.normalize();

    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(2 * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));

    const mat = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.0,
      color: new THREE.Color("#dff0ff"),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 10;
    shootingGroup.add(line);

    shooting.push({
      line,
      startDir: startDir.clone(),
      velAxis: velAxis.clone(),
      angle,
      t: 0,
      dur: lerp(0.55, 1.05, rand()),
      tail: lerp(0.06, 0.12, rand()),
    });
  }

  function updateShootingStars(dt, fade) {
    const spawnP = fade > 0.6 ? dt * 0.018 : 0.0;
    if (spawnP > 0 && randSim() < spawnP) spawnShootingStar();

    for (let i = shooting.length - 1; i >= 0; i--) {
      const s = shooting[i];
      s.t += dt;
      const u = s.t / s.dur;
      if (u >= 1) {
        shootingGroup.remove(s.line);
        s.line.geometry.dispose();
        s.line.material.dispose();
        shooting.splice(i, 1);
        continue;
      }

      const headDir = s.startDir.clone().applyAxisAngle(s.velAxis, s.angle * u).normalize();
      const tailDir = s.startDir.clone().applyAxisAngle(s.velAxis, s.angle * Math.max(0, u - s.tail)).normalize();

      const head = headDir.multiplyScalar(radius * 0.996);
      const tail = tailDir.multiplyScalar(radius * 0.996);

      const posAttr = s.line.geometry.getAttribute("position");
      posAttr.setXYZ(0, head.x, head.y, head.z);
      posAttr.setXYZ(1, tail.x, tail.y, tail.z);
      posAttr.needsUpdate = true;

      const a = smoothstep(0.0, 0.15, u) * (1.0 - smoothstep(0.65, 1.0, u));
      s.line.material.opacity = a * fade * 0.95;
    }
  }

  group.userData.setFade = (fade01, cloudShade01, presetName) => {
    const fade = clamp(fade01, 0, 1);
    const cloudShade = clamp(cloudShade01, 0, 1);
    const opacityBase = fade * fade;
    const skyDim = (1.0 - cloudShade * 0.55);
    const starOpacity = opacityBase * 0.85 * skyDim;
    const brightOpacity = opacityBase * 0.55 * skyDim;
    const mwOpacity = opacityBase * 0.35 * (1.0 - cloudShade * 0.25);

    starsMat.opacity = starOpacity;
    if (group.userData.brightStars?.material) group.userData.brightStars.material.opacity = brightOpacity;
    mwMat.opacity = mwOpacity;

    constellationMat.opacity = fade * fade * 0.22 * (1.0 - cloudShade * 0.25);
    for (const spr of galaxySprites) spr.material.opacity = fade * fade * 0.03 * (1.0 - cloudShade * 0.3);
  };

  group.userData.update = (dt, fade01) => {
    updateShootingStars(dt, clamp(fade01, 0, 1));
  };

  return group;
}

// Starfield motion: rotate the whole sky dome as time advances (1 rotation per 24h).
const STARFIELD_TILT = THREE.MathUtils.degToRad(12);
const STARFIELD_ROT_OFFSET =
  (Math.abs(Math.sin(WORLD_SEED * 12.9898 + 78.233)) * 43758.5453) % 1 * (Math.PI * 2);

const starField = createStarField();
starsScene.add(starField);

const worldGen = createWorldGen({ worldSeed: WORLD_SEED, randWorld, biomeMode: sim.biomeMode });
const {
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
} = worldGen;

sharedUniforms.uPeakCenter.value.set(TERRAIN_PROFILE.peak.x, TERRAIN_PROFILE.peak.z);
sharedUniforms.uPeakRadius.value = TERRAIN_PROFILE.peak.r;

firstPerson.setConstraints({
  worldHalf: WORLD.half,
  getGroundHeight: terrainHeight,
  getWaterLevel,
  eyeHeight: 2.1,
});

function makeDioramaBase() {
  const baseGeo = new THREE.BoxGeometry(WORLD.size + 18, 12, WORLD.size + 18, 1, 1, 1);
  const baseMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#2a2d37"),
    roughness: 0.95,
    metalness: 0.05,
  });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.position.set(0, -10.2, 0);
  base.receiveShadow = true;
  base.castShadow = false;
  scene.add(base);
}

function enableSnow(
  material,
  { useLocalY = false, localYMin = 0.35, localYMax = 1.0, snowBoost = 1.0, normalInfluence = 1.0 } = {}
) {
  const cacheKey = `snow:${useLocalY ? "localY" : "world"}:${snowBoost.toFixed(2)}:${normalInfluence.toFixed(2)}`;
  addMaterialPatch(material, cacheKey, (shader) => {
    shader.uniforms.uSnow = sharedUniforms.uSnow;
    shader.uniforms.uSnowColor = sharedUniforms.uSnowColor;
    shader.uniforms.uSnowHeightMin = sharedUniforms.uSnowHeightMin;
    shader.uniforms.uSnowHeightMax = sharedUniforms.uSnowHeightMax;
    shader.uniforms.uPeakCenter = sharedUniforms.uPeakCenter;
    shader.uniforms.uPeakRadius = sharedUniforms.uPeakRadius;
    shader.uniforms.uPeakSnow = sharedUniforms.uPeakSnow;

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vWorldPos;
${useLocalY ? "varying float vLocalY;" : ""}`
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <worldpos_vertex>",
      `#include <worldpos_vertex>
vWorldPos = worldPosition.xyz;
${useLocalY ? "vLocalY = position.y;" : ""}`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
	uniform float uSnow;
	uniform vec3 uSnowColor;
	uniform float uSnowHeightMin;
	uniform float uSnowHeightMax;
	uniform vec2 uPeakCenter;
	uniform float uPeakRadius;
	uniform float uPeakSnow;
	varying vec3 vWorldPos;
	${useLocalY ? "varying float vLocalY;" : ""}`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      `#include <normal_fragment_begin>
	float upTerm = clamp(pow(max(normal.y, 0.0), 1.35), 0.0, 1.0);
	float snowUp = mix(1.0, upTerm, ${clamp(normalInfluence, 0, 1).toFixed(2)});
	float snowHeight = smoothstep(uSnowHeightMin, uSnowHeightMax, vWorldPos.y);
	float snowMaskSim = uSnow * ${snowBoost.toFixed(2)} * snowUp * mix(0.25, 1.0, snowHeight);
	vec2 toPeak = vWorldPos.xz - uPeakCenter;
	float peakD = length(toPeak);
	float peakMask = smoothstep(uPeakRadius, uPeakRadius * 0.55, peakD) * smoothstep(uSnowHeightMax - 2.0, uSnowHeightMax + 5.5, vWorldPos.y);
	float snowMaskPeak = uPeakSnow * peakMask * snowUp;
	float snowMask = max(snowMaskSim, snowMaskPeak);
	${useLocalY ? `snowMask *= smoothstep(${localYMin.toFixed(2)}, ${localYMax.toFixed(2)}, vLocalY);` : ""}
	diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, snowMask);
	roughnessFactor = mix(roughnessFactor, 0.96, snowMask);
	metalnessFactor = mix(metalnessFactor, 0.0, snowMask);`
    );
  });
}

const MAX_WET_PONDS = 6;
function enableTerrainWetness(material) {
  const cacheKey = "wetness:terrain:v1";
  addMaterialPatch(material, cacheKey, (shader) => {
    const ponds = (BIOME?.ponds ?? []).slice(0, MAX_WET_PONDS);
    const pondVecs = Array.from({ length: MAX_WET_PONDS }, () => new THREE.Vector4(0, 0, 0, 0));
    for (let i = 0; i < ponds.length; i++) {
      const p = ponds[i];
      pondVecs[i].set(p.x, p.z, p.r, 0);
    }

    shader.uniforms.uPondCount = { value: ponds.length };
    shader.uniforms.uPonds = { value: pondVecs };
    shader.uniforms.uSeaMode = { value: BIOME.kind === "miniIslands" ? 1 : 0 };
    shader.uniforms.uSeaLevel = { value: BIOME.kind === "miniIslands" ? BIOME.seaLevel : BIOME.coastWaterLevel };
    shader.uniforms.uCoastDir = { value: BIOME.coastDir.clone() };
    shader.uniforms.uShorePos = { value: BIOME.shorePos ?? 0 };
    shader.uniforms.uShoreWidth = { value: BIOME.shoreWidth ?? 1 };
    shader.uniforms.uCoastWaterLevel = { value: BIOME.coastWaterLevel ?? WORLD.waterLevel };
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uRainWetness = sharedUniforms.uRainWetness;

    shader.fragmentShader = shader.fragmentShader.replace(
      "varying vec3 vWorldPos;",
      `varying vec3 vWorldPos;
#define MAX_WET_PONDS ${MAX_WET_PONDS}
uniform int uPondCount;
uniform vec4 uPonds[MAX_WET_PONDS];
uniform float uSeaMode;
uniform float uSeaLevel;
uniform vec2 uCoastDir;
uniform float uShorePos;
uniform float uShoreWidth;
uniform float uCoastWaterLevel;
uniform float uTime;
uniform float uRainWetness;
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
	float wetMaskDyn = 0.0;
	// Pond shoreline wetness ring
	for (int i = 0; i < MAX_WET_PONDS; i++) {
	  if (i >= uPondCount) break;
	  vec4 p = uPonds[i];
	  float d = length(vWorldPos.xz - p.xy);
	  float ringOuter = smoothstep(p.z * 1.35, p.z * 0.90, d);
	  float ringInner = smoothstep(p.z * 0.55, p.z * 0.92, d);
	  wetMaskDyn = max(wetMaskDyn, ringOuter * ringInner);
	}

	// Sea/coast wetness
	float seaWet = 0.0;
	if (uSeaMode > 0.5) {
	  // Mini-islands: use height above sea as proxy for shoreline.
	  seaWet = 1.0 - smoothstep(uSeaLevel + 0.25, uSeaLevel + 2.6, vWorldPos.y);
	} else {
	  float coastCoord = dot(vWorldPos.xz, uCoastDir);
	  float coastT = smoothstep(uShorePos - uShoreWidth * 0.35, uShorePos + uShoreWidth * 0.65, coastCoord);
	  seaWet = coastT * (1.0 - smoothstep(uCoastWaterLevel - 0.25, uCoastWaterLevel + 1.4, vWorldPos.y));
	}
	wetMaskDyn = max(wetMaskDyn, seaWet);
	wetMaskDyn = clamp(wetMaskDyn, 0.0, 1.0);

	// Defer rain puddles to after normals are computed.
	float rainW = clamp(uRainWetness, 0.0, 1.0);
	float puddleDyn = 0.0;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      `#include <normal_fragment_begin>
	// Rain puddles: only on flatter areas and mostly away from shoreline rings.
	float flatMask = clamp(pow(max(normal.y, 0.0), 7.0), 0.0, 1.0);
	float puddleN = hash12(vWorldPos.xz * 0.12 + vec2(uTime * 0.02, uTime * 0.017));
	puddleN = smoothstep(0.72, 0.96, puddleN);
	puddleDyn = rainW * flatMask * puddleN * (1.0 - wetMaskDyn) * 0.85;
	wetMaskDyn = max(wetMaskDyn, puddleDyn);

	diffuseColor.rgb *= mix(1.0, 0.82, wetMaskDyn * 0.55);
	roughnessFactor = mix(roughnessFactor, 0.42, wetMaskDyn * 0.85);
	// Extra sheen on puddles.
	roughnessFactor = mix(roughnessFactor, 0.16, puddleDyn);
	diffuseColor.rgb *= mix(1.0, 0.92, puddleDyn * 0.35);`
    );
  });
}

function enableRainSheen(material, { strength = 1.0, roughnessMin = 0.35, darken = 0.08 } = {}) {
  const cacheKey = `rainSheen:${strength.toFixed(2)}:${roughnessMin.toFixed(2)}:${darken.toFixed(2)}`;
  addMaterialPatch(material, cacheKey, (shader) => {
    shader.uniforms.uRainWetness = sharedUniforms.uRainWetness;
    if (!shader.fragmentShader.includes("uniform float uRainWetness")) {
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nuniform float uRainWetness;`);
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
float rainW = clamp(uRainWetness, 0.0, 1.0) * ${clamp(strength, 0, 2).toFixed(2)};
diffuseColor.rgb *= mix(1.0, ${(1 - clamp(darken, 0, 0.5)).toFixed(2)}, rainW);
roughnessFactor = mix(roughnessFactor, ${clamp(roughnessMin, 0.05, 1).toFixed(2)}, rainW);`
    );
  });
}

function enableWindSway(material, { strength = 1.0, frequency = 1.0 } = {}) {
  const cacheKey = `wind:${strength.toFixed(2)}:${frequency.toFixed(2)}`;
  addMaterialPatch(material, cacheKey, (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWindDir = sharedUniforms.uWindDir;
    shader.uniforms.uWindStrength = sharedUniforms.uWindStrength;

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `vec3 transformed = vec3(position);
vec3 iPos = vec3(0.0);
#ifdef USE_INSTANCING
  iPos = instanceMatrix[3].xyz;
#endif
float phase = (iPos.x + iPos.z) * 0.12;
float gust = (sin(uTime * (0.8 * ${frequency.toFixed(2)}) + phase) * 0.6 + sin(uTime * (1.9 * ${frequency.toFixed(2)}) + phase * 2.1) * 0.4);
float bend = gust * uWindStrength * ${strength.toFixed(2)};
float tip = smoothstep(0.0, 1.0, transformed.y);
vec2 w = normalize(uWindDir) * bend;
transformed.x += w.x * tip * tip * 0.55;
transformed.z += w.y * tip * tip * 0.55;
transformed.x += sin(uTime * 5.5 + phase * 1.7 + transformed.y * 6.0) * 0.02 * tip;`
    );
  });
}

function enableFloatDrift(material, { ampXZ = 0.08, ampY = 0.05, frequency = 1.0 } = {}) {
  const cacheKey = `floatDrift:${ampXZ.toFixed(3)}:${ampY.toFixed(3)}:${frequency.toFixed(2)}`;
  addMaterialPatch(material, cacheKey, (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWindDir = sharedUniforms.uWindDir;
    shader.uniforms.uWindStrength = sharedUniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `vec3 transformed = vec3(position);
vec3 iPos = vec3(0.0);
#ifdef USE_INSTANCING
  iPos = instanceMatrix[3].xyz;
#endif
float wind01 = clamp(uWindStrength / 2.5, 0.0, 1.0);
float ph = (iPos.x * 0.07 + iPos.z * 0.05);
float w0 = sin(uTime * (0.6 * ${frequency.toFixed(2)}) + ph);
float w1 = cos(uTime * (0.95 * ${frequency.toFixed(2)}) + ph * 1.7);
vec2 wd = normalize(uWindDir);
transformed.x += wd.x * (w0 * ${ampXZ.toFixed(3)}) * (0.35 + 0.65 * wind01);
transformed.z += wd.y * (w1 * ${ampXZ.toFixed(3)}) * (0.35 + 0.65 * wind01);
transformed.y += (w0 * 0.65 + w1 * 0.35) * ${ampY.toFixed(3)};`
    );
  });
}

function createTerrain() {
  const geo = new THREE.PlaneGeometry(WORLD.size, WORLD.size, WORLD.terrainSeg, WORLD.terrainSeg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const baseY = new Float32Array(pos.count);
  const snowNoise = new Float32Array(pos.count);
  const snowDry = new Float32Array(pos.count);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    baseY[i] = y;

    let wet = 0;
    if (BIOME.kind === "miniIslands") {
      const sea = BIOME.seaLevel;
      const nearSea = 1 - smoothstep(sea + 0.15, sea + 3.0, y);
      wet = clamp(nearSea, 0, 1);
    } else {
      const cx = riverCenterX(z);
      const d = Math.abs(x - cx);
      const nearRiver = 1 - smoothstep(WORLD.riverWidth * 0.8, WORLD.riverBankWidth, d);
      const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
      const coastT = smoothstep(BIOME.shorePos - BIOME.shoreWidth * 0.45, BIOME.shorePos + BIOME.shoreWidth, coastCoord);

      let pondWet = 0;
      for (const pond of BIOME.ponds) {
        const dd = Math.hypot(x - pond.x, z - pond.z);
        pondWet = Math.max(pondWet, 1 - smoothstep(pond.r * 1.2, pond.r * 2.4, dd));
      }
      const coastWet = coastT * (1 - smoothstep(BIOME.coastWaterLevel - 0.2, BIOME.coastWaterLevel + 2.0, y));
      wet = clamp(nearRiver * 0.8 + pondWet * 0.9 + coastWet * 0.9, 0, 1);
    }
    snowDry[i] = clamp(1 - wet, 0, 1);
    snowNoise[i] = clamp(noise.noise(x * 0.07, z * 0.07, seed + 333) * 0.5 + 0.5, 0, 1);
  }

  geo.computeVertexNormals();

  const colors = new Float32Array(pos.count * 3);
  const normals = geo.attributes.normal;
  const c = new THREE.Color();
  const c2 = new THREE.Color();
  const c3 = new THREE.Color();

  const sandA = new THREE.Color("#cbb88c");
  const sandB = new THREE.Color("#a98d5f");
  const wetSand = new THREE.Color("#7b6a4b");
  const grassA = new THREE.Color("#2c5e2f");
  const grassB = new THREE.Color("#4c7a35");
  const grassDry = new THREE.Color("#8b9155");
  const tundraA = new THREE.Color("#5f6f55");
  const tundraB = new THREE.Color("#7b8765");
  const lichen = new THREE.Color("#9aa37a");
  const peat = new THREE.Color("#2b281f");
  const rockA = new THREE.Color("#4b4e52");
  const rockB = new THREE.Color("#6a6f74");
  const snowBase = new THREE.Color("#f4f7ff");
  const snowBlue = new THREE.Color("#dfe8ff");
  const mud = new THREE.Color("#4b3a2a");
  const ash = new THREE.Color("#2a2a2e");
  const basalt = new THREE.Color("#2e3238");
  const limestone = new THREE.Color("#cfc7b8");
  const clayRed = new THREE.Color("#8a4a33");
  const moss = new THREE.Color("#2d4b2f");
  const marsh = new THREE.Color("#2a3b2b");
  const dryScrub = new THREE.Color("#8c7d47");
  const gravel = new THREE.Color("#5b6169");
  const lushRiparian = new THREE.Color("#2f6f3a");
  const ecoTmp = {
    temp: 0,
    moist: 0,
    geo: 0,
    dry: 0,
    wetland: 0,
    alpine: 0,
    volcanic: 0,
    clay: 0,
    riparian: 0,
    scree: 0,
  };

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = baseY[i];

    const ny = normals.getY(i);
    const slope = clamp(1 - ny, 0, 1);
    const rock = smoothstep(0.22, 0.62, slope);

    const waterLevel = getWaterLevel();
    let beach = 0;
    let nearWater = 0;
    let pondWet = 0;
    let pondInside = 0;
    let wet = 0;
    let dryness = 0;

    if (BIOME.kind === "miniIslands") {
      const aboveSea = y - waterLevel;
      const shore = 1 - smoothstep(0.2, 3.1, Math.max(0, aboveSea));
      beach = shore * (aboveSea > -0.6 ? 1 : 0);
      nearWater = shore;
      wet = clamp(nearWater * 0.9, 0, 1);
      const dryPatch = clamp(noise.noise(x * 0.015, z * 0.015, seed + 778) * 0.5 + 0.5, 0, 1);
      dryness = clamp((1 - wet) * 0.9 + (dryPatch - 0.5) * 0.55, 0, 1);
    } else {
      const cx = riverCenterX(z);
      const d = Math.abs(x - cx);
      const nearRiver = 1 - smoothstep(WORLD.riverWidth * 0.8, WORLD.riverBankWidth, d);

      const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
      const coastT = smoothstep(BIOME.shorePos - BIOME.shoreWidth * 0.45, BIOME.shorePos + BIOME.shoreWidth, coastCoord);
      const lowAlt = 1 - smoothstep(waterLevel + 2.5, waterLevel + 7.5, y);
      beach = coastT * lowAlt;

      for (const pond of BIOME.ponds) {
        const dd = Math.hypot(x - pond.x, z - pond.z);
        pondWet = Math.max(pondWet, 1 - smoothstep(pond.r * 1.1, pond.r * 2.6, dd));
        pondInside = Math.max(pondInside, 1 - smoothstep(pond.r * 0.65, pond.r * 1.02, dd));
      }

      const patch = clamp(noise.noise(x * 0.03, z * 0.03, seed + 777) * 0.5 + 0.5, 0, 1);
      const dryPatch = clamp(noise.noise(x * 0.015, z * 0.015, seed + 778) * 0.5 + 0.5, 0, 1);
      wet = clamp(nearRiver * 0.85 + pondWet * 0.95 + beach * 0.75, 0, 1);
      dryness = clamp((1 - wet) * 0.8 + (dryPatch - 0.5) * 0.6, 0, 1);
      // Recompute patch below for shared material blending.
      // (For islands mode we compute it below too.)
    }

    const patch = clamp(noise.noise(x * 0.03, z * 0.03, seed + 777) * 0.5 + 0.5, 0, 1);

    const alpine = smoothstep(6.5, 13.0, y);
    const peakD = Math.hypot(x - TERRAIN_PROFILE.peak.x, z - TERRAIN_PROFILE.peak.z);
    const peakMask = smoothstep(TERRAIN_PROFILE.peak.r * 1.15, TERRAIN_PROFILE.peak.r * 0.55, peakD);
    const eco = ECO.sampleTo(ecoTmp, x, z, y, ny);

    // Base vegetation / soil
    c.copy(grassA).lerp(grassB, patch);
    c.lerp(grassDry, smoothstep(0.45, 1.0, dryness));
    c.lerp(mud, wet * (0.45 + 0.35 * patch));

    // Biome bands + micro-biomes (temperature/moisture/geology).
    // Wetlands: dark marsh + mossy greens, especially on flatter ground.
    c2.copy(marsh).lerp(moss, clamp(eco.moist, 0, 1) * 0.55);
    c.lerp(c2, clamp(eco.wetland, 0, 1) * 0.75);

    // Riparian strip: lush/saturated near rivers.
    c2.copy(grassB).lerp(lushRiparian, 0.55);
    c.lerp(c2, clamp(eco.riparian, 0, 1) * 0.35 * (1.0 - rock));

    // Dry scrub / red clay: warmer tones in drier areas.
    c2.copy(dryScrub).lerp(grassDry, 0.35);
    c.lerp(c2, smoothstep(0.35, 0.9, eco.dry) * (1.0 - wet) * 0.45);
    c.lerp(clayRed, clamp(eco.clay, 0, 1) * 0.45 * (1.0 - wet));

    // Tundra + sparse vegetation for high hills (pre-snow zone)
    c2.copy(tundraA).lerp(tundraB, patch);
    c2.lerp(lichen, smoothstep(0.55, 1.0, patch));
    const tundraT = alpine * (1.0 - beach) * (0.35 + 0.65 * peakMask);
    c.lerp(c2, tundraT * (0.45 + 0.35 * (1.0 - rock)));
    c.lerp(peat, tundraT * 0.18 * (0.4 + 0.6 * wet));

    // Beach sand + wet shoreline
    c2.copy(sandA).lerp(sandB, patch);
    c2.lerp(wetSand, wet * 0.7);
    c.lerp(c2, clamp(beach * (0.75 + 0.25 * patch), 0, 1));

    // Rock exposure
    c3.copy(rockA).lerp(rockB, patch);
    c.lerp(c3, rock * (0.55 + 0.25 * alpine));

    // Scree and geology.
    c.lerp(gravel, clamp(eco.scree, 0, 1) * 0.55);
    c.lerp(limestone, clamp((1.0 - eco.geo) * 0.35 * rock, 0, 1));
    c.lerp(basalt, clamp(eco.geo * 0.35 * rock, 0, 1));
    c.lerp(ash, clamp(eco.volcanic, 0, 1) * (0.25 + 0.55 * rock));

    // Pond basins: darker wet ground ring
    c.lerp(mud, pondInside * 0.55);

    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const snowWeight = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const ny = normals.getY(i);
    const flat = clamp(Math.pow(Math.max(ny, 0), 1.35), 0, 1);
    const hMask = smoothstep(sharedUniforms.uSnowHeightMin.value, sharedUniforms.uSnowHeightMax.value, baseY[i]);
    snowWeight[i] = flat * hMask * snowDry[i];
  }

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.98,
    metalness: 0.0,
  });
  enableSnow(mat, { useLocalY: false, snowBoost: 1.0 });
  enableTerrainWetness(mat);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData.snowVolume = {
    baseY,
    snowWeight,
    snowNoise,
    lastApplied: -1,
    timer: 0,
  };
  mesh.userData.baseColors = colors.slice();
  mesh.userData.grid = {
    seg: WORLD.terrainSeg,
    row: WORLD.terrainSeg + 1,
    step: WORLD.size / WORLD.terrainSeg,
    pos: geo.attributes.position.array,
  };
  scene.add(mesh);
  return mesh;
}

function updateTerrainSnowVolume(mesh, dt, force = false) {
  const data = mesh?.userData?.snowVolume;
  if (!data) return;

  data.timer = Math.max(0, (data.timer ?? 0) - dt);
  const target = clamp(sim.snowCover * (seasonState?.snowSimFactor ?? 1), 0, 1);
  const delta = Math.abs(target - (data.lastApplied ?? -1));
  if (!force) {
    if (data.timer > 0 && delta < 0.01) return;
    if (delta < 0.002) return;
  }

  data.timer = 0.18;
  data.lastApplied = target;

  const posAttr = mesh.geometry.attributes.position;
  const arr = posAttr.array;
  const baseY = data.baseY;
  const w = data.snowWeight;
  const n = data.snowNoise;

  const maxDepth = 2.2;
  const depth = Math.pow(target, 1.08) * maxDepth;

  for (let i = 0; i < w.length; i++) {
    const lift = depth * w[i] * lerp(0.65, 1.35, n[i]);
    arr[i * 3 + 1] = baseY[i] + lift;
  }
  posAttr.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.attributes.normal.needsUpdate = true;
}

function sampleTerrainSurfaceHeight(mesh, x, z) {
  const grid = mesh?.userData?.grid;
  if (!grid) return terrainHeight(x, z);

  const fx = (x + WORLD.half) / grid.step;
  const fz = (z + WORLD.half) / grid.step;
  const ix = clamp(Math.floor(fx), 0, grid.seg - 1);
  const iz = clamp(Math.floor(fz), 0, grid.seg - 1);
  const tx = clamp(fx - ix, 0, 1);
  const tz = clamp(fz - iz, 0, 1);

  const idx00 = iz * grid.row + ix;
  const idx10 = idx00 + 1;
  const idx01 = (iz + 1) * grid.row + ix;
  const idx11 = idx01 + 1;

  const p = grid.pos;
  const y00 = p[idx00 * 3 + 1];
  const y10 = p[idx10 * 3 + 1];
  const y01 = p[idx01 * 3 + 1];
  const y11 = p[idx11 * 3 + 1];

  const y0 = lerp(y00, y10, tx);
  const y1 = lerp(y01, y11, tx);
  return lerp(y0, y1, tz);
}

function makeSimpleWaterMaterial({ tint = "#4a9ebe", roughness = 0.06, metalness = 0.08, edgeMode = "none", kind = "pond" } = {}) {
  const edgeModeId = edgeMode === "radial" ? 2 : edgeMode === "rect" ? 1 : 0;
  const kindId = kind === "sea" ? 1 : 0;
  const tintColor = tint instanceof THREE.Color ? tint.clone() : new THREE.Color(tint);
  const mat = new THREE.MeshStandardMaterial({
    color: tintColor.clone().lerp(new THREE.Color("#ffffff"), 0.22),
    roughness,
    metalness,
    transparent: true,
    opacity: 1.0,
  });
  // Important for post-composited stars: water must write depth so stars don't show through it.
  // (Terrain is rendered before water, so this won't break transparency layering in this scene.)
  mat.depthWrite = true;

  mat.customProgramCacheKey = () => `water-simple:${edgeModeId}:${kindId}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWindDir = sharedUniforms.uWindDir;
    shader.uniforms.uWindStrength = sharedUniforms.uWindStrength;
    shader.uniforms.uSunDirView = sharedUniforms.uSunDirView;
    shader.uniforms.tSceneColor = { value: waterRT.texture };
    shader.uniforms.tSceneDepth = { value: waterRT.depthTexture };
    shader.uniforms.uResolution = { value: renderer.getDrawingBufferSize(new THREE.Vector2()) };
    shader.uniforms.uNear = { value: camera.near };
    shader.uniforms.uFar = { value: camera.far };
    shader.uniforms.uTint = { value: tintColor };
    shader.uniforms.uEdgeMode = { value: edgeModeId };
    shader.uniforms.uKind = { value: kindId };
    mat.userData.__waterUniforms = shader.uniforms;

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform int uKind;
varying vec3 vWorldPos;
varying vec2 vWaterUv;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `vec3 transformed = vec3(position);
float wind01 = clamp(uWindStrength / 2.5, 0.0, 1.0);
float sea = step(0.5, float(uKind));
float amp = mix(0.02, 0.07, wind01) * mix(1.0, 1.35, sea);
vec2 dir1 = normalize(uWindDir);
vec2 dir2 = vec2(-dir1.y, dir1.x);
float p1 = dot(position.xz, dir1) * 0.08 + uTime * 0.95;
float p2 = dot(position.xz, dir2) * 0.05 + uTime * 0.70;
float waveA = sin(p1) * amp;
float waveB = sin(p2 + uv.x * 2.0) * (amp * 0.65);
float ripple = sin((uv.y * 21.0) + uTime * 1.1 + uv.x * 5.0) * (amp * 0.12);
float swellA = sin(dot(position.xz, dir1) * 0.018 + uTime * 0.32) * mix(0.0, mix(0.015, 0.055, wind01), sea);
float swellB = sin(dot(position.xz, dir2) * 0.014 + uTime * 0.26 + 2.3) * mix(0.0, mix(0.010, 0.040, wind01), sea);
transformed.y += waveA + waveB + ripple + swellA + swellB;
vWaterUv = uv;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <worldpos_vertex>",
      `#include <worldpos_vertex>
vWorldPos = worldPosition.xyz;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
#include <packing>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform vec3 uSunDirView;
uniform sampler2D tSceneColor;
uniform sampler2D tSceneDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform vec3 uTint;
uniform int uEdgeMode;
uniform int uKind;
varying vec3 vWorldPos;
varying vec2 vWaterUv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// Absorption coefficients (Beer–Lambert). Red is absorbed fastest.
const vec3 absorptionPond = vec3(0.45, 0.08, 0.04);
const vec3 absorptionSea = vec3(0.26, 0.06, 0.018);
const vec3 scatterPond = vec3(0.05, 0.15, 0.22);
const vec3 scatterSea = vec3(0.06, 0.22, 0.30);`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>
vec2 wDir = normalize(uWindDir);
vec2 p = vWorldPos.xz;
float wind01 = clamp(uWindStrength / 2.5, 0.0, 1.0);
float sea = step(0.5, float(uKind));

float a1 = mix(0.03, 0.11, wind01) * mix(1.0, 1.25, sea);
float a2 = mix(0.02, 0.08, wind01) * mix(1.0, 1.2, sea);
float f1 = 0.07;
float f2 = 0.045;
float s1 = 0.95;
float s2 = 0.65;

vec2 d1 = wDir;
vec2 d2 = vec2(-wDir.y, wDir.x);
float ph1 = dot(p, d1) * f1 + uTime * s1;
float ph2 = dot(p, d2) * f2 + uTime * s2;
vec2 grad = d1 * (cos(ph1) * a1 * f1) + d2 * (cos(ph2) * a2 * f2);
float micro = cos((p.x + p.y) * 0.22 + uTime * 1.9) * mix(0.004, 0.018, wind01) * mix(1.0, 1.15, sea);
float micro2 = sin(dot(p, vec2(0.18, 0.25)) * 6.0 + uTime * 2.6) * mix(0.0, 0.008, sea);
grad += vec2(micro, micro);
grad += vec2(micro2, -micro2);

vec3 nWorld = normalize(vec3(-grad.x, 1.0, -grad.y));
vec3 nView = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
normal = normalize(mix(normal, nView, 0.9));`
    );

	    shader.fragmentShader = shader.fragmentShader.replace(
	      "#include <output_fragment>",
	      `vec2 uvScreen = gl_FragCoord.xy / max(uResolution, vec2(1.0));
	uvScreen = clamp(uvScreen, vec2(0.001), vec2(0.999));
	float sceneDepth = texture2D(tSceneDepth, uvScreen).x;

float viewZWater = perspectiveDepthToViewZ(gl_FragCoord.z, uNear, uFar);
float viewZScene = perspectiveDepthToViewZ(sceneDepth, uNear, uFar);
float thickness = 0.0;
float sea = step(0.5, float(uKind));
vec3 absorptionCoeff = mix(absorptionPond, absorptionSea, sea);
vec3 scatterColor = mix(scatterPond, scatterSea, sea);
float depthOk = 1.0 - step(0.999999, sceneDepth);
if (depthOk > 0.5) thickness = max(0.0, viewZWater - viewZScene);
// If depth is missing (sky/background), treat sea as deep so it still reads as ocean.
if (depthOk <= 0.5 && sea > 0.5) thickness = 14.0 + wind01 * 8.0;

vec3 viewDir2 = normalize(vViewPosition);
float NdotV = clamp(dot(normalize(normal), viewDir2), 0.0, 1.0);
float fresnel = pow(1.0 - NdotV, 5.0);
fresnel = mix(mix(0.02, 0.035, sea), 1.0, fresnel);

float thick01 = clamp(thickness / 6.0, 0.0, 1.0);
vec2 refr = normalize(normal).xy * mix(0.0015, 0.012, thick01) * (0.35 + 0.65 * (1.0 - fresnel));
vec2 uvRefr = clamp(uvScreen + refr, vec2(0.001), vec2(0.999));
vec3 behind = texture2D(tSceneColor, uvRefr).rgb;

	vec3 absorptionT = exp(-absorptionCoeff * thickness * 2.1);
vec3 refracted = behind * absorptionT;
refracted += scatterColor * (1.0 - absorptionT.b) * 0.55;
refracted = mix(refracted, refracted * uTint, 0.72);

	vec3 reflectCol = outgoingLight * mix(vec3(1.0), uTint, 0.45);
	vec3 finalCol = mix(refracted, reflectCol, fresnel * 0.55);

// Sun glint (cheap specular sparkle, more noticeable for sea)
vec3 N = normalize(normal);
vec3 R = reflect(-viewDir2, N);
float sunDot = max(dot(R, normalize(uSunDirView)), 0.0);
float glint = pow(sunDot, mix(160.0, 260.0, wind01)) * (0.03 + 0.22 * wind01) * sea;
finalCol += vec3(1.0) * glint * 0.55;
finalCol += uTint * glint * 0.25;

	// Shore foam (screen-space shallow water heuristic)
	float shallow = (1.0 - smoothstep(0.35, 2.6, thickness)) * sea;
	float foamN = hash21(p * 0.20 + uTime * 0.02);
	foamN = mix(foamN, sin(dot(p, normalize(uWindDir)) * 0.35 + uTime * 0.9) * 0.5 + 0.5, 0.55);
	float foam = shallow * smoothstep(0.55, 0.95, foamN) * (0.25 + 0.75 * wind01);
	finalCol = mix(finalCol, vec3(0.92, 0.96, 1.0), foam * 0.65);

	// Shallow-water caustics (cheap, depth-based)
	float caA = sin(dot(p, vec2(0.11, 0.09)) * 8.0 + uTime * 1.9);
	float caB = sin(dot(p, vec2(-0.07, 0.13)) * 7.0 - uTime * 1.6);
	float ca = (caA * caB) * 0.5 + 0.5;
	ca = smoothstep(0.55, 0.95, ca);
	float caMask = (1.0 - smoothstep(0.65, 3.1, thickness)) * (0.55 + 0.45 * sea);
	finalCol += vec3(1.0) * ca * caMask * (0.035 + 0.09 * wind01);

	// Ensure water stays visually readable even when thickness is very small.
	float tintBoost = clamp(mix(0.14, 0.08, sea) + thick01 * mix(0.28, 0.14, sea), 0.0, 0.6);
	finalCol = mix(finalCol, mix(finalCol, uTint, 0.35), tintBoost);

float edgeFade = 1.0;
if (uEdgeMode == 1) {
  float edge = min(min(vWaterUv.x, 1.0 - vWaterUv.x), min(vWaterUv.y, 1.0 - vWaterUv.y));
  edgeFade = smoothstep(0.0, 0.08, edge);
} else if (uEdgeMode == 2) {
  float r = length(vWaterUv - 0.5) * 2.0;
  edgeFade = 1.0 - smoothstep(0.88, 1.0, r);
}
	finalCol = mix(behind, finalCol, edgeFade);

// Pond edge foam (radial edge mode)
float pond = 1.0 - sea;
float pondEdge = (uEdgeMode == 2) ? (1.0 - edgeFade) : 0.0;
float pondShallow = (1.0 - smoothstep(0.45, 2.2, thickness));
float pondFoam = pond * pondEdge * pondShallow * smoothstep(0.50, 0.92, foamN) * (0.15 + 0.35 * wind01);
finalCol = mix(finalCol, vec3(0.92, 0.96, 1.0), pondFoam * 0.75);

	outgoingLight = finalCol;
	float alphaDepth = clamp(1.0 - exp(-thickness * mix(0.40, 0.55, sea)), 0.02, mix(0.82, 0.9, sea));
	float alpha = mix(alphaDepth, 0.98, fresnel * 0.55);
	alpha = mix(alpha, 0.98, foam * 0.75);
	alpha = max(alpha, pondFoam * 0.55);
	alpha *= edgeFade;
	diffuseColor.a = max(alpha, mix(0.08, 0.14, sea));

	#include <output_fragment>`
	    );
	  };

  return mat;
}

function createRiver() {
  const segments = 320;
  const positions = new Float32Array(segments * 2 * 3);
  const uvs = new Float32Array(segments * 2 * 2);
  const indices = new Uint16Array((segments - 1) * 6);
  const depthEdge = new Float32Array(segments * 2);
  const depthCenter = new Float32Array(segments * 2);

  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1);
    const z = lerp(-WORLD.half, WORLD.half, t);
    const cx = riverCenterX(z);

    const y = WORLD.waterLevel;
    const w = WORLD.riverWidth;

    const i0 = i * 2;
    const left = new THREE.Vector3(cx - w * 0.5, y, z);
    const right = new THREE.Vector3(cx + w * 0.5, y, z);

    positions.set([left.x, left.y, left.z, right.x, right.y, right.z], i0 * 3);
    uvs.set([0, t * 6.0, 1, t * 6.0], i0 * 2);

    const bedL = terrainHeight(left.x, z);
    const bedR = terrainHeight(right.x, z);
    const bedC = terrainHeight(cx, z);
    const dL = Math.max(0, WORLD.waterLevel - bedL);
    const dR = Math.max(0, WORLD.waterLevel - bedR);
    const dC = Math.max(0, WORLD.waterLevel - bedC);
    depthEdge[i0] = dL;
    depthEdge[i0 + 1] = dR;
    depthCenter[i0] = dC;
    depthCenter[i0 + 1] = dC;

    if (i < segments - 1) {
      const base = i * 6;
      const a = i0;
      const b = i0 + 1;
      const c = i0 + 2;
      const d = i0 + 3;
      indices.set([a, c, b, b, c, d], base);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aDepthEdge", new THREE.BufferAttribute(depthEdge, 1));
  geo.setAttribute("aDepthCenter", new THREE.BufferAttribute(depthCenter, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#4a9ebe"),
    roughness: 0.04,
    metalness: 0.1,
    transparent: true,
    opacity: 1.0,
  });
  // Same reason as ponds/coast: write depth so post stars don't leak through.
  mat.depthWrite = true;

  mat.customProgramCacheKey = () => "river-transparent";
	  mat.onBeforeCompile = (shader) => {
	    shader.uniforms.uTime = sharedUniforms.uTime;
	    shader.uniforms.uWindDir = sharedUniforms.uWindDir;
	    shader.uniforms.uWindStrength = sharedUniforms.uWindStrength;
	    shader.uniforms.tSceneColor = { value: waterRT.texture };
	    shader.uniforms.tSceneDepth = { value: waterRT.depthTexture };
	    shader.uniforms.uResolution = { value: renderer.getDrawingBufferSize(new THREE.Vector2()) };
	    shader.uniforms.uNear = { value: camera.near };
	    shader.uniforms.uFar = { value: camera.far };
	    mat.userData.__waterUniforms = shader.uniforms;

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
varying vec2 vRiverUv;
attribute float aDepthEdge;
attribute float aDepthCenter;
varying float vDepthEdge;
varying float vDepthCenter;
varying vec3 vWorldPos;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `vec3 transformed = vec3(position);
float wind01 = clamp(uWindStrength / 2.5, 0.0, 1.0);
float amp = mix(0.04, 0.10, wind01);
vec2 dir1 = normalize(uWindDir);
vec2 dir2 = vec2(-dir1.y, dir1.x);
float p1 = dot(position.xz, dir1) * 0.11 + uTime * 1.25;
float p2 = dot(position.xz, dir2) * 0.07 + uTime * 0.92;
float waveA = sin(p1) * amp;
float waveB = sin(p2 + uv.x * 2.2) * (amp * 0.65);
float chop = sin((uv.y * 31.0) + uTime * 1.05 + uv.x * 6.0) * (amp * 0.12);
float swell = sin(dot(position.xz, dir1) * 0.03 + uTime * 0.55) * (amp * 0.5);
transformed.y += waveA + waveB + chop + swell;
vRiverUv = uv;
vDepthEdge = aDepthEdge;
vDepthCenter = aDepthCenter;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
#include <packing>
	uniform float uTime;
	uniform vec2 uWindDir;
	uniform float uWindStrength;
	uniform sampler2D tSceneColor;
	uniform sampler2D tSceneDepth;
	uniform vec2 uResolution;
	uniform float uNear;
	uniform float uFar;
	varying float vDepthEdge;
	varying float vDepthCenter;
	varying vec3 vWorldPos;
	varying vec2 vRiverUv;

// Realistic water absorption coefficients (exponential falloff)
vec3 absorptionCoeff = vec3(0.45, 0.08, 0.04); // Red absorbed fastest, blue slowest
vec3 scatterColor = vec3(0.05, 0.15, 0.22); // Scattered light color (subtle blue-green)`
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <worldpos_vertex>",
      `#include <worldpos_vertex>
vWorldPos = worldPosition.xyz;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
// Calculate water depth at this fragment
float centerW = 1.0 - abs(vRiverUv.x - 0.5) * 2.0;
centerW = smoothstep(0.0, 1.0, centerW);
float depth = mix(max(vDepthEdge, 0.0), max(vDepthCenter, 0.0), centerW);

// Normalize depth for effects (max depth ~2.2 units)
float maxDepth = 2.6;
float depth01 = clamp(depth / maxDepth, 0.0, 1.0);

// Realistic depth-based water color using Beer-Lambert law
// Light absorption increases exponentially with depth
vec3 absorption = exp(-absorptionCoeff * depth * 2.5);

// Base water tint - very clear at surface, becomes tinted with depth
vec3 clearWater = vec3(0.92, 0.97, 1.0); // Nearly white/clear at surface
vec3 deepTint = vec3(0.08, 0.28, 0.38); // Deep water color

// Blend based on depth - shallow water shows underlying terrain color
vec3 waterColor = mix(clearWater, deepTint, smoothstep(0.0, 0.8, depth01));
waterColor *= absorption; // Apply absorption
waterColor += scatterColor * (1.0 - absorption.b) * 0.6; // Add scattered light

diffuseColor.rgb = waterColor;

// Subtle flow pattern (reduced intensity for realism)
float flow = sin((vRiverUv.y * 8.0) - uTime * 1.8) * 0.5 + 0.5;
float edge = 1.0 - centerW;

// Foam only at very shallow edges and rapids
float shallowFoam = (1.0 - smoothstep(0.0, 0.15, depth01)) * 0.35;
float edgeFoam = smoothstep(0.88, 1.0, flow) * edge * 0.25;
float foam = clamp(shallowFoam + edgeFoam, 0.0, 0.6);

// White foam color
vec3 foamColor = vec3(0.95, 0.98, 1.0);
diffuseColor.rgb = mix(diffuseColor.rgb, foamColor, foam);`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <output_fragment>",
      `// Screen-space refraction + thickness from a prepass (scene rendered without water)
	vec2 uvScreen = gl_FragCoord.xy / uResolution;
	uvScreen = clamp(uvScreen, vec2(0.001), vec2(0.999));
	float sceneDepth = texture2D(tSceneDepth, uvScreen).x;
	
	float viewZWater = perspectiveDepthToViewZ(gl_FragCoord.z, uNear, uFar);
	float viewZScene = perspectiveDepthToViewZ(sceneDepth, uNear, uFar);
	float thickness = 0.0;
	if (sceneDepth < 0.999999) {
	  thickness = max(0.0, viewZWater - viewZScene);
	}
	
	float centerW2 = 1.0 - abs(vRiverUv.x - 0.5) * 2.0;
	centerW2 = smoothstep(0.0, 1.0, centerW2);
	float depth2 = mix(max(vDepthEdge, 0.0), max(vDepthCenter, 0.0), centerW2);
	float depth01_2 = clamp(depth2 / 2.6, 0.0, 1.0);
	
	// Fresnel effect for realistic reflections at glancing angles
	vec3 viewDir2 = normalize(vViewPosition);
	float NdotV = clamp(dot(normalize(normal), viewDir2), 0.0, 1.0);
	float fresnel = pow(1.0 - NdotV, 5.0);
	fresnel = mix(0.02, 1.0, fresnel);
	
	// Foam
	float edge2 = 1.0 - centerW2;
	float shallowFoam2 = (1.0 - smoothstep(0.0, 0.15, depth01_2)) * 0.35;
	float edgeFoam2 = smoothstep(0.88, 1.0, sin((vRiverUv.y * 8.0) - uTime * 1.8) * 0.5 + 0.5) * edge2 * 0.25;
	float foam2 = clamp(shallowFoam2 + edgeFoam2, 0.0, 0.6);
	
	// Refraction distortion from view-space normal (gentle in shallow water)
	float thick01 = clamp(thickness / 6.0, 0.0, 1.0);
	vec2 refr = normalize(normal).xy * mix(0.0015, 0.012, thick01) * (0.35 + 0.65 * (1.0 - fresnel));
	vec2 uvRefr = clamp(uvScreen + refr, vec2(0.001), vec2(0.999));
	vec3 behind = texture2D(tSceneColor, uvRefr).rgb;
	
	// Beer–Lambert absorption/scatter through the water thickness
	vec3 absorptionT = exp(-absorptionCoeff * thickness * 2.1);
	vec3 refracted = behind * absorptionT;
	refracted += scatterColor * (1.0 - absorptionT.b) * 0.55;
	
	// Combine refraction + water shading (more reflective at glancing angles)
	vec3 finalCol = mix(refracted, outgoingLight, fresnel * 0.78);
	finalCol = mix(finalCol, foamColor, foam2);
	
	// Edge fade blends towards background for seamless riverbanks
	float edgeFade = smoothstep(0.0, 0.12, min(vRiverUv.x, 1.0 - vRiverUv.x));
	finalCol = mix(behind, finalCol, edgeFade);
	
	outgoingLight = finalCol;
	float alphaDepth = clamp(1.0 - exp(-depth2 * 0.45), 0.02, 0.88);
	float alpha = mix(alphaDepth, 0.99, fresnel * 0.62);
	alpha *= edgeFade;
	diffuseColor.a = alpha;
	
	roughnessFactor = mix(0.01, 0.05, fresnel);
	roughnessFactor = mix(roughnessFactor, 0.18, foam2);
	
	#include <output_fragment>`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>
vec2 wDir = normalize(uWindDir);
vec2 p = vWorldPos.xz;
float wind01 = clamp(uWindStrength / 2.5, 0.0, 1.0);

// Gentler wave normals for clearer water visibility
float a1 = mix(0.04, 0.12, wind01);
float a2 = mix(0.03, 0.08, wind01);
float f1 = 0.08;
float f2 = 0.05;
float s1 = 1.1;
float s2 = 0.75;

vec2 d1 = wDir;
vec2 d2 = vec2(-wDir.y, wDir.x);
float ph1 = dot(p, d1) * f1 + uTime * s1;
float ph2 = dot(p, d2) * f2 + uTime * s2;
vec2 grad = d1 * (cos(ph1) * a1 * f1) + d2 * (cos(ph2) * a2 * f2);

// Subtle ripple detail
float ripple = cos((p.x + p.y) * 0.25 + uTime * 2.0) * mix(0.005, 0.02, wind01);
grad += vec2(ripple, ripple);

vec3 nWorld = normalize(vec3(-grad.x, 1.0, -grad.y));
vec3 nView = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
normal = normalize(mix(normal, nView, 0.85));`
    );

  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  registerWaterMesh(mesh);
  return mesh;
}

function computePondWaterLevels(terrainMesh = null) {
  const sample = (x, z) => sampleTerrainSurfaceHeight(terrainMesh, x, z);
  for (const pond of BIOME.ponds) {
    // Basin: sample a few points inside the pond to better handle sloped terrain.
    let basinMin = sample(pond.x, pond.z);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const x = pond.x + Math.cos(a) * pond.r * 0.35;
      const z = pond.z + Math.sin(a) * pond.r * 0.35;
      basinMin = Math.min(basinMin, sample(x, z));
    }

    let level = basinMin + pond.depth * clamp(pond.fill, 0.25, 1.25);

    // Rim: constrain water level to sit below the lowest shoreline point.
    let rimMin = Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = pond.x + Math.cos(a) * pond.r * 1.05;
      const z = pond.z + Math.sin(a) * pond.r * 1.05;
      rimMin = Math.min(rimMin, sample(x, z));
    }

    // Keep water clearly visible above the pond bed, but still below the shoreline rim.
    const minLevel = basinMin + 0.32;
    const maxLevel = rimMin - 0.10;
    if (Number.isFinite(maxLevel)) {
      // If bounds cross, prioritize "don't overflow the rim".
      level = maxLevel <= minLevel ? maxLevel : clamp(level, minLevel, maxLevel);
    } else {
      level = Math.max(level, minLevel);
    }

    pond.level = level;
  }
}

function isCoastSea(x, z, y) {
  if (BIOME.kind === "miniIslands") {
    // Archipelago ocean covers the whole diorama.
    return y < BIOME.seaLevel + 1.3;
  }
  const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
  const coastT = smoothstep(BIOME.shorePos + BIOME.shoreWidth * 0.05, BIOME.shorePos + BIOME.shoreWidth * 0.95, coastCoord);
  if (coastT < 0.001) return false;
  return y < BIOME.coastWaterLevel + 1.3;
}

function isPondWater(x, z, y) {
  for (const pond of BIOME.ponds) {
    const d = Math.hypot(x - pond.x, z - pond.z);
    if (d < pond.r * 0.96 && y < pond.level + 0.65) return true;
  }
  return false;
}

function isWaterBody(x, z, y) {
  if (isCoastSea(x, z, y)) return true;
  if (isPondWater(x, z, y)) return true;
  return false;
}

function createPonds() {
  const group = new THREE.Group();
  group.userData.pondMeshes = [];
  const baseTint = new THREE.Color("#3d7f94");
  const mudTint = new THREE.Color("#2f5f68");
  const clearTint = new THREE.Color("#4aa5c6");
  const wetTint = new THREE.Color("#2f6a63");
  const ashTint = new THREE.Color("#2a5a6d");
  const ecoTmp = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };

  for (let i = 0; i < BIOME.ponds.length; i++) {
    const pond = BIOME.ponds[i];
    const geo = new THREE.CircleGeometry(pond.r, 42);
    geo.rotateX(-Math.PI / 2);

    const isSpring = i === BIOME.springIndex;
    const eco = ECO.sampleTo(ecoTmp, pond.x, pond.z, pond.level, 1.0);
    const tint = (isSpring ? clearTint.clone() : baseTint.clone().lerp(mudTint, clamp((pond.depth - 1.1) / 2.3, 0, 1)))
      .lerp(wetTint, clamp(eco.wetland, 0, 1) * 0.55)
      .lerp(ashTint, clamp(eco.volcanic, 0, 1) * 0.45)
      .lerp(clearTint, clamp(eco.alpine, 0, 1) * 0.35);

    const mat = makeSimpleWaterMaterial({
      tint,
      roughness: 0.05,
      metalness: 0.06,
      edgeMode: "radial",
    });
    // Reduce z-fighting with the terrain at pond edges.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.pondIndex = i;
    mesh.position.set(pond.x, pond.level + 0.08, pond.z);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 1;
    group.add(mesh);
    registerWaterMesh(mesh);
    group.userData.pondMeshes.push(mesh);
  }

  scene.add(group);
  return group;
}

function createCoastWater() {
  const size = WORLD.size * 1.9;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const mat = makeSimpleWaterMaterial({
    tint: "#4aa5c6",
    roughness: 0.05,
    metalness: 0.06,
    edgeMode: "none",
    kind: "sea",
  });

  const mesh = new THREE.Mesh(geo, mat);
  if (BIOME.kind === "miniIslands") {
    mesh.position.set(0, BIOME.seaLevel, 0);
  } else {
    mesh.position.set(BIOME.coastDir.x * WORLD.half * 0.78, BIOME.coastWaterLevel, BIOME.coastDir.y * WORLD.half * 0.78);
  }
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.renderOrder = 0;
  scene.add(mesh);
  registerWaterMesh(mesh);
  return mesh;
}

function createBiomeDetails({
  reedCount = 3200,
  shrubCount = 520,
  snagCount = 80,
  lilyPadCount = 260,
  ruinPieceCount = 22,
} = {}) {
  const group = new THREE.Group();
  group.name = "biomeDetails";
  group.userData = {};

  const waterLevel = getWaterLevel();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  const ecoTmp = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };

  // --- Reeds (wetlands / riparian)
  const reedGeo = new THREE.PlaneGeometry(0.12, 1.0, 1, 4);
  reedGeo.translate(0, 0.5, 0);
  ensureVertexColorAttribute(reedGeo);
  const reedMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.98,
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  enableWindSway(reedMat, { strength: 1.05, frequency: 1.2 });
  enableSnow(reedMat, { useLocalY: true, snowBoost: 0.65, normalInfluence: 0.0 });

  const reeds = new THREE.InstancedMesh(reedGeo, reedMat, reedCount);
  reeds.castShadow = true;
  reeds.receiveShadow = true;
  reeds.frustumCulled = false;
  reeds.renderOrder = 3;
  let reedsPlaced = 0;
  let tries = 0;
  while (reedsPlaced < reedCount && tries++ < reedCount * 18) {
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;
    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.2) continue;
    if (isWaterBody(x, z, y)) continue;
    if (terrainSlope(x, z) > 0.55) continue;

    const eco = ECO.sampleTo(ecoTmp, x, z, y, 1.0);
    const wetBand = clamp(eco.wetland + eco.riparian * 0.8, 0, 1);
    if (wetBand < 0.55) continue;
    if (eco.volcanic > 0.35 && randWorld() < 0.65) continue;

    p.set(x, y + 0.02, z);
    const yaw = randWorld() * Math.PI * 2;
    e.set((randWorld() - 0.5) * 0.18, yaw, (randWorld() - 0.5) * 0.18);
    q.setFromEuler(e);
    const h = lerp(1.2, 2.9, Math.pow(randWorld(), 0.55));
    const w = lerp(0.75, 1.55, Math.pow(randWorld(), 1.4));
    s.set(w, h, 1);
    m.compose(p, q, s);
    reeds.setMatrixAt(reedsPlaced, m);

    const hue = lerp(0.24, 0.34, clamp(eco.temp, 0, 1)) + lerp(-0.02, 0.02, randWorld());
    const sat = lerp(0.18, 0.55, clamp(eco.moist, 0, 1));
    const lum = lerp(0.12, 0.33, clamp(eco.moist, 0, 1));
    c.setHSL(clamp(hue, 0, 1), clamp(sat, 0, 1), clamp(lum, 0, 1));
    reeds.setColorAt(reedsPlaced, c);

    reedsPlaced++;
  }
  reeds.count = reedsPlaced;
  reeds.userData.maxDrawCount = reedsPlaced;
  reeds.instanceMatrix.needsUpdate = true;
  if (reeds.instanceColor) reeds.instanceColor.needsUpdate = true;
  if (reeds.instanceColor) reeds.userData.baseInstanceColor = reeds.instanceColor.array.slice();
  group.add(reeds);
  group.userData.reeds = reeds;

  // --- Shrubs (dry scrub + clay patches)
  const shrubGeo = new THREE.IcosahedronGeometry(1, 0);
  shrubGeo.computeVertexNormals();
  ensureVertexColorAttribute(shrubGeo);
  const shrubMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.98,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(shrubMat, { useLocalY: false, snowBoost: 0.85, normalInfluence: 0.9 });
  const shrubs = new THREE.InstancedMesh(shrubGeo, shrubMat, shrubCount);
  shrubs.castShadow = true;
  shrubs.receiveShadow = true;
  shrubs.frustumCulled = false;
  shrubs.renderOrder = 3;

  let shrubPlaced = 0;
  tries = 0;
  while (shrubPlaced < shrubCount && tries++ < shrubCount * 40) {
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;
    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.65) continue;
    if (isWaterBody(x, z, y)) continue;

    const slope = terrainSlope(x, z);
    if (slope > 0.65) continue;
    const eco = ECO.sampleTo(ecoTmp, x, z, y, clamp(1 - slope, 0, 1));
    const dryBand = clamp(eco.dry * 0.85 + eco.clay * 0.55, 0, 1);
    if (dryBand < 0.58) continue;
    if (eco.wetland > 0.35) continue;
    if (BIOME.kind !== "miniIslands" && Math.abs(x - riverCenterX(z)) < WORLD.riverBankWidth * 0.75) continue;

    p.set(x, y + 0.08, z);
    e.set((randWorld() - 0.5) * 0.9, randWorld() * Math.PI * 2, (randWorld() - 0.5) * 0.9);
    q.setFromEuler(e);
    const sc = lerp(0.55, 1.85, Math.pow(randWorld(), 1.35));
    s.set(sc * lerp(0.9, 1.2, randWorld()), sc * lerp(0.65, 1.25, randWorld()), sc * lerp(0.9, 1.2, randWorld()));
    m.compose(p, q, s);
    shrubs.setMatrixAt(shrubPlaced, m);

    const hue = lerp(0.07, 0.18, clamp(eco.dry, 0, 1)) + lerp(-0.02, 0.02, randWorld());
    const sat = lerp(0.10, 0.35, 1.0 - clamp(eco.moist, 0, 1));
    const lum = lerp(0.18, 0.42, Math.pow(randWorld(), 0.7));
    c.setHSL(clamp(hue, 0, 1), clamp(sat, 0, 1), clamp(lum, 0, 1));
    shrubs.setColorAt(shrubPlaced, c);

    shrubPlaced++;
  }
  shrubs.count = shrubPlaced;
  shrubs.userData.maxDrawCount = shrubPlaced;
  shrubs.instanceMatrix.needsUpdate = true;
  if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
  if (shrubs.instanceColor) shrubs.userData.baseInstanceColor = shrubs.instanceColor.array.slice();
  group.add(shrubs);
  group.userData.shrubs = shrubs;

  // --- Dead tree snags (dry/volcanic)
  const snagGeo = new THREE.CylinderGeometry(0.22, 0.38, 1, 7, 4);
  snagGeo.translate(0, 0.5, 0);
  ensureVertexColorAttribute(snagGeo);
  const snagMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.98,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(snagMat, { useLocalY: false, snowBoost: 0.85, normalInfluence: 0.9 });
  const snags = new THREE.InstancedMesh(snagGeo, snagMat, snagCount);
  snags.castShadow = true;
  snags.receiveShadow = true;
  snags.frustumCulled = false;
  snags.renderOrder = 2;

  let snagPlaced = 0;
  tries = 0;
  while (snagPlaced < snagCount && tries++ < snagCount * 80) {
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;
    const y = terrainHeight(x, z);
    if (y < waterLevel + 1.2) continue;
    if (isWaterBody(x, z, y)) continue;
    const slope = terrainSlope(x, z);
    if (slope > 0.75) continue;

    const eco = ECO.sampleTo(ecoTmp, x, z, y, clamp(1 - slope, 0, 1));
    const deadBand = clamp(eco.dry * 0.75 + eco.volcanic * 0.85, 0, 1);
    if (deadBand < 0.68) continue;
    if (BIOME.kind !== "miniIslands" && Math.abs(x - riverCenterX(z)) < WORLD.riverBankWidth * 0.7) continue;

    p.set(x, y + 0.05, z);
    e.set((randWorld() - 0.5) * 0.12, randWorld() * Math.PI * 2, (randWorld() - 0.5) * 0.12);
    q.setFromEuler(e);
    const h = lerp(4.0, 10.5, Math.pow(randWorld(), 0.7));
    const r = lerp(0.55, 1.25, Math.pow(randWorld(), 1.3));
    s.set(r * 0.85, h, r);
    m.compose(p, q, s);
    snags.setMatrixAt(snagPlaced, m);

    c.setHSL(lerp(0.07, 0.12, randWorld()), lerp(0.08, 0.22, randWorld()), lerp(0.10, 0.26, randWorld()));
    if (eco.volcanic > 0.55) c.lerp(new THREE.Color("#2b2f36"), 0.45);
    snags.setColorAt(snagPlaced, c);

    snagPlaced++;
  }
  snags.count = snagPlaced;
  snags.userData.maxDrawCount = snagPlaced;
  snags.instanceMatrix.needsUpdate = true;
  if (snags.instanceColor) snags.instanceColor.needsUpdate = true;
  if (snags.instanceColor) snags.userData.baseInstanceColor = snags.instanceColor.array.slice();
  group.add(snags);
  group.userData.snags = snags;

  // --- Lily pads on wetter ponds
  const padGeo = new THREE.CircleGeometry(0.45, 12);
  padGeo.rotateX(-Math.PI / 2);
  const padMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#2e6a35"), transparent: true, opacity: 0.82, depthWrite: false });
  enableFloatDrift(padMat, { ampXZ: 0.035, ampY: 0.03, frequency: 0.85 });
  const pads = new THREE.InstancedMesh(padGeo, padMat, lilyPadCount);
  pads.frustumCulled = false;
  pads.renderOrder = 4;

  let padPlaced = 0;
  if (BIOME.ponds?.length) {
    let padTries = 0;
    while (padPlaced < lilyPadCount && padTries++ < lilyPadCount * 30) {
      const idx = Math.floor(randWorld() * BIOME.ponds.length);
      const pond = BIOME.ponds[idx];
      if (!pond) continue;
      // Prefer non-spring ponds.
      if (idx === BIOME.springIndex && randWorld() < 0.85) continue;
      const eco = ECO.sampleTo(ecoTmp, pond.x, pond.z, pond.level, 1.0);
      if (eco.moist < 0.55 || eco.temp < 0.45) continue;
      const rr = pond.r * 0.82 * Math.sqrt(randWorld());
      const ang = randWorld() * Math.PI * 2;
      const x = pond.x + Math.cos(ang) * rr;
      const z = pond.z + Math.sin(ang) * rr;
      p.set(x, pond.level + 0.03, z);
      e.set(0, randWorld() * Math.PI * 2, 0);
      q.setFromEuler(e);
      const sc = lerp(0.65, 1.55, Math.pow(randWorld(), 1.25));
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      pads.setMatrixAt(padPlaced, m);
      padPlaced++;
    }
  }
  pads.count = padPlaced;
  pads.instanceMatrix.needsUpdate = true;
  group.add(pads);
  group.userData.lilyPads = pads;

  // --- Ruins POI (dry-ish region)
  const ruinGroup = new THREE.Group();
  ruinGroup.name = "ruins";
  const stoneMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#9aa2aa"), roughness: 0.95, metalness: 0.0 });
  enableSnow(stoneMat, { useLocalY: false, snowBoost: 0.95, normalInfluence: 1.0 });
  const blockGeo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  const colGeo = new THREE.CylinderGeometry(0.35, 0.45, 1, 8, 2);
  for (let i = 0; i < ruinPieceCount; i++) {
    const isCol = randWorld() < 0.45;
    const mesh = new THREE.Mesh(isCol ? colGeo : blockGeo, stoneMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const rr = ECO.ruins.r * Math.sqrt(randWorld());
    const ang = randWorld() * Math.PI * 2;
    const x = ECO.ruins.x + Math.cos(ang) * rr;
    const z = ECO.ruins.z + Math.sin(ang) * rr;
    const y = terrainHeight(x, z);
    mesh.position.set(x, y + 0.15, z);
    mesh.rotation.set((randWorld() - 0.5) * 0.35, randWorld() * Math.PI * 2, (randWorld() - 0.5) * 0.35);
    const sc = lerp(0.7, 2.2, Math.pow(randWorld(), 0.9));
    const h = lerp(0.45, 3.8, Math.pow(randWorld(), 1.1));
    mesh.scale.set(sc * lerp(0.9, 1.35, randWorld()), h, sc * lerp(0.9, 1.35, randWorld()));
    ruinGroup.add(mesh);
  }
  group.add(ruinGroup);
  group.userData.ruins = ruinGroup;

  // --- Hot spring (volcanic zone) + small steam sprites
  const springGeo = new THREE.CircleGeometry(5.2, 36);
  springGeo.rotateX(-Math.PI / 2);
  const springMat = makeSimpleWaterMaterial({
    tint: "#6bd3ff",
    roughness: 0.06,
    metalness: 0.04,
    edgeMode: "radial",
  });
  const springMesh = new THREE.Mesh(springGeo, springMat);
  const springY = terrainHeight(ECO.volcano.x, ECO.volcano.z);
  springMesh.position.set(ECO.volcano.x, springY + 0.02, ECO.volcano.z);
  springMesh.castShadow = false;
  springMesh.receiveShadow = false;
  springMesh.renderOrder = 1;
  group.add(springMesh);
  registerWaterMesh(springMesh);
  group.userData.hotSpring = springMesh;

  const steamCount = 120;
  const steamGeo = new THREE.BufferGeometry();
  const steamPos = new Float32Array(steamCount * 3);
  const steamSeed = new Float32Array(steamCount);
  for (let i = 0; i < steamCount; i++) {
    const rr = 4.8 * Math.sqrt(randWorld());
    const ang = randWorld() * Math.PI * 2;
    steamPos[i * 3 + 0] = ECO.volcano.x + Math.cos(ang) * rr;
    steamPos[i * 3 + 1] = springY + lerp(0.6, 3.2, randWorld());
    steamPos[i * 3 + 2] = ECO.volcano.z + Math.sin(ang) * rr;
    steamSeed[i] = randWorld();
  }
  steamGeo.setAttribute("position", new THREE.BufferAttribute(steamPos, 3));
  steamGeo.setAttribute("aSeed", new THREE.BufferAttribute(steamSeed, 1));
  const steamMat = new THREE.PointsMaterial({
    color: 0xe8f6ff,
    size: 0.55,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  const steam = new THREE.Points(steamGeo, steamMat);
  steam.frustumCulled = false;
  steam.renderOrder = 4;
  group.add(steam);
  group.userData.steam = steam;

  scene.add(group);
  return group;
}

function createWaterfall() {
  const pond = BIOME.ponds[BIOME.springIndex];
  const src = new THREE.Vector3(pond.x, pond.level + 0.08, pond.z);
  const dst = new THREE.Vector3(riverCenterX(pond.z), WORLD.waterLevel + 0.12, pond.z);

  let dh = src.y - dst.y;
  if (dh < 3.0) {
    const sideDir = new THREE.Vector2(pond.x - dst.x, pond.z - dst.z).normalize();
    for (let i = 0; i < 18; i++) {
      const t = (i + 1) / 18;
      const x = dst.x + sideDir.x * lerp(22, 46, t);
      const z = dst.z + sideDir.y * lerp(22, 46, t);
      const y = terrainHeight(x, z) + 2.2;
      if (y - dst.y > 3.0) {
        src.set(x, y, z);
        break;
      }
    }
  }

  const dir = new THREE.Vector3().subVectors(dst, src);
  const len = dir.length();
  if (len < 2.0) return null;
  const dirN = dir.clone().normalize();

  const width = lerp(1.8, 3.6, randWorld());
  const geo = new THREE.PlaneGeometry(width, len, 1, 40);
  geo.translate(0, -len * 0.5, 0);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: sharedUniforms.uRealTime,
      uOpacity: { value: 0.85 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uOpacity;

	      #include <common>

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.x);
        float flow = vUv.y * 6.0 - uTime * 2.4;
        float n = hash21(floor(vec2(vUv.x * 12.0, flow)));
        float streak = smoothstep(0.15, 0.85, sin(flow * 3.14159 + n * 6.2831) * 0.5 + 0.5);
        float foam = smoothstep(0.55, 1.0, streak) * 0.35;
        vec3 col = mix(vec3(0.35, 0.62, 0.78), vec3(0.88, 0.95, 1.0), foam);
	        float a = (0.22 + 0.78 * streak) * edge * uOpacity;
	        if (a < 0.01) discard;
	        gl_FragColor = vec4(col, a);
	      }
	    `,
	  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(src);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirN);
  mesh.renderOrder = 3;
  scene.add(mesh);
  registerWaterMesh(mesh);
  return { mesh, src, dst };
}

function createGrass({ count = 14000 } = {}) {
  const bladeGeo = new THREE.PlaneGeometry(0.14, 1.0, 1, 4);
  bladeGeo.translate(0, 0.5, 0);
  ensureVertexColorAttribute(bladeGeo);

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 1.0,
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  enableWindSway(mat, { strength: 0.75, frequency: 1.0 });
  enableSnow(mat, { useLocalY: true, snowBoost: 0.85, normalInfluence: 0.0 });
  enableRainSheen(mat, { strength: 0.75, roughnessMin: 0.28, darken: 0.07 });

  const mesh = new THREE.InstancedMesh(bladeGeo, mat, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  const ecoTmp = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };

  let placed = 0;
  let attempts = 0;
  const waterLevel = getWaterLevel();
  while (placed < count && attempts < count * 12) {
    attempts++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;

    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.35) continue;
    if (isWaterBody(x, z, y)) continue;

    let d = 1e9;
    if (BIOME.kind !== "miniIslands") {
      const cx = riverCenterX(z);
      d = Math.abs(x - cx);
      if (d < WORLD.riverWidth * 0.95) continue;
    }

    const slope = terrainSlope(x, z);
    if (slope > 0.95) continue;

    const ny = clamp(1.0 - slope, 0, 1);
    const eco = ECO.sampleTo(ecoTmp, x, z, y, ny);
    // Keep grass sparse in volcanic / wetland zones (handled by other details).
    if (eco.volcanic > 0.55 && randWorld() < 0.85) continue;
    if (eco.wetland > 0.55 && randWorld() < 0.7) continue;
    if (eco.alpine > 0.65 && randWorld() < 0.55) continue;

    p.set(x, y + 0.02, z);
    const yaw = randWorld() * Math.PI * 2;
    const lean = lerp(0.0, 0.35, Math.pow(randWorld(), 2.0));
    const leanDir = randWorld() * Math.PI * 2;
    const tiltX = Math.cos(leanDir) * lean;
    const tiltZ = Math.sin(leanDir) * lean;
    e.set(tiltX, yaw, tiltZ);
    q.setFromEuler(e);

    const h = lerp(0.25, 1.55, Math.pow(randWorld(), 0.55));
    const w = lerp(0.55, 1.75, Math.pow(randWorld(), 1.4));
    s.set(w, h, 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(placed, m);

    const wet =
      BIOME.kind === "miniIslands" ? clamp(1 - smoothstep(waterLevel + 0.25, waterLevel + 2.6, y), 0, 1) : clamp(1 - smoothstep(WORLD.riverWidth * 1.2, WORLD.riverBankWidth * 0.35, d), 0, 1);
    const h01 = clamp((y + 2) / 9, 0, 1);
    const patch = clamp(noise.noise(x * 0.03, z * 0.03, seed + 777) * 0.5 + 0.5, 0, 1);
    const dryness = clamp((1 - wet) * 0.75 + (patch - 0.5) * 0.55, 0, 1);

    const hueGreen = lerp(0.26, 0.35, h01) + lerp(-0.03, 0.03, randWorld());
    const huePale = lerp(0.16, 0.24, h01) + lerp(-0.03, 0.03, randWorld());
    const hueDry = lerp(0.09, 0.16, h01) + lerp(-0.02, 0.02, randWorld());

    const satGreen = lerp(0.50, 0.78, 1 - wet);
    const satPale = lerp(0.22, 0.46, 1 - wet);
    const satDry = lerp(0.16, 0.42, 1 - wet);

    const lumGreen = lerp(0.14, 0.34, h01) + lerp(0.03, 0.09, wet);
    const lumPale = lerp(0.20, 0.42, h01) + lerp(0.02, 0.07, wet);
    const lumDry = lerp(0.34, 0.62, h01) + lerp(0.0, 0.08, wet);

    const roll = randWorld();
    const wantDry = dryness > 0.5 || eco.dry > 0.58 || (dryness > 0.35 && roll > 0.55);
    const wantPale = !wantDry && (dryness > 0.25 || roll > 0.72);

    let hue = wantDry ? hueDry : wantPale ? huePale : hueGreen;
    let sat = (wantDry ? satDry : wantPale ? satPale : satGreen) + lerp(-0.07, 0.07, randWorld());
    let lum = (wantDry ? lumDry : wantPale ? lumPale : lumGreen) + lerp(-0.05, 0.05, randWorld());
    // Volcanic and clay zones: duller / warmer.
    hue = lerp(hue, 0.08, clamp(eco.clay, 0, 1) * 0.25);
    lum = lerp(lum, lum * 0.78, clamp(eco.volcanic, 0, 1) * 0.65);
    sat = lerp(sat, sat * 0.72, clamp(eco.volcanic, 0, 1) * 0.75);

    c.setHSL(clamp(hue, 0, 1), clamp(sat, 0, 1), clamp(lum, 0, 1));
    mesh.setColorAt(placed, c);

    placed++;
  }
  mesh.count = placed;
  mesh.userData.maxDrawCount = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (mesh.instanceColor) mesh.userData.baseInstanceColor = mesh.instanceColor.array.slice();
  scene.add(mesh);
  return mesh;
}

function createForest({ treeCount = 22, leavesPerTree = 360 } = {}) {
  const group = new THREE.Group();

  const trunkGeo = new THREE.CylinderGeometry(0.62, 0.9, 1, 9, 6);
  trunkGeo.translate(0, 0.5, 0);
  ensureVertexColorAttribute(trunkGeo);
  const trunkMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.95,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(trunkMat, { useLocalY: false, snowBoost: 0.95 });
  enableRainSheen(trunkMat, { strength: 0.55, roughnessMin: 0.35, darken: 0.06 });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  trunks.castShadow = true;
  trunks.receiveShadow = true;
  group.add(trunks);

  const leafGeo = new THREE.PlaneGeometry(0.54, 0.36, 1, 2);
  leafGeo.translate(0, 0.18, 0);
  leafGeo.rotateY(Math.PI * 0.5);
  ensureVertexColorAttribute(leafGeo);

  const leafMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  enableWindSway(leafMat, { strength: 0.38, frequency: 1.15 });
  enableRainSheen(leafMat, { strength: 0.65, roughnessMin: 0.3, darken: 0.08 });
  enableSnow(leafMat, { useLocalY: false, snowBoost: 0.75, normalInfluence: 0.9 });

  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, treeCount * leavesPerTree);
  leaves.castShadow = true;
  leaves.receiveShadow = true;
  group.add(leaves);
  group.userData.trunks = trunks;
  group.userData.leaves = leaves;
  group.userData.maxTreeCount = treeCount;
  group.userData.maxLeafCount = treeCount * leavesPerTree;

  const treePos = [];
  const treeCanopy = [];

  const tmpLeaf = new THREE.Color();
  const tmpTrunk = new THREE.Color();
  const tmpDry = new THREE.Color("#6a4a2b");
  const ecoTmp = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };

  let tries = 0;
  const waterLevel = getWaterLevel();
  while (treePos.length < treeCount && tries < treeCount * 120) {
    tries++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;

    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.8) continue;
    if (isWaterBody(x, z, y)) continue;

    if (BIOME.kind !== "miniIslands") {
      const cx = riverCenterX(z);
      const d = Math.abs(x - cx);
      if (d < WORLD.riverBankWidth * 0.65) continue;
    }

    const slope = terrainSlope(x, z);
    if (slope > 0.58) continue;
    const eco = ECO.sampleTo(ecoTmp, x, z, y, clamp(1.0 - slope, 0, 1));
    // Treeline + biome constraints (no forests in wetlands or volcanic fields).
    if (eco.alpine > 0.72) continue;
    if (eco.wetland > 0.38) continue;
    if (eco.volcanic > 0.55 && randWorld() < 0.9) continue;

    let ok = true;
    for (const p of treePos) {
      if (Math.hypot(p.x - x, p.z - z) < 10.5) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const peakD = Math.hypot(x - TERRAIN_PROFILE.peak.x, z - TERRAIN_PROFILE.peak.z);
    const peakMask = smoothstep(TERRAIN_PROFILE.peak.r * 1.25, TERRAIN_PROFILE.peak.r * 0.55, peakD);
    const alpine = smoothstep(7.5, 13.0, y) * (0.55 + 0.45 * peakMask);
    const dryPatch = clamp(noise.noise(x * 0.016, z * 0.016, seed + 1501) * 0.5 + 0.5, 0, 1);
    const wetPatch = clamp(noise.noise(x * 0.023, z * 0.023, seed + 1502) * 0.5 + 0.5, 0, 1);
    const dryness =
      BIOME.kind === "miniIslands"
        ? clamp(
            smoothstep(waterLevel + 0.9, waterLevel + 6.0, y) * 0.45 +
              (dryPatch - 0.5) * 0.8 +
              (0.5 - wetPatch) * 0.55,
            0,
            1
          )
        : clamp(
            smoothstep(BIOME.shorePos - BIOME.shoreWidth * 0.2, BIOME.shorePos + BIOME.shoreWidth * 0.9, x * BIOME.coastDir.x + z * BIOME.coastDir.y) *
              0.7 +
              (dryPatch - 0.5) * 0.8 +
              (0.5 - wetPatch) * 0.55,
            0,
            1
          );

    // Tree types: pine, broadleaf, dry/autumn
    const typeR = randWorld();
    let trunkH;
    let trunkScale;
    let canopyR;
    let canopyH;
    let canopyShape = "round";
    let leafScaleMul = 1.0;

    const pineClimate = clamp(alpine * 0.7 + (1.0 - eco.temp) * 0.9, 0, 1);
    const pineChance = lerp(0.22, 0.85, pineClimate);
    const autumnChance = lerp(0.16, 0.55, dryness) * (1 - alpine * 0.6) * (0.65 + 0.35 * eco.dry);
    const isPine = typeR < pineChance;
    const isAutumn = !isPine && typeR > 1.0 - autumnChance;

    if (isPine) {
      // Pine (taller, narrower)
      canopyShape = "cone";
      trunkH = lerp(9.8, 18.5, Math.pow(randWorld(), 0.72));
      trunkScale = lerp(0.55, 1.05, Math.pow(randWorld(), 1.1));
      canopyR = lerp(2.0, 4.4, Math.pow(randWorld(), 0.7));
      canopyH = lerp(6.5, 11.8, Math.pow(randWorld(), 0.68));
      leafScaleMul = 0.95;
      tmpLeaf.setHSL(lerp(0.30, 0.36, randWorld()), lerp(0.28, 0.62, randWorld()), lerp(0.18, 0.40, randWorld()));
      // Colder/darker pine near snow biomes
      tmpLeaf.lerp(new THREE.Color("#1f3a2a"), alpine * 0.35);
    } else if (!isAutumn) {
      // Broadleaf (round canopy)
      trunkH = lerp(5.8, 14.2, Math.pow(randWorld(), 0.75));
      trunkScale = lerp(0.75, 1.55, Math.pow(randWorld(), 0.8));
      canopyR = lerp(3.4, 7.6, Math.pow(randWorld(), 0.75));
      canopyH = lerp(3.4, 7.8, Math.pow(randWorld(), 0.75));
      leafScaleMul = 1.08;
      tmpLeaf.setHSL(lerp(0.24, 0.39, randWorld()), lerp(0.30, 0.78, randWorld()), lerp(0.22, 0.46, randWorld()));
      tmpLeaf.lerp(new THREE.Color("#2f6f3a"), clamp(eco.moist, 0, 1) * 0.28);
      tmpLeaf.lerp(new THREE.Color("#3a6a2f"), wetPatch * 0.18);
    } else {
      // Dry/autumn
      trunkH = lerp(6.0, 14.5, Math.pow(randWorld(), 0.8));
      trunkScale = lerp(0.75, 1.35, Math.pow(randWorld(), 0.85));
      canopyR = lerp(3.2, 7.2, Math.pow(randWorld(), 0.75));
      canopyH = lerp(3.2, 7.2, Math.pow(randWorld(), 0.75));
      leafScaleMul = 1.0;
      tmpLeaf.setHSL(lerp(0.06, 0.15, randWorld()), lerp(0.35, 0.82, randWorld()), lerp(0.26, 0.58, randWorld()));
      tmpLeaf.lerp(new THREE.Color("#7b8a3f"), (1 - dryness) * 0.25);
    }

    // Push more dry/autumn near coast
    tmpLeaf.lerp(new THREE.Color("#a77a36"), clamp(dryness - 0.25, 0, 1) * 0.25);

    treePos.push(new THREE.Vector3(x, y, z));

    // Trunk color variety (browns/greys, lighter in dry biomes)
    tmpTrunk.setHSL(lerp(0.06, 0.11, randWorld()), lerp(0.22, 0.5, randWorld()), lerp(0.18, 0.36, randWorld()));
    tmpTrunk.lerp(tmpDry, clamp(dryness - 0.35, 0, 1) * 0.35);
    if (randWorld() < 0.18) tmpTrunk.lerp(new THREE.Color("#3d3f44"), 0.22);

    treeCanopy.push({
      trunkH,
      trunkScale,
      canopyR,
      canopyH,
      canopyShape,
      leafScaleMul,
      leafColor: tmpLeaf.clone(),
      trunkColor: tmpTrunk.clone(),
    });
  }

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();

  for (let i = 0; i < treeCount; i++) {
    const info = treeCanopy[i] ?? { trunkH: 9.2, trunkScale: 1.0, canopyR: 4.2, canopyH: 4.8, leafColor: new THREE.Color("#2f7a33"), trunkColor: new THREE.Color("#5b3a25") };
    const tp = treePos[i] ?? new THREE.Vector3(32 + i * 1.5, terrainHeight(32 + i * 1.5, 18), 18);

    const yaw = randWorld() * Math.PI * 2;
    const tilt = (randWorld() - 0.5) * 0.09;
    const tilt2 = (randWorld() - 0.5) * 0.09;
    e.set(tilt, yaw, tilt2);
    q.setFromEuler(e);
    p.set(tp.x, tp.y, tp.z);
    s.set(info.trunkScale, info.trunkH, info.trunkScale);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);
    trunks.setColorAt(i, info.trunkColor);
  }
  trunks.instanceMatrix.needsUpdate = true;
  if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
  if (trunks.instanceColor) trunks.userData.baseInstanceColor = trunks.instanceColor.array.slice();

  let leafIndex = 0;
  const leafC = new THREE.Color();
  for (let i = 0; i < treeCount; i++) {
    const info = treeCanopy[i] ?? { trunkH: 9.2, trunkScale: 1.0, canopyR: 4.2, canopyH: 4.8, leafColor: new THREE.Color("#2f7a33") };
    const tp = treePos[i] ?? new THREE.Vector3(32 + i * 1.5, terrainHeight(32 + i * 1.5, 18), 18);

    const canopyBase = info.canopyShape === "cone" ? info.trunkH * 0.45 : info.trunkH * 0.7;
    const canopyTop = info.trunkH + info.canopyH;

    for (let j = 0; j < leavesPerTree; j++) {
      const ty = lerp(canopyBase, canopyTop, Math.pow(randWorld(), 0.58));
      const t = clamp((ty - canopyBase) / Math.max(0.001, canopyTop - canopyBase), 0, 1);
      const rAt = info.canopyShape === "cone" ? info.canopyR * Math.pow(1.0 - t, 0.55) : info.canopyR * Math.sin(t * Math.PI);

      const a = randWorld() * Math.PI * 2;
      const rr = Math.sqrt(randWorld()) * rAt;
      const ox = Math.cos(a) * rr;
      const oz = Math.sin(a) * rr;

      p.set(tp.x + ox, tp.y + ty, tp.z + oz);
      e.set((randWorld() - 0.5) * 0.9, randWorld() * Math.PI * 2, (randWorld() - 0.5) * 0.9);
      q.setFromEuler(e);
      const sc = lerp(0.45, 1.55, randWorld()) * (info.leafScaleMul ?? 1.0);
      s.setScalar(sc);
      m.compose(p, q, s);
      leaves.setMatrixAt(leafIndex, m);
      leafC.copy(info.leafColor).offsetHSL(lerp(-0.02, 0.02, randWorld()), lerp(-0.06, 0.06, randWorld()), lerp(-0.06, 0.06, randWorld()));
      leaves.setColorAt(leafIndex, leafC);
      leafIndex++;
    }
  }
  leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  if (leaves.instanceColor) leaves.userData.baseInstanceColor = leaves.instanceColor.array.slice();

  scene.add(group);
  return group;
}

function createRocks({ count = 420 } = {}) {
  function makeRockGeometryVariants(variantCount = 7) {
    const rng = mulberry32(WORLD_SEED ^ 0x4f6b3a21);
    const bases = [
      () => new THREE.IcosahedronGeometry(1, 0),
      () => new THREE.DodecahedronGeometry(1, 0),
      () => new THREE.OctahedronGeometry(1, 0),
      () => new THREE.TetrahedronGeometry(1, 0),
      () => new THREE.BoxGeometry(1, 1, 1, 1, 1, 1),
    ];

    const variants = [];
    for (let i = 0; i < variantCount; i++) {
      const base = bases[Math.floor(rng() * bases.length)]();
      base.computeVertexNormals();
      ensureVertexColorAttribute(base);

      const pos = base.attributes.position;

      const deform = lerp(0.05, 0.22, rng());
      const pinch = lerp(-0.07, 0.10, rng());
      const ax = lerp(0.8, 1.25, rng());
      const ay = lerp(0.75, 1.35, rng());
      const az = lerp(0.8, 1.25, rng());

      for (let v = 0; v < pos.count; v++) {
        const x = pos.getX(v);
        const y = pos.getY(v);
        const z = pos.getZ(v);

        // Deterministic vertex "noise" (per-variant)
        const h = Math.sin((x * 12.9898 + y * 78.233 + z * 37.719 + (i + 1) * 19.19) * 43758.5453);
        const r = (h - Math.floor(h)) * 2 - 1;

        const amp = deform * (0.45 + 0.55 * Math.abs(r));
        const pinchTerm = 1 + pinch * (y * y);

        // IMPORTANT: displace along radial direction (position-based), not face normals.
        // This prevents "exploded" faces on geometries with duplicated vertices (e.g. BoxGeometry).
        const px = (x * ax) * pinchTerm;
        const py = (y * ay) * pinchTerm;
        const pz = (z * az) * pinchTerm;
        const len = Math.sqrt(px * px + py * py + pz * pz) + 1e-6;
        const dx = px / len;
        const dy = py / len;
        const dz = pz / len;
        pos.setXYZ(v, px + dx * amp, py + dy * amp, pz + dz * amp);
      }

      base.computeVertexNormals();
      variants.push(base);
    }

    return variants;
  }

  const geos = makeRockGeometryVariants(8);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.95,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(mat, { useLocalY: false, snowBoost: 1.15, normalInfluence: 1.0 });

  const group = new THREE.Group();
  const meshes = [];
  const capPer = Math.ceil((count / geos.length) * 1.35) + 10;
  for (let i = 0; i < geos.length; i++) {
    const m = new THREE.InstancedMesh(geos[i], mat, capPer);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.maxDrawCount = capPer;
    meshes.push(m);
    group.add(m);
  }
  group.userData.meshes = meshes;

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  const mossTint = new THREE.Color("#3a4a2c");
  const whiteTint = new THREE.Color("#f2f2f2");
  const brownTint = new THREE.Color("#5b3a25");
  const sandyTint = new THREE.Color("#b5976b");
  const ecoTmp = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };

  let placed = 0;
  const placedBy = new Array(meshes.length).fill(0);
  let attempts = 0;
  const waterLevel = getWaterLevel();
  while (placed < count && attempts < count * 30) {
    attempts++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;

    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.8) continue;
    if (isWaterBody(x, z, y)) continue;

    if (BIOME.kind !== "miniIslands") {
      const cx = riverCenterX(z);
      const d = Math.abs(x - cx);
      if (d < WORLD.riverBankWidth * 0.65) continue;
    }

    const slope = terrainSlope(x, z);
    const steep = slope > 0.55;
    if (!steep && randWorld() > 0.14) continue;
    const eco = ECO.sampleTo(ecoTmp, x, z, y, clamp(1.0 - slope, 0, 1));

    // Choose a rock shape variant (skip full buckets)
    let vi = Math.floor(randWorld() * meshes.length);
    if (placedBy[vi] >= meshes[vi].userData.maxDrawCount) {
      let found = false;
      for (let j = 0; j < meshes.length; j++) {
        const idx = (vi + j) % meshes.length;
        if (placedBy[idx] < meshes[idx].userData.maxDrawCount) {
          vi = idx;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    const targetMesh = meshes[vi];
    const instIdx = placedBy[vi];

    p.set(x, y + lerp(0.12, 0.55, randWorld()), z);
    e.set((randWorld() - 0.5) * 0.6, randWorld() * Math.PI * 2, (randWorld() - 0.5) * 0.6);
    q.setFromEuler(e);

    // Wider size distribution with occasional boulders
    const r0 = randWorld();
    let base;
    if (r0 < 0.78) base = lerp(0.55, 2.4, Math.pow(randWorld(), 1.6));
    else if (r0 < 0.95) base = lerp(2.4, 5.2, Math.pow(randWorld(), 1.25));
    else base = lerp(5.2, 9.8, Math.pow(randWorld(), 0.9));
    if (steep) base *= lerp(1.05, 1.45, randWorld());
    s.set(
      base * lerp(0.65, 1.35, randWorld()),
      base * lerp(0.45, 1.15, randWorld()),
      base * lerp(0.65, 1.35, randWorld())
    );
    m.compose(p, q, s);
    targetMesh.setMatrixAt(instIdx, m);

    const moss = randWorld();
    // Rock palette: influenced by geology/moisture bands.
    let kind = randWorld();
    if (eco.volcanic > 0.55 || eco.geo > 0.72) kind = 0.70 + randWorld() * 0.25; // basalt
    else if (eco.clay > 0.55 || eco.dry > 0.65) kind = randWorld() * 0.35; // sandstone
    else if (eco.alpine > 0.55) kind = 0.85 + randWorld() * 0.2; // granite/chalk

    if (kind < 0.52) {
      // Brown / sandstone
      c.setHSL(lerp(0.06, 0.11, randWorld()), lerp(0.22, 0.55, randWorld()), lerp(0.28, 0.56, randWorld()));
      c.lerp(sandyTint, lerp(0.0, 0.35, randWorld()));
    } else if (kind < 0.82) {
      // Grey / basalt
      c.setHSL(lerp(0.02, 0.12, randWorld()), lerp(0.02, 0.12, randWorld()), lerp(0.26, 0.62, randWorld()));
      c.lerp(brownTint, lerp(0.0, 0.18, randWorld()));
    } else {
      // Light granite / chalk
      c.setHSL(lerp(0.06, 0.14, randWorld()), lerp(0.0, 0.12, randWorld()), lerp(0.55, 0.88, randWorld()));
      c.lerp(whiteTint, lerp(0.25, 0.65, randWorld()));
      if (randWorld() < 0.35) c.lerp(brownTint, lerp(0.05, 0.18, randWorld()));
    }
    const mossP = lerp(0.08, 0.28, clamp(eco.moist, 0, 1)) * (1.0 - clamp(eco.dry, 0, 1) * 0.65);
    if (moss < mossP) c.lerp(mossTint, lerp(0.22, 0.45, clamp(eco.moist, 0, 1)));
    targetMesh.setColorAt(instIdx, c);

    placedBy[vi]++;
    placed++;
  }

  for (let i = 0; i < meshes.length; i++) {
    const rm = meshes[i];
    rm.count = placedBy[i];
    rm.instanceMatrix.needsUpdate = true;
    if (rm.instanceColor) rm.instanceColor.needsUpdate = true;
    if (rm.instanceColor) rm.userData.baseInstanceColor = rm.instanceColor.array.slice();
  }

  scene.add(group);
  return group;
}

function createRockFormations({
  archCount = BIOME.kind === "miniIslands" ? 6 : 8,
  basaltClusterCount = BIOME.kind === "miniIslands" ? 5 : 7,
  columnsPerCluster = 18,
  mineralCounts = { metal: 90, diamond: 22, sapphire: 34, ruby: 34 },
} = {}) {
  const group = new THREE.Group();
  group.name = "rockFormations";
  group.userData.rockMeshes = [];
  group.userData.mineralMeshes = [];

  const waterLevel = getWaterLevel();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  const c = new THREE.Color();

  function isValidLand(x, z, y, minAboveWater = 1.0) {
    if (!inSpawnBounds(x, z)) return false;
    if (y < waterLevel + minAboveWater) return false;
    if (isWaterBody(x, z, y)) return false;

    if (BIOME.kind !== "miniIslands") {
      const cx = riverCenterX(z);
      const d = Math.abs(x - cx);
      if (d < WORLD.riverBankWidth * 0.62) return false;
    }

    return true;
  }

  // --- Rock arches (natural bridges)
  const archGeo = new THREE.TorusGeometry(1, 0.32, 6, 11, Math.PI);
  archGeo.computeVertexNormals();
  ensureVertexColorAttribute(archGeo);
  archGeo.computeBoundingBox();
  if (archGeo.boundingBox) archGeo.translate(0, -archGeo.boundingBox.min.y, 0);

  const archMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.97,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(archMat, { useLocalY: false, snowBoost: 1.15, normalInfluence: 1.0 });

  const arches = new THREE.InstancedMesh(archGeo, archMat, archCount);
  arches.name = "arches";
  arches.castShadow = true;
  arches.receiveShadow = true;
  arches.frustumCulled = false;
  arches.renderOrder = 2;

  let placedArches = 0;
  let tries = 0;
  while (placedArches < archCount && tries++ < archCount * 80) {
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    const y = terrainHeight(x, z);
    if (!isValidLand(x, z, y, 2.5)) continue;

    const slope = terrainSlope(x, z);
    if (slope < 0.16 || slope > 0.55) continue;
    if (randWorld() > 0.22 + (0.35 - slope) * 0.6) continue;

    p.set(x, y - 0.05, z);
    const yaw = randWorld() * Math.PI * 2;
    e.set((randWorld() - 0.5) * 0.18, yaw, (randWorld() - 0.5) * 0.18);
    q.setFromEuler(e);

    const size = lerp(5.5, 13.0, Math.pow(randWorld(), 0.72));
    s.set(
      size * lerp(0.85, 1.25, randWorld()),
      size * lerp(0.65, 1.1, randWorld()),
      size * lerp(0.85, 1.25, randWorld())
    );
    m.compose(p, q, s);
    arches.setMatrixAt(placedArches, m);

    const kind = randWorld();
    if (kind < 0.55) c.setHSL(lerp(0.06, 0.12, randWorld()), lerp(0.18, 0.45, randWorld()), lerp(0.32, 0.58, randWorld()));
    else if (kind < 0.85) c.setHSL(lerp(0.02, 0.10, randWorld()), lerp(0.02, 0.10, randWorld()), lerp(0.26, 0.48, randWorld()));
    else c.setHSL(lerp(0.06, 0.14, randWorld()), lerp(0.0, 0.08, randWorld()), lerp(0.56, 0.84, randWorld()));
    arches.setColorAt(placedArches, c);

    placedArches++;
  }
  arches.count = placedArches;
  arches.instanceMatrix.needsUpdate = true;
  if (arches.instanceColor) {
    arches.instanceColor.needsUpdate = true;
    arches.userData.baseInstanceColor = arches.instanceColor.array.slice();
  }
  group.add(arches);
  group.userData.rockMeshes.push(arches);

  // --- Basalt columns (clustered hex prisms)
  const maxColumns = basaltClusterCount * columnsPerCluster;
  const columnGeo = new THREE.CylinderGeometry(0.55, 0.65, 1, 6, 1, false);
  columnGeo.computeVertexNormals();
  ensureVertexColorAttribute(columnGeo);
  columnGeo.translate(0, 0.5, 0); // base at y=0

  const columnMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.98,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(columnMat, { useLocalY: false, snowBoost: 1.1, normalInfluence: 1.0 });

  const columns = new THREE.InstancedMesh(columnGeo, columnMat, maxColumns);
  columns.name = "basaltColumns";
  columns.castShadow = true;
  columns.receiveShadow = true;
  columns.frustumCulled = false;
  columns.renderOrder = 2;

  const basaltCenters = [];
  let colPlaced = 0;
  for (let ci = 0; ci < basaltClusterCount; ci++) {
    let found = false;
    let cx = 0;
    let cz = 0;
    let cy = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      cx = lerp(-WORLD.half, WORLD.half, randWorld());
      cz = lerp(-WORLD.half, WORLD.half, randWorld());
      cy = terrainHeight(cx, cz);
      if (!isValidLand(cx, cz, cy, 4.0)) continue;
      const slope = terrainSlope(cx, cz);
      if (slope < 0.55) continue;
      if (randWorld() > 0.35 + (slope - 0.55) * 0.65) continue;
      found = true;
      break;
    }
    if (!found) continue;

    basaltCenters.push(new THREE.Vector3(cx, cy, cz));

    const clusterR = lerp(4.5, 10.0, randWorld());
    const desired = Math.min(columnsPerCluster, maxColumns - colPlaced);
    for (let k = 0; k < desired; k++) {
      if (colPlaced >= maxColumns) break;
      const ang = randWorld() * Math.PI * 2;
      const rr = clusterR * Math.sqrt(randWorld());
      const x = cx + Math.cos(ang) * rr;
      const z = cz + Math.sin(ang) * rr;
      const y = terrainHeight(x, z);
      if (!isValidLand(x, z, y, 3.0)) continue;
      if (terrainSlope(x, z) < 0.42 && randWorld() > 0.2) continue;

      p.set(x, y - 0.12, z);
      const yaw = randWorld() * Math.PI * 2;
      e.set((randWorld() - 0.5) * 0.06, yaw, (randWorld() - 0.5) * 0.06);
      q.setFromEuler(e);

      const h = lerp(2.2, 9.0, Math.pow(randWorld(), 1.35));
      const r = lerp(0.55, 1.35, Math.pow(randWorld(), 1.1));
      s.set(r * lerp(0.9, 1.25, randWorld()), h, r * lerp(0.9, 1.25, randWorld()));
      m.compose(p, q, s);
      columns.setMatrixAt(colPlaced, m);

      c.setHSL(lerp(0.02, 0.10, randWorld()), lerp(0.02, 0.12, randWorld()), lerp(0.18, 0.38, randWorld()));
      if (randWorld() < 0.25) c.lerp(new THREE.Color("#3a4a2c"), 0.18);
      columns.setColorAt(colPlaced, c);

      colPlaced++;
    }
  }

  columns.count = colPlaced;
  columns.instanceMatrix.needsUpdate = true;
  if (columns.instanceColor) {
    columns.instanceColor.needsUpdate = true;
    columns.userData.baseInstanceColor = columns.instanceColor.array.slice();
  }
  group.add(columns);
  group.userData.rockMeshes.push(columns);

  // --- Minerals (ores + crystals)
  function spawnInstancedMinerals({
    name,
    count,
    geometry,
    material,
    palette,
    scaleRange = [0.55, 1.35],
    heightRange = [0.9, 2.2],
    slopeMin = 0.38,
    minAboveWater = 2.0,
    embed = 0.18,
    preferBasalt = 0.65,
  }) {
    if (!count || count <= 0) return null;

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;

    let placed = 0;
    let tries = 0;
    while (placed < count && tries++ < count * 120) {
      let x, z;
      if (basaltCenters.length && randWorld() < preferBasalt) {
        const bc = basaltCenters[Math.floor(randWorld() * basaltCenters.length)];
        const ang = randWorld() * Math.PI * 2;
        const rr = lerp(1.2, 10.0, randWorld()) * Math.sqrt(randWorld());
        x = bc.x + Math.cos(ang) * rr;
        z = bc.z + Math.sin(ang) * rr;
      } else {
        x = lerp(-WORLD.half, WORLD.half, randWorld());
        z = lerp(-WORLD.half, WORLD.half, randWorld());
      }

      const y = terrainHeight(x, z);
      if (!isValidLand(x, z, y, minAboveWater)) continue;
      if (terrainSlope(x, z) < slopeMin) continue;

      p.set(x, y - embed, z);
      e.set((randWorld() - 0.5) * 0.35, randWorld() * Math.PI * 2, (randWorld() - 0.5) * 0.35);
      q.setFromEuler(e);

      const r = lerp(scaleRange[0], scaleRange[1], Math.pow(randWorld(), 1.3));
      const h = lerp(heightRange[0], heightRange[1], Math.pow(randWorld(), 1.2));
      s.set(r, h, r);
      m.compose(p, q, s);
      mesh.setMatrixAt(placed, m);

      if (palette?.length) {
        c.copy(palette[Math.floor(randWorld() * palette.length)]);
        c.offsetHSL((randWorld() - 0.5) * 0.02, (randWorld() - 0.5) * 0.06, (randWorld() - 0.5) * 0.06);
        mesh.setColorAt(placed, c);
      }

      placed++;
    }

    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    group.userData.mineralMeshes.push(mesh);
    return mesh;
  }

  const gemGeo = new THREE.OctahedronGeometry(1, 0);
  gemGeo.computeVertexNormals();
  ensureVertexColorAttribute(gemGeo);
  gemGeo.computeBoundingBox();
  if (gemGeo.boundingBox) gemGeo.translate(0, -gemGeo.boundingBox.min.y, 0);

  const oreGeo = new THREE.DodecahedronGeometry(1, 0);
  oreGeo.computeVertexNormals();
  ensureVertexColorAttribute(oreGeo);
  oreGeo.computeBoundingBox();
  if (oreGeo.boundingBox) oreGeo.translate(0, -oreGeo.boundingBox.min.y, 0);

  const metalMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.35,
    metalness: 1.0,
    vertexColors: true,
    emissive: new THREE.Color("#101010"),
    emissiveIntensity: 0.25,
  });

  const diamondMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.05,
    metalness: 0.0,
    vertexColors: true,
    emissive: new THREE.Color("#7bb6ff"),
    emissiveIntensity: 0.08,
  });

  const sapphireMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.15,
    metalness: 0.0,
    vertexColors: true,
    emissive: new THREE.Color("#1a3cff"),
    emissiveIntensity: 0.09,
  });

  const rubyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.18,
    metalness: 0.0,
    vertexColors: true,
    emissive: new THREE.Color("#ff2434"),
    emissiveIntensity: 0.08,
  });

  const metalPalette = [new THREE.Color("#d7b35c"), new THREE.Color("#8d929a"), new THREE.Color("#caa35a")];
  const diamondPalette = [new THREE.Color("#e8f6ff"), new THREE.Color("#d7f0ff"), new THREE.Color("#f2fbff")];
  const sapphirePalette = [new THREE.Color("#2a68ff"), new THREE.Color("#1f4dd6"), new THREE.Color("#3d8bff")];
  const rubyPalette = [new THREE.Color("#ff2c3e"), new THREE.Color("#d91f2a"), new THREE.Color("#ff5a5a")];

  spawnInstancedMinerals({
    name: "metal",
    count: mineralCounts.metal ?? 90,
    geometry: oreGeo,
    material: metalMat,
    palette: metalPalette,
    scaleRange: [0.35, 1.05],
    heightRange: [0.35, 0.85],
    slopeMin: 0.35,
    minAboveWater: 2.2,
    embed: 0.08,
    preferBasalt: 0.6,
  });

  spawnInstancedMinerals({
    name: "diamond",
    count: mineralCounts.diamond ?? 22,
    geometry: gemGeo,
    material: diamondMat,
    palette: diamondPalette,
    scaleRange: [0.35, 0.75],
    heightRange: [0.65, 1.4],
    slopeMin: 0.42,
    minAboveWater: 2.4,
    embed: 0.18,
    preferBasalt: 0.75,
  });

  spawnInstancedMinerals({
    name: "sapphire",
    count: mineralCounts.sapphire ?? 34,
    geometry: gemGeo,
    material: sapphireMat,
    palette: sapphirePalette,
    scaleRange: [0.35, 0.85],
    heightRange: [0.75, 1.6],
    slopeMin: 0.42,
    minAboveWater: 2.2,
    embed: 0.18,
    preferBasalt: 0.75,
  });

  spawnInstancedMinerals({
    name: "ruby",
    count: mineralCounts.ruby ?? 34,
    geometry: gemGeo,
    material: rubyMat,
    palette: rubyPalette,
    scaleRange: [0.35, 0.85],
    heightRange: [0.75, 1.6],
    slopeMin: 0.42,
    minAboveWater: 2.2,
    embed: 0.18,
    preferBasalt: 0.75,
  });

  scene.add(group);
  return group;
}

function createMicroDetails({ flowerCount = 2200, bushCount = 260, logCount = 110, mushroomCount = 520, twigCount = 900, pebbleCount = 1400 } = {}) {
  const group = new THREE.Group();

  const waterLevel = getWaterLevel();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  const c = new THREE.Color();

  // Flowers (small wind-swaying billboards)
  const flowerGeo = new THREE.PlaneGeometry(0.18, 0.28, 1, 3);
  flowerGeo.translate(0, 0.14, 0);
  ensureVertexColorAttribute(flowerGeo);
  const flowerMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  enableWindSway(flowerMat, { strength: 0.42, frequency: 1.15 });
  enableSnow(flowerMat, { useLocalY: true, localYMin: 0.0, localYMax: 0.22, snowBoost: 0.6, normalInfluence: 0.0 });
  enableRainSheen(flowerMat, { strength: 0.85, roughnessMin: 0.25, darken: 0.09 });

  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerCount);
  flowers.castShadow = false;
  flowers.receiveShadow = true;
  group.add(flowers);

  const flowerPalette = [
    new THREE.Color("#f4f0d6"), // cream
    new THREE.Color("#ffd167"), // yellow
    new THREE.Color("#ff86a6"), // pink
    new THREE.Color("#8fe3ff"), // light blue
    new THREE.Color("#b7ff8f"), // lime
  ];

  let placedFlowers = 0;
  let tries = 0;
  while (placedFlowers < flowerCount && tries < flowerCount * 10) {
    tries++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;

    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.25) continue;
    if (isWaterBody(x, z, y)) continue;

    const slope = terrainSlope(x, z);
    if (slope > 0.9) continue;

    // Bias density towards pond shores and riverbanks for "discoverable" patches.
    let bias = 0.35;
    for (const pond of BIOME.ponds) {
      const d = Math.hypot(x - pond.x, z - pond.z);
      const t = 1 - smoothstep(pond.r * 0.9, pond.r * 2.2, d);
      bias = Math.max(bias, 0.35 + t * 0.55);
    }
    if (BIOME.kind !== "miniIslands") {
      const cx = riverCenterX(z);
      const d = Math.abs(x - cx);
      const t = 1 - smoothstep(WORLD.riverWidth * 1.3, WORLD.riverBankWidth * 0.7, d);
      bias = Math.max(bias, 0.35 + t * 0.35);
    }
    if (randWorld() > bias) continue;

    p.set(x, y + lerp(0.01, 0.06, randWorld()), z);
    const yaw = randWorld() * Math.PI * 2;
    e.set(0, yaw, 0);
    q.setFromEuler(e);
    const sc = lerp(0.55, 1.75, Math.pow(randWorld(), 0.6));
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    flowers.setMatrixAt(placedFlowers, m);

    const base = flowerPalette[Math.floor(randWorld() * flowerPalette.length)];
    c.copy(base).offsetHSL(lerp(-0.02, 0.02, randWorld()), lerp(-0.08, 0.08, randWorld()), lerp(-0.05, 0.05, randWorld()));
    flowers.setColorAt(placedFlowers, c);
    placedFlowers++;
  }
  flowers.count = placedFlowers;
  flowers.instanceMatrix.needsUpdate = true;
  if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
  if (flowers.instanceColor) flowers.userData.baseInstanceColor = flowers.instanceColor.array.slice();
  group.userData.flowers = flowers;

  // Bushes (low poly clumps)
  const bushGeo = new THREE.IcosahedronGeometry(1, 0);
  ensureVertexColorAttribute(bushGeo);
  const bushMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.95,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(bushMat, { useLocalY: false, snowBoost: 0.8, normalInfluence: 0.8 });
  enableRainSheen(bushMat, { strength: 0.65, roughnessMin: 0.32, darken: 0.08 });

  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, bushCount);
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  group.add(bushes);

  let placedBushes = 0;
  tries = 0;
  while (placedBushes < bushCount && tries < bushCount * 20) {
    tries++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;

    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.55) continue;
    if (isWaterBody(x, z, y)) continue;

    const slope = terrainSlope(x, z);
    if (slope > 0.72) continue;

    p.set(x, y + lerp(0.02, 0.09, randWorld()), z);
    e.set(lerp(-0.12, 0.12, randWorld()), randWorld() * Math.PI * 2, lerp(-0.12, 0.12, randWorld()));
    q.setFromEuler(e);
    const sc = lerp(0.9, 3.2, Math.pow(randWorld(), 0.7));
    s.set(sc * lerp(0.75, 1.25, randWorld()), sc * lerp(0.65, 1.05, randWorld()), sc * lerp(0.75, 1.25, randWorld()));
    m.compose(p, q, s);
    bushes.setMatrixAt(placedBushes, m);

    const hue = lerp(0.24, 0.38, randWorld());
    const sat = lerp(0.20, 0.55, randWorld());
    const lum = lerp(0.14, 0.32, randWorld());
    c.setHSL(hue, sat, lum);
    bushes.setColorAt(placedBushes, c);
    placedBushes++;
  }
  bushes.count = placedBushes;
  bushes.instanceMatrix.needsUpdate = true;
  if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
  if (bushes.instanceColor) bushes.userData.baseInstanceColor = bushes.instanceColor.array.slice();
  group.userData.bushes = bushes;

  // Fallen logs/branches
  const logGeo = new THREE.CylinderGeometry(0.1, 0.12, 1, 6, 1);
  ensureVertexColorAttribute(logGeo);
  const logMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.95,
    metalness: 0.0,
    vertexColors: true,
  });
  enableSnow(logMat, { useLocalY: false, snowBoost: 0.75, normalInfluence: 0.7 });
  enableRainSheen(logMat, { strength: 0.55, roughnessMin: 0.35, darken: 0.05 });

  const logs = new THREE.InstancedMesh(logGeo, logMat, logCount);
  logs.castShadow = true;
  logs.receiveShadow = true;
  group.add(logs);

  let placedLogs = 0;
  tries = 0;
  while (placedLogs < logCount && tries < logCount * 30) {
    tries++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;

    const y = terrainHeight(x, z);
    if (y < waterLevel + 0.6) continue;
    if (isWaterBody(x, z, y)) continue;

    const slope = terrainSlope(x, z);
    if (slope > 0.78) continue;
    if (randWorld() > 0.25) continue;

    p.set(x, y + 0.05, z);
    e.set(Math.PI / 2 + lerp(-0.3, 0.3, randWorld()), randWorld() * Math.PI * 2, lerp(-0.25, 0.25, randWorld()));
    q.setFromEuler(e);
    const len = lerp(0.8, 3.4, Math.pow(randWorld(), 0.6));
    const thick = lerp(0.6, 1.3, Math.pow(randWorld(), 1.7));
    s.set(thick, len, thick);
    m.compose(p, q, s);
    logs.setMatrixAt(placedLogs, m);

    c.setHSL(lerp(0.06, 0.11, randWorld()), lerp(0.18, 0.45, randWorld()), lerp(0.18, 0.32, randWorld()));
    logs.setColorAt(placedLogs, c);
    placedLogs++;
  }
  logs.count = placedLogs;
  logs.instanceMatrix.needsUpdate = true;
  if (logs.instanceColor) logs.instanceColor.needsUpdate = true;
  if (logs.instanceColor) logs.userData.baseInstanceColor = logs.instanceColor.array.slice();
  group.userData.logs = logs;

  // Mushrooms (wet/wooded areas)
  if (mushroomCount > 0) {
    const stemGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.28, 6, 1);
    const capGeo = new THREE.ConeGeometry(0.22, 0.22, 8, 1);
    capGeo.translate(0, 0.11, 0);
    ensureVertexColorAttribute(stemGeo);
    ensureVertexColorAttribute(capGeo);

    const stemMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#ffffff"), roughness: 0.9, metalness: 0.0, vertexColors: true });
    const capMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#ffffff"), roughness: 0.92, metalness: 0.0, vertexColors: true });
    enableSnow(stemMat, { useLocalY: false, snowBoost: 0.7, normalInfluence: 0.7 });
    enableSnow(capMat, { useLocalY: false, snowBoost: 0.7, normalInfluence: 0.6 });
    enableRainSheen(stemMat, { strength: 0.55, roughnessMin: 0.32, darken: 0.04 });
    enableRainSheen(capMat, { strength: 0.75, roughnessMin: 0.28, darken: 0.06 });

    const stems = new THREE.InstancedMesh(stemGeo, stemMat, mushroomCount);
    const caps = new THREE.InstancedMesh(capGeo, capMat, mushroomCount);
    stems.castShadow = true;
    stems.receiveShadow = true;
    caps.castShadow = true;
    caps.receiveShadow = true;
    group.add(stems, caps);

    const stemOff = new THREE.Matrix4().makeTranslation(0, 0.14, 0);
    const capOff = new THREE.Matrix4().makeTranslation(0, 0.30, 0);
    const tmp = new THREE.Matrix4();

    let placedM = 0;
    let mTries = 0;
    const ecoTmp2 = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };
    while (placedM < mushroomCount && mTries++ < mushroomCount * 30) {
      const x = lerp(-WORLD.half, WORLD.half, randWorld());
      const z = lerp(-WORLD.half, WORLD.half, randWorld());
      if (!inSpawnBounds(x, z)) continue;
      const y = terrainHeight(x, z);
      if (y < waterLevel + 0.35) continue;
      if (isWaterBody(x, z, y)) continue;
      const slope = terrainSlope(x, z);
      if (slope > 0.75) continue;

      const eco = ECO.sampleTo(ecoTmp2, x, z, y, clamp(1 - slope, 0, 1));
      const moist = clamp(eco.moist * 0.8 + eco.riparian * 0.55 + eco.wetland * 0.45, 0, 1);
      if (moist < 0.35) continue;
      if (eco.volcanic > 0.55 && randWorld() < 0.85) continue;
      if (randWorld() > moist) continue;

      p.set(x, y + 0.02, z);
      e.set(0, randWorld() * Math.PI * 2, 0);
      q.setFromEuler(e);
      const sc = lerp(0.55, 1.25, Math.pow(randWorld(), 0.8));
      s.set(sc, sc, sc);
      m.compose(p, q, s);

      tmp.copy(m).multiply(stemOff);
      stems.setMatrixAt(placedM, tmp);
      tmp.copy(m).multiply(capOff);
      caps.setMatrixAt(placedM, tmp);

      // stem color
      c.setHSL(lerp(0.10, 0.14, randWorld()), lerp(0.10, 0.22, randWorld()), lerp(0.74, 0.88, randWorld()));
      stems.setColorAt(placedM, c);
      // cap color
      c.setHSL(lerp(0.01, 0.12, randWorld()), lerp(0.22, 0.68, randWorld()), lerp(0.16, 0.38, randWorld()));
      if (randWorld() < 0.25) c.lerp(new THREE.Color("#ffffff"), 0.5);
      caps.setColorAt(placedM, c);

      placedM++;
    }
    stems.count = placedM;
    caps.count = placedM;
    stems.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    if (stems.instanceColor) stems.instanceColor.needsUpdate = true;
    if (caps.instanceColor) caps.instanceColor.needsUpdate = true;
    group.userData.mushrooms = { stems, caps };
  }

  // Twigs (ground clutter)
  if (twigCount > 0) {
    const twigGeo = new THREE.CylinderGeometry(0.03, 0.04, 1.0, 6, 1);
    ensureVertexColorAttribute(twigGeo);
    const twigMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#ffffff"), roughness: 0.95, metalness: 0.0, vertexColors: true });
    enableSnow(twigMat, { useLocalY: false, snowBoost: 0.6, normalInfluence: 0.6 });
    enableRainSheen(twigMat, { strength: 0.4, roughnessMin: 0.35, darken: 0.04 });
    const twigs = new THREE.InstancedMesh(twigGeo, twigMat, twigCount);
    twigs.castShadow = false;
    twigs.receiveShadow = true;
    group.add(twigs);

    let placedT = 0;
    let tTries = 0;
    while (placedT < twigCount && tTries++ < twigCount * 18) {
      const x = lerp(-WORLD.half, WORLD.half, randWorld());
      const z = lerp(-WORLD.half, WORLD.half, randWorld());
      if (!inSpawnBounds(x, z)) continue;
      const y = terrainHeight(x, z);
      if (y < waterLevel + 0.45) continue;
      if (isWaterBody(x, z, y)) continue;
      const slope = terrainSlope(x, z);
      if (slope > 0.9) continue;
      if (randWorld() > 0.55) continue;

      p.set(x, y + 0.02, z);
      e.set(Math.PI / 2 + lerp(-0.15, 0.15, randWorld()), randWorld() * Math.PI * 2, lerp(-0.2, 0.2, randWorld()));
      q.setFromEuler(e);
      const len = lerp(0.25, 1.3, Math.pow(randWorld(), 0.65));
      const thick = lerp(0.6, 1.25, Math.pow(randWorld(), 1.7));
      s.set(thick, len, thick);
      m.compose(p, q, s);
      twigs.setMatrixAt(placedT, m);

      c.setHSL(lerp(0.06, 0.11, randWorld()), lerp(0.12, 0.38, randWorld()), lerp(0.10, 0.28, randWorld()));
      twigs.setColorAt(placedT, c);
      placedT++;
    }
    twigs.count = placedT;
    twigs.userData.maxDrawCount = placedT;
    twigs.instanceMatrix.needsUpdate = true;
    if (twigs.instanceColor) twigs.instanceColor.needsUpdate = true;
    if (twigs.instanceColor) twigs.userData.baseInstanceColor = twigs.instanceColor.array.slice();
    group.userData.twigs = twigs;
  }

  // Pebbles (tiny rocks for extra ground texture)
  if (pebbleCount > 0) {
    const pebGeo = new THREE.IcosahedronGeometry(0.22, 0);
    ensureVertexColorAttribute(pebGeo);
    const pebMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#ffffff"), roughness: 0.92, metalness: 0.02, vertexColors: true });
    enableSnow(pebMat, { useLocalY: false, snowBoost: 0.7, normalInfluence: 0.85 });
    enableRainSheen(pebMat, { strength: 0.25, roughnessMin: 0.4, darken: 0.02 });
    const pebbles = new THREE.InstancedMesh(pebGeo, pebMat, pebbleCount);
    pebbles.castShadow = true;
    pebbles.receiveShadow = true;
    group.add(pebbles);

    let placedP = 0;
    let pTries = 0;
    while (placedP < pebbleCount && pTries++ < pebbleCount * 10) {
      const x = lerp(-WORLD.half, WORLD.half, randWorld());
      const z = lerp(-WORLD.half, WORLD.half, randWorld());
      if (!inSpawnBounds(x, z)) continue;
      const y = terrainHeight(x, z);
      if (y < waterLevel + 0.25) continue;
      if (isWaterBody(x, z, y)) continue;
      const slope = terrainSlope(x, z);
      if (slope > 0.95) continue;

      // Bias towards shore/river/pond edges.
      let bias = 0.35;
      for (const pond of BIOME.ponds) {
        const d = Math.hypot(x - pond.x, z - pond.z);
        const t = 1 - smoothstep(pond.r * 0.95, pond.r * 2.0, d);
        bias = Math.max(bias, 0.35 + t * 0.55);
      }
      if (BIOME.kind !== "miniIslands") {
        const d = Math.abs(x - riverCenterX(z));
        const t = 1 - smoothstep(WORLD.riverWidth * 1.1, WORLD.riverBankWidth * 0.55, d);
        bias = Math.max(bias, 0.35 + t * 0.35);
      }
      if (randWorld() > bias) continue;

      p.set(x, y + 0.02, z);
      e.set(randWorld() * Math.PI, randWorld() * Math.PI * 2, randWorld() * Math.PI);
      q.setFromEuler(e);
      const sc = lerp(0.25, 1.15, Math.pow(randWorld(), 1.3));
      s.set(sc * lerp(0.55, 1.35, randWorld()), sc * lerp(0.35, 1.25, randWorld()), sc * lerp(0.55, 1.35, randWorld()));
      m.compose(p, q, s);
      pebbles.setMatrixAt(placedP, m);

      c.setHSL(lerp(0.58, 0.12, randWorld()), lerp(0.05, 0.18, randWorld()), lerp(0.18, 0.55, randWorld()));
      pebbles.setColorAt(placedP, c);
      placedP++;
    }
    pebbles.count = placedP;
    pebbles.userData.maxDrawCount = placedP;
    pebbles.instanceMatrix.needsUpdate = true;
    if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
    if (pebbles.instanceColor) pebbles.userData.baseInstanceColor = pebbles.instanceColor.array.slice();
    group.userData.pebbles = pebbles;
  }

  scene.add(group);
  return group;
}

function createWildlife({ birdCountMax = 44, rippleCount = 14, fishCountMax = 46 } = {}) {
	  const sys = {
	    group: new THREE.Group(),
	    birds: [],
	    birdCap: birdCountMax,
	    deer: null,
	    ripples: [],
	    rippleTimer: 0,
	    birdTimer: 0,
	    fish: null,
	  };
	  sys.group.name = "wildlife";
	  scene.add(sys.group);

  // Birds (simple silhouettes crossing the scene)
  const birdGeo = new THREE.PlaneGeometry(0.9, 0.35, 1, 1);
  birdGeo.rotateY(Math.PI * 0.5);
  const birdMats = [
    new THREE.MeshBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ color: 0x10131c, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ color: 0x0a0f18, transparent: true, opacity: 0.78, depthWrite: false, side: THREE.DoubleSide }),
  ];

  function spawnBird(b) {
    const wdx0 = sharedUniforms.uWindDir.value.x;
    const wdz0 = sharedUniforms.uWindDir.value.y;
    const wLen = Math.hypot(wdx0, wdz0) || 1;
    const wdx = wdx0 / wLen;
    const wdz = wdz0 / wLen;
    const pdx = -wdz;
    const pdz = wdx;

    const down = WORLD.half * 1.05;
    const cross = WORLD.half * 0.85;
    const along = -down - lerp(0, 40, randSim());
    const across = lerp(-cross, cross, randSim());

    b.along = along;
    b.cross = across;
    b.baseY = lerp(38, 70, randSim());
    b.speed = lerp(10, 22, randSim()) * (0.7 + 0.6 * clamp(sharedUniforms.uWindStrength.value / 2.5, 0, 1));
    b.phase = randSim() * Math.PI * 2;
    b.roll = lerp(-0.25, 0.25, randSim());

    b.wdx = wdx;
    b.wdz = wdz;
    b.pdx = pdx;
    b.pdz = pdz;

    b.mesh.visible = true;
  }
  sys.spawnBird = spawnBird;

  for (let i = 0; i < birdCountMax; i++) {
    const mat = birdMats[Math.floor(randWorld() * birdMats.length)];
    const mesh = new THREE.Mesh(birdGeo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    sys.group.add(mesh);
    const b = { mesh, along: 0, cross: 0, baseY: 50, speed: 15, phase: 0, roll: 0, wdx: 1, wdz: 0, pdx: 0, pdz: 1 };
    sys.birds.push(b);
  }
	for (let i = 0; i < Math.min(3, sys.birds.length); i++) sys.spawnBird(sys.birds[i]);

	sys.setBirdCap = (cap) => {
	  const next = clamp(Math.floor(cap), 0, sys.birds.length);
	  sys.birdCap = next;
	  for (let i = next; i < sys.birds.length; i++) sys.birds[i].mesh.visible = false;
	};

	// Perched shore birds (small takeoff/landing near water edges)
	sys.perchBirds = [];
	const perchGeo = new THREE.ConeGeometry(0.12, 0.42, 6, 1);
	const perchMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#10131c"), roughness: 0.95, metalness: 0.0 });
	const perchCount = 14;

	function placePerch(pb) {
	  const seaY = BIOME.kind === "miniIslands" ? BIOME.seaLevel : BIOME.coastWaterLevel;
	  for (let k = 0; k < 90; k++) {
	    const x = lerp(-WORLD.half, WORLD.half, randWorld());
	    const z = lerp(-WORLD.half, WORLD.half, randWorld());
	    if (!inSpawnBounds(x, z)) continue;
	    const y = terrainHeight(x, z);
	    if (y < getWaterLevel() + 0.45) continue;
	    if (isWaterBody(x, z, y)) continue;
	    const slope = terrainSlope(x, z);
	    if (slope > 0.85) continue;

	    let bias = 0.25;
	    for (const pond of BIOME.ponds) {
	      const d = Math.hypot(x - pond.x, z - pond.z);
	      const t = 1 - smoothstep(pond.r * 1.0, pond.r * 2.4, d);
	      bias = Math.max(bias, 0.25 + t * 0.6);
	    }
	    if (BIOME.kind !== "miniIslands") {
	      const d = Math.abs(x - riverCenterX(z));
	      const t = 1 - smoothstep(WORLD.riverWidth * 1.35, WORLD.riverBankWidth * 0.95, d);
	      bias = Math.max(bias, 0.25 + t * 0.45);
	      const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
	      const coastT = smoothstep(BIOME.shorePos - BIOME.shoreWidth * 0.18, BIOME.shorePos + BIOME.shoreWidth * 0.55, coastCoord);
	      const nearSea = coastT * (1 - smoothstep(seaY - 0.15, seaY + 1.45, y));
	      bias = Math.max(bias, 0.25 + nearSea * 0.55);
	    } else {
	      const nearSea = 1 - smoothstep(seaY + 0.35, seaY + 2.4, y);
	      bias = Math.max(bias, 0.25 + nearSea * 0.55);
	    }

	    if (randWorld() > bias) continue;

	    pb.pos.set(x, y + 0.22, z);
	    pb.yGround = y + 0.22;
	    pb.state = "perched";
	    pb.timer = lerp(1.0, 4.0, randWorld());
	    pb.mesh.visible = true;
	    pb.mesh.position.copy(pb.pos);
	    pb.mesh.rotation.set(0, randWorld() * Math.PI * 2, 0);
	    pb.mesh.scale.setScalar(lerp(0.75, 1.2, randWorld()));
	    return;
	  }
	  pb.mesh.visible = false;
	}
	sys.placePerch = placePerch;

	for (let i = 0; i < perchCount; i++) {
	  const mesh = new THREE.Mesh(perchGeo, perchMat);
	  mesh.frustumCulled = false;
	  mesh.castShadow = true;
	  mesh.receiveShadow = true;
	  mesh.visible = false;
	  sys.group.add(mesh);
	  const pb = {
	    mesh,
	    pos: new THREE.Vector3(),
	    yGround: 0,
	    state: "perched",
	    timer: 0,
	    flyAge: 0,
	    flyLife: 0,
	    baseY: 0,
	    speed: 0,
	  };
	  sys.perchBirds.push(pb);
	  sys.placePerch(pb);
	}

	// Deer (one simple wanderer near ponds)
	function createDeer() {
	    if (!BIOME.ponds?.length) return null;
	    const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#7a5530"), roughness: 0.95, metalness: 0.0 });
	    const hoofMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#2a221b"), roughness: 0.95, metalness: 0.0 });

    const g = new THREE.Group();
    g.scale.set(0.9, 0.9, 0.9);

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.65, 0.55), bodyMat);
    body.position.set(0, 0.65, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

	    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), bodyMat);
	    neck.position.set(0.75, 0.85, 0);
	    neck.castShadow = true;
	    neck.receiveShadow = true;
	    g.add(neck);

	    const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.3, 0.3), bodyMat);
	    head.position.set(1.05, 0.78, 0);
	    head.castShadow = true;
	    head.receiveShadow = true;
	    g.add(head);

    const legGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.65, 6, 1);
    for (const sx of [-0.45, 0.35]) {
      for (const sz of [-0.18, 0.18]) {
        const leg = new THREE.Mesh(legGeo, hoofMat);
        leg.position.set(sx, 0.25, sz);
        leg.castShadow = true;
        leg.receiveShadow = true;
        g.add(leg);
      }
    }

	    const pond = BIOME.ponds[0];
	    g.position.set(pond.x + pond.r * 1.35, terrainHeight(pond.x + pond.r * 1.35, pond.z), pond.z);
	    g.userData.target = g.position.clone();
	    g.userData.timer = 0;
	    g.userData.speed = 2.2;
	    g.userData.pondIndex = 0;
	    g.userData.head = head;
	    g.userData.neck = neck;
	    g.userData.drinkTimer = 0;
	    g.userData.wantDrink = false;
	    sys.group.add(g);
	    return g;
	  }
  if (BIOME.kind !== "miniIslands") sys.deer = createDeer();

  // Pond ripples (small rings that spawn occasionally)
  const rippleGeo = new THREE.RingGeometry(0.18, 0.22, 32, 1);
  rippleGeo.rotateX(-Math.PI / 2);
  const rippleMat = new THREE.MeshBasicMaterial({
    color: 0xe9f6ff,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

	  for (let i = 0; i < rippleCount; i++) {
	    const mesh = new THREE.Mesh(rippleGeo, rippleMat.clone());
	    mesh.visible = false;
	    mesh.renderOrder = 4;
	    sys.group.add(mesh);
	    sys.ripples.push({ mesh, age: 0, life: 1, pondIndex: 0, active: false, baseScale: 1 });
	  }

	  sys.spawnRipple = (pondIndex = 0) => {
	    if (!BIOME.ponds?.length) return;
	    const pond = BIOME.ponds[pondIndex % BIOME.ponds.length];
	    if (!pond) return;

    const r = pond.r * lerp(0.05, 0.55, randSim());
    const a = randSim() * Math.PI * 2;
    const x = pond.x + Math.cos(a) * r;
    const z = pond.z + Math.sin(a) * r;

    for (const rr of sys.ripples) {
      if (rr.active) continue;
      rr.active = true;
      rr.age = 0;
      rr.life = lerp(1.2, 2.0, randSim());
      rr.pondIndex = pondIndex;
      rr.mesh.position.set(x, pond.level + 0.04, z);
      rr.baseScale = lerp(0.6, 1.1, randSim());
      rr.mesh.scale.setScalar(rr.baseScale);
      rr.mesh.material.opacity = 0.0;
      rr.mesh.visible = true;
      break;
    }
	  };

	  // Fish: simple swimmers under pond/sea surfaces.
	  if (fishCountMax > 0) {
	    const fishGeo = new THREE.ConeGeometry(0.16, 0.55, 6, 1);
	    fishGeo.rotateX(Math.PI / 2);

	    const fishMat = new THREE.MeshStandardMaterial({
	      color: 0xffffff,
	      roughness: 0.75,
	      metalness: 0.0,
	      emissive: new THREE.Color(0x102030),
	      emissiveIntensity: 0.55,
	      vertexColors: true,
	    });

	    const fishMesh = new THREE.InstancedMesh(fishGeo, fishMat, fishCountMax);
	    fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
	    fishMesh.castShadow = false;
	    fishMesh.receiveShadow = false;
	    fishMesh.frustumCulled = false;
	    fishMesh.renderOrder = -1;
	    sys.group.add(fishMesh);

	    const fishData = [];
	    const seaLevel = BIOME.kind === "miniIslands" ? BIOME.seaLevel : BIOME.coastWaterLevel;
	    const hasPonds = (BIOME.ponds?.length ?? 0) > 0;

	    function sampleSeaHome() {
	      for (let k = 0; k < 36; k++) {
	        const x = lerp(-WORLD.half, WORLD.half, randWorld());
	        const z = lerp(-WORLD.half, WORLD.half, randWorld());
	        const y = terrainHeight(x, z);
	        if (!isCoastSea(x, z, y)) continue;
	        return { x, z };
	      }
	      const x = (BIOME.coastDir?.x ?? 0) * WORLD.half * 0.72;
	      const z = (BIOME.coastDir?.y ?? 1) * WORLD.half * 0.72;
	      return { x, z };
	    }

	    const tmpCol = new THREE.Color();
	    for (let i = 0; i < fishCountMax; i++) {
	      const preferPond = hasPonds && randWorld() < 0.82;
	      if (preferPond) {
	        const pondIndex = Math.floor(randWorld() * BIOME.ponds.length);
	        const pond = BIOME.ponds[pondIndex];
	        const r = (pond?.r ?? 6) * lerp(0.12, 0.78, Math.pow(randWorld(), 0.55));
	        const depth = lerp(0.15, Math.min(1.25, (pond?.depth ?? 1) * 0.65 + 0.45), Math.pow(randWorld(), 0.7));
	        const dir = randWorld() < 0.5 ? 1 : -1;
	        fishData.push({
	          mode: "pond",
	          pondIndex,
	          radius: r,
	          depth,
	          dir,
	          phase: randWorld() * Math.PI * 2,
	          speed: lerp(0.6, 1.7, randWorld()),
	          wiggle: lerp(3.5, 7.0, randWorld()),
	          size: lerp(0.55, 1.15, Math.pow(randWorld(), 1.6)),
	        });
	      } else {
	        const home = sampleSeaHome();
	        fishData.push({
	          mode: "sea",
	          x: home.x,
	          z: home.z,
	          waterY: seaLevel,
	          radius: lerp(2.0, 7.5, Math.pow(randWorld(), 0.65)),
	          depth: lerp(0.25, 1.1, Math.pow(randWorld(), 0.7)),
	          dir: randWorld() < 0.5 ? 1 : -1,
	          phase: randWorld() * Math.PI * 2,
	          speed: lerp(0.4, 1.2, randWorld()),
	          wiggle: lerp(2.6, 5.8, randWorld()),
	          size: lerp(0.5, 1.0, Math.pow(randWorld(), 1.4)),
	        });
	      }

	      // Subtle color variety (blue/green/brown)
	      tmpCol.setHSL(lerp(0.52, 0.12, randWorld()), lerp(0.2, 0.55, randWorld()), lerp(0.25, 0.55, randWorld()));
	      fishMesh.setColorAt(i, tmpCol);
	    }
	    if (fishMesh.instanceColor) fishMesh.instanceColor.needsUpdate = true;

	    const fishSys = { mesh: fishMesh, data: fishData, fishCap: fishCountMax };
	    fishMesh.count = fishCountMax;
	    sys.fish = fishSys;
	    sys.setFishCap = (cap) => {
	      const next = clamp(Math.floor(cap), 0, fishSys.data.length);
	      fishSys.fishCap = next;
	      fishSys.mesh.count = next;
	      fishSys.mesh.instanceMatrix.needsUpdate = true;
	    };
	  }

	  return sys;
	}

function createCloudField() {
  const clouds = new THREE.Group();

  const geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);

  const vertexShader = /* glsl */ `
    out vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fragmentShader = /* glsl */ `
    precision highp float;
    precision highp int;

    in vec3 vWorldPos;
    out vec4 outColor;

    uniform float uTime;
    uniform vec2 uWindDir;
    uniform float uWindStrength;
    uniform vec3 uSunDirWorld;
    uniform mat4 uInvModel;
    uniform float uSeed;
    uniform float uCoverage;
	    uniform float uOpacity;
	    uniform float uOpacityMul;
	    uniform int uSteps;
	    uniform int uShadowSteps;

    #define MAX_STEPS 32
    #define MAX_SHADOW_STEPS 4

    float hash31(vec3 p) {
      return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
    }

    float noise3(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);

      float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
      float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
      float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
      float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
      float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
      float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
      float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
      float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

      float nx00 = mix(n000, n100, f.x);
      float nx10 = mix(n010, n110, f.x);
      float nx01 = mix(n001, n101, f.x);
      float nx11 = mix(n011, n111, f.x);
      float nxy0 = mix(nx00, nx10, f.y);
      float nxy1 = mix(nx01, nx11, f.y);
      return mix(nxy0, nxy1, f.z);
    }

    // Optimized: reduced from 5 to 3 octaves for better performance
    float fbm(vec3 p) {
      float v = 0.0;
      float a = 0.6;
      for (int i = 0; i < 3; i++) {
        v += a * noise3(p);
        p *= 2.1;
        a *= 0.5;
      }
      return v;
    }

	    float densityAt(vec3 p) {
	      // IMPORTANT: do not advect the *shape* with unbounded time.
	      // Doing so makes r grow forever and the cloud fades to nothing.
	      // We only evolve the internal noise with a bounded offset.
	      vec3 q = p;
	      float wind01 = clamp(uWindStrength / 2.5, 0.0, 1.0);
	      vec2 adv = normalize(uWindDir) * (uTime * (0.10 + 0.18 * wind01));
	      adv = (fract(adv / 64.0) - 0.5) * 64.0;

	      float r = length(q * vec3(1.05, 0.72, 1.0));
	      float shape = smoothstep(0.62, 0.18, r);
	      shape *= smoothstep(-0.5, -0.2, q.y) * smoothstep(0.55, 0.2, q.y);

	      // Optimized: use single fbm sample instead of two
	      vec3 nP = q * 2.8 + vec3(adv.x, 0.0, adv.y) + vec3(uSeed, uSeed * 0.37, uSeed * 1.91);
	      float n = fbm(nP);
	      float d = n;

      float cov = clamp(uCoverage, 0.0, 1.0);
      float thresh = mix(0.86, 0.36, cov);
      d = smoothstep(thresh, 0.98, d);

      return d * shape * mix(0.85, 1.35, cov);
    }

    vec2 intersectBox(vec3 ro, vec3 rd) {
      vec3 invR = 1.0 / rd;
      vec3 t0 = (-0.5 - ro) * invR;
      vec3 t1 = ( 0.5 - ro) * invR;
      vec3 tmin = min(t0, t1);
      vec3 tmax = max(t0, t1);
      float tN = max(max(tmin.x, tmin.y), tmin.z);
      float tF = min(min(tmax.x, tmax.y), tmax.z);
      return vec2(tN, tF);
    }

    float phaseHG(float mu, float g) {
      float gg = g * g;
      return (1.0 - gg) / pow(1.0 + gg - 2.0 * g * mu, 1.5);
    }

    void main() {
      vec3 roW = cameraPosition;
      vec3 rdW = normalize(vWorldPos - cameraPosition);

      vec3 ro = (uInvModel * vec4(roW, 1.0)).xyz;
      vec3 rd = normalize((uInvModel * vec4(rdW, 0.0)).xyz);

      vec2 hit = intersectBox(ro, rd);
      float tN = hit.x;
      float tF = hit.y;
      if (tF < 0.0 || tN > tF) discard;
      tN = max(tN, 0.0);

      vec3 sunDirL = normalize((uInvModel * vec4(normalize(uSunDirWorld), 0.0)).xyz);

      int steps = max(uSteps, 1);
      int shadowSteps = max(uShadowSteps, 1);

      float t = tN;
      float lenSeg = (tF - tN);
      float stepSize = lenSeg / float(steps);

      float jitter = hash31(vec3(gl_FragCoord.xy, uSeed)) - 0.5;
      t += jitter * stepSize;

      vec3 col = vec3(0.0);
      float alpha = 0.0;

      vec3 sunCol = vec3(1.0, 0.96, 0.90);
      vec3 ambCol = vec3(0.70, 0.78, 0.92);

      float g = 0.58;
      float mu = dot(rd, sunDirL);
      float phase = phaseHG(mu, g) * 0.22;

      for (int i = 0; i < MAX_STEPS; i++) {
        if (i >= steps) break;
        vec3 p = ro + rd * t;
        float d = densityAt(p);

        if (d > 0.001) {
          float tr = 1.0;
          float ts = stepSize * 1.8;
          vec3 sp = p;
          for (int j = 0; j < MAX_SHADOW_STEPS; j++) {
            if (j >= shadowSteps) break;
            sp += sunDirL * ts;
            float sd = densityAt(sp);
            tr *= exp(-sd * ts * 2.2);
          }

          vec3 light = ambCol * 0.35 + sunCol * (phase * tr + 0.16 * tr);
          float a = 1.0 - exp(-d * stepSize * 4.0);

          col += (1.0 - alpha) * light * a;
          alpha += (1.0 - alpha) * a;

          if (alpha > 0.985) break;
        }

        t += stepSize;
        if (t > tF) break;
      }

	      alpha *= (uOpacity * uOpacityMul);
	      if (alpha < 0.002) discard;

	      outColor = vec4(col, alpha);
	    }
	  `;
  // Store shared references for dynamic cloud spawning
  const cloudSystem = {
    group: clouds,
    geo,
    vertexShader,
    fragmentShader,
    cloudDefs: [],
    materials: [],
    maxClouds: 8,
  };

  // Helper function to create a single cloud with random properties
  function spawnCloud(rng = randWorld, spawnEdge = null) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      glslVersion: THREE.GLSL3,
      uniforms: {
        uTime: sharedUniforms.uTime,
        uWindDir: sharedUniforms.uWindDir,
        uWindStrength: sharedUniforms.uWindStrength,
        uSunDirWorld: sharedUniforms.uSunDirWorld,
        uInvModel: { value: new THREE.Matrix4() },
        uSeed: { value: rng() * 1000 },
        uCoverage: { value: 0.55 },
        uOpacity: { value: 0.75 },
        uOpacityMul: { value: 1.0 },
        uSteps: { value: 12 },
        uShadowSteps: { value: 2 },
      },
      vertexShader: cloudSystem.vertexShader,
      fragmentShader: cloudSystem.fragmentShader,
    });
    cloudSystem.materials.push(mat);

    const mesh = new THREE.Mesh(cloudSystem.geo, mat);
    mesh.frustumCulled = false;

    // Randomized cloud size with more variation
    const sizeScale = 0.6 + rng() * 0.9; // 0.6 to 1.5x base size
    const baseWidth = lerp(16, 40, rng());
    const baseHeight = lerp(6, 16, rng());
    const baseDepth = lerp(12, 32, rng());
    mesh.scale.set(
      baseWidth * sizeScale,
      baseHeight * sizeScale,
      baseDepth * sizeScale
    );

    // Position - either random or at spawn edge
    let x, z;
    const spawnRange = WORLD.half * 0.85;

    if (spawnEdge === 'left') {
      x = -spawnRange;
      z = lerp(-spawnRange, spawnRange, rng());
    } else if (spawnEdge === 'right') {
      x = spawnRange;
      z = lerp(-spawnRange, spawnRange, rng());
    } else if (spawnEdge === 'front') {
      x = lerp(-spawnRange, spawnRange, rng());
      z = -spawnRange;
    } else if (spawnEdge === 'back') {
      x = lerp(-spawnRange, spawnRange, rng());
      z = spawnRange;
    } else {
      // Random position within world
      x = lerp(-spawnRange, spawnRange, rng());
      z = lerp(-spawnRange, spawnRange, rng());
    }

    const y = lerp(28, 52, rng());
    mesh.position.set(x, y, z);
    mesh.rotation.y = rng() * Math.PI * 2;

    const cloudDef = {
      mesh,
      mat,
      speed: lerp(0.4, 1.0, rng()),
      bob: lerp(0.08, 0.35, rng()),
      phase: rng() * Math.PI * 2,
      baseY: y,
      baseScale: mesh.scale.clone(),
      fade: 1.0,
    };

    cloudSystem.cloudDefs.push(cloudDef);
    cloudSystem.group.add(mesh);

    mesh.onBeforeRender = () => {
      mat.uniforms.uInvModel.value.copy(mesh.matrixWorld).invert();
    };

    return cloudDef;
  }

  function resetCloud(cloudDef, rng = randSim) {
    const { mesh, mat } = cloudDef;

    const sizeScale = 0.6 + rng() * 0.9;
    const baseWidth = lerp(16, 40, rng());
    const baseHeight = lerp(6, 16, rng());
    const baseDepth = lerp(12, 32, rng());
    mesh.scale.set(baseWidth * sizeScale, baseHeight * sizeScale, baseDepth * sizeScale);
    cloudDef.baseScale = cloudDef.baseScale ?? new THREE.Vector3();
    cloudDef.baseScale.copy(mesh.scale);

    mesh.rotation.y = rng() * Math.PI * 2;
    const y = lerp(28, 52, rng());
    cloudDef.baseY = y;

    cloudDef.speed = lerp(0.4, 1.0, rng());
    cloudDef.bob = lerp(0.08, 0.35, rng());
    cloudDef.phase = rng() * Math.PI * 2;

    cloudDef.fade = 0.0;
    mat.uniforms.uOpacityMul.value = 0.0;
    mat.uniforms.uSeed.value = rng() * 1000;
  }

  // Helper to remove a cloud from the scene and memory
  function despawnCloud(cloudDef) {
    const idx = cloudSystem.cloudDefs.indexOf(cloudDef);
    if (idx !== -1) {
      cloudSystem.cloudDefs.splice(idx, 1);
    }
    const matIdx = cloudSystem.materials.indexOf(cloudDef.mat);
    if (matIdx !== -1) {
      cloudSystem.materials.splice(matIdx, 1);
    }
    cloudSystem.group.remove(cloudDef.mesh);
    cloudDef.mesh.geometry = null;  // Don't dispose shared geo
    cloudDef.mat.dispose();
  }

  // Spawn initial clouds
  const initialCloudCount = 5;
  for (let i = 0; i < initialCloudCount; i++) {
    spawnCloud(randWorld);
  }

  // Store helpers for animation loop access
  cloudSystem.spawnCloud = spawnCloud;
  cloudSystem.despawnCloud = despawnCloud;
  cloudSystem.resetCloud = resetCloud;

  clouds.userData = cloudSystem;
  scene.add(clouds);
  return clouds;
}

function createParticles({ count = 2500, color = 0xffffff, size = 0.08 } = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3 + 0] = lerp(-WORLD.half, WORLD.half, randWorld());
    pos[i * 3 + 1] = lerp(5, 85, randWorld());
    pos[i * 3 + 2] = lerp(-WORLD.half, WORLD.half, randWorld());
    seed[i] = randWorld();
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));

  const mat = new THREE.PointsMaterial({
    color,
    size,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

function createRainbow() {
  const group = new THREE.Group();
  group.name = "rainbow";
  group.visible = false;
  group.renderOrder = 8;

  const arc = Math.PI * 1.12;
  const bands = [
    { c: 0xff3b3b, r: 62.5 },
    { c: 0xff8c2f, r: 61.3 },
    { c: 0xffe66b, r: 60.1 },
    { c: 0x5cff6b, r: 58.9 },
    { c: 0x3ea0ff, r: 57.7 },
    { c: 0x7b4dff, r: 56.5 },
  ];

  const mats = [];
  for (const b of bands) {
    const geo = new THREE.TorusGeometry(b.r, 0.95, 6, 180, arc);
    const mat = new THREE.MeshBasicMaterial({
      color: b.c,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    mats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    // Rotate so the arc sits above the horizon.
    mesh.rotation.z = -arc * 0.5 - Math.PI * 0.06;
    group.add(mesh);
  }

  group.userData.mats = mats;
  const tmpSun = new THREE.Vector3();
  const tmpAnti = new THREE.Vector3();
  group.userData.update = (timeMeta) => {
    const show = clamp(sim.rainbow?.show ?? 0, 0, 1);
    if (show <= 0) {
      group.visible = false;
      for (const m of mats) m.opacity = 0;
      return;
    }

    const day = clamp(timeMeta?.day ?? 1, 0, 1);
    const cloud = clamp(sim.cloudiness, 0, 1);
    const night = 1 - day;
    const fade = show * smoothstep(0.08, 0.35, day) * (1 - smoothstep(0.25, 1.0, night)) * (1 - cloud * 0.55);
    if (fade <= 0.01) {
      group.visible = false;
      for (const m of mats) m.opacity = 0;
      return;
    }

    tmpSun.copy(sharedUniforms.uSunDirWorld.value).normalize();
    tmpAnti.copy(tmpSun).multiplyScalar(-1).normalize();
    group.position.copy(camera.position).addScaledVector(tmpAnti, 210).add(new THREE.Vector3(0, 38, 0));
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tmpAnti);
    group.visible = true;
    for (let i = 0; i < mats.length; i++) {
      const bandFade = fade * lerp(0.13, 0.24, 1 - i / Math.max(1, mats.length - 1));
      mats[i].opacity = bandFade;
    }
  };

  scene.add(group);
  return group;
}

function createFireflies({ count = 520 } = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const base = new Float32Array(count * 2);

  const ecoTmp = { temp: 0, moist: 0, geo: 0, dry: 0, wetland: 0, alpine: 0, volcanic: 0, clay: 0, riparian: 0, scree: 0 };
  let placed = 0;
  let tries = 0;
  while (placed < count && tries < count * 40) {
    tries++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;
    const y = terrainHeight(x, z);
    if (y < getWaterLevel() + 0.25) continue;
    if (isWaterBody(x, z, y)) continue;
    const slope = terrainSlope(x, z);
    const ny = clamp(1.0 - slope, 0, 1);
    const eco = ECO.sampleTo(ecoTmp, x, z, y, ny);
    const wetBias = clamp(eco.wetland * 0.9 + eco.riparian * 0.55 + eco.moist * 0.25, 0, 1);
    if (wetBias < 0.25) continue;
    if (randWorld() > wetBias) continue;

    const h = lerp(0.25, 2.1, Math.pow(randWorld(), 1.7));
    pos[placed * 3 + 0] = x;
    pos[placed * 3 + 1] = y + h;
    pos[placed * 3 + 2] = z;
    base[placed * 2 + 0] = x;
    base[placed * 2 + 1] = z;
    seed[placed] = randWorld();
    placed++;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.setAttribute("aBase", new THREE.BufferAttribute(base, 2));

  const mat = new THREE.PointsMaterial({
    color: 0xc9ff8a,
    size: 0.12,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.visible = false;

  pts.userData.update = (dt, timeMeta) => {
    const night = 1 - clamp(timeMeta?.day ?? 1, 0, 1);
    const cloud = clamp(sim.cloudiness, 0, 1);
    const w = sim.activeWeather;
    const allow = w !== "blizzard" && w !== "sandstorm" && w !== "thunderstorm";
    const fade = allow ? smoothstep(0.45, 0.95, night) * (1 - cloud * 0.65) : 0.0;
    pts.visible = fade > 0.02;
    mat.opacity = fade * 0.85;

    if (!pts.visible) return;
    const pAttr = geo.getAttribute("position");
    const bAttr = geo.getAttribute("aBase");
    const sAttr = geo.getAttribute("aSeed");
    const t = sharedUniforms.uTime.value;
    for (let i = 0; i < pAttr.count; i++) {
      const bx = bAttr.getX(i);
      const bz = bAttr.getY(i);
      const s = sAttr.getX(i);
      const y0 = terrainHeight(bx, bz) + 0.35 + s * 1.9;
      const wob = Math.sin(t * (0.8 + 1.3 * s) + s * 33.0) * 0.35;
      const wob2 = Math.cos(t * (1.1 + 1.1 * s) + s * 12.0) * 0.25;
      pAttr.setXYZ(i, bx + wob2, y0 + wob, bz + wob);
    }
    pAttr.needsUpdate = true;
  };

  scene.add(pts);
  return pts;
}

function createPlankton({ count = 2200 } = {}) {
  const seaLevel = BIOME.kind === "miniIslands" ? BIOME.seaLevel : BIOME.coastWaterLevel;

  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const base = new Float32Array(count * 3);

  let placed = 0;
  let tries = 0;
  while (placed < count && tries++ < count * 40) {
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z, 1.05)) continue;
    const yLand = terrainHeight(x, z);
    if (!isCoastSea(x, z, yLand)) continue;

    const depth = lerp(0.15, 1.35, Math.pow(randWorld(), 0.7));
    const y = seaLevel - depth + lerp(-0.06, 0.06, randWorld());
    base[placed * 3 + 0] = x;
    base[placed * 3 + 1] = y;
    base[placed * 3 + 2] = z;
    pos[placed * 3 + 0] = x;
    pos[placed * 3 + 1] = y;
    pos[placed * 3 + 2] = z;
    seed[placed] = randWorld();
    placed++;
  }

  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.setAttribute("aBase", new THREE.BufferAttribute(base, 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: sharedUniforms.uTime,
      uFade: { value: 0 },
      uPixRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uFade;
      uniform float uPixRatio;
      attribute float aSeed;
      attribute vec3 aBase;
      varying float vSeed;
      varying float vFade;
      void main() {
        vSeed = aSeed;
        vFade = uFade;
        vec3 p = aBase;
        float t = uTime;
        float wob = sin(t * (0.8 + aSeed * 1.4) + aSeed * 37.0) * 0.12;
        p.y += wob;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(1.0, -mv.z);
        float baseSize = mix(1.6, 3.2, aSeed);
        gl_PointSize = baseSize * uPixRatio * (40.0 / d);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      varying float vSeed;
      varying float vFade;
      void main() {
        vec2 uv = gl_PointCoord.xy - 0.5;
        float r = dot(uv, uv);
        float disc = smoothstep(0.25, 0.0, r);
        float flick = 0.35 + 0.65 * (sin(uTime * (2.1 + vSeed * 4.0) + vSeed * 61.0) * 0.5 + 0.5);
        vec3 colA = vec3(0.10, 0.95, 0.85);
        vec3 colB = vec3(0.25, 0.55, 1.00);
        vec3 col = mix(colB, colA, smoothstep(0.2, 0.9, vSeed));
        float a = disc * flick * vFade;
        gl_FragColor = vec4(col * a, a);
      }
    `,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.visible = false;
  // Render before water (both are transparent); water will overlay/refraction it.
  pts.renderOrder = -1;

  // A subtle "sea glow" light at night when near plankton.
  const glow = new THREE.PointLight(0x4fffe9, 0, 90, 2.2);
  glow.castShadow = false;
  glow.visible = true;
  scene.add(glow);

  pts.userData.update = (dt, timeMeta) => {
    const day = clamp(timeMeta?.day ?? 1, 0, 1);
    const night = 1 - day;
    const cloud = clamp(sim.cloudiness, 0, 1);
    const w = sim.activeWeather;
    const allow = w !== "blizzard" && w !== "sandstorm";
    const fadeBase = allow ? smoothstep(0.30, 0.92, night) * (1 - cloud * 0.7) : 0.0;

    // Only show when camera is near the coast/sea.
    const camX = camera.position.x;
    const camZ = camera.position.z;
    const camY = terrainHeight(camX, camZ);
    let seaNear = 0;
    if (BIOME.kind === "miniIslands") {
      seaNear = clamp(1 - smoothstep(seaLevel + 0.35, seaLevel + 3.5, camY), 0, 1);
    } else {
      const coastCoord = camX * BIOME.coastDir.x + camZ * BIOME.coastDir.y;
      const coastT = smoothstep(BIOME.shorePos - BIOME.shoreWidth * 0.05, BIOME.shorePos + BIOME.shoreWidth * 0.65, coastCoord);
      const nearSeaY = 1 - smoothstep(seaLevel - 0.15, seaLevel + 2.4, camY);
      seaNear = clamp(coastT * (0.25 + 0.75 * nearSeaY), 0, 1);
    }

    const fade = fadeBase * smoothstep(0.15, 0.65, seaNear) * (w === "fog" ? 0.55 : w === "thunderstorm" ? 0.75 : 1.0);
    mat.uniforms.uFade.value = fade;
    pts.visible = fade > 0.01;
    glow.intensity = Math.max(0, fade * 1.1) * (1.0 - cloud * 0.55);
    glow.distance = 70 + 40 * fade;
    glow.position.set(camera.position.x, seaLevel + 1.4, camera.position.z);
    if (!pts.visible) return;

    // Gentle drift with wind, wrapped in world bounds.
    const pAttr = geo.getAttribute("position");
    const bAttr = geo.getAttribute("aBase");
    const sAttr = geo.getAttribute("aSeed");
    const t = sharedUniforms.uTime.value;
    const wind = sharedUniforms.uWindStrength.value;
    const wx = sharedUniforms.uWindDir.value.x * wind * 0.18;
    const wz = sharedUniforms.uWindDir.value.y * wind * 0.18;
    const area = WORLD.half * 1.05;
    for (let i = 0; i < pAttr.count; i++) {
      const bx = bAttr.getX(i);
      const by = bAttr.getY(i);
      const bz = bAttr.getZ(i);
      const s = sAttr.getX(i);
      let x = bx + wx * (t * (0.35 + 0.65 * s));
      let z = bz + wz * (t * (0.35 + 0.65 * s));
      if (x < -area) x += area * 2;
      if (x > area) x -= area * 2;
      if (z < -area) z += area * 2;
      if (z > area) z -= area * 2;
      const y = by + Math.sin(t * (0.8 + s * 1.4) + s * 37.0) * 0.10;
      pAttr.setXYZ(i, x, y, z);
    }
    pAttr.needsUpdate = true;
  };
  pts.userData.glow = glow;

  scene.add(pts);
  return pts;
}

function createAurora() {
  const geo = new THREE.PlaneGeometry(260, 80, 90, 14);
  geo.rotateY(Math.PI);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: sharedUniforms.uTime,
      uFade: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      out vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        float wave = sin((p.x * 0.06) + uTime * 0.18) * 1.6 + sin((p.x * 0.12) + uTime * 0.27) * 0.9;
        float curtain = smoothstep(-40.0, 40.0, p.y) * smoothstep(40.0, -10.0, p.y);
        p.z += wave * curtain;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform float uFade;
      in vec2 vUv;
      out vec4 outColor;
      float hash12(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      void main() {
        float fade = clamp(uFade, 0.0, 1.0);
        float band = sin((vUv.x * 10.0) + uTime * 0.35) * 0.5 + 0.5;
        float n = hash12(vUv * 64.0 + uTime * 0.02);
        float stripes = smoothstep(0.55, 0.95, band + (n - 0.5) * 0.35);
        float v = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.62, 1.0, vUv.y));
        vec3 colA = vec3(0.15, 0.95, 0.75);
        vec3 colB = vec3(0.20, 0.55, 1.00);
        vec3 col = mix(colB, colA, smoothstep(0.15, 0.85, vUv.y));
        float a = stripes * v * fade;
        outColor = vec4(col * (0.25 + 0.85 * stripes), a * 0.55);
      }
    `,
    glslVersion: THREE.GLSL3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 7;

  mesh.userData.update = (timeMeta) => {
    const night = 1 - clamp(timeMeta?.day ?? 1, 0, 1);
    const cloud = clamp(sim.cloudiness, 0, 1);
    const winter = seasonState?.name === "winter" ? 1 : 0;
    const allow = sim.activeWeather !== "fog" && sim.activeWeather !== "sandstorm";
    const fade = allow ? smoothstep(0.55, 0.95, night) * (1 - cloud * 0.75) * winter : 0;
    mat.uniforms.uFade.value = fade;
    mesh.visible = fade > 0.01;
    if (!mesh.visible) return;
    // Place aurora towards a "north" direction relative to the camera.
    mesh.position.copy(camera.position).add(new THREE.Vector3(0, 70, -140));
    mesh.lookAt(camera.position.x, camera.position.y + 55, camera.position.z);
  };

  scene.add(mesh);
  return mesh;
}

function createShorelineDebris({ count = 850 } = {}) {
  const group = new THREE.Group();
  group.name = "shorelineDebris";
  const geo = new THREE.PlaneGeometry(0.55, 0.18, 1, 1);
  geo.rotateX(-Math.PI / 2);
  ensureVertexColorAttribute(geo);

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
  });
  enableRainSheen(mat, { strength: 0.35, roughnessMin: 0.35, darken: 0.03 });
  enableFloatDrift(mat, { ampXZ: 0.085, ampY: 0.045, frequency: 0.75 });

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  group.add(mesh);

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  const c = new THREE.Color();

  let placed = 0;
  let tries = 0;
  const seaY = BIOME.kind === "miniIslands" ? BIOME.seaLevel : BIOME.coastWaterLevel;

  function place(x, z, y, tint) {
    p.set(x, y, z);
    e.set(0, randWorld() * Math.PI * 2, 0);
    q.setFromEuler(e);
    const sc = lerp(0.6, 2.2, Math.pow(randWorld(), 0.65));
    s.set(sc * lerp(0.8, 1.4, randWorld()), 1, sc);
    m.compose(p, q, s);
    mesh.setMatrixAt(placed, m);
    c.copy(tint).offsetHSL(lerp(-0.03, 0.03, randWorld()), lerp(-0.12, 0.12, randWorld()), lerp(-0.08, 0.08, randWorld()));
    mesh.setColorAt(placed, c);
    placed++;
  }

  while (placed < count && tries < count * 35) {
    tries++;
    const x = lerp(-WORLD.half, WORLD.half, randWorld());
    const z = lerp(-WORLD.half, WORLD.half, randWorld());
    if (!inSpawnBounds(x, z)) continue;
    const y = terrainHeight(x, z);

    // Coastline debris: near sea edge and low altitude.
    let near = 0;
    if (BIOME.kind === "miniIslands") {
      near = 1 - smoothstep(seaY + 0.25, seaY + 2.2, y);
    } else {
      const coastCoord = x * BIOME.coastDir.x + z * BIOME.coastDir.y;
      const coastT = smoothstep(BIOME.shorePos - BIOME.shoreWidth * 0.15, BIOME.shorePos + BIOME.shoreWidth * 0.55, coastCoord);
      near = coastT * (1 - smoothstep(seaY - 0.15, seaY + 1.45, y));
    }

    // Pond debris: lily/leaf/seaweed-like mats near pond edges.
    let pondNear = 0;
    let pondLevel = seaY;
    for (const pond of BIOME.ponds) {
      const d = Math.hypot(x - pond.x, z - pond.z);
      const t = 1 - smoothstep(pond.r * 0.92, pond.r * 1.35, d);
      if (t > pondNear) {
        pondNear = t;
        pondLevel = pond.level;
      }
    }

    const bias = Math.max(near * 0.9, pondNear * 0.85);
    if (bias < 0.15) continue;
    if (randWorld() > bias) continue;

    const yW = pondNear > near ? pondLevel : seaY;
    place(x, z, yW + 0.03, pondNear > near ? new THREE.Color("#2a6d55") : new THREE.Color("#3b6b3f"));
  }

  mesh.count = placed;
  mesh.userData.maxDrawCount = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (mesh.instanceColor) mesh.userData.baseInstanceColor = mesh.instanceColor.array.slice();
  scene.add(group);
  return group;
}

function createLandmarks() {
  const group = new THREE.Group();
  group.name = "landmarks";

  // Basalt columns near volcano rim.
  {
    const colGeo = new THREE.CylinderGeometry(0.55, 0.72, 1.0, 6, 1);
    colGeo.translate(0, 0.5, 0);
    const colMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#2f333b"), roughness: 0.92, metalness: 0.02 });
    enableSnow(colMat, { useLocalY: false, snowBoost: 0.7, normalInfluence: 0.9 });
    enableRainSheen(colMat, { strength: 0.35, roughnessMin: 0.35, darken: 0.03 });
    const cols = new THREE.InstancedMesh(colGeo, colMat, 68);
    cols.castShadow = true;
    cols.receiveShadow = true;
    group.add(cols);

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const e = new THREE.Euler();
    let placed = 0;
    for (let i = 0; i < 68; i++) {
      const a = (i / 68) * Math.PI * 2;
      const r = ECO.volcano.r * lerp(0.48, 0.68, randWorld());
      const x = ECO.volcano.x + Math.cos(a) * r + lerp(-2.5, 2.5, randWorld());
      const z = ECO.volcano.z + Math.sin(a) * r + lerp(-2.5, 2.5, randWorld());
      if (!inSpawnBounds(x, z)) continue;
      const y = terrainHeight(x, z);
      if (y < getWaterLevel() + 0.7) continue;
      const h = lerp(2.0, 10.5, Math.pow(randWorld(), 0.6));
      p.set(x, y, z);
      e.set(0, randWorld() * Math.PI * 2, 0);
      q.setFromEuler(e);
      s.set(lerp(0.8, 1.45, randWorld()), h, lerp(0.8, 1.45, randWorld()));
      m.compose(p, q, s);
      cols.setMatrixAt(placed, m);
      placed++;
    }
    cols.count = placed;
    cols.instanceMatrix.needsUpdate = true;
  }

  // Crystal outcrop near volcanic area.
  {
    const geo = new THREE.OctahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#7bd0ff"),
      roughness: 0.25,
      metalness: 0.15,
      emissive: new THREE.Color("#2b7cff"),
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.95,
    });
    const g = new THREE.Group();
    const baseX = ECO.volcano.x + lerp(-18, 18, randWorld());
    const baseZ = ECO.volcano.z + lerp(-18, 18, randWorld());
    const baseY = terrainHeight(baseX, baseZ);
    g.position.set(baseX, baseY + 0.2, baseZ);
    for (let i = 0; i < 9; i++) {
      const m0 = new THREE.Mesh(geo, mat);
      const a = randWorld() * Math.PI * 2;
      const r = lerp(0.0, 3.4, Math.pow(randWorld(), 0.8));
      m0.position.set(Math.cos(a) * r, lerp(0.0, 3.0, randWorld()), Math.sin(a) * r);
      m0.rotation.set(randWorld() * 0.8, randWorld() * Math.PI * 2, randWorld() * 0.8);
      const sc = lerp(0.55, 2.2, Math.pow(randWorld(), 0.7));
      m0.scale.set(sc * 0.7, sc * 1.6, sc * 0.7);
      m0.castShadow = true;
      m0.receiveShadow = true;
      g.add(m0);
    }
    group.add(g);
  }

  // Small ruin arch near the river / waterfall side.
  if (BIOME.kind !== "miniIslands") {
    const stoneMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#8b8e94"), roughness: 0.92, metalness: 0.02 });
    enableSnow(stoneMat, { useLocalY: false, snowBoost: 0.75, normalInfluence: 0.85 });
    enableRainSheen(stoneMat, { strength: 0.35, roughnessMin: 0.32, darken: 0.03 });

    const pillarGeo = new THREE.BoxGeometry(1.0, 4.4, 1.0);
    const topGeo = new THREE.BoxGeometry(4.2, 0.9, 1.2);
    const ruin = new THREE.Group();
    ruin.name = "ruinArch";

    const cx = riverCenterX(lerp(-WORLD.half * 0.4, WORLD.half * 0.25, randWorld()));
    const rz = lerp(-WORLD.half * 0.25, WORLD.half * 0.25, randWorld());
    const rx = cx + lerp(6.5, 10.5, randWorld()) * (randWorld() < 0.5 ? -1 : 1);
    const ry = terrainHeight(rx, rz);
    ruin.position.set(rx, ry + 0.05, rz);
    ruin.rotation.y = randWorld() * Math.PI * 2;

    const left = new THREE.Mesh(pillarGeo, stoneMat);
    const right = new THREE.Mesh(pillarGeo, stoneMat);
    left.position.set(-1.6, 2.2, 0);
    right.position.set(1.6, 2.2, 0);
    left.castShadow = true;
    left.receiveShadow = true;
    right.castShadow = true;
    right.receiveShadow = true;
    ruin.add(left, right);

    const top = new THREE.Mesh(topGeo, stoneMat);
    top.position.set(0, 4.7, 0);
    top.rotation.z = lerp(-0.08, 0.08, randWorld());
    top.castShadow = true;
    top.receiveShadow = true;
    ruin.add(top);

    // Broken rubble around it.
    const rubbleGeo = new THREE.BoxGeometry(0.7, 0.5, 0.9);
    for (let i = 0; i < 9; i++) {
      const r = new THREE.Mesh(rubbleGeo, stoneMat);
      const a = randWorld() * Math.PI * 2;
      const d = lerp(1.2, 5.2, Math.pow(randWorld(), 0.7));
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      r.position.set(x, 0.2, z);
      r.rotation.set(randWorld() * 0.6, randWorld() * Math.PI * 2, randWorld() * 0.6);
      const sc = lerp(0.35, 1.2, Math.pow(randWorld(), 0.8));
      r.scale.set(sc, sc, sc);
      r.castShadow = true;
      r.receiveShadow = true;
      ruin.add(r);
    }
    group.add(ruin);
  }

  // Fallen giant tree near the first pond (as a landmark).
  if (BIOME.ponds?.length) {
    const logMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#6b4a2c"), roughness: 0.95, metalness: 0.0 });
    enableSnow(logMat, { useLocalY: false, snowBoost: 0.65, normalInfluence: 0.85 });
    enableRainSheen(logMat, { strength: 0.5, roughnessMin: 0.35, darken: 0.05 });

    const logGeo = new THREE.CylinderGeometry(0.75, 0.95, 12.0, 10, 2);
    const log = new THREE.Mesh(logGeo, logMat);
    const pond = BIOME.ponds[0];
    const ang = randWorld() * Math.PI * 2;
    const x = pond.x + Math.cos(ang) * pond.r * 1.8;
    const z = pond.z + Math.sin(ang) * pond.r * 1.8;
    const y = terrainHeight(x, z) + 0.35;
    log.position.set(x, y, z);
    log.rotation.set(lerp(-0.25, 0.25, randWorld()), randWorld() * Math.PI * 2, lerp(-0.25, 0.25, randWorld()));
    log.castShadow = true;
    log.receiveShadow = true;
    group.add(log);
  }

  scene.add(group);
  return group;
}

function createLightningSystem({ boltMax = 10, segMax = 18 } = {}) {
  const group = new THREE.Group();
  group.name = "lightning";
  group.visible = true;

  const lightDir = new THREE.DirectionalLight(0xeaf6ff, 0);
  lightDir.castShadow = false;
  lightDir.position.set(0, 140, 0);
  scene.add(lightDir);

  const lightPoint = new THREE.PointLight(0xeaf6ff, 0, 240, 2.0);
  lightPoint.castShadow = false;
  scene.add(lightPoint);

  const bolts = [];
  const mat = new THREE.LineBasicMaterial({
    color: 0xeaf6ff,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const maxVerts = segMax * 2;
  const maxFloats = maxVerts * 3;

  for (let i = 0; i < boltMax; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(maxFloats), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.LineSegments(geo, mat.clone());
    line.visible = false;
    line.frustumCulled = false;
    line.renderOrder = 6;
    group.add(line);
    bolts.push({ line, age: 0, life: 0.16, strength: 0, active: false });
  }

  scene.add(group);

  const sys = {
    group,
    bolts,
    lightDir,
    lightPoint,
    flash: 0,
    timer: 0,
    pendingStrength: 0,
  };

  function spawnBolt(strength = 1) {
    const bolt = bolts.find((b) => !b.active);
    if (!bolt) return;

    const strikeR = 90 + randSim() * 140;
    const ang = randSim() * Math.PI * 2;
    const x = camera.position.x + Math.cos(ang) * strikeR;
    const z = camera.position.z + Math.sin(ang) * strikeR;
    const yG = terrainHeight(x, z);
    const yTop = lerp(80, 140, randSim());

    const p0 = new THREE.Vector3(x + (randSim() - 0.5) * 10, yTop, z + (randSim() - 0.5) * 10);
    const pN = new THREE.Vector3(x, yG + 0.15, z);

    const segs = Math.max(6, Math.floor(segMax * lerp(0.55, 1.0, randSim())));
    const posAttr = bolt.line.geometry.getAttribute("position");

    let cur = p0.clone();
    let written = 0;
    for (let s = 0; s < segs; s++) {
      const t = (s + 1) / segs;
      const next = p0.clone().lerp(pN, t);
      const jitter = (1.0 - t) * lerp(1.0, 10.0, randSim()) * (0.35 + 0.65 * strength);
      next.x += (randSim() - 0.5) * jitter;
      next.z += (randSim() - 0.5) * jitter;
      next.y += (randSim() - 0.5) * jitter * 0.2;

      posAttr.setXYZ(written + 0, cur.x, cur.y, cur.z);
      posAttr.setXYZ(written + 1, next.x, next.y, next.z);
      written += 2;
      cur.copy(next);
      if (written >= maxVerts - 2) break;
    }

    bolt.line.geometry.setDrawRange(0, written);
    posAttr.needsUpdate = true;

    bolt.active = true;
    bolt.age = 0;
    bolt.life = lerp(0.10, 0.20, randSim());
    bolt.strength = strength;
    bolt.line.visible = true;
    bolt.line.material.opacity = 0.0;

    lightPoint.position.set(x, yG + 6.5, z);
    lightDir.position.set(x + 40, yTop + 10, z + 40);
    lightDir.target.position.set(x, 0, z);
    scene.add(lightDir.target);

    sys.flash = Math.max(sys.flash, 0.35 + 0.65 * strength);
  }

  sys.requestStrike = (strength = 1) => {
    sys.pendingStrength = Math.max(sys.pendingStrength, clamp(strength, 0, 1));
  };

  sys.update = (dt, isStorm, intensity01 = 0.5) => {
    // Flash decay
    sys.flash = Math.max(0, sys.flash - dt * 6.5);

    // Schedule bolts
    sys.timer = Math.max(0, sys.timer - dt);
    if (isStorm && sys.timer <= 0) {
      const strength = clamp((sys.pendingStrength || intensity01) * lerp(0.65, 1.15, randSim()), 0, 1);
      sys.pendingStrength = 0;
      spawnBolt(strength);
      const base = lerp(2.4, 8.0, randSim());
      const freq = lerp(1.0, 0.55, clamp(intensity01, 0, 1));
      sys.timer = base * freq;
    }

    // Update bolts
    let any = false;
    for (const b of bolts) {
      if (!b.active) continue;
      b.age += dt;
      const u = clamp(b.age / Math.max(1e-3, b.life), 0, 1);
      const vis = (1.0 - u) * (0.65 + 0.35 * Math.sin(b.age * 70.0));
      b.line.material.opacity = vis * (0.55 + 0.65 * b.strength);
      any = true;
      if (u >= 1) {
        b.active = false;
        b.line.visible = false;
        b.line.material.opacity = 0.0;
      }
    }

    const f = clamp(sys.flash, 0, 1);
    lightDir.intensity = f * 7.0;
    lightPoint.intensity = f * 80.0;
    group.visible = any;
  };

  return sys;
}

makeDioramaBase();
const terrain = createTerrain();
computePondWaterLevels(terrain);
const coastWater = createCoastWater();
const ponds = createPonds();
const river = BIOME.kind === "miniIslands" ? null : createRiver();
const waterfall = BIOME.kind === "miniIslands" ? null : createWaterfall();
const biomeDetails = createBiomeDetails();
const grass = createGrass({ count: 15000 });
const forest = createForest();
const rocks = createRocks();
const rockFormations = createRockFormations();
const details = createMicroDetails();
const wildlife = createWildlife();
const clouds = createCloudField();
const landmarks = createLandmarks();
const shorelineDebris = createShorelineDebris();
const rainbow = createRainbow();
const fireflies = createFireflies();
const plankton = createPlankton();
const aurora = createAurora();

const snowFX = createParticles({ count: 2800, color: 0xf6f9ff, size: 0.1 });
scene.add(snowFX);
snowFX.visible = false;

const rainFX = createParticles({ count: 2600, color: 0x9acbff, size: 0.06 });
scene.add(rainFX);
rainFX.visible = false;

const dustFX = createParticles({ count: 2400, color: 0xd6b18c, size: 0.1 });
scene.add(dustFX);
dustFX.visible = false;

const lightningFX = createLightningSystem();

let cloudsEnabled = true;
let shadowUpdateInterval = 0.25;
let waterPrepassHz = 30;
let pondLevelTimer = 0;
let pondSnowApplied = -1;
let perfBaseline = { shadowUpdateInterval: 0.25, waterPrepassHz: 30 };

function syncPondMeshes() {
  const meshes = ponds?.userData?.pondMeshes;
  if (!meshes?.length) return;
  for (const mesh of meshes) {
    const idx = mesh?.userData?.pondIndex;
    const pond = BIOME.ponds[idx];
    if (!pond) continue;
    mesh.position.set(pond.x, pond.level + 0.08, pond.z);
  }
}

function updatePonds(dt, force = false) {
  if (!ponds?.userData?.pondMeshes?.length) return;
  pondLevelTimer = Math.max(0, pondLevelTimer - dt);
  const snowNow = sharedUniforms.uSnow.value;
  if (!force && pondLevelTimer > 0 && Math.abs(snowNow - pondSnowApplied) < 0.02) return;
  pondLevelTimer = 0.4;
  pondSnowApplied = snowNow;
  computePondWaterLevels(terrain);
  syncPondMeshes();
}

updatePonds(0, true);

const tmpFishM = new THREE.Matrix4();
const tmpFishP = new THREE.Vector3();
const tmpFishQ = new THREE.Quaternion();
const tmpFishS = new THREE.Vector3();
const tmpFishE = new THREE.Euler();

function updateWildlife(dt, t) {
  if (!wildlife) return;

  // Birds: rare spawns, fly with the wind.
  wildlife.birdTimer = (wildlife.birdTimer ?? 0) - dt;
  if (wildlife.birdTimer <= 0) {
    const windy = sim.activeWeather === "windy" || sim.activeWeather === "sandstorm" || sim.activeWeather === "blizzard";
    const stormy = sim.activeWeather === "thunderstorm" || (sim.activeWeather === "rain" && sim.mood === "storm");
    const minT = stormy ? 2.0 : windy ? 3.5 : 6.0;
    const maxT = stormy ? 5.0 : windy ? 8.0 : 14.0;
    wildlife.birdTimer = lerp(minT, maxT, randSim());

    const spawnCount = stormy ? 3 : windy ? 2 : 1;
    let spawned = 0;
    for (let i = 0; i < wildlife.birds.length; i++) {
      if (i >= (wildlife.birdCap ?? wildlife.birds.length)) break;
      const b = wildlife.birds[i];
      if (!b.mesh.visible) {
        wildlife.spawnBird?.(b);
        spawned++;
        if (spawned >= spawnCount) break;
      }
    }
  }

  const down = WORLD.half * 1.05;
  const cross = WORLD.half * 0.85;
	  for (let i = 0; i < wildlife.birds.length; i++) {
	    if (i >= (wildlife.birdCap ?? wildlife.birds.length)) break;
	    const b = wildlife.birds[i];
	    if (!b.mesh.visible) continue;
    b.along += b.speed * dt;

    if (b.cross < -cross) b.cross += cross * 2;
    else if (b.cross > cross) b.cross -= cross * 2;

    const x = b.wdx * b.along + b.pdx * b.cross;
    const z = b.wdz * b.along + b.pdz * b.cross;
    const flap = 0.6 + 0.4 * Math.sin(t * 10.0 + b.phase);
    const bob = Math.sin(t * 0.75 + b.phase) * 0.8 + Math.sin(t * 2.1 + b.phase * 1.7) * 0.35;
    b.mesh.position.set(x, b.baseY + bob, z);
    b.mesh.rotation.y = Math.atan2(b.wdx, b.wdz);
    b.mesh.rotation.z = b.roll + Math.sin(t * 6.0 + b.phase) * 0.12;
    b.mesh.scale.set(1, flap, 1);

	    if (b.along > down) {
	      if (randSim() < 0.45) b.mesh.visible = false;
	      else wildlife.spawnBird?.(b);
	    }
	  }

	  // Perched shore birds: hop/takeoff near camera or storms.
	  if (wildlife.perchBirds?.length) {
	    const wdx0 = sharedUniforms.uWindDir.value.x;
	    const wdz0 = sharedUniforms.uWindDir.value.y;
	    const wLen = Math.hypot(wdx0, wdz0) || 1;
	    const wdx = wdx0 / wLen;
	    const wdz = wdz0 / wLen;
	    const wind01 = clamp(sharedUniforms.uWindStrength.value / 2.5, 0, 1);
	    const stormy = sim.activeWeather === "thunderstorm" || (sim.activeWeather === "rain" && sim.mood === "storm");
	    for (const pb of wildlife.perchBirds) {
	      if (!pb.mesh.visible) continue;
	      pb.timer = (pb.timer ?? 0) - dt;
	      const dx = pb.pos.x - camera.position.x;
	      const dz = pb.pos.z - camera.position.z;
	      const nearCam = Math.hypot(dx, dz) < 26;

	      if (pb.state === "perched") {
	        const hop = Math.sin(t * (6.0 + 3.0 * wind01) + pb.pos.x * 0.07 + pb.pos.z * 0.05) * 0.06 * (0.25 + 0.75 * wind01);
	        pb.mesh.position.set(pb.pos.x, pb.yGround + hop, pb.pos.z);
	        pb.mesh.rotation.y = Math.atan2(wdx, wdz) + Math.PI;
	        if ((nearCam && randSim() < dt * 0.6) || (stormy && randSim() < dt * 0.9) || pb.timer <= 0) {
	          pb.state = "flying";
	          pb.flyAge = 0;
	          pb.flyLife = lerp(2.2, 4.8, randSim());
	          pb.baseY = pb.yGround + lerp(4.5, 12.0, randSim());
	          pb.speed = lerp(7.0, 15.0, randSim()) * (0.75 + 0.6 * wind01);
	          pb.timer = lerp(1.0, 4.0, randSim());
	        }
	      } else {
	        pb.flyAge += dt;
	        const u = clamp(pb.flyAge / Math.max(1e-3, pb.flyLife), 0, 1);
	        pb.pos.x += wdx * pb.speed * dt;
	        pb.pos.z += wdz * pb.speed * dt;
	        const lift = smoothstep(0.0, 0.18, u) * (1 - smoothstep(0.8, 1.0, u));
	        const bob = Math.sin(t * 9.0 + pb.pos.x * 0.11) * 0.25;
	        pb.mesh.position.set(pb.pos.x, lerp(pb.yGround, pb.baseY, lift) + bob, pb.pos.z);
	        pb.mesh.rotation.y = Math.atan2(wdx, wdz);
	        if (u >= 1) wildlife.placePerch?.(pb);
	      }
	    }
	  }

	  // Deer: slow wander near the first pond.
	  const deer = wildlife.deer;
	  if (deer) {
	    deer.userData.drinkTimer = Math.max(0, (deer.userData.drinkTimer ?? 0) - dt);
	    deer.userData.timer = (deer.userData.timer ?? 0) - dt;
	    const pond = BIOME.ponds[deer.userData.pondIndex ?? 0];
	    if (pond) {
	      const dxT = (deer.userData.target?.x ?? deer.position.x) - deer.position.x;
	      const dzT = (deer.userData.target?.z ?? deer.position.z) - deer.position.z;
	      const distT = Math.hypot(dxT, dzT);
	      if (deer.userData.timer <= 0 || distT < 1.2) {
	        deer.userData.timer = lerp(7, 16, randSim());
	        for (let k = 0; k < 10; k++) {
	          const a = randSim() * Math.PI * 2;
	          const drinkSpot = randSim() < 0.35;
	          const r = pond.r * (drinkSpot ? lerp(1.02, 1.22, randSim()) : lerp(1.25, 2.25, randSim()));
	          const tx = pond.x + Math.cos(a) * r;
	          const tz = pond.z + Math.sin(a) * r;
	          const ty = terrainHeight(tx, tz);
	          if (ty < getWaterLevel() + (drinkSpot ? 0.45 : 0.8)) continue;
	          if (isWaterBody(tx, tz, ty)) continue;
	          deer.userData.target = new THREE.Vector3(tx, ty, tz);
	          deer.userData.wantDrink = drinkSpot;
	          break;
	        }
	      }

	      const target = deer.userData.target ?? deer.position;
	      const dx = target.x - deer.position.x;
	      const dz = target.z - deer.position.z;
	      const dist = Math.hypot(dx, dz);
	      const drinking = (deer.userData.drinkTimer ?? 0) > 0;
	      if (!drinking) {
	        const sp = (deer.userData.speed ?? 2.2) * (dist > 7 ? 1.35 : 1.0);
	        if (dist > 0.01) {
	          const step = Math.min(dist, sp * dt);
	          deer.position.x += (dx / dist) * step;
	          deer.position.z += (dz / dist) * step;
	          deer.rotation.y = Math.atan2(dx, dz);
	        }
	      }
	      deer.position.y = terrainHeight(deer.position.x, deer.position.z);

	      // If we reached a drink spot near the pond edge, pause and "drink".
	      if (!drinking && dist < 1.05 && deer.userData.wantDrink) {
	        deer.userData.wantDrink = false;
	        deer.userData.drinkTimer = lerp(2.5, 5.5, randSim());
	      }

	      const head = deer.userData.head;
	      const neck = deer.userData.neck;
	      if (head && neck) {
	        const d01 = smoothstep(0.0, 1.0, (deer.userData.drinkTimer ?? 0) / 5.5);
	        const nod = Math.sin(t * 3.2) * 0.06;
	        neck.rotation.z = lerp(0.0, -0.18, d01) + nod * d01;
	        head.rotation.z = lerp(0.0, -0.42, d01) + nod * d01 * 1.6;
	      }
	    }
	  }

  // Pond ripples: occasional "fish" events; more frequent in rain.
  if (BIOME.ponds?.length) {
    const rainBoost = sim.activeWeather === "rain" ? lerp(0.22, 0.45, sim.precip) : 1.0;
    wildlife.rippleTimer = (wildlife.rippleTimer ?? 0) - dt * rainBoost;
    if (wildlife.rippleTimer <= 0) {
      wildlife.rippleTimer = lerp(0.9, 2.4, randSim());
      wildlife.spawnRipple?.(Math.floor(randSim() * BIOME.ponds.length));
    }
  }

	  for (const rr of wildlife.ripples) {
	    if (!rr.active) continue;
	    rr.age += dt;
	    const t01 = clamp(rr.age / Math.max(0.001, rr.life), 0, 1);
	    const fade = smoothstep(0.0, 0.12, t01) * (1.0 - smoothstep(0.75, 1.0, t01));
	    const grow = 1.0 + t01 * 5.0;
	    rr.mesh.scale.setScalar(rr.baseScale * grow);
	    rr.mesh.material.opacity = fade * lerp(0.18, 0.35, sim.precip);
	    const pond = BIOME.ponds[rr.pondIndex];
	    if (pond) rr.mesh.position.y = pond.level + 0.04;
	    if (t01 >= 1) {
	      rr.active = false;
	      rr.mesh.visible = false;
	    }
	  }

	  // Fish: swim simple loops under water surfaces.
	  const fish = wildlife.fish;
	  if (fish?.mesh && fish?.data?.length) {
	    const cap = clamp(fish.fishCap ?? fish.data.length, 0, fish.data.length);
	    fish.mesh.count = cap;
	    for (let i = 0; i < cap; i++) {
	      const fd = fish.data[i];
	      let x = 0;
	      let y = 0;
	      let z = 0;
	      let yaw = 0;
	      const dir = fd.dir ?? 1;
	      const a = (fd.phase ?? 0) + t * (fd.speed ?? 1) * dir;

	      if (fd.mode === "pond") {
	        const pond = BIOME.ponds[fd.pondIndex ?? 0];
	        if (!pond) continue;
	        const r = Math.min(fd.radius ?? pond.r * 0.5, pond.r * 0.82);
	        x = pond.x + Math.cos(a) * r;
	        z = pond.z + Math.sin(a) * r;
	        y = pond.level - (fd.depth ?? 0.35) + Math.sin(t * (fd.wiggle ?? 4.8) + (fd.phase ?? 0)) * 0.06;
	      } else {
	        x = (fd.x ?? 0) + Math.cos(a) * (fd.radius ?? 4.0);
	        z = (fd.z ?? 0) + Math.sin(a) * (fd.radius ?? 4.0);
	        y = (fd.waterY ?? getWaterLevel()) - (fd.depth ?? 0.45) + Math.sin(t * (fd.wiggle ?? 4.2) + (fd.phase ?? 0)) * 0.05;
	      }

	      const tx = -Math.sin(a) * dir;
	      const tz = Math.cos(a) * dir;
	      yaw = Math.atan2(tx, tz);
	      const wag = Math.sin(t * (fd.wiggle ?? 4.8) + (fd.phase ?? 0)) * 0.25;
	      const pitch = Math.sin(t * 1.8 + (fd.phase ?? 0)) * 0.05;

	      tmpFishP.set(x, y, z);
	      tmpFishE.set(pitch, yaw + wag, 0);
	      tmpFishQ.setFromEuler(tmpFishE);
	      const sc = fd.size ?? 1;
	      tmpFishS.set(sc * 0.85, sc * 0.6, sc * 1.15);
	      tmpFishM.compose(tmpFishP, tmpFishQ, tmpFishS);
	      fish.mesh.setMatrixAt(i, tmpFishM);
	    }
	    fish.mesh.instanceMatrix.needsUpdate = true;
	  }
	}

const QUALITY_PRESETS = {
  low: {
    pixelRatioCap: 1.0,
    shadowMapSize: 768,
    shadowUpdateInterval: 0.6,
    cloudCount: 4,
    cloudStepsMax: 12,
    cloudShadowStepsMax: 1,
    waterRTScale: 0.42,
    waterPrepassHz: 14,
    tiltShiftScale: 0.36,
    grassCount: 6500,
    birdCap: 12,
    fishCap: 12,
    grassCastShadow: false,
    leavesCastShadow: false,
    trunksCastShadow: true,
    rocksCastShadow: true,
  },
  medium: {
    pixelRatioCap: 1.25,
    shadowMapSize: 1024,
    shadowUpdateInterval: 0.4,
    cloudCount: 5,
    cloudStepsMax: 18,
    cloudShadowStepsMax: 2,
    waterRTScale: 0.55,
    waterPrepassHz: 20,
    tiltShiftScale: 0.45,
    grassCount: 9500,
    birdCap: 22,
    fishCap: 22,
    grassCastShadow: false,
    leavesCastShadow: false,
    trunksCastShadow: true,
    rocksCastShadow: true,
  },
  high: {
    pixelRatioCap: 1.6,
    shadowMapSize: 1536,
    shadowUpdateInterval: 0.3,
    cloudCount: 6,
    cloudStepsMax: 24,
    cloudShadowStepsMax: 3,
    waterRTScale: 0.65,
    waterPrepassHz: 28,
    tiltShiftScale: 0.55,
    grassCount: 13000,
    birdCap: 34,
    fishCap: 34,
    grassCastShadow: true,
    leavesCastShadow: true,
    trunksCastShadow: true,
    rocksCastShadow: true,
  },
  ultra: {
    pixelRatioCap: 2.0,
    shadowMapSize: 2048,
    shadowUpdateInterval: 0.25,
    cloudCount: 7,
    cloudStepsMax: 28,
    cloudShadowStepsMax: 3,
    waterRTScale: 0.75,
    waterPrepassHz: 30,
    tiltShiftScale: 0.62,
    grassCount: 15000,
    birdCap: 44,
    fishCap: 46,
    grassCastShadow: true,
    leavesCastShadow: true,
    trunksCastShadow: true,
    rocksCastShadow: true,
  },
};

let qualityApplied = "high";
let autoQualityTimer = 0;

function setCloudCount(targetCount) {
  const sys = clouds.userData;
  if (!sys?.cloudDefs) return;
  const maxClouds = Number.isFinite(sys.maxClouds) ? sys.maxClouds : 10;
  const clamped = clamp(Math.floor(targetCount), 0, maxClouds);
  while (sys.cloudDefs.length < clamped) sys.spawnCloud(randSim);
  while (sys.cloudDefs.length > clamped) sys.despawnCloud(sys.cloudDefs[sys.cloudDefs.length - 1]);
}

function syncWaterUniformsNow() {
  const res = post.getMainResolution();
  for (const m of waterMeshes) {
    const u = m.material?.userData?.__waterUniforms;
    if (!u?.uResolution?.value) continue;
    u.uResolution.value.set(res.x, res.y);
    if (u.uNear) u.uNear.value = camera.near;
    if (u.uFar) u.uFar.value = camera.far;
    if (u.tSceneColor) u.tSceneColor.value = waterRT.texture;
    if (u.tSceneDepth) u.tSceneDepth.value = waterRT.depthTexture;
  }
}

function updateWaterRefractionPrepass(dt) {
  waterPrepassTimer -= dt;
  if (waterPrepassTimer > 0) return;
  waterPrepassTimer = 1 / Math.max(1, waterPrepassHz);

  if (!waterMeshes.length) return;

  waterVisCache.length = waterMeshes.length;
  const cloudsVis = clouds.visible;
  const snowVis = snowFX.visible;
  const rainVis = rainFX.visible;
  const dustVis = dustFX.visible;

  for (let i = 0; i < waterMeshes.length; i++) {
    const m = waterMeshes[i];
    waterVisCache[i] = m.visible;
    m.visible = false;
  }
  clouds.visible = false;
  snowFX.visible = false;
  rainFX.visible = false;
  dustFX.visible = false;

  renderer.setRenderTarget(waterRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  for (let i = 0; i < waterMeshes.length; i++) waterMeshes[i].visible = waterVisCache[i];
  clouds.visible = cloudsVis;
  snowFX.visible = snowVis;
  rainFX.visible = rainVis;
  dustFX.visible = dustVis;

  syncWaterUniformsNow();
}

function applyQualityPreset(name) {
  const preset = QUALITY_PRESETS[name] ?? QUALITY_PRESETS.high;
  qualityApplied = name in QUALITY_PRESETS ? name : "high";

  pixelRatioCap = preset.pixelRatioCap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  shadowUpdateInterval = preset.shadowUpdateInterval;
  sunLight.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
  renderer.shadowMap.needsUpdate = true;

  cloudsEnabled = preset.cloudCount > 0;
  setCloudCount(preset.cloudCount);

  waterPrepassHz = preset.waterPrepassHz;
  resizeWaterRT(preset.waterRTScale);
  syncWaterUniformsNow();

  post.setTiltShiftScale(preset.tiltShiftScale);

  if (grass) {
    const maxDraw = grass.userData.maxDrawCount ?? grass.count;
    grass.count = Math.min(maxDraw, preset.grassCount);
    grass.castShadow = preset.grassCastShadow;
    grass.receiveShadow = true;
  }

  if (biomeDetails?.userData?.reeds) {
    const reeds = biomeDetails.userData.reeds;
    const maxDraw = reeds.userData.maxDrawCount ?? reeds.count;
    reeds.count = Math.min(maxDraw, Math.floor(preset.grassCount * 0.25));
    reeds.castShadow = preset.grassCastShadow;
    reeds.receiveShadow = true;
  }

  if (forest?.userData?.trunks) {
    forest.userData.trunks.castShadow = preset.trunksCastShadow;
    forest.userData.leaves.castShadow = preset.leavesCastShadow;
  }

  if (rocks?.userData?.meshes) {
    for (const rockMesh of rocks.userData.meshes) {
      rockMesh.castShadow = preset.rocksCastShadow;
      rockMesh.receiveShadow = true;
    }
  } else if (rocks) {
    rocks.castShadow = preset.rocksCastShadow;
  }

  if (rockFormations?.userData?.rockMeshes) {
    for (const rockMesh of rockFormations.userData.rockMeshes) {
      rockMesh.castShadow = preset.rocksCastShadow;
      rockMesh.receiveShadow = true;
    }
  }

  if (rockFormations?.userData?.mineralMeshes) {
    for (const mineralMesh of rockFormations.userData.mineralMeshes) {
      mineralMesh.castShadow = preset.rocksCastShadow;
      mineralMesh.receiveShadow = true;
    }
  }

  if (biomeDetails?.userData?.shrubs) {
    biomeDetails.userData.shrubs.castShadow = preset.rocksCastShadow;
    biomeDetails.userData.shrubs.receiveShadow = true;
  }

  if (biomeDetails?.userData?.snags) {
    biomeDetails.userData.snags.castShadow = preset.trunksCastShadow;
    biomeDetails.userData.snags.receiveShadow = true;
  }

  if (typeof wildlife?.setBirdCap === "function" && preset.birdCap != null) wildlife.setBirdCap(preset.birdCap);
  if (typeof wildlife?.setFishCap === "function" && preset.fishCap != null) wildlife.setFishCap(preset.fishCap);

  // Baseline values used by runtime adaptive scaling (prevents long-term perf drift).
  perfBaseline.shadowUpdateInterval = shadowUpdateInterval;
  perfBaseline.waterPrepassHz = waterPrepassHz;
}

function chooseAutoQuality(fps) {
  if (fps < 34) return "low";
  if (fps < 47) return "medium";
  if (fps < 58) return "high";
  return "ultra";
}

function updateAutoQuality(dt) {
  autoQualityTimer = Math.max(0, autoQualityTimer - dt);
  if (autoQualityTimer > 0) return;
  autoQualityTimer = 1.0;

  const next = chooseAutoQuality(fpsSmooth);
  if (next !== qualityApplied) {
    applyQualityPreset(next);
  }
}

applyQualityPreset(sim.qualityMode === "auto" ? "high" : sim.qualityMode);

const SEASON_ORDER = ["spring", "summer", "autumn", "winter"];
const SEASON_PROFILES = {
  spring: {
    snowSimFactor: 0,
    peakSnow: 0,
    terrain: { hShift: -0.01, sMul: 1.18, lMul: 1.05, tint: new THREE.Color("#88c97f"), tintMix: 0.04 },
    grass: { hShift: -0.01, sMul: 1.25, lMul: 1.08, tint: new THREE.Color("#83cc69"), tintMix: 0.06 },
    leaves: { hShift: -0.01, sMul: 1.18, lMul: 1.05, tint: new THREE.Color("#75c86a"), tintMix: 0.03 },
    trunk: { hShift: 0.0, sMul: 1.05, lMul: 1.02, tintMix: 0.0 },
    rocks: { hShift: 0.0, sMul: 1.0, lMul: 1.0, tintMix: 0.0 },
  },
  summer: {
    snowSimFactor: 0,
    peakSnow: 0,
    terrain: { hShift: 0.0, sMul: 1.06, lMul: 1.02, tint: new THREE.Color("#6fb06e"), tintMix: 0.02 },
    grass: { hShift: 0.0, sMul: 1.08, lMul: 1.02, tint: new THREE.Color("#5aa85a"), tintMix: 0.02 },
    leaves: { hShift: 0.0, sMul: 1.04, lMul: 1.0, tintMix: 0.0 },
    trunk: { hShift: 0.0, sMul: 1.0, lMul: 1.0, tintMix: 0.0 },
    rocks: { hShift: 0.0, sMul: 1.0, lMul: 1.0, tintMix: 0.0 },
  },
  autumn: {
    snowSimFactor: 0,
    peakSnow: 0,
    terrain: { hShift: -0.035, sMul: 0.92, lMul: 0.98, tint: new THREE.Color("#b78650"), tintMix: 0.08 },
    grass: { hShift: -0.06, sMul: 0.85, lMul: 0.95, tint: new THREE.Color("#c2a65a"), tintMix: 0.14 },
    leaves: { hShift: -0.16, sMul: 0.92, lMul: 0.98, tint: new THREE.Color("#d0702f"), tintMix: 0.18 },
    trunk: { hShift: -0.01, sMul: 1.08, lMul: 0.98, tintMix: 0.0 },
    rocks: { hShift: 0.0, sMul: 1.0, lMul: 0.98, tintMix: 0.0 },
  },
  winter: {
    snowSimFactor: 1,
    peakSnow: 0.92,
    terrain: { hShift: 0.02, sMul: 0.72, lMul: 0.92, tint: new THREE.Color("#cfe2ff"), tintMix: 0.04 },
    grass: { hShift: 0.0, sMul: 0.55, lMul: 0.78, tint: new THREE.Color("#cfe2ff"), tintMix: 0.02 },
    leaves: { hShift: 0.0, sMul: 0.75, lMul: 0.86, tint: new THREE.Color("#cfe2ff"), tintMix: 0.02 },
    trunk: { hShift: 0.0, sMul: 0.92, lMul: 0.9, tintMix: 0.0 },
    rocks: { hShift: 0.0, sMul: 0.9, lMul: 0.92, tintMix: 0.0 },
  },
};

const tmpSeasonColor = new THREE.Color();
const tmpSeasonTint = new THREE.Color();
const tmpSeasonHSL = { h: 0, s: 0, l: 0 };

function applySeasonTransformToArray(base, out, profile) {
  if (!base || !out || !profile) return;
  const hShift = profile.hShift ?? 0;
  const sMul = profile.sMul ?? 1;
  const lMul = profile.lMul ?? 1;
  const tintMix = profile.tintMix ?? 0;
  if (tintMix > 0 && profile.tint) tmpSeasonTint.copy(profile.tint);

  for (let i = 0; i < base.length; i += 3) {
    tmpSeasonColor.setRGB(base[i], base[i + 1], base[i + 2]);
    tmpSeasonColor.getHSL(tmpSeasonHSL);
    tmpSeasonHSL.h = (tmpSeasonHSL.h + hShift + 1.0) % 1.0;
    tmpSeasonHSL.s = clamp(tmpSeasonHSL.s * sMul, 0, 1);
    tmpSeasonHSL.l = clamp(tmpSeasonHSL.l * lMul, 0, 1);
    tmpSeasonColor.setHSL(tmpSeasonHSL.h, tmpSeasonHSL.s, tmpSeasonHSL.l);
    if (tintMix > 0 && profile.tint) tmpSeasonColor.lerp(tmpSeasonTint, tintMix);
    out[i] = tmpSeasonColor.r;
    out[i + 1] = tmpSeasonColor.g;
    out[i + 2] = tmpSeasonColor.b;
  }
}

function applySeasonColors(seasonName) {
  const profile = SEASON_PROFILES[seasonName] ?? SEASON_PROFILES.summer;

  const terrainBase = terrain.userData.baseColors;
  const terrainOut = terrain.geometry.attributes.color.array;
  applySeasonTransformToArray(terrainBase, terrainOut, profile.terrain);
  terrain.geometry.attributes.color.needsUpdate = true;

  if (grass?.userData?.baseInstanceColor && grass.instanceColor) {
    applySeasonTransformToArray(grass.userData.baseInstanceColor, grass.instanceColor.array, profile.grass);
    grass.instanceColor.needsUpdate = true;
  }

  if (forest?.userData?.trunks?.userData?.baseInstanceColor && forest.userData.trunks.instanceColor) {
    applySeasonTransformToArray(forest.userData.trunks.userData.baseInstanceColor, forest.userData.trunks.instanceColor.array, profile.trunk);
    forest.userData.trunks.instanceColor.needsUpdate = true;
  }

  if (forest?.userData?.leaves?.userData?.baseInstanceColor && forest.userData.leaves.instanceColor) {
    applySeasonTransformToArray(forest.userData.leaves.userData.baseInstanceColor, forest.userData.leaves.instanceColor.array, profile.leaves);
    forest.userData.leaves.instanceColor.needsUpdate = true;
  }

  const rockMeshes = [];
  if (rocks?.userData?.meshes) rockMeshes.push(...rocks.userData.meshes);
  else if (rocks?.isInstancedMesh) rockMeshes.push(rocks);
  if (rockFormations?.userData?.rockMeshes) rockMeshes.push(...rockFormations.userData.rockMeshes);
  for (const rm of rockMeshes) {
    if (!rm?.userData?.baseInstanceColor || !rm.instanceColor) continue;
    applySeasonTransformToArray(rm.userData.baseInstanceColor, rm.instanceColor.array, profile.rocks);
    rm.instanceColor.needsUpdate = true;
  }

  if (details?.userData?.flowers?.userData?.baseInstanceColor && details.userData.flowers.instanceColor) {
    applySeasonTransformToArray(details.userData.flowers.userData.baseInstanceColor, details.userData.flowers.instanceColor.array, profile.grass);
    details.userData.flowers.instanceColor.needsUpdate = true;
  }
  if (details?.userData?.bushes?.userData?.baseInstanceColor && details.userData.bushes.instanceColor) {
    applySeasonTransformToArray(details.userData.bushes.userData.baseInstanceColor, details.userData.bushes.instanceColor.array, profile.leaves);
    details.userData.bushes.instanceColor.needsUpdate = true;
  }
  if (details?.userData?.logs?.userData?.baseInstanceColor && details.userData.logs.instanceColor) {
    applySeasonTransformToArray(details.userData.logs.userData.baseInstanceColor, details.userData.logs.instanceColor.array, profile.trunk);
    details.userData.logs.instanceColor.needsUpdate = true;
  }

  if (biomeDetails?.userData?.reeds?.userData?.baseInstanceColor && biomeDetails.userData.reeds.instanceColor) {
    applySeasonTransformToArray(biomeDetails.userData.reeds.userData.baseInstanceColor, biomeDetails.userData.reeds.instanceColor.array, profile.grass);
    biomeDetails.userData.reeds.instanceColor.needsUpdate = true;
  }
  if (biomeDetails?.userData?.shrubs?.userData?.baseInstanceColor && biomeDetails.userData.shrubs.instanceColor) {
    applySeasonTransformToArray(biomeDetails.userData.shrubs.userData.baseInstanceColor, biomeDetails.userData.shrubs.instanceColor.array, profile.leaves);
    biomeDetails.userData.shrubs.instanceColor.needsUpdate = true;
  }
  if (biomeDetails?.userData?.snags?.userData?.baseInstanceColor && biomeDetails.userData.snags.instanceColor) {
    applySeasonTransformToArray(biomeDetails.userData.snags.userData.baseInstanceColor, biomeDetails.userData.snags.instanceColor.array, profile.trunk);
    biomeDetails.userData.snags.instanceColor.needsUpdate = true;
  }
}

let lastSeasonName = null;
function updateSeason(dt, force = false) {
  if (sim.seasonMode === "auto") {
    const secondsPerYear = 480;
    seasonPhase = (seasonPhase + dt / secondsPerYear) % 1;
    const idx = clamp(Math.floor(seasonPhase * 4), 0, 3);
    seasonState.name = SEASON_ORDER[idx];
  } else {
    seasonState.name = sim.seasonMode in SEASON_PROFILES ? sim.seasonMode : "summer";
  }

  const prof = SEASON_PROFILES[seasonState.name] ?? SEASON_PROFILES.summer;
  seasonState.snowSimFactor = prof.snowSimFactor ?? 0;
  seasonState.peakSnow = prof.peakSnow ?? 0;
  sharedUniforms.uPeakSnow.value = seasonState.peakSnow;

  if (force || seasonState.name !== lastSeasonName) {
    lastSeasonName = seasonState.name;
    applySeasonColors(seasonState.name);
  }
}

updateSeason(0, true);

function pickAutoWeather() {
  const r = randSim();
  const s = seasonState.name;
  if (s === "winter") {
    if (r < 0.30) return "clear";
    if (r < 0.48) return "windy";
    if (r < 0.60) return "fog";
    if (r < 0.85) return randSim() < 0.55 ? "blizzard" : "snow";
    return "thunderstorm";
  }
  if (s === "spring") {
    if (r < 0.30) return "clear";
    if (r < 0.45) return "windy";
    if (r < 0.60) return "fog";
    if (r < 0.90) return randSim() < 0.30 ? "thunderstorm" : "rain";
    return "snow";
  }
  if (s === "autumn") {
    if (r < 0.28) return "clear";
    if (r < 0.48) return "windy";
    if (r < 0.66) return "fog";
    if (r < 0.92) return randSim() < 0.28 ? "thunderstorm" : "rain";
    return "snow";
  }
  // summer
  if (r < 0.42) return "clear";
  if (r < 0.60) return "windy";
  if (r < 0.72) return "sandstorm";
  if (r < 0.92) return randSim() < 0.35 ? "thunderstorm" : "rain";
  return "fog";
}

function getTimeMetrics() {
  const phase = (sim.timeOfDay / 24) * Math.PI * 2;
  const elevation = Math.sin(phase - Math.PI / 2) * 60;
  const day = smoothstep(-4, 10, elevation);
  const twilight = 1 - smoothstep(0, 14, Math.abs(elevation));

  const azimuth = THREE.MathUtils.degToRad(210);
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = azimuth;
  sunDir.setFromSphericalCoords(1, phi, theta);

  return { elevation, day, twilight, phase };
}

function applySkyAndLights(metrics) {
  sky.material.uniforms.sunPosition.value.copy(sunDir);

  tmpSunColor.copy(COLOR_NIGHT).lerp(COLOR_SUNSET, metrics.twilight).lerp(COLOR_DAY, metrics.day);

  const cloudShade = clamp(sim.cloudiness, 0, 1);
  const night = 1 - metrics.day;
  const intensity = lerp(0.03, 2.2, metrics.day) * lerp(1.0, 0.7, cloudShade);

  sunLight.color.copy(tmpSunColor);
  sunLight.intensity = intensity;
  sunLight.position.copy(sunDir).multiplyScalar(240);
  sunLight.target.position.set(0, 0, 0);

  hemiLight.intensity = lerp(0.05, 0.85, metrics.day) * lerp(1.0, 1.1, cloudShade);
  hemiLight.color.copy(COLOR_HEMI_SKY_NIGHT).lerp(COLOR_HEMI_SKY_DAY, metrics.day);
  hemiLight.groundColor.copy(COLOR_HEMI_GROUND_NIGHT).lerp(COLOR_HEMI_GROUND_DAY, metrics.day);

  tmpFogColor
    .copy(COLOR_FOG_NIGHT)
    .lerp(COLOR_FOG_DAY, metrics.day * 0.65)
    .lerp(COLOR_FOG_CLOUD, cloudShade * metrics.day * 0.35);

  // Local atmosphere tint by biome at the camera position (swamp haze, dust, volcanic ash).
  const camX = camera.position.x;
  const camZ = camera.position.z;
  const camY = terrainHeight(camX, camZ);
  const camSlope = terrainSlope(camX, camZ);
  const eco = ECO.sampleTo(tmpSkyEco, camX, camZ, camY, clamp(1.0 - camSlope, 0, 1));
  const swamp = clamp(eco.wetland, 0, 1) * clamp(eco.moist, 0, 1);
  const dust = clamp(eco.dry, 0, 1) * (1.0 - clamp(eco.wetland, 0, 1));
  const ash = clamp(eco.volcanic, 0, 1);
  const alpine = clamp(eco.alpine, 0, 1);

  tmpFogColor.lerp(COLOR_FOG_SWAMP, swamp * metrics.day * 0.42);
  tmpFogColor.lerp(COLOR_FOG_DUST, dust * metrics.day * 0.18);
  tmpFogColor.lerp(COLOR_FOG_ASH, ash * metrics.day * 0.35);
  // Alpine air is clearer/bluer.
  tmpFogColor.lerp(COLOR_FOG_DAY, alpine * metrics.day * 0.22);
  scene.fog.color.copy(tmpFogColor);

	  // Darker night + slightly boosted day
		  const expoBase = lerp(0.16, 0.82, metrics.day) * lerp(1.0, 0.88, cloudShade);
	  const expoBio = expoBase * lerp(1.0, 0.92, swamp * 0.65 + ash * 0.55 + dust * 0.35) * lerp(1.0, 1.04, alpine * 0.35);
		  // Base fog was intentionally stylized, but it was strong enough to wash out the sky/horizon.
		  // Lower it so clear days stay blue and precipitation reads as gray/overcast from Sky+clouds.
		  const fogBase = lerp(0.0024, 0.0009, metrics.day) * lerp(1.08, 0.82, cloudShade);
	  const fogBio = fogBase * lerp(1.0, 1.55, swamp) * lerp(1.0, 1.25, ash) * lerp(1.0, 1.15, dust) * lerp(1.0, 0.75, alpine);

	  const w = sim.activeWeather;
	  const mist = clamp((sim.afterRainMist ?? 0) / 12.0, 0, 1) * metrics.day * (1 - cloudShade * 0.35);
	  const fogMul =
	    w === "fog"
	      ? lerp(2.6, 4.1, sim.precip)
	      : w === "sandstorm"
	        ? lerp(1.7, 3.2, sim.precip)
	        : w === "blizzard"
	          ? lerp(1.25, 2.0, sim.precip)
	          : w === "thunderstorm"
	            ? lerp(1.1, 1.7, sim.precip)
	            : 1.0;
	  scene.fog.density = fogBio * fogMul * lerp(1.0, 1.35, smoothstep(0.0, 1.0, mist));

	  const expoWeatherMul =
	    w === "fog" ? 0.82 : w === "sandstorm" ? 0.86 : w === "blizzard" ? 0.88 : w === "thunderstorm" ? 0.9 : 1.0;
	  const flash = clamp(lightningFX?.flash ?? 0, 0, 1);
	  renderer.toneMappingExposure = expoBio * expoWeatherMul * (1.0 + flash * 0.45) * lerp(1.0, 0.92, mist);

	  // Sky scattering (Sky shader): push clear days to a natural blue and keep precipitation gray.
	  // NOTE: sim.cloudiness never goes to 0 even in "clear" weather, so we remap it to avoid
	  // an always-hazy sky. (This is why it can look "swapped" between clear vs precipitation.)
	  const cloudOvercast = smoothstep(0.32, 0.92, cloudShade);
	  const precip01 = clamp(sim.precip, 0, 1);
	  const weatherOvercast =
	    w === "thunderstorm"
	      ? lerp(0.18, 0.42, precip01)
	      : w === "rain"
	        ? lerp(0.12, 0.30, precip01)
	        : w === "blizzard"
	          ? lerp(0.12, 0.34, precip01)
	          : w === "snow"
	            ? lerp(0.08, 0.22, precip01)
	            : w === "fog"
	              ? lerp(0.22, 0.55, precip01)
	              : w === "sandstorm"
	                ? lerp(0.10, 0.26, precip01)
	                : (w === "clear" || w === "windy") ? -0.08 : 0.0;

	  const overcast = clamp(cloudOvercast + weatherOvercast, 0, 1);
	  const clear = 1 - overcast;
	  const clear2 = Math.pow(clear, 2.2);

	  // Lower turbidity + higher rayleigh => deeper blue.
	  // Overcast: higher turbidity + higher mieCoeff => whiter/greyer sky.
	  const turbidityDay = lerp(12.5, 2.05, clear2);
	  const rayleighDay = lerp(0.75, 7.6, clear2);
	  const mieCoeffDay = lerp(0.016, 0.00045, clear2);
	  const mieGDay = lerp(0.90, 0.74, clear2);

	  skyUniforms.turbidity.value = lerp(1.1, turbidityDay, metrics.day);
	  skyUniforms.rayleigh.value = lerp(0.02, rayleighDay, metrics.day);
	  skyUniforms.mieCoefficient.value = lerp(0.00006, mieCoeffDay, metrics.day);
	  skyUniforms.mieDirectionalG.value = lerp(0.92, mieGDay, metrics.day);

	  // If present in this Sky version, keep luminance in check to avoid washout.
	  if (skyUniforms.luminance) skyUniforms.luminance.value = lerp(0.12, 0.9, metrics.day);

  // Stars: fade in at night, fade out around twilight
  const starsFade = smoothstep(0.15, 0.85, night) * (1 - metrics.twilight * 0.65);
  starField.userData.setFade?.(starsFade, cloudShade, qualityApplied);
  starField.visible = starsFade > 0.01;
}

function updateWeather(dt, t, dayFactor) {
  const userMode = sim.weatherMode;
  if (userMode === "auto") {
    sim.autoWeatherTimer -= dt;
    if (sim.autoWeatherTimer <= 0) {
      sim.autoWeatherTarget = pickAutoWeather();
      sim.autoWeatherTimer = lerp(28, 55, randSim());
    }
    sim.activeWeather = sim.autoWeatherTarget;
  } else {
    sim.activeWeather = userMode;
  }

  const w = sim.activeWeather;
  const isSnow = w === "snow";
  const isRain = w === "rain";
  const isWindy = w === "windy";
  const isThunder = w === "thunderstorm";
  const isFog = w === "fog";
  const isBlizzard = w === "blizzard";
  const isSand = w === "sandstorm";
  const snowing = isSnow || isBlizzard;
  const raining = isRain || isThunder;

	  const targetCloud = isThunder
	    ? lerp(0.82, 0.98, sim.precip)
	    : isBlizzard
	      ? lerp(0.72, 0.98, sim.precip)
	      : isSnow
	        ? lerp(0.55, 0.95, sim.precip)
	        : isRain
	          ? lerp(0.5, 0.92, sim.precip)
	          : isFog
	            ? lerp(0.45, 0.75, sim.precip)
	            : isSand
	              ? lerp(0.55, 0.88, sim.precip)
	              : isWindy
	                ? 0.55
	                : 0.25;
	  sim.cloudiness = lerp(sim.cloudiness, targetCloud, 1 - Math.pow(0.001, dt));

	  const gust = 0.65 + 0.35 * Math.sin(t * 0.17) + 0.15 * Math.sin(t * 0.71 + 1.4);
	  sim.windGust = gust;
	  const targetWind =
	    sim.windUser * (isSand ? 1.95 : isThunder ? 1.75 : isBlizzard ? 1.65 : isWindy ? 1.55 : snowing ? 1.1 : raining ? 1.25 : isFog ? 0.6 : 0.9);
	  sharedUniforms.uWindStrength.value = lerp(sharedUniforms.uWindStrength.value, targetWind * gust, 1 - Math.pow(0.001, dt));

  const cloudOpacity = lerp(0.28, 0.95, sim.cloudiness);
  const cloudCoverage = clamp(lerp(0.4, 0.98, sim.cloudiness) * lerp(0.92, 1.08, sim.precip), 0, 1);
  for (const mat of clouds.userData.materials) {
    mat.uniforms.uOpacity.value = cloudOpacity;
    mat.uniforms.uCoverage.value = cloudCoverage;
  }
  clouds.visible = cloudsEnabled && cloudOpacity > 0.03;

  // During precipitation, spawn more clouds and massively increase their base scale (up to x4).
  const precipActive = sim.precip > 0.05 && (raining || snowing || isThunder || isBlizzard || isFog);
  {
    const preset = QUALITY_PRESETS[qualityApplied] ?? QUALITY_PRESETS.high;
    const baseCount = preset.cloudCount ?? 5;
    const maxClouds = Number.isFinite(clouds.userData.maxClouds) ? clouds.userData.maxClouds : 10;
    const extra = precipActive ? Math.ceil(sim.precip * (isThunder ? 4 : isBlizzard ? 3.5 : 3.0)) : 0;
    const targetCount = clamp(baseCount + extra, 0, maxClouds);
    if (clouds.userData.dynamicCount !== targetCount) {
      clouds.userData.dynamicCount = targetCount;
      setCloudCount(targetCount);
    }
  }

  // Clouds: bigger/denser in precipitation; a bit larger as cloudiness rises.
  {
    const stormy = isThunder || raining || isBlizzard || snowing || sim.mood === "storm";
    const wet = stormy ? clamp(sim.precip, 0, 1) : clamp(sim.cloudiness, 0, 1);
    const sizeMul = precipActive ? lerp(1.25, 5.0, wet) : 1.0 + (stormy ? lerp(0.35, 1.05, wet) : lerp(0.0, 0.35, wet));
    const heightMul = precipActive ? lerp(1.15, 3.0, wet) : 1.0 + (stormy ? lerp(0.25, 0.85, wet) : lerp(0.0, 0.25, wet));
    const lower = precipActive ? lerp(4.0, 18.0, wet) : stormy ? lerp(2.0, 14.0, wet) : lerp(0.0, 5.0, wet);

    for (const cd of clouds.userData.cloudDefs) {
      const bs = cd.baseScale;
      if (bs) cd.mesh.scale.set(bs.x * sizeMul, bs.y * heightMul, bs.z * sizeMul);
      // Lower storm clouds a bit.
      cd.mesh.position.y = clamp(cd.baseY - lower + Math.sin(simTime * 0.35 + cd.phase) * cd.bob, 20, 55);
    }
  }

	  snowFX.visible = snowing && sim.precip > 0.02;
	  rainFX.visible = raining && sim.precip > 0.02;
	  dustFX.visible = isSand && sim.precip > 0.05;
	  if (snowFX.visible) {
	    const mul = isBlizzard ? 1.15 : 1.0;
	    snowFX.material.opacity = lerp(0.15, 0.95, sim.precip) * mul;
	    snowFX.material.size = lerp(0.06, 0.15, sim.precip) * mul;
	  }
	  if (rainFX.visible) {
	    const mul = isThunder ? 1.15 : 1.0;
	    rainFX.material.opacity = lerp(0.2, 0.9, sim.precip) * mul;
	    rainFX.material.size = lerp(0.04, 0.085, sim.precip) * mul;
	  }
	  if (dustFX.visible) {
	    dustFX.material.opacity = lerp(0.25, 0.85, sim.precip);
	    dustFX.material.size = lerp(0.09, 0.18, sim.precip);
	  }

	  if (snowing) {
	    const acc = dt * lerp(0.004, 0.03, sim.precip);
	    sim.snowCover = clamp(sim.snowCover + acc, 0, 1);
	  } else {
	    const melt = dt * lerp(0.002, 0.02, dayFactor) * lerp(0.55, 1.15, 1 - sim.cloudiness);
	    sim.snowCover = clamp(sim.snowCover - melt, 0, 1);
	  }
  sharedUniforms.uSnow.value = sim.snowCover * (seasonState?.snowSimFactor ?? 1);

  // Ground wetness accumulator (puddles + sheen) and rainbow trigger after rain.
  const prevWeather = sim.prevWeather ?? "clear";
  const prevRaining = prevWeather === "rain" || prevWeather === "thunderstorm";
  const nowRaining = raining;
  sim.prevWeather = w;

  if (nowRaining) {
    sim.groundWetness = clamp(sim.groundWetness + dt * lerp(0.10, 0.55, sim.precip), 0, 1);
  } else {
    const dryRate = isSand ? 0.08 : isFog ? 0.015 : snowing ? 0.01 : 0.03;
    sim.groundWetness = clamp(sim.groundWetness - dt * dryRate, 0, 1);
  }
  sharedUniforms.uRainWetness.value = sim.groundWetness;

  // Rainbow: after rain ends and sun is up.
  if (prevRaining && !nowRaining && (w === "clear" || w === "windy") && dayFactor > 0.22 && sim.cloudiness < 0.75) {
    sim.rainbow.t = 0;
    sim.rainbow.show = 1;
  }
  if (sim.rainbow.show > 0) {
    sim.rainbow.t += dt;
    if (sim.rainbow.t > 18 || dayFactor < 0.12 || sim.cloudiness > 0.85) sim.rainbow.show = 0;
  }

  // After-rain ground mist (short-lived)
  if (prevRaining && !nowRaining) sim.afterRainMist = Math.max(sim.afterRainMist, lerp(7, 14, sim.precip));
  sim.afterRainMist = Math.max(0, sim.afterRainMist - dt);
}

function updateParticles(points, dt, kind = "snow") {
  const isSnow = kind === "snow";
  const isDust = kind === "dust";
  const geo = points.geometry;
  const posAttr = geo.getAttribute("position");
  const seedAttr = geo.getAttribute("aSeed");

  const area = WORLD.half;
  const spawnY = isDust ? 4.0 : 85;
  const fallSpeed = isDust ? 0.0 : isSnow ? lerp(6, 14, sim.precip) : lerp(28, 60, sim.precip);
  const drift = isDust ? 10.0 : isSnow ? 6.0 : 2.5;

  const wind = sharedUniforms.uWindStrength.value;
  const wx = sharedUniforms.uWindDir.value.x * wind * drift;
  const wz = sharedUniforms.uWindDir.value.y * wind * drift;
  const time = sharedUniforms.uTime.value;

  for (let i = 0; i < posAttr.count; i++) {
    let x = posAttr.getX(i);
    let y = posAttr.getY(i);
    let z = posAttr.getZ(i);
    const s = seedAttr.getX(i);

    x += wx * dt * (0.35 + 0.65 * s);
    z += wz * dt * (0.35 + 0.65 * s);
    if (!isDust) y -= fallSpeed * dt * (0.55 + 0.85 * s);

    const surf = sampleTerrainSurfaceHeight(terrain, x, z);
    const ground = surf + (isSnow ? 0.3 : 0.12);

    if (isDust) {
      const wob = Math.sin(time * (0.55 + 0.35 * s) + s * 31.0) * 0.35;
      const targetY = surf + 0.45 + s * 2.8 + wob;
      y = lerp(y, targetY, 1 - Math.pow(0.001, dt));

      // Avoid dust over water; keep it hugging the terrain.
      if (isWaterBody(x, z, surf)) {
        y = spawnY + randSim() * 2;
        x = lerp(-area, area, randSim());
        z = lerp(-area, area, randSim());
      }

      const maxY = surf + 7.5;
      if (y < surf + 0.2 || y > maxY) {
        y = spawnY + randSim() * 2;
        x = lerp(-area, area, randSim());
        z = lerp(-area, area, randSim());
      }
    } else if (y < ground) {
      y = spawnY + randSim() * 18;
      x = lerp(-area, area, randSim());
      z = lerp(-area, area, randSim());
    }

    if (x < -area) x += area * 2;
    if (x > area) x -= area * 2;
    if (z < -area) z += area * 2;
    if (z > area) z -= area * 2;

    posAttr.setXYZ(i, x, y, z);
  }
  posAttr.needsUpdate = true;
}

let uiTimer = 0;
function updateUI(dt, timeMeta) {
  uiTimer -= dt;
  if (uiTimer > 0) return;
  uiTimer = 0.2;

  const hh = Math.floor(sim.timeOfDay);
  const mm = Math.floor((sim.timeOfDay - hh) * 60);
  const clockText = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

  dom.readout.innerHTML = [
    `<div><strong>Time</strong>: ${clockText} — <strong>Season</strong>: ${seasonState.name} — <strong>Biome</strong>: ${sim.biomeMode === "miniIslands" ? "mini islands" : "mainland"} — <strong>Quality</strong>: ${sim.qualityMode === "auto" ? `${qualityApplied} (auto)` : qualityApplied} — <strong>Seed</strong>: ${WORLD_SEED}</div>`,
    `<div><strong>Snow cover</strong>: ${fmt01(sim.snowCover)} — <strong>Clouds</strong>: ${fmt01(sim.cloudiness)} — <strong>Camera</strong>: ${sim.cameraMode}</div>`,
    `<div><strong>Weather</strong>: ${sim.activeWeather} — <strong>Wind</strong>: ${fmt1(sharedUniforms.uWindStrength.value)} — <strong>Precip</strong>: ${fmt01(sim.precip)}</div>`,
    `<div style="opacity:0.85"><strong>Sun elevation</strong>: ${Math.round(timeMeta.elevation)}° — <strong>Daylight</strong>: ${fmt01(timeMeta.day)}</div>`,
  ].join("");
}

const clock = new THREE.Clock();
const tmpSunView = new THREE.Vector3();
let fpsSmooth = 60;
let fpsFrames = 0;
let fpsAccum = 0;
let fpsUiTimer = 0;
let cloudQualityTimer = 0;
let shadowTimer = 0;
let waterPrepassTimer = 0;
let perfAdaptiveTimer = 0;
let simTime = 0;
const FPS_CAP = 60;
const FRAME_DT = 1 / FPS_CAP;
const FRAME_EPS = 1e-4;
let frameCapAccum = 0;

function perfScaleFromFps(fps) {
  if (!Number.isFinite(fps)) return 1.0;
  if (fps < 24) return 0.45;
  if (fps < 30) return 0.55;
  if (fps < 38) return 0.7;
  if (fps < 46) return 0.85;
  return 1.0;
}

function tick() {
  requestAnimationFrame(tick);
  const deltaRaw = clock.getDelta();
  const tReal = clock.elapsedTime;

  if (!Number.isFinite(deltaRaw) || deltaRaw <= 0 || deltaRaw > 0.25) {
    fpsFrames = 0;
    fpsAccum = 0;
    fpsUiTimer = 0;
    frameCapAccum = 0;
    return;
  }

  // Frame limiter: cap rendering/updating to 60 FPS on high-refresh displays.
  let dt = deltaRaw;
  if (deltaRaw < FRAME_DT) {
    frameCapAccum = Math.min(frameCapAccum + deltaRaw, 0.25);
    if (frameCapAccum + FRAME_EPS < FRAME_DT) return;
    dt = FRAME_DT;
    frameCapAccum = Math.max(0, frameCapAccum - FRAME_DT);
  } else {
    frameCapAccum = 0;
  }
  dt = Math.min(dt, 0.05);

  // FPS: short-window average to avoid first-frame spikes and tab-sleep artifacts.
  fpsFrames += 1;
  fpsAccum += dt;
  fpsUiTimer += dt;
  if (fpsUiTimer >= 0.25 && fpsAccum > 0) {
    const fpsAvg = fpsFrames / fpsAccum;
    fpsSmooth = lerp(fpsSmooth, fpsAvg, 0.25);
    fpsFrames = 0;
    fpsAccum = 0;
    fpsUiTimer = 0;
  }
  if (dom.fps) dom.fps.textContent = `FPS: ${Math.round(fpsSmooth)}`;

  sharedUniforms.uRealTime.value = tReal;
  if (sim.qualityMode === "auto") updateAutoQuality(dt);

  applyCameraMode(sim.cameraMode);
  firstPerson.update(dt);

  // Runtime adaptive scaling (even on manual presets) to avoid perf "collapse" during heavy moments.
  perfAdaptiveTimer += dt;
  if (perfAdaptiveTimer >= 1.0) {
    perfAdaptiveTimer = 0;
    const scale = perfScaleFromFps(fpsSmooth);
    waterPrepassHz = Math.min(perfBaseline.waterPrepassHz, Math.max(6, Math.round(perfBaseline.waterPrepassHz * scale)));
    shadowUpdateInterval = lerp(shadowUpdateInterval, perfBaseline.shadowUpdateInterval / Math.max(scale, 0.45), 0.4);
  }

  let timeMeta = getTimeMetrics();

  if (!sim.paused) {
    simTime += dt;
    sharedUniforms.uTime.value = simTime;
    updateSeason(dt);

    if (!sim.manualTimeDrag && sim.timeSpeedHoursPerMinute > 0) {
      sim.timeOfDay = (sim.timeOfDay + (dt * sim.timeSpeedHoursPerMinute) / 60) % 24;
      dom.time.value = String(sim.timeOfDay);
    }

		    timeMeta = getTimeMetrics();
		    updateWeather(dt, simTime, timeMeta.day);
		    {
		      const stormy = sim.activeWeather === "thunderstorm" || (sim.activeWeather === "rain" && sim.mood === "storm");
		      const intensity = clamp(sim.precip, 0, 1);
		      lightningFX?.update(dt, stormy, intensity);
		    }
		    applySkyAndLights(timeMeta);
		    rainbow?.userData?.update?.(timeMeta);
		    aurora?.userData?.update?.(timeMeta);
		    fireflies?.userData?.update?.(dt, timeMeta);
		    plankton?.userData?.update?.(dt, timeMeta);

	    shadowTimer -= dt;
	    if (shadowTimer <= 0) {
	      shadowTimer = shadowUpdateInterval;
	      renderer.shadowMap.needsUpdate = true;
	    }

	    updateTerrainSnowVolume(terrain, dt);
	    updatePonds(dt);
	    updateWildlife(dt, simTime);

    if (cloudsEnabled) {
      const cloudDefs = clouds.userData.cloudDefs;
      const preset = QUALITY_PRESETS[qualityApplied] ?? QUALITY_PRESETS.high;
      cloudQualityTimer -= dt;
      if (cloudQualityTimer <= 0) {
        cloudQualityTimer = 0.85;
        const low = fpsSmooth < 32;
        const mid = fpsSmooth < 45;
        const stepsMax = preset.cloudStepsMax ?? 24;
        const shadowMax = preset.cloudShadowStepsMax ?? 3;
        const stepsTarget = low ? Math.min(12, stepsMax) : mid ? Math.min(18, stepsMax) : stepsMax;
        const shadowTarget = low ? Math.min(1, shadowMax) : mid ? Math.min(2, shadowMax) : shadowMax;
        for (const mat of clouds.userData.materials) {
          mat.uniforms.uSteps.value = stepsTarget;
          mat.uniforms.uShadowSteps.value = shadowTarget;
        }
      }

	    const w = sharedUniforms.uWindStrength.value;
	    const wdx0 = sharedUniforms.uWindDir.value.x;
	    const wdz0 = sharedUniforms.uWindDir.value.y;
	    const wLen = Math.hypot(wdx0, wdz0) || 1;
	    const wdx = wdx0 / wLen;
	    const wdz = wdz0 / wLen;
	    const pdx = -wdz;
	    const pdz = wdx;
	    const wx = wdx * w;
	    const wz = wdz * w;

	    const downwindBound = WORLD.half * 0.95;
	    const crossBound = WORLD.half * 0.75;

	    for (const cd of cloudDefs) {
	      // Move with wind
	      cd.mesh.position.x += wx * dt * cd.speed * 6.0;
	      cd.mesh.position.z += wz * dt * cd.speed * 6.0;

	      // Gentle vertical bobbing (absolute, no integration drift)
	      cd.mesh.position.y = clamp(cd.baseY + Math.sin(simTime * 0.35 + cd.phase) * cd.bob, 25, 55);

	      // Per-cloud fade-in on respawn
	      if (cd.fade < 1) {
	        cd.fade = Math.min(1, cd.fade + dt * 0.55);
	        cd.mat.uniforms.uOpacityMul.value = smoothstep(0.0, 1.0, cd.fade);
	      }

	      const along = cd.mesh.position.x * wdx + cd.mesh.position.z * wdz;
	      let cross = cd.mesh.position.x * pdx + cd.mesh.position.z * pdz;

	      // Keep clouds in a corridor perpendicular to wind
	      if (cross < -crossBound) cross += crossBound * 2;
	      else if (cross > crossBound) cross -= crossBound * 2;

	      // Respawn when exiting downwind
	      if (along > downwindBound) {
	        clouds.userData.resetCloud(cd, randSim);
	        const newAlong = -downwindBound - lerp(0, 25, randSim());
	        const newCross = lerp(-crossBound, crossBound, randSim());
	        cd.mesh.position.x = wdx * newAlong + pdx * newCross;
	        cd.mesh.position.z = wdz * newAlong + pdz * newCross;
	        cd.mesh.position.y = cd.baseY;
	      } else {
	        // Apply cross-corridor adjustment
	        cd.mesh.position.x = wdx * along + pdx * cross;
	        cd.mesh.position.z = wdz * along + pdz * cross;
	      }
	    }
    }

	    if (snowFX.visible) updateParticles(snowFX, dt, "snow");
	    if (rainFX.visible) updateParticles(rainFX, dt, "rain");
	    if (dustFX.visible) updateParticles(dustFX, dt, "dust");

    updateUI(dt, timeMeta);
	  } else {
	    updateSeason(0);
	    timeMeta = getTimeMetrics();
	    lightningFX?.update(dt, false, 0);
	    applySkyAndLights(timeMeta);
	    rainbow?.userData?.update?.(timeMeta);
	    aurora?.userData?.update?.(timeMeta);
	    fireflies?.userData?.update?.(0, timeMeta);
	    plankton?.userData?.update?.(0, timeMeta);
	  }

  if (controls.enabled) controls.update();
  sky.position.copy(camera.position);
  starField.position.copy(camera.position);
  // Make stars move with time, similar to the sun.
  // Keep it subtle: rotate around Y for daily motion, plus a fixed tilt.
  starField.rotation.set(STARFIELD_TILT, timeMeta.phase + STARFIELD_ROT_OFFSET, 0);
  tmpSunView.copy(sunDir).transformDirection(camera.matrixWorldInverse);
  sharedUniforms.uSunDirView.value.copy(tmpSunView);
  sharedUniforms.uSunDirWorld.value.copy(sunDir);

  // Update shooting stars even when paused (uses real time)
  if (starField.visible) {
    const night = 1 - timeMeta.day;
    const fade = smoothstep(0.15, 0.85, night) * (1 - timeMeta.twilight * 0.65);
    starField.userData.update?.(dt, fade);
  }

	  // Water refraction prepass (render scene without water into waterRT)
	  updateWaterRefractionPrepass(dt);

  post.renderFrame(timeMeta, tReal);
}

tick();
