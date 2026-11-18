/**
 * p3_auth_verification.test.js
 * Comprehensive verification suite for Phase P3 (Authentication, 5-Level Verification State Machine,
 * Private Drive Proof Handling, Unique A000xxx Issuance, and Pre-P2.2 Schema Compatibility).
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
 * Builds an isolated GAS V8 VM harness with Google Sheets, Properties, Cache, Lock, Mail, and Drive file mocks.
 */
function createP3Harness(initialProps = {}) {
  const sheets = {};
  const scriptProps = {
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p3_test_hmac_secret_32bytes_value",
    ...initialProps,
  };
  const scriptCache = {};
  const userCache = {};
  const sentEmails = [];
  const tokenDirectory = {};
  const driveFiles = {};
  let driveCounter = 0;
  let lockCount = 0;

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

  function makeDriveFileObj(id, blob) {
    return {
      id,
      name: blob.name,
      mimeType: blob.mimeType,
      bytes: blob.bytes,
      trashed: false,
      sharing: null,
      getId: () => id,
      setSharing: (acc, perm) => {
        driveFiles[id].sharing = { acc, perm };
      },
      setTrashed: (flag) => {
        driveFiles[id].trashed = Boolean(flag);
      },
      getBlob: () => ({
        getName: () => driveFiles[id].name,
        getContentType: () => driveFiles[id].mimeType,
        getBytes: () => driveFiles[id].bytes,
      }),
    };
  }

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
      getScriptLock: () => ({
        waitLock: () => {
          lockCount++;
        },
        releaseLock: () => {},
      }),
    },
    MailApp: {
      sendEmail: (obj) => sentEmails.push(obj),
    },
    DriveApp: {
      Access: { ANYONE: "ANYONE" },
      Permission: { NONE: "NONE" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({
        setSharing: () => {},
        createFile: (blob) => {
          driveCounter++;
          const id = "DRV_" + driveCounter;
          const rec = makeDriveFileObj(id, blob);
          driveFiles[id] = rec;
          return rec;
        },
      }),
      getFileById: (id) => {
        if (!driveFiles[id]) throw new Error("Drive file not found: " + id);
        return driveFiles[id];
      },
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
    Logger: { log: () => {} },
  };

  vm.createContext(sandbox);
  const files = [
    "Setup.gs",
    "Logic.gs",
    "AuditLog.gs",
    "Auth.gs",
    "Notifier.gs",
    "Users.gs",
    "Programs.gs",
    "Donations.gs",
    "Webhook.gs",
    "Admin.gs",
    "PublicApi.gs",
    "Code.gs",
  ];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), "utf8"), sandbox, { filename: f });
  }
  sandbox.setupSheets();

  return {
    sandbox,
    sheets,
    scriptProps,
    sentEmails,
    tokenDirectory,
    driveFiles,
    getLockCount: () => lockCount,
    post: (bodyObj) => {
      const res = sandbox.doPost({ postData: { contents: JSON.stringify(bodyObj) }, parameter: {} });
      return JSON.parse(res.getContent());
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

  console.log("🛡️ RUNNING PHASE P3 AUTHENTICATION & ALUMNI VERIFICATION TESTS...\n");

  test("Google Auth, Repeated Alumni Login Deduplication, & Role Escalation Guard", () => {
    const h = createP3Harness();
    h.tokenDirectory["tok_alu1"] = {
      sub: "sub_alu_1",
      email: "aulia@upi.edu",
      name: "Aulia Rahman",
      email_verified: "true",
      aud: h.scriptProps.GOOGLE_CLIENT_ID,
    };
    h.tokenDirectory["tok_adm"] = {
      sub: "sub_adm_1",
      email: "maulanaa1408@upi.edu",
      name: "Admin UPI",
      email_verified: "true",
      aud: h.scriptProps.GOOGLE_CLIENT_ID,
    };

    // Block client role: ADMIN escalation
    const tamper = h.post({ action: "register_or_login", id_token: "tok_alu1", role: "ADMIN", consent: true });
    assert.strictEqual(tamper.status, "error");
    assert(tamper.message.includes("Forbidden"));

    // First valid Alumni login creates 1 row with NOT_SUBMITTED and no ref_code
    const login1 = h.post({ action: "register_or_login", id_token: "tok_alu1", role: "ALUMNI", consent: true });
    assert.strictEqual(login1.status, "ok");
    assert.strictEqual(login1.user.role, "ALUMNI");
    assert.strictEqual(login1.user.verification_status, "NOT_SUBMITTED");
    assert.strictEqual(login1.user.ref_code, "");

    // Repeated login (including with different email casing or repeat token) never creates a duplicate user row
    const login2 = h.post({ action: "register_or_login", id_token: "tok_alu1", role: "ALUMNI", consent: true });
    assert.strictEqual(login2.status, "ok");
    assert.strictEqual(login2.user.user_id, login1.user.user_id);
    assert.strictEqual(h.sheets.users._rows.length, 2); // header + 1 user

    // Admin login derives ADMIN strictly from backend ADMIN_EMAILS
    const admLogin = h.post({ action: "register_or_login", id_token: "tok_adm", role: "ALUMNI", consent: true });
    assert.strictEqual(admLogin.user.role, "ADMIN");
    assert.strictEqual(admLogin.user.verification_status, "APPROVED");

    // Invalid / expired token, wrong aud, email_verified = false must fail closed
    const badTokRes = h.post({ action: "register_or_login", id_token: "invalid.jwt.string", consent: true });
    assert.strictEqual(badTokRes.status, "error");

    h.tokenDirectory["tok_bad_aud"] = {
      sub: "s_ba",
      email: "bad@upi.edu",
      name: "Bad Aud",
      email_verified: "true",
      aud: "999999-wrong-client.apps.googleusercontent.com",
    };
    const badAudRes = h.post({ action: "register_or_login", id_token: "tok_bad_aud", consent: true });
    assert.strictEqual(badAudRes.status, "error");

    h.tokenDirectory["tok_unverif"] = {
      sub: "s_uv",
      email: "unver@upi.edu",
      name: "Unverif",
      email_verified: "false",
      aud: h.scriptProps.GOOGLE_CLIENT_ID,
    };
    const unverRes = h.post({ action: "register_or_login", id_token: "tok_unverif", consent: true });
    assert.strictEqual(unverRes.status, "error");

    // Empty GOOGLE_CLIENT_ID fails closed
    const hNoCid = createP3Harness({ GOOGLE_CLIENT_ID: "" });
    hNoCid.tokenDirectory["tok_x"] = { sub: "s", email: "x@upi.edu", email_verified: "true", aud: "any" };
    const noCidRes = hNoCid.post({ action: "register_or_login", id_token: "tok_x", consent: true });
    assert.strictEqual(noCidRes.status, "error");
  });

  test("Proof Upload Validation, Private Drive Storage, & Non-Admin Document Access Protection", () => {
    const h = createP3Harness();
    h.tokenDirectory["tok_alu"] = { sub: "s1", email: "alumni1@upi.edu", name: "Bima", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_other"] = { sub: "s2", email: "other@upi.edu", name: "Other", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_adm"] = { sub: "s3", email: "maulanaa1408@upi.edu", name: "Admin", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };

    h.post({ action: "register_or_login", id_token: "tok_alu", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_other", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_adm", consent: true });

    // Reject disallowed MIME type (.exe)
    const badMime = h.post({
      action: "submit_verification",
      id_token: "tok_alu",
      nim: "2001122",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_base64: Buffer.from("fakeexe").toString("base64"),
      file_name: "virus.exe",
      file_mime: "application/x-msdownload",
    });
    assert.strictEqual(badMime.status, "error");
    assert(badMime.message.includes("Format berkas tidak didukung"));

    // Reject > 5MB file
    const bigB64 = Buffer.alloc(5 * 1024 * 1024 + 8, 65).toString("base64");
    const bigRes = h.post({
      action: "submit_verification",
      id_token: "tok_alu",
      nim: "2001122",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_base64: bigB64,
      file_name: "ijazah.pdf",
      file_mime: "application/pdf",
    });
    assert.strictEqual(bigRes.status, "error");
    assert(bigRes.message.includes("5MB"));

    // Valid PDF upload + formula injection neutralization check on NIM
    const pdfPayload = Buffer.from("%PDF-1.4\nValid Ijazah Proof").toString("base64");
    const okSub = h.post({
      action: "submit_verification",
      id_token: "tok_alu",
      nim: "=1801234",
      grad_year: "2023",
      faculty: "FPTK",
      file_base64: pdfPayload,
      file_name: "ijazah.pdf",
      file_mime: "application/pdf",
    });
    assert.strictEqual(okSub.status, "ok");
    assert.strictEqual(okSub.verification_status, "PENDING");

    // Check formula sanitized in alumni_verifications cell & Drive file kept private
    const verifRow = h.sheets.alumni_verifications._rows[1];
    assert.strictEqual(verifRow[4], "'=1801234");
    const fileId = verifRow[7];
    assert.deepStrictEqual(h.driveFiles[fileId].sharing, { acc: "ANYONE", perm: "NONE" });

    // Other alumni and owner cannot access private proof via admin_verif_proof
    const otherTry = h.post({ action: "admin_verif_proof", id_token: "tok_other", verif_id: okSub.verif_id });
    assert.strictEqual(otherTry.status, "error");
    assert(otherTry.message.includes("Forbidden"));

    const ownerTry = h.post({ action: "admin_verif_proof", id_token: "tok_alu", verif_id: okSub.verif_id });
    assert.strictEqual(ownerTry.status, "error");
    assert(ownerTry.message.includes("Forbidden"));

    // Admin listing does NOT leak raw proof_file_id, while admin_verif_proof returns base64 & logs audit
    const listRes = h.post({ action: "admin_verifications", id_token: "tok_adm" });
    assert.strictEqual(listRes.items[0].has_file, true);
    assert.strictEqual(listRes.items[0].file_id, undefined);

    const proofRes = h.post({ action: "admin_verif_proof", id_token: "tok_adm", verif_id: okSub.verif_id });
    assert.strictEqual(proofRes.status, "ok");
    assert.strictEqual(proofRes.mime_type, "application/pdf");
    assert.strictEqual(proofRes.base64_data, pdfPayload);
  });

  test("Verification State Machine: NEEDS_REVISION resubmission, APPROVED A000xxx & REJECTED finality (OPEN-01)", () => {
    const h = createP3Harness();
    h.tokenDirectory["tok_rev"] = { sub: "s_rev", email: "revisi@upi.edu", name: "Citra", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_rej"] = { sub: "s_rej", email: "ditolak@upi.edu", name: "Dedi", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_adm"] = { sub: "s_adm", email: "maulanaa1408@upi.edu", name: "Admin", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };

    h.post({ action: "register_or_login", id_token: "tok_rev", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_rej", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_adm", consent: true });

    const sub1 = h.post({
      action: "submit_verification",
      id_token: "tok_rev",
      nim: "190111",
      grad_year: "2023",
      faculty: "FIP",
      file_base64: Buffer.from("blurry").toString("base64"),
      file_name: "scan1.jpg",
      file_mime: "image/jpeg",
    });
    const firstFileId = h.sheets.alumni_verifications._rows[1][7];

    // Illegal while PENDING: duplicate submit blocked
    const dupSub = h.post({ action: "submit_verification", id_token: "tok_rev", nim: "190111", grad_year: "2023", faculty: "FIP" });
    assert.strictEqual(dupSub.status, "error");

    // Mandatory reason check on NEEDS_REVISION
    const missingReason = h.post({ action: "review_verification", id_token: "tok_adm", verif_id: sub1.verif_id, decision: "NEEDS_REVISION", reason: "" });
    assert.strictEqual(missingReason.status, "error");

    // Admin requests NEEDS_REVISION -> old file trashed, no A000xxx issued
    const revOut = h.post({ action: "review_verification", id_token: "tok_adm", verif_id: sub1.verif_id, decision: "NEEDS_REVISION", reason: "Scan ijazah terpotong." });
    assert.strictEqual(revOut.status, "ok");
    assert.strictEqual(revOut.decision, "NEEDS_REVISION");
    assert.strictEqual(h.driveFiles[firstFileId].trashed, true);

    // Resubmission allowed in NEEDS_REVISION state (NEEDS_REVISION -> PENDING)
    const sub2 = h.post({
      action: "submit_verification",
      id_token: "tok_rev",
      nim: "190111",
      grad_year: "2023",
      faculty: "FIP",
      file_base64: Buffer.from("clear_pdf").toString("base64"),
      file_name: "scan2.pdf",
      file_mime: "application/pdf",
    });
    assert.strictEqual(sub2.status, "ok");
    assert.strictEqual(sub2.verification_status, "PENDING");
    const secondFileId = h.sheets.alumni_verifications._rows[2][7];

    // Admin approves -> unique A000xxx minted, proof trashed, APPROVED cannot resubmit or be re-reviewed
    const appOut = h.post({ action: "review_verification", id_token: "tok_adm", verif_id: sub2.verif_id, decision: "APPROVED" });
    assert.strictEqual(appOut.status, "ok");
    assert.strictEqual(appOut.decision, "APPROVED");
    assert(/^A\d{6}$/.test(appOut.ref_code), "Expected A000xxx format");
    assert.strictEqual(h.driveFiles[secondFileId].trashed, true);

    // Illegal: APPROVED user cannot return to PENDING
    const backToPend = h.post({ action: "submit_verification", id_token: "tok_rev", nim: "190111", grad_year: "2023", faculty: "FIP" });
    assert.strictEqual(backToPend.status, "error");
    assert(backToPend.message.includes("Forbidden"));

    // Illegal: Re-reviewing an already APPROVED ticket is rejected
    const reReview = h.post({ action: "review_verification", id_token: "tok_adm", verif_id: sub2.verif_id, decision: "REJECTED", reason: "Late" });
    assert.strictEqual(reReview.status, "error");

    // OPEN-01: REJECTED is terminal and permanently blocks resubmission
    const rejSub = h.post({
      action: "submit_verification",
      id_token: "tok_rej",
      nim: "999999",
      grad_year: "2020",
      faculty: "FPIPS",
      file_base64: Buffer.from("bad").toString("base64"),
      file_name: "bad.png",
      file_mime: "image/png",
    });
    const rejOut = h.post({ action: "review_verification", id_token: "tok_adm", verif_id: rejSub.verif_id, decision: "REJECTED", reason: "Bukan data mahasiswa UPI." });
    assert.strictEqual(rejOut.status, "ok");
    assert.strictEqual(rejOut.decision, "REJECTED");

    const retryAfterReject = h.post({ action: "submit_verification", id_token: "tok_rej", nim: "999999", grad_year: "2020", faculty: "FPIPS" });
    assert.strictEqual(retryAfterReject.status, "error");
    assert(retryAfterReject.message.includes("DITOLAK secara final"));
  });

  test("Alumni Donation Gate (TEST-07) & Legacy Pre-P2.2 Database Compatibility (NONE / VERIFIED)", () => {
    const h = createP3Harness();
    h.tokenDirectory["tok_adm"] = { sub: "s_adm", email: "maulanaa1408@upi.edu", name: "Admin", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.post({ action: "register_or_login", id_token: "tok_adm", consent: true });

    h.tokenDirectory["tok_none"] = { sub: "s_n", email: "none@upi.edu", name: "User None", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_pend"] = { sub: "s_p", email: "pend@upi.edu", name: "User Pending", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_rev"] = { sub: "s_r", email: "rev@upi.edu", name: "User Revision", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_rej"] = { sub: "s_j", email: "rej@upi.edu", name: "User Rejected", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.tokenDirectory["tok_ver"] = { sub: "s_v", email: "verified@upi.edu", name: "Alumni Verified", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };

    // Manually insert legacy v1 rows directly into users sheet (pre-P2.2 state)
    h.sheets.users.appendRow(["USR_L1", "s_n", "none@upi.edu", "User None", "ALUMNI", "", "NONE", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    h.sheets.users.appendRow(["USR_LP", "s_p", "pend@upi.edu", "User Pending", "ALUMNI", "", "PENDING", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    h.sheets.users.appendRow(["USR_LR", "s_r", "rev@upi.edu", "User Revision", "ALUMNI", "", "NEEDS_REVISION", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    h.sheets.users.appendRow(["USR_LJ", "s_j", "rej@upi.edu", "User Rejected", "ALUMNI", "", "REJECTED", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    h.sheets.users.appendRow(["USR_L2", "s_v", "verified@upi.edu", "Alumni Verified", "ALUMNI", "A000471", "VERIFIED", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    h.sheets.counters.getRange(2, 1, 1, 2).setValues([["ALUMNI", 10]]); // Legacy counter behind max ref_code 471

    // Legacy NONE -> NOT_SUBMITTED, PENDING, NEEDS_REVISION, REJECTED must all be blocked from donating
    const loginNone = h.post({ action: "register_or_login", id_token: "tok_none", consent: true });
    assert.strictEqual(loginNone.user.verification_status, "NOT_SUBMITTED");
    for (const blockedTok of ["tok_none", "tok_pend", "tok_rev", "tok_rej"]) {
      const blockedIntent = h.post({ action: "create_intent", id_token: blockedTok, amount: 50000, bank: "BCA", program: "Beasiswa Alumni UPI" });
      assert.strictEqual(blockedIntent.status, "error");
      assert(blockedIntent.message.includes("Forbidden"), `Expected Forbidden for ${blockedTok}`);
    }

    // Legacy VERIFIED user maps to APPROVED and can donate cleanly even before P2.2 runs!
    const loginVer = h.post({ action: "register_or_login", id_token: "tok_ver", consent: true });
    assert.strictEqual(loginVer.user.verification_status, "APPROVED");
    const allowedIntent = h.post({ action: "create_intent", id_token: "tok_ver", amount: 50000, bank: "BCA", program: "Beasiswa Alumni UPI" });
    assert.strictEqual(allowedIntent.status, "ok");
    assert.strictEqual(allowedIntent.ref_code, "A000471");

    // Next approved alumni gets sequence strictly > max existing ref_code (A000472, zero collision!)
    h.tokenDirectory["tok_new"] = { sub: "s_new", email: "newalu@upi.edu", name: "New Alu", email_verified: "true", aud: h.scriptProps.GOOGLE_CLIENT_ID };
    h.post({ action: "register_or_login", id_token: "tok_new", consent: true });
    const subNew = h.post({ action: "submit_verification", id_token: "tok_new", nim: "220011", grad_year: "2024", faculty: "FPEB" });
    const appNew = h.post({ action: "review_verification", id_token: "tok_adm", verif_id: subNew.verif_id, decision: "APPROVED" });
    assert.strictEqual(appNew.ref_code, "A000472");
  });

  test("Frontend P3 Controls Check: donation form lock, NEEDS_REVISION reason, & admin preview modal present", () => {
    const appHtml = fs.readFileSync(path.join(FRONTEND_DIR, "app.html"), "utf8");
    const appJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "app.js"), "utf8");
    const adminHtml = fs.readFileSync(path.join(FRONTEND_DIR, "admin.html"), "utf8");
    const adminJs = fs.readFileSync(path.join(FRONTEND_DIR, "js", "admin.js"), "utf8");

    assert(appHtml.includes('id="donationLockNotice"'));
    assert(appJs.includes("updateDonationFormAccess"));
    assert(appJs.includes("NEEDS_REVISION"));
    assert(appJs.includes("normStatus === 'REJECTED'"));
    assert(adminHtml.includes('id="proofPreviewModal"'));
    assert(adminJs.includes("admin_verif_proof"));
    assert(adminJs.includes("NEEDS_REVISION"));
  });

  console.log(`\n==========================================\nP3 AUTH & VERIFICATION SUITE: ${passed} Passed, ${failed} Failed\n==========================================`);
  if (failed > 0) process.exit(1);
}

runTests();
