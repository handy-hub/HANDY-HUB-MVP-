/* ════════════════════════════════════════════════════════════════════
   HandyHub · Booking Service
   shared/js/services/bookingService.js

   All booking-related read/write operations in one place.
   Depends on stateService.js being loaded first (window.HH_State).

   Usage:
     <script src="../shared/js/services/stateService.js"></script>
     <script src="../shared/js/services/bookingService.js"></script>
     const id = window.HH_Booking.confirm({ professional, services, schedule, total });

   Migration path → swap the _persist* functions below to call
   Firebase / Supabase / REST without touching any page code.
════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Ensure stateService is available */
  var _state = global.HH_State;
  if (!_state) {
    console.warn('[HH_Booking] stateService not loaded — booking features degraded.');
    _state = { booking: { get: function(){return{};}, patch: function(){}, clear: function(){} },
               history: { push: function(){}, update: function(){}, getAll: function(){return[];}, getById: function(){return null;} },
               generateBookingId: function(){ return 'HHB-' + Date.now(); } };
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */
  var _pad = function (n) { return String(n).padStart(2, '0'); };

  function _buildId(date) {
    return _state.generateBookingId(date);
  }

  /* ── Status constants ────────────────────────────────────────────── */
  // These values must match the Firestore bookings schema exactly.
  // 'pending' (lowercase) is the canonical create-time status per firestore.rules.
  var STATUS = {
    PENDING:    'pending',
    CONFIRMED:  'pending',    // alias — both map to 'pending' in Firestore
    ACTIVE:     'in_progress',
    ON_THE_WAY: 'en_route',
    COMPLETED:  'completed',
    CANCELLED:  'cancelled',
    EMERGENCY:  'pending',    // emergency bookings start as 'pending'
  };

  /* ── Core booking actions ────────────────────────────────────────── */

  /**
   * Confirm a booking. Saves to both hh_booking (active) and
   * hh_booking_history (array). Returns the generated booking ID.
   *
   * @param {object} opts
   *   professional  — professional object from book-step2
   *   services      — array of service objects
   *   schedule      — { date, dateDisplay, dateShort, time }
   *   total         — numeric total (GHC)
   *   payment       — payment method label string
   *   notes         — optional string
   *   type          — 'standard' | 'emergency' (default 'standard')
   */
  function confirm(opts) {
    var now   = new Date();
    var id    = _buildId(now);
    var pro   = opts.professional || {};
    var svc   = opts.services && opts.services.length ? opts.services[0] : {};
    var sched = opts.schedule || {};
    var status = opts.type === 'emergency' ? STATUS.EMERGENCY : STATUS.CONFIRMED;

    var record = {
      id:          id,
      service:     svc.name    || opts.serviceName || 'Service',
      serviceIcon: svc.icon    || '',
      category:    svc.category || '',
      proName:     pro.name    || 'Professional',
      proType:     pro.type    || '',
      proPhoto:    pro.photo   || null,
      proPhone:    pro.phone   || null,
      proRating:   pro.rating  || null,
      proId:       pro.id      || null,
      dateDisplay: sched.dateDisplay || sched.dateShort || '',
      date:        sched.date  || '',
      time:        sched.time  || '',
      total:       opts.total  || 0,
      payment:     opts.payment || 'Wallet',
      notes:       opts.notes  || '',
      status:      status,
      type:        opts.type   || 'standard',
      ts:          now.toISOString(),
      reviewLeft:  false,
    };

    /* Persist to history */
    _state.history.push(record);

    /* Update active booking state */
    _state.booking.patch({
      bookingId: id,
      status:    status,
      ts:        now.toISOString(),
    });

    return id;
  }

  /**
   * Mark a booking completed (updates both history record and active state).
   * Call this when the customer taps "Confirm Done" in booking.html or
   * the slide-to-complete in live-tracking.html.
   *
   * @param {string} id  Booking ID
   */
  function markCompleted(id) {
    _state.history.update(id, { status: STATUS.COMPLETED, completedAt: new Date().toISOString() });
    _state.booking.patch({ status: STATUS.COMPLETED });
  }

  /**
   * Mark a booking cancelled.
   * @param {string} id  Booking ID
   * @param {string} reason  Optional cancellation reason
   */
  function markCancelled(id, reason) {
    _state.history.update(id, {
      status:      STATUS.CANCELLED,
      cancelledAt: new Date().toISOString(),
      cancelReason: reason || '',
    });
    _state.booking.patch({ status: STATUS.CANCELLED });
  }

  /**
   * Save a review against a completed booking.
   * @param {string} id       Booking ID
   * @param {object} review   { rating, tags, comment, tip }
   */
  function saveReview(id, review) {
    _state.history.update(id, {
      reviewLeft: true,
      review: {
        rating:    review.rating    || 0,
        tags:      review.tags      || [],
        comment:   review.comment   || '',
        tip:       review.tip       || 0,
        reviewedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Get the current active booking (from hh_booking).
   * Returns {} if none.
   */
  function getActive() { return _state.booking.get(); }

  /**
   * Clear the active booking slot (call after completion or cancel).
   */
  function clearActive() { _state.booking.clear(); }

  /**
   * Get all booking history records.
   */
  function getHistory() { return _state.history.getAll(); }

  /**
   * Get a booking history record by ID.
   */
  function getById(id) { return _state.history.getById(id); }

  /**
   * Get bookings filtered by status label(s).
   * @param {string|string[]} status
   */
  function getByStatus(status) { return _state.history.byStatus(status); }

  /**
   * Classify history into tab buckets for booking.html.
   * Returns { upcoming, active, completed, cancelled }
   */
  function classify() {
    var all = _state.history.getAll();
    return {
      upcoming:  all.filter(function (r) { return ['pending','Pending','Confirmed'].includes(r.status); }),
      active:    all.filter(function (r) { return ['Active','On the way','In Progress','En Route','Emergency'].includes(r.status); }),
      completed: all.filter(function (r) { return r.status === STATUS.COMPLETED; }),
      cancelled: all.filter(function (r) { return r.status === STATUS.CANCELLED; }),
    };
  }

  /* ── Emergency booking shortcut ──────────────────────────────────── */

  /**
   * Fast-path: confirm an emergency booking.
   * @param {object} opts  { serviceName, pro, eta, refCode }
   */
  function confirmEmergency(opts) {
    var now    = new Date();
    var id     = _buildId(now);
    var pro    = opts.pro || {};

    var record = {
      id:          id,
      service:     opts.serviceName || 'Emergency Service',
      proName:     pro.name    || 'Professional',
      proType:     pro.type    || '',
      proPhoto:    pro.photo   || null,
      proPhone:    pro.phone   || null,
      proRating:   pro.rating  || null,
      proId:       pro.id      || null,
      dateDisplay: now.toLocaleDateString('en-GH', { weekday:'short', day:'numeric', month:'short', year:'numeric' }),
      date:        now.toISOString().slice(0, 10),
      time:        now.toLocaleTimeString('en-GH', { hour:'2-digit', minute:'2-digit' }),
      total:       opts.total  || 0,
      payment:     'Pay on completion',
      status:      STATUS.EMERGENCY,
      type:        'emergency',
      eta:         opts.eta    || null,
      refCode:     opts.refCode || id,
      ts:          now.toISOString(),
      reviewLeft:  false,
    };

    _state.history.push(record);
    _state.booking.patch({
      bookingId:   id,
      status:      STATUS.EMERGENCY,
      professional: pro,
      serviceName:  opts.serviceName,
      refCode:     opts.refCode || id,
      ts:          now.toISOString(),
    });

    return id;
  }

  /* ── Public API ──────────────────────────────────────────────────── */
  global.HH_Booking = {
    confirm:          confirm,
    confirmEmergency: confirmEmergency,
    markCompleted:    markCompleted,
    markCancelled:    markCancelled,
    saveReview:       saveReview,
    getActive:        getActive,
    clearActive:      clearActive,
    getHistory:       getHistory,
    getById:          getById,
    getByStatus:      getByStatus,
    classify:         classify,
    STATUS:           STATUS,
  };

  /* Legacy ES module export (no-op in plain script context) */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.HH_Booking;
  }

})(typeof window !== 'undefined' ? window : global);
