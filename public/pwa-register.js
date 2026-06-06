/**
 * ShoppingSmart PWA — service worker + deferred install prompt.
 * Suppresses the browser auto-prompt; shows a custom banner after 30s or user action.
 */
(function initShoppingSmartPwa() {
  var DISMISS_KEY = 'shoppingsmart_pwa_install_dismissed';
  var DELAY_MS = 30000;

  var deferredPrompt = null;
  var bannerEligible = false;
  var bannerVisible = false;
  var delayTimer = null;

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isDismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (_e) {
      return false;
    }
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  }

  function canOfferInstall() {
    if (isStandalone() || isDismissed()) return false;
    return Boolean(deferredPrompt) || isIos();
  }

  function getBannerEl() {
    return document.getElementById('pwa-install-banner');
  }

  function updateIosCopy() {
    var sub = document.getElementById('pwa-install-sub');
    var btn = document.getElementById('pwa-install-btn');
    if (!sub || !btn) return;
    if (!deferredPrompt && isIos()) {
      sub.textContent = 'Tap Share, then "Add to Home Screen"';
      btn.textContent = 'Got it';
    }
  }

  function showBanner() {
    if (bannerVisible || !bannerEligible || !canOfferInstall()) return;
    var banner = getBannerEl();
    if (!banner) return;
    updateIosCopy();
    banner.classList.remove('hidden');
    bannerVisible = true;
  }

  function hideBanner() {
    var banner = getBannerEl();
    if (banner) banner.classList.add('hidden');
    bannerVisible = false;
  }

  function markEligible() {
    if (!canOfferInstall()) return;
    bannerEligible = true;
    showBanner();
  }

  function dismissBanner() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch (_e) {
      /* ignore */
    }
    hideBanner();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (err) {
        console.warn('[ShoppingSmart PWA] Service worker registration failed:', err);
      });
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (bannerEligible) showBanner();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    dismissBanner();
  });

  delayTimer = window.setTimeout(function () {
    markEligible();
  }, DELAY_MS);

  function bindBannerUi() {
    var installBtn = document.getElementById('pwa-install-btn');
    var dismissBtn = document.getElementById('pwa-install-dismiss');

    installBtn?.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (choice) {
          deferredPrompt = null;
          if (choice.outcome === 'accepted') {
            dismissBanner();
          }
        });
        return;
      }
      if (isIos()) hideBanner();
    });

    dismissBtn?.addEventListener('click', dismissBanner);
  }

  window.ShoppingSmartPwa = {
    /** Call after a successful search or meaningful user action */
    notifyUserAction: function () {
      markEligible();
    },
  };

  registerServiceWorker();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindBannerUi);
  } else {
    bindBannerUi();
  }
})();
