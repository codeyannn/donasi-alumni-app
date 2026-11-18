/**
 * p0_security.test.js
 * Comprehensive local security & regression test suite for Phase P0 (SEC-P0-1 to SEC-P0-8).
 * Evaluates actual Google Apps Script source files inside an isolated VM runtime and verifies
 * frontend API transport and simulator HMAC envelope compliance.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAS_DIR = path.join(ROOT_DIR, "apps-script");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");

/**
 * Creates an in-memory Google Sheets mock supporting Setup, Users, Donations, Audit, and Webhook ops.
 */
function createMockSpreadsheetHarness(initialProps = {}) {
  const sheets = {};
  const scriptProps = { ...initialProps };
  const scriptCache = {};
  const userCache = {};
  const tokenDirectory = {};

  function makeSheet(name) {
    const rows = [];
    const sheetObj = {
      getName: () => name,
      getLastRow: () => rows.length,
      appendRow: (row) => {
        rows.push([...row]);
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

  const ss = {
    getSheetByName: (name) => sheets[name] || null,
    insertSheet: (name) => {
      sheets[name] = makeSheet(name);
      return sheets[name];
    },
  };

  // Build Google Apps Script V8 service sandbox
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
      getActiveSpreadsheet: () => ss,
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
        waitLock: () => {},
        releaseLock: () => {},
      }),
    },
    MailApp: {
      sendEmail: () => {},
    },
    DriveApp: {
      Access: { ANYONE: "ANYONE" },
      Permission: { NONE: "NONE" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({ setSharing: () => {}, createFile: () => ({ getId: () => "file_1", setSharing: () => {} }) }),
      getFileById: () => ({ setTrashed: () => {} }),
    },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (txt) => ({
        _text: txt,
        setMimeType: function () {
          return this;
        },
        getContent: function () {
          return this._text;
        },
      }),
    },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5", SHA_256: "SHA_256", SHA_512: "SHA_512" },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => new Date(d).toISOString().slice(0, 19).replace("T", " "),
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
      base64Decode: (b64) => Array.from(Buffer.from(b64, "base64")),
      computeDigest: (alg, val) => {
        const nodeAlg = alg === "MD5" ? "md5" : alg === "SHA_512" ? "sha512" : "sha256";
        const buf = crypto.createHash(nodeAlg).update(String(val), "utf8").digest();
        return Array.from(buf, (b) => (b > 127 ? b - 256 : b));
      },
      computeHmacSha256Signature: (msg, secret) => {
        const buf = crypto.createHmac("sha256", String(secret)).update(String(msg), "utf8").digest();
        return Array.from(buf, (b) => (b > 127 ? b - 256 : b));
      },
    },
    UrlFetchApp: {
      fetch: (url) => {
        const tokenMatch = url.match(/id_token=([^&]+)/);
        const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : "";
        const claims = tokenDirectory[token];
        if (!claims) {
          return {
            getResponseCode: () => 400,
            getContentText: () => JSON.stringify({ error_description: "Invalid Value" }),
          };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(claims),
        };
      },
    },
    Logger: {
      _logs: [],
      log: function (m) {
        this._logs.push(String(m));
      },
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => "maulanaa1408@upi.edu" }),
    },
  };

  vm.createContext(sandbox);

  // Load all backend .gs files into one shared global GAS scope
  const gsOrder = [
    "Setup.gs",
    "Logic.gs",
    "AuditLog.gs",
    "Auth.gs",
    "Users.gs",
    "Programs.gs",
    "Donations.gs",
    "Webhook.gs",
    "Notifier.gs",
    "Admin.gs",
    "PublicApi.gs",
    "Code.gs",
  ];
  for (const file of gsOrder) {
    const code = fs.readFileSync(path.join(GAS_DIR, file), "utf8");
    vm.runInContext(code, sandbox, { filename: file });
  }

  sandbox.setupSheets();

  return {
    sandbox,
    sheets,
    scriptProps,
    tokenDirectory,
    callPost: (body, queryParams = {}) => {
      const e = {
        parameter: queryParams,
        postData: { contents: JSON.stringify(body) },
      };
      const out = sandbox.doPost(e);
      return JSON.parse(out.getContent());
    },
    callGet: (queryParams = {}) => {
      const e = { parameter: queryParams };
      const out = sandbox.doGet(e);
      return JSON.parse(out.getContent());
    },
  };
}

console.log("🔒 RUNNING PHASE P0 SECURITY & REGRESSION TESTS...\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

const VALID_CLIENT_ID = "898950675801-testclient.apps.googleusercontent.com";
const WEBHOOK_SECRET = "super_random_32byte_p0_webhook_secret_2026";

function signWebhook(mutations, secret, opts = {}) {
  const ts = String(opts.timestamp || Math.floor(Date.now() / 1000));
  const nonce = opts.nonce || crypto.randomBytes(12).toString("hex");
  const payloadRaw = JSON.stringify(mutations);
  let sig = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${nonce}.${payloadRaw}`, "utf8")
    .digest("hex");
  if (opts.tamper) sig = "a".repeat(64);
  return {
    webhook_auth: { timestamp: ts, nonce, signature: sig },
    payload_raw: payloadRaw,
  };
}

// 1. SEC-P0-1: Privilege escalation via role: "ADMIN"
test("SEC-P0-1: rejects client payload attempting role: ADMIN", () => {
  const h = createMockSpreadsheetHarness({
    GOOGLE_CLIENT_ID: VALID_CLIENT_ID,
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
  });
  h.tokenDirectory["tok_attacker"] = {
    sub: "sub_atk",
    email: "attacker@upi.edu",
    email_verified: "true",
    name: "Attacker",
    aud: VALID_CLIENT_ID,
  };

  const res = h.callPost({
    action: "register_or_login",
    id_token: "tok_attacker",
    role: "ADMIN",
    consent: true,
  });

  assert.strictEqual(res.status, "error");
  assert(res.message.includes("ADMIN"), "Expected error mentioning ADMIN restriction");
  // Confirm zero user rows created for attacker
  assert.strictEqual(h.sheets.users.getLastRow(), 1);
  // Confirm audit log captured the tamper attempt
  assert(h.sheets.audit_log.getLastRow() >= 2);
});

test("SEC-P0-1b: enforces P4 ALUMNI-only Google registration, blocks new GUEST signup, and elevates only backend ADMIN_EMAILS", () => {
  const h = createMockSpreadsheetHarness({
    GOOGLE_CLIENT_ID: VALID_CLIENT_ID,
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
  });
  h.tokenDirectory["tok_alumni"] = {
    sub: "sub_alu",
    email: "alumni@upi.edu",
    email_verified: "true",
    name: "Alumni Biasa",
    aud: VALID_CLIENT_ID,
  };
  h.tokenDirectory["tok_guest"] = {
    sub: "sub_gst",
    email: "guest@gmail.com",
    email_verified: "true",
    name: "Guest Biasa",
    aud: VALID_CLIENT_ID,
  };
  h.tokenDirectory["tok_legacy_guest"] = {
    sub: "sub_lgst",
    email: "legacy.guest@gmail.com",
    email_verified: "true",
    name: "Legacy Guest",
    aud: VALID_CLIENT_ID,
  };
  h.tokenDirectory["tok_admin"] = {
    sub: "sub_adm",
    email: "maulanaa1408@upi.edu",
    email_verified: "true",
    name: "Maulana",
    aud: VALID_CLIENT_ID,
  };

  const rAlu = h.callPost({ action: "register_or_login", id_token: "tok_alumni", role: "ALUMNI", consent: true });
  assert.strictEqual(rAlu.status, "ok");
  assert.strictEqual(rAlu.user.role, "ALUMNI");

  // P4: New Guest registration via Google Sign-In is rejected with 0 users rows inserted
  const rGst = h.callPost({ action: "register_or_login", id_token: "tok_guest", role: "GUEST", consent: true });
  assert.strictEqual(rGst.status, "error");
  assert(rGst.message.includes("Tamu"));

  // Legacy historical GUEST accounts already stored in users sheet remain supported
  h.sheets.users.appendRow(["USR_LEG_G", "sub_lgst", "legacy.guest@gmail.com", "Legacy Guest", "GUEST", "G000099", "NOT_SUBMITTED", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
  const rLegGst = h.callPost({ action: "register_or_login", id_token: "tok_legacy_guest", role: "GUEST", consent: true });
  assert.strictEqual(rLegGst.status, "ok");
  assert.strictEqual(rLegGst.user.role, "GUEST");
  assert.strictEqual(rLegGst.user.ref_code, "G000099");

  const rAdm = h.callPost({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });
  assert.strictEqual(rAdm.status, "ok");
  assert.strictEqual(rAdm.user.role, "ADMIN");
});

// 2. SEC-P0-2: mock_token_* backdoor blocked in live mode
test("SEC-P0-2: blocks mock_token_admin and mock_token_alumni when ALLOW_MOCK_AUTH is disabled", () => {
  const h = createMockSpreadsheetHarness({
    GOOGLE_CLIENT_ID: VALID_CLIENT_ID,
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
  });

  const res1 = h.callPost({ action: "admin_verifications", id_token: "mock_token_admin" });
  assert.strictEqual(res1.status, "error");
  assert(res1.message.includes("Mock authentication is disabled"));

  const res2 = h.callPost({ action: "register_or_login", id_token: "mock_token_alumni", role: "ALUMNI", consent: true });
  assert.strictEqual(res2.status, "error");

  // Audit log must redact mock tokens (zero literal 'mock_token_admin' persisted)
  const auditDump = JSON.stringify(h.sheets.audit_log._rows);
  assert(!auditDump.includes("mock_token_admin"), "Mock token string leaked into audit_log");
});

// 3. SEC-P0-3: Frontend live UI hides/blocks demo mode
test("SEC-P0-3: live index.html and auth.js keep demo mode hidden and guard quickDemoLogin", () => {
  const indexHtml = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf8");
  const authJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "auth.js"), "utf8");
  const configJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "config.js"), "utf8");

  assert(configJs.includes("DEMO_MODE: false"), "Local config.js DEMO_MODE: false was unexpectedly altered");
  assert(indexHtml.includes('id="demoLoginSection" style="display: none;'), "Demo UI must be hidden by default");
  assert(indexHtml.includes("if (!isLocalDemoEnabled())"), "quickDemoLogin must enforce local check");
  assert(authJs.includes('normalizedRole'), "auth.js must clamp selectedRole");
});

// 4. SEC-P0-4: Fail-closed GOOGLE_CLIENT_ID & audience / email_verified validation
test("SEC-P0-4: fails closed when GOOGLE_CLIENT_ID is missing, aud mismatches, or email unverified", () => {
  const hEmpty = createMockSpreadsheetHarness({ ADMIN_EMAILS: "maulanaa1408@upi.edu" });
  hEmpty.tokenDirectory["tok_x"] = {
    sub: "sub_x",
    email: "user@upi.edu",
    email_verified: "true",
    aud: VALID_CLIENT_ID,
  };
  const rEmpty = hEmpty.callPost({ action: "register_or_login", id_token: "tok_x", consent: true });
  assert.strictEqual(rEmpty.status, "error");
  assert(rEmpty.message.includes("GOOGLE_CLIENT_ID is required"));

  const h = createMockSpreadsheetHarness({
    GOOGLE_CLIENT_ID: VALID_CLIENT_ID,
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
  });
  h.tokenDirectory["tok_other_aud"] = {
    sub: "sub_o",
    email: "user@upi.edu",
    email_verified: "true",
    aud: "99999-otherapp.apps.googleusercontent.com",
  };
  const rAud = h.callPost({ action: "register_or_login", id_token: "tok_other_aud", consent: true });
  assert.strictEqual(rAud.status, "error");
  assert(rAud.message.includes("not issued for this application"));

  h.tokenDirectory["tok_unverified_email"] = {
    sub: "sub_u",
    email: "unverified@upi.edu",
    email_verified: "false",
    aud: VALID_CLIENT_ID,
  };
  const rUnv = h.callPost({ action: "register_or_login", id_token: "tok_unverified_email", consent: true });
  assert.strictEqual(rUnv.status, "error");
  assert(rUnv.message.includes("not verified"));
});

// 5. SEC-P0-5: No URL tokens, private reads via POST, and CORS text/plain in api.js
test("SEC-P0-5: rejects URL query tokens on GET/POST and verifies frontend uses CORS-safe text/plain POST", () => {
  const h = createMockSpreadsheetHarness({ GOOGLE_CLIENT_ID: VALID_CLIENT_ID });

  // GET with token rejected
  const rGetTok = h.callGet({ action: "my_donations", id_token: "some_tok" });
  assert.strictEqual(rGetTok.status, "error");

  // GET for private action without token rejected with 405 message
  const rGetPriv = h.callGet({ action: "admin_verifications" });
  assert.strictEqual(rGetPriv.status, "error");
  assert(rGetPriv.message.includes("POST"));

  // POST with query ?token= rejected
  const rPostTok = h.callPost({ action: "health" }, { token: "old_query_token" });
  assert.strictEqual(rPostTok.status, "error");

  // Public GET health & public_summary still work
  assert.strictEqual(h.callGet({ action: "health" }).status, "ok");
  assert.strictEqual(h.callGet({ action: "public_summary" }).status, "ok");

  // Frontend static transport checks
  const apiJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "api.js"), "utf8");
  const appJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "app.js"), "utf8");
  const adminJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "admin.js"), "utf8");
  assert(apiJs.includes("'Content-Type': 'text/plain;charset=utf-8'"), "api.js must send POST as text/plain to prevent GAS CORS preflight");
  assert(!apiJs.includes("'Content-Type': 'application/json'"), "api.js must not trigger OPTIONS preflight via application/json");
  assert(!appJs.includes("API.get('check_intent'"), "app.js must not call check_intent via GET");
  assert(!appJs.includes("API.get('my_donations'"), "app.js must not call my_donations via GET");
  assert(!adminJs.includes('API.get("admin_'), "admin.js must not call admin endpoints via GET");
});

// 6. SEC-P0-6: checkIntentStatus & simulateIntentPayment ownership enforcement
test("SEC-P0-6: enforces authentication and owner check on checkIntentStatus and simulateIntentPayment", () => {
  const h = createMockSpreadsheetHarness({
    GOOGLE_CLIENT_ID: VALID_CLIENT_ID,
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
  });
  h.tokenDirectory["tok_alu1"] = { sub: "s1", email: "a1@upi.edu", email_verified: "true", name: "Alumni 1", aud: VALID_CLIENT_ID };
  h.tokenDirectory["tok_alu2"] = { sub: "s2", email: "a2@upi.edu", email_verified: "true", name: "Alumni 2", aud: VALID_CLIENT_ID };
  h.tokenDirectory["tok_adm"] = { sub: "sa", email: "maulanaa1408@upi.edu", email_verified: "true", name: "Admin", aud: VALID_CLIENT_ID };

  h.callPost({ action: "register_or_login", id_token: "tok_alu1", role: "ALUMNI", consent: true });
  h.callPost({ action: "register_or_login", id_token: "tok_alu2", role: "ALUMNI", consent: true });
  h.callPost({ action: "register_or_login", id_token: "tok_adm", role: "ALUMNI", consent: true });
  h.callPost({ action: "submit_verification", id_token: "tok_alu1", nim: "180111", grad_year: "2022", faculty: "FPMIPA" });
  const verifId = h.sheets.alumni_verifications._rows[1][0];
  h.callPost({ action: "review_verification", id_token: "tok_adm", verif_id: verifId, decision: "APPROVED" });

  const intentRes = h.callPost({
    action: "create_intent",
    id_token: "tok_alu1",
    amount: 100000,
    bank: "BCA",
    program: "Beasiswa Alumni UPI",
  });
  assert.strictEqual(intentRes.status, "ok");

  // Missing token rejected
  assert.strictEqual(h.callPost({ action: "check_intent", intent_id: intentRes.intent_id }).status, "error");

  // Owner succeeds
  const ownCheck = h.callPost({ action: "check_intent", id_token: "tok_alu1", intent_id: intentRes.intent_id });
  assert.strictEqual(ownCheck.status, "ok");
  assert.strictEqual(ownCheck.intent_status, "PENDING");

  // Cross-user rejected (IDOR blocked)
  const crossCheck = h.callPost({ action: "check_intent", id_token: "tok_alu2", intent_id: intentRes.intent_id });
  assert.strictEqual(crossCheck.status, "error");
  assert(crossCheck.message.includes("Forbidden"));

  const crossSim = h.callPost({ action: "simulate_payment", id_token: "tok_alu2", intent_id: intentRes.intent_id });
  assert.strictEqual(crossSim.status, "error");
  assert(crossSim.message.includes("Forbidden"));

  // Admin succeeds
  const admCheck = h.callPost({ action: "check_intent", id_token: "tok_adm", intent_id: intentRes.intent_id });
  assert.strictEqual(admCheck.status, "ok");
});

// 7. SEC-P0-7: Centralized requireAdmin_ enforcement
test("SEC-P0-7: enforces requireAdmin_ on all admin endpoints and rejects non-admin roles", () => {
  const h = createMockSpreadsheetHarness({
    GOOGLE_CLIENT_ID: VALID_CLIENT_ID,
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
  });
  h.tokenDirectory["tok_user"] = { sub: "su", email: "user@upi.edu", email_verified: "true", name: "User", aud: VALID_CLIENT_ID };
  h.tokenDirectory["tok_adm"] = { sub: "sa", email: "maulanaa1408@upi.edu", email_verified: "true", name: "Admin", aud: VALID_CLIENT_ID };

  h.callPost({ action: "register_or_login", id_token: "tok_user", role: "ALUMNI", consent: true });
  h.callPost({ action: "register_or_login", id_token: "tok_adm", role: "ALUMNI", consent: true });

  for (const act of ["admin_verifications", "admin_queue", "admin_insights", "review_verification", "resolve_queue"]) {
    const rDenied = h.callPost({ action: act, id_token: "tok_user", verif_id: "V1", queue_id: "Q1" });
    assert.strictEqual(rDenied.status, "error", `Expected rejection for ${act}`);
    assert(rDenied.message.includes("Forbidden"), `Expected Forbidden for ${act}, got: ${rDenied.message}`);
  }

  assert.strictEqual(h.callPost({ action: "admin_verifications", id_token: "tok_adm" }).status, "ok");
  assert.strictEqual(h.callPost({ action: "admin_queue", id_token: "tok_adm" }).status, "ok");
  assert.strictEqual(h.callPost({ action: "admin_insights", id_token: "tok_adm" }).status, "ok");
});

// 8. SEC-P0-8: Static webhook secret removed + ScriptProperties HMAC-SHA256 timestamp/nonce auth
test("SEC-P0-8: removes static secret and enforces HMAC-SHA256 timestamp + nonce anti-replay in POST body", () => {
  // Verify zero static literal remains in repo source
  const setupSrc = fs.readFileSync(path.join(GAS_DIR, "Setup.gs"), "utf8");
  const codeSrc = fs.readFileSync(path.join(GAS_DIR, "Code.gs"), "utf8");
  const simSrc = fs.readFileSync(path.join(ROOT_DIR, "simulator", "send_webhook.py"), "utf8");
  const envExSrc = fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8");
  assert(!setupSrc.includes("ALUMNI_UPI_SECRET_TOKEN_2026"), "Static secret still in Setup.gs");
  assert(!codeSrc.includes("WEBHOOK_TOKEN"), "Legacy WEBHOOK_TOKEN still referenced in Code.gs");
  assert(!simSrc.includes("ALUMNI_UPI_SECRET_TOKEN_2026"), "Static secret still in send_webhook.py");
  assert(!envExSrc.includes("ALUMNI_UPI_SECRET_TOKEN_2026"), "Static secret still in .env.example");

  const mut = [{ mutation_id: "M_SEC_01", bank: "BCA", amount: 100000, type: "CR", description: "TRSF A000001", transaction_date: "2026-11-18 00:00:00" }];

  // Missing ScriptProperties WEBHOOK_MANUAL_SECRET fails closed
  const hNoSec = createMockSpreadsheetHarness({ GOOGLE_CLIENT_ID: VALID_CLIENT_ID });
  const rNoSec = hNoSec.callPost(signWebhook(mut, WEBHOOK_SECRET));
  assert.strictEqual(rNoSec.status, "error");

  const h = createMockSpreadsheetHarness({
    GOOGLE_CLIENT_ID: VALID_CLIENT_ID,
    WEBHOOK_MANUAL_SECRET: WEBHOOK_SECRET,
  });

  // Invalid signature rejected
  const rBadSig = h.callPost(signWebhook(mut, WEBHOOK_SECRET, { tamper: true }));
  assert.strictEqual(rBadSig.status, "error");

  // Expired timestamp rejected (> 300s)
  const rStale = h.callPost(signWebhook(mut, WEBHOOK_SECRET, { timestamp: Math.floor(Date.now() / 1000) - 600 }));
  assert.strictEqual(rStale.status, "error");

  // Valid HMAC succeeds
  const validEnv = signWebhook(mut, WEBHOOK_SECRET, { nonce: "nonce_unique_123456" });
  const rOk = h.callPost(validEnv);
  assert.strictEqual(rOk.status, "ok");
  assert.strictEqual(rOk.inserted, 1);

  // Same nonce replayed inside 300s is rejected
  const rReplay = h.callPost(validEnv);
  assert.strictEqual(rReplay.status, "error");
  assert(rReplay.message.includes("replay"));

  // Fresh nonce with identical mutation_id succeeds auth & is deduplicated in ledger
  const rDup = h.callPost(signWebhook(mut, WEBHOOK_SECRET));
  assert.strictEqual(rDup.status, "ok");
  assert.strictEqual(rDup.duplicates, 1);
  assert.strictEqual(rDup.inserted, 0);

  // Verify Python simulator dry-run CLI produces valid envelope
  const pyOut = execFileSync("python", [
    path.join(ROOT_DIR, "simulator", "send_webhook.py"),
    "--bank", "BCA", "--amount", "250000", "--ref", "A000001", "--va", "--dry-run", "--secret", WEBHOOK_SECRET
  ], { encoding: "utf8" });
  assert(pyOut.includes("HMAC-SHA256 in POST body"));
  assert(!pyOut.includes("?token="));
});

console.log(`\n==========================================`);
console.log(`P0 SECURITY SUITE: ${passed} Passed, ${failed} Failed`);
console.log(`==========================================`);

if (failed > 0) {
  process.exit(1);
}
