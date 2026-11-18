/**
 * Setup.gs
 * Schema definitions, initial builder, preflight validator, backup/restore manager,
 * and non-destructive idempotent migration engine for DonasiAlumniApp.
 */

var MIGRATION_VERSION = "P2_V2.0.0";

var SHEET_NAMES = SHEET_NAMES || {
  USERS: "users",
  VERIFICATIONS: "alumni_verifications",
  INTENTS: "donation_intents",
  TRANSACTIONS: "transactions",
  REVIEW_QUEUE: "review_queue",
  COUNTERS: "counters",
  AUDIT_LOG: "audit_log",
  CONFIG: "config",
  KEYWORDS: "program_keywords",
  PROGRAMS: "programs",
};

/**
 * Required baseline (v1) sheet headers before P2 migration.
 */
var SCHEMA_V1_DEFINITIONS = {
  users: [
    "user_id",
    "google_sub",
    "email",
    "full_name",
    "role",
    "ref_code",
    "verification_status",
    "consent_at",
    "created_at",
  ],
  alumni_verifications: [
    "verif_id",
    "user_id",
    "email",
    "full_name",
    "nim",
    "grad_year",
    "faculty",
    "proof_file_id",
    "status",
    "submitted_at",
    "reviewed_by",
    "reviewed_at",
    "reject_reason",
  ],
  donation_intents: [
    "intent_id",
    "user_id",
    "ref_code",
    "amount",
    "bank",
    "program",
    "status",
    "created_at",
    "expires_at",
    "matched_tx_id",
  ],
  transactions: [
    "tx_id",
    "mutation_id",
    "received_at",
    "bank",
    "account_masked",
    "tx_date",
    "amount",
    "description",
    "donor_name_raw",
    "donor_display_name",
    "match_status",
    "match_tier",
    "user_id",
    "ref_code",
    "intent_id",
    "program",
    "is_anonymous",
  ],
  review_queue: [
    "queue_id",
    "tx_id",
    "bank",
    "amount",
    "tx_date",
    "description",
    "reason",
    "candidates_count",
    "status",
    "resolved_by",
    "resolved_at",
    "assigned_user_id",
    "assigned_ref_code",
  ],
  counters: ["name", "value"],
  audit_log: ["timestamp", "actor_email", "action", "target", "detail"],
  config: ["key", "value", "description"],
  program_keywords: ["keyword", "program"],
};

/**
 * Target (v2) sheet headers aligned with database_migration_plan.md.
 * All additions are strictly appended to the right end of existing tables.
 */
var SCHEMA_V2_DEFINITIONS = {
  users: SCHEMA_V1_DEFINITIONS.users.slice(),
  alumni_verifications: SCHEMA_V1_DEFINITIONS.alumni_verifications.slice(),
  donation_intents: SCHEMA_V1_DEFINITIONS.donation_intents.concat([
    "is_anonymous",
    "payment_channel",
    "donor_type",
    "donor_name",
    "donor_email",
    "program_id",
    "midtrans_order_id",
    "snap_token",
    "access_token_hash",
    "access_token_expires_at",
    "last_inquiry_at",
  ]),
  transactions: SCHEMA_V1_DEFINITIONS.transactions.concat([
    "donor_type",
    "donor_email",
    "program_id",
    "payment_channel",
    "gateway_order_id",
    "gateway_transaction_id",
    "gateway_payment_type",
    "gateway_status",
    "gross_amount",
    "gateway_fee",
    "net_amount",
    "receipt_no",
    "receipt_issued_at",
    "access_token_hash",
    "access_token_expires_at",
    "email_status",
    "email_sent_at",
    "email_error",
  ]),
  review_queue: SCHEMA_V1_DEFINITIONS.review_queue.slice(),
  counters: SCHEMA_V1_DEFINITIONS.counters.slice(),
  audit_log: SCHEMA_V1_DEFINITIONS.audit_log.slice(),
  config: SCHEMA_V1_DEFINITIONS.config.slice(),
  program_keywords: SCHEMA_V1_DEFINITIONS.program_keywords.slice(),
  programs: [
    "program_id",
    "name",
    "description",
    "is_active",
    "created_at",
    "updated_at",
  ],
};

/**
 * Initial seed rows for the programs master sheet (inserted only when missing).
 */
var PROGRAM_SEEDS = [
  ["PRG-001", "Beasiswa Alumni UPI", "Program reguler beasiswa UKT mahasiswa UPI", "TRUE"],
  ["PRG-002", "Beasiswa Prestasi", "Dukungan mahasiswa berprestasi akademik/non-akademik", "TRUE"],
  ["PRG-003", "Beasiswa Afirmasi", "Bantuan mahasiswa dari daerah 3T / ekonomi rentan", "TRUE"],
  ["PRG-004", "Wakaf Pendidikan", "Pengembangan sarana laboratorium dan perpustakaan", "TRUE"],
  ["PRG-005", "Infaq Operasional", "Dukungan pembinaan penerima beasiswa", "TRUE"],
];

/**
 * Counter keys seeded for v2 operations.
 */
var P2_COUNTER_SEEDS = [
  ["ALUMNI", 0],
  ["GUEST", 0],
  ["RECEIPT", 0],
  ["PROGRAM", 5],
];

/**
 * Non-secret operational config keys ensured during migration.
 */
var P2_NON_SECRET_CONFIG_SEEDS = [
  [
    "ALLOW_MOCK_AUTH",
    "false",
    "Must remain false in live environments to block mock_token_* backdoors",
  ],
  [
    "ALLOW_MANUAL_DEMO_TRIGGER",
    "false",
    "Must remain false in production except controlled manual demo sessions",
  ],
  [
    "MIDTRANS_IS_PRODUCTION",
    "false",
    "Controls Midtrans Sandbox vs Production endpoint selection",
  ],
  [
    "GUEST_RECEIPT_TTL_DAYS",
    "30",
    "Access token validity window in days for Guest receipt viewing",
  ],
  [
    "MAX_DONATION_AMOUNT",
    "100000000",
    "Maximum allowed donation nominal per transaction in IDR",
  ],
];

/**
 * Initializes baseline sheets, columns, formatting, and default configurations.
 * Preserved compatible with P0 and P1 modules until P2.2 migration is authorized.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      "Tidak dapat mendeteksi Spreadsheet aktif. Buka Apps Script dari menu Extensions > Apps Script.",
    );
  }

  // Initialize baseline 9 tables using v1 schema headers
  initSheetWithHeaders_(ss, SHEET_NAMES.USERS, SCHEMA_V1_DEFINITIONS.users);
  initSheetWithHeaders_(ss, SHEET_NAMES.VERIFICATIONS, SCHEMA_V1_DEFINITIONS.alumni_verifications);
  initSheetWithHeaders_(ss, SHEET_NAMES.INTENTS, SCHEMA_V1_DEFINITIONS.donation_intents);
  initSheetWithHeaders_(ss, SHEET_NAMES.TRANSACTIONS, SCHEMA_V1_DEFINITIONS.transactions);
  initSheetWithHeaders_(ss, SHEET_NAMES.REVIEW_QUEUE, SCHEMA_V1_DEFINITIONS.review_queue);
  initSheetWithHeaders_(ss, SHEET_NAMES.AUDIT_LOG, SCHEMA_V1_DEFINITIONS.audit_log);

  // Initialize counters sheet with baseline sequences
  const counterSheet = initSheetWithHeaders_(ss, SHEET_NAMES.COUNTERS, SCHEMA_V1_DEFINITIONS.counters);
  if (counterSheet.getLastRow() <= 1) {
    counterSheet.getRange(2, 1, 2, 2).setValues([
      ["ALUMNI", 0],
      ["GUEST", 0],
    ]);
  }

  // Initialize non-secret operational settings
  const cfgSheet = initSheetWithHeaders_(ss, SHEET_NAMES.CONFIG, SCHEMA_V1_DEFINITIONS.config);
  if (cfgSheet.getLastRow() <= 1) {
    const defaultConfigs = [
      [
        "ALLOW_MOCK_AUTH",
        "false",
        "Must remain false in live environments to block mock_token_* backdoors",
      ],
      [
        "ADMIN_EMAILS",
        "maulanaa1408@upi.edu",
        "Comma separated emails of trusted system admins",
      ],
      [
        "MATCH_WINDOW_HOURS",
        "24",
        "Hours window to consider an intent valid for tier 2 auto-match",
      ],
      [
        "ORG_NAME",
        "Pengelola Beasiswa Ikatan Alumni UPI",
        "Organization title displayed on app & emails",
      ],
      [
        "GOOGLE_CLIENT_ID",
        "",
        "Required Google OAuth Web Client ID for fail-closed token audience verification",
      ],
    ];
    cfgSheet.getRange(2, 1, defaultConfigs.length, 3).setValues(defaultConfigs);
  }

  // Initialize fallback program keywords for manual transfers without intents
  const kwSheet = initSheetWithHeaders_(ss, SHEET_NAMES.KEYWORDS, SCHEMA_V1_DEFINITIONS.program_keywords);
  if (kwSheet.getLastRow() <= 1) {
    const defaultKeywords = [
      ["BEASISWA", "Beasiswa Alumni UPI"],
      ["PRESTASI", "Beasiswa Prestasi"],
      ["AFIRMASI", "Beasiswa Afirmasi"],
      ["WAKAF", "Wakaf Pendidikan"],
      ["ZAKAT", "Zakat Pendidikan"],
      ["INFAQ", "Infaq Operasional"],
      ["SEDEKAH", "Infaq & Sedekah"],
    ];
    kwSheet.getRange(2, 1, defaultKeywords.length, 2).setValues(defaultKeywords);
  }

  Logger.log("Setup completed successfully for DonasiAlumniApp.");
}

/**
 * Helper to ensure a tab exists with bold styled headers and frozen first row.
 */
function initSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange(1, 1, 1, headers.length)
    .setFontWeight("bold")
    .setBackground("#E2E8F0");
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * Builds a header-name-to-0-based-index dictionary from row 1 of a sheet.
 * Rejects duplicate header names so header-based reads/writes never target ambiguous columns.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Target Google Sheet tab.
 * @returns {Object.<string, number>} Map of header name -> 0-based column index.
 */
function getHeaderMap_(sheet) {
  if (!sheet) {
    throw new Error("Sheet tidak ditemukan saat membaca header.");
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    throw new Error("Sheet '" + sheet.getName() + "' tidak memiliki baris header.");
  }
  const fullData = sheet.getDataRange().getValues();
  const headerRow = (fullData && fullData[0]) ? fullData[0] : [];
  const map = {};

  for (let c = 0; c < headerRow.length; c++) {
    const colName = String(headerRow[c] || "").trim();
    if (!colName) {
      continue;
    }
    // Reject duplicate column labels to protect positional integrity
    if (Object.prototype.hasOwnProperty.call(map, colName)) {
      throw new Error(
        "Duplicate header column '" + colName + "' detected in sheet '" + sheet.getName() + "'.",
      );
    }
    map[colName] = c;
  }

  return map;
}

/**
 * Reads header names as a trimmed string array from row 1 of a sheet.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Target sheet tab.
 * @returns {string[]} Array of header names in left-to-right column order.
 */
function getSheetHeadersList_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) {
    return [];
  }
  const rows = sheet.getDataRange().getValues();
  const row1 = rows[0] || [];
  // Trim trailing empty cells while preserving header positions
  let endIdx = row1.length - 1;
  while (endIdx >= 0 && String(row1[endIdx] || "").trim() === "") {
    endIdx--;
  }
  const headers = [];
  for (let i = 0; i <= endIdx; i++) {
    headers.push(String(row1[i] || "").trim());
  }
  return headers;
}

/**
 * Validates that a sheet's leading columns match the baseline v1 schema
 * and that any appended columns strictly follow the expected v2 definition.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Sheet to inspect.
 * @param {string[]} expectedPrefix - Mandatory v1 leading column names.
 * @param {string[]} allowedTarget - Full target v2 column names.
 * @returns {Object} Structured header validation result.
 */
function validateSheetHeaders_(sheet, expectedPrefix, allowedTarget) {
  const sheetName = sheet.getName();
  const currentHeaders = getSheetHeadersList_(sheet);
  const errors = [];

  if (currentHeaders.length < expectedPrefix.length) {
    errors.push(
      "Sheet '" + sheetName + "' header count " + currentHeaders.length +
      " is shorter than baseline " + expectedPrefix.length + ".",
    );
  }

  // Check duplicate header names cleanly via Map/Set
  const seen = {};
  for (let i = 0; i < currentHeaders.length; i++) {
    const h = currentHeaders[i];
    if (!h) {
      errors.push("Sheet '" + sheetName + "' contains an empty header at column " + (i + 1) + ".");
      continue;
    }
    if (seen[h]) {
      errors.push("Sheet '" + sheetName + "' contains duplicate header '" + h + "'.");
    }
    seen[h] = true;
  }

  // Verify leading baseline columns stay in exact position and spelling
  for (let i = 0; i < expectedPrefix.length && i < currentHeaders.length; i++) {
    if (currentHeaders[i] !== expectedPrefix[i]) {
      errors.push(
        "Sheet '" + sheetName + "' column " + (i + 1) + " expected '" + expectedPrefix[i] +
        "' but found '" + currentHeaders[i] + "'.",
      );
    }
  }

  // Verify any already-appended columns beyond baseline match target order
  for (let i = expectedPrefix.length; i < currentHeaders.length; i++) {
    if (i >= allowedTarget.length || currentHeaders[i] !== allowedTarget[i]) {
      errors.push(
        "Sheet '" + sheetName + "' unexpected extended column at " + (i + 1) +
        ": '" + currentHeaders[i] + "' (expected '" + (allowedTarget[i] || "NONE") + "').",
      );
    }
  }

  const missingTargetColumns = [];
  for (let i = 0; i < allowedTarget.length; i++) {
    if (!seen[allowedTarget[i]]) {
      missingTargetColumns.push(allowedTarget[i]);
    }
  }

  return {
    ok: errors.length === 0,
    sheetName: sheetName,
    currentCount: currentHeaders.length,
    baselineCount: expectedPrefix.length,
    targetCount: allowedTarget.length,
    currentHeaders: currentHeaders,
    missingTargetColumns: missingTargetColumns,
    errors: errors,
  };
}

/**
 * Writes a sanitized audit log entry strictly to the target spreadsheet's audit_log tab
 * so copy/sandbox migrations never pollute an external active spreadsheet.
 */
function appendMigrationAuditLog_(ss, actor, action, target, detail) {
  try {
    const targetSs = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!targetSs) return;
    const sheet = targetSs.getSheetByName(SHEET_NAMES.AUDIT_LOG);
    if (!sheet) return;
    const rawDetail = String(detail || "");
    const cleanDetail = typeof redactSensitiveAuditText_ === "function"
      ? redactSensitiveAuditText_(rawDetail)
      : rawDetail;
    const cleanActor = typeof redactSensitiveAuditText_ === "function"
      ? redactSensitiveAuditText_(String(actor || "SYSTEM"))
      : String(actor || "SYSTEM");
    sheet.appendRow([
      new Date().toISOString(),
      cleanActor,
      String(action || ""),
      String(target || ""),
      cleanDetail,
    ]);
  } catch (ignoreAuditErr) {
    // Non-fatal audit fallback during migration
  }
}

/**
 * Formats a compact WIB/UTC timestamp string for backup naming.
 */
function formatMigrationTimestamp_(dateObj) {
  const d = dateObj || new Date();
  try {
    if (typeof Utilities !== "undefined" && typeof Utilities.formatDate === "function") {
      return Utilities.formatDate(d, "Asia/Jakarta", "yyyyMMdd_HHmmss");
    }
  } catch (ignore) {
    // Fall back to ISO timestamp formatting when timezone formatter is unavailable
  }
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
}

/**
 * Reads all non-empty rows of a sheet as 2D array (header row included at index 0).
 */
function readSheetMatrix_(sheet) {
  if (!sheet || sheet.getLastRow() === 0) {
    return [];
  }
  return sheet.getDataRange().getValues();
}

/**
 * Creates a full verified Drive copy backup of the active Spreadsheet before migration.
 * Enforces admin authorization when adminToken is provided or requireAuth is true,
 * and serializes execution via LockService.
 *
 * @param {Object=} options - { adminToken, requireAuth, sourceSpreadsheet, migrationVersion, writeAuditLog }.
 * @returns {Object} Verified backup metadata and per-sheet verification report.
 */
function createMigrationBackup(options) {
  const opts = options || {};
  if (opts.adminToken !== undefined || opts.requireAuth === true) {
    requireAdmin_(opts.adminToken);
  }

  const ss = opts.sourceSpreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Spreadsheet aktif tidak ditemukan untuk backup.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const versionTag = String(opts.migrationVersion || MIGRATION_VERSION);
    const now = new Date();
    const stamp = formatMigrationTimestamp_(now);
    const backupName = "BACKUP_DonasiAlumniApp_" + versionTag + "_" + stamp;

    // Create full Spreadsheet snapshot copy via GAS copy API
    const backupSs = ss.copy(backupName);
    if (!backupSs) {
      throw new Error("Pembuatan salinan backup gagal: objek backup kosong.");
    }

    // Never assume copy succeeded without checking every sheet, header, and row
    const verification = verifyMigrationBackup(ss, backupSs, versionTag);
    if (!verification.ok) {
      throw new Error("Verifikasi backup gagal: " + verification.errors.join(" | "));
    }

    const backupMeta = {
      backup_id: typeof backupSs.getId === "function" ? backupSs.getId() : backupName,
      backup_name: typeof backupSs.getName === "function" ? backupSs.getName() : backupName,
      backup_url: typeof backupSs.getUrl === "function" ? backupSs.getUrl() : "",
      migration_version: versionTag,
      created_at: now.toISOString(),
      verified: true,
      sheet_count: verification.sheets.length,
      sheets: verification.sheets,
    };

    // Persist safe non-secret backup metadata in ScriptProperties for traceability
    try {
      const props = PropertiesService.getScriptProperties();
      if (props) {
        props.setProperty("LAST_MIGRATION_BACKUP", JSON.stringify({
          backup_id: backupMeta.backup_id,
          backup_name: backupMeta.backup_name,
          migration_version: versionTag,
          created_at: backupMeta.created_at,
          sheet_count: backupMeta.sheet_count,
        }));
      }
    } catch (ignorePropErr) {
      // Non-fatal metadata storage fallback
    }

    // Write sanitized audit entry strictly to source spreadsheet after backup equality verification completes
    if (opts.writeAuditLog !== false) {
      appendMigrationAuditLog_(
        ss,
        "SYSTEM_MIGRATION",
        "MIGRATION_BACKUP_CREATED",
        backupMeta.backup_id,
        "Verified backup " + backupMeta.backup_name + " (" + backupMeta.sheet_count + " sheets).",
      );
    }

    return {
      status: "ok",
      backup: backupMeta,
      backupSpreadsheet: backupSs,
      verification: verification,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Verifies a backup Spreadsheet against the source Spreadsheet cell-by-cell.
 * Confirms presence of all required tables (plus programs if present), matching headers, and row counts.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} sourceSs - Original spreadsheet.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} backupSs - Backup spreadsheet copy.
 * @param {string=} expectedVersion - Migration version tag attached to this backup.
 * @returns {Object} Detailed backup verification summary.
 */
function verifyMigrationBackup(sourceSs, backupSs, expectedVersion) {
  const errors = [];
  const verifiedSheets = [];

  if (!sourceSs || !backupSs) {
    return {
      ok: false,
      migration_version: expectedVersion || MIGRATION_VERSION,
      errors: ["Source or backup spreadsheet reference is missing."],
      sheets: [],
    };
  }

  // Gather all source sheets dynamically when getSheets() is available, plus known schema names
  const seenNames = {};
  const sheetsToCheck = [];
  if (typeof sourceSs.getSheets === "function") {
    const allSrc = sourceSs.getSheets();
    for (let i = 0; i < allSrc.length; i++) {
      const sName = allSrc[i].getName();
      if (!seenNames[sName]) {
        seenNames[sName] = true;
        sheetsToCheck.push(sName);
      }
    }
  } else {
    const knownKeys = Object.keys(SCHEMA_V1_DEFINITIONS);
    for (let i = 0; i < knownKeys.length; i++) {
      sheetsToCheck.push(knownKeys[i]);
    }
    if (sourceSs.getSheetByName(SHEET_NAMES.PROGRAMS)) {
      sheetsToCheck.push(SHEET_NAMES.PROGRAMS);
    }
  }

  // Ensure every critical baseline table exists in source and backup
  const requiredTables = Object.keys(SCHEMA_V1_DEFINITIONS);
  for (let i = 0; i < requiredTables.length; i++) {
    const reqName = requiredTables[i];
    if (!sourceSs.getSheetByName(reqName)) {
      errors.push("Required source sheet missing for backup: " + reqName);
    } else if (!seenNames[reqName]) {
      seenNames[reqName] = true;
      sheetsToCheck.push(reqName);
    }
  }

  for (let i = 0; i < sheetsToCheck.length; i++) {
    const name = sheetsToCheck[i];
    const srcSheet = sourceSs.getSheetByName(name);
    const bakSheet = backupSs.getSheetByName(name);

    if (!srcSheet) {
      continue;
    }
    if (!bakSheet) {
      errors.push("Sheet '" + name + "' missing in backup spreadsheet.");
      continue;
    }

    const srcMatrix = readSheetMatrix_(srcSheet);
    const bakMatrix = readSheetMatrix_(bakSheet);
    const srcHeaders = getSheetHeadersList_(srcSheet);
    const bakHeaders = getSheetHeadersList_(bakSheet);

    // Check row count parity
    if (srcMatrix.length !== bakMatrix.length) {
      errors.push(
        "Row count mismatch on backup sheet '" + name + "': source=" +
        srcMatrix.length + ", backup=" + bakMatrix.length,
      );
    }

    // Check exact header order and spelling
    if (JSON.stringify(srcHeaders) !== JSON.stringify(bakHeaders)) {
      errors.push("Header mismatch on backup sheet '" + name + "'.");
    }

    // Verify full cell matrix equivalence so partial copies never pass unnoticed
    const minRows = Math.min(srcMatrix.length, bakMatrix.length);
    for (let r = 0; r < minRows; r++) {
      const sRow = srcMatrix[r] || [];
      const bRow = bakMatrix[r] || [];
      const maxCols = Math.max(sRow.length, bRow.length);
      for (let c = 0; c < maxCols; c++) {
        const sv = sRow[c] === undefined ? "" : String(sRow[c]);
        const bv = bRow[c] === undefined ? "" : String(bRow[c]);
        if (sv !== bv) {
          errors.push(
            "Cell content mismatch on backup sheet '" + name + "' at R" + (r + 1) + "C" + (c + 1) + ".",
          );
          break;
        }
      }
      if (errors.length > 0 && errors[errors.length - 1].indexOf("'" + name + "'") !== -1) {
        break;
      }
    }

    verifiedSheets.push({
      name: name,
      header_count: srcHeaders.length,
      total_rows: srcMatrix.length,
      data_rows: Math.max(0, srcMatrix.length - 1),
      backup_rows: bakMatrix.length,
      headers_match: JSON.stringify(srcHeaders) === JSON.stringify(bakHeaders),
      rows_match: srcMatrix.length === bakMatrix.length,
    });
  }

  return {
    ok: errors.length === 0,
    migration_version: expectedVersion || MIGRATION_VERSION,
    verified_at: new Date().toISOString(),
    sheets: verifiedSheets,
    errors: errors,
  };
}

/**
 * Extracts trailing numeric sequence from prefixed reference codes (A000471 -> 471, PRG-005 -> 5).
 */
function extractNumericSequence_(value, regex) {
  const text = String(value || "").trim().toUpperCase();
  const match = text.match(regex);
  if (!match) return 0;
  const parsed = parseInt(match[1], 10);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Computes maximum numeric sequence values across existing tables so counters never regress.
 */
function computeCounterHighWaterMarks_(ss) {
  let maxAlumni = 0;
  let maxGuest = 0;
  let maxReceipt = 0;
  let maxProgram = PROGRAM_SEEDS.length;

  const scanRefCode = function (code) {
    maxAlumni = Math.max(maxAlumni, extractNumericSequence_(code, /^A(\d{6})$/));
    maxGuest = Math.max(maxGuest, extractNumericSequence_(code, /^G(\d{6})$/));
  };

  // Scan users.ref_code
  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (userSheet && userSheet.getLastRow() > 1) {
    const uMap = getHeaderMap_(userSheet);
    const uData = readSheetMatrix_(userSheet);
    for (let i = 1; i < uData.length; i++) {
      if (uMap.ref_code !== undefined) scanRefCode(uData[i][uMap.ref_code]);
    }
  }

  // Scan donation_intents.ref_code
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (intentSheet && intentSheet.getLastRow() > 1) {
    const iMap = getHeaderMap_(intentSheet);
    const iData = readSheetMatrix_(intentSheet);
    for (let i = 1; i < iData.length; i++) {
      if (iMap.ref_code !== undefined) scanRefCode(iData[i][iMap.ref_code]);
    }
  }

  // Scan transactions.ref_code and transactions.receipt_no
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (txSheet && txSheet.getLastRow() > 1) {
    const tMap = getHeaderMap_(txSheet);
    const tData = readSheetMatrix_(txSheet);
    for (let i = 1; i < tData.length; i++) {
      if (tMap.ref_code !== undefined) scanRefCode(tData[i][tMap.ref_code]);
      if (tMap.receipt_no !== undefined) {
        maxReceipt = Math.max(
          maxReceipt,
          extractNumericSequence_(tData[i][tMap.receipt_no], /^KWT-\d{4}-(\d{6})$/),
        );
      }
    }
  }

  // Scan existing programs sheet if already present
  const prgSheet = ss.getSheetByName(SHEET_NAMES.PROGRAMS);
  if (prgSheet && prgSheet.getLastRow() > 1) {
    const pMap = getHeaderMap_(prgSheet);
    const pData = readSheetMatrix_(prgSheet);
    for (let i = 1; i < pData.length; i++) {
      if (pMap.program_id !== undefined) {
        maxProgram = Math.max(maxProgram, extractNumericSequence_(pData[i][pMap.program_id], /^PRG-(\d{3,})$/));
      }
    }
  }

  return {
    ALUMNI: maxAlumni,
    GUEST: maxGuest,
    RECEIPT: maxReceipt,
    PROGRAM: maxProgram,
  };
}

/**
 * Checks uniqueness of non-empty key column values in a sheet matrix.
 */
function checkUniqueColumnValues_(rows, colIdx, sheetName, colName, blockingErrors) {
  if (colIdx === undefined || colIdx < 0) return;
  const seen = {};
  for (let i = 1; i < rows.length; i++) {
    const val = String(rows[i][colIdx] === undefined ? "" : rows[i][colIdx]).trim();
    if (!val) continue;
    if (seen[val]) {
      blockingErrors.push(
        "Duplicate " + colName + " '" + val + "' in sheet '" + sheetName + "' at row " + (i + 1) + ".",
      );
    } else {
      seen[val] = true;
    }
  }
}

/**
 * Performs read-only preflight inspection across schema headers, data consistency,
 * duplicate IDs, incomplete records, and planned P2 changes.
 *
 * @param {Object=} options - { adminToken, requireAuth, spreadsheet }.
 * @returns {Object} Detailed preflight report (zero mutations performed).
 */
function runMigrationPreflight(options) {
  const opts = options || {};
  if (opts.adminToken !== undefined || opts.requireAuth === true) {
    requireAdmin_(opts.adminToken);
  }

  const ss = opts.spreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Spreadsheet aktif tidak ditemukan untuk preflight migrasi.");
  }

  const blockingErrors = [];
  const warnings = [];
  const headerValidations = {};
  const beforeCounts = {};
  const columnsToAppend = {};
  const baselineNames = Object.keys(SCHEMA_V1_DEFINITIONS);

  // 1. Validate required sheets and headers
  for (let i = 0; i < baselineNames.length; i++) {
    const name = baselineNames[i];
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      blockingErrors.push("Missing required baseline sheet: '" + name + "'.");
      continue;
    }
    beforeCounts[name] = Math.max(0, sheet.getLastRow() - 1);
    const vRes = validateSheetHeaders_(
      sheet,
      SCHEMA_V1_DEFINITIONS[name],
      SCHEMA_V2_DEFINITIONS[name],
    );
    headerValidations[name] = vRes;
    if (!vRes.ok) {
      for (let e = 0; e < vRes.errors.length; e++) {
        blockingErrors.push(vRes.errors[e]);
      }
    }
    if (vRes.missingTargetColumns.length > 0) {
      columnsToAppend[name] = vRes.missingTargetColumns.slice();
    }
  }

  // Validate optional programs sheet if it already exists
  const existingPrgSheet = ss.getSheetByName(SHEET_NAMES.PROGRAMS);
  if (existingPrgSheet) {
    beforeCounts[SHEET_NAMES.PROGRAMS] = Math.max(0, existingPrgSheet.getLastRow() - 1);
    const prgVal = validateSheetHeaders_(
      existingPrgSheet,
      SCHEMA_V2_DEFINITIONS.programs,
      SCHEMA_V2_DEFINITIONS.programs,
    );
    headerValidations[SHEET_NAMES.PROGRAMS] = prgVal;
    if (!prgVal.ok) {
      for (let e = 0; e < prgVal.errors.length; e++) {
        blockingErrors.push(prgVal.errors[e]);
      }
    }
  }

  // Plan counters/programs/normalizations/backfills only when headers can be safely resolved
  const plannedChanges = {
    sheets_to_create: existingPrgSheet ? [] : [SHEET_NAMES.PROGRAMS],
    program_seeds_to_insert: 0,
    columns_to_append: columnsToAppend,
    status_normalizations: {
      users_NONE_to_NOT_SUBMITTED: 0,
      users_VERIFIED_to_APPROVED: 0,
      verifications_VERIFIED_to_APPROVED: 0,
    },
    backfill_counts: {
      donation_intents_rows_needing_backfill: 0,
      transactions_matched_needing_backfill: 0,
      transactions_unmatched_needing_backfill: 0,
      historical_receipts_to_mint: 0,
    },
    counters_sync: {},
    config_keys_to_add: [],
    config_webhook_token_to_retire: false,
  };

  if (blockingErrors.length > 0) {
    return {
      ok: false,
      migration_version: MIGRATION_VERSION,
      inspected_at: new Date().toISOString(),
      before_counts: beforeCounts,
      header_validations: headerValidations,
      planned_changes: plannedChanges,
      blocking_errors: blockingErrors,
      warnings: warnings,
    };
  }

  // 2. Program seeds count check
  if (!existingPrgSheet) {
    plannedChanges.program_seeds_to_insert = PROGRAM_SEEDS.length;
  } else {
    const pMap = getHeaderMap_(existingPrgSheet);
    const pRows = readSheetMatrix_(existingPrgSheet);
    checkUniqueColumnValues_(pRows, pMap.program_id, SHEET_NAMES.PROGRAMS, "program_id", blockingErrors);
    const existingPids = {};
    for (let i = 1; i < pRows.length; i++) {
      existingPids[String(pRows[i][pMap.program_id] || "").trim()] = true;
    }
    for (let s = 0; s < PROGRAM_SEEDS.length; s++) {
      if (!existingPids[PROGRAM_SEEDS[s][0]]) {
        plannedChanges.program_seeds_to_insert++;
      }
    }
  }

  // 3. Check users integrity & legacy status count
  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  const uMap = getHeaderMap_(userSheet);
  const uRows = readSheetMatrix_(userSheet);
  checkUniqueColumnValues_(uRows, uMap.user_id, SHEET_NAMES.USERS, "user_id", blockingErrors);
  checkUniqueColumnValues_(uRows, uMap.email, SHEET_NAMES.USERS, "email", blockingErrors);
  checkUniqueColumnValues_(uRows, uMap.ref_code, SHEET_NAMES.USERS, "ref_code", blockingErrors);

  const userIdsSet = {};
  for (let i = 1; i < uRows.length; i++) {
    const uid = String(uRows[i][uMap.user_id] || "").trim();
    const email = String(uRows[i][uMap.email] || "").trim();
    const verStatus = String(uRows[i][uMap.verification_status] || "").trim().toUpperCase();
    if (!uid || !email) {
      blockingErrors.push("Incomplete user record in 'users' row " + (i + 1) + " (missing user_id or email).");
      continue;
    }
    userIdsSet[uid] = true;
    if (verStatus === "NONE") plannedChanges.status_normalizations.users_NONE_to_NOT_SUBMITTED++;
    if (verStatus === "VERIFIED") plannedChanges.status_normalizations.users_VERIFIED_to_APPROVED++;
  }

  // 4. Check alumni_verifications integrity & legacy status count
  const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  const vMap = getHeaderMap_(verifSheet);
  const vRows = readSheetMatrix_(verifSheet);
  checkUniqueColumnValues_(vRows, vMap.verif_id, SHEET_NAMES.VERIFICATIONS, "verif_id", blockingErrors);
  for (let i = 1; i < vRows.length; i++) {
    const vid = String(vRows[i][vMap.verif_id] || "").trim();
    const uid = String(vRows[i][vMap.user_id] || "").trim();
    const st = String(vRows[i][vMap.status] || "").trim().toUpperCase();
    if (!vid || !uid || !st) {
      blockingErrors.push("Incomplete verification record in 'alumni_verifications' row " + (i + 1) + ".");
    }
    if (st === "VERIFIED") plannedChanges.status_normalizations.verifications_VERIFIED_to_APPROVED++;
  }

  // 5. Check donation_intents integrity & backfill scope
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  const iMap = getHeaderMap_(intentSheet);
  const iRows = readSheetMatrix_(intentSheet);
  checkUniqueColumnValues_(iRows, iMap.intent_id, SHEET_NAMES.INTENTS, "intent_id", blockingErrors);

  const intentIdsSet = {};
  const intentMatchedTxRefs = [];
  for (let i = 1; i < iRows.length; i++) {
    const iid = String(iRows[i][iMap.intent_id] || "").trim();
    const amt = Number(iRows[i][iMap.amount]);
    const st = String(iRows[i][iMap.status] || "").trim().toUpperCase();
    if (!iid || isNaN(amt) || amt <= 0 || !st) {
      blockingErrors.push("Incomplete intent record in 'donation_intents' row " + (i + 1) + ".");
      continue;
    }
    intentIdsSet[iid] = true;
    const mTxId = String(iRows[i][iMap.matched_tx_id] || "").trim();
    if (mTxId) intentMatchedTxRefs.push({ row: i + 1, matched_tx_id: mTxId });

    // Count intent rows missing v2 metadata
    const hasAllV2Meta =
      iMap.is_anonymous !== undefined && String(iRows[i][iMap.is_anonymous] || "").trim() !== "" &&
      iMap.payment_channel !== undefined && String(iRows[i][iMap.payment_channel] || "").trim() !== "" &&
      iMap.donor_type !== undefined && String(iRows[i][iMap.donor_type] || "").trim() !== "" &&
      iMap.program_id !== undefined && String(iRows[i][iMap.program_id] || "").trim() !== "";
    if (!hasAllV2Meta) {
      plannedChanges.backfill_counts.donation_intents_rows_needing_backfill++;
    }
  }

  // 6. Check transactions integrity, backfill scope, & strict UNMATCHED receipt rule
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const tMap = getHeaderMap_(txSheet);
  const tRows = readSheetMatrix_(txSheet);
  checkUniqueColumnValues_(tRows, tMap.tx_id, SHEET_NAMES.TRANSACTIONS, "tx_id", blockingErrors);
  checkUniqueColumnValues_(tRows, tMap.mutation_id, SHEET_NAMES.TRANSACTIONS, "mutation_id", blockingErrors);
  if (tMap.receipt_no !== undefined) {
    checkUniqueColumnValues_(tRows, tMap.receipt_no, SHEET_NAMES.TRANSACTIONS, "receipt_no", blockingErrors);
  }

  const txIdsSet = {};
  for (let i = 1; i < tRows.length; i++) {
    const txId = String(tRows[i][tMap.tx_id] || "").trim();
    const amt = Number(tRows[i][tMap.amount]);
    const matchStatus = String(tRows[i][tMap.match_status] || "").trim().toUpperCase();
    const linkedIntentId = String(tRows[i][tMap.intent_id] || "").trim();
    if (!txId || isNaN(amt) || amt <= 0 || !matchStatus) {
      blockingErrors.push("Incomplete transaction record in 'transactions' row " + (i + 1) + ".");
      continue;
    }
    txIdsSet[txId] = true;

    if (linkedIntentId && !intentIdsSet[linkedIntentId]) {
      warnings.push("Transaction '" + txId + "' references missing intent_id '" + linkedIntentId + "'.");
    }

    const existingReceipt = tMap.receipt_no !== undefined ? String(tRows[i][tMap.receipt_no] || "").trim() : "";
    const existingEmailStatus = tMap.email_status !== undefined ? String(tRows[i][tMap.email_status] || "").trim() : "";
    const isConfirmed = matchStatus === "MATCHED" || matchStatus === "MANUAL_MATCHED";

    if (!isConfirmed && existingReceipt !== "") {
      blockingErrors.push(
        "Integrity violation: non-confirmed transaction '" + txId + "' (" + matchStatus + ") already holds a receipt_no.",
      );
    }

    if (isConfirmed) {
      if (existingReceipt === "") {
        plannedChanges.backfill_counts.historical_receipts_to_mint++;
      }
      if (tMap.payment_channel === undefined || !String(tRows[i][tMap.payment_channel] || "").trim() || !existingEmailStatus) {
        plannedChanges.backfill_counts.transactions_matched_needing_backfill++;
      }
    } else if (tMap.payment_channel === undefined || !existingEmailStatus) {
      plannedChanges.backfill_counts.transactions_unmatched_needing_backfill++;
    }
  }

  // Verify donation_intents.matched_tx_id references existing transaction rows
  for (let m = 0; m < intentMatchedTxRefs.length; m++) {
    if (!txIdsSet[intentMatchedTxRefs[m].matched_tx_id]) {
      warnings.push(
        "donation_intents row " + intentMatchedTxRefs[m].row +
        " references missing matched_tx_id '" + intentMatchedTxRefs[m].matched_tx_id + "'.",
      );
    }
  }

  // 7. Check review_queue completeness
  const qSheet = ss.getSheetByName(SHEET_NAMES.REVIEW_QUEUE);
  const qMap = getHeaderMap_(qSheet);
  const qRows = readSheetMatrix_(qSheet);
  checkUniqueColumnValues_(qRows, qMap.queue_id, SHEET_NAMES.REVIEW_QUEUE, "queue_id", blockingErrors);
  for (let i = 1; i < qRows.length; i++) {
    const qid = String(qRows[i][qMap.queue_id] || "").trim();
    const txRef = String(qRows[i][qMap.tx_id] || "").trim();
    if (!qid || !txRef) {
      blockingErrors.push("Incomplete review_queue record at row " + (i + 1) + ".");
    }
  }

  // 8. Check counters & high-water marks
  const ctrSheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
  const ctrMap = getHeaderMap_(ctrSheet);
  const ctrRows = readSheetMatrix_(ctrSheet);
  checkUniqueColumnValues_(ctrRows, ctrMap.name, SHEET_NAMES.COUNTERS, "name", blockingErrors);

  const currentCounters = {};
  for (let i = 1; i < ctrRows.length; i++) {
    const cName = String(ctrRows[i][ctrMap.name] || "").trim().toUpperCase();
    if (cName) currentCounters[cName] = Number(ctrRows[i][ctrMap.value]) || 0;
  }
  const highWater = computeCounterHighWaterMarks_(ss);
  // Forecast RECEIPT counter value after minting historical receipts
  const forecastReceiptTarget = Math.max(highWater.RECEIPT, currentCounters.RECEIPT || 0) +
    plannedChanges.backfill_counts.historical_receipts_to_mint;

  plannedChanges.counters_sync = {
    ALUMNI: { current: currentCounters.ALUMNI || 0, target_min: Math.max(highWater.ALUMNI, currentCounters.ALUMNI || 0), exists: currentCounters.ALUMNI !== undefined },
    GUEST: { current: currentCounters.GUEST || 0, target_min: Math.max(highWater.GUEST, currentCounters.GUEST || 0), exists: currentCounters.GUEST !== undefined },
    RECEIPT: { current: currentCounters.RECEIPT || 0, target_min: forecastReceiptTarget, exists: currentCounters.RECEIPT !== undefined },
    PROGRAM: { current: currentCounters.PROGRAM || 0, target_min: Math.max(highWater.PROGRAM, currentCounters.PROGRAM || 0), exists: currentCounters.PROGRAM !== undefined },
  };

  // 9. Check config keys and secret hygiene without echoing secret values
  const cfgSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
  const cfgMap = getHeaderMap_(cfgSheet);
  const cfgRows = readSheetMatrix_(cfgSheet);
  checkUniqueColumnValues_(cfgRows, cfgMap.key, SHEET_NAMES.CONFIG, "key", blockingErrors);

  const existingCfg = {};
  for (let i = 1; i < cfgRows.length; i++) {
    const k = String(cfgRows[i][cfgMap.key] || "").trim();
    const v = String(cfgRows[i][cfgMap.value] || "").trim();
    if (k) existingCfg[k] = v;
  }

  for (let c = 0; c < P2_NON_SECRET_CONFIG_SEEDS.length; c++) {
    const keyName = P2_NON_SECRET_CONFIG_SEEDS[c][0];
    if (!Object.prototype.hasOwnProperty.call(existingCfg, keyName)) {
      plannedChanges.config_keys_to_add.push(keyName);
    }
  }

  let legacyWebhookSecretState = "NOT_PRESENT";
  if (Object.prototype.hasOwnProperty.call(existingCfg, "WEBHOOK_TOKEN")) {
    if (existingCfg.WEBHOOK_TOKEN !== "MIGRATED_TO_SCRIPT_PROPERTIES") {
      plannedChanges.config_webhook_token_to_retire = true;
      legacyWebhookSecretState = "[REDACTED_PRESENT_WILL_RETIRE]";
    } else {
      legacyWebhookSecretState = "ALREADY_RETIRED";
    }
  }

  return {
    ok: blockingErrors.length === 0,
    migration_version: MIGRATION_VERSION,
    inspected_at: new Date().toISOString(),
    before_counts: beforeCounts,
    header_validations: headerValidations,
    planned_changes: plannedChanges,
    secret_hygiene: {
      legacy_webhook_token_status: legacyWebhookSecretState,
    },
    blocking_errors: blockingErrors,
    warnings: warnings,
  };
}

/**
 * Captures a read-only structural and historical baseline snapshot for post-migration validation.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Target spreadsheet.
 * @returns {Object} Snapshot containing row counts, leading headers, and immutable key records.
 */
function captureDatabaseSnapshot_(ss) {
  const rowCounts = {};
  const headersBySheet = {};
  const matricesBySheet = {};
  const baselineNames = Object.keys(SCHEMA_V1_DEFINITIONS);

  for (let i = 0; i < baselineNames.length; i++) {
    const name = baselineNames[i];
    const sheet = ss.getSheetByName(name);
    if (!sheet) continue;
    rowCounts[name] = Math.max(0, sheet.getLastRow() - 1);
    headersBySheet[name] = getSheetHeadersList_(sheet);
    // Store shallow-copied historical cells for strict post-migration cell comparison
    const matrix = readSheetMatrix_(sheet);
    matricesBySheet[name] = matrix.map(function (r) {
      return r.slice();
    });
  }

  // Capture immutable historical rows from users, donation_intents, and transactions
  const userRecords = [];
  const uSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (uSheet) {
    const uMap = getHeaderMap_(uSheet);
    const uRows = readSheetMatrix_(uSheet);
    for (let i = 1; i < uRows.length; i++) {
      userRecords.push({
        user_id: String(uRows[i][uMap.user_id] || "").trim(),
        email: String(uRows[i][uMap.email] || "").trim(),
        ref_code: String(uRows[i][uMap.ref_code] || "").trim(),
        verification_status: String(uRows[i][uMap.verification_status] || "").trim().toUpperCase(),
      });
    }
  }

  const intentRecords = [];
  const iSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (iSheet) {
    const iMap = getHeaderMap_(iSheet);
    const iRows = readSheetMatrix_(iSheet);
    for (let i = 1; i < iRows.length; i++) {
      intentRecords.push({
        intent_id: String(iRows[i][iMap.intent_id] || "").trim(),
        ref_code: String(iRows[i][iMap.ref_code] || "").trim(),
        amount: Number(iRows[i][iMap.amount]),
        program: String(iRows[i][iMap.program] || "").trim(),
        status: String(iRows[i][iMap.status] || "").trim(),
        matched_tx_id: String(iRows[i][iMap.matched_tx_id] || "").trim(),
      });
    }
  }

  const txRecords = [];
  const tSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (tSheet) {
    const tMap = getHeaderMap_(tSheet);
    const tRows = readSheetMatrix_(tSheet);
    for (let i = 1; i < tRows.length; i++) {
      txRecords.push({
        tx_id: String(tRows[i][tMap.tx_id] || "").trim(),
        mutation_id: String(tRows[i][tMap.mutation_id] || "").trim(),
        amount: Number(tRows[i][tMap.amount]),
        match_status: String(tRows[i][tMap.match_status] || "").trim(),
        intent_id: String(tRows[i][tMap.intent_id] || "").trim(),
        program: String(tRows[i][tMap.program] || "").trim(),
        receipt_no: tMap.receipt_no !== undefined ? String(tRows[i][tMap.receipt_no] || "").trim() : "",
      });
    }
  }

  return {
    captured_at: new Date().toISOString(),
    row_counts: rowCounts,
    headers_by_sheet: headersBySheet,
    matrices_by_sheet: matricesBySheet,
    users: userRecords,
    intents: intentRecords,
    transactions: txRecords,
  };
}

/**
 * Normalizes legacy verification status strings while respecting the explicit transform map.
 */
function normalizeLegacyVerificationStatus_(statusValue) {
  const val = String(statusValue || "").trim().toUpperCase();
  if (val === "NONE") return "NOT_SUBMITTED";
  if (val === "VERIFIED") return "APPROVED";
  return val;
}

/**
 * Formats sequential receipt numbers as KWT-YYYY-000001.
 */
function formatReceiptNumber_(year, seq) {
  let y = String(year || new Date().getFullYear()).trim();
  if (!/^\d{4}$/.test(y)) {
    y = String(new Date().getFullYear());
  }
  const s = String(seq);
  const padded = s.length >= 6 ? s : ("000000" + s).slice(-6);
  return "KWT-" + y + "-" + padded;
}

/**
 * Extracts a 4-digit year string from a date string or falls back to current year.
 */
function resolveTransactionYear_(txDate, receivedAt) {
  const candidates = [txDate, receivedAt];
  for (let i = 0; i < candidates.length; i++) {
    const m = String(candidates[i] || "").match(/^(\d{4})/);
    if (m) return m[1];
  }
  return String(new Date().getFullYear());
}

/**
 * Ensures target columns exist at the right edge of a sheet without moving or overwriting existing columns.
 */
function appendMissingColumnsToSheet_(sheet, targetHeaders) {
  const currentHeaders = getSheetHeadersList_(sheet);
  const present = {};
  for (let i = 0; i < currentHeaders.length; i++) {
    present[currentHeaders[i]] = true;
  }

  const toAppend = [];
  for (let i = 0; i < targetHeaders.length; i++) {
    if (!present[targetHeaders[i]]) {
      toAppend.push(targetHeaders[i]);
    }
  }

  if (toAppend.length === 0) {
    return 0;
  }

  const startCol = currentHeaders.length + 1;
  sheet.getRange(1, startCol, 1, toAppend.length).setValues([toAppend]);
  sheet
    .getRange(1, startCol, 1, toAppend.length)
    .setFontWeight("bold")
    .setBackground("#E2E8F0");
  return toAppend.length;
}

/**
 * Builds a lookup map of program name -> program_id from the programs sheet.
 */
function getProgramNameToIdMap_(prgSheet) {
  const map = {};
  if (!prgSheet || prgSheet.getLastRow() <= 1) return map;
  const pHeader = getHeaderMap_(prgSheet);
  const rows = readSheetMatrix_(prgSheet);
  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][pHeader.program_id] || "").trim();
    const pName = String(rows[i][pHeader.name] || "").trim();
    if (pid && pName) {
      map[pName.toLowerCase()] = pid;
    }
  }
  return map;
}

/**
 * Builds a lookup map of user_id -> { full_name, email } from users sheet for backfill enrichment.
 */
function getUsersByIdForMigration_(userSheet) {
  const map = {};
  if (!userSheet || userSheet.getLastRow() <= 1) return map;
  const uHeader = getHeaderMap_(userSheet);
  const rows = readSheetMatrix_(userSheet);
  for (let i = 1; i < rows.length; i++) {
    const uid = String(rows[i][uHeader.user_id] || "").trim();
    if (uid) {
      map[uid] = {
        full_name: String(rows[i][uHeader.full_name] || "").trim(),
        email: String(rows[i][uHeader.email] || "").trim(),
      };
    }
  }
  return map;
}

/**
 * Verifies exact staging target safety by checking both:
 * 1) ScriptProperties.EXPECTED_STAGING_SPREADSHEET_ID exact match, and
 * 2) Active spreadsheet name starting with 'STAGING_'.
 * Fails closed immediately if either requirement is absent or mismatched.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Candidate target spreadsheet.
 * @returns {Object} Verified { id, name } metadata.
 */
function assertStagingSpreadsheetTarget_(ss) {
  if (!ss) {
    throw new Error("Safety Abort: Target spreadsheet tidak ditemukan.");
  }
  const actualId = typeof ss.getId === "function" ? String(ss.getId() || "").trim() : "";
  const actualName = typeof ss.getName === "function" ? String(ss.getName() || "").trim() : "";

  let expectedId = "";
  try {
    const props = PropertiesService.getScriptProperties();
    expectedId = props ? String(props.getProperty("EXPECTED_STAGING_SPREADSHEET_ID") || "").trim() : "";
  } catch (ignorePropErr) {
    expectedId = "";
  }

  if (!expectedId) {
    throw new Error("Safety Abort: ScriptProperties.EXPECTED_STAGING_SPREADSHEET_ID belum diisi.");
  }
  if (!actualId || actualId !== expectedId) {
    throw new Error("Safety Abort: Spreadsheet ID tidak cocok dengan EXPECTED_STAGING_SPREADSHEET_ID.");
  }
  if (actualName.indexOf("STAGING_") !== 0) {
    throw new Error("Safety Abort: Nama spreadsheet target wajib diawali 'STAGING_'.");
  }
  return { id: actualId, name: actualName };
}

/**
 * Executes non-destructive idempotent database migration with safe DRY_RUN default.
 * Defaults to dryRun = true unless options.dryRun === false is explicitly passed.
 * Unconditionally enforces Staging Guard (EXPECTED_STAGING_SPREADSHEET_ID + 'STAGING_' prefix)
 * whenever dryRun === false, before LockService, backup, snapshot, or mutation.
 *
 * @param {Object=} options - { dryRun, adminToken, requireAuth, enforceStagingGuard, spreadsheet, backupVerified, autoBackup, _simulateFailureAtStep }.
 * @returns {Object} Structured migration execution or dry-run report.
 */
function migrateDatabaseNonDestructive(options) {
  const opts = options || {};
  const dryRun = !(opts.dryRun === false);

  if (opts.adminToken !== undefined || opts.requireAuth === true) {
    requireAdmin_(opts.adminToken);
  }

  const ss = opts.spreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Spreadsheet aktif tidak ditemukan untuk migrasi.");
  }

  // Enforce exact Staging Guard unconditionally for actual mutations (dryRun: false),
  // while allowing read-only DRY_RUN inspection unless enforceStagingGuard: true is requested.
  if (!dryRun || opts.enforceStagingGuard === true) {
    assertStagingSpreadsheetTarget_(ss);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  const executionLog = [];
  let currentStep = "preflight";

  try {
    // Step 1: Mandatory read-only preflight check before touching any cell
    const preflight = runMigrationPreflight({ spreadsheet: ss });
    executionLog.push({ step: "preflight", ok: preflight.ok });

    if (!preflight.ok) {
      return {
        status: "aborted",
        dry_run: dryRun,
        mutated: false,
        migration_version: MIGRATION_VERSION,
        reason: "Preflight validation failed.",
        preflight: preflight,
        execution_log: executionLog,
      };
    }

    // Return detailed DRY_RUN plan immediately without mutating any sheet or property
    if (dryRun) {
      return {
        status: "dry_run_ok",
        dry_run: true,
        mutated: false,
        migration_version: MIGRATION_VERSION,
        preflight: preflight,
        planned_operations: preflight.planned_changes,
        message: "DRY_RUN selesai tanpa mengubah satu sel pun di database.",
        execution_log: executionLog,
      };
    }

    // Require verified backup before actual mutation unless autoBackup handles it
    let backupResult = null;
    if (opts.backupVerified !== true) {
      if (opts.autoBackup === false) {
        throw new Error("Migrasi aktual diblokir: backup terverifikasi wajib tersedia sebelum dryRun=false.");
      }
      currentStep = "auto_backup";
      backupResult = createMigrationBackup({
        sourceSpreadsheet: ss,
        migrationVersion: MIGRATION_VERSION,
        writeAuditLog: false,
      });
      executionLog.push({ step: "auto_backup", backup_id: backupResult.backup.backup_id, verified: true });
    }

    // Capture baseline snapshot before first write for post-migration integrity comparison
    const beforeSnapshot = captureDatabaseSnapshot_(ss);
    const nowIso = new Date().toISOString();

    // Step 2: Ensure programs sheet exists (6 columns) and insert missing seed programs idempotently
    currentStep = "programs_sheet";
    let prgSheet = ss.getSheetByName(SHEET_NAMES.PROGRAMS);
    if (!prgSheet) {
      prgSheet = initSheetWithHeaders_(ss, SHEET_NAMES.PROGRAMS, SCHEMA_V2_DEFINITIONS.programs);
    } else {
      appendMissingColumnsToSheet_(prgSheet, SCHEMA_V2_DEFINITIONS.programs);
    }

    const prgMap = getHeaderMap_(prgSheet);
    const prgRows = readSheetMatrix_(prgSheet);
    const existingPrgIds = {};
    for (let i = 1; i < prgRows.length; i++) {
      existingPrgIds[String(prgRows[i][prgMap.program_id] || "").trim()] = true;
    }

    let insertedSeeds = 0;
    for (let s = 0; s < PROGRAM_SEEDS.length; s++) {
      const seed = PROGRAM_SEEDS[s];
      if (!existingPrgIds[seed[0]]) {
        prgSheet.appendRow([seed[0], seed[1], seed[2], seed[3], nowIso, nowIso]);
        insertedSeeds++;
      }
    }
    executionLog.push({ step: "programs_sheet", inserted_seeds: insertedSeeds });

    // Step 3: Append new columns strictly at the right edge of existing tables
    currentStep = "append_headers";
    const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
    const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    const intentAddedCols = appendMissingColumnsToSheet_(intentSheet, SCHEMA_V2_DEFINITIONS.donation_intents);
    const txAddedCols = appendMissingColumnsToSheet_(txSheet, SCHEMA_V2_DEFINITIONS.transactions);
    executionLog.push({
      step: "append_headers",
      donation_intents_added: intentAddedCols,
      transactions_added: txAddedCols,
    });

    // Controlled test hook for verifying recovery behavior when mid-migration failure occurs
    if (opts._simulateFailureAtStep === "after_headers") {
      throw new Error("Simulated mid-migration failure after header expansion.");
    }

    // Step 4: Normalize legacy status strings in users and alumni_verifications
    currentStep = "normalize_statuses";
    let updatedUsersCount = 0;
    const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
    const uMap = getHeaderMap_(userSheet);
    const uRows = readSheetMatrix_(userSheet);
    for (let i = 1; i < uRows.length; i++) {
      const curStatus = String(uRows[i][uMap.verification_status] || "").trim().toUpperCase();
      const nextStatus = normalizeLegacyVerificationStatus_(curStatus);
      if (nextStatus !== curStatus) {
        userSheet.getRange(i + 1, uMap.verification_status + 1).setValue(nextStatus);
        updatedUsersCount++;
      }
    }

    let updatedVerifCount = 0;
    const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
    const vMap = getHeaderMap_(verifSheet);
    const vRows = readSheetMatrix_(verifSheet);
    for (let i = 1; i < vRows.length; i++) {
      const curVerif = String(vRows[i][vMap.status] || "").trim().toUpperCase();
      const nextVerif = curVerif === "VERIFIED" ? "APPROVED" : curVerif;
      if (nextVerif !== curVerif) {
        verifSheet.getRange(i + 1, vMap.status + 1).setValue(nextVerif);
        updatedVerifCount++;
      }
    }
    executionLog.push({
      step: "normalize_statuses",
      users_updated: updatedUsersCount,
      verifications_updated: updatedVerifCount,
    });

    // Step 5: Seed and synchronize counters without regressing past existing numeric IDs
    currentStep = "sync_counters";
    const ctrSheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
    const ctrMap = getHeaderMap_(ctrSheet);
    const ctrRows = readSheetMatrix_(ctrSheet);
    const highWater = computeCounterHighWaterMarks_(ss);
    const ctrRowIdxByName = {};
    const ctrValByName = {};
    for (let i = 1; i < ctrRows.length; i++) {
      const cName = String(ctrRows[i][ctrMap.name] || "").trim().toUpperCase();
      if (cName) {
        ctrRowIdxByName[cName] = i + 1;
        ctrValByName[cName] = Number(ctrRows[i][ctrMap.value]) || 0;
      }
    }

    for (let s = 0; s < P2_COUNTER_SEEDS.length; s++) {
      const name = P2_COUNTER_SEEDS[s][0];
      const defaultFloor = P2_COUNTER_SEEDS[s][1];
      const targetVal = Math.max(defaultFloor, highWater[name] || 0, ctrValByName[name] || 0);
      if (ctrRowIdxByName[name]) {
        if (targetVal > ctrValByName[name]) {
          ctrSheet.getRange(ctrRowIdxByName[name], ctrMap.value + 1).setValue(targetVal);
        }
        ctrValByName[name] = targetVal;
      } else {
        ctrSheet.appendRow([name, targetVal]);
        ctrRowIdxByName[name] = ctrSheet.getLastRow();
        ctrValByName[name] = targetVal;
      }
    }
    executionLog.push({ step: "sync_counters", values: { ...ctrValByName } });

    // Step 6: Selective idempotent backfill of new columns in donation_intents (never touches cols 1..10)
    currentStep = "backfill_intents";
    const prgNameToId = getProgramNameToIdMap_(prgSheet);
    const usersById = getUsersByIdForMigration_(userSheet);
    const iMap = getHeaderMap_(intentSheet);
    const iRows = readSheetMatrix_(intentSheet);
    let props = null;
    try {
      props = PropertiesService.getScriptProperties();
    } catch (ignoreProps) {
      props = null;
    }

    const intentById = {};
    let backfilledIntents = 0;
    for (let i = 1; i < iRows.length; i++) {
      const row = iRows[i];
      const intentId = String(row[iMap.intent_id] || "").trim();
      const userId = String(row[iMap.user_id] || "").trim();
      const refCode = String(row[iMap.ref_code] || "").trim().toUpperCase();
      const progName = String(row[iMap.program] || "").trim();
      const donorProfile = usersById[userId] || { full_name: "", email: "" };
      const bridgeKey = "INTENT_ANON_" + intentId;
      const bridgeAnon = props ? props.getProperty(bridgeKey) : null;

      const defaults = {
        is_anonymous: bridgeAnon === "YES" || bridgeAnon === "NO" ? bridgeAnon : "NO",
        payment_channel: "MANUAL_TRANSFER",
        donor_type: refCode.indexOf("G") === 0 ? "GUEST" : "ALUMNI",
        donor_name: donorProfile.full_name,
        donor_email: donorProfile.email,
        program_id: prgNameToId[progName.toLowerCase()] || "PRG-001",
      };

      let rowChanged = false;
      const defaultKeys = Object.keys(defaults);
      for (let d = 0; d < defaultKeys.length; d++) {
        const col = defaultKeys[d];
        const colIdx = iMap[col];
        if (colIdx !== undefined && String(row[colIdx] === undefined ? "" : row[colIdx]).trim() === "" && defaults[col] !== "") {
          intentSheet.getRange(i + 1, colIdx + 1).setValue(defaults[col]);
          row[colIdx] = defaults[col];
          rowChanged = true;
        }
      }
      if (rowChanged) backfilledIntents++;

      intentById[intentId] = {
        donor_type: String(row[iMap.donor_type] || defaults.donor_type),
        donor_email: String(row[iMap.donor_email] || defaults.donor_email),
        program_id: String(row[iMap.program_id] || defaults.program_id),
      };
    }
    executionLog.push({ step: "backfill_intents", backfilled_rows: backfilledIntents });

    if (opts._simulateFailureAtStep === "after_intents") {
      throw new Error("Simulated mid-migration failure after donation_intents backfill.");
    }

    // Step 7: Selective idempotent backfill of new columns in transactions (never touches cols 1..17)
    currentStep = "backfill_transactions";
    const tMap = getHeaderMap_(txSheet);
    const tRows = readSheetMatrix_(txSheet);
    let receiptSeq = ctrValByName.RECEIPT || 0;
    let backfilledTx = 0;
    let mintedReceipts = 0;

    for (let i = 1; i < tRows.length; i++) {
      const row = tRows[i];
      const matchStatus = String(row[tMap.match_status] || "").trim().toUpperCase();
      const isConfirmed = matchStatus === "MATCHED" || matchStatus === "MANUAL_MATCHED";
      const refCode = String(row[tMap.ref_code] || "").trim().toUpperCase();
      const userId = String(row[tMap.user_id] || "").trim();
      const linkedIntentId = String(row[tMap.intent_id] || "").trim();
      const progName = String(row[tMap.program] || "").trim();
      const amountVal = Number(row[tMap.amount]) || 0;
      const donorProfile = usersById[userId] || (intentById[linkedIntentId] ? { email: intentById[linkedIntentId].donor_email } : { email: "" });

      const resolvedDonorType = isConfirmed
        ? (refCode.indexOf("G") === 0 ? "GUEST" : (intentById[linkedIntentId] ? intentById[linkedIntentId].donor_type : "ALUMNI"))
        : "UNIDENTIFIED";

      const txUpdates = {
        donor_type: resolvedDonorType,
        donor_email: isConfirmed ? (donorProfile.email || "") : "",
        program_id: prgNameToId[progName.toLowerCase()] || (progName.toLowerCase() === "umum" ? "PRG-UMUM" : "PRG-001"),
        payment_channel: "MANUAL_TRANSFER",
        gateway_payment_type: "manual_bank",
        gateway_status: isConfirmed ? "MANUAL_CONFIRMED" : "UNMATCHED",
        gross_amount: amountVal,
        gateway_fee: 0,
        net_amount: amountVal,
        email_status: isConfirmed ? "SENT" : "NOT_APPLICABLE",
      };

      // Strictly only confirmed transactions may receive historical receipt_no
      const currentReceipt = String(row[tMap.receipt_no] === undefined ? "" : row[tMap.receipt_no]).trim();
      if (isConfirmed && currentReceipt === "") {
        receiptSeq++;
        const txYear = resolveTransactionYear_(row[tMap.tx_date], row[tMap.received_at]);
        txUpdates.receipt_no = formatReceiptNumber_(txYear, receiptSeq);
        txUpdates.receipt_issued_at = String(row[tMap.received_at] || nowIso);
        mintedReceipts++;
      }

      let txChanged = false;
      const txKeys = Object.keys(txUpdates);
      for (let k = 0; k < txKeys.length; k++) {
        const colName = txKeys[k];
        const colIdx = tMap[colName];
        const existingCell = String(row[colIdx] === undefined ? "" : row[colIdx]).trim();
        if (colIdx !== undefined && existingCell === "" && txUpdates[colName] !== "") {
          txSheet.getRange(i + 1, colIdx + 1).setValue(txUpdates[colName]);
          txChanged = true;
        }
      }
      if (txChanged) backfilledTx++;
    }

    // Update RECEIPT counter after minting historical receipts
    if (receiptSeq > (ctrValByName.RECEIPT || 0)) {
      ctrSheet.getRange(ctrRowIdxByName.RECEIPT, ctrMap.value + 1).setValue(receiptSeq);
    }
    executionLog.push({
      step: "backfill_transactions",
      backfilled_rows: backfilledTx,
      minted_receipts: mintedReceipts,
      receipt_counter_final: receiptSeq,
    });

    // Step 8: Add missing non-secret operational configs & retire WEBHOOK_TOKEN from Sheet cells
    currentStep = "update_config";
    const cfgSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
    const cfgMap = getHeaderMap_(cfgSheet);
    const cfgRows = readSheetMatrix_(cfgSheet);
    const cfgRowIdxByKey = {};
    for (let i = 1; i < cfgRows.length; i++) {
      const k = String(cfgRows[i][cfgMap.key] || "").trim();
      if (k) cfgRowIdxByKey[k] = i + 1;
    }

    let addedCfgCount = 0;
    for (let c = 0; c < P2_NON_SECRET_CONFIG_SEEDS.length; c++) {
      const cfgSeed = P2_NON_SECRET_CONFIG_SEEDS[c];
      if (!cfgRowIdxByKey[cfgSeed[0]]) {
        cfgSheet.appendRow(cfgSeed);
        addedCfgCount++;
      }
    }

    let retiredWebhookToken = false;
    if (cfgRowIdxByKey.WEBHOOK_TOKEN) {
      const rowNum = cfgRowIdxByKey.WEBHOOK_TOKEN;
      const curVal = String(cfgRows[rowNum - 1][cfgMap.value] || "").trim();
      if (curVal !== "MIGRATED_TO_SCRIPT_PROPERTIES") {
        cfgSheet.getRange(rowNum, cfgMap.value + 1).setValue("MIGRATED_TO_SCRIPT_PROPERTIES");
        retiredWebhookToken = true;
      }
    }
    executionLog.push({
      step: "update_config",
      added_keys: addedCfgCount,
      retired_webhook_token: retiredWebhookToken,
    });

    // Step 9: Post-migration integrity verification against beforeSnapshot
    currentStep = "validate_integrity";
    const integrity = validateMigrationIntegrity_(beforeSnapshot, ss);
    executionLog.push({ step: "validate_integrity", ok: integrity.ok });
    if (!integrity.ok) {
      throw new Error("Post-migration integrity check failed: " + integrity.errors.join(" | "));
    }

    // Write sanitized completion audit entry strictly to target migrated spreadsheet
    appendMigrationAuditLog_(
      ss,
      "SYSTEM_MIGRATION",
      "MIGRATION_P2_COMPLETED",
      MIGRATION_VERSION,
      "Non-destructive migration completed cleanly. Minted historical receipts: " + mintedReceipts,
    );

    return {
      status: "migrated_ok",
      dry_run: false,
      mutated: true,
      migration_version: MIGRATION_VERSION,
      backup: backupResult ? backupResult.backup : null,
      execution_log: executionLog,
      integrity: integrity,
    };
  } catch (err) {
    if (!dryRun) {
      appendMigrationAuditLog_(
        ss,
        "SYSTEM_MIGRATION",
        "MIGRATION_FAILED",
        currentStep,
        "Migration stopped safely at step '" + currentStep + "': " + (err.message || String(err)),
      );
    }
    const errOut = new Error(
      "Migration aborted at step '" + currentStep + "': " + (err.message || String(err)) +
      ". Restore from verified backup using restoreDatabaseFromBackup() before retrying.",
    );
    errOut.failedStep = currentStep;
    errOut.executionLog = executionLog;
    throw errOut;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Validates database integrity after migration by comparing against pre-migration snapshot.
 * Ensures zero lost rows, immutable historical fields, unique receipts, and zero receipts on UNMATCHED.
 *
 * @param {Object} beforeSnapshot - Output captured from captureDatabaseSnapshot_(ss) prior to writes.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Migrated spreadsheet instance.
 * @returns {Object} Detailed integrity check report.
 */
function validateMigrationIntegrity_(beforeSnapshot, ss) {
  const errors = [];
  const targetSs = ss || SpreadsheetApp.getActiveSpreadsheet();
  if (!beforeSnapshot || !targetSs) {
    return { ok: false, errors: ["Missing beforeSnapshot or target spreadsheet."] };
  }

  // 1. Verify exact baseline row count preservation & prefix header invariance across all 9 baseline tabs
  const baselineNames = Object.keys(SCHEMA_V1_DEFINITIONS);
  for (let i = 0; i < baselineNames.length; i++) {
    const name = baselineNames[i];
    const sheet = targetSs.getSheetByName(name);
    if (!sheet) {
      errors.push("Baseline sheet missing after migration: " + name);
      continue;
    }

    const afterCount = Math.max(0, sheet.getLastRow() - 1);
    const beforeCount = beforeSnapshot.row_counts[name] || 0;
    // Note: counters and config may legally grow via append-only P2 seeds; transactional/entity tables must stay identical
    const isTransactionalOrEntity =
      name !== SHEET_NAMES.COUNTERS &&
      name !== SHEET_NAMES.CONFIG &&
      name !== SHEET_NAMES.AUDIT_LOG;

    if (isTransactionalOrEntity && afterCount !== beforeCount) {
      errors.push("Row count changed on '" + name + "': before=" + beforeCount + ", after=" + afterCount);
    } else if (!isTransactionalOrEntity && afterCount < beforeCount) {
      errors.push("Rows unexpectedly removed on '" + name + "': before=" + beforeCount + ", after=" + afterCount);
    }

    const prevHeaders = beforeSnapshot.headers_by_sheet[name] || [];
    const afterHeaders = getSheetHeadersList_(sheet);
    for (let c = 0; c < prevHeaders.length; c++) {
      if (afterHeaders[c] !== prevHeaders[c]) {
        errors.push(
          "Baseline header altered on '" + name + "' col " + (c + 1) +
          ": before='" + prevHeaders[c] + "', after='" + (afterHeaders[c] || "") + "'",
        );
      }
    }

    // Verify all historical leading columns remained bit-for-bit identical except explicit transformation rules
    if (
      beforeSnapshot.matrices_by_sheet &&
      beforeSnapshot.matrices_by_sheet[name] &&
      (name === SHEET_NAMES.INTENTS ||
        name === SHEET_NAMES.TRANSACTIONS ||
        name === SHEET_NAMES.REVIEW_QUEUE ||
        name === SHEET_NAMES.KEYWORDS ||
        name === SHEET_NAMES.USERS ||
        name === SHEET_NAMES.VERIFICATIONS)
    ) {
      const prevMatrix = beforeSnapshot.matrices_by_sheet[name];
      const curMatrix = readSheetMatrix_(sheet);
      const baselineWidth = SCHEMA_V1_DEFINITIONS[name].length;
      for (let r = 1; r < prevMatrix.length; r++) {
        const oldRow = prevMatrix[r] || [];
        const newRow = curMatrix[r] || [];
        for (let c = 0; c < baselineWidth; c++) {
          const oldVal = oldRow[c] === undefined ? "" : String(oldRow[c]);
          const newVal = newRow[c] === undefined ? "" : String(newRow[c]);
          if (oldVal === newVal) continue;
          if (name === SHEET_NAMES.USERS && c === 6 && normalizeLegacyVerificationStatus_(oldVal) === newVal) {
            continue;
          }
          if (name === SHEET_NAMES.VERIFICATIONS && c === 8 && String(oldVal).toUpperCase() === "VERIFIED" && newVal === "APPROVED") {
            continue;
          }
          errors.push(
            "Historical cell mutated on '" + name + "' R" + (r + 1) + "C" + (c + 1) +
            ": before='" + oldVal + "', after='" + newVal + "'",
          );
        }
      }
    }

    const expectedTargetLen = SCHEMA_V2_DEFINITIONS[name].length;
    if (afterHeaders.length !== expectedTargetLen) {
      errors.push(
        "Target column count mismatch on '" + name + "': expected " + expectedTargetLen + ", got " + afterHeaders.length,
      );
    }
  }

  // 2. Verify new programs sheet matches 6 columns
  const prgSheet = targetSs.getSheetByName(SHEET_NAMES.PROGRAMS);
  if (!prgSheet) {
    errors.push("Target sheet 'programs' was not created.");
  } else if (getSheetHeadersList_(prgSheet).length !== SCHEMA_V2_DEFINITIONS.programs.length) {
    errors.push("Sheet 'programs' header count does not match 6.");
  }

  // 3. Verify users historical identities, ref_codes, and status transformation rules
  const uSheet = targetSs.getSheetByName(SHEET_NAMES.USERS);
  const uMap = getHeaderMap_(uSheet);
  const uRows = readSheetMatrix_(uSheet);
  for (let i = 0; i < beforeSnapshot.users.length; i++) {
    const oldU = beforeSnapshot.users[i];
    const newRow = uRows[i + 1] || [];
    const expectedStatus = normalizeLegacyVerificationStatus_(oldU.verification_status);
    if (String(newRow[uMap.user_id] || "").trim() !== oldU.user_id) {
      errors.push("User ID mutated at users row " + (i + 2));
    }
    if (String(newRow[uMap.ref_code] || "").trim() !== oldU.ref_code) {
      errors.push("User ref_code mutated at users row " + (i + 2));
    }
    if (String(newRow[uMap.verification_status] || "").trim().toUpperCase() !== expectedStatus) {
      errors.push("User verification_status failed transform rule at row " + (i + 2));
    }
  }

  // 4. Verify donation_intents cols 1..10 immutability
  const iSheet = targetSs.getSheetByName(SHEET_NAMES.INTENTS);
  const iMap = getHeaderMap_(iSheet);
  const iRows = readSheetMatrix_(iSheet);
  for (let i = 0; i < beforeSnapshot.intents.length; i++) {
    const oldI = beforeSnapshot.intents[i];
    const newRow = iRows[i + 1] || [];
    if (
      String(newRow[iMap.intent_id] || "").trim() !== oldI.intent_id ||
      String(newRow[iMap.ref_code] || "").trim() !== oldI.ref_code ||
      Number(newRow[iMap.amount]) !== oldI.amount ||
      String(newRow[iMap.program] || "").trim() !== oldI.program ||
      String(newRow[iMap.status] || "").trim() !== oldI.status ||
      String(newRow[iMap.matched_tx_id] || "").trim() !== oldI.matched_tx_id
    ) {
      errors.push("Historical intent fields altered for intent_id '" + oldI.intent_id + "'.");
    }
  }

  // 5. Verify transactions immutability, unique receipts, and strict zero-receipt on UNMATCHED
  const tSheet = targetSs.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const tMap = getHeaderMap_(tSheet);
  const tRows = readSheetMatrix_(tSheet);
  const seenReceipts = {};
  for (let i = 0; i < beforeSnapshot.transactions.length; i++) {
    const oldT = beforeSnapshot.transactions[i];
    const newRow = tRows[i + 1] || [];
    const newStatus = String(newRow[tMap.match_status] || "").trim().toUpperCase();
    const newReceipt = String(newRow[tMap.receipt_no] || "").trim();

    if (
      String(newRow[tMap.tx_id] || "").trim() !== oldT.tx_id ||
      String(newRow[tMap.mutation_id] || "").trim() !== oldT.mutation_id ||
      Number(newRow[tMap.amount]) !== oldT.amount ||
      newStatus !== String(oldT.match_status || "").toUpperCase() ||
      String(newRow[tMap.intent_id] || "").trim() !== oldT.intent_id ||
      String(newRow[tMap.program] || "").trim() !== oldT.program
    ) {
      errors.push("Historical transaction fields altered for tx_id '" + oldT.tx_id + "'.");
    }

    if (oldT.receipt_no && newReceipt !== oldT.receipt_no) {
      errors.push("Existing receipt_no changed for tx_id '" + oldT.tx_id + "'.");
    }

    if (newStatus === "UNMATCHED" && newReceipt !== "") {
      errors.push("Integrity error: UNMATCHED transaction '" + oldT.tx_id + "' received a receipt_no.");
    }

    if (newReceipt !== "") {
      if (seenReceipts[newReceipt]) {
        errors.push("Duplicate receipt_no detected after migration: '" + newReceipt + "'.");
      }
      seenReceipts[newReceipt] = true;
    }
  }

  return {
    ok: errors.length === 0,
    validated_at: new Date().toISOString(),
    checked_users: beforeSnapshot.users.length,
    checked_intents: beforeSnapshot.intents.length,
    checked_transactions: beforeSnapshot.transactions.length,
    unique_receipts_count: Object.keys(seenReceipts).length,
    errors: errors,
  };
}

/**
 * Restores a spreadsheet's sheets and cell contents exactly from a verified backup spreadsheet.
 * Intended for controlled recovery if a partial migration or post-migration anomaly occurs.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} targetSs - Spreadsheet to restore.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet|string} backupSource - Backup Spreadsheet object or Drive file ID.
 * @param {Object=} options - { adminToken, requireAuth }.
 * @returns {Object} Restoration verification summary.
 */
function restoreDatabaseFromBackup(targetSs, backupSource, options) {
  const opts = options || {};
  if (opts.adminToken !== undefined || opts.requireAuth === true) {
    requireAdmin_(opts.adminToken);
  }

  const ss = targetSs || SpreadsheetApp.getActiveSpreadsheet();
  const backupSs = typeof backupSource === "string"
    ? SpreadsheetApp.openById(backupSource)
    : backupSource;

  if (!ss || !backupSs) {
    throw new Error("Target or backup spreadsheet is missing for restore.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const backupSheetNames = {};
    const backupSheets = typeof backupSs.getSheets === "function" ? backupSs.getSheets() : [];
    for (let i = 0; i < backupSheets.length; i++) {
      backupSheetNames[backupSheets[i].getName()] = true;
    }

    // Fallback to known schema names if custom mock lacks getSheets()
    if (backupSheets.length === 0) {
      const baselineNames = Object.keys(SCHEMA_V1_DEFINITIONS);
      for (let i = 0; i < baselineNames.length; i++) {
        if (backupSs.getSheetByName(baselineNames[i])) {
          backupSheetNames[baselineNames[i]] = true;
        }
      }
      if (backupSs.getSheetByName(SHEET_NAMES.PROGRAMS)) {
        backupSheetNames[SHEET_NAMES.PROGRAMS] = true;
      }
    }

    // Restore each sheet matrix cleanly from backup
    const namesToRestore = Object.keys(backupSheetNames);
    for (let i = 0; i < namesToRestore.length; i++) {
      const sName = namesToRestore[i];
      const bSheet = backupSs.getSheetByName(sName);
      let tSheet = ss.getSheetByName(sName);
      if (!tSheet) {
        tSheet = ss.insertSheet(sName);
      } else if (typeof tSheet.clearContents === "function") {
        tSheet.clearContents();
      }
      const bMatrix = readSheetMatrix_(bSheet);
      if (bMatrix.length > 0 && bMatrix[0].length > 0) {
        tSheet.getRange(1, 1, bMatrix.length, bMatrix[0].length).setValues(bMatrix);
      }
    }

    // Remove newly created post-migration tabs (e.g. programs) that did not exist in the backup
    if (typeof ss.getSheets === "function" && typeof ss.deleteSheet === "function") {
      const curSheets = ss.getSheets().slice();
      for (let i = 0; i < curSheets.length; i++) {
        const curName = curSheets[i].getName();
        if (!backupSheetNames[curName]) {
          ss.deleteSheet(curSheets[i]);
        }
      }
    }

    // Confirm post-restore spreadsheet matches backup identically
    const verifyRestore = verifyMigrationBackup(backupSs, ss, MIGRATION_VERSION);
    if (!verifyRestore.ok) {
      throw new Error("Post-restore parity check failed: " + verifyRestore.errors.join(" | "));
    }

    return {
      status: "restored_ok",
      restored_at: new Date().toISOString(),
      verification: verifyRestore,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Authorized administrative entrypoint for P2.1 backup creation, preflight, and DRY_RUN.
 * Does NOT perform any write mutations against live data tables during DRY_RUN.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @param {Object=} options - Optional { createBackup: boolean }.
 * @returns {Object} Preflight + DRY_RUN + optional verified backup report.
 */
function adminRunMigrationPreflightAndDryRun(adminToken, options) {
  requireAdmin_(adminToken);
  const opts = options || {};
  const ss = opts.spreadsheet || SpreadsheetApp.getActiveSpreadsheet();

  const dryRunResult = migrateDatabaseNonDestructive({
    dryRun: true,
    spreadsheet: ss,
    adminToken: adminToken,
    requireAuth: true,
    enforceStagingGuard: opts.enforceStagingGuard === true,
  });

  let backupInfo = null;
  if (opts.createBackup === true) {
    const bak = createMigrationBackup({
      sourceSpreadsheet: ss,
      adminToken: adminToken,
      requireAuth: true,
      migrationVersion: MIGRATION_VERSION,
    });
    backupInfo = bak.backup;
  }

  return {
    status: dryRunResult.status,
    dry_run: true,
    mutated: false,
    preflight: dryRunResult.preflight,
    planned_operations: dryRunResult.planned_operations,
    backup: backupInfo,
  };
}

/**
 * Compares an actual sheet header array against expected V2 headers by exact name and order.
 *
 * @param {string[]} actualHeaders - Header row read from sheet.
 * @param {string[]} expectedHeaders - Canonical V2 schema headers.
 * @returns {string|null} Failure reason if mismatched, otherwise null.
 */
function checkExactHeaders_(actualHeaders, expectedHeaders) {
  // Verify column count before comparing individual column names
  if (actualHeaders.length !== expectedHeaders.length) {
    return "Expected " + expectedHeaders.length + " columns, got " + actualHeaders.length + ".";
  }
  for (let i = 0; i < expectedHeaders.length; i++) {
    if (actualHeaders[i] !== expectedHeaders[i]) {
      return (
        "Header mismatch at column " + (i + 1) +
        ": expected '" + expectedHeaders[i] + "', got '" + (actualHeaders[i] || "") + "'."
      );
    }
  }
  return null;
}

/**
 * Executes a strict, header-mapped PASS/FAIL post-migration inspection against a staging copy.
 * Verifies all V2 structural invariants without logging secrets, tokens, or admin emails.
 *
 * @param {Object=} options - Optional { spreadsheet, skipLog }.
 * @returns {Object} Structured PASS/FAIL report for all mandatory post-migration invariants.
 */
function inspectStagingPostMigrationDetails(options) {
  const opts = options || {};
  const ss = opts.spreadsheet || SpreadsheetApp.getActiveSpreadsheet();

  // Fail closed unless inspecting the ID- and prefix-verified staging spreadsheet
  assertStagingSpreadsheetTarget_(ss);

  const checks = {};
  const recordCheck = function (key, ok, reason, details) {
    checks[key] = Object.assign(
      {
        status: ok ? "PASS" : "FAIL",
        reason: ok ? "" : String(reason || "Invariant failed."),
      },
      details || {},
    );
  };

  // 1. Verify exact 10 V2 sheets exist without missing or unexpected tabs
  const expectedSheetNames = Object.keys(SCHEMA_V2_DEFINITIONS);
  const actualSheets = ss.getSheets();
  const actualSheetNames = actualSheets.map(function (s) { return s.getName(); });
  const missingSheets = expectedSheetNames.filter(function (n) {
    return actualSheetNames.indexOf(n) === -1;
  });
  const unexpectedSheets = actualSheetNames.filter(function (n) {
    return expectedSheetNames.indexOf(n) === -1;
  });
  const sheetsOk =
    actualSheetNames.length === expectedSheetNames.length &&
    missingSheets.length === 0 &&
    unexpectedSheets.length === 0;
  recordCheck(
    "v2_sheet_count_and_names",
    sheetsOk,
    "Expected " + expectedSheetNames.length + " V2 sheets (got " + actualSheetNames.length +
      ", missing=" + JSON.stringify(missingSheets) + ", unexpected=" + JSON.stringify(unexpectedSheets) + ").",
    {
      expected_sheet_count: expectedSheetNames.length,
      actual_sheet_count: actualSheetNames.length,
      missing_sheets: missingSheets,
      unexpected_sheets: unexpectedSheets,
    },
  );

  // 2. Verify programs sheet contains all 5 expected seeds and zero duplicate IDs
  const prgSheet = ss.getSheetByName(SHEET_NAMES.PROGRAMS);
  if (!prgSheet) {
    recordCheck("programs_seed_integrity", false, "Sheet 'programs' is missing.");
  } else {
    const prgHeaders = getSheetHeadersList_(prgSheet);
    const prgHeaderErr = checkExactHeaders_(prgHeaders, SCHEMA_V2_DEFINITIONS.programs);
    const pMap = getHeaderMap_(prgSheet);
    const pRows = readSheetMatrix_(prgSheet);

    const seenPids = {};
    const duplicatePids = [];
    let blankIdRows = 0;
    for (let i = 1; i < pRows.length; i++) {
      const pid = pMap.program_id !== undefined ? String(pRows[i][pMap.program_id] || "").trim() : "";
      if (!pid) {
        blankIdRows++;
        continue;
      }
      if (seenPids[pid]) {
        duplicatePids.push(pid);
      }
      seenPids[pid] = true;
    }

    const expectedSeedIds = PROGRAM_SEEDS.map(function (seed) { return seed[0]; });
    const missingSeedIds = expectedSeedIds.filter(function (id) { return !seenPids[id]; });
    const prgOk =
      !prgHeaderErr &&
      pMap.program_id !== undefined &&
      missingSeedIds.length === 0 &&
      duplicatePids.length === 0 &&
      blankIdRows === 0;

    let prgReason = "";
    if (prgHeaderErr) prgReason = "Sheet 'programs' header invalid: " + prgHeaderErr;
    else if (pMap.program_id === undefined) prgReason = "Missing 'program_id' header in 'programs'.";
    else if (missingSeedIds.length > 0) prgReason = "Missing seed program IDs: " + missingSeedIds.join(", ");
    else if (duplicatePids.length > 0) prgReason = "Duplicate program IDs detected: " + duplicatePids.join(", ");
    else if (blankIdRows > 0) prgReason = "Found " + blankIdRows + " row(s) with empty program_id.";

    recordCheck("programs_seed_integrity", prgOk, prgReason, {
      programs_total: Object.keys(seenPids).length,
      expected_seed_count: expectedSeedIds.length,
      missing_seed_ids: missingSeedIds,
      duplicate_program_ids: duplicatePids,
    });
  }

  // 3. Verify donation_intents (21 cols) and transactions (35 cols) with exact V2 headers
  const intentsSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const intentHeaders = intentsSheet ? getSheetHeadersList_(intentsSheet) : [];
  const txHeaders = txSheet ? getSheetHeadersList_(txSheet) : [];
  const intentErr = intentsSheet
    ? checkExactHeaders_(intentHeaders, SCHEMA_V2_DEFINITIONS.donation_intents)
    : "Sheet 'donation_intents' is missing.";
  const txErr = txSheet
    ? checkExactHeaders_(txHeaders, SCHEMA_V2_DEFINITIONS.transactions)
    : "Sheet 'transactions' is missing.";
  const schemaColsOk = !intentErr && !txErr;
  const schemaFailParts = [];
  if (intentErr) schemaFailParts.push("donation_intents: " + intentErr);
  if (txErr) schemaFailParts.push("transactions: " + txErr);

  recordCheck("schema_columns_intents_and_transactions", schemaColsOk, schemaFailParts.join(" "), {
    donation_intents_columns: intentHeaders.length,
    donation_intents_expected: SCHEMA_V2_DEFINITIONS.donation_intents.length,
    transactions_columns: txHeaders.length,
    transactions_expected: SCHEMA_V2_DEFINITIONS.transactions.length,
  });

  // 4. Verify counters ALUMNI, GUEST, RECEIPT, PROGRAM meet minimum actual data high-water marks
  const ctrSheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
  const minMarks = computeCounterHighWaterMarks_(ss);
  const requiredCounters = ["ALUMNI", "GUEST", "RECEIPT", "PROGRAM"];
  if (!ctrSheet) {
    recordCheck("counters_minimum_watermarks", false, "Sheet 'counters' is missing.");
  } else {
    const cMap = getHeaderMap_(ctrSheet);
    if (cMap.name === undefined || cMap.value === undefined) {
      recordCheck("counters_minimum_watermarks", false, "Missing 'name' or 'value' column in 'counters'.");
    } else {
      const cRows = readSheetMatrix_(ctrSheet);
      const actualCounters = {};
      const dupCounters = [];
      for (let i = 1; i < cRows.length; i++) {
        const cName = String(cRows[i][cMap.name] || "").trim().toUpperCase();
        if (!cName) continue;
        if (actualCounters[cName] !== undefined) {
          dupCounters.push(cName);
        }
        actualCounters[cName] = Number(cRows[i][cMap.value]);
      }

      const counterDetails = {};
      const counterErrors = [];
      if (dupCounters.length > 0) {
        counterErrors.push("Duplicate counter rows: " + dupCounters.join(", "));
      }
      for (let i = 0; i < requiredCounters.length; i++) {
        const key = requiredCounters[i];
        const actualVal = actualCounters[key];
        const minExpected = minMarks[key];
        const isNum = typeof actualVal === "number" && !isNaN(actualVal);
        const meetsMin = isNum && actualVal >= minExpected;
        counterDetails[key] = {
          actual: isNum ? actualVal : null,
          min_expected: minExpected,
          ok: meetsMin,
        };
        if (!isNum) {
          counterErrors.push("Counter '" + key + "' missing or non-numeric.");
        } else if (!meetsMin) {
          counterErrors.push("Counter '" + key + "' (" + actualVal + ") is below minimum (" + minExpected + ").");
        }
      }

      recordCheck(
        "counters_minimum_watermarks",
        counterErrors.length === 0,
        counterErrors.join(" "),
        { counters: counterDetails },
      );
    }
  }

  // 5 & 6. Verify receipt uniqueness and strict zero-receipt invariant on UNMATCHED in transactions
  if (!txSheet) {
    recordCheck("unique_receipt_numbers", false, "Sheet 'transactions' is missing.");
    recordCheck("unmatched_transactions_zero_receipt", false, "Sheet 'transactions' is missing.");
  } else {
    const tMap = getHeaderMap_(txSheet);
    const tRows = readSheetMatrix_(txSheet);

    // 5. Unique receipt_no across all transactions
    if (tMap.receipt_no === undefined) {
      recordCheck("unique_receipt_numbers", false, "Missing 'receipt_no' header in 'transactions'.");
    } else {
      const seenReceipts = {};
      const duplicateReceipts = [];
      let totalIssuedReceipts = 0;
      for (let i = 1; i < tRows.length; i++) {
        const recNo = String(tRows[i][tMap.receipt_no] || "").trim();
        if (!recNo) continue;
        totalIssuedReceipts++;
        if (seenReceipts[recNo]) {
          duplicateReceipts.push(recNo);
        }
        seenReceipts[recNo] = true;
      }
      recordCheck(
        "unique_receipt_numbers",
        duplicateReceipts.length === 0,
        "Duplicate receipt_no values found: " + duplicateReceipts.join(", "),
        {
          total_issued_receipts: totalIssuedReceipts,
          duplicate_receipt_count: duplicateReceipts.length,
        },
      );
    }

    // 6. UNMATCHED transactions in 'transactions' (read via match_status & receipt_no headers)
    if (tMap.match_status === undefined || tMap.receipt_no === undefined) {
      recordCheck(
        "unmatched_transactions_zero_receipt",
        false,
        "Missing required 'match_status' or 'receipt_no' header in 'transactions'.",
      );
    } else {
      let unmatchedCount = 0;
      let unmatchedWithReceiptCount = 0;
      const violatingTxIds = [];
      for (let i = 1; i < tRows.length; i++) {
        const mStatus = String(tRows[i][tMap.match_status] || "").trim().toUpperCase();
        if (mStatus !== "UNMATCHED") continue;
        unmatchedCount++;
        const recNo = String(tRows[i][tMap.receipt_no] || "").trim();
        if (recNo !== "") {
          unmatchedWithReceiptCount++;
          if (tMap.tx_id !== undefined) {
            violatingTxIds.push(String(tRows[i][tMap.tx_id] || "row_" + (i + 1)));
          }
        }
      }
      recordCheck(
        "unmatched_transactions_zero_receipt",
        unmatchedWithReceiptCount === 0,
        unmatchedWithReceiptCount + " UNMATCHED transaction(s) illegally have a receipt_no (tx_ids=" +
          JSON.stringify(violatingTxIds) + ").",
        {
          unmatched_count: unmatchedCount,
          unmatched_with_receipt_count: unmatchedWithReceiptCount,
          violating_tx_ids: violatingTxIds,
        },
      );
    }
  }

  // 7. Verify legacy WEBHOOK_TOKEN placeholder in config without ever logging raw config values
  const cfgSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
  if (!cfgSheet) {
    recordCheck("legacy_webhook_token_placeholder", false, "Sheet 'config' is missing.");
  } else {
    const cfgMap = getHeaderMap_(cfgSheet);
    if (cfgMap.key === undefined || cfgMap.value === undefined) {
      recordCheck("legacy_webhook_token_placeholder", false, "Missing 'key' or 'value' column in 'config'.");
    } else {
      const cfgRows = readSheetMatrix_(cfgSheet);
      let webhookRowFound = false;
      let webhookPlaceholderValid = false;
      const configKeys = [];
      for (let i = 1; i < cfgRows.length; i++) {
        const k = String(cfgRows[i][cfgMap.key] || "").trim();
        if (!k) continue;
        configKeys.push(k);
        if (k === "WEBHOOK_TOKEN") {
          webhookRowFound = true;
          webhookPlaceholderValid =
            String(cfgRows[i][cfgMap.value] || "").trim() === "MIGRATED_TO_SCRIPT_PROPERTIES";
        }
      }
      const webhookOk = !webhookRowFound || webhookPlaceholderValid;
      recordCheck(
        "legacy_webhook_token_placeholder",
        webhookOk,
        "Legacy 'WEBHOOK_TOKEN' row in config does not equal placeholder 'MIGRATED_TO_SCRIPT_PROPERTIES'.",
        {
          webhook_token_row_present: webhookRowFound,
          webhook_token_placeholder_ok: webhookOk,
          config_key_count: configKeys.length,
        },
      );
    }
  }

  // 8. Verify ScriptProperties.ALLOW_MOCK_AUTH is not 'true' (without exposing value)
  let allowMockRaw = "";
  try {
    const props = PropertiesService.getScriptProperties();
    allowMockRaw = props ? String(props.getProperty("ALLOW_MOCK_AUTH") || "").trim().toLowerCase() : "";
  } catch (ignoreAllowErr) {
    allowMockRaw = "";
  }
  const allowMockOk = allowMockRaw !== "true";
  recordCheck(
    "allow_mock_auth_not_true",
    allowMockOk,
    "ScriptProperties.ALLOW_MOCK_AUTH must not be 'true'.",
    { allow_mock_auth_not_true: allowMockOk },
  );

  // Aggregate overall PASS/FAIL status across all mandatory invariants
  const checkNames = Object.keys(checks);
  const failedInvariants = checkNames
    .filter(function (name) { return checks[name].status !== "PASS"; })
    .map(function (name) { return { check: name, reason: checks[name].reason }; });

  const report = {
    overall_status: failedInvariants.length === 0 ? "PASS" : "FAIL",
    total_checks: checkNames.length,
    passed_count: checkNames.length - failedInvariants.length,
    failed_count: failedInvariants.length,
    failed_invariants: failedInvariants,
    checks: checks,
    runtime_scope_note:
      "Structural and invariant checks only against target staging spreadsheet and ScriptProperties; does not substitute for full live GAS runtime QA.",
  };

  if (opts.skipLog !== true) {
    Logger.log(JSON.stringify(report));
  }

  return report;
}

/**
 * Verifies required staging ScriptProperties presence and confirms ALLOW_MOCK_AUTH === 'false'
 * without printing any secret, token, pepper, credential, or admin email values.
 *
 * @param {Object=} options - Optional { skipLog }.
 * @returns {Object} Redacted SET/MISSING presence report and Gate 1 readiness flag.
 */
function verifyStagingPropsPresence_(options) {
  const opts = options || {};
  const props = PropertiesService.getScriptProperties();
  const keys = [
    "EXPECTED_STAGING_SPREADSHEET_ID",
    "ADMIN_EMAILS",
    "GOOGLE_CLIENT_ID",
    "WEBHOOK_MANUAL_SECRET",
    "TOKEN_PEPPER",
    "ALLOW_MOCK_AUTH",
  ];

  // Inspect only presence (SET/MISSING) for each required key
  const propertiesStatus = {};
  let allSet = true;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const raw = props ? props.getProperty(key) : null;
    const isSet = raw !== null && String(raw).trim() !== "";
    propertiesStatus[key] = isSet ? "SET" : "MISSING";
    if (!isSet) {
      allSet = false;
    }
  }

  // Confirm ALLOW_MOCK_AUTH is explicitly set to 'false'
  const allowMockVal = props ? String(props.getProperty("ALLOW_MOCK_AUTH") || "").trim().toLowerCase() : "";
  const allowMockIsFalse = allowMockVal === "false";

  const report = {
    overall_status: allSet && allowMockIsFalse ? "PASS" : "FAIL",
    properties: propertiesStatus,
    allow_mock_auth_is_false: allowMockIsFalse,
  };

  if (opts.skipLog !== true) {
    Logger.log(JSON.stringify(report));
  }

  return report;
}

/**
 * Public Apps Script editor runner alias (without trailing underscore so it appears in the Run dropdown).
 *
 * @param {Object=} options - Optional { skipLog }.
 * @returns {Object} Redacted SET/MISSING presence report and Gate 1 readiness flag.
 */
function verifyStagingPropsPresence(options) {
  // Delegate directly to verifyStagingPropsPresence_ so it is selectable in the GAS IDE toolbar
  return verifyStagingPropsPresence_(options);
}

/**
 * Gate 1 Staging Runner: Executes a guarded, read-only DRY_RUN on the staging spreadsheet
 * and logs a redacted JSON summary ready for review before any mutation is approved.
 *
 * @param {Object=} options - Optional { spreadsheet, skipLog }.
 * @returns {Object} Redacted DRY_RUN summary.
 */
function runStagingP2DryRun(options) {
  const opts = options || {};
  const res = migrateDatabaseNonDestructive({
    dryRun: true,
    enforceStagingGuard: true,
    spreadsheet: opts.spreadsheet,
  });

  // Build redacted Gate 1 summary without exposing secrets or spreadsheet IDs
  const summary = {
    status: res.status,
    dry_run: res.dry_run,
    mutated: res.mutated,
    migration_version: res.migration_version,
    preflight_ok: res.preflight ? res.preflight.ok : false,
    blocking_errors: res.preflight ? res.preflight.blocking_errors : [],
    warnings: res.preflight ? res.preflight.warnings : [],
    before_counts: res.preflight ? res.preflight.before_counts : null,
    planned_operations: res.planned_operations || null,
    secret_hygiene: res.preflight ? res.preflight.secret_hygiene : null,
  };

  if (opts.skipLog !== true) {
    Logger.log(JSON.stringify(summary));
  }

  return summary;
}

/**
 * Gate 2 Staging Runner: Executes the guarded P2.2 migration with mandatory verified auto-backup
 * on the staging spreadsheet and logs a redacted JSON summary.
 *
 * @param {Object=} options - Optional { spreadsheet, skipLog }.
 * @returns {Object} Redacted migration and backup verification summary.
 */
function runStagingP2Migration(options) {
  const opts = options || {};
  const res = migrateDatabaseNonDestructive({
    dryRun: false,
    autoBackup: true,
    enforceStagingGuard: true,
    spreadsheet: opts.spreadsheet,
  });

  // Build redacted Gate 2 summary omitting raw Spreadsheet IDs and URLs
  const summary = {
    status: res.status,
    dry_run: res.dry_run,
    mutated: res.mutated,
    migration_version: res.migration_version,
    backup: res.backup
      ? {
          backup_name: res.backup.backup_name,
          migration_version: res.backup.migration_version,
          created_at: res.backup.created_at,
          sheet_count: res.backup.sheet_count,
          verified: res.backup.verified,
        }
      : null,
    execution_log: res.execution_log || [],
    integrity: res.integrity
      ? {
          ok: res.integrity.ok,
          checked_users: res.integrity.checked_users,
          checked_intents: res.integrity.checked_intents,
          checked_transactions: res.integrity.checked_transactions,
          unique_receipts_count: res.integrity.unique_receipts_count,
          errors: res.integrity.errors,
        }
      : null,
  };

  if (opts.skipLog !== true) {
    Logger.log(JSON.stringify(summary));
  }

  return summary;
}
