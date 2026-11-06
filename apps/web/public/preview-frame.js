// Coding Studio preview frame: the editor posts the app's HTML; it replaces this page (which
// keeps this page's Content-Security-Policy, made for running the app).
(function () {
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.source !== 'coding-studio-editor' || typeof e.data.html !== 'string') return;
    document.open();
    document.write(e.data.html);
    document.close();
  });
  parent.postMessage({ source: 'coding-studio-preview-frame', ready: true }, location.origin);
})();
