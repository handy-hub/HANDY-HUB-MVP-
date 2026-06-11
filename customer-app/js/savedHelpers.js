import { getAppContainer } from '../shared/js/app/container.js';

window.hhSaveProfessional = async function (pro) {
  if (!pro || !pro.id) return;
  try {
    const { services: { authService, databaseService } } = getAppContainer();
    const user = await authService.waitForUser();
    if (!user) return;

    // Force-refresh the customer doc before reading so we never append to a
    // stale cached list (the in-memory TTL is 30 s — another tab may have
    // removed or added items since the cache was last populated).
    if (typeof databaseService.invalidate === 'function') {
      databaseService.invalidate('customers', user.uid);
    }

    const snap     = await databaseService.getDocument('customers', user.uid);
    const existing = (snap?.data?.savedProfessionals || []);
    if (existing.find(function (p) { return p.id === pro.id; })) return;

    const item = {
      id:           pro.id,
      name:         pro.name         || 'Professional',
      specialty:    pro.specialty    || pro.category || '',
      category:     pro.category     || pro.specialty || '',
      rating:       pro.rating       ?? null,
      reviewCount:  pro.reviewCount  ?? 0,
      profileImage: pro.profileImage || pro.photo || null,
      isOnline:     pro.isOnline     || false,
      location:     pro.location     || '',
      savedAt:      new Date().toISOString(),
    };

    await databaseService.updateDocument('customers', user.uid, {
      savedProfessionals: [...existing, item],
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[saved] hhSaveProfessional error:', err);
  }
};

window.hhSaveService = async function (svc) {
  if (!svc || !svc.id) return;
  try {
    const { services: { authService, databaseService } } = getAppContainer();
    const user = await authService.waitForUser();
    if (!user) return;

    if (typeof databaseService.invalidate === 'function') {
      databaseService.invalidate('customers', user.uid);
    }

    const snap     = await databaseService.getDocument('customers', user.uid);
    const existing = (snap?.data?.savedServices || []);
    if (existing.find(function (s) { return s.id === svc.id; })) return;

    const item = {
      id:       svc.id,
      name:     svc.name        || 'Service',
      desc:     svc.desc        || svc.description || '',
      category: svc.category    || '',
      savedAt:  new Date().toISOString(),
    };

    await databaseService.updateDocument('customers', user.uid, {
      savedServices: [...existing, item],
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[saved] hhSaveService error:', err);
  }
};

window.hhIsProfessionalSaved = async function (artisanId) {
  try {
    const { services: { authService, databaseService } } = getAppContainer();
    const user = await authService.waitForUser();
    if (!user) return false;
    const snap = await databaseService.getDocument('customers', user.uid);
    const list = snap?.data?.savedProfessionals || [];
    return list.some(function (p) { return p.id === artisanId; });
  } catch (_) { return false; }
};
