// Runs immediately when loaded — apply before paint to prevent flash
(function () {
    if (localStorage.getItem('hh_theme') === 'dark') {
        document.documentElement.classList.add('dark');
    }
})();

window.toggleTheme = function () {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('hh_theme', isDark ? 'dark' : 'light');
    return isDark;
};

window.isDarkMode = function () {
    return document.documentElement.classList.contains('dark');
};
