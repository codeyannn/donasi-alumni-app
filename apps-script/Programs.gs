/**
 * Programs.gs
 * Master donation program CRUD, active program caching, historical delete guard,
 * and pre-P2.2 compatibility checks against Setup.gs definitions.
 */

var ACTIVE_PROGRAMS_CACHE_KEY = 'active_programs_v1';
var ACTIVE_PROGRAMS_CACHE_TTL_SEC = 60;

/**
 * Checks whether the target v2 'programs' sheet exists and has valid headers.
 * Never auto-creates sheets on production databases before P2.2 migration is approved.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Active spreadsheet.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null} Programs sheet or null if pre-P2.2.
 */
function getProgramsSheetIfReady_(ss) {
  const sheet = ss ? ss.getSheetByName(SHEET_NAMES.PROGRAMS) : null;
  if (!sheet || sheet.getLastRow() < 1) {
    return null;
  }
  const hMap = getHeaderMap_(sheet);
  if (hMap.program_id === undefined || hMap.name === undefined || hMap.is_active === undefined) {
    throw new Error("Schema integrity error: Header pada sheet 'programs' tidak sesuai spesifikasi P2.1.");
  }
  return sheet;
}

/**
 * Requires sheet 'programs' to exist before admin CRUD mutations.
 */
function requireProgramsSheetReady_(ss) {
  const sheet = getProgramsSheetIfReady_(ss);
  if (!sheet) {
    throw new Error(
      "Schema dependency error: Sheet 'programs' belum tersedia. Jalankan migrasi P2.2 terlebih dahulu sebelum mengelola CRUD program."
    );
  }
  return sheet;
}

/**
 * Clears cached public active programs immediately after admin writes.
 */
function invalidateActiveProgramsCache_() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache && typeof cache.remove === 'function') {
      cache.remove(ACTIVE_PROGRAMS_CACHE_KEY);
    } else if (cache) {
      cache.put(ACTIVE_PROGRAMS_CACHE_KEY, '', 1);
    }
  } catch (ignoreCacheErr) {
    // Cache cleanup failure should not abort database commit
  }
}

/**
 * Public read endpoint returning active donation programs (no authentication or PII).
 * Falls back cleanly to read-only PROGRAM_SEEDS with schema_ready: false if P2.2 has not run yet.
 *
 * @returns {Object} { status: 'ok', schema_ready: boolean, programs: Array<Object> }.
 */
function getActivePrograms() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache ? cache.get(ACTIVE_PROGRAMS_CACHE_KEY) : null;
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.programs)) {
        return parsed;
      }
    }
  } catch (ignoreReadErr) {
    // Proceed cleanly to fresh read if cached payload is empty or invalid
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getProgramsSheetIfReady_(ss);
  let payload;

  if (!sheet) {
    // Explicit pre-P2.2 baseline fallback without mutating production spreadsheet structure
    const seeds = (typeof PROGRAM_SEEDS !== 'undefined' ? PROGRAM_SEEDS : []).map(function (row) {
      return {
        program_id: row[0],
        name: row[1],
        description: row[2],
        is_active: String(row[3]).toUpperCase() === 'TRUE'
      };
    });
    payload = {
      status: 'ok',
      schema_ready: false,
      programs: seeds
    };
  } else {
    const hMap = getHeaderMap_(sheet);
    const rows = sheet.getDataRange().getValues();
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const pid = String(rows[i][hMap.program_id] || '').trim();
      const name = String(rows[i][hMap.name] || '').trim();
      const activeFlag = String(rows[i][hMap.is_active] || '').trim().toUpperCase() === 'TRUE';
      if (pid && name && activeFlag) {
        list.push({
          program_id: pid,
          name: name,
          description: hMap.description !== undefined ? String(rows[i][hMap.description] || '').trim() : '',
          is_active: true
        });
      }
    }
    payload = {
      status: 'ok',
      schema_ready: true,
      programs: list
    };
  }

  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      cache.put(ACTIVE_PROGRAMS_CACHE_KEY, JSON.stringify(payload), ACTIVE_PROGRAMS_CACHE_TTL_SEC);
    }
  } catch (ignoreWriteErr) {
    // Cache write error is non-fatal
  }

  return payload;
}

/**
 * Counts how many historical donation_intents and transactions reference a given program.
 * Supports both v2 (program_id column) and v1 snapshot (program name column) matching.
 */
function countProgramHistoricalUsage_(ss, programId, programName) {
  const targetPid = String(programId || '').trim();
  const targetName = String(programName || '').trim().toLowerCase();
  let count = 0;

  const scanSheet = function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() <= 1) return;
    const hMap = getHeaderMap_(sheet);
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const rowPid = hMap.program_id !== undefined ? String(rows[i][hMap.program_id] || '').trim() : '';
      const rowName = hMap.program !== undefined ? String(rows[i][hMap.program] || '').trim().toLowerCase() : '';
      if ((targetPid && rowPid === targetPid) || (targetName && rowName === targetName)) {
        count++;
      }
    }
  };

  scanSheet(SHEET_NAMES.INTENTS);
  scanSheet(SHEET_NAMES.TRANSACTIONS);
  return count;
}

/**
 * Lists all programs (active and inactive) with historical usage counters for Admin UI.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @returns {Object} { status: 'ok', programs: Array<Object> }.
 */
function getAllProgramsAdmin(adminToken) {
  requireAdmin_(adminToken);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = requireProgramsSheetReady_(ss);
  const hMap = getHeaderMap_(sheet);
  const rows = sheet.getDataRange().getValues();
  const items = [];

  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][hMap.program_id] || '').trim();
    const name = String(rows[i][hMap.name] || '').trim();
    if (!pid) continue;
    items.push({
      program_id: pid,
      name: name,
      description: hMap.description !== undefined ? String(rows[i][hMap.description] || '').trim() : '',
      is_active: String(rows[i][hMap.is_active] || '').trim().toUpperCase() === 'TRUE',
      usage_count: countProgramHistoricalUsage_(ss, pid, name),
      created_at: hMap.created_at !== undefined ? rows[i][hMap.created_at] : '',
      updated_at: hMap.updated_at !== undefined ? rows[i][hMap.updated_at] : ''
    });
  }

  return {
    status: 'ok',
    programs: items
  };
}

/**
 * Issues next unique PRG-xxx ID inside ScriptLock by scanning both counters.PROGRAM and programs sheet.
 */
function getNextProgramSequenceSafe_(ss, prgSheet) {
  let maxSeq = 0;
  if (prgSheet && prgSheet.getLastRow() > 1) {
    const hMap = getHeaderMap_(prgSheet);
    const rows = prgSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const m = String(rows[i][hMap.program_id] || '').trim().toUpperCase().match(/^PRG-(\d{3,})$/);
      if (m) {
        const val = parseInt(m[1], 10);
        if (!isNaN(val) && val > maxSeq) maxSeq = val;
      }
    }
  }

  const ctrSheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
  const lastRow = ctrSheet ? ctrSheet.getLastRow() : 0;
  for (let i = 2; i <= lastRow; i++) {
    const name = String(ctrSheet.getRange(i, 1).getValue()).trim().toUpperCase();
    if (name === 'PROGRAM') {
      const cur = parseInt(ctrSheet.getRange(i, 2).getValue(), 10) || 0;
      const next = Math.max(cur, maxSeq) + 1;
      ctrSheet.getRange(i, 2).setValue(next);
      return next;
    }
  }

  const nextInit = maxSeq + 1;
  if (ctrSheet) ctrSheet.appendRow(['PROGRAM', nextInit]);
  return nextInit;
}

/**
 * Admin CRUD write handler for creating, updating, or toggling donation programs.
 * Never alters historical snapshot names already recorded on transactions/intents.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @param {Object} data - { mode: 'create'|'update'|'toggle', program_id?, name?, description?, is_active? }.
 * @returns {Object} Saved program record.
 */
function saveProgramAdmin(adminToken, data) {
  const adminProfile = requireAdmin_(adminToken);
  const input = data || {};
  const mode = String(input.mode || (input.program_id ? 'update' : 'create')).trim().toLowerCase();
  if (['create', 'update', 'toggle'].indexOf(mode) === -1) {
    throw new Error("Mode penyimpanan program tidak valid. Gunakan 'create', 'update', atau 'toggle'.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = requireProgramsSheetReady_(ss);
    const hMap = getHeaderMap_(sheet);
    const rows = sheet.getDataRange().getValues();
    const nowIso = new Date().toISOString();

    if (mode === 'create') {
      const cleanName = sanitizeSpreadsheetFormula(input.name);
      const cleanDesc = sanitizeSpreadsheetFormula(input.description || '');
      if (!cleanName || cleanName.length < 3 || cleanName.length > 100) {
        throw new Error('Nama program wajib diisi (3-100 karakter).');
      }

      // Reject duplicate case-insensitive program names
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][hMap.name] || '').trim().toLowerCase() === cleanName.toLowerCase()) {
          throw new Error("Program dengan nama '" + cleanName + "' sudah terdaftar.");
        }
      }

      const seq = getNextProgramSequenceSafe_(ss, sheet);
      const programId = formatProgramId(seq);
      const activeFlag = input.is_active === false || String(input.is_active).toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';

      const newRow = new Array(sheet.getLastColumn ? Math.max(6, sheet.getLastColumn()) : 6).fill('');
      newRow[hMap.program_id] = programId;
      newRow[hMap.name] = cleanName;
      if (hMap.description !== undefined) newRow[hMap.description] = cleanDesc;
      newRow[hMap.is_active] = activeFlag;
      if (hMap.created_at !== undefined) newRow[hMap.created_at] = nowIso;
      if (hMap.updated_at !== undefined) newRow[hMap.updated_at] = nowIso;
      sheet.appendRow(newRow);

      invalidateActiveProgramsCache_();
      logAudit_(adminProfile.email, 'CREATE_PROGRAM', programId, 'Created program: ' + cleanName);

      return {
        status: 'ok',
        program: {
          program_id: programId,
          name: cleanName,
          description: cleanDesc,
          is_active: activeFlag === 'TRUE',
          created_at: nowIso,
          updated_at: nowIso
        }
      };
    }

    // Update or toggle existing program row by program_id
    const targetPid = String(input.program_id || '').trim().toUpperCase();
    if (!targetPid) {
      throw new Error('Parameter program_id wajib diisi.');
    }

    let rowIdx = -1;
    let currentRow = null;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][hMap.program_id] || '').trim().toUpperCase() === targetPid) {
        rowIdx = i + 1;
        currentRow = rows[i];
        break;
      }
    }
    if (rowIdx === -1 || !currentRow) {
      throw new Error('Program tidak ditemukan: ' + targetPid);
    }

    if (mode === 'toggle') {
      const curActive = String(currentRow[hMap.is_active] || '').trim().toUpperCase() === 'TRUE';
      const nextActive = input.is_active !== undefined
        ? (input.is_active === true || String(input.is_active).toUpperCase() === 'TRUE')
        : !curActive;
      const nextActiveStr = nextActive ? 'TRUE' : 'FALSE';

      sheet.getRange(rowIdx, hMap.is_active + 1).setValue(nextActiveStr);
      if (hMap.updated_at !== undefined) {
        sheet.getRange(rowIdx, hMap.updated_at + 1).setValue(nowIso);
      }

      invalidateActiveProgramsCache_();
      logAudit_(adminProfile.email, 'TOGGLE_PROGRAM', targetPid, 'Set is_active=' + nextActiveStr);

      return {
        status: 'ok',
        program: {
          program_id: targetPid,
          name: String(currentRow[hMap.name] || '').trim(),
          description: hMap.description !== undefined ? String(currentRow[hMap.description] || '').trim() : '',
          is_active: nextActive,
          updated_at: nowIso
        }
      };
    }

    // Update name, description, and optional active status (leaving historical tx/intent snapshots unchanged)
    const nextName = sanitizeSpreadsheetFormula(input.name);
    const nextDesc = input.description !== undefined
      ? sanitizeSpreadsheetFormula(input.description)
      : (hMap.description !== undefined ? String(currentRow[hMap.description] || '') : '');
    if (!nextName || nextName.length < 3 || nextName.length > 100) {
      throw new Error('Nama program wajib diisi (3-100 karakter).');
    }

    for (let i = 1; i < rows.length; i++) {
      if (i + 1 !== rowIdx && String(rows[i][hMap.name] || '').trim().toLowerCase() === nextName.toLowerCase()) {
        throw new Error("Nama program '" + nextName + "' sudah digunakan oleh program lain.");
      }
    }

    const nextActiveBool = input.is_active !== undefined
      ? (input.is_active === true || String(input.is_active).toUpperCase() === 'TRUE')
      : (String(currentRow[hMap.is_active] || '').trim().toUpperCase() === 'TRUE');
    const nextActiveStr = nextActiveBool ? 'TRUE' : 'FALSE';

    sheet.getRange(rowIdx, hMap.name + 1).setValue(nextName);
    if (hMap.description !== undefined) {
      sheet.getRange(rowIdx, hMap.description + 1).setValue(nextDesc);
    }
    sheet.getRange(rowIdx, hMap.is_active + 1).setValue(nextActiveStr);
    if (hMap.updated_at !== undefined) {
      sheet.getRange(rowIdx, hMap.updated_at + 1).setValue(nowIso);
    }

    invalidateActiveProgramsCache_();
    logAudit_(adminProfile.email, 'UPDATE_PROGRAM', targetPid, 'Updated program to: ' + nextName + ' (active=' + nextActiveStr + ')');

    return {
      status: 'ok',
      program: {
        program_id: targetPid,
        name: nextName,
        description: nextDesc,
        is_active: nextActiveBool,
        updated_at: nowIso
      }
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Deletes an unused program row. Strictly rejects deletion (Conflict) when any historical
 * transaction or donation intent references it, preserving referential history.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @param {string} programId - Target PRG-xxx identifier.
 * @returns {Object} Deletion confirmation.
 */
function deleteProgramAdmin(adminToken, programId) {
  const adminProfile = requireAdmin_(adminToken);
  const targetPid = String(programId || '').trim().toUpperCase();
  if (!targetPid) {
    throw new Error('Parameter program_id wajib diisi.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = requireProgramsSheetReady_(ss);
    const hMap = getHeaderMap_(sheet);
    const rows = sheet.getDataRange().getValues();

    let rowIdx = -1;
    let progName = '';
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][hMap.program_id] || '').trim().toUpperCase() === targetPid) {
        rowIdx = i + 1;
        progName = String(rows[i][hMap.name] || '').trim();
        break;
      }
    }
    if (rowIdx === -1) {
      throw new Error('Program tidak ditemukan: ' + targetPid);
    }

    const usageCount = countProgramHistoricalUsage_(ss, targetPid, progName);
    if (usageCount > 0) {
      throw new Error(
        '409 Conflict: Program ' + targetPid + ' sudah digunakan oleh ' + usageCount +
        ' transaksi/intent historis. Nonaktifkan program sebagai gantinya.'
      );
    }

    if (typeof sheet.deleteRow === 'function') {
      sheet.deleteRow(rowIdx);
    } else {
      // Fallback for simple in-memory mocks lacking deleteRow
      throw new Error('Spreadsheet environment does not support deleteRow.');
    }

    invalidateActiveProgramsCache_();
    logAudit_(adminProfile.email, 'DELETE_PROGRAM', targetPid, 'Deleted unused program: ' + progName);

    return {
      status: 'ok',
      deleted_program_id: targetPid
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Authoritative backend resolver for validating donation program selection on intent creation.
 * Ensures selected program exists and is currently active (never trusts client-submitted names alone).
 *
 * @param {string} programIdInput - Optional program_id (e.g. 'PRG-001').
 * @param {string} programNameInput - Optional fallback program display name.
 * @returns {Object} { program_id, name, schema_ready }.
 */
function resolveProgramForDonation_(programIdInput, programNameInput) {
  const pidIn = String(programIdInput || '').trim().toUpperCase();
  const nameIn = String(programNameInput || '').trim();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getProgramsSheetIfReady_(ss);

  if (!sheet) {
    // Validate against baseline PROGRAM_SEEDS when running on pre-P2.2 v1 schema
    const seeds = typeof PROGRAM_SEEDS !== 'undefined' ? PROGRAM_SEEDS : [];
    for (let i = 0; i < seeds.length; i++) {
      const sPid = String(seeds[i][0]).toUpperCase();
      const sName = String(seeds[i][1]);
      if ((pidIn && pidIn === sPid) || (!pidIn && nameIn && nameIn.toLowerCase() === sName.toLowerCase())) {
        return { program_id: sPid, name: sName, schema_ready: false };
      }
    }
    throw new Error('Program donasi tidak valid atau belum tersedia.');
  }

  const hMap = getHeaderMap_(sheet);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const sPid = String(rows[i][hMap.program_id] || '').trim().toUpperCase();
    const sName = String(rows[i][hMap.name] || '').trim();
    const isActive = String(rows[i][hMap.is_active] || '').trim().toUpperCase() === 'TRUE';

    const matches = (pidIn && sPid === pidIn) || (!pidIn && nameIn && sName.toLowerCase() === nameIn.toLowerCase());
    if (matches) {
      if (!isActive) {
        throw new Error("Program '" + sName + "' sedang tidak aktif dan tidak dapat menerima donasi baru.");
      }
      return { program_id: sPid, name: sName, schema_ready: true };
    }
  }

  throw new Error('Program donasi yang dipilih tidak ditemukan.');
}
