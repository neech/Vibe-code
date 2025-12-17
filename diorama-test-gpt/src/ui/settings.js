export const SETTINGS_KEY = "diorama-test-gpt:settings";
const HUD_COLLAPSED_KEY = "diorama-test-gpt:hudCollapsed";

export function loadSettings(storage = localStorage) {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

export function saveSettings(sim, storage = localStorage) {
  try {
    const data = {
      qualityMode: sim.qualityMode,
      seasonMode: sim.seasonMode,
      biomeMode: sim.biomeMode,
      cameraMode: sim.cameraMode,
      tiltFocus: sim.tiltFocus,
      weatherMode: sim.weatherMode,
      precip: sim.precip,
      windUser: sim.windUser,
      timeSpeedHoursPerMinute: sim.timeSpeedHoursPerMinute,
    };
    storage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage failures (private mode etc.)
  }
}

export function applySavedSettingsToDom(savedSettings, dom) {
  if (!savedSettings) return;
  if (dom.quality && typeof savedSettings.qualityMode === "string") dom.quality.value = savedSettings.qualityMode;
  if (dom.season && typeof savedSettings.seasonMode === "string") dom.season.value = savedSettings.seasonMode;
  if (dom.biome && typeof savedSettings.biomeMode === "string") dom.biome.value = savedSettings.biomeMode;
  if (dom.cameraMode && typeof savedSettings.cameraMode === "string") dom.cameraMode.value = savedSettings.cameraMode;
  if (dom.tiltFocus && typeof savedSettings.tiltFocus === "number") dom.tiltFocus.value = String(savedSettings.tiltFocus);
  if (typeof savedSettings.weatherMode === "string") dom.weather.value = savedSettings.weatherMode;
  if (typeof savedSettings.precip === "number") dom.precip.value = String(savedSettings.precip);
  if (typeof savedSettings.windUser === "number") dom.wind.value = String(savedSettings.windUser);
  if (typeof savedSettings.timeSpeedHoursPerMinute === "number") dom.timeSpeed.value = String(savedSettings.timeSpeedHoursPerMinute);
}

export function syncSimFromDom(sim, dom) {
  sim.qualityMode = dom.quality?.value ?? sim.qualityMode;
  sim.seasonMode = dom.season?.value ?? sim.seasonMode;
  sim.biomeMode = dom.biome?.value ?? sim.biomeMode;
  sim.cameraMode = dom.cameraMode?.value ?? sim.cameraMode;
  sim.tiltFocus = Number(dom.tiltFocus?.value ?? sim.tiltFocus);

  sim.weatherMode = dom.weather.value;
  sim.precip = Number(dom.precip.value);
  sim.windUser = Number(dom.wind.value);
  sim.timeSpeedHoursPerMinute = Number(dom.timeSpeed.value);
}

function applyMoodPreset(sim, dom, kind, save) {
  sim.mood = kind;
  if (kind === "golden") {
    sim.weatherMode = "clear";
    dom.weather.value = sim.weatherMode;
    sim.precip = 0.15;
    dom.precip.value = String(sim.precip);
    sim.windUser = 0.7;
    dom.wind.value = String(sim.windUser);
    sim.timeOfDay = 18.4;
    dom.time.value = String(sim.timeOfDay);
  } else if (kind === "storm") {
    sim.weatherMode = "rain";
    dom.weather.value = sim.weatherMode;
    sim.precip = 0.92;
    dom.precip.value = String(sim.precip);
    sim.windUser = 2.1;
    dom.wind.value = String(sim.windUser);
    sim.timeOfDay = 15.2;
    dom.time.value = String(sim.timeOfDay);
  } else {
    sim.mood = "normal";
  }
  save();
}

export function setupUi(dom, sim, { save, applyQualityPreset, updateSeason, resetSim, resetCamera, reload, newWorld } = {}) {
  const saveFn = typeof save === "function" ? save : () => {};
  const reloadFn = typeof reload === "function" ? reload : () => location.reload();
  const newWorldFn = typeof newWorld === "function" ? newWorld : () => {};

  function setHudCollapsed(collapsed) {
    if (!dom.hud) return;
    dom.hud.classList.toggle("collapsed", Boolean(collapsed));
    if (dom.toggleHud) {
      dom.toggleHud.textContent = collapsed ? "Show" : "Hide";
      dom.toggleHud.setAttribute("aria-pressed", collapsed ? "true" : "false");
    }
    try {
      localStorage.setItem(HUD_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }

  // Restore persisted state.
  try {
    setHudCollapsed(localStorage.getItem(HUD_COLLAPSED_KEY) === "1");
  } catch {
    // ignore
  }

  dom.time?.addEventListener("pointerdown", () => (sim.manualTimeDrag = true));
  dom.time?.addEventListener("pointerup", () => (sim.manualTimeDrag = false));
  dom.time?.addEventListener("input", () => {
    sim.timeOfDay = Number(dom.time.value);
  });

  dom.timeSpeed?.addEventListener("input", () => {
    sim.timeSpeedHoursPerMinute = Number(dom.timeSpeed.value);
    saveFn();
  });

  dom.weather?.addEventListener("change", () => {
    sim.weatherMode = dom.weather.value;
    if (sim.weatherMode !== "auto") sim.activeWeather = sim.weatherMode;
    saveFn();
  });

  dom.precip?.addEventListener("input", () => {
    sim.precip = Number(dom.precip.value);
    saveFn();
  });

  dom.wind?.addEventListener("input", () => {
    sim.windUser = Number(dom.wind.value);
    saveFn();
  });

  dom.quality?.addEventListener("change", () => {
    sim.qualityMode = dom.quality.value;
    if (sim.qualityMode !== "auto" && typeof applyQualityPreset === "function") applyQualityPreset(sim.qualityMode);
    saveFn();
  });

  dom.season?.addEventListener("change", () => {
    sim.seasonMode = dom.season.value;
    if (typeof updateSeason === "function") updateSeason(0, true);
    saveFn();
  });

  dom.biome?.addEventListener("change", () => {
    sim.biomeMode = dom.biome.value;
    saveFn();
    reloadFn();
  });

  dom.cameraMode?.addEventListener("change", () => {
    sim.cameraMode = dom.cameraMode.value;
    saveFn();
  });

  dom.presetGolden?.addEventListener("click", () => applyMoodPreset(sim, dom, "golden", saveFn));
  dom.presetStorm?.addEventListener("click", () => applyMoodPreset(sim, dom, "storm", saveFn));
  dom.newWorld?.addEventListener("click", () => newWorldFn());
  dom.toggleHud?.addEventListener("click", () => setHudCollapsed(!dom.hud?.classList?.contains("collapsed")));

  dom.tiltFocus?.addEventListener("input", () => {
    sim.tiltFocus = Number(dom.tiltFocus.value);
    saveFn();
  });

  dom.pause?.addEventListener("click", () => {
    sim.paused = !sim.paused;
    dom.pause.textContent = sim.paused ? "Resume" : "Pause";
  });

  dom.reset?.addEventListener("click", () => {
    resetSim?.();
    resetCamera?.();
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key.toLowerCase() === "r") resetCamera?.();
    if (ev.key.toLowerCase() === "h") setHudCollapsed(!dom.hud?.classList?.contains("collapsed"));
  });
}
