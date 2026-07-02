/* ============================================================================
   HandyHub — Service Catalog (single source of truth)
   ----------------------------------------------------------------------------
   ONE definition of every service category and its sub-services. Replaces the
   hardcoded lists previously duplicated across:
     • customer-app/book-now.html      (SERVICES chips)
     • customer-app/book-step1.html    (SVC_CATALOG)
     • customer-app/book-emergency.html(service chips)
     • customer-app/dashboard.html     (popular-services grid)

   This is a static, versioned catalog (works offline, no Firestore round-trip on
   first paint). The data shape is intentionally Firestore-ready: when a
   `serviceCategories` collection is introduced, a repository can return objects
   of this exact shape and every consumer keeps working unchanged.

   Category object shape:
     id          kebab/route key, used in URLs (?cat=plumbing)
     key         display key used by the artisan `category` field in Firestore
     name        professional noun shown to users ("Plumber")
     categoryLabel  the work domain ("Plumbing") — matches artisan.category
     emKey       emergency-flow service key (book-emergency expects this)
     icon        inline SVG markup (currentColor — inherits brand)
     iconImg     raster/SVG asset path for grid tiles
     blurb       one-line description for the service-detail hero
     priceRange  { min, max } in GHS — the trust-anchor range
     arrival     human ETA string
     duration    typical job duration string
     emergencyEligible  whether this category appears in the emergency flow
     services[]  granular jobs: { name, desc, price, dur, img }
   ============================================================================ */

export const SERVICE_CATEGORIES = [
  {
    id: 'electrical',
    key: 'electrician',
    name: 'Electrician',
    categoryLabel: 'Electrical',
    emKey: 'Electrical',
    iconImg: '../shared/assets/icons/electricals.png',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M13 10V3L4 14h7v7l9-11h-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    blurb: "We'll match you with the nearest available electrician.",
    priceRange: { min: 50, max: 200 },
    arrival: '5–10 mins',
    duration: '30 mins – 4 hrs',
    emergencyEligible: true,
    services: [
      { name: 'Fix Switch / Socket',         desc: 'Repair or replace faulty switches or power outlets.', price: 50,  dur: '30–60 mins', img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=150&h=150&fit=crop' },
      { name: 'Light Installation',          desc: 'Install lights, chandeliers, or pendant fittings.',   price: 60,  dur: '30–60 mins', img: 'https://images.unsplash.com/photo-1524484485831-a92ffc0de03f?w=150&h=150&fit=crop' },
      { name: 'Circuit Breaker Repair',      desc: 'Fix tripping issues and electrical breaker problems.', price: 80,  dur: '45–90 mins', img: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=150&h=150&fit=crop' },
      { name: 'Electrical Wiring / Rewiring', desc: 'New wiring or full rewiring for homes and offices.', price: 200, dur: '2–4 hours',  img: 'https://images.unsplash.com/photo-1609205807107-2f5ad87f5c4c?w=150&h=150&fit=crop' },
    ],
  },
  {
    id: 'plumbing',
    key: 'plumber',
    name: 'Plumber',
    categoryLabel: 'Plumbing',
    emKey: 'Plumbing',
    iconImg: '../shared/assets/icons/plummer.png',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2a5 5 0 0 1 5 5v3H7V7a5 5 0 0 1 5-5z" stroke="currentColor" stroke-width="2"/><path d="M7 10c0 5.52 10 5.52 10 0M12 19v3M9 22h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    blurb: "We'll connect you with a skilled plumber near you.",
    priceRange: { min: 55, max: 150 },
    arrival: '8–15 mins',
    duration: '30 mins – 2 hrs',
    emergencyEligible: true,
    services: [
      { name: 'Fix Leaking Pipe',           desc: 'Repair burst or leaking water pipes quickly.',     price: 60,  dur: '30–60 mins', img: 'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=150&h=150&fit=crop' },
      { name: 'Toilet Repair / Unclogging', desc: 'Fix running toilets, clogs, or broken cisterns.',   price: 70,  dur: '30–90 mins', img: 'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=150&h=150&fit=crop' },
      { name: 'Water Heater Installation',  desc: 'Install or replace electric or gas water heaters.', price: 150, dur: '1–2 hours',  img: 'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?w=150&h=150&fit=crop' },
      { name: 'Tap / Faucet Replacement',   desc: 'Replace old or dripping taps with new fittings.',   price: 55,  dur: '30–60 mins', img: 'https://images.unsplash.com/photo-1516455590571-18256e5bb9ff?w=150&h=150&fit=crop' },
    ],
  },
  {
    id: 'carpentry',
    key: 'carpenter',
    name: 'Carpenter',
    categoryLabel: 'Carpentry',
    emKey: 'Carpentry',
    iconImg: '../shared/assets/icons/carpenter.png',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M15 4v16M3 8h12M3 16h8M3 4v16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    blurb: "We'll find an expert carpenter for your woodwork needs.",
    priceRange: { min: 60, max: 150 },
    arrival: '10–20 mins',
    duration: '1 – 4 hrs',
    emergencyEligible: false,
    services: [
      { name: 'Door Fitting / Repair',   desc: 'Fix or install interior and exterior doors.',      price: 80,  dur: '1–2 hours', img: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=150&h=150&fit=crop' },
      { name: 'Furniture Assembly',      desc: 'Assemble flat-pack or custom furniture pieces.',    price: 60,  dur: '1–3 hours', img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=150&h=150&fit=crop' },
      { name: 'Cabinet Installation',    desc: 'Install kitchen or bathroom cabinets and shelving.', price: 120, dur: '2–4 hours', img: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=150&h=150&fit=crop' },
      { name: 'Window Repair / Fitting', desc: 'Fix broken window frames or install new windows.',  price: 90,  dur: '1–3 hours', img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=150&h=150&fit=crop' },
    ],
  },
  {
    id: 'ac-repair',
    key: 'ac',
    name: 'AC Specialist',
    categoryLabel: 'AC Repair',
    emKey: 'AC Repair',
    iconImg: '../shared/assets/icons/cooling.png',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    blurb: 'Get your AC serviced by a certified technician fast.',
    priceRange: { min: 60, max: 200 },
    arrival: '15–25 mins',
    duration: '30 mins – 4 hrs',
    emergencyEligible: true,
    services: [
      { name: 'AC Installation',        desc: 'Install split, window, or ceiling AC units.',        price: 200, dur: '2–4 hours',  img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=150&h=150&fit=crop' },
      { name: 'AC Servicing / Cleaning', desc: 'Deep clean filters, coils, and drainage lines.',     price: 80,  dur: '1–2 hours',  img: 'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?w=150&h=150&fit=crop' },
      { name: 'AC Gas Recharge',        desc: 'Refill refrigerant gas for optimal cooling.',        price: 120, dur: '1–2 hours',  img: 'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=150&h=150&fit=crop' },
      { name: 'AC Fault Diagnosis',     desc: 'Identify why your AC is not cooling or making noise.', price: 60,  dur: '30–60 mins', img: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=150&h=150&fit=crop' },
    ],
  },
  {
    id: 'welding',
    key: 'welder',
    name: 'Welder',
    categoryLabel: 'Welding',
    emKey: 'Welding',
    iconImg: '../shared/assets/icons/welder.png',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7v10l10 5 10-5V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    blurb: 'Steel gates, burglar-proofing, and metal fabrication.',
    priceRange: { min: 100, max: 250 },
    arrival: '15–30 mins',
    duration: '1 – 8 hrs',
    emergencyEligible: false,
    services: [
      { name: 'Gate / Fence Welding',      desc: 'Weld, repair, or fabricate steel gates and fences.',  price: 150, dur: '2–4 hours', img: 'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?w=150&h=150&fit=crop' },
      { name: 'Burglar Proof Installation', desc: 'Install burglar-proof bars on windows and doors.',    price: 200, dur: '3–5 hours', img: 'https://images.unsplash.com/photo-1609205807107-2f5ad87f5c4c?w=150&h=150&fit=crop' },
      { name: 'Metal Furniture Welding',   desc: 'Weld, reinforce, or fabricate metal furniture.',       price: 100, dur: '1–3 hours', img: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=150&h=150&fit=crop' },
      { name: 'Structural Welding',        desc: 'Weld structural steel beams and joints.',              price: 250, dur: '4–8 hours', img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=150&h=150&fit=crop' },
    ],
  },
  {
    id: 'cleaning',
    key: 'cleaning',
    name: 'Cleaner',
    categoryLabel: 'Cleaning',
    emKey: 'Cleaning',
    iconImg: '../shared/assets/icons/cleaner.svg',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="2"/><path d="M9 22V12h6v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    blurb: 'Book a trusted home cleaning professional today.',
    priceRange: { min: 80, max: 150 },
    arrival: '10–20 mins',
    duration: '2 – 4 hrs',
    emergencyEligible: false,
    services: [
      { name: 'House Cleaning',        desc: 'Full home deep clean including kitchen and bathrooms.', price: 80,  dur: '2–4 hours', img: 'https://images.unsplash.com/photo-1527515545081-5db817172677?w=150&h=150&fit=crop' },
      { name: 'Deep Kitchen Cleaning', desc: 'Degrease, sanitise and detail the whole kitchen.',      price: 90,  dur: '2–3 hours', img: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?w=150&h=150&fit=crop' },
      { name: 'Move-out Cleaning',     desc: 'Top-to-bottom clean for moving in or out.',             price: 130, dur: '3–5 hours', img: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=150&h=150&fit=crop' },
      { name: 'Carpet & Upholstery',   desc: 'Shampoo and steam carpets, sofas and rugs.',            price: 110, dur: '2–4 hours', img: 'https://images.unsplash.com/photo-1558317374-067fb5f30001?w=150&h=150&fit=crop' },
    ],
  },
  {
    id: 'painting',
    key: 'painter',
    name: 'Painter',
    categoryLabel: 'Painting',
    emKey: 'General Emergency',
    iconImg: '../shared/assets/icons/painter.png',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M19 11V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12" stroke="currentColor" stroke-width="2"/><path d="M14 11v3a3 3 0 0 1-3 3H9v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    blurb: 'Interior or exterior wall painting and touch-ups.',
    priceRange: { min: 120, max: 300 },
    arrival: '20–40 mins',
    duration: '3 – 8 hrs',
    emergencyEligible: false,
    services: [
      { name: 'Interior Wall Painting', desc: 'Repaint rooms with premium emulsion finishes.',   price: 120, dur: '3–6 hours', img: 'https://images.unsplash.com/photo-1562259929-b4e1fd3aef09?w=150&h=150&fit=crop' },
      { name: 'Exterior Painting',      desc: 'Weather-proof exterior walls and facades.',        price: 250, dur: '1–2 days',  img: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?w=150&h=150&fit=crop' },
      { name: 'Touch-ups & Repairs',    desc: 'Patch, fill and repaint small damaged areas.',     price: 80,  dur: '1–3 hours', img: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?w=150&h=150&fit=crop' },
    ],
  },
  {
    id: 'gardening',
    key: 'gardener',
    name: 'Gardener',
    categoryLabel: 'Gardening',
    emKey: 'General Emergency',
    iconImg: '../shared/assets/icons/gardener.svg',
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 22c4-4 8-8 8-13a8 8 0 0 0-16 0c0 5 4 9 8 13z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 22V9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    blurb: 'Lawn care, hedge trimming and garden maintenance.',
    priceRange: { min: 60, max: 200 },
    arrival: '20–40 mins',
    duration: '1 – 5 hrs',
    emergencyEligible: false,
    services: [
      { name: 'Lawn Mowing',         desc: 'Mow, edge and tidy your lawn.',                  price: 60,  dur: '1–2 hours', img: 'https://images.unsplash.com/photo-1592722470371-32a2c8b7a3f6?w=150&h=150&fit=crop' },
      { name: 'Hedge Trimming',      desc: 'Shape and trim hedges and shrubs.',              price: 80,  dur: '1–3 hours', img: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=150&h=150&fit=crop' },
      { name: 'Garden Clearance',    desc: 'Clear overgrowth, weeds and garden waste.',      price: 150, dur: '2–5 hours', img: 'https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?w=150&h=150&fit=crop' },
    ],
  },
];

/* ── Lookup helpers ───────────────────────────────────────────────────────── */

const _BY_ID = Object.create(null);
const _BY_LABEL = Object.create(null);
const _BY_KEY = Object.create(null);
for (const c of SERVICE_CATEGORIES) {
  _BY_ID[c.id] = c;
  _BY_LABEL[(c.categoryLabel || '').toLowerCase()] = c;
  _BY_KEY[(c.key || '').toLowerCase()] = c;
}

/** Find a category by its route id (e.g. "plumbing"). */
export function getCategoryById(id) {
  return _BY_ID[String(id || '').toLowerCase()] || null;
}

/** Find a category by the artisan `category` field label (e.g. "Plumbing"). */
export function getCategoryByLabel(label) {
  return _BY_LABEL[String(label || '').toLowerCase()] || null;
}

/** Find a category by its short key (e.g. "plumber"). */
export function getCategoryByKey(key) {
  return _BY_KEY[String(key || '').toLowerCase()] || null;
}

/** Resolve from any of id / label / key — convenient for mixed callers. */
export function resolveCategory(token) {
  return getCategoryById(token) || getCategoryByLabel(token) || getCategoryByKey(token) || null;
}

/** Categories eligible for the emergency dispatch flow. */
export function getEmergencyCategories() {
  return SERVICE_CATEGORIES.filter(c => c.emergencyEligible);
}

/** Human price-range string, e.g. "GHC 50–200". */
export function priceRangeLabel(cat) {
  if (!cat || !cat.priceRange) return 'GHC 50–200';
  return `GHC ${cat.priceRange.min}–${cat.priceRange.max}`;
}
