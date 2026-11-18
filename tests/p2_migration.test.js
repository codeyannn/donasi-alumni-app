/**
 * p2_migration.test.js
 * Comprehensive verification suite for Phase P2.1 (Backup, Preflight, DRY_RUN,
 * Idempotent Non-Destructive Migration on Database Copy, Failure Guardrails, & Restore).
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAS_DIR = path.join(ROOT_DIR, "apps-script");

/**
 * Creates a full in-memory Google Spreadsheet VM harness supporting ss.copy(),
 * ss.getSheets(), ss.deleteSheet(), clearContents(), ScriptProperties, and LockService.
 */
function createP2Harness(initialProps = {}) {
  const spreadsheetRegistry = {};
  let spreadsheetCounter = 0;
  const metrics = {
    lockWaitCount: 0,
    copyCalls: 0,
    logs: [],
  };

  function makeSpreadsheet(initialName) {
    spreadsheetCounter++;
    const ssId = "SS_" + spreadsheetCounter;
    let ssName = initialName || "DonasiAlumniApp_TestDB";
    const sheetOrder = [];
    const sheetsByName = {};

    function makeSheet(name, initialRows = []) {
      const rows = initialRows.map((r) => [...r]);
      const sheetObj = {
        getName: () => name,
        getLastRow: () => rows.length,
        getLastColumn: () => {
          let maxC = 0;
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].length > maxC) maxC = rows[i].length;
          }
          return maxC;
        },
        appendRow: (row) => rows.push([...row]),
        clearContents: () => {
          rows.length = 0;
        },
        getDataRange: () => ({
          getValues: () => rows.map((r) => [...r]),
        }),
        getRange: (startRow, startCol, numRows = 1, numCols = 1) => ({
          getValues: () => {
            const out = [];
            for (let r = 0; r < numRows; r++) {
              const rowArr = rows[startRow - 1 + r] || [];
              const slice = [];
              for (let c = 0; c < numCols; c++) {
                const val = rowArr[startCol - 1 + c];
                slice.push(val === undefined ? "" : val);
              }
              out.push(slice);
            }
            return out;
          },
          getValue: () => {
            const rowArr = rows[startRow - 1] || [];
            const val = rowArr[startCol - 1];
            return val === undefined ? "" : val;
          },
          setValue: (val) => {
            while (rows.length < startRow) rows.push([]);
            while (rows[startRow - 1].length < startCol) rows[startRow - 1].push("");
            rows[startRow - 1][startCol - 1] = val;
          },
          setValues: (matrix) => {
            for (let r = 0; r < matrix.length; r++) {
              const targetR = startRow - 1 + r;
              while (rows.length <= targetR) rows.push([]);
              for (let c = 0; c < matrix[r].length; c++) {
                const targetC = startCol - 1 + c;
                while (rows[targetR].length <= targetC) rows[targetR].push("");
                rows[targetR][targetC] = matrix[r][c];
              }
            }
          },
          setFontWeight: () => sheetObj.getRange(startRow, startCol, numRows, numCols),
          setBackground: () => sheetObj.getRange(startRow, startCol, numRows, numCols),
        }),
        setFrozenRows: () => {},
        _rows: rows,
      };
      return sheetObj;
    }

    const ssObj = {
      getId: () => ssId,
      getName: () => ssName,
      getUrl: () => "https://docs.google.com/spreadsheets/d/" + ssId,
      getSheetByName: (name) => sheetsByName[name] || null,
      getSheets: () => sheetOrder.map((n) => sheetsByName[n]),
      insertSheet: (name) => {
        if (sheetsByName[name]) return sheetsByName[name];
        const s = makeSheet(name);
        sheetsByName[name] = s;
        sheetOrder.push(name);
        return s;
      },
      deleteSheet: (sheetOrName) => {
        const targetName = typeof sheetOrName === "string" ? sheetOrName : sheetOrName.getName();
        delete sheetsByName[targetName];
        const idx = sheetOrder.indexOf(targetName);
        if (idx !== -1) sheetOrder.splice(idx, 1);
      },
      copy: (copyName) => {
        metrics.copyCalls++;
        const cloned = makeSpreadsheet(copyName || ssName + "_Copy");
        for (let i = 0; i < sheetOrder.length; i++) {
          const sName = sheetOrder[i];
          const cSheet = cloned.insertSheet(sName);
          const matrix = sheetsByName[sName].getDataRange().getValues();
          if (matrix.length > 0 && matrix[0].length > 0) {
            cSheet.getRange(1, 1, matrix.length, matrix[0].length).setValues(matrix);
          }
        }
        return cloned;
      },
    };

    spreadsheetRegistry[ssId] = ssObj;
    return ssObj;
  }

  let activeSpreadsheet = makeSpreadsheet("DonasiAlumniApp_LiveMock");

  const scriptProps = {
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p2_test_hmac_secret_32bytes_value",
    ...initialProps,
  };
  const scriptCache = {};
  const userCache = {};
  const tokenDirectory = {};
  const sentEmails = [];

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSpreadsheet,
      openById: (id) => spreadsheetRegistry[id] || null,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
        setProperty: (k, v) => {
          scriptProps[k] = String(v);
        },
        deleteProperty: (k) => {
          delete scriptProps[k];
        },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in scriptCache ? scriptCache[k] : null),
        put: (k, v) => {
          scriptCache[k] = String(v);
        },
      }),
      getUserCache: () => ({
        get: (k) => (k in userCache ? userCache[k] : null),
        put: (k, v) => {
          userCache[k] = String(v);
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          metrics.lockWaitCount++;
        },
        releaseLock: () => {},
      }),
    },
    MailApp: { sendEmail: (obj) => sentEmails.push(obj) },
    DriveApp: {
      Access: { ANYONE: "ANYONE" },
      Permission: { NONE: "NONE" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({ setSharing: () => {}, createFile: () => ({ getId: () => "f1", setSharing: () => {} }) }),
    },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5", SHA_256: "SHA_256", SHA_512: "SHA_512" },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => new Date(d).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_"),
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
      computeDigest: (algo, input) => {
        const alg = algo === "SHA_256" ? "sha256" : algo === "SHA_512" ? "sha512" : "md5";
        return Array.from(crypto.createHash(alg).update(String(input), "utf8").digest());
      },
    },
    UrlFetchApp: {
      fetch: (url) => {
        const qIdx = url.indexOf("id_token=");
        const tok = qIdx >= 0 ? decodeURIComponent(url.slice(qIdx + "id_token=".length)) : "";
        const rec = tokenDirectory[tok];
        if (!rec) return { getResponseCode: () => 401, getContentText: () => "{}" };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(rec) };
      },
    },
    Logger: { log: (msg) => metrics.logs.push(String(msg)) },
  };

  vm.createContext(sandbox);
  for (const file of ["Setup.gs", "Logic.gs", "AuditLog.gs", "Auth.gs", "Notifier.gs", "Users.gs", "Code.gs"]) {
    const code = fs.readFileSync(path.join(GAS_DIR, file), "utf8");
    vm.runInContext(code, sandbox, { filename: file });
  }

  return {
    sandbox,
    scriptProps,
    sentEmails,
    getMetrics: () => ({
      lockWaitCount: metrics.lockWaitCount,
      copyCalls: metrics.copyCalls,
      logs: [...metrics.logs],
    }),
    resetMetrics: () => {
      metrics.lockWaitCount = 0;
      metrics.copyCalls = 0;
      metrics.logs.length = 0;
    },
    getActiveSpreadsheet: () => activeSpreadsheet,
    setActiveSpreadsheet: (ss) => {
      activeSpreadsheet = ss;
    },
    registerOAuthToken: (tok, claims) => {
      tokenDirectory[tok] = {
        aud: scriptProps.GOOGLE_CLIENT_ID,
        email_verified: "true",
        ...claims,
      };
    },
  };
}

/**
 * Deeply snapshots every sheet, header, and row in a Spreadsheet for zero-mutation proofs.
 */
function dumpSpreadsheetState(ss) {
  const out = {};
  for (const s of ss.getSheets()) {
    out[s.getName()] = s.getDataRange().getValues();
  }
  return out;
}

/**
 * Seeds realistic historical v1 baseline data (users, verifications, intents, transactions, etc.).
 */
function seedRealisticLegacyDatabase(harness) {
  const { sandbox, registerOAuthToken } = harness;
  sandbox.setupSheets();

  const adminToken = "tok_admin_p2";
  const alumniToken = "tok_alumni_p2";
  registerOAuthToken(adminToken, { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin UPI" });
  registerOAuthToken(alumniToken, { sub: "sub_alu", email: "alumni.lama@upi.edu", name: "Ahmad Ridwan" });

  const ss = harness.getActiveSpreadsheet();

  // Populate historical users with mixed legacy statuses (NONE, VERIFIED, PENDING, REJECTED)
  const uSheet = ss.getSheetByName("users");
  uSheet.appendRow(["USR_001", "sub_adm", "maulanaa1408@upi.edu", "Admin UPI", "ADMIN", "A000001", "VERIFIED", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
  uSheet.appendRow(["USR_002", "sub_alu", "alumni.lama@upi.edu", "Ahmad Ridwan", "ALUMNI", "A000471", "VERIFIED", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"]);
  uSheet.appendRow(["USR_003", "sub_none", "baru@upi.edu", "Budi Santoso", "ALUMNI", "", "NONE", "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z"]);
  uSheet.appendRow(["USR_004", "sub_pend", "pending@upi.edu", "Citra Dewi", "ALUMNI", "", "PENDING", "2026-01-04T00:00:00Z", "2026-01-04T00:00:00Z"]);
  uSheet.appendRow(["USR_005", "sub_rej", "ditolak@upi.edu", "Doni Pratama", "ALUMNI", "", "REJECTED", "2026-01-05T00:00:00Z", "2026-01-05T00:00:00Z"]);

  // Populate alumni_verifications with historical VERIFIED and PENDING tickets
  const vSheet = ss.getSheetByName("alumni_verifications");
  vSheet.appendRow(["VRF_001", "USR_002", "alumni.lama@upi.edu", "Ahmad Ridwan", "2001234", "2024", "FPMIPA", "file_1", "VERIFIED", "2026-01-02T01:00:00Z", "maulanaa1408@upi.edu", "2026-01-02T02:00:00Z", ""]);
  vSheet.appendRow(["VRF_002", "USR_004", "pending@upi.edu", "Citra Dewi", "2105678", "2025", "FPTK", "file_2", "PENDING", "2026-01-04T01:00:00Z", "", "", ""]);

  // Populate historical donation_intents (Alumni + Guest non-account)
  const iSheet = ss.getSheetByName("donation_intents");
  iSheet.appendRow(["INT_001", "USR_002", "A000471", 250000, "BCA", "Beasiswa Prestasi", "MATCHED", "2026-02-10T10:00:00Z", "2026-02-11T10:00:00Z", "TX_001"]);
  iSheet.appendRow(["INT_002", "", "G000012", 150000, "BNI", "Wakaf Pendidikan", "PENDING", "2026-02-11T10:00:00Z", "2026-02-12T10:00:00Z", ""]);

  // Populate historical transactions (MATCHED, MANUAL_MATCHED, UNMATCHED)
  const tSheet = ss.getSheetByName("transactions");
  tSheet.appendRow(["TX_001", "MUT_001", "2026-02-10T10:05:00Z", "BCA", "123****890", "2026-02-10", 250000, "TRSF A000471 PRESTASI", "AHMAD RIDWAN", "A***d R.", "MATCHED", "1", "USR_002", "A000471", "INT_001", "Beasiswa Prestasi", "NO"]);
  tSheet.appendRow(["TX_002", "MUT_002", "2026-02-10T12:00:00Z", "BSI", "999****111", "2026-02-10", 100000, "INFAQ ANONIM", "SITI AMINAH", "Seseorang", "MANUAL_MATCHED", "MANUAL", "USR_002", "A000471", "", "Infaq Operasional", "YES"]);
  tSheet.appendRow(["TX_003", "MUT_003", "2026-02-11T08:00:00Z", "BRI", "444****222", "2026-02-11", 500000, "TRANSFER TANPA KODE", "", "Pengirim Tidak Tercatat", "UNMATCHED", "3", "", "", "", "Umum", "NO"]);

  // Populate review_queue for TX_003
  const qSheet = ss.getSheetByName("review_queue");
  qSheet.appendRow(["QUE_001", "TX_003", "BRI", 500000, "2026-02-11", "TRANSFER TANPA KODE", "NO_MATCHING_CANDIDATE", 0, "PENDING", "", "", "", ""]);

  // Counters initially lower than max historical ID to test counter synchronization
  const ctrSheet = ss.getSheetByName("counters");
  ctrSheet.getRange(2, 1, 2, 2).setValues([["ALUMNI", 10], ["GUEST", 5]]);

  // Legacy config row containing deprecated WEBHOOK_TOKEN secret
  const cfgSheet = ss.getSheetByName("config");
  cfgSheet.appendRow(["WEBHOOK_TOKEN", "LEGACY_SECRET_SHOULD_BE_RETIRED", "Old insecure webhook token"]);

  return { adminToken, alumniToken };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}\n     ${err.stack || err.message}`);
      failed++;
    }
  }

  console.log("🗄️ RUNNING PHASE P2.1 MIGRATION, BACKUP, PREFLIGHT & DRY-RUN TESTS...\n");

  test("Backup & Verification: creates timestamped versioned backup covering all sheets and verifies cell-by-cell parity", () => {
    const h = createP2Harness();
    const { adminToken } = seedRealisticLegacyDatabase(h);
    const sourceSs = h.getActiveSpreadsheet();

    // Add a programs sheet copy case too, plus an audit row, to verify full dynamic coverage
    const res = h.sandbox.createMigrationBackup({
      adminToken,
      requireAuth: true,
      sourceSpreadsheet: sourceSs,
      writeAuditLog: true,
    });

    assert.strictEqual(res.status, "ok");
    assert.strictEqual(res.backup.verified, true);
    assert.strictEqual(res.backup.migration_version, "P2_V2.0.0");
    assert.ok(res.backup.backup_name.startsWith("BACKUP_DonasiAlumniApp_P2_V2.0.0_"));

    const expectedNames = ["users", "alumni_verifications", "donation_intents", "transactions", "review_queue", "counters", "audit_log", "config", "program_keywords"];
    const backedUpNames = res.backup.sheets.map((s) => s.name);
    for (const req of expectedNames) {
      assert.ok(backedUpNames.includes(req), `Backup missing required sheet: ${req}`);
    }

    // Corrupt a cell in the backup copy and verify verifyMigrationBackup detects the corruption
    res.backupSpreadsheet.getSheetByName("transactions").getRange(2, 7).setValue(999999);
    const badCheck = h.sandbox.verifyMigrationBackup(sourceSs, res.backupSpreadsheet, "P2_V2.0.0");
    assert.strictEqual(badCheck.ok, false);
    assert.ok(badCheck.errors.some((e) => e.includes("Cell content mismatch") || e.includes("transactions")));
  });

  test("Authorization & Secret Hygiene: blocks non-admin and never leaks legacy secret value in preflight/dry-run", () => {
    const h = createP2Harness();
    const { alumniToken } = seedRealisticLegacyDatabase(h);

    assert.throws(() => h.sandbox.adminRunMigrationPreflightAndDryRun(alumniToken, {}), /Forbidden/);
    assert.throws(() => h.sandbox.createMigrationBackup({ adminToken: alumniToken }), /Forbidden/);
    assert.throws(() => h.sandbox.migrateDatabaseNonDestructive({ adminToken: alumniToken, dryRun: false }), /Forbidden/);

    const preflight = h.sandbox.runMigrationPreflight({});
    const serialized = JSON.stringify(preflight);
    assert.strictEqual(preflight.secret_hygiene.legacy_webhook_token_status, "[REDACTED_PRESENT_WILL_RETIRE]");
    assert.ok(!serialized.includes("LEGACY_SECRET_SHOULD_BE_RETIRED"), "Preflight output leaked legacy secret");
  });

  test("DRY_RUN Zero-Mutation Proof: computes exact plan without altering any cell or sheet", () => {
    const h = createP2Harness();
    const { adminToken } = seedRealisticLegacyDatabase(h);
    const ss = h.getActiveSpreadsheet();

    const beforeDump = dumpSpreadsheetState(ss);
    const defaultDry = h.sandbox.migrateDatabaseNonDestructive();
    const adminDry = h.sandbox.adminRunMigrationPreflightAndDryRun(adminToken, {});
    const afterDump = dumpSpreadsheetState(ss);

    assert.strictEqual(defaultDry.status, "dry_run_ok");
    assert.strictEqual(defaultDry.dry_run, true);
    assert.strictEqual(defaultDry.mutated, false);
    assert.strictEqual(adminDry.mutated, false);

    // Normalize cross-realm VM array before deepStrictEqual comparison
    assert.deepStrictEqual(JSON.parse(JSON.stringify(adminDry.planned_operations.sheets_to_create)), ["programs"]);
    assert.strictEqual(adminDry.planned_operations.program_seeds_to_insert, 5);
    assert.strictEqual(adminDry.planned_operations.columns_to_append.donation_intents.length, 11);
    assert.strictEqual(adminDry.planned_operations.columns_to_append.transactions.length, 18);
    assert.strictEqual(adminDry.planned_operations.status_normalizations.users_NONE_to_NOT_SUBMITTED, 1);
    assert.strictEqual(adminDry.planned_operations.status_normalizations.users_VERIFIED_to_APPROVED, 2);
    assert.strictEqual(adminDry.planned_operations.status_normalizations.verifications_VERIFIED_to_APPROVED, 1);
    assert.strictEqual(adminDry.planned_operations.backfill_counts.historical_receipts_to_mint, 2);
    assert.strictEqual(adminDry.planned_operations.counters_sync.ALUMNI.target_min, 471);
    assert.strictEqual(adminDry.planned_operations.counters_sync.GUEST.target_min, 12);
    assert.strictEqual(adminDry.planned_operations.counters_sync.RECEIPT.target_min, 2);
    assert.strictEqual(adminDry.planned_operations.config_webhook_token_to_retire, true);

    // Bit-for-bit equality proof that zero cells/tabs changed
    assert.deepStrictEqual(afterDump, beforeDump);
    assert.strictEqual(ss.getSheetByName("programs"), null);
  });

  test("Copy Database Migration & Idempotency (TEST-18 & TEST-19): migrates copy cleanly and repeats with zero duplication", () => {
    const h = createP2Harness();
    const { adminToken } = seedRealisticLegacyDatabase(h);
    const liveBaselineSs = h.getActiveSpreadsheet();
    const liveBaselineBefore = dumpSpreadsheetState(liveBaselineSs);

    // Work exclusively on a staging copy of the database, leaving original baseline untouched
    const testCopySs = liveBaselineSs.copy("STAGING_COPY_DonasiAlumniApp_Test");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = testCopySs.getId();

    // Run 1: Actual non-destructive migration on test copy
    const run1 = h.sandbox.migrateDatabaseNonDestructive({
      dryRun: false,
      adminToken,
      spreadsheet: testCopySs,
    });

    assert.strictEqual(run1.status, "migrated_ok");
    assert.strictEqual(run1.integrity.ok, true);
    assert.strictEqual(testCopySs.getSheetByName("programs").getLastRow(), 6); // 1 header + 5 seeds
    assert.strictEqual(testCopySs.getSheetByName("donation_intents").getLastColumn(), 21);
    assert.strictEqual(testCopySs.getSheetByName("transactions").getLastColumn(), 35);

    // Verify status transforms and historical preservation
    const uRows = testCopySs.getSheetByName("users").getDataRange().getValues();
    assert.strictEqual(uRows[1][6], "APPROVED");
    assert.strictEqual(uRows[3][6], "NOT_SUBMITTED");
    assert.strictEqual(uRows[4][6], "PENDING");
    assert.strictEqual(uRows[5][6], "REJECTED");

    // Verify receipt & email rules: MATCHED/MANUAL_MATCHED get receipts & SENT; UNMATCHED keeps receipt_no=""
    const tMap = h.sandbox.getHeaderMap_(testCopySs.getSheetByName("transactions"));
    const tRows = testCopySs.getSheetByName("transactions").getDataRange().getValues();
    assert.strictEqual(tRows[1][tMap.receipt_no], "KWT-2026-000001");
    assert.strictEqual(tRows[1][tMap.email_status], "SENT");
    assert.strictEqual(tRows[1][tMap.gross_amount], 250000);
    assert.strictEqual(tRows[1][tMap.gateway_fee], 0);
    assert.strictEqual(tRows[1][tMap.net_amount], 250000);
    assert.strictEqual(tRows[2][tMap.receipt_no], "KWT-2026-000002");
    assert.strictEqual(tRows[3][tMap.receipt_no], ""); // Strictly empty for UNMATCHED!
    assert.strictEqual(tRows[3][tMap.email_status], "NOT_APPLICABLE");

    // Verify WEBHOOK_TOKEN retired in config sheet
    const cfgRows = testCopySs.getSheetByName("config").getDataRange().getValues();
    const webhookRow = cfgRows.find((r) => r[0] === "WEBHOOK_TOKEN");
    assert.strictEqual(webhookRow[1], "MIGRATED_TO_SCRIPT_PROPERTIES");

    // Verify counters synchronized >= highest historical IDs
    const ctrRows = testCopySs.getSheetByName("counters").getDataRange().getValues();
    const ctrObj = Object.fromEntries(ctrRows.slice(1).map((r) => [r[0], r[1]]));
    assert.strictEqual(ctrObj.ALUMNI, 471);
    assert.strictEqual(ctrObj.GUEST, 12);
    assert.strictEqual(ctrObj.RECEIPT, 2);
    assert.strictEqual(ctrObj.PROGRAM, 5);

    // Run 2 & Run 3: Repeated executions must be strictly idempotent
    const afterRun1Dump = dumpSpreadsheetState(testCopySs);
    const run2 = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, adminToken, spreadsheet: testCopySs });
    const run3 = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, adminToken, spreadsheet: testCopySs });

    assert.strictEqual(run2.status, "migrated_ok");
    assert.strictEqual(run3.status, "migrated_ok");
    assert.strictEqual(testCopySs.getSheetByName("programs").getLastRow(), 6);
    assert.strictEqual(testCopySs.getSheetByName("donation_intents").getLastColumn(), 21);
    assert.strictEqual(testCopySs.getSheetByName("transactions").getLastColumn(), 35);
    assert.strictEqual(testCopySs.getSheetByName("transactions").getDataRange().getValues()[1][tMap.receipt_no], "KWT-2026-000001");
    assert.strictEqual(afterRun1Dump.counters.length, testCopySs.getSheetByName("counters").getLastRow());

    // Confirm untouched live baseline remained 100% unmodified
    assert.deepStrictEqual(dumpSpreadsheetState(liveBaselineSs), liveBaselineBefore);
  });

  test("Failure Modes: aborts cleanly without mutation on missing sheet, header mismatch, duplicate keys, or incomplete rows", () => {
    const h = createP2Harness();
    seedRealisticLegacyDatabase(h);
    const baseSs = h.getActiveSpreadsheet();

    // Case 1: Missing sheet
    const missingSheetCopy = baseSs.copy("STAGING_COPY_MissingSheet");
    missingSheetCopy.deleteSheet("review_queue");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = missingSheetCopy.getId();
    const mRes = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, spreadsheet: missingSheetCopy });
    assert.strictEqual(mRes.status, "aborted");
    assert.strictEqual(mRes.mutated, false);
    assert.ok(mRes.preflight.blocking_errors.some((e) => e.includes("review_queue")));

    // Case 2: Reordered / mismatched header
    const badHeaderCopy = baseSs.copy("STAGING_COPY_BadHeader");
    badHeaderCopy.getSheetByName("donation_intents").getRange(1, 5).setValue("unexpected_col_name");
    const hBefore = dumpSpreadsheetState(badHeaderCopy);
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = badHeaderCopy.getId();
    const hRes = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, spreadsheet: badHeaderCopy });
    assert.strictEqual(hRes.status, "aborted");
    assert.strictEqual(hRes.mutated, false);
    assert.deepStrictEqual(dumpSpreadsheetState(badHeaderCopy), hBefore);

    // Case 3: Duplicate primary ID / ref_code
    const dupCopy = baseSs.copy("STAGING_COPY_Duplicate");
    dupCopy.getSheetByName("users").appendRow(["USR_002", "sub_x", "other@upi.edu", "Dup", "ALUMNI", "A000471", "VERIFIED", "", ""]);
    const dBefore = dumpSpreadsheetState(dupCopy);
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = dupCopy.getId();
    const dRes = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, spreadsheet: dupCopy });
    assert.strictEqual(dRes.status, "aborted");
    assert.strictEqual(dRes.mutated, false);
    assert.deepStrictEqual(dumpSpreadsheetState(dupCopy), dBefore);

    // Case 4: Incomplete row (missing amount <= 0 or missing intent_id)
    const incCopy = baseSs.copy("STAGING_COPY_Incomplete");
    incCopy.getSheetByName("donation_intents").appendRow(["", "USR_002", "A000471", 0, "BCA", "Beasiswa Alumni UPI", "PENDING", "", "", ""]);
    const iBefore = dumpSpreadsheetState(incCopy);
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = incCopy.getId();
    const iRes = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, spreadsheet: incCopy });
    assert.strictEqual(iRes.status, "aborted");
    assert.strictEqual(iRes.mutated, false);
    assert.deepStrictEqual(dumpSpreadsheetState(incCopy), iBefore);
  });

  test("Mid-Migration Failure & Backup Recovery: restores target spreadsheet identically to pre-migration backup", () => {
    const h = createP2Harness();
    const { adminToken } = seedRealisticLegacyDatabase(h);
    const sourceSs = h.getActiveSpreadsheet();
    const targetCopy = sourceSs.copy("STAGING_COPY_MidFailureTest");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = targetCopy.getId();
    const preMigrationDump = dumpSpreadsheetState(targetCopy);

    // Create verified backup right before migration attempt
    const backupOut = h.sandbox.createMigrationBackup({
      adminToken,
      sourceSpreadsheet: targetCopy,
      writeAuditLog: false,
    });
    assert.strictEqual(backupOut.verification.ok, true);

    // Trigger mid-migration failure after intents step (leaving partial mutations)
    let caughtErr = null;
    try {
      h.sandbox.migrateDatabaseNonDestructive({
        dryRun: false,
        adminToken,
        spreadsheet: targetCopy,
        backupVerified: true,
        _simulateFailureAtStep: "after_intents",
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Expected simulated mid-migration failure to throw");
    assert.strictEqual(caughtErr.failedStep, "backfill_intents");
    // Confirm targetCopy indeed had partial mutations (programs added, 21/35 cols appended)
    assert.ok(targetCopy.getSheetByName("programs") !== null);
    assert.strictEqual(targetCopy.getSheetByName("transactions").getLastColumn(), 35);

    // Execute rollback / recovery from verified backup
    const restoreOut = h.sandbox.restoreDatabaseFromBackup(targetCopy, backupOut.backupSpreadsheet, { adminToken });
    assert.strictEqual(restoreOut.status, "restored_ok");
    assert.strictEqual(restoreOut.verification.ok, true);

    // Verify targetCopy returned bit-for-bit to pre-migration baseline (including removing added programs sheet)
    assert.strictEqual(targetCopy.getSheetByName("programs"), null);
    assert.deepStrictEqual(dumpSpreadsheetState(targetCopy), preMigrationDump);
  });

  test("Staging Target Guard (Exact Spreadsheet ID + STAGING_ prefix) & ADMIN_EMAILS Allowlist Consistency", () => {
    const h = createP2Harness();
    seedRealisticLegacyDatabase(h);
    const baseSs = h.getActiveSpreadsheet();

    // 1. Exact ID + STAGING_ prefix enforcement across DRY_RUN and actual migration
    const stagingSs = baseSs.copy("STAGING_DonasiAlumniApp_P2_2");
    const nonPrefixSs = baseSs.copy("PROD_STAGING_COPY");

    // Aborts when EXPECTED_STAGING_SPREADSHEET_ID is unset
    assert.throws(
      () => h.sandbox.migrateDatabaseNonDestructive({ dryRun: true, enforceStagingGuard: true, spreadsheet: stagingSs }),
      /EXPECTED_STAGING_SPREADSHEET_ID/,
    );
    assert.throws(
      () => h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: true, enforceStagingGuard: true, spreadsheet: stagingSs }),
      /EXPECTED_STAGING_SPREADSHEET_ID/,
    );

    // Aborts when EXPECTED_STAGING_SPREADSHEET_ID mismatches target ID
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = "WRONG_SPREADSHEET_ID";
    assert.throws(
      () => h.sandbox.migrateDatabaseNonDestructive({ dryRun: true, enforceStagingGuard: true, spreadsheet: stagingSs }),
      /tidak cocok/,
    );

    // Aborts when ID matches non-STAGING_ prefixed sheet
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = nonPrefixSs.getId();
    assert.throws(
      () => h.sandbox.migrateDatabaseNonDestructive({ dryRun: true, enforceStagingGuard: true, spreadsheet: nonPrefixSs }),
      /STAGING_/,
    );

    // Succeeds on DRY_RUN and autoBackup actual migration when BOTH exact ID and STAGING_ prefix match
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = stagingSs.getId();
    const dryStaging = h.sandbox.migrateDatabaseNonDestructive({
      dryRun: true,
      enforceStagingGuard: true,
      spreadsheet: stagingSs,
    });
    assert.strictEqual(dryStaging.status, "dry_run_ok");
    assert.strictEqual(dryStaging.mutated, false);

    const migStaging = h.sandbox.migrateDatabaseNonDestructive({
      dryRun: false,
      autoBackup: true,
      enforceStagingGuard: true,
      spreadsheet: stagingSs,
    });
    assert.strictEqual(migStaging.status, "migrated_ok");
    assert.strictEqual(migStaging.backup.verified, true);
    assert.strictEqual(migStaging.integrity.ok, true);

    // 2. ADMIN_EMAILS consistency: Notifier.gs obeys authoritative ScriptProperties.ADMIN_EMAILS, never stale config/hardcoded fallback
    h.scriptProps.ADMIN_EMAILS = "staging.only@upi.edu";
    assert.strictEqual(h.sandbox.isAdminEmail_("staging.only@upi.edu"), true);
    assert.strictEqual(h.sandbox.isAdminEmail_("maulanaa1408@upi.edu"), false);

    h.sandbox.sendAdminDonationAlert_([{ bank: "BCA", amount: 50000, donor: "Seseorang", ref_code: "G000001", status: "MATCHED", tier: "1" }]);
    h.sandbox.sendAdminNewVerificationAlert_({ full_name: "Alumni", email: "alu@upi.edu" }, "VRF_1", { nim: "123", grad_year: "2024", faculty: "FPMIPA" });
    assert.strictEqual(h.sentEmails.length, 2);
    assert(h.sentEmails.every((m) => m.to === "staging.only@upi.edu"), "Notifications must go exclusively to authoritative allowlist");

    // When ADMIN_EMAILS is cleared in both ScriptProperties & config sheet, zero alerts sent to hardcoded emails
    delete h.scriptProps.ADMIN_EMAILS;
    const cfgRows = baseSs.getSheetByName("config")._rows;
    const admCfgIdx = cfgRows.findIndex((r) => r[0] === "ADMIN_EMAILS");
    if (admCfgIdx !== -1) cfgRows[admCfgIdx][1] = "";
    h.sentEmails.length = 0;
    h.sandbox.sendAdminDonationAlert_([{ bank: "BCA", amount: 50000, donor: "Seseorang", ref_code: "G000001", status: "MATCHED", tier: "1" }]);
    assert.strictEqual(h.sentEmails.length, 0, "Empty allowlist must not fall back to hardcoded admin email");
  });

  test("Mandatory Staging Guard on Actual Migration (Unbypassable on dryRun: false, Zero Lock/Backup/Mutation Before Guard)", () => {
    const h = createP2Harness();
    seedRealisticLegacyDatabase(h);
    const baseSs = h.getActiveSpreadsheet();
    const stagingSs = baseSs.copy("STAGING_MandatoryGuard_DB");
    const nonPrefixSs = baseSs.copy("PROD_WITHOUT_STAGING_PREFIX");

    // 1. Actual migration WITHOUT enforceStagingGuard flag & WITHOUT EXPECTED_STAGING_SPREADSHEET_ID must be rejected
    h.resetMetrics();
    const beforeMissingProp = dumpSpreadsheetState(stagingSs);
    assert.throws(
      () => h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, spreadsheet: stagingSs }),
      /EXPECTED_STAGING_SPREADSHEET_ID/,
    );
    assert.strictEqual(h.getMetrics().lockWaitCount, 0, "LockService must not run before Staging Guard passes");
    assert.strictEqual(h.getMetrics().copyCalls, 0, "Backup copy must not run before Staging Guard passes");
    assert.deepStrictEqual(dumpSpreadsheetState(stagingSs), beforeMissingProp);

    // 2. Actual migration WITH enforceStagingGuard: false override attempt & wrong ID must still be rejected
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = "DIFFERENT_SPREADSHEET_ID";
    h.resetMetrics();
    assert.throws(
      () => h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, enforceStagingGuard: false, spreadsheet: stagingSs }),
      /tidak cocok/,
    );
    assert.strictEqual(h.getMetrics().lockWaitCount, 0, "LockService must not run on mismatched ID");
    assert.strictEqual(h.getMetrics().copyCalls, 0, "Backup copy must not run on mismatched ID");
    assert.deepStrictEqual(dumpSpreadsheetState(stagingSs), beforeMissingProp);

    // 3. Actual migration WITH matching ID but missing STAGING_ name prefix must be rejected before lock/backup/mutation
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = nonPrefixSs.getId();
    const beforeNonPrefix = dumpSpreadsheetState(nonPrefixSs);
    h.resetMetrics();
    assert.throws(
      () => h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, spreadsheet: nonPrefixSs }),
      /STAGING_/,
    );
    assert.strictEqual(h.getMetrics().lockWaitCount, 0, "LockService must not run on missing STAGING_ prefix");
    assert.strictEqual(h.getMetrics().copyCalls, 0, "Backup copy must not run on missing STAGING_ prefix");
    assert.deepStrictEqual(dumpSpreadsheetState(nonPrefixSs), beforeNonPrefix);

    // Read-only DRY_RUN remains safe without enforceStagingGuard (zero backup, zero mutation)
    h.resetMetrics();
    const drySafe = h.sandbox.migrateDatabaseNonDestructive({ dryRun: true, spreadsheet: nonPrefixSs });
    assert.strictEqual(drySafe.status, "dry_run_ok");
    assert.strictEqual(drySafe.mutated, false);
    assert.strictEqual(h.getMetrics().copyCalls, 0);
    assert.deepStrictEqual(dumpSpreadsheetState(nonPrefixSs), beforeNonPrefix);

    // 4. Actual migration WITH matching ID and STAGING_ prefix proceeds past guard into preflight & backup
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = stagingSs.getId();
    h.resetMetrics();
    const okRes = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, spreadsheet: stagingSs });
    assert.strictEqual(okRes.status, "migrated_ok");
    assert.strictEqual(okRes.backup.verified, true);
    assert.strictEqual(okRes.integrity.ok, true);
    assert.ok(h.getMetrics().lockWaitCount >= 1, "Guarded actual migration should enter LockService + preflight");
    assert.strictEqual(h.getMetrics().copyCalls, 1, "Guarded actual migration should execute auto-backup");
  });

  test("Post-Migration Inspection (PASS/FAIL Invariants, Header-Mapped UNMATCHED Validation, & Zero Secret Leakage)", () => {
    const h = createP2Harness();
    seedRealisticLegacyDatabase(h);
    const stagingSs = h.getActiveSpreadsheet().copy("STAGING_Inspection_Target");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = stagingSs.getId();

    const migRes = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: true, spreadsheet: stagingSs });
    assert.strictEqual(migRes.status, "migrated_ok");
    assert.strictEqual(stagingSs.getSheetByName("unmatched_bank_tx"), null, "unmatched_bank_tx must not be assumed or created");

    // 1. Healthy V2 staging DB passes all 8 invariants without exposing sensitive strings
    h.resetMetrics();
    const passReport = h.sandbox.inspectStagingPostMigrationDetails({ spreadsheet: stagingSs });
    assert.strictEqual(passReport.overall_status, "PASS");
    assert.strictEqual(passReport.total_checks, 8);
    assert.strictEqual(passReport.passed_count, 8);
    assert.strictEqual(passReport.failed_count, 0);
    assert.strictEqual(passReport.checks.v2_sheet_count_and_names.actual_sheet_count, 10);
    assert.strictEqual(passReport.checks.schema_columns_intents_and_transactions.donation_intents_columns, 21);
    assert.strictEqual(passReport.checks.schema_columns_intents_and_transactions.transactions_columns, 35);
    assert.strictEqual(passReport.checks.unmatched_transactions_zero_receipt.status, "PASS");
    assert.strictEqual(passReport.checks.unmatched_transactions_zero_receipt.unmatched_count, 1);
    assert.strictEqual(passReport.checks.unmatched_transactions_zero_receipt.unmatched_with_receipt_count, 0);
    assert.ok(passReport.runtime_scope_note.includes("does not substitute"));

    const loggedText = h.getMetrics().logs.join("\n");
    const serialized = JSON.stringify(passReport);
    for (const forbidden of ["LEGACY_SECRET_SHOULD_BE_RETIRED", "p2_test_hmac_secret_32bytes_value", "maulanaa1408@upi.edu"]) {
      assert.ok(!serialized.includes(forbidden), `Inspection report leaked sensitive value: ${forbidden}`);
      assert.ok(!loggedText.includes(forbidden), `Inspection log leaked sensitive value: ${forbidden}`);
    }

    // 2. FAIL when an UNMATCHED row in 'transactions' has a non-empty receipt_no (header-mapped, no unmatched_bank_tx sheet)
    const badUnmatchedSs = stagingSs.copy("STAGING_Inspect_BadUnmatched");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = badUnmatchedSs.getId();
    const tSheet = badUnmatchedSs.getSheetByName("transactions");
    const tMap = h.sandbox.getHeaderMap_(tSheet);
    const tVals = tSheet.getDataRange().getValues();
    const unmatchedRowIdx = tVals.findIndex((r, idx) => idx > 0 && r[tMap.match_status] === "UNMATCHED");
    assert.ok(unmatchedRowIdx > 0);
    tSheet.getRange(unmatchedRowIdx + 1, tMap.receipt_no + 1).setValue("KWT-2026-999999");
    const failUnmatched = h.sandbox.inspectStagingPostMigrationDetails({ spreadsheet: badUnmatchedSs, skipLog: true });
    assert.strictEqual(failUnmatched.overall_status, "FAIL");
    assert.strictEqual(failUnmatched.checks.unmatched_transactions_zero_receipt.status, "FAIL");
    assert.strictEqual(failUnmatched.checks.unmatched_transactions_zero_receipt.unmatched_with_receipt_count, 1);

    // 3. FAIL when duplicate receipt_no exists
    const dupReceiptSs = stagingSs.copy("STAGING_Inspect_DupReceipt");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = dupReceiptSs.getId();
    const dupTSheet = dupReceiptSs.getSheetByName("transactions");
    const dupTMap = h.sandbox.getHeaderMap_(dupTSheet);
    dupTSheet.getRange(3, dupTMap.receipt_no + 1).setValue("KWT-2026-000001");
    const failDupRec = h.sandbox.inspectStagingPostMigrationDetails({ spreadsheet: dupReceiptSs, skipLog: true });
    assert.strictEqual(failDupRec.overall_status, "FAIL");
    assert.strictEqual(failDupRec.checks.unique_receipt_numbers.status, "FAIL");

    // 4. FAIL when counter falls below high-water mark
    const badCtrSs = stagingSs.copy("STAGING_Inspect_BadCounter");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = badCtrSs.getId();
    const ctrSheet = badCtrSs.getSheetByName("counters");
    const ctrMap = h.sandbox.getHeaderMap_(ctrSheet);
    ctrSheet.getRange(2, ctrMap.value + 1).setValue(10); // ALUMNI min is 471
    const failCtr = h.sandbox.inspectStagingPostMigrationDetails({ spreadsheet: badCtrSs, skipLog: true });
    assert.strictEqual(failCtr.overall_status, "FAIL");
    assert.strictEqual(failCtr.checks.counters_minimum_watermarks.status, "FAIL");

    // 5. FAIL when programs has duplicate ID & when V2 sheet count != 10
    const badPrgSs = stagingSs.copy("STAGING_Inspect_BadPrograms");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = badPrgSs.getId();
    badPrgSs.getSheetByName("programs").appendRow(["PRG-001", "Dup", "Dup desc", "TRUE", "", ""]);
    badPrgSs.insertSheet("extra_unexpected_tab");
    const failPrg = h.sandbox.inspectStagingPostMigrationDetails({ spreadsheet: badPrgSs, skipLog: true });
    assert.strictEqual(failPrg.overall_status, "FAIL");
    assert.strictEqual(failPrg.checks.programs_seed_integrity.status, "FAIL");
    assert.strictEqual(failPrg.checks.v2_sheet_count_and_names.status, "FAIL");

    // 6. FAIL when transaction header order/column count is invalid & WEBHOOK_TOKEN placeholder is wrong without leaking value
    const badHdrCfgSs = stagingSs.copy("STAGING_Inspect_BadHeaderCfg");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = badHdrCfgSs.getId();
    badHdrCfgSs.getSheetByName("transactions").getRange(1, 35).setValue("wrong_last_header");
    const cfgSheet = badHdrCfgSs.getSheetByName("config");
    const cfgMap = h.sandbox.getHeaderMap_(cfgSheet);
    const cfgRows = cfgSheet.getDataRange().getValues();
    const whRowIdx = cfgRows.findIndex((r, idx) => idx > 0 && r[cfgMap.key] === "WEBHOOK_TOKEN");
    cfgSheet.getRange(whRowIdx + 1, cfgMap.value + 1).setValue("SENSITIVE_UNMIGRATED_SECRET_XYZ");
    h.scriptProps.ALLOW_MOCK_AUTH = "true";

    const failHdrCfg = h.sandbox.inspectStagingPostMigrationDetails({ spreadsheet: badHdrCfgSs, skipLog: true });
    assert.strictEqual(failHdrCfg.overall_status, "FAIL");
    assert.strictEqual(failHdrCfg.checks.schema_columns_intents_and_transactions.status, "FAIL");
    assert.strictEqual(failHdrCfg.checks.legacy_webhook_token_placeholder.status, "FAIL");
    assert.strictEqual(failHdrCfg.checks.allow_mock_auth_not_true.status, "FAIL");
    assert.ok(!JSON.stringify(failHdrCfg).includes("SENSITIVE_UNMIGRATED_SECRET_XYZ"), "Failed config check leaked secret");

    // 7. Built-in Staging Runner helpers in Setup.gs (verifyStagingPropsPresence_, runStagingP2DryRun, runStagingP2Migration)
    const runnerSs = h.getActiveSpreadsheet().copy("STAGING_DonasiAlumniApp_P2_2");
    h.scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = runnerSs.getId();
    h.scriptProps.TOKEN_PEPPER = "staging_pepper_secret_32bytes";
    h.scriptProps.ALLOW_MOCK_AUTH = "false";
    const propsCheck = h.sandbox.verifyStagingPropsPresence_({ skipLog: true });
    assert.strictEqual(propsCheck.overall_status, "PASS");
    assert.strictEqual(propsCheck.allow_mock_auth_is_false, true);
    assert.ok(!JSON.stringify(propsCheck).includes("staging_pepper_secret_32bytes"));

    const gate1Out = h.sandbox.runStagingP2DryRun({ spreadsheet: runnerSs, skipLog: true });
    assert.strictEqual(gate1Out.status, "dry_run_ok");
    assert.strictEqual(gate1Out.mutated, false);
    assert.strictEqual(gate1Out.preflight_ok, true);
    assert.strictEqual(gate1Out.blocking_errors.length, 0);

    const gate2Out = h.sandbox.runStagingP2Migration({ spreadsheet: runnerSs, skipLog: true });
    assert.strictEqual(gate2Out.status, "migrated_ok");
    assert.strictEqual(gate2Out.mutated, true);
    assert.strictEqual(gate2Out.backup.verified, true);
    assert.strictEqual(gate2Out.integrity.ok, true);
  });

  console.log(`\n==========================================\nP2 MIGRATION SUITE: ${passed} Passed, ${failed} Failed\n==========================================`);
  if (failed > 0) process.exit(1);
}

runTests();
