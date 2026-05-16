(() => {
  function injectScript(src, onError) {
    const script = document.createElement("script");
    script.src = src;
    script.defer = true;
    if (typeof onError === "function") {
      script.onerror = onError;
    }
    document.head.appendChild(script);
  }

  injectScript("../js/pages/trackingPage.js", () => {
    injectScript("../js/Pages/trackingPage.js");
  });
})();
