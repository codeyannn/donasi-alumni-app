/**
 * p7_admin_dashboard.test.js
 * Comprehensive verification suite for Phase P7 (Pure-Aggregate PublicApi,
 * Admin Transaction Ledger & Filtering, Financial Gross/Fee/Net Insights,
 * Paginated Redacted Audit Log Viewer, & Admin Console Frontend Controls).
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAS_DIR = path.join(ROOT_DIR, "apps-script");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");

function createP7Harness(options = {}) {
  const sheets = {};
  const scriptProps = {
    EXPECTED_STAGING_SPREADSHEET_ID: "STAGING_P7_TEST_SS_ID",
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p7_test_hmac_secret_32bytes_value",
    TOKEN_PEPPER: "p7_test_pepper_32bytes_secret_value",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-P7_UNIT_TEST_SECRET_KEY",
    MIDTRANS_IS_PRODUCTION: "false",
    ALLOW_MOCK_AUTH: "false",
    ...(options.props || {}),
  };
  const scriptCache = {};
  const userCache = {};
  const sentEmails = [];
  const tokenDirectory = {};

  function makeSheet(name) {
    const rows = [];
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
      deleteRow: (rowIdx1) => {
        if (rowIdx1 >= 1 && rowIdx1 <= rows.length) {
          rows.splice(rowIdx1 - 1, 1);
        }
      },
      clearContents: () => {
        rows.length = 0;
      },
      getDataRange: () => ({ getValues: () => rows.map((r) => [...r]) }),
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

  const ss = {
    getId: () => "STAGING_P7_TEST_SS_ID",
    getName: () => "STAGING_P7_TestDB",
    getSheets: () => Object.values(sheets),
    getSheetByName: (name) => sheets[name] || null,
    insertSheet: (name) => {
      sheets[name] = makeSheet(name);
      return sheets[name];
    },
    deleteSheet: (s) => {
      const n = typeof s === "string" ? s : s.getName();
      delete sheets[n];
    },
  };

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
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
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
        remove: (k) => {
          delete scriptCache[k];
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
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    MailApp: { sendEmail: (obj) => sentEmails.push(obj) },
    DriveApp: {
      Access: { ANYONE: "ANYONE", PRIVATE: "PRIVATE" },
      Permission: { NONE: "NONE", VIEW: "VIEW" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({ setSharing: () => {}, createFile: () => ({ getId: () => "DRV_1", setSharing: () => {} }) }),
    },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5", SHA_256: "SHA_256", SHA_512: "SHA_512" },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => new Date(d).toISOString().replace("T", " ").substring(0, 19),
      base64Encode: (input) =>
        Array.isArray(input)
          ? Buffer.from(input.map((b) => (b < 0 ? b + 256 : b))).toString("base64")
          : Buffer.from(String(input), "utf8").toString("base64"),
      computeDigest: (algo, input) => {
        const alg = algo === "SHA_256" ? "sha256" : algo === "SHA_512" ? "sha512" : "md5";
        return Array.from(crypto.createHash(alg).update(String(input), "utf8").digest()).map((b) => (b >= 128 ? b - 256 : b));
      },
      computeHmacSha256Signature: (msg, key) =>
        Array.from(crypto.createHmac("sha256", String(key)).update(String(msg), "utf8").digest()).map((b) => (b >= 128 ? b - 256 : b)),
    },
    UrlFetchApp: {
      fetch: (url, fetchOpts = {}) => {
        if (url.indexOf("oauth2.googleapis.com/tokeninfo") !== -1) {
          const qIdx = url.indexOf("id_token=");
          const tok = qIdx >= 0 ? decodeURIComponent(url.slice(qIdx + "id_token=".length)) : "";
          const rec = tokenDirectory[tok];
          if (!rec) return { getResponseCode: () => 401, getContentText: () => "{}" };
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(rec) };
        }
        if (url.indexOf("/snap/v1/transactions") !== -1) {
          const parsedBody = JSON.parse(fetchOpts.payload || "{}");
          const oid = parsedBody.transaction_details.order_id;
          return {
            getResponseCode: () => 201,
            getContentText: () => JSON.stringify({ token: "SNAP_TOK_" + oid, redirect_url: "https://sandbox/" + oid }),
          };
        }
        return { getResponseCode: () => 404, getContentText: () => "{}" };
      },
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (str) => ({ setMimeType: () => {}, getContent: () => str }),
    },
    Logger: { log: () => {} },
  };

  vm.createContext(sandbox);
  for (const f of [
    "Setup.gs",
    "Logic.gs",
    "AuditLog.gs",
    "Auth.gs",
    "Notifier.gs",
    "Programs.gs",
    "Payments.gs",
    "Receipts.gs",
    "Users.gs",
    "Donations.gs",
    "Webhook.gs",
    "Admin.gs",
    "PublicApi.gs",
    "Code.gs",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), "utf8"), sandbox, { filename: f });
  }

  sandbox.setupSheets();
  sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: false, backupVerified: true });

  return {
    ss,
    sandbox,
    sheets,
    scriptCache,
    scriptProps,
    registerOAuth: (token, claims) => {
      tokenDirectory[token] = {
        aud: scriptProps.GOOGLE_CLIENT_ID,
        email_verified: "true",
        ...claims,
      };
    },
    post: (bodyObj) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(bodyObj) }, parameter: {} }).getContent()),
    get: (params) => JSON.parse(sandbox.doGet({ parameter: params }).getContent()),
  };
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

  console.log("📊 RUNNING PHASE P7 DASHBOARD, MONITORING & ADMIN CONSOLE TESTS...\n");

  test("Pure Aggregate PublicApi: zero recent_donations / PII, 60s caching, & index.html clean", () => {
    const h = createP7Harness();
    const gIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Rahasia Nama Asli",
      donor_email: "rahasia@example.com",
      amount: 275000,
      program_id: "PRG-002",
      payment_channel: "MANUAL_TRANSFER",
      bank: "BCA",
      is_anonymous: false,
      consent: true,
    });
    h.post({ action: "simulate_manual_payment", intent_id: gIntent.intent_id, access_token: gIntent.access_token });

    const pub = h.get({ action: "public_summary" });
    assert.strictEqual(pub.status, "ok");
    assert.strictEqual(pub.total_amount, 275000);
    assert.strictEqual(pub.total_count, 1);
    assert.strictEqual(pub.by_bank.BCA, 275000);
    assert.strictEqual(pub.by_program["Beasiswa Prestasi"], 275000);
    assert.strictEqual(pub.recent_donations, undefined, "PublicApi must NEVER expose individual recent_donations list");

    const serialized = JSON.stringify(pub);
    assert.ok(!serialized.includes("Rahasia"), "Public summary leaked donor name");
    assert.ok(!serialized.includes("rahasia@example.com"), "Public summary leaked donor email");
    assert.ok(!serialized.includes(gIntent.ref_code), "Public summary leaked ref_code");
    assert.ok(h.scriptCache.PUBLIC_AGGREGATE_SUMMARY_V2, "Public summary must be cached in ScriptCache");

    const indexHtml = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf8");
    const apiJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "api.js"), "utf8");
    assert.ok(!indexHtml.includes("pubRecentTable"), "index.html should render aggregate tables instead of per-donor rows");
    assert.ok(!apiJs.includes("recent_donations"), "api.js offline mock should match pure-aggregate contract");
  });

  test("Admin Transactions & Financial Insights (gross/fee/net, channel/program/status filters, & pending Midtrans monitor)", () => {
    const h = createP7Harness();
    h.registerOAuth("tok_admin", { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin" });
    h.registerOAuth("tok_user", { sub: "sub_usr", email: "user@upi.edu", name: "User" });
    h.post({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_user", role: "ALUMNI", consent: true });

    // Non-admin rejected from admin_transactions
    const unauthTx = h.post({ action: "admin_transactions", id_token: "tok_user" });
    assert.strictEqual(unauthTx.status, "error");
    assert.ok(unauthTx.message.includes("Forbidden"));

    // 1. Confirmed manual guest donation (PRG-001, Rp 200.000)
    const mIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Manual Donor",
      donor_email: "man@example.com",
      amount: 200000,
      program_id: "PRG-001",
      payment_channel: "MANUAL_TRANSFER",
      bank: "BRI",
      is_anonymous: false,
      consent: true,
    });
    h.post({ action: "simulate_manual_payment", intent_id: mIntent.intent_id, access_token: mIntent.access_token });

    // 2. Confirmed Midtrans donation (PRG-004, Rp 350.000) + Pending Midtrans intent
    const sIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Midtrans Donor",
      donor_email: "mt@example.com",
      amount: 350000,
      program_id: "PRG-004",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });
    const pendingSnap = h.post({
      action: "create_guest_intent",
      donor_name: "Pending Snap",
      donor_email: "pend@example.com",
      amount: 100000,
      program_id: "PRG-003",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });

    // Settle sIntent via Midtrans webhook
    const rawSig = sIntent.order_id + "200" + "350000.00" + h.scriptProps.MIDTRANS_SERVER_KEY;
    const sigKey = crypto.createHash("sha512").update(rawSig, "utf8").digest("hex");
    h.post({
      order_id: sIntent.order_id,
      transaction_id: "MT_P7_01",
      status_code: "200",
      gross_amount: "350000.00",
      transaction_status: "settlement",
      payment_type: "qris",
      signature_key: sigKey,
    });

    // Query all transactions & pending Midtrans monitor
    const allTx = h.post({ action: "admin_transactions", id_token: "tok_admin" });
    assert.strictEqual(allTx.status, "ok");
    assert.strictEqual(allTx.items.length, 2);
    assert.strictEqual(allTx.summary.total_gross, 550000);
    assert.strictEqual(allTx.summary.total_fee, 0);
    assert.strictEqual(allTx.summary.total_net, 550000);
    assert.strictEqual(allTx.pending_midtrans_intents.length, 1);
    assert.strictEqual(allTx.pending_midtrans_intents[0].order_id, pendingSnap.order_id);

    // Filter by channel = MIDTRANS_SNAP
    const midFilter = h.post({
      action: "admin_transactions",
      id_token: "tok_admin",
      filters: { channel: "MIDTRANS_SNAP" },
    });
    assert.strictEqual(midFilter.items.length, 1);
    assert.strictEqual(midFilter.items[0].program_id, "PRG-004");

    // Verify admin_insights totals & channel/program breakdowns
    const insights = h.post({ action: "admin_insights", id_token: "tok_admin" });
    assert.strictEqual(insights.status, "ok");
    assert.strictEqual(insights.total_gross, 550000);
    assert.strictEqual(insights.total_fee, 0);
    assert.strictEqual(insights.total_net, 550000);
    assert.strictEqual(insights.channel_breakdown.MANUAL_TRANSFER, 200000);
    assert.strictEqual(insights.channel_breakdown.MIDTRANS_SNAP, 350000);
    assert.strictEqual(insights.program_breakdown["Wakaf Pendidikan"], 350000);
  });

  test("Paginated Admin Audit Log Viewer, Secret Redaction, & Admin Frontend Controls", () => {
    const h = createP7Harness();
    h.registerOAuth("tok_admin", { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin" });
    h.registerOAuth("tok_user", { sub: "sub_usr", email: "user@upi.edu", name: "User" });
    h.post({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_user", role: "ALUMNI", consent: true });

    // Non-admin & GET blocked
    const unauthAudit = h.post({ action: "admin_audit_logs", id_token: "tok_user" });
    assert.strictEqual(unauthAudit.status, "error");
    assert.ok(unauthAudit.message.includes("Forbidden"));
    assert.strictEqual(h.get({ action: "admin_audit_logs" }).status, "error");
    assert.strictEqual(h.get({ action: "admin_transactions" }).status, "error");

    // Append entries containing sensitive patterns to confirm automatic redaction
    h.sandbox.logAudit_(
      "maulanaa1408@upi.edu",
      "TEST_REDACT_CHECK",
      "TARGET_1",
      "access_token=abc123secret SB-Mid-server-TOPSECRETKEY eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123"
    );

    const page1 = h.post({ action: "admin_audit_logs", id_token: "tok_admin", limit: 2, offset: 0 });
    assert.strictEqual(page1.status, "ok");
    assert.strictEqual(page1.items.length, 2);
    assert.ok(page1.total >= 3);
    assert.strictEqual(page1.items[0].action, "TEST_REDACT_CHECK");
    assert.ok(!page1.items[0].detail.includes("abc123secret"), "access_token leaked in audit log");
    assert.ok(!page1.items[0].detail.includes("TOPSECRETKEY"), "Midtrans server key leaked in audit log");
    assert.ok(!page1.items[0].detail.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT leaked in audit log");

    const page2 = h.post({ action: "admin_audit_logs", id_token: "tok_admin", limit: 2, offset: 2 });
    assert.strictEqual(page2.status, "ok");
    assert.ok(page2.items.length >= 1);
    assert.notStrictEqual(page2.items[0].action, page1.items[0].action);

    // Frontend admin.html & admin.js wiring verification
    const adminHtml = fs.readFileSync(path.join(FRONTEND_DIR, "admin.html"), "utf8");
    const adminJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "admin.js"), "utf8");
    for (const id of ["sectionTransactions", "sectionAuditLogs", "tabBtnTransactions", "tabBtnAuditLogs", "insightTotalGross", "insightTotalFee"]) {
      assert.ok(adminHtml.includes(id), `admin.html missing P7 element id: ${id}`);
    }
    for (const fn of ["loadAdminTransactions", "handleAdminSyncMidtrans", "handleRetryTxEmail", "exportAdminFinancialCsv", "escapeCsvCell_", "loadAdminAuditLogs"]) {
      assert.ok(adminJs.includes(fn), `admin.js missing P7 function: ${fn}`);
    }
  });

  console.log(`\n==========================================\nP7 ADMIN DASHBOARD SUITE: ${passed} Passed, ${failed} Failed\n==========================================`);
  if (failed > 0) process.exit(1);
}

runTests();
