(() => {
    const forwardButtonSelector = '.notification-wrapper-button';
    const backButtonSelectors = '.back-to-dashboard';
    const forwardTarget = 'notification.html';
    const backTarget = 'dashboard.html';
    const transitionStorageKey = 'pageTransitionDirection';

    function setTransitionDirection(direction) {
        try {
            sessionStorage.setItem(transitionStorageKey, direction);
        } catch (error) {
            // silent fallback if sessionStorage is unavailable
        }
    }

    function getTransitionDirection() {
        try {
            const saved = sessionStorage.getItem(transitionStorageKey);
            if (saved) {
                sessionStorage.removeItem(transitionStorageKey);
                return saved;
            }
        } catch (error) {
            return null;
        }
        return null;
    }

    function handleForwardClick(event) {
        event.preventDefault();
        setTransitionDirection('forward');
        window.location.href = forwardTarget;
    }

    function handleBackClick(event) {
        event.preventDefault();
        setTransitionDirection('back');
        window.location.href = backTarget;
    }

    function activateEntryAnimation() {
        const mounted = document.body;
        const pageType = document.body.dataset.pageType;
        const savedDirection = getTransitionDirection();

        if (savedDirection === 'back') {
            mounted.classList.add('page-slide-in-left');
        } else if (pageType === 'notification' || savedDirection === 'forward') {
            mounted.classList.add('page-slide-in-right');
        }

        if (mounted.classList.contains('page-slide-in-left') || mounted.classList.contains('page-slide-in-right')) {
            mounted.addEventListener('animationend', () => {
                mounted.classList.remove('page-slide-in-left', 'page-slide-in-right');
            }, { once: true });
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const forwardButton = document.querySelector(forwardButtonSelector);
        if (forwardButton) {
            forwardButton.addEventListener('click', handleForwardClick);
        }

        document.querySelectorAll(backButtonSelectors).forEach(button => {
            button.addEventListener('click', handleBackClick);
        });

        activateEntryAnimation();
    });
})();
