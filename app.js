(function () {
  const {
    getState,
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
  } = window.RoomSettings;

  let activePickerRoomId = null;

  // 1. Smart CSV-parser (understøtter ;, , og TAB samt fjerner UTF-8 BOM)
  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/)[0] || "";
    const semicolons = (firstLine.match(/;/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    const tabs = (firstLine.match(/\t/g) || []).length;
    if (tabs > semicolons && tabs > commas) return "\t";
    return semicolons >= commas && semicolons > 0 ? ";" : ",";
  }

  function parseCSV(rawText) {
    const cleanText = rawText.replace(/^\uFEFF/, "").trim();
    if (!cleanText) return { headers: [], rows: [], delimiter: "," };

    const delimiter = detectDelimiter(cleanText);
    const rows = [];
    let inQuotes = false;
    let row = [];
    let cell = "";

    for (let i = 0; i < cleanText.length; i++) {
      const char = cleanText[i];
      if (char === '"' && cleanText[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && cleanText[i + 1] === "\n") i++;
        row.push(cell.trim());
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    if (cell || row.length) {
      row.push(cell.trim());
      rows.push(row);
    }

    const nonEmptyRows = rows.filter(r => r.some(c => c !== ""));
    if (nonEmptyRows.length === 0) return { headers: [], rows: [], delimiter };

    const headers = nonEmptyRows[0].map((h, idx) => h || `Kolonne_${idx + 1}`);
    const data = nonEmptyRows.slice(1).map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = (r[i] || "").trim();
      });
      return obj;
    });

    return { headers, rows: data, delimiter };
  }

  // 2. Normalisering af værdier fra systemeksport
  function isTruthy(val) {
    const v = String(val || "").toLowerCase().trim();
    return ["ja", "yes", "true", "1", "x", "sand"].includes(v);
  }

  function isFalsy(val) {
    const v = String(val || "").toLowerCase().trim();
    return ["nej", "no", "false", "0", "lukket", "inaktiv"].includes(v);
  }

  function normalizeGender(val) {
    const v = String(val || "").toLowerCase().trim();
    if (!v || ["fri", "alle", "neutral", "blandet"].includes(v)) return "Fri";
    if (["pige", "piger", "kvinde", "k", "f", "female", "hun"].includes(v)) return "Pige";
    if (["dreng", "drenge", "mand", "m", "male", "han"].includes(v)) return "Dreng";
    if (["ikke-binær", "ikke binær", "ikkebinaer", "non-binær", "non binær", "non-binary", "nonbinary", "nb", "andet", "x"].includes(v)) return "Ikke-binær";
    return val.trim();
  }

  function normalizeSpaces(str) {
    return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // Læser kommaseparerede (eller semikolonseparerede) værdier i det rene dataformat
  function splitList(val) {
    if (!val) return [];
    return String(val)
      .split(/[,;]+/)
      .map(s => normalizeSpaces(s))
      .filter(Boolean);
  }

  function getBaseRoomId(roomId) {
    const clean = String(roomId || "").trim();
    if (/[a-zA-ZæøåÆØÅ]$/.test(clean)) {
      return clean.slice(0, -1);
    }
    return clean;
  }

  function getFloorFromRoomId(roomId) {
    const match = String(roomId || "").trim().match(/\d/);
    return match ? match[0] : "";
  }

  function parsePriority(val) {
    const v = String(val || "").toLowerCase().trim();
    if (!v) return 2;
    if (["høj", "hoej", "high", "først", "foerst"].includes(v)) return 1;
    if (["mellem", "normal", "medium"].includes(v)) return 2;
    if (["lav", "low", "sidst", "reserve"].includes(v)) return 3;
    const num = parseInt(v, 10);
    return Number.isFinite(num) ? num : 2;
  }

  function extractStudentIdentity(raw, mE) {
    let name = mE.name ? (raw[mE.name] || "").trim() : "";
    if (!name && (mE.firstName || mE.lastName)) {
      const fn = mE.firstName ? (raw[mE.firstName] || "").trim() : "";
      const ln = mE.lastName ? (raw[mE.lastName] || "").trim() : "";
      name = `${fn} ${ln}`.trim();
    }
    const extId = mE.id ? String(raw[mE.id] || "").trim() : "";
    return {
      name,
      nameLower: normalizeSpaces(name),
      extId,
      extIdLower: extId.toLowerCase(),
      key: extId || name
    };
  }

  function matchesExcludeEntry(ref, student) {
    const cleanRef = normalizeSpaces(ref);
    if (!cleanRef) return false;
    if (cleanRef === student.nameLower) return true;
    if (student.extId && cleanRef === student.extId) return true;
    return false;
  }

  function hasStudentConflict(s1, s2) {
    if (s1.excludeWith.some(ref => matchesExcludeEntry(ref, s2))) return true;
    if (s2.excludeWith.some(ref => matchesExcludeEntry(ref, s1))) return true;
    return false;
  }

  function hasInternatConflict(s1, s2) {
    return (s1.international && s2.optOutInternational) || (s2.international && s1.optOutInternational);
  }

  // Find alle aktive konflikter på værelser og delte bad-grupper (til live-markering)
  function analyzeRoomConflicts(rooms, assignments, studentMap, rules) {
    const roomConflicts = new Map();
    const clusterConflicts = new Map();
    const conflictingStudentKeys = new Set();
    const topWarnings = [];

    const addRoomConflict = (roomId, msg) => {
      if (!roomConflicts.has(roomId)) roomConflicts.set(roomId, []);
      if (!roomConflicts.get(roomId).includes(msg)) roomConflicts.get(roomId).push(msg);
    };

    const addClusterConflict = (baseId, msg) => {
      if (!clusterConflicts.has(baseId)) clusterConflicts.set(baseId, []);
      if (!clusterConflicts.get(baseId).includes(msg)) clusterConflicts.get(baseId).push(msg);
    };

    const roomsByBase = new Map();
    rooms.forEach(r => {
      if (!roomsByBase.has(r.baseId)) roomsByBase.set(r.baseId, []);
      roomsByBase.get(r.baseId).push(r);
    });

    roomsByBase.forEach((clusterRooms, baseId) => {
      const clusterEntries = [];

      // 1. Tjek konflikter inde på hvert enkelt værelse
      clusterRooms.forEach(room => {
        const occs = (assignments[room.roomId] || [])
          .map(e => studentMap.get(e.studentKey))
          .filter(Boolean);

        occs.forEach(s => clusterEntries.push({ room, student: s }));

        if (room.fixedGender !== "Fri") {
          occs.forEach(s => {
            if (s.gender !== "Fri" && s.gender !== room.fixedGender) {
              conflictingStudentKeys.add(s.key);
              addRoomConflict(
                room.roomId,
                `${s.name} (${s.gender}) matcher ikke værelsets kønskrav (${room.fixedGender})`
              );
            }
          });
        }

        const roomGenders = [...new Set(occs.map(s => s.gender).filter(g => g !== "Fri"))];
        if (roomGenders.length > 1) {
          occs.forEach(s => {
            if (s.gender !== "Fri") conflictingStudentKeys.add(s.key);
          });
          addRoomConflict(room.roomId, `Blandede køn på værelset (${roomGenders.join(" og ")})`);
        }

        for (let i = 0; i < occs.length; i++) {
          for (let j = i + 1; j < occs.length; j++) {
            const s1 = occs[i];
            const s2 = occs[j];

            if (hasStudentConflict(s1, s2)) {
              conflictingStudentKeys.add(s1.key);
              conflictingStudentKeys.add(s2.key);
              addRoomConflict(room.roomId, `${s1.name} og ${s2.name} ("Ikke med")`);
            }

            if (hasInternatConflict(s1, s2)) {
              conflictingStudentKeys.add(s1.key);
              conflictingStudentKeys.add(s2.key);
              addRoomConflict(room.roomId, `${s1.name} og ${s2.name} (fravalg af international)`);
            }
          }
        }

        const rMsgs = roomConflicts.get(room.roomId);
        if (rMsgs && rMsgs.length > 0) {
          topWarnings.push(
            `Konflikt på <strong>Værelse ${escapeHtml(room.roomId)}</strong>: ${rMsgs.map(escapeHtml).join(" · ")}.`
          );
        }
      });

      // 2. Tjek konflikter på tværs af A/B-værelser med delt bad & toilet
      if (clusterRooms.length > 1 && clusterEntries.length > 0) {
        const clusterLabel = clusterRooms.map(r => r.roomId).join(" & ");
        const clusterGenders = [...new Set(clusterEntries.map(x => x.student.gender).filter(g => g !== "Fri"))];
        const hasSingleRoomGenderMix = clusterRooms.some(r => {
          const msgs = roomConflicts.get(r.roomId) || [];
          return msgs.some(m => m.startsWith("Blandede køn"));
        });

        if (clusterGenders.length > 1 && !hasSingleRoomGenderMix) {
          clusterEntries.forEach(x => {
            if (x.student.gender !== "Fri") conflictingStudentKeys.add(x.student.key);
          });
          addClusterConflict(baseId, `Blandede køn på delt bad (${clusterGenders.join(" og ")})`);
        }

        for (let i = 0; i < clusterEntries.length; i++) {
          for (let j = i + 1; j < clusterEntries.length; j++) {
            const a = clusterEntries[i];
            const b = clusterEntries[j];
            if (a.room.roomId === b.room.roomId) continue;

            if (rules.abStrictExclude && hasStudentConflict(a.student, b.student)) {
              conflictingStudentKeys.add(a.student.key);
              conflictingStudentKeys.add(b.student.key);
              addClusterConflict(
                baseId,
                `${a.student.name} (${a.room.roomId}) og ${b.student.name} (${b.room.roomId}) ("Ikke med" på delt bad)`
              );
            }

            if (rules.abStrictInternat && hasInternatConflict(a.student, b.student)) {
              conflictingStudentKeys.add(a.student.key);
              conflictingStudentKeys.add(b.student.key);
              addClusterConflict(
                baseId,
                `${a.student.name} (${a.room.roomId}) og ${b.student.name} (${b.room.roomId}) (fravalg af international på delt bad)`
              );
            }
          }
        }

        const cMsgs = clusterConflicts.get(baseId);
        if (cMsgs && cMsgs.length > 0) {
          topWarnings.push(
            `Konflikt på delt bad (<strong>Værelse ${escapeHtml(clusterLabel)}</strong>): ${cMsgs.map(escapeHtml).join(" · ")}.`
          );
        }
      }
    });

    return { roomConflicts, clusterConflicts, conflictingStudentKeys, topWarnings };
  }

  // Byg samlet historik fra alle tidligere perioder (0 .. activeIndex - 1)
  function buildMultiPeriodHistory(state, activePeriodIndex, roomByLower, mE) {
    const priorPeriods = state.periods.slice(0, activePeriodIndex);
    const knownIds = new Set();
    const knownNames = new Set();

    const prevById = new Map();
    const prevByName = new Map();

    const allHistoryById = new Map();
    const allHistoryByName = new Map();

    function getOrCreateTotalHistory(map, key) {
      if (!map.has(key)) {
        map.set(key, {
          rooms: new Set(),
          floors: new Set(),
          roomTypes: new Set(),
          roomies: new Set()
        });
      }
      return map.get(key);
    }

    priorPeriods.forEach((period, pIdx) => {
      const isImmediatePrev = pIdx === priorPeriods.length - 1;
      const studentLookup = new Map();
      const studentByName = new Map();

      (period.eleverRows || []).forEach((raw, rIdx) => {
        const idObj = extractStudentIdentity(raw, mE);
        if (!idObj.name) return;
        const key = idObj.extId || `row_${rIdx}_${idObj.name}`;
        if (idObj.extIdLower) knownIds.add(idObj.extIdLower);
        if (idObj.nameLower) knownNames.add(idObj.nameLower);
        studentLookup.set(key, idObj);
        studentByName.set(idObj.nameLower, idObj);
      });

      const roomOccupants = new Map();
      Object.entries(period.assignments || {}).forEach(([roomId, entries]) => {
        const rObj = roomByLower.get(roomId.toLowerCase());
        const rType = rObj ? rObj.roomType.toLowerCase() : "";
        const floor = rObj ? rObj.floor : getFloorFromRoomId(roomId);
        const occList = [];

        (entries || []).forEach(entry => {
          let st = studentLookup.get(entry.studentKey);
          if (!st && typeof entry.studentKey === "string") {
            const fallbackName = normalizeSpaces(entry.studentKey.replace(/^row_\d+_/, ""));
            st = studentByName.get(fallbackName);
          }
          if (!st) return;
          occList.push({
            roomLower: roomId.toLowerCase(),
            floor,
            roomTypeLower: rType,
            extIdLower: st.extIdLower,
            nameLower: st.nameLower
          });
        });

        if (occList.length > 0) roomOccupants.set(roomId.toLowerCase(), occList);
      });

      roomOccupants.forEach(occList => {
        occList.forEach(person => {
          const roomies = occList
            .filter(other => other !== person)
            .flatMap(other => [other.nameLower, other.extIdLower].filter(Boolean));

          [
            person.extIdLower ? getOrCreateTotalHistory(allHistoryById, person.extIdLower) : null,
            person.nameLower ? getOrCreateTotalHistory(allHistoryByName, person.nameLower) : null
          ]
            .filter(Boolean)
            .forEach(rec => {
              if (person.roomLower) rec.rooms.add(person.roomLower);
              if (person.floor) rec.floors.add(person.floor);
              if (person.roomTypeLower) rec.roomTypes.add(person.roomTypeLower);
              roomies.forEach(rm => rec.roomies.add(rm));
            });

          if (isImmediatePrev) {
            const record = {
              prevRoom: person.roomLower,
              prevFloor: person.floor,
              prevRoomType: person.roomTypeLower,
              prevRoomies: roomies
            };
            if (person.extIdLower) prevById.set(person.extIdLower, record);
            if (person.nameLower) prevByName.set(person.nameLower, record);
          }
        });
      });
    });

    return {
      hasPriorPeriods: priorPeriods.length > 0,
      hasPriorHistory: allHistoryById.size > 0 || allHistoryByName.size > 0,
      knownIds,
      knownNames,
      prevById,
      prevByName,
      allHistoryById,
      allHistoryByName
    };
  }

  // 3. Klargør normaliserede modeller for den aktive periode
  function buildModels() {
    const state = getState();
    const activePeriod = getActivePeriod();
    const activePeriodIndex = state.periods.findIndex(p => p.id === activePeriod.id);
    const mE = state.mapping.elever;
    const mV = state.mapping.vaerelser;

    const rooms = (state.cachedData.vaerelserRows || [])
      .map((raw, idx) => {
        const roomId = String(raw[mV.roomId] || "").trim();
        const capacity = parseInt(raw[mV.capacity], 10);
        const activeVal = mV.active ? raw[mV.active] : "";
        const isActive = !isFalsy(activeVal);

        if (!roomId || isNaN(capacity) || capacity <= 0 || !isActive) return null;

        return {
          roomId,
          baseId: getBaseRoomId(roomId),
          floor: getFloorFromRoomId(roomId),
          capacity,
          roomType: mV.roomType ? (raw[mV.roomType] || "").trim() : "",
          priority: mV.priority ? parsePriority(raw[mV.priority]) : 2,
          fixedGender: mV.gender ? normalizeGender(raw[mV.gender]) : "Fri",
          index: idx
        };
      })
      .filter(Boolean);

    const roomByLower = new Map(rooms.map(r => [r.roomId.toLowerCase(), r]));
    const history = buildMultiPeriodHistory(state, activePeriodIndex, roomByLower, mE);

    let returningCount = 0;
    let newStudentsCount = 0;

    const students = (activePeriod.eleverRows || [])
      .map((raw, idx) => {
        const idObj = extractStudentIdentity(raw, mE);
        if (!idObj.name) return null;

        const studentKey = idObj.extId || `row_${idx}_${idObj.name}`;

        let international = false;
        let countryName = "";
        if (mE.country && raw[mE.country]) {
          countryName = String(raw[mE.country]).trim();
          const country = countryName.toLowerCase();
          international = country !== "" && !["dk", "danmark", "denmark"].includes(country);
        }

        const histRecord = history.hasPriorPeriods
          ? (idObj.extIdLower && history.prevById.get(idObj.extIdLower)) ||
            history.prevByName.get(idObj.nameLower) ||
            null
          : null;

        const totalHist = history.hasPriorPeriods
          ? (idObj.extIdLower && history.allHistoryById.get(idObj.extIdLower)) ||
            history.allHistoryByName.get(idObj.nameLower) ||
            null
          : null;

        const allPrevRooms = totalHist ? [...totalHist.rooms] : [];
        const allPrevFloors = totalHist ? [...totalHist.floors] : [];
        const allPrevRoomTypes = totalHist ? [...totalHist.roomTypes] : [];
        const allPrevRoomies = totalHist ? [...totalHist.roomies] : [];

        const immediateSet = new Set(histRecord ? histRecord.prevRoomies : []);
        const olderRoomies = allPrevRoomies.filter(r => !immediateSet.has(r));

        const existedBefore =
          history.hasPriorPeriods &&
          Boolean(
            totalHist ||
              histRecord ||
              (idObj.extIdLower && history.knownIds.has(idObj.extIdLower)) ||
              history.knownNames.has(idObj.nameLower)
          );

        let isNew = false;
        if (mE.isNew && raw[mE.isNew] !== undefined && String(raw[mE.isNew]).trim() !== "") {
          isNew = isTruthy(raw[mE.isNew]);
        } else if (history.hasPriorPeriods && (history.knownIds.size > 0 || history.knownNames.size > 0)) {
          isNew = !existedBefore;
        }

        if (history.hasPriorPeriods) {
          if (isNew) newStudentsCount++;
          else returningCount++;
        }

        return {
          key: studentKey,
          extId: idObj.extIdLower,
          name: idObj.name,
          nameLower: idObj.nameLower,
          gender: mE.gender ? normalizeGender(raw[mE.gender]) : "Fri",
          lockedRoom: mE.lockedRoom ? String(raw[mE.lockedRoom] || "").trim() : "",
          countryName,
          international,
          optOutInternational: mE.optOutInternational ? isTruthy(raw[mE.optOutInternational]) : false,
          excludeWith: mE.excludeWith ? splitList(raw[mE.excludeWith]) : [],
          isNew,
          hasPriorPlacement: allPrevRooms.length > 0,
          prevRoom: histRecord ? histRecord.prevRoom : "",
          prevFloor: histRecord ? histRecord.prevFloor : "",
          prevRoomType: histRecord ? histRecord.prevRoomType : "",
          prevRoomies: histRecord ? histRecord.prevRoomies : [],
          olderRoomies,
          allPrevRooms,
          allPrevFloors,
          allPrevRoomTypes,
          allPrevRoomies
        };
      })
      .filter(Boolean);

    let stoppedCount = 0;
    if (history.hasPriorPeriods) {
      const currentIds = new Set(students.map(s => s.extId).filter(Boolean));
      const currentNames = new Set(students.map(s => s.nameLower));
      const totalPrev = history.knownIds.size > 0 ? history.knownIds.size : history.knownNames.size;
      let stillHere = 0;

      if (history.knownIds.size > 0) {
        history.knownIds.forEach(id => {
          if (currentIds.has(id)) stillHere++;
        });
      } else {
        history.knownNames.forEach(n => {
          if (currentNames.has(n)) stillHere++;
        });
      }
      stoppedCount = Math.max(0, totalPrev - stillHere);
    }

    return {
      rooms,
      students,
      activePeriod,
      meta: {
        isSubsequentPeriod: history.hasPriorPeriods,
        hasPriorHistory: history.hasPriorHistory,
        returningCount,
        newStudentsCount,
        stoppedCount
      }
    };
  }

  // Hjælpere til manuel flytning, fjernelse og tildeling på den aktive periode
  function assignStudentToRoom(studentKey, targetRoomId, lockAfterMove = true) {
    const activePeriod = getActivePeriod();
    const assignments = activePeriod.assignments || {};

    for (const rId of Object.keys(assignments)) {
      assignments[rId] = (assignments[rId] || []).filter(entry => entry.studentKey !== studentKey);
    }

    if (targetRoomId) {
      if (!assignments[targetRoomId]) assignments[targetRoomId] = [];
      assignments[targetRoomId].push({ studentKey, locked: lockAfterMove });
    }

    activePeriod.assignments = assignments;
    saveState();
    renderAll();
  }

  function removeStudentFromRoom(roomId, studentKey) {
    const activePeriod = getActivePeriod();
    const assignments = activePeriod.assignments || {};
    if (!assignments[roomId]) return;

    assignments[roomId] = assignments[roomId].filter(entry => entry.studentKey !== studentKey);
    saveState();
    renderAll();
  }

  function getUnplacedStudents(students, assignments) {
    const placedSet = new Set();
    Object.values(assignments).forEach(list => {
      (list || []).forEach(entry => placedSet.add(entry.studentKey));
    });
    return students.filter(s => !placedSet.has(s.key));
  }

  // 4. Hent data fra Google Sheets for fælles værelsesliste + aktiv periode
  async function fetchSheetsData() {
    const state = getState();
    const activePeriod = getActivePeriod();
    const statusEl = document.getElementById("status-bar");

    if (!state.urlVaerelser || !activePeriod.urlElever) {
      statusEl.innerHTML = `⚠️ Indtast link til både <strong>Fælles Værelsesliste</strong> og <strong>Elevliste for "${escapeHtml(activePeriod.name)}"</strong> under Indstillinger.`;
      document.getElementById("settings-panel").classList.remove("hidden");
      return;
    }

    statusEl.innerHTML = `⏳ Henter data for <strong>${escapeHtml(activePeriod.name)}</strong> fra Google Sheets...`;

    try {
      const [resV, resE] = await Promise.all([
        fetch(state.urlVaerelser, { cache: "no-store" }),
        fetch(activePeriod.urlElever, { cache: "no-store" })
      ]);

      if (!resV.ok || !resE.ok) {
        throw new Error(`HTTP-fejl ved hentning (Værelser: ${resV.status}, Elever: ${resE.status}). Tjek at arkene er udgivet på nettet som CSV.`);
      }

      const [txtV, txtE] = await Promise.all([resV.text(), resE.text()]);
      const parsedV = parseCSV(txtV);
      const parsedE = parseCSV(txtE);

      const hadExistingAssignments = Object.values(activePeriod.assignments || {}).some(
        list => list && list.length > 0
      );

      state.cachedData.vaerelserRows = parsedV.rows;
      activePeriod.eleverRows = parsedE.rows;

      autoMapHeaders(parsedE.headers, parsedV.headers);
      renderSettingsUI();

      const mE = state.mapping.elever;
      const mV = state.mapping.vaerelser;
      const missingCore = (!mE.name && !mE.firstName) || !mE.gender || !mV.roomId || !mV.capacity;

      if (missingCore) {
        document.getElementById("settings-panel").classList.remove("hidden");
        statusEl.innerHTML = `⚠️ Data hentet, men vælg venligst de manglende kolonner under <strong>Indstillinger &amp; Kolonner</strong>.`;
        syncAssignmentsWithModels(true);
        return;
      }

      const syncSummary = syncAssignmentsWithModels(true);
      const { meta } = buildModels();

      if (hadExistingAssignments && syncSummary.preservedCount > 0) {
        const unplacedText =
          syncSummary.unplacedCount > 0
            ? `, <strong>${syncSummary.unplacedCount}</strong> uden værelse`
            : "";
        statusEl.innerHTML = `✅ Data opdateret for <strong>${escapeHtml(activePeriod.name)}</strong>! Eksisterende fordeling er bevaret (<strong>${syncSummary.placedCount}</strong> placeret${unplacedText}).`;
      } else if (meta.isSubsequentPeriod) {
        statusEl.innerHTML = `✅ <strong>${escapeHtml(activePeriod.name)}:</strong> ${meta.returningCount} fortsættende elever, <strong>${meta.newStudentsCount}</strong> nye elever${meta.stoppedCount > 0 ? `, ${meta.stoppedCount} stoppede frasorteret` : ""}.`;
      } else {
        statusEl.innerHTML = `✅ <strong>${escapeHtml(activePeriod.name)}:</strong> Indlæst <strong>${activePeriod.eleverRows.length}</strong> elever og <strong>${state.cachedData.vaerelserRows.length}</strong> værelser.`;
      }
    } catch (err) {
      statusEl.innerHTML = `❌ <strong>Fejl:</strong> ${escapeHtml(err.message)}`;
      console.error(err);
    }
  }

  // Synkronisér placeringer med opdaterede arkdata og bevar eksisterende fordeling
  function syncAssignmentsWithModels(preserveExisting = true) {
    const { rooms, students, activePeriod } = buildModels();
    const prevAssignments = activePeriod.assignments || {};

    const nextAssignments = {};
    const warnings = [];
    const placedKeys = new Set();

    rooms.forEach(r => (nextAssignments[r.roomId] = []));
    const roomByLower = new Map(rooms.map(r => [r.roomId.toLowerCase(), r]));
    const studentMap = new Map(students.map(s => [s.key, s]));
    const studentByName = new Map(students.map(s => [s.nameLower, s]));

    // 1. Forhåndslåste værelser fra elev-arkets kolonne (f.eks. kolonne E) har altid højeste prioritet
    students.forEach(s => {
      if (!s.lockedRoom) return;
      const target = roomByLower.get(s.lockedRoom.toLowerCase());
      if (!target) {
        warnings.push(`Låst værelse "${escapeHtml(s.lockedRoom)}" for <strong>${escapeHtml(s.name)}</strong> findes ikke i værelsesarket.`);
        return;
      }
      nextAssignments[target.roomId].push({ studentKey: s.key, locked: true });
      placedKeys.add(s.key);
    });

    // 2. Bevar eksisterende placeringer fra nuværende fordeling
    let preservedCount = 0;
    const removedRoomStudents = [];

    if (preserveExisting) {
      Object.entries(prevAssignments).forEach(([oldRoomId, entries]) => {
        const targetRoom = roomByLower.get(oldRoomId.toLowerCase());

        (entries || []).forEach(entry => {
          if (!entry || !entry.studentKey) return;

          let student = studentMap.get(entry.studentKey);
          if (!student && typeof entry.studentKey === "string" && entry.studentKey.startsWith("row_")) {
            const fallbackName = normalizeSpaces(entry.studentKey.replace(/^row_\d+_/, ""));
            student = studentByName.get(fallbackName);
          }

          if (!student || placedKeys.has(student.key)) return;

          if (!targetRoom) {
            removedRoomStudents.push(student.name);
            return;
          }

          nextAssignments[targetRoom.roomId].push({
            studentKey: student.key,
            locked: !!entry.locked
          });
          placedKeys.add(student.key);
          preservedCount++;
        });
      });
    }

    if (removedRoomStudents.length > 0) {
      warnings.push(
        `Værelset for <strong>${removedRoomStudents.map(escapeHtml).join(", ")}</strong> er nu lukket/fjernet i værelsesarket, så eleven er flyttet til "Elever uden værelse".`
      );
    }

    activePeriod.assignments = nextAssignments;
    saveState();
    renderAll(warnings);

    return {
      placedCount: placedKeys.size,
      preservedCount,
      unplacedCount: Math.max(0, students.length - placedKeys.size)
    };
  }

  // 5. Tilfældig fordelingsalgoritme for den aktive periode
  function allocateRemainingRandomly() {
    const { rooms, students, activePeriod } = buildModels();
    const state = getState();
    const rules = state.rules;
    const warnings = [];

    if (rooms.length === 0 || students.length === 0) {
      document.getElementById("status-bar").innerHTML = "⚠️ Mangler værelser eller elever. Tjek kolonne-mapping i indstillinger.";
      return;
    }

    const clusterMap = new Map();
    rooms.forEach(r => {
      if (!clusterMap.has(r.baseId)) clusterMap.set(r.baseId, []);
      clusterMap.get(r.baseId).push(r);
    });

    const currentAssignments = activePeriod.assignments || {};
    const studentMap = new Map(students.map(s => [s.key, s]));
    const lockedByRoom = {};
    const lockedKeys = new Set();

    rooms.forEach(r => {
      lockedByRoom[r.roomId] = [];
      (currentAssignments[r.roomId] || []).forEach(entry => {
        if (entry.locked && studentMap.has(entry.studentKey)) {
          lockedByRoom[r.roomId].push(studentMap.get(entry.studentKey));
          lockedKeys.add(entry.studentKey);
        }
      });
    });

    const lockedStudents = students.filter(s => lockedKeys.has(s.key));
    const unlockedStudents = students.filter(s => !lockedKeys.has(s.key));

    function canPlaceInRoom(student, room, currentRooms, ignoreStudentKey = null) {
      const occupants = currentRooms[room.roomId].filter(s => s.key !== ignoreStudentKey);
      if (occupants.length >= room.capacity) return false;

      const clusterRooms = clusterMap.get(room.baseId) || [room];
      const clusterOccupants = clusterRooms.flatMap(r =>
        currentRooms[r.roomId].filter(s => s.key !== ignoreStudentKey)
      );

      let requiredGender = room.fixedGender !== "Fri" ? room.fixedGender : "Fri";
      for (const cr of clusterRooms) {
        if (cr.fixedGender !== "Fri") requiredGender = cr.fixedGender;
      }
      for (const occ of clusterOccupants) {
        if (occ.gender !== "Fri") {
          requiredGender = occ.gender;
          break;
        }
      }

      if (requiredGender !== "Fri" && student.gender !== "Fri" && requiredGender !== student.gender) {
        return false;
      }

      const checkExcludePool = rules.abStrictExclude ? clusterOccupants : occupants;
      if (checkExcludePool.some(occ => hasStudentConflict(student, occ))) return false;

      const checkInternatPool = rules.abStrictInternat ? clusterOccupants : occupants;
      if (checkInternatPool.some(occ => hasInternatConflict(student, occ))) return false;

      return true;
    }

    function evaluateWholeAllocation(currentRooms, unplacedCount) {
      let totalScore = -unplacedCount * 100000;
      let lonelyMultiRooms = 0;

      for (const room of rooms) {
        const occs = currentRooms[room.roomId];
        const count = occs.length;
        if (count === 0) continue;

        const prio = Number.isFinite(room.priority) ? room.priority : 2;
        totalScore -= prio * 200 * count;

        if (room.capacity > 1 && count === 1) {
          lonelyMultiRooms++;
          totalScore -= 5000;
        }

        const intlCount = occs.filter(o => o.international).length;
        if (intlCount > 1) {
          totalScore -= 400 * (intlCount - 1);
        }

        const newCount = occs.filter(o => o.isNew).length;
        if (rules.avoidTwoNew && newCount > 1) {
          totalScore -= 600 * (newCount - 1);
        }

        for (let i = 0; i < count; i++) {
          const s1 = occs[i];
          const rLower = room.roomId.toLowerCase();
          if (s1.prevRoom && rLower === s1.prevRoom) {
            totalScore -= 60;
          } else if (s1.allPrevRooms.includes(rLower)) {
            totalScore -= 35;
          }

          if (room.floor) {
            if (s1.prevFloor && room.floor === s1.prevFloor) {
              totalScore -= 30;
            } else if (s1.allPrevFloors.includes(room.floor)) {
              totalScore -= 15;
            }
          }

          if (room.roomType) {
            const rtLower = room.roomType.toLowerCase();
            if (s1.prevRoomType && rtLower === s1.prevRoomType) {
              totalScore -= 25;
            } else if (s1.allPrevRoomTypes.includes(rtLower)) {
              totalScore -= 12;
            }
          }

          for (let j = i + 1; j < count; j++) {
            const s2 = occs[j];
            const hadImmediatePrev =
              s1.prevRoomies.includes(s2.nameLower) ||
              (s2.extId && s1.prevRoomies.includes(s2.extId)) ||
              s2.prevRoomies.includes(s1.nameLower) ||
              (s1.extId && s2.prevRoomies.includes(s1.extId));

            if (hadImmediatePrev) {
              totalScore -= 85;
            } else {
              const hadOlder =
                s1.olderRoomies.includes(s2.nameLower) ||
                (s2.extId && s1.olderRoomies.includes(s2.extId)) ||
                s2.olderRoomies.includes(s1.nameLower) ||
                (s1.extId && s2.olderRoomies.includes(s1.extId));
              if (hadOlder) totalScore -= 45;
            }
          }
        }
      }

      for (const clusterRooms of clusterMap.values()) {
        if (clusterRooms.length > 1) {
          const occupiedRoomsInCluster = clusterRooms.filter(r => currentRooms[r.roomId].length > 0).length;
          if (occupiedRoomsInCluster > 0 && occupiedRoomsInCluster < clusterRooms.length) {
            totalScore -= 120;
          }
        }
      }

      return { totalScore, lonelyMultiRooms };
    }

    function optimizeBySwapping(currentRooms, unplacedCount) {
      let { totalScore } = evaluateWholeAllocation(currentRooms, unplacedCount);

      for (let step = 0; step < 150; step++) {
        const populatedRooms = rooms.filter(r => currentRooms[r.roomId].some(s => !lockedKeys.has(s.key)));
        if (populatedRooms.length < 2) break;

        const r1 = populatedRooms[Math.floor(Math.random() * populatedRooms.length)];
        const r2 = populatedRooms[Math.floor(Math.random() * populatedRooms.length)];
        if (r1.roomId === r2.roomId) continue;

        const unlocked1 = currentRooms[r1.roomId].filter(s => !lockedKeys.has(s.key));
        const unlocked2 = currentRooms[r2.roomId].filter(s => !lockedKeys.has(s.key));
        if (unlocked1.length === 0 || unlocked2.length === 0) continue;

        const s1 = unlocked1[Math.floor(Math.random() * unlocked1.length)];
        const s2 = unlocked2[Math.floor(Math.random() * unlocked2.length)];

        if (!canPlaceInRoom(s1, r2, currentRooms, s2.key)) continue;
        if (!canPlaceInRoom(s2, r1, currentRooms, s1.key)) continue;

        const idx1 = currentRooms[r1.roomId].findIndex(s => s.key === s1.key);
        const idx2 = currentRooms[r2.roomId].findIndex(s => s.key === s2.key);
        currentRooms[r1.roomId][idx1] = s2;
        currentRooms[r2.roomId][idx2] = s1;

        const nextEval = evaluateWholeAllocation(currentRooms, unplacedCount);
        if (nextEval.totalScore > totalScore) {
          totalScore = nextEval.totalScore;
        } else {
          currentRooms[r1.roomId][idx1] = s1;
          currentRooms[r2.roomId][idx2] = s2;
        }
      }
    }

    let bestSolution = null;
    let bestGlobalScore = -Infinity;
    const ITERATIONS = 200;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const currentRooms = {};
      rooms.forEach(r => {
        currentRooms[r.roomId] = [...lockedByRoom[r.roomId]];
      });

      const mode = iter % 4;
      const prioWeight = mode === 0 ? 220 : mode === 3 ? 30 : 60;
      const noiseRange = mode === 3 ? 55 : 20;

      const shuffled = [...unlockedStudents]
        .map(s => ({ s, rand: Math.random() }))
        .sort((a, b) => {
          const weightA =
            (a.s.gender === "Ikke-binær" ? 10 : 0) +
            a.s.excludeWith.length * 3 +
            (a.s.optOutInternational ? 2 : 0) +
            a.rand;
          const weightB =
            (b.s.gender === "Ikke-binær" ? 10 : 0) +
            b.s.excludeWith.length * 3 +
            (b.s.optOutInternational ? 2 : 0) +
            b.rand;
          return weightB - weightA;
        })
        .map(item => item.s);

      const unplaced = [];

      for (const student of shuffled) {
        let bestRoom = null;
        let highestStepScore = -Infinity;

        for (const room of rooms) {
          if (!canPlaceInRoom(student, room, currentRooms)) continue;

          const occupants = currentRooms[room.roomId];
          const clusterRooms = clusterMap.get(room.baseId) || [room];
          const clusterOccupants = clusterRooms.flatMap(r => currentRooms[r.roomId]);

          const prio = Number.isFinite(room.priority) ? room.priority : 2;
          let stepScore = Math.random() * noiseRange - prio * prioWeight;

          if (room.capacity > 1 && occupants.length === 1) {
            stepScore += 140;
          } else if (occupants.length > 0) {
            stepScore += 45;
          } else if (clusterOccupants.length > 0) {
            stepScore += 65;
          }

          if (mode === 1 && room.capacity === 2) stepScore += 85;
          if (mode === 2 && room.capacity >= 3) stepScore += 85;

          if (student.international) {
            const intlInRoom = occupants.filter(occ => occ.international).length;
            if (intlInRoom > 0) {
              stepScore -= 250 * intlInRoom;
            }
          }

          if (rules.avoidTwoNew && student.isNew) {
            const newInRoom = occupants.filter(occ => occ.isNew).length;
            if (newInRoom > 0) {
              stepScore -= 350 * newInRoom;
            }
            const newInCluster = clusterOccupants.filter(occ => occ.isNew).length;
            if (newInCluster > 0) {
              stepScore -= 25 * newInCluster;
            }
          }

          const rLower = room.roomId.toLowerCase();
          if (student.prevRoom && rLower === student.prevRoom) stepScore -= 60;
          else if (student.allPrevRooms.includes(rLower)) stepScore -= 35;

          if (room.floor) {
            if (student.prevFloor && room.floor === student.prevFloor) stepScore -= 30;
            else if (student.allPrevFloors.includes(room.floor)) stepScore -= 15;
          }

          if (room.roomType) {
            const rtLower = room.roomType.toLowerCase();
            if (student.prevRoomType && rtLower === student.prevRoomType) stepScore -= 25;
            else if (student.allPrevRoomTypes.includes(rtLower)) stepScore -= 12;
          }

          const sharedImmediatePrev = occupants.some(occ =>
            student.prevRoomies.includes(occ.nameLower) || (occ.extId && student.prevRoomies.includes(occ.extId))
          );
          if (sharedImmediatePrev) {
            stepScore -= 85;
          } else {
            const sharedOlder = occupants.some(occ =>
              student.olderRoomies.includes(occ.nameLower) || (occ.extId && student.olderRoomies.includes(occ.extId))
            );
            if (sharedOlder) stepScore -= 45;
          }

          if (stepScore > highestStepScore) {
            highestStepScore = stepScore;
            bestRoom = room;
          }
        }

        if (bestRoom) {
          currentRooms[bestRoom.roomId].push(student);
        } else {
          unplaced.push(student);
        }
      }

      optimizeBySwapping(currentRooms, unplaced.length);

      const { totalScore, lonelyMultiRooms } = evaluateWholeAllocation(currentRooms, unplaced.length);
      if (totalScore > bestGlobalScore) {
        bestGlobalScore = totalScore;
        bestSolution = { currentRooms, unplaced, lonelyMultiRooms };
      }
    }

    const finalAssignments = {};
    rooms.forEach(r => {
      finalAssignments[r.roomId] = (bestSolution.currentRooms[r.roomId] || []).map(s => ({
        studentKey: s.key,
        locked: lockedKeys.has(s.key)
      }));
    });

    if (bestSolution.unplaced.length > 0) {
      const names = bestSolution.unplaced.map(s => `${escapeHtml(s.name)} (${escapeHtml(s.gender)})`).join(", ");
      warnings.push(`Kunne ikke placere <strong>${bestSolution.unplaced.length}</strong> elev(er) uden at bryde reglerne: ${names}.`);
    }

    activePeriod.assignments = finalAssignments;
    saveState();

    const lonelyNote =
      bestSolution.lonelyMultiRooms > 0
        ? ` · ⚠️ ${bestSolution.lonelyMultiRooms} flersengsværelse(r) med 1 person`
        : " · Ingen alene på flersengsværelser";

    document.getElementById("status-bar").innerHTML = `🎲 Fordeling gennemført for <strong>${escapeHtml(activePeriod.name)}</strong>! <strong>${lockedStudents.length}</strong> låste, <strong>${unlockedStudents.length - bestSolution.unplaced.length}</strong> fordelt tilfældigt${lonelyNote}.`;
    renderAll(warnings);
  }

  function clearUnlocked() {
    const activePeriod = getActivePeriod();
    const assignments = activePeriod.assignments || {};
    let clearedCount = 0;

    for (const roomId in assignments) {
      const before = assignments[roomId].length;
      assignments[roomId] = assignments[roomId].filter(entry => entry.locked);
      clearedCount += before - assignments[roomId].length;
    }

    saveState();
    renderAll();
    document.getElementById("status-bar").innerHTML = `🧹 Ryddede <strong>${clearedCount}</strong> ulåste elever i <strong>${escapeHtml(activePeriod.name)}</strong>. Låste elever blev på deres pladser.`;
  }

  // 6. Modaler (valg af elev på sengeplads + oprettelse af nyt værelsesskift)
  function openBedPicker(roomId) {
    activePickerRoomId = roomId;
    const modal = document.getElementById("bed-picker-modal");
    const searchInput = document.getElementById("picker-search");
    searchInput.value = "";
    modal.classList.remove("hidden");
    renderBedPickerList();
    setTimeout(() => searchInput.focus(), 20);
  }

  function closeBedPicker() {
    activePickerRoomId = null;
    document.getElementById("bed-picker-modal").classList.add("hidden");
  }

  function renderBedPickerList() {
    if (!activePickerRoomId) return;
    const { rooms, students, activePeriod } = buildModels();
    const assignments = activePeriod.assignments || {};
    const studentMap = new Map(students.map(s => [s.key, s]));
    const targetRoom = rooms.find(r => r.roomId === activePickerRoomId);
    if (!targetRoom) return;

    const assignedInRoom = (assignments[targetRoom.roomId] || [])
      .map(a => studentMap.get(a.studentKey))
      .filter(Boolean);

    const clusterRooms = rooms.filter(r => r.baseId === targetRoom.baseId);
    const clusterOccupants = clusterRooms.flatMap(r =>
      (assignments[r.roomId] || []).map(a => studentMap.get(a.studentKey)).filter(Boolean)
    );

    let roomGender = targetRoom.fixedGender !== "Fri" ? targetRoom.fixedGender : "Fri";
    for (const cr of clusterRooms) {
      if (cr.fixedGender !== "Fri") roomGender = cr.fixedGender;
    }
    for (const occ of clusterOccupants) {
      if (occ.gender !== "Fri") {
        roomGender = occ.gender;
        break;
      }
    }

    document.getElementById("picker-title").textContent = `Tildel elev til Værelse ${targetRoom.roomId}`;
    document.getElementById("picker-subtitle").textContent = `${assignedInRoom.length}/${targetRoom.capacity} pladser optaget · Køn: ${roomGender}`;

    const query = document.getElementById("picker-search").value.toLowerCase().trim();
    const unplaced = getUnplacedStudents(students, assignments).filter(s => {
      if (!query) return true;
      return (
        s.nameLower.includes(query) ||
        s.gender.toLowerCase().includes(query) ||
        (s.countryName && s.countryName.toLowerCase().includes(query))
      );
    });

    unplaced.sort((a, b) => {
      const aMatch = roomGender === "Fri" || a.gender === "Fri" || a.gender === roomGender ? 0 : 1;
      const bMatch = roomGender === "Fri" || b.gender === "Fri" || b.gender === roomGender ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return a.name.localeCompare(b.name, "da");
    });

    const listEl = document.getElementById("picker-list");
    if (unplaced.length === 0) {
      listEl.innerHTML = `<p class="hint" style="margin:0.5rem 0;">Ingen elever uden værelse matcher søgningen.</p>`;
      return;
    }

    listEl.innerHTML = unplaced
      .map(s => {
        const notes = [];
        if (roomGender !== "Fri" && s.gender !== "Fri" && s.gender !== roomGender) {
          notes.push(`Andet køn (${s.gender})`);
        }
        const hasClash = clusterOccupants.some(occ => hasStudentConflict(s, occ));
        if (hasClash) notes.push("Konflikt ('Ikke med')");
        const intlClash = clusterOccupants.some(occ => hasInternatConflict(s, occ));
        if (intlClash) notes.push("Fravalg af intl.");
        if (s.isNew && assignedInRoom.some(occ => occ.isNew)) {
          notes.push("Anden ny elev på værelset");
        }

        return `
          <button type="button" class="picker-item ${notes.length ? "has-warning" : ""}" data-pick-key="${escapeHtml(s.key)}">
            <div>
              <strong>${escapeHtml(s.name)}</strong>
              <div class="room-meta">${escapeHtml(s.gender)}${s.countryName ? ` · ${escapeHtml(s.countryName)}` : ""}${notes.length ? ` · ⚠️ ${escapeHtml(notes.join(", "))}` : ""}</div>
            </div>
            <span class="badges">
              ${s.international ? `<span class="badge badge-intl">🌍</span>` : ""}
              ${s.isNew ? `<span class="badge badge-new">✨ Ny</span>` : ""}
              <span class="badge badge-locked">+ Vælg</span>
            </span>
          </button>
        `;
      })
      .join("");
  }

  function openNewPeriodModal() {
    const state = getState();
    const activePeriod = getActivePeriod();
    const nextNum = state.periods.length;
    document.getElementById("new-period-name").value = `Værelsesskift ${nextNum}`;
    document.getElementById("new-period-elever-url").value = activePeriod.urlElever || "";
    document.getElementById("new-period-modal").classList.remove("hidden");
    setTimeout(() => document.getElementById("new-period-name").focus(), 20);
  }

  function closeNewPeriodModal() {
    document.getElementById("new-period-modal").classList.add("hidden");
  }

  // 7. Rendering af periode-faner, optælling, værelsesskift-status, pulje uden værelse, værelseskort og tabel
  function renderPeriodsBar() {
    const state = getState();
    const bar = document.getElementById("periods-bar");
    if (!bar) return;

    const tabsHtml = state.periods
      .map(p => {
        const isActive = p.id === state.activePeriodId;
        const placedCount = Object.values(p.assignments || {}).reduce((sum, list) => sum + (list ? list.length : 0), 0);
        const totalInPeriod = (p.eleverRows || []).length;
        const badgeText = totalInPeriod > 0 ? `${placedCount}/${totalInPeriod}` : "Ny";

        return `
          <button type="button" class="period-tab ${isActive ? "active" : ""}" data-switch-period="${escapeHtml(p.id)}">
            <span>${escapeHtml(p.name)}</span>
            <span class="tab-count">${badgeText}</span>
          </button>
        `;
      })
      .join("");

    bar.innerHTML = `
      ${tabsHtml}
      <button type="button" id="btn-open-new-period" class="period-add-btn">+ Nyt værelsesskift</button>
    `;
  }

  function renderShiftStatus(rooms, students, assignments, studentMap, meta, activePeriod) {
    const panel = document.getElementById("shift-status-panel");
    if (!panel) return;

    if (!meta.isSubsequentPeriod) {
      panel.classList.add("hidden");
      panel.innerHTML = "";
      return;
    }

    panel.classList.remove("hidden");

    let evaluatedCount = 0;
    let newRoomiesCount = 0;
    let newRoomCount = 0;

    let floorComparableCount = 0;
    let newFloorCount = 0;

    let typeComparableCount = 0;
    let newTypeCount = 0;

    let placedNewCount = 0;
    let separatedNewCount = 0;

    const deviations = [];

    rooms.forEach(room => {
      const assignedEntries = (assignments[room.roomId] || []).filter(e => studentMap.has(e.studentKey));
      const roomOccupants = assignedEntries.map(e => studentMap.get(e.studentKey));

      roomOccupants.forEach(s => {
        if (s.isNew) {
          placedNewCount++;
          const otherNew = roomOccupants.filter(other => other.key !== s.key && other.isNew);
          if (otherNew.length === 0) {
            separatedNewCount++;
          } else {
            deviations.push({
              name: s.name,
              roomId: room.roomId,
              reasons: [`Ny elev sammen med ny elev (${otherNew.map(o => o.name).join(", ")})`]
            });
          }
        }

        if (!s.hasPriorPlacement) return;
        evaluatedCount++;

        const reasons = [];

        const repeatedRoomies = roomOccupants
          .filter(other => other.key !== s.key)
          .filter(
            other =>
              s.allPrevRoomies.includes(other.nameLower) ||
              (other.extId && s.allPrevRoomies.includes(other.extId))
          )
          .map(other => other.name);

        if (repeatedRoomies.length === 0) {
          newRoomiesCount++;
        } else {
          reasons.push(`Tidligere roomie (${repeatedRoomies.join(", ")})`);
        }

        if (room.floor && s.allPrevFloors.length > 0) {
          floorComparableCount++;
          if (!s.allPrevFloors.includes(room.floor)) {
            newFloorCount++;
          } else {
            reasons.push(`Samme etage (Etage ${room.floor})`);
          }
        }

        if (room.roomType && s.allPrevRoomTypes.length > 0) {
          typeComparableCount++;
          if (!s.allPrevRoomTypes.includes(room.roomType.toLowerCase())) {
            newTypeCount++;
          } else {
            reasons.push(`Samme værelsestype (${room.roomType})`);
          }
        }

        if (!s.allPrevRooms.includes(room.roomId.toLowerCase())) {
          newRoomCount++;
        } else {
          reasons.push(`Samme værelse (${room.roomId})`);
        }

        if (reasons.length > 0) {
          deviations.push({
            name: s.name,
            roomId: room.roomId,
            reasons
          });
        }
      });
    });

    if (evaluatedCount === 0 && placedNewCount === 0) {
      panel.innerHTML = `
        <div class="shift-status-header">
          <h2>🔄 Status på værelsesskift – ${escapeHtml(activePeriod.name)}</h2>
          <span class="room-meta">Afventer placering af elever</span>
        </div>
        <p class="hint" style="margin:0;">Klik på <strong>🎲 Fordel ulåste</strong> for at se, hvor mange der kommer på ny etage, ny værelsestype og med nye roomies.</p>
      `;
      return;
    }

    const buildMetricCard = (label, successCount, totalCount, subText, fallbackText) => {
      if (totalCount === 0) {
        return `
          <div class="shift-metric">
            <div class="shift-metric-top">
              <span class="shift-metric-label">${label}</span>
              <span class="shift-metric-pct">-</span>
            </div>
            <div class="shift-meter-bar"><div class="shift-meter-fill fill-mid" style="width:0%"></div></div>
            <div class="shift-metric-detail">${fallbackText}</div>
          </div>
        `;
      }
      const pct = Math.round((successCount / totalCount) * 100);
      const fillClass = pct >= 90 ? "fill-good" : pct >= 70 ? "fill-mid" : "fill-warn";
      return `
        <div class="shift-metric">
          <div class="shift-metric-top">
            <span class="shift-metric-label">${label}</span>
            <span class="shift-metric-pct">${pct}%</span>
          </div>
          <div class="shift-meter-bar"><div class="shift-meter-fill ${fillClass}" style="width:${pct}%"></div></div>
          <div class="shift-metric-detail">${subText}</div>
        </div>
      `;
    };

    const newSpreadCard =
      placedNewCount > 0
        ? buildMetricCard(
            "Nye elever spredt",
            separatedNewCount,
            placedNewCount,
            `${separatedNewCount} af ${placedNewCount} nye bor med erfarne`,
            ""
          )
        : "";

    const deviationsHtml =
      deviations.length === 0
        ? `<div class="shift-all-good">✓ Alle ${evaluatedCount} fortsættende elever har fået nye roomies, ny etage, ny værelsestype og nyt værelse${placedNewCount > 0 ? `, og alle ${placedNewCount} nye elever er spredt` : ""}.</div>`
        : `<details class="shift-deviations">
            <summary>⚠️ ${deviations.length} elev(er) har én eller flere gentagelser (klik for at se hvem)</summary>
            <ul>
              ${deviations
                .map(
                  d =>
                    `<li><strong>${escapeHtml(d.name)}</strong> (Værelse ${escapeHtml(d.roomId)}): ${escapeHtml(d.reasons.join(" · "))}</li>`
                )
                .join("")}
            </ul>
          </details>`;

    panel.innerHTML = `
      <div class="shift-status-header">
        <h2>🔄 Status på værelsesskift – ${escapeHtml(activePeriod.name)}</h2>
        <span class="room-meta">Sammenlignet med alle tidligere perioder (${evaluatedCount} fortsættende${placedNewCount > 0 ? ` · ${placedNewCount} nye` : ""})</span>
      </div>
      <div class="shift-metrics-grid">
        ${buildMetricCard("Nye roomies", newRoomiesCount, evaluatedCount, `${newRoomiesCount} af ${evaluatedCount} fortsættende elever`, "Ingen historik")}
        ${newSpreadCard}
        ${buildMetricCard("Ny etage", newFloorCount, floorComparableCount, `${newFloorCount} af ${floorComparableCount} fortsættende elever`, "Ingen etage i værelsesnr.")}
        ${buildMetricCard("Ny værelsestype", newTypeCount, typeComparableCount, `${newTypeCount} af ${typeComparableCount} fortsættende elever`, "Ingen værelsestype angivet")}
        ${buildMetricCard("Nyt værelse", newRoomCount, evaluatedCount, `${newRoomCount} af ${evaluatedCount} fortsættende elever`, "Ingen historik")}
      </div>
      ${deviationsHtml}
    `;
  }

  function renderAll(warnings = []) {
    renderPeriodsBar();

    const { rooms, students, activePeriod, meta } = buildModels();
    const state = getState();
    const assignments = activePeriod.assignments || {};
    const studentMap = new Map(students.map(s => [s.key, s]));

    // Tjek alle konflikter (Ikke med, fravalg af international, blandede køn)
    const {
      roomConflicts,
      clusterConflicts,
      conflictingStudentKeys,
      topWarnings
    } = analyzeRoomConflicts(rooms, assignments, studentMap, state.rules);

    const activeWarnings = [...topWarnings, ...warnings];

    const sectionTitleEl = document.getElementById("rooms-section-title");
    if (sectionTitleEl) {
      sectionTitleEl.textContent = `Værelsesoversigt – ${activePeriod.name}`;
    }

    const totalRooms = rooms.length;
    const totalBeds = rooms.reduce((sum, r) => sum + r.capacity, 0);
    let lockedCount = 0;
    let randomCount = 0;
    let freeBeds = 0;
    let overCapacityExcess = 0;

    rooms.forEach(room => {
      const assigned = (assignments[room.roomId] || []).filter(entry => studentMap.has(entry.studentKey));
      assigned.forEach(entry => {
        if (entry.locked) lockedCount++;
        else randomCount++;
      });

      if (assigned.length > room.capacity) {
        const extra = assigned.length - room.capacity;
        overCapacityExcess += extra;
        activeWarnings.unshift(
          `Værelse <strong>${escapeHtml(room.roomId)}</strong> har <strong>${assigned.length}</strong> elever på <strong>${room.capacity}</strong> sengepladser (<strong>${extra}</strong> for meget).`
        );
      } else {
        freeBeds += room.capacity - assigned.length;
      }
    });

    const occupiedBeds = lockedCount + randomCount;
    const unplacedStudents = getUnplacedStudents(students, assignments);
    const unplacedCount = unplacedStudents.length;

    if (students.length > totalBeds) {
      activeWarnings.unshift(
        `Der er <strong>${students.length}</strong> elever, men kun <strong>${totalBeds}</strong> aktive sengepladser (mangler <strong>${students.length - totalBeds}</strong> pladser).`
      );
    }

    const statsBar = document.getElementById("stats-bar");
    if (statsBar) {
      if (totalRooms === 0 && students.length === 0) {
        statsBar.innerHTML = "";
      } else {
        const capacityAlert = students.length > totalBeds || overCapacityExcess > 0;
        const allPlaced = students.length > 0 && unplacedCount === 0 && overCapacityExcess === 0;

        statsBar.innerHTML = `
          <div class="stat-card ${students.length > totalBeds ? "stat-danger" : ""}">
            <div class="stat-label">Sengepladser i alt</div>
            <div class="stat-value">${totalBeds}</div>
            <div class="stat-sub">Fordelt på ${totalRooms} aktive værelser</div>
          </div>
          <div class="stat-card ${overCapacityExcess > 0 ? "stat-danger" : ""}">
            <div class="stat-label">Optagede pladser</div>
            <div class="stat-value">${occupiedBeds}</div>
            <div class="stat-sub">🔒 ${lockedCount} låste · 🎲 ${randomCount} fordelt${overCapacityExcess > 0 ? ` · ⚠️ ${overCapacityExcess} overbelagt` : ""}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Ledige sengepladser</div>
            <div class="stat-value">${freeBeds}</div>
            <div class="stat-sub">${totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0}% belægning</div>
          </div>
          <div class="stat-card ${capacityAlert ? "stat-danger" : allPlaced ? "stat-success" : ""}">
            <div class="stat-label">Elever i ${escapeHtml(activePeriod.name)}</div>
            <div class="stat-value">${students.length}</div>
            <div class="stat-sub">${allPlaced ? "✓ Alle elever har fået plads" : `${unplacedCount} uden værelse`}</div>
          </div>
        `;
      }
    }

    renderShiftStatus(rooms, students, assignments, studentMap, meta, activePeriod);

    // Pulje med elever uden værelse
    const unplacedBadge = document.getElementById("unplaced-count-badge");
    const unplacedListEl = document.getElementById("unplaced-list");
    if (unplacedBadge && unplacedListEl) {
      unplacedBadge.textContent = unplacedCount;
      unplacedListEl.innerHTML = unplacedCount
        ? unplacedStudents
            .map(
              s => `
            <div class="unplaced-chip" draggable="true" data-student-key="${escapeHtml(s.key)}" data-from-room="">
              <span>${escapeHtml(s.name)}</span>
              <span class="badge">${escapeHtml(s.gender)}</span>
              ${s.international ? `<span class="badge badge-intl" title="International">🌍</span>` : ""}
              ${s.isNew ? `<span class="badge badge-new" title="Ny elev">✨ Ny</span>` : ""}
            </div>
          `
            )
            .join("")
        : `<span class="hint" style="margin:0;">Alle elever er placeret på et værelse.</span>`;
    }

    // Advarsler
    const warnBox = document.getElementById("warnings-box");
    if (activeWarnings.length > 0) {
      warnBox.classList.remove("hidden");
      warnBox.innerHTML = `<strong>Bemærk:</strong><ul>${activeWarnings.map(w => `<li>${w}</li>`).join("")}</ul>`;
    } else {
      warnBox.classList.add("hidden");
      warnBox.innerHTML = "";
    }

    const grid = document.getElementById("rooms-grid");
    if (rooms.length === 0) {
      grid.innerHTML = `<p class="hint">Ingen værelser indlæst endnu. Klik på "Hent data fra ark" eller tjek kolonne-mapping under Indstillinger.</p>`;
      document.getElementById("summary-table-container").innerHTML = "";
      return;
    }

    // Gruppér værelser på baseId
    const clusterOrder = [];
    const roomsByBase = new Map();
    rooms.forEach(room => {
      if (!roomsByBase.has(room.baseId)) {
        roomsByBase.set(room.baseId, []);
        clusterOrder.push(room.baseId);
      }
      roomsByBase.get(room.baseId).push(room);
    });

    // Find kønnet per bad-gruppe (A/B)
    const clusterGenderMap = {};
    rooms.forEach(room => {
      const assigned = assignments[room.roomId] || [];
      const occupants = assigned.map(a => studentMap.get(a.studentKey)).filter(Boolean);
      if (room.fixedGender !== "Fri") {
        clusterGenderMap[room.baseId] = room.fixedGender;
      } else if (!clusterGenderMap[room.baseId] && occupants[0]?.gender && occupants[0].gender !== "Fri") {
        clusterGenderMap[room.baseId] = occupants[0].gender;
      }
    });

    function getGenderBadgeClass(gender) {
      const g = gender.toLowerCase();
      if (g === "dreng") return "badge-dreng";
      if (g === "pige") return "badge-pige";
      if (["ikke-binær", "non-binær", "non-binary"].includes(g)) return "badge-nonbinaer";
      return "";
    }

    function renderRoomSlots(room, assigned) {
      const totalSlots = Math.max(room.capacity, assigned.length);
      const itemsHtml = [];

      for (let i = 0; i < totalSlots; i++) {
        const entry = assigned[i];
        const s = entry ? studentMap.get(entry.studentKey) : null;

        if (s) {
          const isConflictingStudent = conflictingStudentKeys.has(s.key);
          const lockBtn = entry.locked
            ? `<button type="button" class="badge badge-locked toggle-lock-btn" data-room="${escapeHtml(room.roomId)}" data-key="${escapeHtml(s.key)}" title="Låst – klik for at låse op">🔒</button>`
            : `<button type="button" class="badge badge-random toggle-lock-btn" data-room="${escapeHtml(room.roomId)}" data-key="${escapeHtml(s.key)}" title="Tilfældig – klik for at låse fast">🎲</button>`;

          itemsHtml.push(`
            <li class="student-item ${entry.locked ? "is-locked" : ""} ${isConflictingStudent ? "student-conflict" : ""}" draggable="true" data-student-key="${escapeHtml(s.key)}" data-from-room="${escapeHtml(room.roomId)}">
              <span>${escapeHtml(s.name)}</span>
              <span class="badges">
                ${isConflictingStudent ? `<span class="badge badge-conflict" title="Bør ikke bo her pga. konflikt">⚠️</span>` : ""}
                ${lockBtn}
                ${s.international ? `<span class="badge badge-intl" title="International">🌍</span>` : ""}
                ${s.isNew ? `<span class="badge badge-new" title="Ny elev">✨ Ny</span>` : ""}
                <button type="button" class="btn-icon remove-student-btn" data-room="${escapeHtml(room.roomId)}" data-key="${escapeHtml(s.key)}" title="Fjern fra værelse">✕</button>
              </span>
            </li>
          `);
        } else {
          itemsHtml.push(
            `<li class="student-item empty-bed" data-open-picker-room="${escapeHtml(room.roomId)}" title="Klik for at vælge en elev til denne seng">+ Ledig sengeplads</li>`
          );
        }
      }

      return `<ul class="student-list">${itemsHtml.join("")}</ul>`;
    }

    grid.innerHTML = clusterOrder
      .map(baseId => {
        const clusterRooms = roomsByBase.get(baseId);
        const activeGender = clusterGenderMap[baseId] || "Ledigt";
        const genderClass = getGenderBadgeClass(activeGender);

        if (clusterRooms.length === 1) {
          const room = clusterRooms[0];
          const assigned = (assignments[room.roomId] || []).filter(entry => studentMap.has(entry.studentKey));
          const isOverCapacity = assigned.length > room.capacity;
          const rConflicts = roomConflicts.get(room.roomId) || [];
          const hasConflict = rConflicts.length > 0;

          const overBanner = isOverCapacity
            ? `<div class="over-capacity-banner">⚠️ ${assigned.length - room.capacity} elev(er) for meget – flyt eller fjern en for at få det til at passe</div>`
            : "";

          const conflictBanner = hasConflict
            ? `<div class="conflict-banner">⚠️ Konflikt: ${rConflicts.map(escapeHtml).join(" · ")}</div>`
            : "";

          return `
            <div class="room-card drop-zone-room ${isOverCapacity ? "over-capacity" : ""} ${hasConflict ? "has-conflict" : ""}" data-drop-room="${escapeHtml(room.roomId)}">
              <div class="room-header">
                <div>
                  <div class="room-title">Værelse ${escapeHtml(room.roomId)}</div>
                  <div class="room-meta">${room.roomType ? escapeHtml(room.roomType) + " · " : ""}Eget bad${room.priority !== 2 ? ` · Prio ${room.priority}` : ""}</div>
                </div>
                <div class="room-header-badges">
                  <span class="badge ${genderClass}">${escapeHtml(activeGender)}</span>
                  ${hasConflict ? `<span class="badge badge-conflict">⚠️ Konflikt</span>` : ""}
                  ${isOverCapacity ? `<span class="badge badge-danger">⚠️ ${assigned.length}/${room.capacity} pladser</span>` : ""}
                </div>
              </div>
              ${overBanner}
              ${conflictBanner}
              ${renderRoomSlots(room, assigned)}
            </div>
          `;
        }

        const clusterTitle = `Værelse ${clusterRooms.map(r => escapeHtml(r.roomId)).join(" &amp; ")}`;
        const uniqueTypes = [...new Set(clusterRooms.map(r => r.roomType).filter(Boolean))];
        const uniquePrios = [...new Set(clusterRooms.map(r => r.priority).filter(p => p !== 2))];
        const metaParts = [];
        if (uniqueTypes.length) metaParts.push(escapeHtml(uniqueTypes.join(" / ")));
        metaParts.push("Delt bad &amp; toilet");
        if (uniquePrios.length) metaParts.push(`Prio ${uniquePrios.join("/")}`);

        const cConflicts = clusterConflicts.get(baseId) || [];
        const hasClusterConflict = cConflicts.length > 0;
        const clusterConflictBanner = hasClusterConflict
          ? `<div class="conflict-banner">⚠️ Konflikt på delt bad: ${cConflicts.map(escapeHtml).join(" · ")}</div>`
          : "";

        const columnsHtml = clusterRooms
          .map(room => {
            const assigned = (assignments[room.roomId] || []).filter(entry => studentMap.has(entry.studentKey));
            const isOverCapacity = assigned.length > room.capacity;
            const rConflicts = roomConflicts.get(room.roomId) || [];
            const hasRoomConflict = rConflicts.length > 0;

            const overBanner = isOverCapacity
              ? `<div class="over-capacity-banner">⚠️ ${assigned.length - room.capacity} for meget</div>`
              : "";

            const roomConflictBanner = hasRoomConflict
              ? `<div class="conflict-banner">⚠️ Konflikt: ${rConflicts.map(escapeHtml).join(" · ")}</div>`
              : "";

            return `
              <div class="cluster-room-col drop-zone-room ${isOverCapacity ? "over-capacity" : ""} ${hasRoomConflict ? "has-conflict" : ""}" data-drop-room="${escapeHtml(room.roomId)}">
                <div class="subroom-header">
                  <span class="subroom-title">Værelse ${escapeHtml(room.roomId)}</span>
                  <span class="badges">
                    ${hasRoomConflict ? `<span class="badge badge-conflict">⚠️ Konflikt</span>` : ""}
                    ${isOverCapacity ? `<span class="badge badge-danger">⚠️ ${assigned.length}/${room.capacity}</span>` : ""}
                  </span>
                </div>
                ${overBanner}
                ${roomConflictBanner}
                ${renderRoomSlots(room, assigned)}
              </div>
            `;
          })
          .join("");

        return `
          <div class="room-card shared-bath-cluster ${hasClusterConflict ? "has-conflict" : ""}">
            <div class="room-header">
              <div>
                <div class="room-title">${clusterTitle}</div>
                <div class="room-meta">${metaParts.join(" · ")}</div>
              </div>
              <div class="room-header-badges">
                <span class="badge ${genderClass}">${escapeHtml(activeGender)}</span>
                ${hasClusterConflict ? `<span class="badge badge-conflict">⚠️ Konflikt</span>` : ""}
              </div>
            </div>
            ${clusterConflictBanner}
            <div class="cluster-columns">${columnsHtml}</div>
          </div>
        `;
      })
      .join("");

    // Samlet tabel til oversigt & eksport
    const tableRows = [];
    rooms.forEach(room => {
      const assigned = (assignments[room.roomId] || []).filter(entry => studentMap.has(entry.studentKey));
      assigned.forEach(entry => {
        const s = studentMap.get(entry.studentKey);
        if (!s) return;
        const roomies = assigned
          .filter(other => other.studentKey !== entry.studentKey)
          .map(other => studentMap.get(other.studentKey)?.name)
          .filter(Boolean)
          .join(", ");

        tableRows.push(`
          <tr>
            <td><strong>${escapeHtml(room.roomId)}</strong></td>
            <td>${escapeHtml(room.roomType || "-")}</td>
            <td>${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.gender)}</td>
            <td>${s.international ? "Ja" : "Nej"}</td>
            <td>${entry.locked ? "Låst" : "Tilfældig"}</td>
            <td>${escapeHtml(roomies || "-")}</td>
          </tr>
        `);
      });
    });

    document.getElementById("summary-table-container").innerHTML = tableRows.length
      ? `<table>
          <thead>
            <tr>
              <th>Værelse</th>
              <th>Type</th>
              <th>Elev</th>
              <th>Køn</th>
              <th>Intl.</th>
              <th>Status</th>
              <th>Roomie(s)</th>
            </tr>
          </thead>
          <tbody>${tableRows.join("")}</tbody>
        </table>`
      : `<p class="hint">Ingen elever fordelt endnu.</p>`;
  }

  // 8. Eksport & Kopiér til Google Sheets
  function buildExportRows(delimiter) {
    const { rooms, students, activePeriod } = buildModels();
    const assignments = activePeriod.assignments || {};
    const studentMap = new Map(students.map(s => [s.key, s]));

    const lines = [["Vaerelse", "Vaerelsestype", "Elev_ID", "Navn", "Koen", "International", "Status", "Roomies"].join(delimiter)];

    rooms.forEach(room => {
      const assigned = assignments[room.roomId] || [];
      assigned.forEach(entry => {
        const s = studentMap.get(entry.studentKey);
        if (!s) return;
        const roomies = assigned
          .filter(o => o.studentKey !== entry.studentKey)
          .map(o => studentMap.get(o.studentKey)?.name)
          .filter(Boolean)
          .join(", ");

        lines.push([
          room.roomId,
          room.roomType,
          s.extId,
          s.name,
          s.gender,
          s.international ? "JA" : "NEJ",
          entry.locked ? "Laast" : "Tilfaeldig",
          roomies
        ].join(delimiter));
      });
    });

    return lines.join("\n");
  }

  // 9. Event Listeners & Drag-and-Drop
  document.addEventListener("DOMContentLoaded", () => {
    renderSettingsUI();

    document.getElementById("periods-bar").addEventListener("click", e => {
      const switchBtn = e.target.closest("[data-switch-period]");
      if (switchBtn) {
        const periodId = switchBtn.getAttribute("data-switch-period");
        setActivePeriod(periodId);
        renderSettingsUI();
        const activePeriod = getActivePeriod();
        document.getElementById("status-bar").innerHTML = `📂 Viser <strong>${escapeHtml(activePeriod.name)}</strong>.`;
        renderAll();
        return;
      }

      if (e.target.closest("#btn-open-new-period")) {
        openNewPeriodModal();
      }
    });

    document.getElementById("btn-close-new-period").addEventListener("click", closeNewPeriodModal);
    document.getElementById("btn-cancel-new-period").addEventListener("click", closeNewPeriodModal);
    document.getElementById("new-period-modal").addEventListener("click", e => {
      if (e.target.id === "new-period-modal") closeNewPeriodModal();
    });
    document.getElementById("btn-confirm-new-period").addEventListener("click", () => {
      const name = document.getElementById("new-period-name").value.trim();
      const eleverUrl = document.getElementById("new-period-elever-url").value.trim();

      if (!eleverUrl) {
        alert("Indtast venligst et CSV-link til elevlisten for det nye værelsesskift.");
        return;
      }

      addPeriod(name, eleverUrl);
      closeNewPeriodModal();
      renderSettingsUI();
      fetchSheetsData();
    });

    document.getElementById("toggle-settings").addEventListener("click", () => {
      document.getElementById("settings-panel").classList.toggle("hidden");
    });

    document.getElementById("btn-save-settings").addEventListener("click", () => {
      readSettingsFromUI();
      renderSettingsUI();
      syncAssignmentsWithModels(true);
      document.getElementById("status-bar").innerHTML = `✅ Indstillinger for <strong>${escapeHtml(getActivePeriod().name)}</strong> er gemt i localStorage.`;
    });

    document.getElementById("btn-delete-period").addEventListener("click", () => {
      const currentName = getActivePeriod().name;
      if (!confirm(`Er du sikker på, at du vil slette "${currentName}"?`)) return;
      if (deleteActivePeriod()) {
        renderSettingsUI();
        renderAll();
        document.getElementById("status-bar").innerHTML = `🗑️ Slettede <strong>${escapeHtml(currentName)}</strong>.`;
      }
    });

    document.getElementById("btn-reset-storage").addEventListener("click", () => {
      if (!confirm("Dette nulstiller alle perioder og gemte fordelinger. Vil du fortsætte?")) return;
      resetState();
      renderSettingsUI();
      renderAll();
      document.getElementById("status-bar").innerHTML = "🗑️ Alt gemt data er nulstillet. Klik på 'Hent data fra ark'.";
    });

    document.getElementById("btn-fetch").addEventListener("click", () => {
      readSettingsFromUI();
      fetchSheetsData();
    });

    document.getElementById("btn-allocate").addEventListener("click", allocateRemainingRandomly);
    document.getElementById("btn-clear-unlocked").addEventListener("click", clearUnlocked);

    document.getElementById("rooms-grid").addEventListener("click", e => {
      const lockBtn = e.target.closest(".toggle-lock-btn");
      if (lockBtn) {
        const roomId = lockBtn.getAttribute("data-room");
        const studentKey = lockBtn.getAttribute("data-key");
        const activePeriod = getActivePeriod();
        const entry = activePeriod.assignments[roomId]?.find(x => x.studentKey === studentKey);
        if (entry) {
          entry.locked = !entry.locked;
          saveState();
          renderAll();
        }
        return;
      }

      const removeBtn = e.target.closest(".remove-student-btn");
      if (removeBtn) {
        const roomId = removeBtn.getAttribute("data-room");
        const studentKey = removeBtn.getAttribute("data-key");
        removeStudentFromRoom(roomId, studentKey);
        document.getElementById("status-bar").innerHTML = `👤 Fjernede elev fra Værelse <strong>${escapeHtml(roomId)}</strong>.`;
        return;
      }

      const pickerTrigger = e.target.closest("[data-open-picker-room]");
      if (pickerTrigger) {
        const roomId = pickerTrigger.getAttribute("data-open-picker-room");
        openBedPicker(roomId);
      }
    });

    document.getElementById("btn-close-picker").addEventListener("click", closeBedPicker);
    document.getElementById("bed-picker-modal").addEventListener("click", e => {
      if (e.target.id === "bed-picker-modal") closeBedPicker();
    });
    document.getElementById("picker-search").addEventListener("input", renderBedPickerList);
    document.getElementById("picker-list").addEventListener("click", e => {
      const item = e.target.closest("[data-pick-key]");
      if (!item || !activePickerRoomId) return;
      const studentKey = item.getAttribute("data-pick-key");
      const roomId = activePickerRoomId;
      assignStudentToRoom(studentKey, roomId, true);
      closeBedPicker();
      document.getElementById("status-bar").innerHTML = `🔒 Tildelte og låste elev på Værelse <strong>${escapeHtml(roomId)}</strong>.`;
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        if (activePickerRoomId) closeBedPicker();
        closeNewPeriodModal();
      }
    });

    document.addEventListener("dragstart", e => {
      const draggable = e.target.closest("[draggable='true'][data-student-key]");
      if (!draggable) return;
      const payload = {
        studentKey: draggable.getAttribute("data-student-key"),
        fromRoom: draggable.getAttribute("data-from-room") || ""
      };
      e.dataTransfer.setData("text/plain", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      document.body.classList.add("is-dragging");
    });

    document.addEventListener("dragend", () => {
      document.body.classList.remove("is-dragging");
      document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    });

    const roomsGrid = document.getElementById("rooms-grid");
    roomsGrid.addEventListener("dragover", e => {
      const target = e.target.closest("[data-drop-room]");
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      target.classList.add("drag-over");
    });

    roomsGrid.addEventListener("dragleave", e => {
      const target = e.target.closest("[data-drop-room]");
      if (target) target.classList.remove("drag-over");
    });

    roomsGrid.addEventListener("drop", e => {
      const target = e.target.closest("[data-drop-room]");
      if (!target) return;
      e.preventDefault();
      target.classList.remove("drag-over");

      try {
        const payload = JSON.parse(e.dataTransfer.getData("text/plain"));
        const targetRoomId = target.getAttribute("data-drop-room");
        if (!payload?.studentKey || !targetRoomId || payload.fromRoom === targetRoomId) return;

        assignStudentToRoom(payload.studentKey, targetRoomId, true);
        document.getElementById("status-bar").innerHTML = `↔️ Flyttede og låste elev på Værelse <strong>${escapeHtml(targetRoomId)}</strong>.`;
      } catch (err) {
        console.error("Drop-fejl:", err);
      }
    });

    const unplacedZone = document.getElementById("unplaced-dropzone");
    unplacedZone.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      unplacedZone.classList.add("drag-over");
    });

    unplacedZone.addEventListener("dragleave", () => {
      unplacedZone.classList.remove("drag-over");
    });

    unplacedZone.addEventListener("drop", e => {
      e.preventDefault();
      unplacedZone.classList.remove("drag-over");
      try {
        const payload = JSON.parse(e.dataTransfer.getData("text/plain"));
        if (!payload?.studentKey || !payload.fromRoom) return;
        removeStudentFromRoom(payload.fromRoom, payload.studentKey);
        document.getElementById("status-bar").innerHTML = `👤 Fjernede elev fra Værelse <strong>${escapeHtml(payload.fromRoom)}</strong>.`;
      } catch (err) {
        console.error("Drop-fejl:", err);
      }
    });

    document.getElementById("btn-copy-tsv").addEventListener("click", async () => {
      const tsv = buildExportRows("\t");
      await navigator.clipboard.writeText(tsv);
      document.getElementById("status-bar").innerHTML = `📋 Kopieret fordelingen for <strong>${escapeHtml(getActivePeriod().name)}</strong>! Tryk <strong>Ctrl+V / Cmd+V</strong> direkte ind i Google Sheets.`;
    });

    document.getElementById("btn-export-csv").addEventListener("click", () => {
      const activePeriod = getActivePeriod();
      const safeName = activePeriod.name.toLowerCase().replace(/[^a-z0-9æøå]+/gi, "_");
      const csv = "\uFEFF" + buildExportRows(";");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

    const state = getState();
    const activePeriod = getActivePeriod();
    if ((activePeriod.eleverRows || []).length > 0 && (state.cachedData.vaerelserRows || []).length > 0) {
      document.getElementById("status-bar").innerHTML = `💾 Gendannet <strong>${escapeHtml(activePeriod.name)}</strong> (${activePeriod.eleverRows.length} elever og ${state.cachedData.vaerelserRows.length} værelser) fra localStorage.`;
      renderAll();
    } else {
      fetchSheetsData();
    }
  });
})();