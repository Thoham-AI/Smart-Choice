/**
 * Register the ShoppingSmart service worker (production + localhost).
 */
(function registerShoppingSmartPwa() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(function (err) {
        console.warn('[ShoppingSmart PWA] Service worker registration failed:', err);
      });
  });
})();
