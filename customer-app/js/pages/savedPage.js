import { requireAuth }     from '../../shared/js/utils/authGuard.js';
import { getAppContainer } from '../../shared/js/app/container.js';

await requireAuth();

const { services: { authService, databaseService } } = getAppContainer();
const user = await authService.waitForUser();

if (user) {
  window._svUid = user.uid;

  const unsub = databaseService.subscribeToDocument(
    'customers',
    user.uid,
    function (snap) {
      if (!snap || !snap.data) {
        window._svPros = [];
        window._svSvcs = [];
      } else {
        window._svPros = Array.isArray(snap.data.savedProfessionals) ? snap.data.savedProfessionals : [];
        window._svSvcs = Array.isArray(snap.data.savedServices)      ? snap.data.savedServices      : [];
      }
      window.svRender(window._svFilter || '');
    },
    function (err) {
      console.warn('[saved] Firestore subscription error:', err);
      window._svPros = [];
      window._svSvcs = [];
      window.svRender('');
    }
  );

  window.addEventListener('pagehide', function () {
    if (typeof unsub === 'function') unsub();
  });
}
