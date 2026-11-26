import { MODULE_ID, getStationConfig, shouldScrollWithBg } from "./transition.js";

/**
 * Inietta i campi nella sezione "Livello iniziale" di SceneConfig (Foundry v14 AppV2).
 */
export function injectSceneConfig(app, html) {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector(".ss-config-fieldset")) return;

  const scene = app.document;
  const config = getStationConfig(scene);

  // 1. Cerca il selettore del "Livello iniziale" o il campo background del livello
  const initialLevelField =
    root.querySelector('[name="initialLevel"]') ??
    root.querySelector('[name*="initialLevel"]') ??
    root.querySelector('[name$="background.src"]');

  // 2. Risale al fieldset o al tab che contiene "Livello iniziale"
  const targetSection =
    initialLevelField?.closest("fieldset") ??
    initialLevelField?.closest(".tab") ??
    root.querySelector('.tab[data-tab="basics"]') ??
    root.querySelector('.tab[data-tab="levels"]') ??
    root.querySelector(".tab.active") ??
    root;

  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("ss-config-fieldset");
  fieldset.innerHTML = `
    <legend>Scena a Stazioni</legend>

    <div class="form-group">
      <label>Abilita scena a stazioni</label>
      <div class="form-fields">
        <input type="checkbox" class="ss-toggle-enabled" name="flags.${MODULE_ID}.enabled" ${config.enabled ? "checked" : ""}>
      </div>
    </div>

    <div class="ss-conditional-fields ${config.enabled ? "" : "ss-hidden"}">
      <div class="form-group">
        <label>Direzione di scorrimento</label>
        <div class="form-fields">
          <select name="flags.${MODULE_ID}.direction">
            <option value="bottom-to-top" ${config.direction === "bottom-to-top" ? "selected" : ""}>Dal basso verso l'alto</option>
            <option value="top-to-bottom" ${config.direction === "top-to-bottom" ? "selected" : ""}>Dall'alto verso il basso</option>
            <option value="left-to-right" ${config.direction === "left-to-right" ? "selected" : ""}>Da sinistra verso destra</option>
            <option value="right-to-left" ${config.direction === "right-to-left" ? "selected" : ""}>Da destra verso sinistra</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>Tile visibili per stazione</label>
        <div class="form-fields">
          <input type="number" name="flags.${MODULE_ID}.tilesPerStation" value="${config.tilesPerStation}" min="1" step="1">
        </div>
        <p class="hint">Numero di celle della griglia mostrate per volta lungo la direzione di scorrimento.</p>
      </div>

      <div class="form-group">
        <label>Durata transizione (ms)</label>
        <div class="form-fields">
          <input type="number" name="flags.${MODULE_ID}.duration" value="${config.duration}" min="200" step="100">
        </div>
      </div>

      <div class="form-group">
        <label>Suono di transizione</label>
        <div class="form-fields">
          <input type="text" class="ss-sound-input" name="flags.${MODULE_ID}.transitionSound" value="${config.transitionSound ?? ""}" placeholder="Percorso file audio...">
          <button type="button" class="ss-browse-sound" title="Scegli file audio" style="flex: 0 0 32px;">
            <i class="fa-solid fa-file-audio"></i>
          </button>
        </div>
        <p class="hint">Riprodotto in loop solo mentre la mappa sta scorrendo.</p>
      </div>
    </div>
  `;

  // Se abbiamo trovato un fieldset specifico (es. quello di Livello iniziale), inseriamo subito dopo di esso;
  // altrimenti appendiamo in fondo al tab trovato.
  if (targetSection.tagName === "FIELDSET") {
    targetSection.insertAdjacentElement("afterend", fieldset);
  } else {
    targetSection.appendChild(fieldset);
  }

  // Mostra/nasconde i campi aggiuntivi quando si clicca la checkbox
  const checkbox = fieldset.querySelector(".ss-toggle-enabled");
  const extraFields = fieldset.querySelector(".ss-conditional-fields");

  checkbox.addEventListener("change", () => {
    extraFields.classList.toggle("ss-hidden", !checkbox.checked);
  });

  const soundInput = fieldset.querySelector(".ss-sound-input");
  const soundBrowseBtn = fieldset.querySelector(".ss-browse-sound");

  soundBrowseBtn.addEventListener("click", () => {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    new FP({
      type: "audio",
      current: soundInput.value || "",
      callback: (path) => {
        soundInput.value = path;
      }
    }).browse();
  });
}

const HUD_POS_KEY = `${MODULE_ID}.hudPosition`;

/**
 * Renderizza il dock di controllo trascinabile sul canvas (solo GM).
 */
export function renderStationControls(scene, totalStations) {
  document.getElementById("ss-canvas-hud")?.remove();

  if (!game.user.isGM || !scene || totalStations < 2) return;
  const config = getStationConfig(scene);
  if (!config.enabled) return;

  const idx = Math.clamp(config.currentIndex, 0, totalStations - 1);

  const hud = document.createElement("div");
  hud.id = "ss-canvas-hud";
  hud.innerHTML = `
    <div class="ss-drag-handle" title="Trascina per spostare">
      <i class="fa-solid fa-grip-vertical"></i>
    </div>
    <button type="button" class="ss-btn-prev" title="Stazione precedente" ${idx <= 0 ? "disabled" : ""}>
      <i class="fa-solid fa-chevron-left"></i>
    </button>
    <div class="ss-hud-label">
      <span class="ss-hud-step">Stazione</span>
      <span class="ss-hud-name">${idx + 1} / ${totalStations}</span>
    </div>
    <button type="button" class="ss-btn-next" title="Stazione successiva" ${idx >= totalStations - 1 ? "disabled" : ""}>
      <i class="fa-solid fa-chevron-right"></i>
    </button>
  `;

  hud.querySelector(".ss-btn-prev").addEventListener("click", () => {
    if (idx > 0) scene.setFlag(MODULE_ID, "currentIndex", idx - 1);
  });

  hud.querySelector(".ss-btn-next").addEventListener("click", () => {
    if (idx < totalStations - 1) scene.setFlag(MODULE_ID, "currentIndex", idx + 1);
  });

  document.body.appendChild(hud);

  // Ripristina la posizione salvata (se presente)
  try {
    const saved = JSON.parse(localStorage.getItem(HUD_POS_KEY));
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      const maxLeft = Math.max(0, window.innerWidth - hud.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - hud.offsetHeight);
      hud.style.left = `${Math.clamp(saved.left, 0, maxLeft)}px`;
      hud.style.top = `${Math.clamp(saved.top, 0, maxTop)}px`;
      hud.style.right = "auto";
      hud.style.bottom = "auto";
    }
  } catch {
    // Ignora eventuali dati corrotti in localStorage
  }

  enableHudDrag(hud);
}

/**
 * Gestisce il drag & drop del dock ignorando i clic sui pulsanti.
 */
function enableHudDrag(hud) {
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  hud.addEventListener("pointerdown", (e) => {
    // Non iniziare il drag se l'utente clicca sui pulsanti freccia
    if (e.target.closest("button")) return;

    isDragging = true;
    hud.classList.add("ss-dragging");
    hud.setPointerCapture(e.pointerId);

    const rect = hud.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    // Passa al posizionamento assoluto tramite left/top
    hud.style.left = `${rect.left}px`;
    hud.style.top = `${rect.top}px`;
    hud.style.right = "auto";
    hud.style.bottom = "auto";
  });

  hud.addEventListener("pointermove", (e) => {
    if (!isDragging) return;

    const maxLeft = Math.max(0, window.innerWidth - hud.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - hud.offsetHeight);

    const newLeft = Math.clamp(e.clientX - offsetX, 0, maxLeft);
    const newTop = Math.clamp(e.clientY - offsetY, 0, maxTop);

    hud.style.left = `${newLeft}px`;
    hud.style.top = `${newTop}px`;
  });

  const endDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    hud.classList.remove("ss-dragging");
    if (hud.hasPointerCapture(e.pointerId)) {
      hud.releasePointerCapture(e.pointerId);
    }

    localStorage.setItem(
      HUD_POS_KEY,
      JSON.stringify({
        left: parseFloat(hud.style.left) || 0,
        top: parseFloat(hud.style.top) || 0
      })
    );
  };

  hud.addEventListener("pointerup", endDrag);
  hud.addEventListener("pointercancel", endDrag);
}

/**
 * Aggiunge il tasto "Scorri con lo sfondo" nel Token HUD.
 */
export function injectTokenHudButton(app, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const tokenDoc = app.document ?? app.object?.document;
  if (!root || !tokenDoc || root.querySelector('[data-action="ss-toggle-scroll"]')) return;

  const isScrolling = shouldScrollWithBg(tokenDoc);
  const col = root.querySelector(".col.right") ?? root.querySelector(".col.left");
  if (!col) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `control-icon ${isScrolling ? "active" : ""}`;
  btn.dataset.action = "ss-toggle-scroll";
  btn.title = "Scorri con lo sfondo (Scena a Stazioni)";
  btn.innerHTML = `<i class="fa-solid fa-arrows-up-down-left-right"></i>`;

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const nextState = !shouldScrollWithBg(tokenDoc);
    await tokenDoc.setFlag(MODULE_ID, "scrollWithBg", nextState);
    btn.classList.toggle("active", nextState);
  });

  col.appendChild(btn);
}

/**
 * Aggiunge la checkbox "Scorri con lo sfondo" nella configurazione di Muri e Luci.
 */
export function injectPlaceableConfigCheckbox(app, html) {
  const root = html instanceof HTMLElement ? html : html[0];
  const doc = app.document;
  if (!root || !doc || root.querySelector(".ss-scroll-checkbox")) return;

  const isScrolling = shouldScrollWithBg(doc);

  const group = document.createElement("div");
  group.classList.add("form-group", "ss-scroll-checkbox");
  group.innerHTML = `
    <label>Scorri con lo sfondo (Stazioni)</label>
    <div class="form-fields">
      <input type="checkbox" name="flags.${MODULE_ID}.scrollWithBg" ${isScrolling ? "checked" : ""}>
    </div>
    <p class="hint">Se attivo, questo elemento si sposta e scompare/riappare insieme allo scorrimento della mappa.</p>
  `;

  // Inserisce prima del footer o in fondo al primo tab / form
  const footer = root.querySelector("footer.form-footer, footer");
  const targetTab = root.querySelector('.tab[data-tab="basic"], .tab.active');

  if (targetTab) {
    targetTab.appendChild(group);
  } else if (footer) {
    footer.insertAdjacentElement("beforebegin", group);
  } else {
    root.appendChild(group);
  }
}