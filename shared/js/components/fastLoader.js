(function () {
    var COLOR = '#730201';
    var bar = null;

    function ensureBar() {
        if (bar) return;
        bar = document.createElement('div');
        bar.setAttribute('style',
            'position:fixed;top:0;left:0;height:3px;z-index:99999;pointer-events:none;' +
            'background:' + COLOR + ';width:0%;opacity:0;transition:none;'
        );
        document.body.appendChild(bar);
    }

    function startLoading() {
        ensureBar();
        bar.style.transition = 'none';
        bar.style.width = '0%';
        bar.style.opacity = '1';
        bar.offsetWidth; // force reflow so transition triggers
        bar.style.transition = 'width 0.6s cubic-bezier(0.1, 0.5, 0.2, 1)';
        bar.style.width = '80%';
    }

    function finishLoading() {
        ensureBar();
        bar.style.transition = 'none';
        bar.style.width = '0%';
        bar.style.opacity = '1';
        bar.offsetWidth;
        bar.style.transition = 'width 0.25s ease';
        bar.style.width = '100%';
        setTimeout(function () {
            bar.style.transition = 'opacity 0.2s ease';
            bar.style.opacity = '0';
        }, 250);
    }

    document.addEventListener('click', function (e) {
        var el = e.target.closest('a[href]');
        if (!el) return;
        var href = el.getAttribute('href');
        if (!href || href.charAt(0) === '#' ||
            href.indexOf('javascript:') === 0 ||
            href.indexOf('mailto:') === 0 ||
            href.indexOf('tel:') === 0 ||
            el.target === '_blank') return;
        try {
            var url = new URL(href, window.location.href);
            if (url.origin !== window.location.origin) return;
        } catch (_) { return; }
        startLoading();
    }, true);

    document.addEventListener('DOMContentLoaded', finishLoading);
})();
