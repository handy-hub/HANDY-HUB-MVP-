import { clearUserSession } from '../../utils/clearUserSession.js';

export function createSessionService({ authRepository }) {
  if (!authRepository) {
    throw new Error('SessionService requires authRepository.');
  }

  return {
    /**
     * Sign out the current user.
     * Clears all uid-scoped localStorage, sessionStorage, and in-memory
     * HH_State BEFORE calling Firebase signOut so the uid is still available
     * when constructing scoped key names.
     */
    async logout() {
      // Resolve uid while we still have it
      const uid = window.HH_State ? window.HH_State.currentUid() : null;
      clearUserSession(uid);
      await authRepository.signOut();
    },
  };
}
