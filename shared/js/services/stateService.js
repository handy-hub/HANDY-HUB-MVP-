/* ════════════════════════════════════════════════════════════════════
   HandyHub · State Service
   shared/js/services/stateService.js

   Centralised localStorage / sessionStorage abstraction.
   All keys live here — no more magic strings scattered across pages.

   Usage (as a plain <script> tag, no bundler needed):
     <script src="../shared/js/services/stateService.js"></script>
     const booking = window.HH_State.booking.get();

   Migration path → when moving to a real backend (Firebase / Supabase /
   REST) replace the read / write helpers below; page code doesn't change.
════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── Local storage keys ──────────────────────────────────────────── */
  var KEYS = {
    BOOKING:         'hh_booking',           // active booking state object
    HISTORY:         'hh_booking_history',   // array of completed / past records
    SAVED:           'hh_saved_items',       // { professionals:[], services:[] }
    PROFILE:         'hh_profile_cache',     // logged-in user profile snapshot
    LOCATION:        'hh_detected_location', // { lat, lng, address }
    SCORES:          'service_scores',       // { [serviceId]: clickCount }
  };

  /* ── Session storage keys ────────────────────────────────────────── */
  var SESSION_KEYS = {
    SERVICE:    'hh_service',    // service name string for booking flow
    TASK:       'hh_task',       // task description string
    SERVICE_ID: 'hh_service_id', // service catalogue ID
    EM_SERVICE: 'em_service',    // emergency service name string
  };

  /* ── Low-level helpers ───────────────────────────────────────────── */
  function _read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function _write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function _readSession(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }
  function _writeSession(key, value) {
    try { sessionStorage.setItem(key, String(value)); return true; } catch { return false; }
  }
  function _removeSession(key) {
    try { sessionStorage.removeItem(key); } catch {}
  }

  /* ── Booking state (active in-progress booking) ─────────────────── */
  var booking = {
    /** Return the active booking object, or {} if none */
    get: function () { return _read(KEYS.BOOKING) || {}; },

    /** Merge a patch into the active booking state */
    patch: function (patch) {
      var current = booking.get();
      return _write(KEYS.BOOKING, Object.assign({}, current, patch));
    },

    /** Replace the full active booking state */
    set: function (obj) { return _write(KEYS.BOOKING, obj); },

    /** Clear the active booking (after completion / cancellation) */
    clear: function () {
      try { localStorage.removeItem(KEYS.BOOKING); return true; } catch { return false; }
    },

    /** Return true if there is an active booking in progress */
    hasActive: function () {
      var b = booking.get();
      return b && b.status && ['Confirmed', 'Active', 'On the way', 'In Progress'].includes(b.status);
    },
  };

  /* ── Booking history (array of records) ─────────────────────────── */
  var history = {
    MAX_RECORDS: 50,

    /** Return the booking history array (most recent first) */
    getAll: function () { return _read(KEYS.HISTORY) || []; },

    /** Return a single record by ID */
    getById: function (id) {
      return history.getAll().find(function (r) { return r.id === id; }) || null;
    },

    /**
     * Prepend a new record.
     * Will not duplicate if the same ID already exists at position 0.
     */
    push: function (record) {
      var list = history.getAll();
      if (list.length && list[0].id === record.id) return false; // guard against double-save on page reload
      list.unshift(record);
      return _write(KEYS.HISTORY, list.slice(0, history.MAX_RECORDS));
    },

    /**
     * Update a single field (or whole record) by ID.
     * @param {string} id
     * @param {object} patch
     */
    update: function (id, patch) {
      var list = history.getAll();
      var idx  = list.findIndex(function (r) { return r.id === id; });
      if (idx < 0) return false;
      list[idx] = Object.assign({}, list[idx], patch);
      return _write(KEYS.HISTORY, list);
    },

    /** Return records filtered by status string(s) */
    byStatus: function (statusOrArray) {
      var statuses = Array.isArray(statusOrArray) ? statusOrArray : [statusOrArray];
      return history.getAll().filter(function (r) { return statuses.includes(r.status); });
    },

    /** Clear all history (use with care!) */
    clearAll: function () {
      try { localStorage.removeItem(KEYS.HISTORY); return true; } catch { return false; }
    },
  };

  /* ── Saved items ─────────────────────────────────────────────────── */
  var saved = {
    _default: function () { return { professionals: [], services: [] }; },
    get: function () { return _read(KEYS.SAVED) || saved._default(); },
    set: function (obj) { return _write(KEYS.SAVED, obj); },

    savePro: function (pro) {
      var data = saved.get();
      if (!data.professionals.find(function (p) { return p.id === pro.id; })) {
        data.professionals.unshift(pro);
        saved.set(data);
        return true;
      }
      return false; // already saved
    },

    removePro: function (id) {
      var data = saved.get();
      var before = data.professionals.length;
      data.professionals = data.professionals.filter(function (p) { return p.id !== id; });
      if (data.professionals.length < before) { saved.set(data); return true; }
      return false;
    },

    saveService: function (svc) {
      var data = saved.get();
      if (!data.services.find(function (s) { return s.id === svc.id; })) {
        data.services.unshift(svc);
        saved.set(data);
        return true;
      }
      return false;
    },

    removeService: function (id) {
      var data = saved.get();
      var before = data.services.length;
      data.services = data.services.filter(function (s) { return s.id !== id; });
      if (data.services.length < before) { saved.set(data); return true; }
      return false;
    },

    isProSaved: function (id) {
      return !!saved.get().professionals.find(function (p) { return p.id === id; });
    },

    isServiceSaved: function (id) {
      return !!saved.get().services.find(function (s) { return s.id === id; });
    },
  };

  /* ── User profile cache ──────────────────────────────────────────── */
  var profile = {
    get:   function () { return _read(KEYS.PROFILE) || {}; },
    set:   function (obj) { return _write(KEYS.PROFILE, obj); },
    patch: function (patch) { return _write(KEYS.PROFILE, Object.assign(profile.get(), patch)); },
    clear: function () { try { localStorage.removeItem(KEYS.PROFILE); } catch {} },
  };

  /* ── Detected location ───────────────────────────────────────────── */
  var location = {
    get: function () { return _read(KEYS.LOCATION) || null; },
    set: function (obj) { return _write(KEYS.LOCATION, obj); }, // { lat, lng, address }
    clear: function () { try { localStorage.removeItem(KEYS.LOCATION); } catch {} },
  };

  /* ── Service click scores (for ranking the service grid) ─────────── */
  var scores = {
    get: function () { return _read(KEYS.SCORES) || {}; },
    increment: function (serviceId) {
      var s = scores.get();
      s[serviceId] = (s[serviceId] || 0) + 1;
      _write(KEYS.SCORES, s);
    },
    reset: function () { try { localStorage.removeItem(KEYS.SCORES); } catch {} },
  };

  /* ── Session (navigation context between pages) ──────────────────── */
  var session = {
    getService:   function () { return _readSession(SESSION_KEYS.SERVICE); },
    setService:   function (v) { _writeSession(SESSION_KEYS.SERVICE, v); },

    getTask:      function () { return _readSession(SESSION_KEYS.TASK); },
    setTask:      function (v) { _writeSession(SESSION_KEYS.TASK, v); },

    getServiceId: function () { return _readSession(SESSION_KEYS.SERVICE_ID); },
    setServiceId: function (v) { _writeSession(SESSION_KEYS.SERVICE_ID, v); },

    getEmService: function () { return _readSession(SESSION_KEYS.EM_SERVICE); },
    setEmService: function (v) { _writeSession(SESSION_KEYS.EM_SERVICE, v); },

    /** Clear all session navigation keys (call on booking flow exit) */
    clearNavKeys: function () {
      Object.values(SESSION_KEYS).forEach(_removeSession);
    },
  };

  /* ── ID generator ────────────────────────────────────────────────── */
  function generateBookingId(date) {
    var d = date || new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return (
      'HHB-' +
      String(d.getFullYear()).slice(2) +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      pad(d.getMinutes())
    );
  }

  /* ── Public API ──────────────────────────────────────────────────── */
  global.HH_State = {
    booking:            booking,
    history:            history,
    saved:              saved,
    profile:            profile,
    location:           location,
    scores:             scores,
    session:            session,
    generateBookingId:  generateBookingId,
    KEYS:               KEYS,
    SESSION_KEYS:       SESSION_KEYS,
  };

})(typeof window !== 'undefined' ? window : global);
