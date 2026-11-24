/**
 * p4_donation_management.test.js
 * Comprehensive verification suite for Phase P4 (Program CRUD, Verified Alumni Donations,
 * Accountless Guest Checkout, 256-bit Access Token Security, Idempotency, & Pre-P2.2 Compatibility).
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAS_DIR = path.join(ROOT_DIR, "apps-script");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");

/**
 * Builds an isolated GAS V8 VM harness supporting both v1 (pre-P2.2) and v2 (post-P2.2 copy) schemas.
 */
function createP4Harness(options = {}) {
  const sheets = {};
  const scriptProps = {
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p4_test_hmac_secret_32bytes_value",
    TOKEN_PEPPER: "p4_test_pepper_32bytes_secret_value",
    ...(options.props || {}),
  };
  const scriptCache = {};
  const userCache = {};
  const sentEmails = [];
  const tokenDirectory = {};
  const logs = [];

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

  const ssId = options.ssId || "STAGING_P4_TEST_SS_ID";
  const ssName = options.ssName || "STAGING_P4_TestDB";
  const ss = {
    getId: () => ssId,
    getName: () => ssName,
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
    copy: (copyName) => {
      const cloned = createP4Harness({ props: scriptProps, skipInit: true, ssId: ssId + "_copy", ssName: copyName || ssName + "_Copy" });
      for (const [k, sh] of Object.entries(sheets)) {
        const ns = cloned.ss.insertSheet(k);
        const m = sh.getDataRange().getValues();
        if (m.length > 0 && m[0].length > 0) {
          ns.getRange(1, 1, m.length, m[0].length).setValues(m);
        }
      }
      return cloned.ss;
    },
  };

  let lockCalls = 0;
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
      getScriptLock: () => ({
        waitLock: () => {
          lockCalls++;
        },
        releaseLock: () => {},
      }),
    },
    MailApp: { sendEmail: (obj) => sentEmails.push(obj) },
    DriveApp: {
      Access: { ANYONE: "ANYONE" },
      Permission: { NONE: "NONE" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({
        setSharing: () => {},
        createFile: () => ({ getId: () => "DRV_1", setSharing: () => {} }),
      }),
    },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (txt) => ({
        _text: txt,
        setMimeType: function () { return this; },
        getContent: function () { return this._text; },
      }),
    },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5", SHA_256: "SHA_256", SHA_512: "SHA_512" },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => new Date(d).toISOString().slice(0, 19).replace("T", " "),
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
      base64Decode: (b64) => Array.from(Buffer.from(String(b64), "base64")),
      newBlob: (bytes, mime, name) => ({ bytes, mimeType: mime, name }),
      computeDigest: (algo, input) => {
        const alg = algo === "SHA_256" ? "sha256" : algo === "SHA_512" ? "sha512" : "md5";
        return Array.from(crypto.createHash(alg).update(String(input), "utf8").digest());
      },
      computeHmacSha256Signature: (msg, sec) => {
        return Array.from(crypto.createHmac("sha256", String(sec)).update(String(msg), "utf8").digest());
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
    Logger: { log: (m) => logs.push(String(m)) },
  };

  vm.createContext(sandbox);
  const files = [
    "Setup.gs",
    "Logic.gs",
    "AuditLog.gs",
    "Auth.gs",
    "Notifier.gs",
    "Programs.gs",
    "Users.gs",
    "Donations.gs",
    "Webhook.gs",
    "Admin.gs",
    "PublicApi.gs",
    "Code.gs",
  ];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), "utf8"), sandbox, { filename: f });
  }

  if (!options.skipInit) {
    sandbox.setupSheets();
    if (options.useV2TestFixture) {
      // Upgrade ONLY the isolated local test fixture to v2 headers (never production)
      scriptProps.EXPECTED_STAGING_SPREADSHEET_ID = ss.getId();
      sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: false, backupVerified: true });
    }
  }

  return {
    ss,
    sandbox,
    sheets,
    scriptProps,
    scriptCache,
    sentEmails,
    tokenDirectory,
    logs,
    getLockCalls: () => lockCalls,
    post: (bodyObj) => {
      const res = sandbox.doPost({ postData: { contents: JSON.stringify(bodyObj) }, parameter: {} });
      return JSON.parse(res.getContent());
    },
    get: (params) => {
      const res = sandbox.doGet({ parameter: params });
      return JSON.parse(res.getContent());
    },
    sendSignedWebhook: (mutations) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomBytes(12).toString("hex");
      const raw = JSON.stringify(mutations);
      const sig = crypto
        .createHmac("sha256", scriptProps.WEBHOOK_MANUAL_SECRET)
        .update(`${ts}.${nonce}.${raw}`)
        .digest("hex");
      const res = sandbox.doPost({
        parameter: {},
        postData: { contents: JSON.stringify({ webhook_auth: { timestamp: ts, nonce, signature: sig }, payload_raw: raw }) },
      });
      return JSON.parse(res.getContent());
    },
  };
}

function registerUser(h, token, email, name, roleHint = "ALUMNI") {
  h.tokenDirectory[token] = {
    sub: "sub_" + token,
    email,
    name,
    email_verified: "true",
    aud: h.scriptProps.GOOGLE_CLIENT_ID,
  };
  return h.post({ action: "register_or_login", id_token: token, role: roleHint, consent: true });
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

  console.log("🚀 RUNNING PHASE P4 DONATION MANAGEMENT & PROGRAM CRUD TESTS...\n");

  test("Program CRUD & Security: Admin CRUD lifecycle, unique IDs, non-admin blocked, inactive rejected, delete guard", () => {
    const h = createP4Harness({ useV2TestFixture: true });
    registerUser(h, "tok_adm", "maulanaa1408@upi.edu", "Admin UPI");
    registerUser(h, "tok_alu", "alumni@upi.edu", "Alumni Biasa");
    h.post({ action: "submit_verification", id_token: "tok_alu", nim: "200100", grad_year: "2024", faculty: "FPMIPA" });
    h.post({ action: "review_verification", id_token: "tok_adm", verif_id: h.sheets.alumni_verifications._rows[1][0], decision: "APPROVED" });

    // Non-admin blocked on all CRUD endpoints
    for (const act of ["admin_programs", "save_program", "delete_program"]) {
      const blocked = h.post({ action: act, id_token: "tok_alu", program_id: "PRG-001", name: "Hack", mode: "create" });
      assert.strictEqual(blocked.status, "error");
      assert(blocked.message.includes("Forbidden"), `Expected Forbidden on ${act}`);
    }

    // Admin lists initial 5 seeded programs + creates PRG-006
    const list1 = h.post({ action: "admin_programs", id_token: "tok_adm" });
    assert.strictEqual(list1.status, "ok");
    assert.strictEqual(list1.programs.length, 5);

    const created = h.post({
      action: "save_program",
      id_token: "tok_adm",
      mode: "create",
      name: "Beasiswa Riset AI",
      description: "Pendanaan riset mahasiswa",
      is_active: true,
    });
    assert.strictEqual(created.status, "ok");
    assert.strictEqual(created.program.program_id, "PRG-006");

    // Admin updates name/description cleanly
    const updated = h.post({
      action: "save_program",
      id_token: "tok_adm",
      mode: "update",
      program_id: "PRG-006",
      name: "Beasiswa Riset AI & Data",
      description: "Update deskripsi",
      is_active: true,
    });
    assert.strictEqual(updated.status, "ok");
    assert.strictEqual(updated.program.name, "Beasiswa Riset AI & Data");

    // Public GET active_programs returns updated active catalog without auth or PII
    const pubProgs = h.get({ action: "active_programs" });
    assert.strictEqual(pubProgs.status, "ok");
    assert.strictEqual(pubProgs.schema_ready, true);
    assert(pubProgs.programs.some((p) => p.program_id === "PRG-006"));

    // Verified alumni donates to PRG-006, then renaming/disabling PRG-006 never alters historical intent or allows deletion
    const intentRes = h.post({
      action: "create_intent",
      id_token: "tok_alu",
      amount: 100000,
      bank: "BCA",
      program_id: "PRG-006",
    });
    assert.strictEqual(intentRes.status, "ok");

    const toggled = h.post({ action: "save_program", id_token: "tok_adm", mode: "toggle", program_id: "PRG-006", is_active: false });
    assert.strictEqual(toggled.status, "ok");
    assert.strictEqual(toggled.program.is_active, false);

    // Inactive program rejected for new alumni & guest intents
    const blockedAlu = h.post({ action: "create_intent", id_token: "tok_alu", amount: 50000, bank: "BCA", program_id: "PRG-006" });
    assert.strictEqual(blockedAlu.status, "error");
    assert(blockedAlu.message.includes("tidak aktif"));

    const blockedGst = h.post({
      action: "create_guest_intent",
      donor_name: "Budi",
      donor_email: "budi@mail.com",
      amount: 50000,
      bank: "BCA",
      program_id: "PRG-006",
      consent: true,
    });
    assert.strictEqual(blockedGst.status, "error");
    assert(blockedGst.message.includes("tidak aktif"));

    // Historical usage guard blocks delete_program for used PRG-006
    const delConflict = h.post({ action: "delete_program", id_token: "tok_adm", program_id: "PRG-006" });
    assert.strictEqual(delConflict.status, "error");
    assert(delConflict.message.includes("Conflict"));

    // Unused PRG-007 can be created and deleted cleanly
    const c2 = h.post({ action: "save_program", id_token: "tok_adm", mode: "create", name: "Program Sementara" });
    assert.strictEqual(c2.program.program_id, "PRG-007");
    const delOk = h.post({ action: "delete_program", id_token: "tok_adm", program_id: "PRG-007" });
    assert.strictEqual(delOk.status, "ok");
  });

  test("Alumni Donation Flow: enforces APPROVED/VERIFIED status, blocks pending/revision/rejected/no-code, scopes my_donations", () => {
    const h = createP4Harness({ useV2TestFixture: true });
    registerUser(h, "tok_adm", "maulanaa1408@upi.edu", "Admin");

    // Seed statuses covering APPROVED, legacy VERIFIED, PENDING, NEEDS_REVISION, REJECTED, and APPROVED missing A000xxx
    h.tokenDirectory["tok_app"] = { sub: "s_app", email: "app@upi.edu", name: "App", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_ver"] = { sub: "s_ver", email: "ver@upi.edu", name: "Ver", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_pnd"] = { sub: "s_pnd", email: "pnd@upi.edu", name: "Pnd", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_rev"] = { sub: "s_rev", email: "rev@upi.edu", name: "Rev", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_rej"] = { sub: "s_rej", email: "rej@upi.edu", name: "Rej", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_noc"] = { sub: "s_noc", email: "noc@upi.edu", name: "Noc", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };

    h.sheets.users.appendRow(["U_APP", "s_app", "app@upi.edu", "Alumni Approved", "ALUMNI", "A000101", "APPROVED", "2026-01-01", "2026-01-01"]);
    h.sheets.users.appendRow(["U_VER", "s_ver", "ver@upi.edu", "Alumni Legacy", "ALUMNI", "A000102", "VERIFIED", "2026-01-01", "2026-01-01"]);
    h.sheets.users.appendRow(["U_PND", "s_pnd", "pnd@upi.edu", "Alumni Pending", "ALUMNI", "", "PENDING", "2026-01-01", "2026-01-01"]);
    h.sheets.users.appendRow(["U_REV", "s_rev", "rev@upi.edu", "Alumni Revision", "ALUMNI", "", "NEEDS_REVISION", "2026-01-01", "2026-01-01"]);
    h.sheets.users.appendRow(["U_REJ", "s_rej", "rej@upi.edu", "Alumni Rejected", "ALUMNI", "", "REJECTED", "2026-01-01", "2026-01-01"]);
    h.sheets.users.appendRow(["U_NOC", "s_noc", "noc@upi.edu", "Alumni NoCode", "ALUMNI", "", "APPROVED", "2026-01-01", "2026-01-01"]);

    // Blocked alumni states
    for (const tok of ["tok_pnd", "tok_rev", "tok_rej", "tok_noc"]) {
      const blocked = h.post({ action: "create_intent", id_token: tok, amount: 50000, bank: "BCA", program_id: "PRG-001" });
      assert.strictEqual(blocked.status, "error");
      assert(blocked.message.includes("Forbidden"));
    }

    // APPROVED manual + Midtrans & legacy VERIFIED succeed
    const okApp = h.post({ action: "create_intent", id_token: "tok_app", amount: 250000, bank: "BSI", program_id: "PRG-002", is_anonymous: true });
    assert.strictEqual(okApp.status, "ok");
    assert.strictEqual(okApp.ref_code, "A000101");

    const okSnap = h.post({ action: "create_intent", id_token: "tok_app", amount: 150000, payment_channel: "MIDTRANS_SNAP", program_id: "PRG-003" });
    assert.strictEqual(okSnap.status, "ok");
    assert.strictEqual(okSnap.gateway_fee, 0);
    assert.strictEqual(okSnap.gross_amount, 150000);
    assert(okSnap.order_id.startsWith("DON-A000101-"));

    const okVer = h.post({ action: "create_intent", id_token: "tok_ver", amount: 100000, bank: "BCA", program_id: "PRG-001" });
    assert.strictEqual(okVer.status, "ok");

    // Scope isolation: tok_ver's my_donations contains only tok_ver's intent, never tok_app's
    const myVer = h.post({ action: "my_donations", id_token: "tok_ver" });
    assert.strictEqual(myVer.active_intents.length, 1);
    assert.strictEqual(myVer.active_intents[0].ref_code, "A000102");
  });

  test("Accountless Guest Checkout, Unique G000xxx, Rate-Limit, Validation, & 3-Tier Manual Match", () => {
    const h = createP4Harness({ useV2TestFixture: true });
    const usersBefore = h.sheets.users.getLastRow();

    // Validation failures: bad email, nominal < 100, missing consent, > MAX_DONATION_AMOUNT
    assert.strictEqual(
      h.post({ action: "create_guest_intent", donor_name: "A", donor_email: "bad-email", amount: 50000, bank: "BCA", program_id: "PRG-001", consent: true }).status,
      "error"
    );
    assert.strictEqual(
      h.post({ action: "create_guest_intent", donor_name: "Budi", donor_email: "budi@mail.com", amount: 50, bank: "BCA", program_id: "PRG-001", consent: true }).status,
      "error"
    );
    assert.strictEqual(
      h.post({ action: "create_guest_intent", donor_name: "Budi", donor_email: "budi@mail.com", amount: 50000, bank: "BCA", program_id: "PRG-001", consent: false }).status,
      "error"
    );
    assert.strictEqual(
      h.post({ action: "create_guest_intent", donor_name: "Budi", donor_email: "budi@mail.com", amount: 999999999, bank: "BCA", program_id: "PRG-001", consent: true }).status,
      "error"
    );

    // Valid Guests with attempted spoofed donor_type='ALUMNI' and ref_code='A000001' must still receive GUEST & sequential G000xxx
    const g1 = h.post({
      action: "create_guest_intent",
      donor_name: "Budi Santoso",
      donor_email: "budi.santoso@mail.com",
      donor_type: "ALUMNI",
      ref_code: "A000001",
      amount: 150000,
      bank: "BCA",
      program_id: "PRG-004",
      is_anonymous: true,
      consent: true,
    });
    const g2 = h.post({
      action: "create_guest_intent",
      donor_name: "Siti Aminah",
      donor_email: "siti@mail.com",
      amount: 200000,
      payment_channel: "MIDTRANS_SNAP",
      program_id: "PRG-002",
      consent: true,
    });

    assert.strictEqual(g1.status, "ok");
    assert.strictEqual(g1.donor_type, "GUEST");
    assert.strictEqual(g1.ref_code, "G000001");
    assert.strictEqual(g2.status, "ok");
    assert.strictEqual(g2.ref_code, "G000002");
    assert.notStrictEqual(g1.ref_code, g2.ref_code);
    assert.strictEqual(h.sheets.users.getLastRow(), usersBefore, "Accountless Guest must never create a users row");

    // Verify Guest 3-Tier manual bank reconciliation still works cleanly & respects is_anonymous=YES
    const vaNum = g1.virtual_account.va_number;
    const whRes = h.sendSignedWebhook([{
      mutation_id: "MUT_P4_GUEST_1",
      bank: "BCA",
      amount: 150000,
      type: "CR",
      description: `TRSF VA ${vaNum} AN BUDI SANTOSO BEASISWA`,
    }]);
    assert.strictEqual(whRes.matched, 1);

    const txRow = h.sheets.transactions._rows[1];
    assert.strictEqual(txRow[9], "Seseorang");
    assert.strictEqual(txRow[13], "G000001");
    assert.strictEqual(txRow[15], "Wakaf Pendidikan");
    assert.strictEqual(txRow[16], "YES");

    // Guest cannot call my_donations without Google user account
    assert.strictEqual(h.post({ action: "my_donations", access_token: g1.access_token }).status, "error");
  });

  test("Secure 256-bit Guest Access Token: entropy, hashed storage, pepper fail-closed, anti-IDOR, rate-limit, & zero log leak", () => {
    const h = createP4Harness({ useV2TestFixture: true });

    const g1 = h.post({
      action: "create_guest_intent",
      donor_name: "Guest Satu",
      donor_email: "g1@mail.com",
      amount: 120000,
      bank: "BNI",
      program_id: "PRG-001",
      consent: true,
    });
    const g2 = h.post({
      action: "create_guest_intent",
      donor_name: "Guest Dua",
      donor_email: "g2@mail.com",
      amount: 130000,
      bank: "BSI",
      program_id: "PRG-002",
      consent: true,
    });

    // 256-bit token format check (64 hex chars)
    assert(/^[a-f0-9]{64}$/.test(g1.access_token), "Expected 64-hex-char 256-bit token");

    // Sheet stores hash ONLY, never raw token; audit_log & Logger contain zero raw tokens
    const iMap = h.sandbox.getHeaderMap_(h.sheets.donation_intents);
    const storedHash = h.sheets.donation_intents._rows[1][iMap.access_token_hash];
    assert(storedHash && storedHash !== g1.access_token && /^[a-f0-9]{64}$/.test(storedHash));
    assert(!JSON.stringify(h.sheets.audit_log._rows).includes(g1.access_token));
    assert(!h.logs.join("\n").includes(g1.access_token));

    // Query string rejection
    assert.strictEqual(h.get({ action: "guest_lookup", access_token: g1.access_token, ref_code: g1.ref_code }).status, "error");

    // Valid token succeeds on check_intent & guest_lookup
    const checkOk = h.post({ action: "check_intent", intent_id: g1.intent_id, access_token: g1.access_token });
    assert.strictEqual(checkOk.status, "ok");
    const lookupOk = h.post({ action: "guest_lookup", ref_code: g1.ref_code, access_token: g1.access_token });
    assert.strictEqual(lookupOk.status, "ok");
    assert.strictEqual(lookupOk.ref_code, g1.ref_code);

    // Cross-guest access, empty token, and ref-only/email lookup rejected
    assert.strictEqual(h.post({ action: "check_intent", intent_id: g1.intent_id, access_token: g2.access_token }).status, "error");
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: g1.ref_code, access_token: g2.access_token }).status, "error");
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: g1.ref_code, donor_email: "g1@mail.com" }).status, "error");

    // Expired token rejected
    h.sheets.donation_intents.getRange(2, iMap.access_token_expires_at + 1).setValue("2020-01-01T00:00:00Z");
    const expCheck = h.post({ action: "guest_lookup", ref_code: g1.ref_code, access_token: g1.access_token });
    assert.strictEqual(expCheck.status, "error");
    assert(expCheck.message.includes("expired"));

    // Rate-limit locks out repeated invalid guesses for g2
    for (let k = 0; k < 10; k++) {
      h.post({ action: "guest_lookup", ref_code: g2.ref_code, access_token: "0".repeat(64) });
    }
    const rateLimited = h.post({ action: "guest_lookup", ref_code: g2.ref_code, access_token: g2.access_token });
    assert.strictEqual(rateLimited.status, "error");
    assert(rateLimited.message.includes("Too Many Requests"));

    // Missing TOKEN_PEPPER fails closed
    const hNoPepper = createP4Harness({ useV2TestFixture: true, props: { TOKEN_PEPPER: "" } });
    const noPepRes = hNoPepper.post({
      action: "create_guest_intent",
      donor_name: "Guest NoPep",
      donor_email: "np@mail.com",
      amount: 50000,
      bank: "BCA",
      program_id: "PRG-001",
      consent: true,
    });
    assert.strictEqual(noPepRes.status, "error");
    assert(noPepRes.message.includes("TOKEN_PEPPER"));
  });

  test("Idempotency Proof Recovery, Concurrent Same-Request, Mismatched Payload Conflict, Midtrans Guard & Frontend Checks", async () => {
    // 1. Lost HTTP response + verified proof retry rotates token safely (no raw token in cache/props/DB)
    const h = createP4Harness({ useV2TestFixture: true });
    const reqId = "idem-req-uuid-12345678";
    const proofSecret = crypto.randomBytes(32).toString("hex");
    const payload = {
      action: "create_guest_intent",
      donor_name: "Rina",
      donor_email: "rina@mail.com",
      amount: 75000,
      payment_channel: "MIDTRANS_SNAP",
      program_id: "PRG-005",
      consent: true,
      client_request_id: reqId,
      idempotency_proof: proofSecret,
    };

    const locksBefore = h.getLockCalls();
    const first = h.post(payload);
    assert.strictEqual(first.status, "ok");
    const lostFirstToken = first.access_token;

    // Concurrent / duplicate retries using Promise.all with same request_id + proof + payload
    const [retryA, retryB] = await Promise.all([
      Promise.resolve().then(() => h.post(payload)),
      Promise.resolve().then(() => h.post(payload)),
    ]);

    assert.strictEqual(retryA.status, "ok");
    assert.strictEqual(retryA.deduplicated, true);
    assert.strictEqual(retryA.recovered, true);
    assert.strictEqual(retryA.token_rotated, true);
    assert.strictEqual(retryA.intent_id, first.intent_id);
    assert.strictEqual(retryA.ref_code, first.ref_code);
    assert.strictEqual(retryB.status, "ok");
    assert.strictEqual(retryB.intent_id, first.intent_id);
    assert.strictEqual(retryB.ref_code, first.ref_code);
    assert.strictEqual(h.sheets.donation_intents.getLastRow(), 2, "Concurrent/retry requests must not insert 2nd row");
    assert(h.getLockCalls() >= locksBefore + 3, "LockService must guard creation & each rotation");

    // Old lost token and superseded retryA token must both be invalidated; latest retryB token works!
    assert.notStrictEqual(retryA.access_token, lostFirstToken);
    assert.notStrictEqual(retryB.access_token, retryA.access_token);
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: first.ref_code, access_token: lostFirstToken }).status, "error");
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: first.ref_code, access_token: retryA.access_token }).status, "error");
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: first.ref_code, access_token: retryB.access_token }).status, "ok");

    // Ensure raw tokens and idempotency_proof NEVER persist in DB, cache, ScriptProperties, audit_log, or Logger
    const fullMemoryDump = JSON.stringify({
      intents: h.sheets.donation_intents._rows,
      audit: h.sheets.audit_log._rows,
      props: h.scriptProps,
      cache: h.scriptCache,
      logs: h.logs,
    });
    for (const secretVal of [lostFirstToken, retryA.access_token, retryB.access_token, proofSecret]) {
      assert(!fullMemoryDump.includes(secretVal), "Raw secret leaked into persistent/cache/log storage");
    }

    // Same client_request_id with altered payload MUST return 409 Conflict
    const mismatchRes = h.post({ ...payload, amount: 90000 });
    assert.strictEqual(mismatchRes.status, "error");
    assert(mismatchRes.message.includes("Conflict"));

    // Attacker with same client_request_id + payload but wrong or missing idempotency_proof is rejected
    const hijackNoProof = h.post({ ...payload, idempotency_proof: "" });
    assert.strictEqual(hijackNoProof.status, "error");
    assert(hijackNoProof.message.includes("Forbidden"));

    const hijackBadProof = h.post({ ...payload, idempotency_proof: "f".repeat(64) });
    assert.strictEqual(hijackBadProof.status, "error");
    assert(hijackBadProof.message.includes("Forbidden"));

    // Ensure MIDTRANS_SNAP cannot be forged via simulate_manual_payment
    const simBlocked = h.post({ action: "simulate_manual_payment", intent_id: first.intent_id, access_token: retryB.access_token });
    assert.strictEqual(simBlocked.status, "error");
    assert(simBlocked.message.includes("Midtrans Snap"));

    // 2. Pre-P2.2 (v1 unmigrated sheet): admin CRUD and guest checkout fail explicitly without auto-creating sheets
    const hV1 = createP4Harness({ useV2TestFixture: false });
    registerUser(hV1, "tok_adm", "maulanaa1408@upi.edu", "Admin");
    const pubV1 = hV1.get({ action: "active_programs" });
    assert.strictEqual(pubV1.schema_ready, false);
    assert.strictEqual(pubV1.programs.length, 5);

    const adminV1Err = hV1.post({ action: "admin_programs", id_token: "tok_adm" });
    assert.strictEqual(adminV1Err.status, "error");
    assert(adminV1Err.message.includes("Schema dependency error"));
    assert.strictEqual(hV1.ss.getSheetByName("programs"), null, "Must never auto-create programs sheet pre-P2.2");

    const guestV1Err = hV1.post({
      action: "create_guest_intent",
      donor_name: "Budi",
      donor_email: "budi@mail.com",
      amount: 50000,
      bank: "BCA",
      program_id: "PRG-001",
      consent: true,
    });
    assert.strictEqual(guestV1Err.status, "error");
    assert(guestV1Err.message.includes("Schema dependency error"));

    // 3. Static frontend checks: no Guest Google Login button, sessionStorage only for Guest token & pending request proof
    const indexHtml = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf8");
    const authJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "auth.js"), "utf8");
    const guestJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "guest.js"), "utf8");
    assert(!indexHtml.includes("startLoginFlow('GUEST')"), "index.html must retire Guest Google login flow");
    assert(indexHtml.includes("openGuestCheckoutSection()"));
    assert(!guestJs.includes("API.post('register_or_login'") && !guestJs.includes('API.post("register_or_login"'));
    assert(guestJs.includes("API.post('create_guest_intent'"));
    assert(guestJs.includes("idempotency_proof"));
    assert(!guestJs.includes("window.localStorage"));
    assert(guestJs.includes("window.sessionStorage"));
    assert(authJs.includes('const normalizedRole = "ALUMNI"'));
  });

  test("Token Rotation (Self & Admin Recovery), Unauthorized Hijack Block, Expiry, & Mid-Process Failure Safety", () => {
    const h = createP4Harness({ useV2TestFixture: true });
    registerUser(h, "tok_adm", "maulanaa1408@upi.edu", "Admin");
    registerUser(h, "tok_alu", "alu@upi.edu", "Alumni Biasa");

    const g1 = h.post({
      action: "create_guest_intent",
      donor_name: "Guest A",
      donor_email: "ga@mail.com",
      amount: 100000,
      bank: "BCA",
      program_id: "PRG-001",
      consent: true,
      client_request_id: "req-rotate-a-0001",
      idempotency_proof: "a".repeat(64),
    });
    const g2 = h.post({
      action: "create_guest_intent",
      donor_name: "Guest B",
      donor_email: "gb@mail.com",
      amount: 100000,
      bank: "BSI",
      program_id: "PRG-002",
      consent: true,
    });
    assert.strictEqual(g1.ref_code, "G000001");
    assert.strictEqual(g2.ref_code, "G000002");

    // Cross-guest rotation & non-admin rotation must fail
    const crossRot = h.post({ action: "rotate_guest_token", ref_code: g1.ref_code, access_token: g2.access_token });
    assert.strictEqual(crossRot.status, "error");
    const nonAdmRot = h.post({ action: "rotate_guest_token", id_token: "tok_alu", ref_code: g1.ref_code });
    assert.strictEqual(nonAdmRot.status, "error");
    assert(nonAdmRot.message.includes("Forbidden"));

    // Valid Guest self-rotation immediately revokes g1.access_token
    const selfRot = h.post({ action: "rotate_guest_token", intent_id: g1.intent_id, access_token: g1.access_token });
    assert.strictEqual(selfRot.status, "ok");
    assert.strictEqual(selfRot.token_rotated, true);
    assert.notStrictEqual(selfRot.access_token, g1.access_token);
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: g1.ref_code, access_token: g1.access_token }).status, "error");
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: g1.ref_code, access_token: selfRot.access_token }).status, "ok");

    // Admin-assisted rotation dispatches #fragment email and revokes selfRot token without returning raw token in response
    const emailCountBefore = h.sentEmails.length;
    const admRot = h.post({ action: "rotate_guest_token", id_token: "tok_adm", ref_code: g1.ref_code });
    assert.strictEqual(admRot.status, "ok");
    assert.strictEqual(admRot.token_rotated, true);
    assert.strictEqual(admRot.email_dispatched, true);
    assert.strictEqual(admRot.access_token, undefined, "Admin response must not expose raw access_token");
    assert.strictEqual(h.sentEmails.length, emailCountBefore + 1);
    const emailedFragment = h.sentEmails[emailCountBefore].htmlBody.match(/#ref=G000001&amp;token=([a-f0-9]{64})/)[1];
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: g1.ref_code, access_token: selfRot.access_token }).status, "error");
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: g1.ref_code, access_token: emailedFragment }).status, "ok");

    // Expired token cannot be rotated
    const iMap = h.sandbox.getHeaderMap_(h.sheets.donation_intents);
    h.sheets.donation_intents.getRange(2, iMap.access_token_expires_at + 1).setValue("2020-01-01T00:00:00Z");
    const expRot = h.post({ action: "rotate_guest_token", intent_id: g1.intent_id, access_token: emailedFragment });
    assert.strictEqual(expRot.status, "error");
    assert(expRot.message.includes("expired"));

    // Mid-process storage failure Case A: appendRow fails before write -> zero row, counter untouched, safe retry succeeds
    const hFail = createP4Harness({ useV2TestFixture: true });
    const origAppend = hFail.sheets.donation_intents.appendRow;
    hFail.sheets.donation_intents.appendRow = () => {
      throw new Error("Simulated Sheets transient append failure");
    };
    const failReq = {
      action: "create_guest_intent",
      donor_name: "MidFail Donor",
      donor_email: "midfail@mail.com",
      amount: 85000,
      bank: "BRI",
      program_id: "PRG-001",
      consent: true,
      client_request_id: "req-midfail-00001",
      idempotency_proof: "b".repeat(64),
    };
    const resFailA = hFail.post(failReq);
    assert.strictEqual(resFailA.status, "error");
    assert.strictEqual(hFail.sheets.donation_intents.getLastRow(), 1, "No partial row written on append failure");
    assert.strictEqual(hFail.sheets.counters._rows[2][1], 0, "GUEST counter must not burn sequence on append failure");

    // Restore appendRow and retry -> cleanly gets G000001
    hFail.sheets.donation_intents.appendRow = origAppend;
    const resRecoverA = hFail.post(failReq);
    assert.strictEqual(resRecoverA.status, "ok");
    assert.strictEqual(resRecoverA.ref_code, "G000001");

    // Mid-process storage failure Case B: counter update throws AFTER intent append + idem commit -> retry recovers G000001 cleanly & next Guest gets G000002
    const ctrOrigGetRange = hFail.sheets.counters.getRange;
    let ctrFailOnce = true;
    hFail.sheets.counters.getRange = function (r, c, nr, nc) {
      const rng = ctrOrigGetRange(r, c, nr, nc);
      return {
        ...rng,
        setValue: (v) => {
          if (ctrFailOnce && r === 3 && c === 2) {
            ctrFailOnce = false;
            throw new Error("Simulated counter commit failure after intent append");
          }
          return rng.setValue(v);
        },
      };
    };
    const failCaseBReq = {
      action: "create_guest_intent",
      donor_name: "CtrFail Donor",
      donor_email: "ctrfail@mail.com",
      amount: 95000,
      bank: "MANDIRI",
      program_id: "PRG-003",
      consent: true,
      client_request_id: "req-ctrfail-00002",
      idempotency_proof: "c".repeat(64),
    };
    const firstCtrFail = hFail.post(failCaseBReq);
    assert.strictEqual(firstCtrFail.status, "error");
    assert.strictEqual(hFail.sheets.donation_intents.getLastRow(), 3); // header + G000001 + G000002
    const recB = hFail.post(failCaseBReq);
    assert.strictEqual(recB.status, "ok");
    assert.strictEqual(recB.deduplicated, true);
    assert.strictEqual(recB.recovered, true);
    assert.strictEqual(recB.ref_code, "G000002");
    assert.strictEqual(hFail.sheets.donation_intents.getLastRow(), 3, "No duplicate row after recovery");

    const nextFreshGuest = hFail.post({
      action: "create_guest_intent",
      donor_name: "Fresh Third",
      donor_email: "third@mail.com",
      amount: 60000,
      bank: "BCA",
      program_id: "PRG-001",
      consent: true,
    });
    assert.strictEqual(nextFreshGuest.ref_code, "G000003", "Sequence scan prevents G000xxx collision even after prior counter error");
  });

  console.log(`\n==========================================\nP4 DONATION MANAGEMENT SUITE: ${passed} Passed, ${failed} Failed\n==========================================`);
  if (failed > 0) process.exit(1);
}

runTests();
