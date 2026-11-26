import {
  MODULE_ID,
  setupStationLayer,
  teardownStationLayer,
  animateToStation,
  applyOffscreenVisibility,
  syncAllOffscreenVisibility
} from "./transition.js";
import {
  injectSceneConfig,
  renderStationControls,
  injectTokenHudButton,
  injectPlaceableConfigCheckbox
} from "./ui.js";

let currentTotalStations = 0;

Hooks.on("renderSceneConfig", (app, html) => {
  injectSceneConfig(app, html);
});

Hooks.on("renderTokenHUD", (app, html) => {
  injectTokenHudButton(app, html);
});

Hooks.on("renderWallConfig", (app, html) => {
  injectPlaceableConfigCheckbox(app, html);
});

Hooks.on("renderAmbientLightConfig", (app, html) => {
  injectPlaceableConfigCheckbox(app, html);
});

Hooks.on("preUpdateScene", (scene, changed) => {
  const modFlags = changed.flags?.[MODULE_ID];
  if (!modFlags) return;

  // Se sta cambiando solo la stazione corrente, non toccare le dimensioni della scena
  const structuralChange =
    modFlags.enabled !== undefined ||
    modFlags.direction !== undefined ||
    modFlags.tilesPerStation !== undefined;

  if (!structuralChange) return;

  const prevEnabled = Boolean(scene.getFlag(MODULE_ID, "enabled"));
  const nextEnabled = modFlags.enabled !== undefined ? Boolean(modFlags.enabled) : prevEnabled;

  if (prevEnabled && !nextEnabled) {
    const origW = scene.getFlag(MODULE_ID, "originalWidth");
    const origH = scene.getFlag(MODULE_ID, "originalHeight");
    if (origW && origW !== scene.width) changed.width = origW;
    if (origH && origH !== scene.height) changed.height = origH;
    return;
  }

  if (nextEnabled) {
    const direction = modFlags.direction ?? scene.getFlag(MODULE_ID, "direction") ?? "bottom-to-top";
    const tiles = Math.max(1, Number(modFlags.tilesPerStation ?? scene.getFlag(MODULE_ID, "tilesPerStation")) || 30);
    const gridSize = Number(changed.grid?.size ?? scene.grid.size) || 100;
    const isVertical = direction === "bottom-to-top" || direction === "top-to-bottom";

    if (!prevEnabled) {
      modFlags.originalWidth = scene.width;
      modFlags.originalHeight = scene.height;
    }

    const origW = modFlags.originalWidth ?? scene.getFlag(MODULE_ID, "originalWidth") ?? scene.width;
    const origH = modFlags.originalHeight ?? scene.getFlag(MODULE_ID, "originalHeight") ?? scene.height;

    const targetW = isVertical ? origW : tiles * gridSize;
    const targetH = isVertical ? tiles * gridSize : origH;

    if (targetW !== scene.width) changed.width = targetW;
    if (targetH !== scene.height) changed.height = targetH;
  }
});

Hooks.on("canvasReady", async (canvas) => {
  currentTotalStations = await setupStationLayer(canvas.scene);
  renderStationControls(canvas.scene, currentTotalStations);
  syncAllOffscreenVisibility();
});

Hooks.on("canvasTearDown", () => {
  teardownStationLayer();
  document.getElementById("ss-canvas-hud")?.remove();
});

Hooks.on("updateScene", async (scene, changed) => {
  if (scene.id !== canvas.scene?.id) return;

  const modFlags = changed.flags?.[MODULE_ID];
  const structuralChange =
    changed.width !== undefined ||
    changed.height !== undefined ||
    changed.levels !== undefined ||
    modFlags?.enabled !== undefined ||
    modFlags?.direction !== undefined ||
    modFlags?.tilesPerStation !== undefined;

  // 1. Priorità: se è cambiato solo currentIndex, anima lo scorrimento
  if (modFlags?.currentIndex !== undefined && !structuralChange) {
    renderStationControls(scene, currentTotalStations);
    await animateToStation(scene, modFlags.currentIndex);
    return;
  }

  // 2. Solo se cambiano dimensioni, livelli o opzioni strutturali, ricostruisce il layer
  if (structuralChange) {
    currentTotalStations = await setupStationLayer(scene);
    renderStationControls(scene, currentTotalStations);
  }
});

Hooks.on("refreshToken", (token) => applyOffscreenVisibility(token));
Hooks.on("refreshAmbientLight", (light) => applyOffscreenVisibility(light));
Hooks.on("refreshWall", (wall) => applyOffscreenVisibility(wall));