/**
 * Seed the local emulators with the exact scenario section 9 of the brief
 * demands: ONE customer with TWO simultaneous active bookings, with the SAME
 * artisan, so "did the app keep them apart?" has a real answer.
 *
 * Writes go through the Admin SDK, which bypasses rules — this is fixture
 * setup, not a test of the rules (tests/firestore-rules.test.mjs owns that).
 */
'use strict';

// firebase-admin lives in functions/node_modules; resolve from there rather
// than from this scratch file's own directory.
require('../support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const { createRequire } = require('module');
const req = createRequire(require('path').join(__dirname, '..', '..', 'functions', 'package.json'));
const admin = req('firebase-admin');

// These fixtures CREATE and MUTATE bookings, so they run against the local
// emulator only. They must never be pointed at the production project.
const PROJECT = 'lamax-4fd82';
const DB_ID   = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
db.settings({ databaseId: DB_ID, ignoreUndefinedProperties: true });

const CUSTOMER = { uid: 'e2e_customer_1', email: 'customer@e2e.test', password: 'Passw0rd!23' };
const ARTISAN  = { uid: 'e2e_artisan_1',  email: 'artisan@e2e.test',  password: 'Passw0rd!23' };

// Two active bookings, same customer, same artisan — the isolation case.
const BOOKING_A = 'HHB-E2E-PLUMB-A';
const BOOKING_B = 'HHB-E2E-ELEC-B';
const BOOKING_C = 'HHB-E2E-CARP-C';

const now = () => new Date().toISOString();

async function createUser(u) {
  try { await admin.auth().deleteUser(u.uid); } catch (_) {}
  await admin.auth().createUser({ uid: u.uid, email: u.email, password: u.password, emailVerified: true });
}

async function main() {
  await createUser(CUSTOMER);
  await createUser(ARTISAN);

  await db.collection('customers').doc(CUSTOMER.uid).set({
    uid: CUSTOMER.uid, email: CUSTOMER.email, fullName: 'Ama Boateng',
    userType: 'customer',
    phone: '+233201234567', walletBalance: 500, escrowBalance: 0, spent: 0,
    emailVerified: true, createdAt: now(), updatedAt: now(),
  });

  await db.collection('artisans').doc(ARTISAN.uid).set({
    uid: ARTISAN.uid, email: ARTISAN.email, fullName: 'Kwame Mensah',
    userType: 'artisan',
    businessName: 'Mensah Plumbing & Electrical',
    phone: '+233209876543', specialty: 'Plumbing',
    verificationStatus: 'approved', status: 'active',
    rating: 4.8, jobsCompleted: 42, availableBalance: 0, pendingBalance: 0, totalEarned: 0,
    lat: 5.6037, lng: -0.1870, isOnline: true,
    createdAt: now(), updatedAt: now(),
  });

  const base = {
    customerId: CUSTOMER.uid,
    customerName: 'Ama Boateng',
    customerPhone: '+233201234567',
    artisanId: ARTISAN.uid,
    artisanName: 'Kwame Mensah',
    track: 'inspection',
    type: 'standard',
    calloutFee: 60,
    calloutPaid: true,
    lat: 5.6100, lng: -0.1900,
    createdAt: now(), updatedAt: now(),
  };

  // A — plumbing, WORK phase (quote approved) so live-tracking is genuinely its
  // destination. bookingHref sends a pre-quote inspection booking to the
  // console instead, which is correct but tests a different screen.
  await db.collection('bookings').doc(BOOKING_A).set({
    ...base,
    serviceType: 'Plumbing',
    description: 'Kitchen sink leaking under the cupboard for three days.',
    address: '12 Ring Road East, Accra',
    status: 'en_route',
    quoteApproved: true,
    jobQuote: 450,
    photos: [],
  });

  // B — electrical, further along, updated LAST so any "most recently
  // updated booking" fallback would wrongly select it.
  await new Promise(r => setTimeout(r, 1200));
  await db.collection('bookings').doc(BOOKING_B).set({
    ...base,
    serviceType: 'Electrical',
    description: 'Sockets in the back bedroom have no power.',
    address: '4 Labone Crescent, Accra',
    status: 'in_progress',
    quoteApproved: true,
    jobQuote: 300,
    photos: [],
    updatedAt: now(),
  });

  // C — still mid-inspection, so its correct destination is the console. Proves
  // the router sends each booking to the screen that can ACT on it, with its id.
  await db.collection('bookings').doc(BOOKING_C).set({
    ...base,
    serviceType: 'Carpentry',
    description: 'Wardrobe door off its hinge.',
    address: '9 Osu Badu Street, Accra',
    status: 'inspection_scheduled',
    photos: [],
  });

  const snap = await db.collection('bookings').where('customerId', '==', CUSTOMER.uid).get();
  console.log(`seeded ${snap.size} bookings:`);
  snap.forEach(d => console.log(`   ${d.id}  ${d.data().serviceType.padEnd(11)} ${d.data().status.padEnd(22)} updated=${d.data().updatedAt}`));
  console.log(`\ncustomer: ${CUSTOMER.email} / ${CUSTOMER.password}`);
  console.log(`artisan : ${ARTISAN.email} / ${ARTISAN.password}`);
  console.log(`\nBOOKING_A=${BOOKING_A}  (plumbing, older updatedAt)`);
  console.log(`BOOKING_B=${BOOKING_B}  (electrical, newest updatedAt)`);
  console.log(`BOOKING_C=${BOOKING_C}  (carpentry, pre-quote -> console)`);
  process.exit(0);
}

main().catch(e => { console.error('SEED FAILED:', e); process.exit(1); });
