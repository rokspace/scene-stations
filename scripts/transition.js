export const MODULE_ID = "scene-stations";

let stationContainer = null;
let stationSprite = null;
let isTransitioning = false;
let activeRafId = null;
let activeTransitionSound = null;
let soundSessionId = 0;

/**
 * Legge la configurazione dai flag della scena.
 */
export function getStationConfig(scene) {
  return {
    enabled: Boolean(scene?.getFlag(MODULE_ID, "enabled")),
    direction: scene?.getFlag(MODULE_ID, "direction") ?? "bottom-to-top",
    tilesPerStation: Math.max(1, Number(scene?.getFlag(MODULE_ID, "tilesPerStation")) || 30),
    duration: Math.max(200, Number(scene?.getFlag(MODULE_ID, "duration")) || 2000),
    currentIndex: Math.max(0, Number(scene?.getFlag(MODULE_ID, "currentIndex")) || 0),
    transitionSound: scene?.getFlag(MODULE_ID, "transitionSound") ?? ""
  };
}

/**
 * Ritorna true se l'elemento deve scorrere con lo sfondo (default: true).
 */
export function shouldScrollWithBg(doc) {
  return doc?.getFlag(MODULE_ID, "scrollWithBg") ?? true;
}

/**
 * Nasconde completamente dal canvas (anche per il GM) Token, Luci e Muri fuori stazione.
 */
export function applyOffscreenVisibility(placeable) {
  if (!placeable?.document) return;
  const offscreen = Boolean(placeable.document.getFlag(MODULE_ID, "isOffscreen"));
  placeable.visible = !offscreen;
  if (placeable.mesh) placeable.mesh.visible = !offscreen;
}

/**
 * Riallinea la visibilità di tutti i placeable sulla scena corrente.
 */
export function syncAllOffscreenVisibility() {
  if (!canvas?.ready) return;
  for (const t of canvas.tokens?.placeables ?? []) applyOffscreenVisibility(t);
  for (const l of canvas.lighting?.placeables ?? []) applyOffscreenVisibility(l);
  for (const w of canvas.walls?.placeables ?? []) applyOffscreenVisibility(w);
}

/**
 * Avvia il suono di transizione in loop sul client locale.
 */
async function startTransitionSound(src) {
  stopTransitionSound();
  if (!src) return;

  const session = ++soundSessionId;
  const Audio = foundry.audio?.AudioHelper ?? AudioHelper;

  try {
    // push = false perché animateToStation gira già su tutti i client connessi
    const sound = await Audio.play({ src, volume: 0.8, autoplay: true, loop: true }, false);
    if (!sound) return;

    // Se l'animazione è già terminata mentre il file caricava, ferma subito il suono
    if (session !== soundSessionId) {
      sound.stop();
      return;
    }

    activeTransitionSound = sound;
  } catch (err) {
    console.warn(`${MODULE_ID} | Impossibile riprodurre il suono di transizione:`, err);
  }
}

/**
 * Ferma immediatamente il suono di transizione.
 */
function stopTransitionSound() {
  soundSessionId++;
  if (activeTransitionSound) {
    activeTransitionSound.stop();
    activeTransitionSound = null;
  }
}

/**
 * Calcola geometria, dimensioni e numero di stazioni dalla texture del background.
 */
export function computeStationMetrics(scene, texture, config) {
  const gridSize = scene.grid.size || 100;
  const { x, y, width: sceneW, height: sceneH } = canvas.dimensions.sceneRect;
  const isVertical = config.direction === "bottom-to-top" || config.direction === "top-to-bottom";

  // Mantiene le proporzioni originali dell'immagine adattandola all'asse perpendicolare allo scorrimento
  const texW = texture.width || sceneW;
  const texH = texture.height || sceneH;

  let spriteW, spriteH, windowW, windowH, totalStations;

  if (isVertical) {
    const scale = sceneW / texW;
    spriteW = sceneW;
    spriteH = texH * scale;
    windowW = sceneW;
    windowH = Math.min(config.tilesPerStation * gridSize, spriteH);
    totalStations = Math.max(1, Math.ceil(spriteH / windowH));
  } else {
    const scale = sceneH / texH;
    spriteH = sceneH;
    spriteW = texW * scale;
    windowH = sceneH;
    windowW = Math.min(config.tilesPerStation * gridSize, spriteW);
    totalStations = Math.max(1, Math.ceil(spriteW / windowW));
  }

  return { x, y, spriteW, spriteH, windowW, windowH, totalStations, isVertical };
}

/**
 * Calcola la posizione (x, y) dello sprite per un determinato indice di stazione.
 */
function getTargetPosition(metrics, direction, index) {
  const { x, y, spriteW, spriteH, windowW, windowH } = metrics;
  const maxOffsetY = Math.max(0, spriteH - windowH);
  const maxOffsetX = Math.max(0, spriteW - windowW);

  switch (direction) {
    case "bottom-to-top": {
      // Stazione 0 = primi N tile in basso; avanzando scorre verso l'alto della mappa
      const offset = Math.max(0, maxOffsetY - index * windowH);
      return { x, y: y - offset };
    }
    case "top-to-bottom": {
      // Stazione 0 = primi N tile in alto; avanzando scorre verso il basso
      const offset = Math.min(maxOffsetY, index * windowH);
      return { x, y: y - offset };
    }
    case "left-to-right": {
      // Stazione 0 = primi N tile a sinistra; avanzando scorre verso destra
      const offset = Math.min(maxOffsetX, index * windowW);
      return { x: x - offset, y };
    }
    case "right-to-left": {
      // Stazione 0 = primi N tile a destra; avanzando scorre verso sinistra
      const offset = Math.max(0, maxOffsetX - index * windowW);
      return { x: x - offset, y };
    }
    default:
      return { x, y };
  }
}

/**
 * Rimuove il layer personalizzato e ripristina il background standard di Foundry.
 */
export function teardownStationLayer() {
  if (activeRafId) {
    cancelAnimationFrame(activeRafId);
    activeRafId = null;
  }
  stopTransitionSound();

  if (stationContainer) {
    canvas.primary?.removeChild(stationContainer);
    stationContainer.destroy({ children: true });
    stationContainer = null;
    stationSprite = null;
  }
  if (canvas.primary?.background) {
    canvas.primary.background.renderable = true;
  }
}

/**
 * Inizializza il background mascherato alla stazione corrente.
 * Ritorna il numero totale di stazioni calcolato (utile per il dock GM).
 */
export async function setupStationLayer(scene) {
  teardownStationLayer();

  if (!canvas?.ready || canvas.scene?.id !== scene?.id) return 0;

  const config = getStationConfig(scene);
  const bgSrc = getLevelBackgroundSrc(scene);
  if (!config.enabled || !bgSrc) return 0;

  const loadTex = foundry.canvas?.loadTexture ?? loadTexture;
  const PrimaryGroup = foundry.canvas?.groups?.PrimaryCanvasGroup ?? PrimaryCanvasGroup;

  const texture = await loadTex(bgSrc);
  if (!texture) return 0;

  const metrics = computeStationMetrics(scene, texture, config);
  const clampedIndex = Math.clamp(config.currentIndex, 0, metrics.totalStations - 1);
  const pos = getTargetPosition(metrics, config.direction, clampedIndex);

  if (canvas.primary.background) {
    canvas.primary.background.renderable = false;
  }

  stationContainer = new PIXI.Container();
  stationContainer.elevation = -Infinity;
  stationContainer.sortLayer = PrimaryGroup.SORT_LAYERS.SCENE;
  stationContainer.sort = 1;

  const mask = new PIXI.Graphics();
  mask.beginFill(0xffffff);
  mask.drawRect(metrics.x, metrics.y, metrics.windowW, metrics.windowH);
  mask.endFill();
  stationContainer.addChild(mask);
  stationContainer.mask = mask;

  stationSprite = new PIXI.Sprite(texture);
  stationSprite.width = metrics.spriteW;
  stationSprite.height = metrics.spriteH;
  stationSprite.position.set(pos.x, pos.y);

  stationContainer.addChild(stationSprite);
  canvas.primary.addChild(stationContainer);
  canvas.primary.sortDirty = true;

  return metrics.totalStations;
}

/**
 * Anima lo scorrimento fluido verso la nuova stazione.
 */
export function animateToStation(scene, targetIndex) {
  if (!canvas?.ready || canvas.scene?.id !== scene.id) return Promise.resolve();

  if (!stationSprite || stationSprite.destroyed) {
    return setupStationLayer(scene);
  }

  const config = getStationConfig(scene);
  const metrics = computeStationMetrics(scene, stationSprite.texture, config);
  const clampedIndex = Math.clamp(targetIndex, 0, metrics.totalStations - 1);
  const targetPos = getTargetPosition(metrics, config.direction, clampedIndex);

  if (activeRafId) {
    cancelAnimationFrame(activeRafId);
    activeRafId = null;
  }

  const startX = stationSprite.x;
  const startY = stationSprite.y;
  const deltaX = targetPos.x - startX;
  const deltaY = targetPos.y - startY;
  const duration = Math.max(200, Number(config.duration) || 2000);

  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
    return Promise.resolve();
  }

  // 1. Token visibili che scorrono
  const scrollingTokens = canvas.tokens.placeables
    .filter((t) => !t.document.hidden && shouldScrollWithBg(t.document) && t.mesh)
    .map((t) => ({
      mesh: t.mesh,
      startX: t.mesh.x,
      startY: t.mesh.y
    }));

  // 2. Luci che scorrono (sia in uscita che in entrata)
  const scrollingLights = canvas.lighting.placeables
    .filter((l) => shouldScrollWithBg(l.document))
    .map((l) => {
      const wasOffscreen = Boolean(l.document.getFlag(MODULE_ID, "isOffscreen"));
      const basePos = wasOffscreen
        ? (l.document.getFlag(MODULE_ID, "virtualPos") ?? { x: l.document.x, y: l.document.y })
        : { x: l.document.x, y: l.document.y };

      return {
        placeable: l,
        doc: l.document,
        origX: l.document.x,
        origY: l.document.y,
        origHidden: l.document.hidden,
        startX: basePos.x,
        startY: basePos.y
      };
    });

  // 3. Muri che scorrono (sia in uscita che in entrata)
  const scrollingWalls = canvas.walls.placeables
    .filter((w) => shouldScrollWithBg(w.document))
    .map((w) => {
      const wasOffscreen = Boolean(w.document.getFlag(MODULE_ID, "isOffscreen"));
      const baseC = wasOffscreen
        ? (w.document.getFlag(MODULE_ID, "virtualC") ?? w.document.c)
        : w.document.c;
      const saved = wasOffscreen ? w.document.getFlag(MODULE_ID, "savedWallProps") : null;

      return {
        placeable: w,
        doc: w.document,
        origC: [...w.document.c],
        origProps: {
          move: w.document.move,
          sight: w.document.sight,
          light: w.document.light,
          sound: w.document.sound
        },
        activeProps: saved ?? {
          move: w.document.move,
          sight: w.document.sight,
          light: w.document.light,
          sound: w.document.sound
        },
        startC: [...baseC]
      };
    });

  const rect = canvas.dimensions.sceneRect;
  const isInside = (px, py) =>
    px >= rect.x && px <= rect.x + rect.width &&
    py >= rect.y && py <= rect.y + rect.height;

  const startTime = performance.now();
  startTransitionSound(config.transitionSound);

  return new Promise((resolve) => {
    const step = async (now) => {
      if (!stationSprite || stationSprite.destroyed) {
        activeRafId = null;
        stopTransitionSound();
        return resolve();
      }

      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);

      const curDX = deltaX * ease;
      const curDY = deltaY * ease;

      // Muove lo sfondo
      stationSprite.position.set(startX + curDX, startY + curDY);

      // Muove i token
      for (const st of scrollingTokens) {
        if (!st.mesh.destroyed) {
          st.mesh.position.set(st.startX + curDX, st.startY + curDY);
        }
      }

      // Muove le luci in memoria e aggiorna la sorgente luminosa
      for (const sl of scrollingLights) {
        const curX = sl.startX + curDX;
        const curY = sl.startY + curDY;
        const inside = isInside(curX, curY);

        sl.doc.x = curX;
        sl.doc.y = curY;
        sl.doc.hidden = !inside;
        sl.placeable.position.set(curX, curY);
        sl.placeable.visible = inside;
        sl.placeable.initializeLightSource();
      }

      // Muove i muri e aggiorna direttamente il loro Edge per spostare ombre e visione in tempo reale
      for (const sw of scrollingWalls) {
        const c = [
          sw.startC[0] + curDX,
          sw.startC[1] + curDY,
          sw.startC[2] + curDX,
          sw.startC[3] + curDY
        ];
        const midX = (c[0] + c[2]) / 2;
        const midY = (c[1] + c[3]) / 2;
        const inside = isInside(c[0], c[1]) || isInside(c[2], c[3]) || isInside(midX, midY);

        const move = inside ? sw.activeProps.move : 0;
        const sight = inside ? sw.activeProps.sight : 0;
        const light = inside ? sw.activeProps.light : 0;
        const sound = inside ? sw.activeProps.sound : 0;

        sw.doc.c = c;
        sw.doc.move = move;
        sw.doc.sight = sight;
        sw.doc.light = light;
        sw.doc.sound = sound;

        // Aggiorna l'Edge in cache usato dal motore di visione/luci
        if (sw.placeable.edge) {
          sw.placeable.edge.a.set(c[0], c[1]);
          sw.placeable.edge.b.set(c[2], c[3]);
          sw.placeable.edge.move = move;
          sw.placeable.edge.sight = sight;
          sw.placeable.edge.light = light;
          sw.placeable.edge.sound = sound;
        }

        sw.placeable.visible = inside;
        sw.placeable.renderFlags?.set({ refreshLine: true });
      }

      // Ricostruisce gli edge e aggiorna ombre, visione e illuminazione
      if (scrollingWalls.length) {
        if (typeof canvas.edges?.initialize === "function") {
          canvas.edges.initialize();
        } else {
          canvas.edges?.refresh();
        }
      }
      if (scrollingLights.length || scrollingWalls.length) {
        canvas.perception.update({
          initializeLighting: true,
          initializeVision: scrollingWalls.length > 0,
          refreshLighting: true,
          refreshVision: scrollingWalls.length > 0
        });
      }

      if (t < 1) {
        activeRafId = requestAnimationFrame(step);
      } else {
        stationSprite.position.set(targetPos.x, targetPos.y);
        activeRafId = null;
        stopTransitionSound();

        // Ripristina i valori in memoria prima del commit definitivo
        for (const st of scrollingTokens) {
          if (!st.mesh.destroyed) st.mesh.position.set(st.startX, st.startY);
        }
        for (const sl of scrollingLights) {
          sl.doc.x = sl.origX;
          sl.doc.y = sl.origY;
          sl.doc.hidden = sl.origHidden;
          sl.placeable.position.set(sl.origX, sl.origY);
        }
        for (const sw of scrollingWalls) {
          sw.doc.c = sw.origC;
          sw.doc.move = sw.origProps.move;
          sw.doc.sight = sw.origProps.sight;
          sw.doc.light = sw.origProps.light;
          sw.doc.sound = sw.origProps.sound;
        }

        await commitScrollingPlaceables(scene, deltaX, deltaY);

        // Forza il riallineamento di hitArea, quadtree e controlli per Token, Luci e Muri
        for (const token of canvas.tokens?.placeables ?? []) {
          token.renderFlags?.set({ refreshPosition: true, refreshVisibility: true });
        }
        if (scrollingLights.length) {
          const wasActive = canvas.lighting.active;
          await canvas.lighting.draw();
          if (wasActive) canvas.lighting.activate();
        }
        for (const wall of canvas.walls?.placeables ?? []) {
          wall.renderFlags?.set({ refreshLine: true, refreshState: true });
        }

        if (typeof canvas.edges?.initialize === "function") {
          canvas.edges.initialize();
        } else {
          canvas.edges?.refresh();
        }

        canvas.perception.update({
          initializeLighting: true,
          initializeVision: true,
          refreshLighting: true,
          refreshVision: true
        });
        syncAllOffscreenVisibility();
        resolve();
      }
    };

    activeRafId = requestAnimationFrame(step);
  });
}

/**
 * Legge il percorso dello sfondo dal livello attivo (Foundry v14) senza warning di deprecazione.
 */
function getLevelBackgroundSrc(scene) {
  return (
    canvas.level?.background?.src ??
    scene.levels?.get(scene.initialLevel)?.background?.src ??
    null
  );
}

/**
 * Aggiorna posizioni e visibilità di Token, Muri e Luci marcati con scrollWithBg (solo GM).
 */
/**
 * Aggiorna posizioni virtuali e visibilità di Token, Muri e Luci (solo GM).
 */
async function commitScrollingPlaceables(scene, deltaX, deltaY) {
  if (!game.user.isGM) return;

  const rect = canvas.dimensions.sceneRect;
  const gridSize = scene.grid.size || 100;
  const isInside = (px, py) =>
    px >= rect.x && px <= rect.x + rect.width &&
    py >= rect.y && py <= rect.y + rect.height;

  // 1. TOKEN
  const tokenUpdates = [];
  for (const token of scene.tokens) {
    if (!shouldScrollWithBg(token)) continue;

    const wasOffscreen = Boolean(token.getFlag(MODULE_ID, "isOffscreen"));
    const basePos = wasOffscreen
      ? (token.getFlag(MODULE_ID, "virtualPos") ?? { x: token.x, y: token.y })
      : { x: token.x, y: token.y };

    const nextX = Math.round(basePos.x + deltaX);
    const nextY = Math.round(basePos.y + deltaY);
    const centerX = nextX + (token.width * gridSize) / 2;
    const centerY = nextY + (token.height * gridSize) / 2;
    const inside = isInside(centerX, centerY);

    const update = {
      _id: token.id,
      [`flags.${MODULE_ID}.virtualPos`]: { x: nextX, y: nextY },
      [`flags.${MODULE_ID}.isOffscreen`]: !inside
    };

    if (inside) {
      update.x = nextX;
      update.y = nextY;
      update.hidden = false;
    } else {
      update.hidden = true;
    }

    tokenUpdates.push(update);
  }

  // 2. LUCI AMBIENTALI
  const lightUpdates = [];
  for (const light of scene.lights) {
    if (!shouldScrollWithBg(light)) continue;

    const wasOffscreen = Boolean(light.getFlag(MODULE_ID, "isOffscreen"));
    const basePos = wasOffscreen
      ? (light.getFlag(MODULE_ID, "virtualPos") ?? { x: light.x, y: light.y })
      : { x: light.x, y: light.y };

    const nextX = Math.round(basePos.x + deltaX);
    const nextY = Math.round(basePos.y + deltaY);
    const inside = isInside(nextX, nextY);

    const update = {
      _id: light.id,
      [`flags.${MODULE_ID}.virtualPos`]: { x: nextX, y: nextY },
      [`flags.${MODULE_ID}.isOffscreen`]: !inside
    };

    if (inside) {
      update.x = nextX;
      update.y = nextY;
      update.hidden = false;
    } else {
      update.hidden = true;
    }

    lightUpdates.push(update);
  }

  // 3. MURI
  const wallUpdates = [];
  for (const wall of scene.walls) {
    if (!shouldScrollWithBg(wall)) continue;

    const wasOffscreen = Boolean(wall.getFlag(MODULE_ID, "isOffscreen"));
    const baseC = wasOffscreen
      ? (wall.getFlag(MODULE_ID, "virtualC") ?? wall.c)
      : wall.c;

    const nextC = [
      Math.round(baseC[0] + deltaX),
      Math.round(baseC[1] + deltaY),
      Math.round(baseC[2] + deltaX),
      Math.round(baseC[3] + deltaY)
    ];

    const midX = (nextC[0] + nextC[2]) / 2;
    const midY = (nextC[1] + nextC[3]) / 2;
    const inside = isInside(nextC[0], nextC[1]) || isInside(nextC[2], nextC[3]) || isInside(midX, midY);

    const update = {
      _id: wall.id,
      [`flags.${MODULE_ID}.virtualC`]: nextC,
      [`flags.${MODULE_ID}.isOffscreen`]: !inside
    };

    if (inside) {
      update.c = nextC;
      if (wasOffscreen) {
        const saved = wall.getFlag(MODULE_ID, "savedWallProps");
        if (saved) {
          update.move = saved.move;
          update.sight = saved.sight;
          update.light = saved.light;
          update.sound = saved.sound;
        }
      }
    } else {
      if (!wasOffscreen) {
        update[`flags.${MODULE_ID}.savedWallProps`] = {
          move: wall.move,
          sight: wall.sight,
          light: wall.light,
          sound: wall.sound
        };
      }
      // Disattiva collisioni e blocchi visione finché il muro è fuori scena
      update.move = 0;
      update.sight = 0;
      update.light = 0;
      update.sound = 0;
    }

    wallUpdates.push(update);
  }

  const promises = [];
  if (tokenUpdates.length) {
    promises.push(scene.updateEmbeddedDocuments("Token", tokenUpdates, { animate: false }));
  }
  if (lightUpdates.length) {
    promises.push(scene.updateEmbeddedDocuments("AmbientLight", lightUpdates));
  }
  if (wallUpdates.length) {
    promises.push(scene.updateEmbeddedDocuments("Wall", wallUpdates));
  }

  await Promise.all(promises);
}