import { getAppContainer }   from '../../app/container.js';
import { clearUserSession } from '../../utils/clearUserSession.js';

const LOGOUT_REDIRECT_URL = 'login.html';

const { services: { sessionService } } = getAppContainer();

export function bootstrapLogoutLinkController() {
  const logoutLink = document.getElementById('logout-link');
  if (!logoutLink) return;

  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();

    const originalText = logoutLink.textContent;
    logoutLink.textContent    = 'Logging out...';
    logoutLink.style.pointerEvents = 'none';

    try {
      // clearUserSession is called inside sessionService.logout()
      // but we also call it explicitly here as a safety net in case
      // the service call throws before reaching its own clear.
      const uid = window.HH_State ? window.HH_State.currentUid() : null;
      clearUserSession(uid);
      await sessionService.logout();
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      logoutLink.textContent    = originalText;
      logoutLink.style.pointerEvents = 'auto';
      window.location.href = LOGOUT_REDIRECT_URL;
    }
  });
}

bootstrapLogoutLinkController();
