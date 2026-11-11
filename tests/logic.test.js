/**
 * logic.test.js
 * Comprehensive unit test suite for Logic.gs running natively under Node.js.
 * Verifies ref code generation, masking, multi-bank parsing (including BNI fix), and 3-tier matching.
 */

const assert = require("assert");
const {
  SUPPORTED_BANKS,
  formatRefCode,
  extractRefCode,
  maskDonorName,
  maskAccountNumber,
  parseDonorName,
  detectProgram,
  matchTransaction,
  formatRupiah,
} = require("../apps-script/Logic.gs");

console.log("🧪 RUNNING UNIT TESTS FOR LOGIC.GS...\n");

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(err);
    failed++;
  }
}

// 1. Ref Code Generation
it("formatRefCode pads sequences to 6 digits with proper prefix", () => {
  assert.strictEqual(formatRefCode("A", 471), "A000471");
  assert.strictEqual(formatRefCode("g", 12), "G000012");
  assert.strictEqual(formatRefCode("A", 1000000), "A1000000");
});

// 2. Ref Code Extraction
it("extractRefCode parses A and G codes correctly from text", () => {
  assert.strictEqual(
    extractRefCode("TRANSFER DONASI A000471 BEASISWA"),
    "A000471",
  );
  assert.strictEqual(extractRefCode("INFAQ G000012 OLEH TAMU"), "G000012");
  assert.strictEqual(extractRefCode("TRANSFER DARI AHMAD TANPA KODE"), null);
  assert.strictEqual(extractRefCode("B000123"), null); // Only A or G
});

// 3. Donor Name Masking (UU PDP)
it("maskDonorName respects privacy standards for various name shapes", () => {
  assert.strictEqual(maskDonorName(""), "Seseorang");
  assert.strictEqual(maskDonorName(null), "Seseorang");
  assert.strictEqual(maskDonorName("Ahmad"), "A***d");
  assert.strictEqual(maskDonorName("Ahmad Rizki"), "A***d R.");
  assert.strictEqual(maskDonorName("Siti Nurhaliza Putri"), "S***i N.");
  assert.strictEqual(maskDonorName("Bo"), "B*");
});

it("maskAccountNumber masks intermediate digits", () => {
  assert.strictEqual(maskAccountNumber("7129384756"), "71****56");
  assert.strictEqual(maskAccountNumber("123"), "****");
});

// 4. Multi-Bank Narrative Parsing (BSI, Mandiri, BCA, BNI, BRI)
it("parseDonorName extracts correct donor from BCA", () => {
  const desc = "TRSF E-BANKING CR 0811/FTSCY/WS95031 AHMAD RIZKI BEASISWA";
  assert.strictEqual(parseDonorName("BCA", desc), "AHMAD RIZKI");
});

it("parseDonorName extracts correct donor from BSI", () => {
  const desc = "TRF CR DARI 1234567890 MUHAMMAD RAFI DONASI BEASISWA";
  assert.strictEqual(parseDonorName("BSI", desc), "MUHAMMAD RAFI");
});

it("parseDonorName extracts correct donor from Mandiri", () => {
  const desc = "TRANSFER DARI 1370012345678 AN SITI NURHALIZA INFAQ";
  assert.strictEqual(parseDonorName("MANDIRI", desc), "SITI NURHALIZA");
});

it("parseDonorName extracts correct donor from BNI (including BI-FAST and DARI BNI prefix)", () => {
  const desc = "TRF BI-FAST CR DARI BNI 987654321 DIMAS ANUGRAH BEASISWA";
  assert.strictEqual(parseDonorName("BNI", desc), "DIMAS ANUGRAH");
});

it("parseDonorName extracts correct donor from BRI", () => {
  const desc = "TRANSFER BRIMO DARI 001201000123500 FARHAN ADITYA BEASISWA";
  assert.strictEqual(parseDonorName("BRI", desc), "FARHAN ADITYA");
});

// 5. Keyword Program Detection
it("detectProgram matches keyword correctly or falls back to Umum", () => {
  const dict = [
    { keyword: "BEASISWA", program: "Beasiswa Alumni UPI" },
    { keyword: "WAKAF", program: "Wakaf Pendidikan" },
  ];
  assert.strictEqual(
    detectProgram("DONASI BEASISWA 2026", dict),
    "Beasiswa Alumni UPI",
  );
  assert.strictEqual(
    detectProgram("TRANSFER WAKAF FPMIPA", dict),
    "Wakaf Pendidikan",
  );
  assert.strictEqual(detectProgram("DANA SUKARELA", dict), "Umum");
});

// 6. 3-Tier Matcher Engine
const mockUsers = new Map([
  [
    "A000471",
    {
      user_id: "usr_alumni_1",
      ref_code: "A000471",
      full_name: "Ahmad Rizki",
      role: "ALUMNI",
    },
  ],
  [
    "G000012",
    {
      user_id: "usr_guest_2",
      ref_code: "G000012",
      full_name: "Budi Santoso",
      role: "GUEST",
    },
  ],
]);

const baseTime = new Date("2026-11-11T10:00:00Z");

it("matchTransaction Tier 1: matches when ref_code is present in description", () => {
  const tx = {
    bank: "BCA",
    amount: 500000,
    description: "TRSF CR WS95031 AHMAD RIZKI A000471 BEASISWA",
  };
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      {
        intent_id: "int_1",
        ref_code: "A000471",
        bank: "BCA",
        amount: 500000,
        created_at: baseTime,
      },
    ],
    windowHours: 24,
    now: baseTime,
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, "MATCHED");
  assert.strictEqual(res.tier, 1);
  assert.strictEqual(res.ref_code, "A000471");
  assert.strictEqual(res.intent_id, "int_1");
});

it("matchTransaction Tier 2: matches uniquely via Bank + Amount when no ref_code", () => {
  const tx = {
    bank: "BSI",
    amount: 250000,
    description: "TRF CR DARI 7129384756 MUHAMMAD RAFI DONASI",
  };
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      {
        intent_id: "int_2",
        ref_code: "A000471",
        user_id: "usr_alumni_1",
        bank: "BSI",
        amount: 250000,
        created_at: baseTime,
      },
    ],
    windowHours: 24,
    now: new Date("2026-11-11T12:00:00Z"), // within 2 hours
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, "MATCHED");
  assert.strictEqual(res.tier, 2);
  assert.strictEqual(res.ref_code, "A000471");
  assert.strictEqual(res.intent_id, "int_2");
});

it("matchTransaction Tier 3: routes to UNMATCHED review queue when ambiguous collision occurs", () => {
  const tx = {
    bank: "BCA",
    amount: 100000,
    description: "TRSF CR BCA 100K NO REF",
  };
  // Two distinct alumni registered intents for 100k BCA in the same window
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      {
        intent_id: "int_3",
        ref_code: "A000471",
        bank: "BCA",
        amount: 100000,
        created_at: baseTime,
      },
      {
        intent_id: "int_4",
        ref_code: "G000012",
        bank: "BCA",
        amount: 100000,
        created_at: baseTime,
      },
    ],
    windowHours: 24,
    now: baseTime,
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, "UNMATCHED");
  assert.strictEqual(res.tier, 3);
  assert.strictEqual(res.candidates_count, 2);
  assert.ok(res.reason.includes("Ambiguous match"));
});

it("matchTransaction Tier 3: routes to UNMATCHED when outside window", () => {
  const tx = {
    bank: "MANDIRI",
    amount: 750000,
    description: "TRANSFER DARI MANDIRI",
  };
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      // Intent was created 48 hours ago (> 24h)
      {
        intent_id: "int_5",
        ref_code: "A000471",
        bank: "MANDIRI",
        amount: 750000,
        created_at: new Date("2026-11-09T08:00:00Z"),
      },
    ],
    windowHours: 24,
    now: baseTime,
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, "UNMATCHED");
  assert.strictEqual(res.tier, 3);
});

console.log(`\n==========================================`);
console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log(`==========================================`);

if (failed > 0) {
  process.exit(1);
}
