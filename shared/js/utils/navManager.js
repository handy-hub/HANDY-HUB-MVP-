(function (w) {
    'use strict';

    var ORIGIN_KEY = 'hh_nav_origin';
    var DIR_KEY = 'pageTransitionDirection';

    function currentPage() {
        return location.pathname.split('/').pop() || 'dashboard.html';
    }

    function navigate(target, customOrigin) {
        sessionStorage.setItem(ORIGIN_KEY, customOrigin || currentPage());
        sessionStorage.setItem(DIR_KEY, 'forward');
        location.href = target;
    }

    function navigateBack(fallback) {
        var origin = sessionStorage.getItem(ORIGIN_KEY) || fallback || 'dashboard.html';
        sessionStorage.removeItem(ORIGIN_KEY);
        sessionStorage.setItem(DIR_KEY, 'back');
        location.href = origin;
    }

    w.HH = w.HH || {};
    w.HH.nav = { navigate: navigate, navigateBack: navigateBack };

    // Android hardware back button / browser popstate support
    w.addEventListener('popstate', function () {
        navigateBack();
    });

})(window);
