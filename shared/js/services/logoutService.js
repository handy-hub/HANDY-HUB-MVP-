(async () => {
const { auth } = await import('../firebase/firebaseConfig.js');
    const { signOut } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');

    const LOGOUT_REDIRECT_URL = 'login.html';
    const logoutLink = document.getElementById('logout-link');

    if (logoutLink) {
        logoutLink.addEventListener('click', async (event) => {
            event.preventDefault();

            const originalText = logoutLink.textContent;
            logoutLink.textContent = 'Logging out...';
            logoutLink.style.pointerEvents = 'none';

            try {
                await signOut(auth);
            } catch (error) {
                console.error('Logout failed:', error);
            } finally {
                logoutLink.textContent = originalText;
                logoutLink.style.pointerEvents = 'auto';
                window.location.href = LOGOUT_REDIRECT_URL;
            }
        });
    }
})();
