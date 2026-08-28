/* ════════════════════════════════════════════════════════════════════
   HandyHub · State Service
   shared/js/services/stateService.js

   Centralised localStorage / sessionStorage abstraction.
   All user-specific keys are uid-scoped (e.g. hh_booking_<uid>)
   to prevent cross-account data leakage on shared devices.

   Usage:
     // 1. On every protected page (called automatically by requireAuth):
     HH_State.setUser(user.uid);

     // 2. Use any API:
     const booking = window.HH_State.booking.get();

   On logout, call clearUserSession(uid) which also calls HH_State.clearUser().
════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── Current session uid (set by requireAuth / setUser) ─────────────── */
  var _uid = null;

  /* ── Base key names (never written to storage directly) ─────────────── */
  var BASE_KEYS = {
    BOOKING:  'hh_booking',
    HISTORY:  'hh_booking_history',
    SAVED:    'hh_saved_items',
    PROFILE:  'hh_profile_cache',
    LOCATION: 'hh_detected_location',
    SCORES:   'service_scores',
  };

  /* ── Session storage keys (per-tab, not uid-scoped) ─────────────────── */
  var SESSION_KEYS = {
    SERVICE:    'hh_service',
    TASK:       'hh_task',
    SERVICE_ID: 'hh_service_id',
    EM_SERVICE: 'em_service',
  };

  /* ── Key scoping ─────────────────────────────────────────────────────── */
  /**
   * Returns the uid-scoped storage key.
   * Falls back to the bare base key if uid is not yet set (e.g., during
   * the instant-paint before requireAuth resolves — should be rare).
   */
  function _key(base) {
    return _uid ? base + '_' + _uid : base;
  }

  /* ── Low-level localStorage helpers ─────────────────────────────────── */
  function _read(base) {
    try { return JSON.parse(localStorage.getItem(_key(base))); } catch { return null; }
  }
  function _write(base, value) {
    try { localStorage.setItem(_key(base), JSON.stringify(value)); return true; } catch { return false; }
  }
  function _del(base) {
    try { localStorage.removeItem(_key(base)); } catch {}
  }

  /* ── Session storage helpers ─────────────────────────────────────────── */
  function _readSession(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }
  function _writeSession(key, value) {
    try { sessionStorage.setItem(key, String(value)); return true; } catch { return false; }
  }
  function _removeSession(key) {
    try { sessionStorage.removeItem(key); } catch {}
  }

  /* ── Booking state ───────────────────────────────────────────────────── */
  var booking = {
    get: function () { return _read(BASE_KEYS.BOOKING) || {}; },
    patch: function (patch) {
      return _write(BASE_KEYS.BOOKING, Object.assign({}, booking.get(), patch));
    },
    set: function (obj) { return _write(BASE_KEYS.BOOKING, obj); },
    clear: function () { _del(BASE_KEYS.BOOKING); return true; },
    hasActive: function () {
      var b = booking.get();
      if (!b || !b.status) return false;
      var active = [
        'pending','dispatching','searching','dispatched','assigned',
        'accepted','en_route','in_progress','awaiting',
      ];
      return active.includes((b.status || '').toLowerCase());
    },
  };

  /* ── Booking history ─────────────────────────────────────────────────── */
  var history = {
    MAX_RECORDS: 50,
    getAll: function () { return _read(BASE_KEYS.HISTORY) || []; },
    getById: function (id) {
      return history.getAll().find(function (r) { return r.id === id; }) || null;
    },
    push: function (record) {
      var list = history.getAll();
      if (list.length && list[0].id === record.id) return false;
      list.unshift(record);
      return _write(BASE_KEYS.HISTORY, list.slice(0, history.MAX_RECORDS));
    },
    update: function (id, patch) {
      var list = history.getAll();
      var idx  = list.findIndex(function (r) { return r.id === id; });
      if (idx < 0) return false;
      list[idx] = Object.assign({}, list[idx], patch);
      return _write(BASE_KEYS.HISTORY, list);
    },
    byStatus: function (statusOrArray) {
      var statuses = Array.isArray(statusOrArray) ? statusOrArray : [statusOrArray];
      return history.getAll().filter(function (r) { return statuses.includes(r.status); });
    },
    clearAll: function () { _del(BASE_KEYS.HISTORY); return true; },
  };

  /* ── Saved items ─────────────────────────────────────────────────────── */
  // DEPRECATED — no longer the write path. The authoritative saved-professionals/
  // services store is Firestore: customers/{uid}.savedProfessionals / .savedServices.
  // All writes go through savedHelpers.js (window.hhSaveProfessional / hhSaveService)
  // and reads through savedPage.js (real-time subscription). This localStorage API
  // is kept only so clearUserSession() can purge any legacy hh_saved_items_<uid>
  // keys written by older app versions.
  var saved = {
    _default: function () { return { professionals: [], services: [] }; },
    get: function () { return _read(BASE_KEYS.SAVED) || saved._default(); },
    set: function (obj) { return _write(BASE_KEYS.SAVED, obj); },
    savePro: function (pro) {
      var data = saved.get();
      if (!data.professionals.find(function (p) { return p.id === pro.id; })) {
        data.professionals.unshift(pro);
        saved.set(data);
        return true;
      }
      return false;
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

  /* ── User profile cache ──────────────────────────────────────────────── */
  var profile = {
    TTL_MS: 24 * 60 * 60 * 1000,

    get: function () { return _read(BASE_KEYS.PROFILE) || {}; },

    /** Return cache only if uid matches and data is within TTL. */
    getForUser: function (uid) {
      if (!uid) return {};
      var p = _read(BASE_KEYS.PROFILE);
      if (!p) return {};
      if (p._uid && p._uid !== uid) return {};
      if (Date.now() - (p._cachedAt || 0) > profile.TTL_MS) return {};
      return p;
    },

    /** Write full profile, stamping _uid and _cachedAt. */
    set: function (obj, uid) {
      var stamped = Object.assign({}, obj, {
        _uid:      uid || _uid || (obj && obj._uid) || null,
        _cachedAt: Date.now(),
      });
      return _write(BASE_KEYS.PROFILE, stamped);
    },

    /** Merge patch, preserving uid + refreshing timestamp. */
    patch: function (patch, uid) {
      var current = _read(BASE_KEYS.PROFILE) || {};
      var effectiveUid = uid || _uid;
      if (effectiveUid && current._uid && current._uid !== effectiveUid) {
        current = {};
      }
      return _write(BASE_KEYS.PROFILE, Object.assign({}, current, patch, {
        _uid:      effectiveUid || current._uid || null,
        _cachedAt: Date.now(),
      }));
    },

    clear:  function () { _del(BASE_KEYS.PROFILE); return true; },

    isValidFor: function (uid) {
      var p = _read(BASE_KEYS.PROFILE);
      if (!p || !uid) return false;
      if (p._uid && p._uid !== uid) return false;
      return (Date.now() - (p._cachedAt || 0)) < profile.TTL_MS;
    },
  };

  /* ── Detected location ───────────────────────────────────────────────── */
  var location = {
    get:   function () { return _read(BASE_KEYS.LOCATION) || null; },
    set:   function (obj) { return _write(BASE_KEYS.LOCATION, obj); },
    clear: function () { _del(BASE_KEYS.LOCATION); },
  };

  /* ── Service click scores ────────────────────────────────────────────── */
  var scores = {
    get: function () { return _read(BASE_KEYS.SCORES) || {}; },
    increment: function (serviceId) {
      var s = scores.get();
      s[serviceId] = (s[serviceId] || 0) + 1;
      _write(BASE_KEYS.SCORES, s);
    },
    reset: function () { _del(BASE_KEYS.SCORES); },
  };

  /* ── Session navigation context ──────────────────────────────────────── */
  var session = {
    getService:   function () { return _readSession(SESSION_KEYS.SERVICE); },
    setService:   function (v) { _writeSession(SESSION_KEYS.SERVICE, v); },
    getTask:      function () { return _readSession(SESSION_KEYS.TASK); },
    setTask:      function (v) { _writeSession(SESSION_KEYS.TASK, v); },
    getServiceId: function () { return _readSession(SESSION_KEYS.SERVICE_ID); },
    setServiceId: function (v) { _writeSession(SESSION_KEYS.SERVICE_ID, v); },
    getEmService: function () { return _readSession(SESSION_KEYS.EM_SERVICE); },
    setEmService: function (v) { _writeSession(SESSION_KEYS.EM_SERVICE, v); },
    clearNavKeys: function () { Object.values(SESSION_KEYS).forEach(_removeSession); },
  };

  /* ── Booking ID generator ────────────────────────────────────────────── */
  function generateBookingId(date) {
    var d   = date || new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var rnd;
    try {
      var arr = new Uint8Array(2);
      crypto.getRandomValues(arr);
      rnd = Array.from(arr, function (b) { return b.toString(16).padStart(2, '0'); })
               .join('').toUpperCase();
    } catch (_) {
      rnd = Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
    }
    return 'HHB-' +
      String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) +
      '-' + rnd;
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  global.HH_State = {
    booking:           booking,
    history:           history,
    saved:             saved,
    profile:           profile,
    location:          location,
    scores:            scores,
    session:           session,
    generateBookingId: generateBookingId,

    /** Return the current uid-scoped key for a given base key string. */
    scopedKey: function (base) { return _key(base); },

    /** Return the current authenticated uid (or null). */
    currentUid: function () { return _uid; },

    /**
     * Activate uid-scoped storage for the authenticated user.
     * Called by requireAuth() on every protected page.
     * Also saves hh_last_session_uid for the dashboard instant-paint.
     */
    setUser: function (uid) {
      _uid = uid || null;
      if (_uid) {
        try { localStorage.setItem('hh_last_session_uid', _uid); } catch {}
      }
    },

    /**
     * Deactivate uid-scoped storage (called on logout before page redirect).
     * Does NOT clear any storage — use clearUserSession() for that.
     */
    clearUser: function () { _uid = null; },

    BASE_KEYS:    BASE_KEYS,
    SESSION_KEYS: SESSION_KEYS,

    /* Backward-compat alias — old code used KEYS */
    KEYS: BASE_KEYS,
  };

})(typeof window !== 'undefined' ? window : global);
