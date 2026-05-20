document.addEventListener('DOMContentLoaded', () => {

    // Back button
    const backBtn = document.querySelector('.back-btn');
    if (backBtn) backBtn.addEventListener('click', () => history.back());

    // Find the Theme menu item
    let themeBtn = null;
    document.querySelectorAll('.menu-item').forEach(item => {
        const title = item.querySelector('.menu-title');
        if (title && title.textContent.trim() === 'Theme') themeBtn = item;
    });

    if (themeBtn) {
        const valueSpan = themeBtn.querySelector('.menu-value');

        function updateLabel() {
            if (valueSpan) valueSpan.textContent = window.isDarkMode() ? 'Dark' : 'Light';
        }

        updateLabel();

        themeBtn.addEventListener('click', () => {
            window.toggleTheme();
            updateLabel();
        });
    }
});
