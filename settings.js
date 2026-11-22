window.RoomSettings = (function () {
  const STORAGE_KEY = "vaerelsesfordeling_state_v3";
  const PREV_KEYS = ["vaerelsesfordeling_state_v2", "vaerelsesfordeling_state_v1"];

  const DEFAULT_ELEVER_URL =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vR3R_YlG91wHU9McLEXydy9Je4gh0xnGhIZQjNB3g9_tjtJgmHikzOfAtZgzVKppKwbxwTyikLoTzak/pub?gid=211164369&single=true&output=csv";
  const DEFAULT_VAERELSER_URL =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vRk2Tks0XVu1h_y3lh4w6YQAfxsMq6f9HSNe5xR27c-DpvKh90P4CH1CmE2Fu16-6e4289l3VcnDIMy/pub?gid=0&single=true&output=csv";

  function createPeriodObject(id, name, urlElever = "") {
    return {
      id,
      name,
      urlElever,
      eleverRows: [],
      assignments: {} // { roomId: [ { studentKey, locked } ] }
    };
  }

  const DEFAULT_CONFIG = {
    urlVaerelser: DEFAULT_VAERELSER_URL,
    rules: {
      abStrictInternat: false,
      abStrictExclude: true,
      avoidTwoNew: true
    },
    mapping: {
      elever: {},
      vaerelser: {}
    },
    cachedData: {
      eleverHeaders: [],
      vaerelserHeaders: [],
      vaerelserRows: []
    },
    activePeriodId: "period_1",
    periods: [createPeriodObject("period_1", "Periode 1", DEFAULT_ELEVER_URL)]
  };

  // Synonymer til automatisk genkendelse af kolonner fra systemeksport
  const STUDENT_FIELDS = [
    { key: "id", label: "Elev ID (valgfri)", aliases: ["elev_id", "id", "elevnr", "nummer", "brugerid", "unilogin"] },
    { key: "name", label: "Fulde navn", aliases: ["navn", "fulde navn", "elevnavn", "elev", "name"] },
    { key: "firstName", label: "Fornavn (hvis opdelt)", aliases: ["fornavn", "firstname", "first name"] },
    { key: "lastName", label: "Efternavn (hvis opdelt)", aliases: ["efternavn", "lastname", "last name"] },
    { key: "gender", label: "Køn *", aliases: ["koen", "køn", "gender", "sex"] },
    { key: "lockedRoom", label: "Låst værelse (forhåndsvalg)", aliases: ["laast_vaerelse", "låst værelse", "fast værelse", "vaerelse", "værelse", "værelsesnr", "room", "tildelt"] },
    { key: "country", label: "Land / Nationalitet", aliases: ["land", "country", "nationalitet", "nationality", "nation"] },
    { key: "optOutInternational", label: "Fravælg international", aliases: ["fravaelg_international", "fravælg international", "fravalg international", "ikke international"] },
    { key: "excludeWith", label: "Ikke på værelse med", aliases: ["ikke_med", "ikke med", "undgå", "undgaa", "må ikke bo med", "konflikt"] },
    { key: "isNew", label: "Ny elev (valgfri overstyring)", aliases: ["ny_elev", "ny elev", "ny", "new"] }
  ];

  const ROOM_FIELDS = [
    { key: "roomId", label: "Værelsesnr / ID *", aliases: ["vaerelse_id", "værelse_id", "værelse", "vaerelse", "værelsesnr", "nr", "nummer", "room", "navn"] },
    { key: "capacity", label: "Antal pladser *", aliases: ["pladser", "antal", "senge", "kapacitet", "antal pladser", "beds", "capacity"] },
    { key: "roomType", label: "Værelsestype / Fløj", aliases: ["vaerelsestype", "værelsestype", "type", "fløj", "floej", "bygning", "afdeling"] },
    { key: "priority", label: "Prioritet (1 = først)", aliases: ["prioritet", "priority", "prio", "rækkefølge", "raekkefoelge"] },
    { key: "gender", label: "Låst køn (valgfri)", aliases: ["koen", "køn", "gender", "kønskrav"] },
    { key: "active", label: "Aktiv (JA/NEJ)", aliases: ["aktiv", "active", "status", "i brug"] }
  ];

  let state = loadState();

  function loadState() {
    try {
      const rawV3 = localStorage.getItem(STORAGE_KEY);
      if (rawV3) {
        const parsed = JSON.parse(rawV3);
        const periods = Array.isArray(parsed.periods) && parsed.periods.length > 0
          ? parsed.periods
          : structuredClone(DEFAULT_CONFIG.periods);

        return {
          ...structuredClone(DEFAULT_CONFIG),
          ...parsed,
          rules: { ...DEFAULT_CONFIG.rules, ...(parsed.rules || {}) },
          mapping: {
            elever: { ...(parsed.mapping?.elever || {}) },
            vaerelser: { ...(parsed.mapping?.vaerelser || {}) }
          },
          cachedData: { ...DEFAULT_CONFIG.cachedData, ...(parsed.cachedData || {}) },
          periods,
          activePeriodId: periods.some(p => p.id === parsed.activePeriodId)
            ? parsed.activePeriodId
            : periods[0].id
        };
      }

      for (const oldKey of PREV_KEYS) {
        const oldRaw = localStorage.getItem(oldKey);
        if (!oldRaw) continue;
        const old = JSON.parse(oldRaw);
        const p1 = createPeriodObject(
          "period_1",
          "Periode 1",
          old.urlElever1 || old.urlElever || DEFAULT_ELEVER_URL
        );
        p1.eleverRows = old.cachedData?.elever1Rows || old.cachedData?.eleverRows || [];
        p1.assignments = old.cachedData?.assignments || {};

        return {
          ...structuredClone(DEFAULT_CONFIG),
          urlVaerelser: old.urlVaerelser || DEFAULT_VAERELSER_URL,
          rules: { ...DEFAULT_CONFIG.rules, ...(old.rules || {}) },
          mapping: {
            elever: { ...(old.mapping?.elever || {}) },
            vaerelser: { ...(old.mapping?.vaerelser || {}) }
          },
          cachedData: {
            eleverHeaders: old.cachedData?.eleverHeaders || [],
            vaerelserHeaders: old.cachedData?.vaerelserHeaders || [],
            vaerelserRows: old.cachedData?.vaerelserRows || []
          },
          activePeriodId: "period_1",
          periods: [p1]
        };
      }

      return structuredClone(DEFAULT_CONFIG);
    } catch (e) {
      console.warn("Kunne ikke læse localStorage, bruger standard:", e);
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Fejl ved gem i localStorage:", e);
    }
  }

  function resetState() {
    localStorage.removeItem(STORAGE_KEY);
    PREV_KEYS.forEach(k => localStorage.removeItem(k));
    state = structuredClone(DEFAULT_CONFIG);
  }

  function getActivePeriod() {
    let found = state.periods.find(p => p.id === state.activePeriodId);
    if (!found) {
      found = state.periods[0];
      state.activePeriodId = found.id;
    }
    return found;
  }

  function setActivePeriod(periodId) {
    if (state.periods.some(p => p.id === periodId)) {
      state.activePeriodId = periodId;
      saveState();
    }
  }

  function addPeriod(name, urlElever) {
    const id = `period_${Date.now()}`;
    const cleanName = (name || "").trim() || `Værelsesskift ${state.periods.length}`;
    const newPeriod = createPeriodObject(id, cleanName, urlElever.trim());
    state.periods.push(newPeriod);
    state.activePeriodId = id;
    saveState();
    return newPeriod;
  }

  function deleteActivePeriod() {
    if (state.periods.length <= 1) return false;
    const idx = state.periods.findIndex(p => p.id === state.activePeriodId);
    if (idx === -1) return false;
    state.periods.splice(idx, 1);
    const nextIdx = Math.max(0, idx - 1);
    state.activePeriodId = state.periods[nextIdx].id;
    saveState();
    return true;
  }

  function normalizeHeader(str) {
    return String(str || "").toLowerCase().replace(/[\s_-]+/g, "").trim();
  }

  function autoMapHeaders(eleverHeaders, vaerelserHeaders) {
    if (eleverHeaders && eleverHeaders.length > 0) {
      state.cachedData.eleverHeaders = eleverHeaders;
    }
    if (vaerelserHeaders && vaerelserHeaders.length > 0) {
      state.cachedData.vaerelserHeaders = vaerelserHeaders;
    }

    const eH = state.cachedData.eleverHeaders || [];
    const vH = state.cachedData.vaerelserHeaders || [];

    STUDENT_FIELDS.forEach(field => {
      const current = state.mapping.elever[field.key];
      if (current && eH.includes(current)) return;

      const match = eH.find(h =>
        field.aliases.some(alias => normalizeHeader(h) === normalizeHeader(alias))
      );
      if (match) state.mapping.elever[field.key] = match;
    });

    ROOM_FIELDS.forEach(field => {
      const current = state.mapping.vaerelser[field.key];
      if (current && vH.includes(current)) return;

      const match = vH.find(h =>
        field.aliases.some(alias => normalizeHeader(h) === normalizeHeader(alias))
      );
      if (match) state.mapping.vaerelser[field.key] = match;
    });

    saveState();
  }

  function renderSettingsUI() {
    const activePeriod = getActivePeriod();
    document.getElementById("url-vaerelser").value = state.urlVaerelser || "";
    document.getElementById("active-period-settings-title").textContent = `Opsætning for "${activePeriod.name}"`;
    document.getElementById("period-name-input").value = activePeriod.name || "";
    document.getElementById("url-period-elever").value = activePeriod.urlElever || "";

    const deleteBtn = document.getElementById("btn-delete-period");
    if (deleteBtn) {
      deleteBtn.disabled = state.periods.length <= 1;
      deleteBtn.title = state.periods.length <= 1 ? "Du kan ikke slette den sidste periode" : "Slet denne periode";
    }

    document.getElementById("rule-ab-strict-internat").checked = !!state.rules.abStrictInternat;
    document.getElementById("rule-ab-strict-exclude").checked = !!state.rules.abStrictExclude;
    document.getElementById("rule-avoid-two-new").checked = !!state.rules.avoidTwoNew;

    const container = document.getElementById("mapping-container");
    const eHeaders = state.cachedData.eleverHeaders || [];
    const vHeaders = state.cachedData.vaerelserHeaders || [];

    const buildSelect = (type, fieldKey, headers, selectedVal) => {
      const options = [`<option value="">-- Ikke valgt --</option>`]
        .concat(headers.map(h => `<option value="${escapeAttr(h)}" ${h === selectedVal ? "selected" : ""}>${escapeHtml(h)}</option>`));
      return `<select data-map-type="${type}" data-map-key="${fieldKey}">${options.join("")}</select>`;
    };

    container.innerHTML = `
      <div class="mapping-box">
        <h3>Kolonner i Eleveksport (${eHeaders.length} fundet)</h3>
        ${STUDENT_FIELDS.map(f => `
          <div class="mapping-row">
            <label>${f.label}</label>
            ${buildSelect("elever", f.key, eHeaders, state.mapping.elever[f.key])}
          </div>
        `).join("")}
      </div>
      <div class="mapping-box">
        <h3>Kolonner i Værelsesliste (${vHeaders.length} fundet)</h3>
        ${ROOM_FIELDS.map(f => `
          <div class="mapping-row">
            <label>${f.label}</label>
            ${buildSelect("vaerelser", f.key, vHeaders, state.mapping.vaerelser[f.key])}
          </div>
        `).join("")}
      </div>
    `;
  }

  function readSettingsFromUI() {
    const activePeriod = getActivePeriod();
    state.urlVaerelser = document.getElementById("url-vaerelser").value.trim();

    const newName = document.getElementById("period-name-input").value.trim();
    if (newName) activePeriod.name = newName;
    activePeriod.urlElever = document.getElementById("url-period-elever").value.trim();

    state.rules.abStrictInternat = document.getElementById("rule-ab-strict-internat").checked;
    state.rules.abStrictExclude = document.getElementById("rule-ab-strict-exclude").checked;
    state.rules.avoidTwoNew = document.getElementById("rule-avoid-two-new").checked;

    document.querySelectorAll("select[data-map-type]").forEach(sel => {
      const type = sel.getAttribute("data-map-type");
      const key = sel.getAttribute("data-map-key");
      state.mapping[type][key] = sel.value;
    });

    saveState();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  return {
    getState: () => state,
    getActivePeriod,
    setActivePeriod,
    addPeriod,
    deleteActivePeriod,
    saveState,
    resetState,
    autoMapHeaders,
    renderSettingsUI,
    readSettingsFromUI,
    escapeHtml
  };
})();