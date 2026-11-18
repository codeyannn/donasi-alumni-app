/**
 * p8_acceptance_20_scenarios.test.js
 * Unified Phase P8 Verification Suite covering all 20 mandatory acceptance scenarios
 * (TEST-01 through TEST-20) defined in testing_strategy.md on an isolated Node.js GAS VM harness.
 *
 * Scope Notice: Verifies domain logic, security guards, state machines, idempotency,
 * migration integrity, and static CORS transport rules locally. Live Google OAuth tokeninfo,
 * Drive, Gmail, Netlify cross-origin, and Midtrans Sandbox network calls still require Live QA.
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
 * Signs a manual bank webhook payload using HMAC-SHA256(timestamp.nonce.payload_raw).
 */
function signManualWebhookBody(mutationsArr, secret) {
  const rawPayload = JSON.stringify(mutationsArr);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = "p8_nonce_" + crypto.randomUUID();
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${nonce}.${rawPayload}`, "utf8")
    .digest("hex");
  return {
    webhook_auth: { timestamp: ts, nonce: nonce, signature: sig },
    payload_raw: rawPayload,
  };
}

/**
 * Signs a simulated Midtrans webhook notification using SHA-512.
 */
function signMidtransNotification(payload, serverKey) {
  const raw =
    String(payload.order_id) +
    String(payload.status_code) +
    String(payload.gross_amount) +
    String(serverKey);
  return {
    ...payload,
    signature_key: crypto.createHash("sha512").update(raw, "utf8").digest("hex"),
  };
}

/**
 * Creates a full in-memory GAS V8 harness supporting V1->V2 migration, backup copies,
 * OAuth mocks, Drive, MailApp, CacheService, LockService, and Midtrans Sandbox HTTP mocks.
 */
function createP8Harness(options = {}) {
  const spreadsheetRegistry = {};
  let spreadsheetCounter = 0;

  function makeSpreadsheet(initialName) {
    spreadsheetCounter++;
    const ssId = "STAGING_P8_SS_" + spreadsheetCounter;
    const ssName = initialName || "STAGING_P8_TestDB";
    const sheetOrder = [];
    const sheetsByName = {};

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
          if (rowIdx1 >= 1 && rowIdx1 <= rows.length) rows.splice(rowIdx1 - 1, 1);
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
      deleteSheet: (s) => {
        const n = typeof s === "string" ? s : s.getName();
        delete sheetsByName[n];
        const idx = sheetOrder.indexOf(n);
        if (idx !== -1) sheetOrder.splice(idx, 1);
      },
      copy: (copyName) => {
        const cloned = makeSpreadsheet(copyName || ssName + "_Copy");
        for (const n of sheetOrder) {
          const ns = cloned.insertSheet(n);
          const m = sheetsByName[n].getDataRange().getValues();
          if (m.length > 0 && m[0].length > 0) {
            ns.getRange(1, 1, m.length, m[0].length).setValues(m);
          }
        }
        return cloned;
      },
    };
    spreadsheetRegistry[ssId] = ssObj;
    return ssObj;
  }

  const activeSs = makeSpreadsheet("STAGING_DonasiAlumniApp_P8");
  const scriptProps = {
    EXPECTED_STAGING_SPREADSHEET_ID: activeSs.getId(),
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "admin1@upi.edu,admin2@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p8_test_hmac_secret_32bytes_value",
    TOKEN_PEPPER: "p8_test_pepper_32bytes_secret_value",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-P8_ACCEPTANCE_TEST_KEY",
    MIDTRANS_IS_PRODUCTION: "false",
    ALLOW_MOCK_AUTH: "false",
    ...(options.props || {}),
  };
  const scriptCache = {};
  const userCache = {};
  const sentEmails = [];
  const tokenDirectory = {};
  const midtransStatusByOrderId = {};
  let mailShouldThrow = false;

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
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSs,
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
    MailApp: {
      sendEmail: (obj) => {
        if (mailShouldThrow) throw new Error("Simulated MailApp error");
        sentEmails.push(obj);
      },
    },
    DriveApp: {
      Access: { ANYONE: "ANYONE", PRIVATE: "PRIVATE" },
      Permission: { NONE: "NONE", VIEW: "VIEW" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({
        setSharing: () => {},
        createFile: () => ({ getId: () => "DRV_" + crypto.randomUUID().slice(0, 6), setSharing: () => {} }),
      }),
      getFileById: () => ({
        setTrashed: () => {},
        getBlob: () => ({ getBytes: () => [1, 2, 3], getContentType: () => "application/pdf", getName: () => "proof.pdf" }),
      }),
    },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5", SHA_256: "SHA_256", SHA_512: "SHA_512" },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => new Date(d).toISOString().replace("T", " ").substring(0, 19),
      base64Encode: (input) =>
        Array.isArray(input)
          ? Buffer.from(input.map((b) => (b < 0 ? b + 256 : b))).toString("base64")
          : Buffer.from(String(input), "utf8").toString("base64"),
      base64Decode: (b64) => Array.from(Buffer.from(String(b64 || ""), "base64")),
      newBlob: (bytes, mime, name) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
      computeDigest: (algo, input) => {
        const alg = algo === "SHA_256" ? "sha256" : algo === "SHA_512" ? "sha512" : "md5";
        return Array.from(crypto.createHash(alg).update(String(input), "utf8").digest()).map((b) => (b >= 128 ? b - 256 : b));
      },
      computeHmacSha256Signature: (msg, key) => {
        return Array.from(crypto.createHmac("sha256", String(key)).update(String(msg), "utf8").digest()).map((b) => (b >= 128 ? b - 256 : b));
      },
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
            getContentText: () => JSON.stringify({ token: "SNAP_" + oid, redirect_url: "https://sandbox/" + oid }),
          };
        }
        const stMatch = url.match(/\/v2\/([^/]+)\/status$/);
        if (stMatch) {
          const oid = decodeURIComponent(stMatch[1]);
          const mocked = midtransStatusByOrderId[oid];
          if (!mocked) {
            return { getResponseCode: () => 404, getContentText: () => JSON.stringify({ status_code: "404" }) };
          }
          return { getResponseCode: () => mocked.http_status || 200, getContentText: () => JSON.stringify(mocked) };
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
  if (!options.keepV1) {
    sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: false, backupVerified: true });
  }

  return {
    ss: activeSs,
    sandbox,
    scriptProps,
    sentEmails,
    midtransStatusByOrderId,
    setMailShouldThrow: (v) => {
      mailShouldThrow = Boolean(v);
    },
    registerOAuth: (tok, claims) => {
      tokenDirectory[tok] = { aud: scriptProps.GOOGLE_CLIENT_ID, email_verified: "true", ...claims };
    },
    registerRawToken: (tok, claims) => {
      tokenDirectory[tok] = claims;
    },
    post: (bodyObj, params = {}) =>
      JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(bodyObj) }, parameter: params }).getContent()),
    get: (params) => JSON.parse(sandbox.doGet({ parameter: params }).getContent()),
    approveNewAlumni: (tokAlu, email, name, nim) => {
      const reg = JSON.parse(
        sandbox.doPost({ postData: { contents: JSON.stringify({ action: "register_or_login", id_token: tokAlu, consent: true }) }, parameter: {} }).getContent()
      );
      const sub = JSON.parse(
        sandbox
          .doPost({
            postData: {
              contents: JSON.stringify({
                action: "submit_verification",
                id_token: tokAlu,
                nim: nim || "2408647",
                grad_year: "2024",
                faculty: "FPMIPA",
                file_name: "ijazah.pdf",
                file_mime: "application/pdf",
                file_base64: Buffer.from("%PDF-1.4 test").toString("base64"),
              }),
            },
            parameter: {},
          })
          .getContent()
      );
      const rev = JSON.parse(
        sandbox
          .doPost({
            postData: {
              contents: JSON.stringify({
                action: "review_verification",
                id_token: "tok_admin1",
                verif_id: sub.verif_id,
                decision: "APPROVED",
              }),
            },
            parameter: {},
          })
          .getContent()
      );
      return { user: reg.user, verif_id: sub.verif_id, ref_code: rev.ref_code };
    },
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

  console.log("🏁 RUNNING PHASE P8 UNIFIED 20-SCENARIO ACCEPTANCE SUITE (TEST-01..TEST-20)...\n");

  test("TEST-01..TEST-04: Auth Rejections, Admin RBAC, Privilege Escalation Block, & Guest Anti-IDOR", () => {
    const h = createP8Harness();
    h.registerOAuth("tok_admin1", { sub: "s_adm1", email: "admin1@upi.edu", name: "Admin 1" });
    h.registerOAuth("tok_alu", { sub: "s_alu1", email: "alu1@upi.edu", name: "Alumni Satu" });
    h.registerRawToken("tok_wrong_aud", { sub: "s_bad", email: "x@upi.edu", aud: "OTHER_CLIENT", email_verified: "true" });
    h.registerRawToken("tok_unverified_mail", { sub: "s_unv", email: "y@upi.edu", aud: h.scriptProps.GOOGLE_CLIENT_ID, email_verified: "false" });

    h.post({ action: "register_or_login", id_token: "tok_admin1", consent: true });

    // TEST-01: Invalid JWT, wrong aud, unverified email, & mock_token_admin blocked when ALLOW_MOCK_AUTH=false
    const usersBefore = h.ss.getSheetByName("users").getLastRow();
    assert.strictEqual(h.post({ action: "register_or_login", id_token: "invalid.jwt.string", consent: true }).status, "error");
    assert.strictEqual(h.post({ action: "register_or_login", id_token: "tok_wrong_aud", consent: true }).status, "error");
    assert.strictEqual(h.post({ action: "register_or_login", id_token: "tok_unverified_mail", consent: true }).status, "error");
    assert.strictEqual(h.post({ action: "register_or_login", id_token: "mock_token_admin", consent: true }).status, "error");
    assert.strictEqual(h.ss.getSheetByName("users").getLastRow(), usersBefore);

    // TEST-03: Client payload attempting role: "ADMIN" is explicitly rejected and never elevates privileges
    const escRes = h.post({ action: "register_or_login", id_token: "tok_alu", role: "ADMIN", consent: true });
    assert.strictEqual(escRes.status, "error");
    assert.ok(escRes.message.includes("Forbidden") || escRes.message.includes("ADMIN"));
    const normalLogin = h.post({ action: "register_or_login", id_token: "tok_alu", consent: true });
    assert.strictEqual(normalLogin.status, "ok");
    assert.strictEqual(normalLogin.user.role, "ALUMNI");
    assert.strictEqual(normalLogin.user.ref_code, "");
    assert.strictEqual(normalLogin.user.verification_status, "NOT_SUBMITTED");

    // TEST-02: Regular Alumni blocked from every admin endpoint
    for (const action of [
      "admin_verifications",
      "admin_verif_proof",
      "review_verification",
      "admin_queue",
      "resolve_queue",
      "admin_transactions",
      "save_program",
      "delete_program",
      "retry_tx_email",
      "admin_audit_logs",
      "admin_check_midtrans",
    ]) {
      const r = h.post({ action, id_token: "tok_alu", verif_id: "V1", queue_id: "Q1", program_id: "PRG-001", tx_id: "T1", intent_id: "I1" });
      assert.strictEqual(r.status, "error", `Expected non-admin block for ${action}`);
      assert.ok(r.message.includes("Forbidden"), `Expected Forbidden for ${action}`);
    }

    // TEST-04: Guest cross-token IDOR blocked on check_intent, guest_lookup, & get_receipt
    const gA = h.post({
      action: "create_guest_intent",
      donor_name: "Guest A",
      donor_email: "ga@example.com",
      amount: 100000,
      program_id: "PRG-001",
      payment_channel: "MANUAL_TRANSFER",
      bank: "BCA",
      is_anonymous: false,
      consent: true,
    });
    const gB = h.post({
      action: "create_guest_intent",
      donor_name: "Guest B",
      donor_email: "gb@example.com",
      amount: 100000,
      program_id: "PRG-001",
      payment_channel: "MANUAL_TRANSFER",
      bank: "BCA",
      is_anonymous: false,
      consent: true,
    });
    assert.strictEqual(h.post({ action: "check_intent", intent_id: gA.intent_id, access_token: gB.access_token }).status, "error");
    assert.strictEqual(h.post({ action: "guest_lookup", ref_code: gA.ref_code, access_token: gB.access_token }).status, "error");
    assert.strictEqual(h.post({ action: "get_receipt", ref_code: gA.ref_code, access_token: "" }).status, "error");
  });

  test("TEST-05..TEST-07 & TEST-17: Accountless Guest Manual/Midtrans, Pre-APPROVED Lock & REJECTED Finality, & Concurrent Admin Approval", () => {
    const h = createP8Harness();
    h.registerOAuth("tok_admin1", { sub: "s_adm1", email: "admin1@upi.edu", name: "Admin 1" });
    h.registerOAuth("tok_admin2", { sub: "s_adm2", email: "admin2@upi.edu", name: "Admin 2" });
    h.post({ action: "register_or_login", id_token: "tok_admin1", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_admin2", consent: true });
    const usersAfterAdmins = h.ss.getSheetByName("users").getLastRow();

    // TEST-05: Guest Manual Transfer without any row in users
    const gManual = h.post({
      action: "create_guest_intent",
      donor_name: "Tamu Manual",
      donor_email: "tman@example.com",
      amount: 150000,
      program_id: "PRG-001",
      payment_channel: "MANUAL_TRANSFER",
      bank: "BCA",
      is_anonymous: false,
      consent: true,
    });
    assert.strictEqual(h.ss.getSheetByName("users").getLastRow(), usersAfterAdmins, "Guest checkout must not add row to users");
    const whManual = h.post(
      signManualWebhookBody(
        [{ mutation_id: "MUT_P8_T5", bank: "BCA", amount: 150000, type: "CR", description: `TRSF ${gManual.ref_code} TAMU MANUAL` }],
        h.scriptProps.WEBHOOK_MANUAL_SECRET
      )
    );
    assert.strictEqual(whManual.matched, 1);
    const manReceipt = h.post({ action: "get_receipt", ref_code: gManual.ref_code, access_token: gManual.access_token });
    assert.strictEqual(manReceipt.status, "ok");
    assert.match(manReceipt.receipt.receipt_no, /^KWT-\d{4}-000001$/);

    // TEST-06: Guest Midtrans Snap without any row in users (Sandbox OPEN-03 fee=0)
    const gSnap = h.post({
      action: "create_guest_intent",
      donor_name: "Tamu Snap",
      donor_email: "tsnap@example.com",
      amount: 200000,
      program_id: "PRG-002",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });
    assert.strictEqual(h.ss.getSheetByName("users").getLastRow(), usersAfterAdmins);
    assert.ok(gSnap.snap_token.startsWith("SNAP_"));
    assert.strictEqual(gSnap.gateway_fee, 0);
    const mtSettle = h.post(
      signMidtransNotification(
        {
          order_id: gSnap.order_id,
          transaction_id: "MT_P8_T6",
          status_code: "200",
          gross_amount: "200000.00",
          transaction_status: "settlement",
          payment_type: "qris",
        },
        h.scriptProps.MIDTRANS_SERVER_KEY
      )
    );
    assert.strictEqual(mtSettle.intent_status, "MATCHED");
    const snapReceipt = h.post({ action: "get_receipt", ref_code: gSnap.ref_code, access_token: gSnap.access_token });
    assert.strictEqual(snapReceipt.receipt.gateway_fee, 0);
    assert.ok(snapReceipt.receipt.environment_notice.includes("Mode Sandbox"));

    // TEST-07 & TEST-17: Pre-APPROVED lock, NEEDS_REVISION resubmit, REJECTED finality, & dual-admin lock conflict
    h.registerOAuth("tok_alu_flow", { sub: "s_af", email: "aluflow@upi.edu", name: "Alumni Flow" });
    h.post({ action: "register_or_login", id_token: "tok_alu_flow", consent: true });
    assert.strictEqual(
      h.post({ action: "create_intent", id_token: "tok_alu_flow", amount: 100000, payment_channel: "MANUAL_TRANSFER", bank: "BCA", program_id: "PRG-001" }).status,
      "error"
    );

    const vSub = h.post({
      action: "submit_verification",
      id_token: "tok_alu_flow",
      nim: "2400001",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_name: "doc.pdf",
      file_mime: "application/pdf",
      file_base64: Buffer.from("%PDF-1.4").toString("base64"),
    });
    // NEEDS_REVISION allows resubmission, then Admin 1 & Admin 2 race on approval
    h.post({ action: "review_verification", id_token: "tok_admin1", verif_id: vSub.verif_id, decision: "NEEDS_REVISION", reason: "Buram" });
    const vResub = h.post({
      action: "submit_verification",
      id_token: "tok_alu_flow",
      nim: "2400001",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_name: "doc2.pdf",
      file_mime: "application/pdf",
      file_base64: Buffer.from("%PDF-1.4 clear").toString("base64"),
    });
    const adm1Approve = h.post({ action: "review_verification", id_token: "tok_admin1", verif_id: vResub.verif_id, decision: "APPROVED" });
    assert.strictEqual(adm1Approve.status, "ok");
    assert.match(adm1Approve.ref_code, /^A\d{6}$/);
    const adm2Race = h.post({ action: "review_verification", id_token: "tok_admin2", verif_id: vResub.verif_id, decision: "APPROVED" });
    assert.strictEqual(adm2Race.status, "error", "Second admin approving same ticket must fail cleanly");

    // REJECTED is terminal & blocks re-submission
    h.registerOAuth("tok_alu_rej", { sub: "s_ar", email: "alurej@upi.edu", name: "Alumni Rej" });
    h.post({ action: "register_or_login", id_token: "tok_alu_rej", consent: true });
    const vRejSub = h.post({
      action: "submit_verification",
      id_token: "tok_alu_rej",
      nim: "2409999",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_name: "bad.pdf",
      file_mime: "application/pdf",
      file_base64: Buffer.from("%PDF-1.4 bad").toString("base64"),
    });
    h.post({ action: "review_verification", id_token: "tok_admin1", verif_id: vRejSub.verif_id, decision: "REJECTED", reason: "Data palsu" });
    const blockedReapply = h.post({
      action: "submit_verification",
      id_token: "tok_alu_rej",
      nim: "2409999",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_name: "reapply.pdf",
      file_mime: "application/pdf",
      file_base64: Buffer.from("%PDF-1.4").toString("base64"),
    });
    assert.strictEqual(blockedReapply.status, "error");
    assert.strictEqual(
      h.post({ action: "create_intent", id_token: "tok_alu_rej", amount: 100000, payment_channel: "MANUAL_TRANSFER", bank: "BCA", program_id: "PRG-001" }).status,
      "error"
    );
  });

  test("TEST-08..TEST-16: Midtrans Security/Idempotency/Email Isolation/Refund & 3-Tier Anti-False-Match/Expiry", () => {
    const h = createP8Harness();
    h.registerOAuth("tok_admin1", { sub: "s_adm1", email: "admin1@upi.edu", name: "Admin 1" });
    h.registerOAuth("tok_alu_m", { sub: "s_am", email: "alum@upi.edu", name: "Alumni Match" });
    h.post({ action: "register_or_login", id_token: "tok_admin1", consent: true });
    const aluInfo = h.approveNewAlumni("tok_alu_m", "alum@upi.edu", "Alumni Match", "2405555");

    // TEST-16: Concurrent/consecutive create_guest_intent produce strictly unique ref_code & order_id
    const g1 = h.post({
      action: "create_guest_intent",
      donor_name: "Race Guest 1",
      donor_email: "rg1@example.com",
      amount: 500000,
      program_id: "PRG-001",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });
    const g2 = h.post({
      action: "create_guest_intent",
      donor_name: "Race Guest 2",
      donor_email: "rg2@example.com",
      amount: 125000,
      program_id: "PRG-001",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });
    assert.notStrictEqual(g1.ref_code, g2.ref_code);
    assert.notStrictEqual(g1.order_id, g2.order_id);

    // TEST-08 & TEST-09: Invalid Midtrans signature & gross_amount tampering rejected
    assert.strictEqual(
      h.post(signMidtransNotification({ order_id: g1.order_id, status_code: "200", gross_amount: "500000.00", transaction_status: "settlement" }, "BAD_KEY")).status,
      "error"
    );
    assert.strictEqual(
      h.post(signMidtransNotification({ order_id: g1.order_id, status_code: "200", gross_amount: "50000.00", transaction_status: "settlement" }, h.scriptProps.MIDTRANS_SERVER_KEY)).status,
      "error"
    );

    // TEST-10 & TEST-11 & TEST-12: 3x duplicate webhook + concurrent Active Inquiry + MailApp failure isolation & retry_tx_email
    h.setMailShouldThrow(true);
    const validNotif = signMidtransNotification(
      {
        order_id: g1.order_id,
        transaction_id: "MT_P8_IDEM_01",
        status_code: "200",
        gross_amount: "500000.00",
        transaction_status: "settlement",
        payment_type: "bank_transfer",
        va_numbers: [{ bank: "bca" }],
      },
      h.scriptProps.MIDTRANS_SERVER_KEY
    );
    const r1 = h.post(validNotif);
    const r2 = h.post(validNotif);
    const r3 = h.post(validNotif);
    h.midtransStatusByOrderId[g1.order_id] = validNotif;
    const inqConcurrent = h.post({ action: "check_intent", intent_id: g1.intent_id, access_token: g1.access_token });
    assert.strictEqual(r1.intent_status, "MATCHED");
    assert.strictEqual(r1.email_status, "FAILED");
    assert.strictEqual(r2.duplicate, true);
    assert.strictEqual(r3.duplicate, true);
    assert.strictEqual(inqConcurrent.receipt_no, r1.receipt_no);
    assert.strictEqual(h.ss.getSheetByName("transactions").getLastRow(), 2);

    // Recover email via retry_tx_email (TEST-12)
    h.setMailShouldThrow(false);
    const retryRes = h.post({ action: "retry_tx_email", id_token: "tok_admin1", tx_id: r1.tx_id });
    assert.strictEqual(retryRes.email_status, "SENT");
    assert.strictEqual(h.post({ action: "retry_tx_email", id_token: "tok_admin1", tx_id: r1.tx_id }).status, "error");

    // TEST-13: Refund webhook updates in-place & deducts from public_summary
    assert.strictEqual(h.get({ action: "public_summary" }).total_amount, 500000);
    h.post(
      signMidtransNotification(
        {
          order_id: g1.order_id,
          transaction_id: "MT_P8_IDEM_01",
          status_code: "200",
          gross_amount: "500000.00",
          transaction_status: "refund",
        },
        h.scriptProps.MIDTRANS_SERVER_KEY
      )
    );
    assert.strictEqual(h.get({ action: "public_summary" }).total_amount, 0);
    assert.strictEqual(h.ss.getSheetByName("transactions").getLastRow(), 2);

    // TEST-14: Bank mutation with valid ref_code (A000001) & mismatched amount leaves 500k intent PENDING
    const intent500k = h.post({
      action: "create_intent",
      id_token: "tok_alu_m",
      amount: 500000,
      payment_channel: "MANUAL_TRANSFER",
      bank: "BCA",
      program_id: "PRG-001",
    });
    h.post(
      signManualWebhookBody(
        [{ mutation_id: "MUT_P8_100K", bank: "BCA", amount: 100000, type: "CR", description: `TRSF ${aluInfo.ref_code} BEASISWA` }],
        h.scriptProps.WEBHOOK_MANUAL_SECRET
      )
    );
    const chk500k = h.post({ action: "check_intent", id_token: "tok_alu_m", intent_id: intent500k.intent_id });
    assert.strictEqual(chk500k.intent_status, "PENDING", "500k intent must stay PENDING on 100k transfer");

    // TEST-15: Expired intent cannot be matched by Tier 2
    const iSheet = h.ss.getSheetByName("donation_intents");
    const iMap = h.sandbox.getHeaderMap_(iSheet);
    const iRows = iSheet.getDataRange().getValues();
    const row500k = iRows.findIndex((r, idx) => idx > 0 && r[iMap.intent_id] === intent500k.intent_id);
    iSheet.getRange(row500k + 1, iMap.expires_at + 1).setValue(new Date(Date.now() - 3600000).toISOString());
    h.sandbox.expireStaleIntents();
    assert.strictEqual(iSheet.getDataRange().getValues()[row500k][iMap.status], "EXPIRED");

    const whNoRefAfterExp = h.post(
      signManualWebhookBody(
        [{ mutation_id: "MUT_P8_AFTER_EXP", bank: "BCA", amount: 500000, type: "CR", description: "TRANSFER TANPA BERITA" }],
        h.scriptProps.WEBHOOK_MANUAL_SECRET
      )
    );
    assert.strictEqual(whNoRefAfterExp.unmatched, 1, "Transfer without ref must route to UNMATCHED when intent is EXPIRED");
  });

  test("TEST-18..TEST-20: Idempotent Migration DRY_RUN/2x Preservation & CORS text/plain + Zero Query Token Enforcement", () => {
    // TEST-18 & TEST-19: Pre-V2 database copy with historical users (NONE/VERIFIED), MATCHED, & UNMATCHED rows
    const h = createP8Harness({ keepV1: true });
    h.ss.getSheetByName("users").appendRow(["USR_OLD1", "sub1", "v@upi.edu", "Verified", "ALUMNI", "A000009", "VERIFIED", "2026-01-01", "2026-01-01"]);
    h.ss.getSheetByName("users").appendRow(["USR_OLD2", "sub2", "n@upi.edu", "None", "ALUMNI", "", "NONE", "2026-01-01", "2026-01-01"]);
    h.ss.getSheetByName("transactions").appendRow(["TX_OLD_M", "M_1", "2026-01-01", "BCA", "12****34", "2026-01-01", 250000, "TRSF A000009", "Verified", "V***d", "MATCHED", "1", "USR_OLD1", "A000009", "", "Beasiswa Alumni UPI", "NO"]);
    h.ss.getSheetByName("transactions").appendRow(["TX_OLD_U", "M_2", "2026-01-01", "BRI", "56****78", "2026-01-01", 120000, "NO REF", "Pengirim", "P***m", "UNMATCHED", "3", "", "", "", "Umum", "NO"]);

    const dry = h.sandbox.migrateDatabaseNonDestructive({ dryRun: true, enforceStagingGuard: true, spreadsheet: h.ss });
    assert.strictEqual(dry.status, "dry_run_ok");
    assert.strictEqual(dry.mutated, false);

    const mig1 = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: true, spreadsheet: h.ss });
    const mig2 = h.sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: true, spreadsheet: h.ss });
    assert.strictEqual(mig1.status, "migrated_ok");
    assert.strictEqual(mig2.status, "migrated_ok");
    assert.strictEqual(mig1.integrity.ok, true);
    assert.strictEqual(h.ss.getSheetByName("programs").getLastRow(), 6);
    assert.strictEqual(h.ss.getSheetByName("donation_intents").getLastColumn(), 21);
    assert.strictEqual(h.ss.getSheetByName("transactions").getLastColumn(), 35);

    const tMap = h.sandbox.getHeaderMap_(h.ss.getSheetByName("transactions"));
    const tRows = h.ss.getSheetByName("transactions").getDataRange().getValues();
    assert.match(String(tRows[1][tMap.receipt_no]), /^KWT-\d{4}-000001$/);
    assert.strictEqual(tRows[2][tMap.receipt_no], "", "UNMATCHED legacy transaction must retain empty receipt_no");

    const postInspect = h.sandbox.inspectStagingPostMigrationDetails({ spreadsheet: h.ss, skipLog: true });
    assert.strictEqual(postInspect.overall_status, "PASS");

    // TEST-20: CORS text/plain transport & zero URL query tokens across backend & frontend
    const apiJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "api.js"), "utf8");
    assert.ok(apiJs.includes("text/plain;charset=utf-8"), "api.js POST must use text/plain;charset=utf-8 to prevent CORS OPTIONS preflight");
    assert.ok(!apiJs.includes("application/json"), "api.js must avoid application/json header that triggers GAS CORS preflight failure");
    assert.strictEqual(h.get({ action: "my_donations", id_token: "leak" }).status, "error");
    assert.strictEqual(h.post({ action: "health" }, { token: "leak_in_query" }).status, "error");
  });

  console.log(`\n==========================================\nP8 UNIFIED 20-SCENARIO SUITE: ${passed} Passed, ${failed} Failed\n==========================================`);
  if (failed > 0) process.exit(1);
}

runTests();

