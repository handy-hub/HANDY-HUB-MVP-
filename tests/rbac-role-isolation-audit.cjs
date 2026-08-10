/**
 * rbac-role-isolation-audit.cjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Attacker-model regression test for HandyHub ROLE ISOLATION (application
 * boundary enforcement) at the Firestore Security Rules layer.
 *
 * Proves — using real Firebase Auth emulator ID tokens as request.auth and the
 * Firestore emulator REST API — that a single UID can NEVER own both a
 * customers/{uid} and an artisans/{uid} document, and that only a genuine
 * customer may create a booking. This is the server-side backstop behind the
 * customer app's client role guard (shared/js/utils/roleGuard.js).
 *
 * Run (starts + tears down the emulators automatically):
 *   firebase emulators:exec --only firestore,auth \
 *     --config firebase.rulescheck.json --project demo-handyhub \
 *     "node tests/rbac-role-isolation-audit.cjs"
 *
 * Exit code 0 = all expectations met. Non-zero = a role-isolation regression.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const FS_HOST   = process.env.FIRESTORE_EMULATOR_HOST     || '127.0.0.1:8199';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9299';
const PROJECT   = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'demo-handyhub';
const DB        = '(default)';
const DOCS_BASE = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/${DB}/documents`;

const tokens = {};
async function createUser(key, email) {
  const r = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Audit-pass-123!', returnSecureToken: true }) }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(`signUp failed for ${email}: ${JSON.stringify(d)}`);
  tokens[key] = d.idToken;
  return d.localId;
}

const authHeader = (who) => (who ? { Authorization: `Bearer ${tokens[who]}` } : {});

// ── Plain JS object → Firestore typed-value document ─────────────────────────
function toValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object')  return { mapValue: toFields(v) };
  return { stringValue: String(v) };
}
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toValue(v);
  return { fields };
}

async function createDoc(collectionPath, docId, who, data) {
  const url = `${DOCS_BASE}/${collectionPath}?documentId=${encodeURIComponent(docId)}`;
  return fetch(url, {
    method: 'POST',
    headers: { ...authHeader(who), 'Content-Type': 'application/json' },
    body: JSON.stringify(toFields(data)),
  });
}

// ── Assertion harness ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
async function expect(name, wantAllow, fn) {
  let status, body = '';
  try {
    const r = await fn();
    status = r.status;
    body = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
  } catch (e) {
    status = 'ERR';
    body = e.message;
  }
  const allowed = status === 200;
  const ok = allowed === wantAllow;
  if (ok) pass++; else fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  [${wantAllow ? 'ALLOW' : 'DENY '}] ${name}` +
    `  → status ${status}${ok ? '' : `  BODY: ${body}`}`
  );
}

function customerDoc(uid, email) {
  return { id: uid, name: 'Test Customer', email, userType: 'customer', status: 'active', bookings: 0, spent: 0 };
}
function artisanDoc(uid, email) {
  return { id: uid, name: 'Test Artisan', email, userType: 'artisan', status: 'pending' };
}
function bookingDoc(customerUid) {
  return {
    customerId: customerUid,
    artisanId: 'artisan-target-uid-123',
    status: 'pending',
    serviceType: 'Plumbing',
    createdAt: new Date().toISOString(),
    type: 'standard',
    total: 0,
  };
}

(async () => {
  // Distinct emails → distinct UIDs.
  const artisanUid   = await createUser('artisan',   'artisan1@example.test');
  const customerUid  = await createUser('customer',  'customer1@example.test');
  const newCustUid   = await createUser('newcust',   'newcustomer@example.test');
  const newArtUid    = await createUser('newart',    'newartisan@example.test');

  console.log('\n── Setup: establish the two base identities ─────────────────');
  await expect('artisan creates own artisans/{uid}',  true,
    () => createDoc('artisans',  artisanUid,  'artisan',  artisanDoc(artisanUid,  'artisan1@example.test')));
  await expect('customer creates own customers/{uid}', true,
    () => createDoc('customers', customerUid, 'customer', customerDoc(customerUid, 'customer1@example.test')));

  console.log('\n── Attacks: cross-role identity minting (must be DENIED) ─────');
  // The reported vulnerability class: an artisan minting a customer identity.
  await expect('artisan mints customers/{artisanUid} (cross-role)', false,
    () => createDoc('customers', artisanUid, 'artisan', customerDoc(artisanUid, 'artisan1@example.test')));
  // Symmetric direction: a customer minting an artisan identity.
  await expect('customer mints artisans/{customerUid} (cross-role)', false,
    () => createDoc('artisans', customerUid, 'customer', artisanDoc(customerUid, 'customer1@example.test')));

  console.log('\n── Attacks: artisan acting as a customer (must be DENIED) ────');
  // Artisan has no customers/{uid} doc (can't create one) → cannot create a booking.
  await expect('artisan (no customer profile) creates a booking', false,
    () => createDoc('bookings', 'HHB-AUDIT-ART-1', 'artisan', bookingDoc(artisanUid)));

  console.log('\n── Legitimate flows (must be ALLOWED) ───────────────────────');
  await expect('genuine customer creates a booking', true,
    () => createDoc('bookings', 'HHB-AUDIT-CUST-1', 'customer', bookingDoc(customerUid)));
  await expect('brand-new customer (no artisan doc) creates customers/{uid}', true,
    () => createDoc('customers', newCustUid, 'newcust', customerDoc(newCustUid, 'newcustomer@example.test')));
  await expect('brand-new artisan (no customer doc) creates artisans/{uid}', true,
    () => createDoc('artisans', newArtUid, 'newart', artisanDoc(newArtUid, 'newartisan@example.test')));

  console.log(`\n──────────────────────────────────────────────\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error('FATAL', e); process.exitCode = 2; });
