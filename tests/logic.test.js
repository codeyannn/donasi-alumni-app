/**
 * logic.test.js
 * Comprehensive unit test suite for Logic.gs running natively under Node.js.
 * Verifies ref code generation, masking, multi-bank parsing, Virtual Account generation/decoding, and 3-tier matching.
 */

const assert = require('assert');
const {
  SUPPORTED_BANKS,
  BANK_VA_PREFIXES,
  formatRefCode,
  generateVirtualAccount,
  decodeRefCodeFromVA,
  extractRefCode,
  maskDonorName,
  maskAccountNumber,
  parseDonorName,
  detectProgram,
  matchTransaction,
  formatRupiah
} = require('../apps-script/Logic.gs');

console.log('🧪 RUNNING UNIT TESTS FOR LOGIC.GS (WITH VIRTUAL ACCOUNT & QRIS LOGIC)...\n');

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
it('formatRefCode pads sequences to 6 digits with proper prefix', () => {
  assert.strictEqual(formatRefCode('A', 471), 'A000471');
  assert.strictEqual(formatRefCode('g', 12), 'G000012');
  assert.strictEqual(formatRefCode('A', 1000000), 'A1000000');
});

// 2. Virtual Account Generation & Formatting
it('generateVirtualAccount generates authentic 12-digit numbers per bank', () => {
  const bcaAlumni = generateVirtualAccount('BCA', 'A000471');
  assert.strictEqual(bcaAlumni.va_number, '390121000471');
  assert.strictEqual(bcaAlumni.va_formatted, '39012 1 000471');

  const mandiriGuest = generateVirtualAccount('MANDIRI', 'G000012');
  assert.strictEqual(mandiriGuest.va_number, '895082000012');
  assert.strictEqual(mandiriGuest.va_formatted, '89508 2 000012');

  const briAlumni = generateVirtualAccount('BRI', 'A000001');
  assert.strictEqual(briAlumni.va_number, '888101000001');

  const bniAlumni = generateVirtualAccount('BNI', 'A000001');
  assert.strictEqual(bniAlumni.va_number, '988141000001');

  const bsiAlumni = generateVirtualAccount('BSI', 'A000001');
  assert.strictEqual(bsiAlumni.va_number, '900191000001');
});

// 3. Virtual Account Decoding
it('decodeRefCodeFromVA recovers original Ref Code from 12-digit VA', () => {
  assert.strictEqual(decodeRefCodeFromVA('390121000471'), 'A000471');
  assert.strictEqual(decodeRefCodeFromVA('895082000012'), 'G000012');
  assert.strictEqual(decodeRefCodeFromVA('88810 1 000001'), 'A000001');
  assert.strictEqual(decodeRefCodeFromVA('12345'), null);
});

// 4. Ref Code Extraction (Direct Ref Code & VA in Narration)
it('extractRefCode parses A and G codes correctly from text', () => {
  assert.strictEqual(extractRefCode('TRANSFER DONASI A000471 BEASISWA'), 'A000471');
  assert.strictEqual(extractRefCode('INFAQ G000012 OLEH TAMU'), 'G000012');
  assert.strictEqual(extractRefCode('TRANSFER DARI AHMAD TANPA KODE'), null);
});

it('extractRefCode decodes 12-digit Virtual Account from bank mutasi narration', () => {
  assert.strictEqual(extractRefCode('PEMBAYARAN VA 390121000471 AN AHMAD RIZKI'), 'A000471');
  assert.strictEqual(extractRefCode('TRSF CR VA MANDIRI 895082000012 BUDI'), 'G000012');
});

// 5. Donor Name Masking (UU PDP)
it('maskDonorName respects privacy standards for various name shapes', () => {
  assert.strictEqual(maskDonorName(''), 'Hamba Allah');
  assert.strictEqual(maskDonorName(null), 'Hamba Allah');
  assert.strictEqual(maskDonorName('Ahmad'), 'A***d');
  assert.strictEqual(maskDonorName('Ahmad Rizki'), 'A***d R.');
  assert.strictEqual(maskDonorName('Siti Nurhaliza Putri'), 'S***i N.');
  assert.strictEqual(maskDonorName('Bo'), 'B*');
});

it('maskAccountNumber masks intermediate digits', () => {
  assert.strictEqual(maskAccountNumber('7129384756'), '71****56');
  assert.strictEqual(maskAccountNumber('123'), '****');
});

// 6. Multi-Bank Narrative Parsing (BSI, Mandiri, BCA, BNI, BRI)
it('parseDonorName extracts correct donor from BCA', () => {
  const desc = 'TRSF E-BANKING CR 0811/FTSCY/WS95031 AHMAD RIZKI BEASISWA';
  assert.strictEqual(parseDonorName('BCA', desc), 'AHMAD RIZKI');
});

it('parseDonorName extracts correct donor from BSI', () => {
  const desc = 'TRF CR DARI 1234567890 MUHAMMAD RAFI DONASI BEASISWA';
  assert.strictEqual(parseDonorName('BSI', desc), 'MUHAMMAD RAFI');
});

it('parseDonorName extracts correct donor from Mandiri', () => {
  const desc = 'TRANSFER DARI 1370012345678 AN SITI NURHALIZA INFAQ';
  assert.strictEqual(parseDonorName('MANDIRI', desc), 'SITI NURHALIZA');
});

it('parseDonorName extracts correct donor from BNI (including BI-FAST and DARI BNI prefix)', () => {
  const desc = 'TRF BI-FAST CR DARI BNI 987654321 DIMAS ANUGRAH BEASISWA';
  assert.strictEqual(parseDonorName('BNI', desc), 'DIMAS ANUGRAH');
});

it('parseDonorName extracts correct donor from BRI', () => {
  const desc = 'TRANSFER BRIMO DARI 001201000123500 FARHAN ADITYA BEASISWA';
  assert.strictEqual(parseDonorName('BRI', desc), 'FARHAN ADITYA');
});

// 7. Keyword Program Detection
it('detectProgram matches keyword correctly or falls back to Umum', () => {
  const dict = [
    { keyword: 'BEASISWA', program: 'Beasiswa Alumni UPI' },
    { keyword: 'WAKAF', program: 'Wakaf Pendidikan' }
  ];
  assert.strictEqual(detectProgram('DONASI BEASISWA 2026', dict), 'Beasiswa Alumni UPI');
  assert.strictEqual(detectProgram('TRANSFER WAKAF FPMIPA', dict), 'Wakaf Pendidikan');
  assert.strictEqual(detectProgram('DANA SUKARELA', dict), 'Umum');
});

// 8. 3-Tier Matcher Engine with Virtual Account support
const mockUsers = new Map([
  ['A000471', { user_id: 'usr_alumni_1', ref_code: 'A000471', full_name: 'Ahmad Rizki', role: 'ALUMNI' }],
  ['G000012', { user_id: 'usr_guest_2', ref_code: 'G000012', full_name: 'Budi Santoso', role: 'GUEST' }]
]);

const baseTime = new Date('2026-11-11T10:00:00Z');

it('matchTransaction Tier 1: matches when ref_code is present in description', () => {
  const tx = {
    bank: 'BCA',
    amount: 500000,
    description: 'TRSF CR WS95031 AHMAD RIZKI A000471 BEASISWA'
  };
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      { intent_id: 'int_1', ref_code: 'A000471', bank: 'BCA', amount: 500000, created_at: baseTime }
    ],
    windowHours: 24,
    now: baseTime
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, 'MATCHED');
  assert.strictEqual(res.tier, 1);
  assert.strictEqual(res.ref_code, 'A000471');
});

it('matchTransaction Tier 1: matches automatically via Virtual Account number in description', () => {
  const tx = {
    bank: 'MANDIRI',
    amount: 250000,
    description: 'PEMBAYARAN VA 895081000471 AN AHMAD RIZKI BEASISWA'
  };
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      { intent_id: 'int_va_1', ref_code: 'A000471', bank: 'MANDIRI', amount: 250000, created_at: baseTime }
    ],
    windowHours: 24,
    now: baseTime
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, 'MATCHED');
  assert.strictEqual(res.tier, 1);
  assert.strictEqual(res.ref_code, 'A000471');
  assert.strictEqual(res.intent_id, 'int_va_1');
});

it('matchTransaction Tier 2: matches uniquely via Bank + Amount when no ref_code', () => {
  const tx = {
    bank: 'BSI',
    amount: 250000,
    description: 'TRF CR DARI 7129384756 MUHAMMAD RAFI DONASI'
  };
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      { intent_id: 'int_2', ref_code: 'A000471', user_id: 'usr_alumni_1', bank: 'BSI', amount: 250000, created_at: baseTime }
    ],
    windowHours: 24,
    now: new Date('2026-11-11T12:00:00Z')
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, 'MATCHED');
  assert.strictEqual(res.tier, 2);
  assert.strictEqual(res.ref_code, 'A000471');
});

it('matchTransaction Tier 3: routes to UNMATCHED review queue when collision occurs', () => {
  const tx = {
    bank: 'BCA',
    amount: 100000,
    description: 'TRSF CR BCA 100K NO REF'
  };
  const ctx = {
    usersByRefCode: mockUsers,
    pendingIntents: [
      { intent_id: 'int_3', ref_code: 'A000471', bank: 'BCA', amount: 100000, created_at: baseTime },
      { intent_id: 'int_4', ref_code: 'G000012', bank: 'BCA', amount: 100000, created_at: baseTime }
    ],
    windowHours: 24,
    now: baseTime
  };
  const res = matchTransaction(tx, ctx);
  assert.strictEqual(res.status, 'UNMATCHED');
  assert.strictEqual(res.tier, 3);
  assert.strictEqual(res.candidates_count, 2);
});

console.log(`\n==========================================`);
console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log(`==========================================`);

if (failed > 0) {
  process.exit(1);
}
