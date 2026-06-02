/**
 * Pageview counter — calls GET /api/pageviews once per page load.
 */
(function initPageViewsCounter() {
  const FALLBACK_VIEWS = 125;
  const STORAGE_KEY = 'smartchoice_pageviews_last';

  function formatCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return String(FALLBACK_VIEWS);
    return n.toLocaleString('en-AU');
  }

  function setPageViewsText(totalViews) {
    const countEl = document.getElementById('pageviews-count');
    const display = document.getElementById('pageviews-display');
    if (!countEl || !display) return;

    countEl.textContent = formatCount(totalViews);
    display.removeAttribute('hidden');
    display.classList.remove('is-loading');
    display.classList.add('is-visible');
    display.style.display = 'block';
  }

  function readCachedViews() {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (!cached) return null;
      const n = Number(cached);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  function persistViews(totalViews) {
    try {
      localStorage.setItem(STORAGE_KEY, String(totalViews));
    } catch {
      /* private mode */
    }
  }

  function showBestKnown(fallback) {
    const cached = readCachedViews();
    if (cached != null) {
      setPageViewsText(Math.max(cached, fallback));
      return;
    }
    setPageViewsText(fallback);
  }

  async function fetchPageViewsOnce() {
    const response = await fetch('/api/pageviews', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok && data.total_views != null) {
      setPageViewsText(data.total_views);
      persistViews(data.total_views);
      return true;
    }

    console.warn('[SmartChoice] Pageviews API:', response.status, data.error || data);
    return false;
  }

  async function fetchAndShowPageViews() {
    const countEl = document.getElementById('pageviews-count');
    if (!countEl) return;

    const cached = readCachedViews();
    if (cached != null) {
      setPageViewsText(cached);
    }

    try {
      let ok = await fetchPageViewsOnce();
      if (!ok) {
        await new Promise((r) => setTimeout(r, 400));
        ok = await fetchPageViewsOnce();
      }
      if (ok) return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('[SmartChoice] Pageviews:', err.message || err);
    }

    showBestKnown(FALLBACK_VIEWS);
  }

  function startOnce() {
    if (window.__smartchoicePageViewsStarted) return;
    window.__smartchoicePageViewsStarted = true;
    fetchAndShowPageViews();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startOnce, { once: true });
  } else {
    startOnce();
  }
})();
