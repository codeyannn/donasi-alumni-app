/**
 * p1_stabilization.test.js
 * End-to-end integration & regression tests for Phase P1 (P1.1 - P1.5) inside Node.js GAS VM.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAS_DIR = path.join(ROOT_DIR, "apps-script");

/**
 * Builds an isolated GAS V8 VM harness with Google Sheets, Properties, Lock, and Mail mocks.
 */
function createP1Harness() {
  const sheets = {};
  const scriptProps = {
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p1_test_hmac_secret_32bytes_value",
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
      getLastColumn: () => (rows[0] ? rows[0].length : 0),
      appendRow: (row) => rows.push([...row]),
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
    getSheetByName: (name) => sheets[name] || null,
    insertSheet: (name) => {
      sheets[name] = makeSheet(name);
      return sheets[name];
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
      sendEmail: (obj) => sentEmails.push(obj),
    },
    DriveApp: {
      Access: { ANYONE: "ANYONE" },
      Permission: { NONE: "NONE" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({ setSharing: () => {}, createFile: () => ({ getId: () => "f1", setSharing: () => {} }) }),
      getFileById: () => ({ setTrashed: () => {} }),
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
        const m = url.match(/id_token=([^&]+)/);
        const tok = m ? decodeURIComponent(m[1]) : "";
        const claims = tokenDirectory[tok];
        if (!claims) return { getResponseCode: () => 400, getContentText: () => "{}" };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(claims) };
      },
    },
    Logger: { _logs: [], log: function (m) { this._logs.push(String(m)); } },
  };

  vm.createContext(sandbox);
  for (const file of [
    "Setup.gs", "Logic.gs", "AuditLog.gs", "Auth.gs", "Users.gs", "Programs.gs",
    "Donations.gs", "Webhook.gs", "Notifier.gs", "Admin.gs", "PublicApi.gs", "Code.gs", "Tests.gs",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, file), "utf8"), sandbox, { filename: file });
  }
  sandbox.setupSheets();

  return {
    sandbox,
    sheets,
    scriptProps,
    sentEmails,
    tokenDirectory,
    post: (body) => JSON.parse(sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).getContent()),
    get: (params) => JSON.parse(sandbox.doGet({ parameter: params }).getContent()),
    sendSignedWebhook: (mutations) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomBytes(12).toString("hex");
      const raw = JSON.stringify(mutations);
      const sig = crypto.createHmac("sha256", scriptProps.WEBHOOK_MANUAL_SECRET).update(`${ts}.${nonce}.${raw}`).digest("hex");
      return JSON.parse(sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify({ webhook_auth: { timestamp: ts, nonce, signature: sig }, payload_raw: raw }) } }).getContent());
    },
  };
}

console.log("🛠️ RUNNING PHASE P1 STABILIZATION TESTS...\n");
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

test("P1.5: Apps Script internal runSelfTests() executes with zero failures", () => {
  const h = createP1Harness();
  h.sandbox.runSelfTests();
  const summaryLog = h.sandbox.Logger._logs.find((l) => l.includes("SELF TESTS FINISHED"));
  assert(summaryLog && summaryLog.includes("0 Failed"), `Expected 0 Failed in Tests.gs, got: ${summaryLog}`);
});

test("P1.1 & P1.2: preserves explicit is_anonymous=YES ('Seseorang') and donor-selected program across webhook", () => {
  const h = createP1Harness();
  h.tokenDirectory["tok_alu"] = { sub: "s1", email: "alumni@upi.edu", email_verified: "true", name: "Ahmad Rizki", aud: h.scriptProps.GOOGLE_CLIENT_ID };
  h.tokenDirectory["tok_adm"] = { sub: "s2", email: "maulanaa1408@upi.edu", email_verified: "true", name: "Admin", aud: h.scriptProps.GOOGLE_CLIENT_ID };

  h.post({ action: "register_or_login", id_token: "tok_alu", role: "ALUMNI", consent: true });
  h.post({ action: "register_or_login", id_token: "tok_adm", role: "ALUMNI", consent: true });
  h.post({ action: "submit_verification", id_token: "tok_alu", nim: "1802134", grad_year: "2022", faculty: "FPMIPA" });
  const verifId = h.sheets.alumni_verifications._rows[1][0];
  h.post({ action: "review_verification", id_token: "tok_adm", verif_id: verifId, approve: true });

  // Alumni creates anonymous intent for "Wakaf Pendidikan"
  const intent = h.post({
    action: "create_intent",
    id_token: "tok_alu",
    amount: 250000,
    bank: "BCA",
    program: "Wakaf Pendidikan",
    is_anonymous: true,
  });
  assert.strictEqual(intent.status, "ok");

  // Bank narration mentions "BEASISWA" (which detectProgram would map to "Beasiswa Alumni UPI")
  const wh = h.sendSignedWebhook([{
    mutation_id: "MUT_P1_ANON_01",
    bank: "BCA",
    amount: 250000,
    type: "CR",
    description: `TRSF E-BANKING CR 1111/FTSCY/WS95011 AHMAD RIZKI ${intent.ref_code} BEASISWA`,
  }]);
  assert.strictEqual(wh.matched, 1);

  const txRow = h.sheets.transactions._rows[1];
  assert.strictEqual(txRow[9], "Seseorang", "donor_display_name must be 'Seseorang' when is_anonymous=YES");
  assert.strictEqual(txRow[15], "Wakaf Pendidikan", "program must stay 'Wakaf Pendidikan', not overwritten by detectProgram");
  assert.strictEqual(txRow[16], "YES", "is_anonymous col 17 must persist as YES");
  assert.strictEqual(h.scriptProps["INTENT_ANON_" + intent.intent_id], undefined, "Bridge property cleaned up after match");
});

test("P1.1: separates failed-to-parse bank name ('Pengirim Tidak Tercatat') from explicit anonymity", () => {
  const h = createP1Harness();
  const wh = h.sendSignedWebhook([{
    mutation_id: "MUT_P1_NONAME_01",
    bank: "BCA",
    amount: 123000,
    type: "CR",
    description: "CR KLIRING TANPA NAMA PENGIRIM",
  }]);
  assert.strictEqual(wh.unmatched, 1);

  const txRow = h.sheets.transactions._rows[1];
  assert.strictEqual(txRow[9], "Pengirim Tidak Tercatat");
  assert.strictEqual(txRow[10], "UNMATCHED");
  assert.strictEqual(txRow[16], "NO");

  // UNMATCHED must NOT inflate public_summary totals
  const pub = h.get({ action: "public_summary" });
  assert.strictEqual(pub.total_amount, 0);
  assert.strictEqual(pub.total_count, 0);
});

test("P1.3: matches non-account Guest via donation_intents in Tier 1 without any row in users sheet", () => {
  const h = createP1Harness();
  // Insert Guest intent directly into donation_intents WITHOUT any row in users sheet
  const now = new Date();
  const exp = new Date(now.getTime() + 24 * 3600 * 1000);
  h.sheets.donation_intents.appendRow([
    "INT_GUEST_01",
    "",
    "G000077",
    300000,
    "MANDIRI",
    "Beasiswa Prestasi",
    "PENDING",
    now.toISOString(),
    exp.toISOString(),
    "",
  ]);

  assert.strictEqual(h.sheets.users.getLastRow(), 1, "users sheet must remain empty (no Guest account)");

  const wh = h.sendSignedWebhook([{
    mutation_id: "MUT_P1_GUEST_VA",
    bank: "MANDIRI",
    amount: 300000,
    type: "CR",
    description: "PEMBAYARAN VA 895082000077 AN BUDI SANTOSO",
  }]);
  assert.strictEqual(wh.matched, 1);
  assert.strictEqual(wh.unmatched, 0);

  const txRow = h.sheets.transactions._rows[1];
  assert.strictEqual(txRow[10], "MATCHED");
  assert.strictEqual(txRow[11], 1);
  assert.strictEqual(txRow[13], "G000077");
  assert.strictEqual(txRow[14], "INT_GUEST_01");
  assert.strictEqual(txRow[15], "Beasiswa Prestasi");

  // Intent closed to MATCHED with matched_tx_id
  assert.strictEqual(h.sheets.donation_intents._rows[1][6], "MATCHED");
  assert.strictEqual(h.sheets.donation_intents._rows[1][9], txRow[0]);
});

test("P1.3 & P1.4: blocks false matching on ambiguous, expired, already-paid intents and deduplicates retries", () => {
  const h = createP1Harness();
  const now = new Date();
  const future = new Date(now.getTime() + 12 * 3600 * 1000);
  const past = new Date(now.getTime() - 2 * 3600 * 1000);

  // Ambiguous pair: two PENDING intents with same bank+amount and no ref in mutation
  h.sheets.donation_intents.appendRow(["INT_AMB_1", "", "G000101", 100000, "BSI", "Beasiswa Alumni UPI", "PENDING", now.toISOString(), future.toISOString(), ""]);
  h.sheets.donation_intents.appendRow(["INT_AMB_2", "", "G000102", 100000, "BSI", "Wakaf Pendidikan", "PENDING", now.toISOString(), future.toISOString(), ""]);

  // Expired Guest intent
  h.sheets.donation_intents.appendRow(["INT_EXP_1", "", "G000103", 200000, "BNI", "Beasiswa Prestasi", "PENDING", new Date(now.getTime() - 30 * 3600 * 1000).toISOString(), past.toISOString(), ""]);

  // Already paid Guest intent
  h.sheets.donation_intents.appendRow(["INT_PAID_1", "", "G000104", 400000, "BRI", "Beasiswa Afirmasi", "MATCHED", now.toISOString(), future.toISOString(), "TX_OLD"]);

  const wh1 = h.sendSignedWebhook([
    { mutation_id: "MUT_AMB_01", bank: "BSI", amount: 100000, type: "CR", description: "TRF CR DARI 7129384756 SITI" },
    { mutation_id: "MUT_EXP_01", bank: "BNI", amount: 200000, type: "CR", description: "TRF BI-FAST CR DARI BNI 987654321 ANDI G000103" },
    { mutation_id: "MUT_PAID_01", bank: "BRI", amount: 400000, type: "CR", description: "TRANSFER BRIMO DARI 001201000123500 RUDI G000104" },
  ]);

  assert.strictEqual(wh1.inserted, 3);
  assert.strictEqual(wh1.matched, 0, "None of ambiguous/expired/already-paid may auto-match");
  assert.strictEqual(wh1.unmatched, 3);
  assert.strictEqual(h.sheets.review_queue.getLastRow(), 4);

  // Retry exact same mutation_id -> deduplicated without changing anything
  const whRetry = h.sendSignedWebhook([
    { mutation_id: "MUT_AMB_01", bank: "BSI", amount: 100000, type: "CR", description: "TRF CR DARI 7129384756 SITI" },
  ]);
  assert.strictEqual(whRetry.duplicates, 1);
  assert.strictEqual(whRetry.inserted, 0);
  assert.strictEqual(h.sheets.transactions.getLastRow(), 4);
});

console.log(`\n==========================================`);
console.log(`P1 STABILIZATION SUITE: ${passed} Passed, ${failed} Failed`);
console.log(`==========================================`);

if (failed > 0) {
  process.exit(1);
}
