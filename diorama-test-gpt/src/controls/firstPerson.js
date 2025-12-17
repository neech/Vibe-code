import * as THREE from "three";

import { clamp } from "../utils/math.js";

const DEFAULT_MOUSE_SENSITIVITY = 0.0022;

export function createFirstPersonController({ camera, domElement } = {}) {
  if (!camera) throw new Error("createFirstPersonController: missing camera");
  if (!domElement) throw new Error("createFirstPersonController: missing domElement");

  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();

  const keyDown = new Set();

  const state = {
    enabled: false,
    yaw: 0,
    pitch: 0,
    mouseSensitivity: DEFAULT_MOUSE_SENSITIVITY,
    speed: 18,
    sprintMul: 2.2,
    eyeHeight: 2.1,
    boundsMul: 0.98,
    worldHalf: 0,
    getGroundHeight: null,
    getWaterLevel: null,
  };

  function isLocked() {
    return document.pointerLockElement === domElement;
  }

  function setEnabled(next) {
    const v = Boolean(next);
    if (state.enabled === v) return;
    state.enabled = v;
    if (!state.enabled) unlock();
  }

  function lock() {
    if (!state.enabled) return;
    domElement.requestPointerLock?.();
  }

  function unlock() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  function syncRotationFromCamera() {
    camera.updateMatrixWorld(true);
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    state.yaw = e.y;
    state.pitch = e.x;
    camera.rotation.order = "YXZ";
  }

  function applyRotation() {
    camera.rotation.order = "YXZ";
    camera.rotation.x = state.pitch;
    camera.rotation.y = state.yaw;
    camera.rotation.z = 0;
  }

  function setConstraints({ worldHalf, getGroundHeight, getWaterLevel, eyeHeight } = {}) {
    if (Number.isFinite(worldHalf)) state.worldHalf = Math.max(0, worldHalf);
    if (typeof getGroundHeight === "function") state.getGroundHeight = getGroundHeight;
    if (typeof getWaterLevel === "function") state.getWaterLevel = getWaterLevel;
    if (Number.isFinite(eyeHeight)) state.eyeHeight = Math.max(0.1, eyeHeight);
  }

  function onPointerDown(ev) {
    if (!state.enabled) return;
    if (ev.button !== 0) return;
    lock();
  }

  function onMouseMove(ev) {
    if (!state.enabled) return;
    if (!isLocked()) return;
    const mx = ev.movementX ?? 0;
    const my = ev.movementY ?? 0;
    state.yaw -= mx * state.mouseSensitivity;
    state.pitch -= my * state.mouseSensitivity;
    state.pitch = clamp(state.pitch, -1.35, 1.35);
    applyRotation();
  }

  function shouldIgnoreKeyEvent(ev) {
    const el = ev.target;
    const tag = el?.tagName?.toLowerCase?.() ?? "";
    return tag === "input" || tag === "select" || tag === "textarea";
  }

  function onKeyDown(ev) {
    if (!state.enabled) return;
    if (!isLocked()) return;
    if (shouldIgnoreKeyEvent(ev)) return;
    keyDown.add(ev.key.toLowerCase());
    if (ev.key === " ") ev.preventDefault();
  }

  function onKeyUp(ev) {
    if (!state.enabled) return;
    keyDown.delete(ev.key.toLowerCase());
  }

  function onPointerLockChange() {
    if (!state.enabled) return;
    if (!isLocked()) keyDown.clear();
  }

  function connect() {
    domElement.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerlockchange", onPointerLockChange);
  }

  function disconnect() {
    domElement.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    keyDown.clear();
  }

  function update(dt) {
    if (!state.enabled) return;
    if (!isLocked()) return;

    const gH = state.getGroundHeight;
    const wL = state.getWaterLevel;
    if (typeof gH !== "function" || typeof wL !== "function" || !Number.isFinite(state.worldHalf) || state.worldHalf <= 0) return;

    const forwardKey = (keyDown.has("w") ? 1 : 0) + (keyDown.has("arrowup") ? 1 : 0) - (keyDown.has("s") ? 1 : 0) - (keyDown.has("arrowdown") ? 1 : 0);
    const strafeKey = (keyDown.has("d") ? 1 : 0) + (keyDown.has("arrowright") ? 1 : 0) - (keyDown.has("a") ? 1 : 0) - (keyDown.has("arrowleft") ? 1 : 0);
    if (forwardKey === 0 && strafeKey === 0) return;

    camera.getWorldDirection(forward);
    forward.y = 0;
    const fLen = forward.length();
    if (fLen > 1e-6) forward.multiplyScalar(1 / fLen);
    else forward.set(0, 0, -1);
    right.crossVectors(forward, up).normalize();

    move.set(0, 0, 0);
    move.addScaledVector(forward, forwardKey);
    move.addScaledVector(right, strafeKey);
    const mLen = move.length();
    if (mLen > 1e-6) move.multiplyScalar(1 / mLen);

    const sprint = keyDown.has("shift");
    const speed = state.speed * (sprint ? state.sprintMul : 1);
    camera.position.addScaledVector(move, speed * dt);

    const maxR = state.worldHalf * state.boundsMul;
    camera.position.x = clamp(camera.position.x, -maxR, maxR);
    camera.position.z = clamp(camera.position.z, -maxR, maxR);

    const ground = gH(camera.position.x, camera.position.z);
    const water = wL();
    const base = ground < water + 0.15 ? water : ground;
    camera.position.y = base + state.eyeHeight;
  }

  // Initialize yaw/pitch from current camera orientation.
  syncRotationFromCamera();
  connect();

  return Object.freeze({
    isLocked,
    setEnabled,
    setConstraints,
    syncRotationFromCamera,
    lock,
    unlock,
    update,
    dispose: disconnect,
  });
}

