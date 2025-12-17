import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function createEngine({ dom, pixelRatioCap = 2 } = {}) {
  if (!dom?.canvas) throw new Error("Missing canvas element (#c).");

  const renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: true,
    powerPreference: "high-performance",
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#05070d");
  scene.fog = new THREE.FogExp2(0x0b1328, 0.0018);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 4200);
  camera.position.set(96, 64, 116);

  const controls = new OrbitControls(camera, dom.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 18;
  controls.maxDistance = 980;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 10, 0);
  controls.update();

  return { renderer, scene, camera, controls };
}

