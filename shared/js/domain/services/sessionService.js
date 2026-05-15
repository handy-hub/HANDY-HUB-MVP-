export function createSessionService({ authRepository }) {
  if (!authRepository) {
    throw new Error("SessionService requires authRepository.");
  }

  return {
    async logout() {
      await authRepository.signOut();
    }
  };
}

