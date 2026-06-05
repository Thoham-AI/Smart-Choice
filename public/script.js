/** Cùng domain khi deploy (Vercel/điện thoại); localhost khi mở file trực tiếp */
const API_BASE =
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost:3000';
const FALLBACK_IMAGE_URL = 'https://placehold.co/150?text=No+Image';
const CART_STORAGE_KEY = 'shoppingsmart_cart';
const WATCHLIST_STORAGE_KEY = 'shoppingsmart_watchlist';
const THEME_STORAGE_KEY = 'shoppingsmart_theme';
const HISTORY_STORAGE_KEY = 'shoppingsmart_history';
const HISTORY_MAX_ITEMS = 5;
/** Persists in-app location choice so the banner does not reappear every visit. */
const LOCATION_CONSENT_STORAGE_KEY = 'shoppingsmart_location_consent';

/** Sydney CBD fallback when the user declines GPS or the browser cannot provide it. */
const DEFAULT_SYDNEY_LOCATION = {
  latitude: -33.8688,
  longitude: 151.2093,
};

/** Copy shown before the user chooses Share location / Not now. */
const LOCATION_CONSENT_MESSAGE =
  'Agree to share your location so we can update prices at the supermarkets nearest to you.';

/**
 * Coordinates forwarded on every API call (headers + query).
 * `ready` is false until the user taps Share location or Not now.
 * `source` is "pending" until a choice is made; never calls GPS before consent.
 */
let userLocation = {
  latitude: DEFAULT_SYDNEY_LOCATION.latitude,
  longitude: DEFAULT_SYDNEY_LOCATION.longitude,
  source: 'pending',
  ready: false,
};

/** True while navigator.geolocation.getCurrentPosition is in flight after consent. */
let locationRequestInFlight = false;

/** Resolves after the user completes the location popup (Share / Not now). */
let locationConsentResume = null;

/** Whether the location popup is currently visible. */
let locationConsentModalOpen = false;

/** Shared promise while the location popup is waiting for a choice. */
let locationConsentPendingPromise = null;

/** Tổng tiền tiết kiệm tích lũy trong giỏ (cộng dồn mỗi lần Add to cart) */
let totalSaved = 0;

// --- Geolocation (explicit in-app consent, then browser API) ---

/**
 * Restore a previous Share / Not now choice from localStorage (skips the banner).
 */
function loadSavedLocationConsent() {
  try {
    const raw = localStorage.getItem(LOCATION_CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ready) return null;
    const lat = Number(parsed.latitude);
    const lng = Number(parsed.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      latitude: lat,
      longitude: lng,
      source: parsed.source === 'gps' ? 'gps' : 'default',
      ready: true,
    };
  } catch {
    return null;
  }
}

function saveLocationConsentChoice() {
  try {
    localStorage.setItem(
      LOCATION_CONSENT_STORAGE_KEY,
      JSON.stringify({
        latitude: userLocation.latitude,
        longitude: userLocation.longitude,
        source: userLocation.source,
        ready: true,
      })
    );
  } catch {
    /* private mode / quota — banner still dismisses */
  }
}

/**
 * Hide the location consent popup after the user has chosen Share or Not now.
 */
function dismissLocationConsentBanner() {
  hideLocationConsentModal();
}

function showLocationConsentModal() {
  const modal = document.getElementById('location-consent-modal');
  if (!modal || locationConsentModalOpen || userLocation.ready) return;

  locationConsentModalOpen = true;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('location-modal-open');
  updateLocationNoticeUi();

  const allowBtn = document.getElementById('location-allow-btn');
  allowBtn?.focus();
}

function hideLocationConsentModal() {
  const modal = document.getElementById('location-consent-modal');
  if (!modal) return;

  if (modal.classList.contains('hidden')) {
    locationConsentModalOpen = false;
    return;
  }

  modal.classList.add('location-modal--closing');

  const finish = () => {
    modal.classList.remove('location-modal--closing');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('location-modal-open');
    locationConsentModalOpen = false;
  };

  modal.addEventListener('transitionend', finish, { once: true });
  window.setTimeout(finish, 280);
}

/**
 * Show the location popup on first price lookup; skip if the user already chose.
 * @returns {Promise<void>}
 */
function ensureLocationConsent() {
  if (userLocation.ready) return Promise.resolve();
  if (locationConsentPendingPromise) return locationConsentPendingPromise;

  locationConsentPendingPromise = new Promise((resolve) => {
    locationConsentResume = () => {
      locationConsentPendingPromise = null;
      resolve();
    };
    showLocationConsentModal();
  });

  return locationConsentPendingPromise;
}

function resumeLocationConsentFlow() {
  const resume = locationConsentResume;
  locationConsentResume = null;
  resume?.();
}

/**
 * Wire the location popup buttons. Does not touch the Geolocation API until the user agrees.
 */
function initLocationConsentUi() {
  const saved = loadSavedLocationConsent();
  if (saved) {
    userLocation = saved;
    hideLocationConsentModal();
  }

  const allowBtn = document.getElementById('location-allow-btn');
  const declineBtn = document.getElementById('location-decline-btn');
  const backdrop = document.getElementById('location-modal-backdrop');

  allowBtn?.addEventListener('click', onLocationConsentAllow);
  declineBtn?.addEventListener('click', onLocationConsentDecline);
  backdrop?.addEventListener('click', onLocationConsentDecline);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const modal = document.getElementById('location-consent-modal');
    if (!modal || modal.classList.contains('hidden') || userLocation.ready) return;
    onLocationConsentDecline();
  });
}

/** User agreed in-app → request browser GPS (second permission layer). */
function onLocationConsentAllow() {
  if (userLocation.ready || locationRequestInFlight) return;

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    applyDefaultUserLocation('unsupported');
    return;
  }

  locationRequestInFlight = true;
  setLocationConsentButtonsDisabled(true);
  dismissLocationConsentBanner();

  navigator.geolocation.getCurrentPosition(
    (position) => {
      locationRequestInFlight = false;
      userLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        source: 'gps',
        ready: true,
      };
      finalizeLocationConsentUi();
    },
    () => {
      locationRequestInFlight = false;
      applyDefaultUserLocation('denied');
    },
    {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 5 * 60 * 1000,
    }
  );
}

/** User declined in-app → use Sydney default; do not call the Geolocation API. */
function onLocationConsentDecline() {
  if (userLocation.ready || locationRequestInFlight) return;
  hideLocationConsentModal();
  applyDefaultUserLocation('declined');
}

/** Apply Sydney defaults after decline, denial, or unsupported browsers. */
function applyDefaultUserLocation(_reason) {
  userLocation = {
    latitude: DEFAULT_SYDNEY_LOCATION.latitude,
    longitude: DEFAULT_SYDNEY_LOCATION.longitude,
    source: 'default',
    ready: true,
  };
  finalizeLocationConsentUi();
}

/** Persist choice, close popup, continue any pending search. */
function finalizeLocationConsentUi() {
  setLocationConsentButtonsDisabled(false);
  saveLocationConsentChoice();
  dismissLocationConsentBanner();
  resumeLocationConsentFlow();
}

function setLocationConsentButtonsDisabled(disabled) {
  const allowBtn = document.getElementById('location-allow-btn');
  const declineBtn = document.getElementById('location-decline-btn');
  if (allowBtn) allowBtn.disabled = disabled;
  if (declineBtn) declineBtn.disabled = disabled;
}

/** Headers attached to every ShoppingSmart API request. */
function getLocationRequestHeaders() {
  return {
    'X-Latitude': String(userLocation.latitude),
    'X-Longitude': String(userLocation.longitude),
    'X-Location-Source': userLocation.source || 'default',
  };
}

/**
 * Append latitude/longitude query params (in addition to headers) for GET routes.
 * @param {string} pathWithQuery - e.g. "/api/compare?keyword=milk"
 */
function buildApiUrl(pathWithQuery) {
  const url = new URL(pathWithQuery, API_BASE);
  url.searchParams.set('latitude', String(userLocation.latitude));
  url.searchParams.set('longitude', String(userLocation.longitude));
  return url.toString();
}

/** Hủy tìm kiếm compare trước đó khi gõ từ khóa mới. */
let compareSearchAbortController = null;

const COMPARE_FETCH_TIMEOUT_MS = 42000;

/**
 * fetch() wrapper: always forwards the latest known coordinates to the backend.
 */
async function apiFetch(url, options = {}) {
  const headers = {
    ...getLocationRequestHeaders(),
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

/**
 * fetch compare với timeout + hủy request cũ (tránh chồng "pork belly" + "prawn").
 */
async function apiFetchCompare(url) {
  compareSearchAbortController?.abort();
  compareSearchAbortController = new AbortController();
  const signal = compareSearchAbortController.signal;

  const timeoutId = setTimeout(() => compareSearchAbortController.abort(), COMPARE_FETCH_TIMEOUT_MS);

  try {
    return await apiFetch(url, { signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Update banner copy. Pass optionalMessage to override auto text (e.g. while waiting on GPS).
 */
function updateLocationNoticeUi(optionalMessage) {
  const textEl = document.getElementById('location-notice-text');
  if (!textEl) return;

  if (optionalMessage) {
    textEl.textContent = optionalMessage;
    return;
  }

  if (!userLocation.ready) {
    textEl.textContent = LOCATION_CONSENT_MESSAGE;
    return;
  }

  if (userLocation.source === 'gps') {
    textEl.textContent =
      'Using your location to show prices from supermarkets near you.';
    return;
  }

  textEl.textContent =
    'Showing prices using Sydney, NSW as the default area. You can reload the page to share location later.';
}

// --- Tiết kiệm / gamification (so sánh Coles vs Woolworths) ---

/** Làm tròn tiền tệ 2 chữ số thập phân */
function roundMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

/**
 * Ngưỡng sai số ($) khi so sánh giá/kg hoặc giá gói — khớp logic API (api/index.js).
 * Chênh ≤ ngưỡng → đồng giá, không hiện tag "Coles/Woolworths cheaper".
 */
const PRICE_EPSILON = 0.05;

/**
 * Chuẩn hóa giá/kg từ sản phẩm (field hoặc parse unit_price_text).
 * @returns {number|null}
 */
function extractUnitPricePerKg(product) {
  if (!product) return null;
  if (product.pricePerKg != null && Number(product.pricePerKg) > 0) {
    return Number(product.pricePerKg);
  }
  const text = String(product.unit_price_text || '');
  const kgMatch = text.match(/\$?\s*([\d.]+)\s*\/\s*kg\b/i);
  if (kgMatch) {
    const v = parseFloat(kgMatch[1]);
    if (Number.isFinite(v) && v > 0) return Number(v.toFixed(4));
  }
  const per100g = text.match(/\$?\s*([\d.]+)\s*\/\s*100\s*g\b/i);
  if (per100g) {
    const v = parseFloat(per100g[1]);
    if (Number.isFinite(v) && v > 0) return Number((v * 10).toFixed(4));
  }
  const shelf = product.packShelfPrice ?? product.price;
  const kg = product.packWeightKg;
  if (shelf != null && kg != null && kg > 0) {
    return Number((shelf / kg).toFixed(4));
  }
  return null;
}

/**
 * Compare unit/pack prices across two or more products (Coles / Woolworths).
 * @param {object[]} products
 * @returns {{ saving: number, cheaperStore: string|null, compareBasis?: string }}
 */
function compareStoresForCheaper(products) {
  const list = (products || []).filter(Boolean);
  if (list.length < 2) {
    return { saving: 0, cheaperStore: 'tie', compareBasis: 'pack_price' };
  }

  const kgRows = list
    .map((product) => ({
      store: product.supermarket,
      kg: extractUnitPricePerKg(product),
      product,
    }))
    .filter((row) => row.kg != null && row.kg > 0);

  if (kgRows.length >= 2) {
    const minRow = kgRows.reduce((a, b) => (a.kg <= b.kg ? a : b));
    const maxRow = kgRows.reduce((a, b) => (a.kg >= b.kg ? a : b));
    const priceDiff = maxRow.kg - minRow.kg;
    if (priceDiff <= PRICE_EPSILON) {
      return { saving: 0, cheaperStore: 'tie', compareBasis: 'per_kg' };
    }
    const refKg = Math.min(
      minRow.product.packWeightKg > 0 ? minRow.product.packWeightKg : 1,
      maxRow.product.packWeightKg > 0 ? maxRow.product.packWeightKg : 1
    );
    return {
      saving: roundMoney(priceDiff * refKg),
      cheaperStore: minRow.store,
      compareBasis: 'per_kg',
    };
  }

  const packRows = list
    .map((product) => ({
      store: product.supermarket,
      pack: Number(product.packShelfPrice ?? product.price ?? 0),
    }))
    .filter((row) => row.pack > 0);

  if (packRows.length < 2) {
    return { saving: 0, cheaperStore: 'tie', compareBasis: 'pack_price' };
  }

  packRows.sort((a, b) => a.pack - b.pack);
  const packDiff = packRows[packRows.length - 1].pack - packRows[0].pack;
  if (packDiff <= PRICE_EPSILON) {
    return { saving: 0, cheaperStore: 'tie', compareBasis: 'pack_price' };
  }

  return {
    saving: roundMoney(packDiff),
    cheaperStore: packRows[0].store,
    compareBasis: 'pack_price',
  };
}

/** Woolworths vs Coles pair (similar-product rows). */
function compareProductsForCheaper(woolProduct, colesProduct) {
  return compareStoresForCheaper([woolProduct, colesProduct].filter(Boolean));
}

/**
 * Item-level saving badge; uses $/kg when both products provide it.
 */
function calcDualStoreSaving(colesProduct, woolProduct) {
  if (colesProduct && woolProduct) {
    return compareProductsForCheaper(woolProduct, colesProduct);
  }
  const coles = Number(colesProduct);
  const wool = Number(woolProduct);
  if (!Number.isFinite(coles) || !Number.isFinite(wool) || coles <= 0 || wool <= 0) {
    return { saving: 0, cheaperStore: null };
  }
  const saving = roundMoney(Math.abs(coles - wool));
  if (saving <= 0) return { saving: 0, cheaperStore: 'tie' };
  const cheaperStore = wool < coles ? 'Woolworths' : 'Coles';
  return { saving, cheaperStore };
}

/**
 * Green badge beside the cheaper side (hidden when unit prices are equal).
 */
function buildItemSavingBadge(colesProduct, woolProduct, storeForThisSide) {
  const { saving, cheaperStore } = calcDualStoreSaving(colesProduct, woolProduct);
  if (!cheaperStore || cheaperStore === 'tie' || saving <= 0) return '';
  if (cheaperStore !== storeForThisSide) return '';
  return `<span class="item-saving-badge">Save $${saving.toFixed(2)} by choosing ${cheaperStore}</span>`;
}

/** Price block plus savings badge (Similar products). */
function buildPriceBlockWithSaving(item, colesProduct, woolProduct) {
  const badge = buildItemSavingBadge(colesProduct, woolProduct, item.supermarket);
  return `${buildPriceBlock(item)}${badge}`;
}

// --- Official store search URLs (image + product name links) ---

const COLES_SEARCH_BASE = 'https://www.coles.com.au/search?q=';
/** URL tìm kiếm công khai chuẩn Woolworths AU — phải có /products (không dùng /shop/search?). */
const WOOLWORTHS_SEARCH_BASE = 'https://www.woolworths.com.au/shop/search/products?searchTerm=';

/**
 * Search term for store websites: barcode first, then product name, then cart line keyword.
 */
function getStoreSearchQuery(product, fallbackKeyword = '') {
  const barcode = String(product?.barcode || '').replace(/\D/g, '');
  if (barcode.length >= 8) return barcode;
  const name = String(product?.name || '').trim();
  if (name) return name;
  return String(fallbackKeyword || '').trim();
}

function buildColesSearchUrl(query) {
  return `${COLES_SEARCH_BASE}${encodeURIComponent(query)}`;
}

function buildWoolworthsSearchUrl(query) {
  return `${WOOLWORTHS_SEARCH_BASE}${encodeURIComponent(query)}`;
}

/** Resolve href for image/name links: ưu tiên url sản phẩm từ API, fallback search chính thức. */
function resolveStoreSearchUrl(item, fallbackKeyword = '') {
  const direct = String(item?.url || '').trim();
  if (/^https?:\/\//i.test(direct)) {
    return direct;
  }

  const store = item?.supermarket;
  const query = getStoreSearchQuery(item, fallbackKeyword);
  if (query && store === 'Coles') return buildColesSearchUrl(query);
  if (query && store === 'Woolworths') return buildWoolworthsSearchUrl(query);
  return '';
}

/**
 * Per-line cart saving = Coles vs Woolworths price gap when both prices exist.
 */
function calcLineSavingForCartEntry(entry) {
  const products = [];
  if (compareStoreVisibility.woolworths !== false && entry.woolworthsPrice != null) {
    products.push({
      supermarket: 'Woolworths',
      price: entry.woolworthsPrice,
      packShelfPrice: entry.woolworthsPrice,
      packWeightKg: entry.woolworthsPackKg,
      pricePerKg: entry.woolworthsPricePerKg,
      unit_price_text: entry.woolworthsUnitText,
    });
  }
  if (compareStoreVisibility.coles !== false && entry.colesPrice != null) {
    products.push({
      supermarket: 'Coles',
      price: entry.colesPrice,
      packShelfPrice: entry.colesPrice,
      packWeightKg: entry.colesPackKg,
      pricePerKg: entry.colesPricePerKg,
      unit_price_text: entry.colesUnitText,
    });
  }
  if (products.length >= 2) {
    const cmp = compareStoresForCheaper(products);
    return cmp.saving;
  }
  return 0;
}

/**
 * Cộng dồn tiết kiệm toàn giỏ = tổng tiết kiệm từng món đã Add to cart.
 */
function calcCartCumulativeSaving(cart) {
  let saving = 0;
  let referenceTotal = 0;

  for (const entry of cart) {
    const lineSaving =
      entry.lineSaving != null ? Number(entry.lineSaving) : calcLineSavingForCartEntry(entry);
    saving += lineSaving;

    const coles = entry.colesPrice;
    const wool = entry.woolworthsPrice;
    if (coles != null && wool != null) {
      referenceTotal += Math.max(coles, wool);
    } else {
      referenceTotal += coles ?? wool ?? 0;
    }
  }

  return {
    saving: roundMoney(saving),
    referenceTotal: roundMoney(referenceTotal),
  };
}

/**
 * Cập nhật totalSaved và banner trong panel giỏ hàng (chỉ hiện ở cart).
 */
function updateCartSavingsDisplay() {
  const cart = loadCart();
  const { saving, referenceTotal } = calcCartCumulativeSaving(cart);
  totalSaved = saving;
  renderTripSavingsBanner(
    document.getElementById('cart-trip-savings'),
    totalSaved,
    referenceTotal
  );
}

/** Render banner "You've saved" trong giỏ hàng */
function renderTripSavingsBanner(el, amount, referenceTotal = 0) {
  if (!el) return;

  const saved = roundMoney(amount);

  if (saved <= 0) {
    el.classList.add('hidden');
    el.innerHTML = '';
    el.classList.remove('trip-savings-banner--celebrate');
    return;
  }

  const pct = referenceTotal > 0 ? (saved / referenceTotal) * 100 : 0;
  const celebrate = pct > 30;
  const icon = celebrate ? '🎉🥳' : '🥳';

  el.innerHTML = `
    <span class="trip-savings-icon">${icon}</span>
    <span class="trip-savings-text">You've saved <strong>$${saved.toFixed(2)}</strong> on this shopping trip!</span>
  `;
  el.classList.remove('hidden');
  el.classList.toggle('trip-savings-banner--celebrate', celebrate);
  el.classList.add('trip-savings-banner--pop');
  window.setTimeout(() => el.classList.remove('trip-savings-banner--pop'), 600);
}

// --- Search history (localStorage: shoppingsmart_history) ---

/** Load history array from localStorage */
function loadSearchHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && String(entry.query || '').trim())
      .map((entry) => ({
        query: String(entry.query).trim(),
        type: entry.type === 'ai' ? 'ai' : 'search',
        at: entry.at || null,
      }));
  } catch {
    return [];
  }
}

/** Save history array to localStorage */
function saveSearchHistory(list) {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
}

/**
 * Prepend new entry (max 5); duplicates move to top (case-insensitive).
 * @param {string} query - Keyword or AI shopping list text
 * @param {'search'|'ai'} type - Single search or AI list analysis
 */
function addToSearchHistory(query, type = 'search') {
  const text = String(query || '').trim();
  if (!text) return;

  const normalized = text.toLowerCase();
  let list = loadSearchHistory().filter(
    (entry) => entry.query.toLowerCase() !== normalized
  );

  list.unshift({
    query: text,
    type: type === 'ai' ? 'ai' : 'search',
    at: new Date().toISOString(),
  });

  if (list.length > HISTORY_MAX_ITEMS) {
    list = list.slice(0, HISTORY_MAX_ITEMS);
  }

  saveSearchHistory(list);
  renderRecentSearches();
}

/** Clear all history */
function clearSearchHistory() {
  saveSearchHistory([]);
  renderRecentSearches();
}

/** Truncate label shown on history tag */
function truncateHistoryLabel(text, maxLen = 42) {
  const s = String(text).trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

/** Render Recent searches below the search bar */
function renderRecentSearches() {
  const section = document.getElementById('recent-searches-section');
  const tagsEl = document.getElementById('recent-searches-tags');
  if (!section || !tagsEl) return;

  const list = loadSearchHistory();

  if (!list.length) {
    section.classList.add('hidden');
    tagsEl.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');
  tagsEl.innerHTML = '';

  list.forEach((entry) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `history-tag${entry.type === 'ai' ? ' history-tag-ai' : ''}`;
    btn.title = entry.query;
    btn.setAttribute('data-query', entry.query);
    btn.setAttribute('data-type', entry.type);

    const label =
      entry.type === 'ai'
        ? `✨ ${truncateHistoryLabel(entry.query)}`
        : truncateHistoryLabel(entry.query);

    btn.textContent = label;
    btn.addEventListener('click', () => runHistoryEntry(entry));
    tagsEl.appendChild(btn);
  });
}

/**
 * History tag click: fill input and run search or Analyze List by AI.
 */
function runHistoryEntry(entry) {
  if (!entry?.query) return;

  document.querySelector('.main-tab[data-tab="compare"]')?.click();

  if (entry.type === 'ai') {
    const textarea = document.getElementById('aiListInput');
    if (textarea) textarea.value = entry.query;
    analyzeShoppingList();
    return;
  }

  const input = document.getElementById('itemInput');
  if (input) input.value = entry.query;
  searchProducts();
}

// --- Dark mode (localStorage) ---

/** Apply light/dark theme on the html element */
function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

/** Show a results section with a light slide-in animation */
function showRevealSection(sectionEl) {
  if (!sectionEl) return;
  sectionEl.classList.remove('hidden');
  sectionEl.classList.remove('reveal-animate');
  void sectionEl.offsetWidth;
  sectionEl.classList.add('reveal-animate');
}

function hideRevealSection(sectionEl) {
  if (!sectionEl) return;
  sectionEl.classList.add('hidden');
  sectionEl.classList.remove('reveal-animate');
}

/**
 * Quantity label for AI list lines — avoids "(1 undefined)" when unit is missing.
 */
function formatRequestLabel(request) {
  if (!request) return '';

  const keyword = String(request.keyword || '').trim();
  const qty = Number(request.quantity);
  const unit = String(request.unit || '').trim().toLowerCase();

  if (!keyword) return '';
  if (!Number.isFinite(qty) || qty <= 0) return keyword;

  const weightUnits = { kg: 'kg', g: 'g', l: 'L', ml: 'ml' };
  if (weightUnits[unit]) {
    return `${keyword} (${qty} ${weightUnits[unit]})`;
  }

  const packUnits = ['pack', 'pk', 'bunch', 'dozen', 'loaf', 'bottle', 'can'];
  if (packUnits.includes(unit)) {
    return `${keyword} (${qty} ${unit})`;
  }

  if (!unit || unit === 'each' || unit === 'ea') {
    return qty === 1 ? keyword : `${keyword} (×${qty})`;
  }

  return `${keyword} (${qty})`;
}

/** Similar product pairs from latest search — used by Add to list */
let lastSimilarPairs = [];

// --- Price watchlist (localStorage: shoppingsmart_watchlist) ---

/** Stable product id for watchlist entries */
function getWatchlistProductId(item) {
  if (item.productId) return String(item.productId);
  const store = item.supermarket || 'unknown';
  const key = (item.url || item.name || '').toLowerCase().trim();
  return `${store}::${key}`;
}

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWatchlist(list) {
  localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(list));
}

function isInWatchlist(productId) {
  return loadWatchlist().some((entry) => entry.id === productId);
}

/** Toggle watch: save price at bell click time */
function toggleWatchlist(item) {
  const id = getWatchlistProductId(item);
  let list = loadWatchlist();
  const existing = list.findIndex((entry) => entry.id === id);

  if (existing >= 0) {
    list = list.filter((entry) => entry.id !== id);
  } else {
    list.push({
      id,
      productId: item.productId || null,
      name: item.name,
      image: item.image || '',
      supermarket: item.supermarket,
      url: item.url || '',
      searchKeyword: item.searchKeyword || item.name.split(/\s+/).slice(0, 4).join(' '),
      watchedAtPrice: item.price,
      watchedAt: new Date().toISOString(),
    });
  }

  saveWatchlist(list);
  updateWatchlistTabBadge();
  syncWatchlistBellButtons();
  return existing < 0;
}

/** Bell button HTML next to product name */
function buildWatchlistBellButton(item) {
  const id = getWatchlistProductId(item);
  const watching = isInWatchlist(id);
  return `
    <button
      type="button"
      class="watchlist-btn${watching ? ' is-watching' : ''}"
      data-watch-id="${escapeHtml(id)}"
      title="${watching ? 'Stop watching price' : 'Watch for price drops'}"
      aria-label="${watching ? 'Stop watching' : 'Watch price'}"
      aria-pressed="${watching ? 'true' : 'false'}"
    >🔔</button>
  `;
}

/** Title row: product name + bell */
function buildProductTitleRow(item) {
  return `
    <div class="product-title-row">
      <div class="product-name-wrap">${buildProductNameLink(item)}</div>
      ${buildWatchlistBellButton(item)}
    </div>
  `;
}

/** Attach click handlers to bell buttons in a DOM subtree */
function bindWatchlistButtons(root, itemResolver) {
  if (!root) return;

  root.querySelectorAll('.watchlist-btn').forEach((btn) => {
    const fresh = btn.cloneNode(true);
    btn.replaceWith(fresh);
    fresh.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const watchId = fresh.getAttribute('data-watch-id');
      const item = itemResolver(watchId, fresh);
      if (!item) return;
      toggleWatchlist(item);
    });
  });
}

/** Sync active state for all bell buttons on the page */
function syncWatchlistBellButtons() {
  document.querySelectorAll('.watchlist-btn').forEach((btn) => {
    const id = btn.getAttribute('data-watch-id');
    const watching = isInWatchlist(id);
    btn.classList.toggle('is-watching', watching);
    btn.setAttribute('aria-pressed', watching ? 'true' : 'false');
    btn.title = watching ? 'Stop watching price' : 'Watch for price drops';
  });
}

function updateWatchlistTabBadge() {
  const badge = document.getElementById('watchlist-tab-badge');
  if (!badge) return;
  const count = loadWatchlist().length;
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

// --- Cart (localStorage) ---

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
}

function addToCart(item) {
  const pair = findPairForItem(item);
  const cart = loadCart();

  const cartItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: item.name,
    woolworthsPrice:
      pair?.woolworths?.price ??
      (item.supermarket === 'Woolworths' ? item.price : null),
    colesPrice:
      pair?.coles?.price ?? (item.supermarket === 'Coles' ? item.price : null),
    woolworthsPackKg: pair?.woolworths?.packWeightKg ?? (item.supermarket === 'Woolworths' ? item.packWeightKg : null),
    colesPackKg: pair?.coles?.packWeightKg ?? (item.supermarket === 'Coles' ? item.packWeightKg : null),
    woolworthsPricePerKg: pair?.woolworths?.pricePerKg ?? (item.supermarket === 'Woolworths' ? item.pricePerKg : null),
    colesPricePerKg: pair?.coles?.pricePerKg ?? (item.supermarket === 'Coles' ? item.pricePerKg : null),
    woolworthsUnitText: pair?.woolworths?.unit_price_text ?? (item.supermarket === 'Woolworths' ? item.unit_price_text : null),
    colesUnitText: pair?.coles?.unit_price_text ?? (item.supermarket === 'Coles' ? item.unit_price_text : null),
    woolworthsUrl: pair?.woolworths?.url || (item.supermarket === 'Woolworths' ? item.url : ''),
    colesUrl: pair?.coles?.url || (item.supermarket === 'Coles' ? item.url : ''),
    lineSaving: 0,
  };

  cartItem.lineSaving = calcLineSavingForCartEntry(cartItem);

  cart.push(cartItem);
  saveCart(cart);
  renderCartPanel();
}

function findPairForItem(item) {
  for (const pair of lastSimilarPairs) {
    if (item.supermarket === 'Woolworths' && pair.woolworths?.name === item.name) {
      return pair;
    }
    if (item.supermarket === 'Coles' && pair.coles?.name === item.name) {
      return pair;
    }
  }
  return null;
}

function removeFromCart(id) {
  const cart = loadCart().filter((item) => item.id !== id);
  saveCart(cart);
  renderCartPanel();
}

function clearCart() {
  saveCart([]);
  totalSaved = 0;
  renderCartPanel();
}

function renderCartPanel() {
  const panel = document.getElementById('cart-panel');
  const itemsEl = document.getElementById('cart-items');
  const totalsEl = document.getElementById('cart-totals');
  const savingsEl = document.getElementById('cart-savings');
  if (!panel || !itemsEl) return;

  const cart = loadCart();

  if (!cart.length) {
    panel.classList.add('hidden');
    totalSaved = 0;
    renderTripSavingsBanner(document.getElementById('cart-trip-savings'), 0, 0);
    return;
  }

  panel.classList.remove('hidden');

  let colesTotal = 0;
  let woolworthsTotal = 0;
  let colesCount = 0;
  let woolworthsCount = 0;

  itemsEl.innerHTML = '';
  cart.forEach((entry) => {
    if (entry.colesPrice != null) {
      colesTotal += entry.colesPrice;
      colesCount += 1;
    }
    if (entry.woolworthsPrice != null) {
      woolworthsTotal += entry.woolworthsPrice;
      woolworthsCount += 1;
    }

    const row = document.createElement('div');
    row.className = 'cart-item';
    row.innerHTML = `
      <p class="cart-item-name">${escapeHtml(entry.name)}</p>
      <p class="cart-item-prices">
        ${entry.woolworthsPrice != null ? `<span class="ww">WW $${entry.woolworthsPrice.toFixed(2)}</span>` : ''}
        ${entry.colesPrice != null ? `<span class="coles">Coles $${entry.colesPrice.toFixed(2)}</span>` : ''}
      </p>
      <button type="button" class="cart-remove" data-id="${escapeHtml(entry.id)}">Remove</button>
    `;
    row.querySelector('.cart-remove').addEventListener('click', () => {
      removeFromCart(entry.id);
    });
    itemsEl.appendChild(row);
  });

  totalsEl.innerHTML = `
    <p><strong>Woolworths total:</strong> $${woolworthsTotal.toFixed(2)} (${woolworthsCount} items)</p>
    <p><strong>Coles total:</strong> $${colesTotal.toFixed(2)} (${colesCount} items)</p>
  `;

  updateCartSavingsDisplay();

  if (colesCount > 0 && woolworthsCount > 0) {
    const diff = Math.abs(colesTotal - woolworthsTotal);
    const cheaperStore = woolworthsTotal < colesTotal ? 'Woolworths' : colesTotal < woolworthsTotal ? 'Coles' : null;
    if (cheaperStore && diff > 0) {
      savingsEl.innerHTML = `If you buy this cart at <strong>${cheaperStore}</strong>, you save <strong>$${diff.toFixed(2)}</strong>!`;
    } else {
      savingsEl.textContent = 'Both store totals are the same for your cart.';
    }
  } else {
    savingsEl.textContent = 'Add items with both store prices to see full cart savings.';
  }
}

// --- AI results accordion (collapse on search; content is kept) ---

const AI_RESULTS_SECTION_ID = 'ai-results-section';

/** True after a successful AI analyze render */
let aiAnalyzeHasContent = false;

function getAiAccordionEls() {
  return {
    section: document.getElementById(AI_RESULTS_SECTION_ID),
    collapseBar: document.getElementById('ai-results-collapse-bar'),
    expandBar: document.getElementById('ai-results-expand-bar'),
    body: document.getElementById('ai-results-body'),
  };
}

/** Collapse to a thin bar; keeps HTML inside for later */
function collapseAiAnalyzeAccordion() {
  if (!aiAnalyzeHasContent) return;

  const { section, collapseBar, expandBar, body } = getAiAccordionEls();
  if (!section || !expandBar || !body) return;

  section.classList.remove('hidden');
  section.classList.add('ai-collapsed');
  collapseBar?.classList.add('hidden');
  collapseBar?.setAttribute('aria-expanded', 'false');
  expandBar.classList.remove('hidden');
  expandBar.setAttribute('aria-expanded', 'false');
  body.setAttribute('aria-hidden', 'true');
}

/** Expand full AI results panel */
function expandAiAnalyzeAccordion() {
  const { section, collapseBar, expandBar, body } = getAiAccordionEls();
  if (!section) return;

  section.classList.remove('hidden', 'ai-collapsed');
  expandBar?.classList.add('hidden');
  expandBar?.setAttribute('aria-expanded', 'true');
  if (aiAnalyzeHasContent) {
    collapseBar?.classList.remove('hidden');
    collapseBar?.setAttribute('aria-expanded', 'true');
  }
  body?.setAttribute('aria-hidden', 'false');
}

function showAiAnalyzeResults() {
  expandAiAnalyzeAccordion();
}

// --- Search ---

/** Toggle hero logo visibility (hidden after results load). */
function setSearchResultsVisible(hasResults) {
  document.getElementById('search-section')?.classList.toggle('search-section--has-results', Boolean(hasResults));
}

/** Reset compare UI — clear input, hide results, restore idle home layout. */
function resetCompareView() {
  const itemInput = document.getElementById('itemInput');
  if (itemInput) {
    itemInput.value = '';
    restartRotatingComparePlaceholder();
  }

  removeBarcodeScanBanner();
  setSearchResultsVisible(false);

  const alignedSection = document.getElementById('aligned-compare-section');
  const summarySection = document.getElementById('summary-section');
  const alignedRowsEl = document.getElementById('aligned-compare-rows');
  const browseGrid = document.querySelector('.comparison-grid--browse');
  const wooliesCont = document.getElementById('woolworths-results');
  const colesCont = document.getElementById('coles-results');

  if (alignedRowsEl) alignedRowsEl.innerHTML = '';
  hideRevealSection(alignedSection);
  hideRevealSection(summarySection);
  hideCompareStoreFilterToolbar();
  if (browseGrid) browseGrid.classList.add('hidden');
  if (wooliesCont) wooliesCont.innerHTML = '<p class="status-text">Enter an item to see prices...</p>';
  if (colesCont) colesCont.innerHTML = '<p class="status-text">Enter an item to see prices...</p>';

  compareStoreVisibility.woolworths = true;
  compareStoreVisibility.coles = true;
  lastSimilarPairs = [];
}

function handleBrandHomeClick(event) {
  event.preventDefault();
  resetCompareView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.location.pathname !== '/') {
    window.location.href = '/';
  }
}

async function searchProducts() {
  const keyword = document.getElementById('itemInput').value.trim();
  if (!keyword) {
    return alert('Enter a product name (e.g. milk, rice 1kg).');
  }
  await ensureLocationConsent();
  await runCompareSearch({ keyword });
}

/** Called after a successful barcode scan (from barcode-scanner.js) */
async function searchByBarcode(barcode) {
  const digits = String(barcode).replace(/\D/g, '');
  if (digits.length < 8) {
    return alert('Invalid barcode. Try scanning again.');
  }

  document.querySelector('.main-tab[data-tab="compare"]')?.click();
  document.getElementById('itemInput').value = digits;
  await ensureLocationConsent();
  await runCompareSearch({ barcode: digits });
}

window.searchByBarcode = searchByBarcode;

/**
 * Unified search by product name or barcode.
 * Shows results; scrolls to matched pairs when scanning barcode.
 */
async function runCompareSearch({ keyword, barcode }) {
  // Single search / barcode → collapse AI panel (content preserved)
  collapseAiAnalyzeAccordion();

  const wooliesCont = document.getElementById('woolworths-results');
  const colesCont = document.getElementById('coles-results');
  const alignedSection = document.getElementById('aligned-compare-section');
  const alignedRowsEl = document.getElementById('aligned-compare-rows');
  const summarySection = document.getElementById('summary-section');
  const summaryText = document.getElementById('summary-text');
  const searchBtn = document.getElementById('searchBtn');

  const url = barcode
    ? buildApiUrl(`/api/compare/barcode?barcode=${encodeURIComponent(barcode)}`)
    : buildApiUrl(`/api/compare?keyword=${encodeURIComponent(keyword)}`);

  searchBtn.disabled = true;
  if (alignedRowsEl) alignedRowsEl.innerHTML = '<p class="loading">Loading...</p>';
  if (alignedSection) showRevealSection(alignedSection);
  if (wooliesCont) wooliesCont.innerHTML = '<p class="loading">Loading...</p>';
  if (colesCont) colesCont.innerHTML = '<p class="loading">Loading...</p>';
  hideRevealSection(summarySection);
  removeBarcodeScanBanner();

  try {
    const response = await apiFetchCompare(url);
    const data = await response.json();

    if (!response.ok && !data?.alignedRows?.length) {
      throw new Error(data.error || 'Could not load data.');
    }

    displayCompareResults(data, { fromBarcode: Boolean(barcode) });

    const hasResults =
      (Array.isArray(data?.alignedRows) && data.alignedRows.length > 0) ||
      (Array.isArray(data?.items) && data.items.length > 0);
    setSearchResultsVisible(hasResults);

    if (keyword && !barcode) {
      addToSearchHistory(keyword, 'search');
    }
  } catch (err) {
    let message = err.message || 'Could not load results.';
    if (err.name === 'AbortError') {
      message =
        'Search timed out or was cancelled. Check your internet, then try again. Cached results may load faster on repeat searches.';
    }
    if (alignedRowsEl) {
      alignedRowsEl.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
    }
    if (wooliesCont) wooliesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
    if (colesCont) colesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
    setSearchResultsVisible(false);
  } finally {
    searchBtn.disabled = false;
  }
}

/** Render comparison results on screen */
function displayCompareResults(data, options = {}) {
  const alignedSection = document.getElementById('aligned-compare-section');
  const alignedRowsEl = document.getElementById('aligned-compare-rows');
  const summarySection = document.getElementById('summary-section');
  const summaryText = document.getElementById('summary-text');
  const browseGrid = document.querySelector('.comparison-grid--browse');

  const items = Array.isArray(data) ? data : data.items || [];
  const alignedRows = Array.isArray(data?.alignedRows) ? data.alignedRows : [];
  lastSimilarPairs = [];

  if (options.fromBarcode && data.scannedBarcode) {
    showBarcodeScanBanner(data.scannedBarcode);
  }

  if (alignedRows.length) {
    compareStoreVisibility.woolworths = true;
    compareStoreVisibility.coles = true;

    const keywordBlocks = normalizeAlignedKeywordBlocks(alignedRows);
    initCompareStoreFilterToolbar();
    renderAlignedCompareRows(alignedRowsEl, alignedSection, keywordBlocks, data);
    showCompareStoreFilterToolbar();
    applyCompareStoreColumnVisibility();
    if (data.error) {
      summaryText.innerHTML = escapeHtml(data.error);
      showRevealSection(summarySection);
    } else {
      renderSummaryFromAlignedKeywordBlocks(summaryText, summarySection, keywordBlocks, data);
    }
    if (browseGrid) browseGrid.classList.add('hidden');
  } else {
    const wooliesCont = document.getElementById('woolworths-results');
    const colesCont = document.getElementById('coles-results');
    const woolworths = items.filter((item) => item.supermarket === 'Woolworths');
    const coles = items.filter((item) => item.supermarket === 'Coles');

    renderSummary(summaryText, summarySection, woolworths, coles, data);
    renderStoreResults(wooliesCont, woolworths, 'Woolworths', data.storeErrors?.woolworths);
    renderStoreResults(colesCont, coles, 'Coles', data.storeErrors?.coles);
    hideRevealSection(alignedSection);
    hideCompareStoreFilterToolbar();
    if (browseGrid) browseGrid.classList.remove('hidden');
  }
}

/**
 * Chuẩn hóa payload API: khối theo từ khóa + matrixRows (tương thích bản cũ 1 hàng).
 */
function normalizeAlignedKeywordBlocks(alignedRows) {
  return (alignedRows || []).map((block) => {
    if (Array.isArray(block.matrixRows) && block.matrixRows.length) {
      return block;
    }
    return {
      keyword: block.keyword,
      matrixRows: [
        {
          rowIndex: 0,
          woolworths: block.woolworths || null,
          coles: block.coles || null,
        },
      ],
      storeCounts: block.storeCounts || {
        woolworths: block.woolworths ? 1 : 0,
        coles: block.coles ? 1 : 0,
      },
    };
  });
}

/** Trạng thái bật/tắt cột siêu thị trên bảng Compare (mặc định cả 2 bật). */
const compareStoreVisibility = {
  woolworths: true,
  coles: true,
};

function isCompareStoreVisible(storeKey) {
  return compareStoreVisibility[storeKey] !== false;
}

/** Khởi tạo thanh lọc siêu thị (gọi một lần). */
function initCompareStoreFilterToolbar() {
  const toolbar = document.getElementById('store-filter-toolbar');
  if (!toolbar || toolbar.dataset.bound === '1') return;
  toolbar.dataset.bound = '1';

  toolbar.querySelectorAll('.store-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const storeKey = btn.dataset.store;
      if (!storeKey) return;

      const activeCount = Object.values(compareStoreVisibility).filter(Boolean).length;
      const isActive = btn.classList.contains('is-active');
      if (isActive && activeCount <= 1) return;

      compareStoreVisibility[storeKey] = !isActive;
      btn.classList.toggle('is-active', !isActive);
      btn.setAttribute('aria-pressed', !isActive ? 'true' : 'false');
      applyCompareStoreColumnVisibility();
    });
  });
}

function showCompareStoreFilterToolbar() {
  const toolbar = document.getElementById('store-filter-toolbar');
  if (!toolbar) return;
  toolbar.classList.remove('hidden');
  toolbar.querySelectorAll('.store-filter-btn').forEach((btn) => {
    const key = btn.dataset.store;
    const on = isCompareStoreVisible(key);
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function hideCompareStoreFilterToolbar() {
  document.getElementById('store-filter-toolbar')?.classList.add('hidden');
}

/**
 * Ẩn/hiện cột + co giãn grid + tính lại Lowest Price chỉ trên siêu thị đang bật.
 */
function applyCompareStoreColumnVisibility() {
  const container = document.getElementById('aligned-compare-rows');
  if (!container) return;

  const visibleCount = ['woolworths', 'coles'].filter((k) =>
    isCompareStoreVisible(k)
  ).length;

  container.classList.remove('cols-1', 'cols-2', 'cols-3');
  container.classList.add(`cols-${Math.max(visibleCount, 1)}`);

  container.querySelectorAll('.aligned-store-cell[data-store]').forEach((cell) => {
    const key = cell.dataset.store;
    cell.classList.toggle('store-col-hidden', !isCompareStoreVisible(key));
  });

  container.querySelectorAll('.aligned-compare-row').forEach((rowEl) => {
    refreshMatrixRowPriceBadges(rowEl);
  });

  const summaryText = document.getElementById('summary-text');
  const summarySection = document.getElementById('summary-section');
  if (summaryText && container._keywordBlocks) {
    renderSummaryFromAlignedKeywordBlocks(
      summaryText,
      summarySection,
      container._keywordBlocks,
      container._alignedCompareData || {}
    );
  }
}

/** Sản phẩm trên hàng — chỉ các siêu thị đang bật và có giá. */
function getMatrixRowPeers(matrixRow, visibility = compareStoreVisibility) {
  if (!matrixRow) return [];
  const slots = [
    { key: 'woolworths', product: matrixRow.woolworths },
    { key: 'coles', product: matrixRow.coles },
  ];
  return slots
    .filter(({ key, product }) => visibility[key] !== false && product && Number(product.price) > 0)
    .map(({ product }) => product);
}

/**
 * Tóm tắt theo hàng Top 1 của mỗi từ khóa (hàng đầu ma trận).
 */
function renderSummaryFromAlignedKeywordBlocks(el, section, keywordBlocks, data = {}) {
  if (!keywordBlocks.length) {
    hideRevealSection(section);
    return;
  }

  let text = '';
  if (data.searchMode === 'barcode') {
    text += '📷 Got a barcode hit! ';
  }

  keywordBlocks.forEach((block) => {
    const topRow = block.matrixRows?.[0];
    if (!topRow) {
      text += `<strong>${escapeHtml(block.keyword)}</strong>: no match at any store. `;
      return;
    }
    const peers = getMatrixRowPeers(topRow, compareStoreVisibility);
    if (!peers.length) {
      const err = data.storeErrors || {};
      const visibleStores = ['woolworths', 'coles'].filter((k) =>
        isCompareStoreVisible(k)
      );
      const storeLabel = { woolworths: 'Woolworths', coles: 'Coles' };
      const apiDown = visibleStores.filter((k) => err[k] && /timed out|unable to load/i.test(err[k]));
      if (apiDown.length >= 2) {
        text += `<strong>${escapeHtml(block.keyword)}</strong>: could not reach ${apiDown.length} store(s) — check network, MongoDB, and API keys. `;
      } else if (apiDown.length === 1) {
        text += `<strong>${escapeHtml(block.keyword)}</strong>: ${storeLabel[apiDown[0]] || apiDown[0]} unreachable. `;
      } else {
        text += `<strong>${escapeHtml(block.keyword)}</strong>: no match at any store on this row. `;
      }
      return;
    }
    if (peers.length === 1) {
      const only = peers[0];
      text += `<strong>${escapeHtml(block.keyword)}</strong>: only at ${only.supermarket} (<strong>$${only.price.toFixed(2)}</strong>). `;
      return;
    }
    const cmp = compareStoresForCheaper(peers);
    const minPack = Math.min(...peers.map((p) => p.price));
    if (cmp.cheaperStore === 'tie' || !cmp.cheaperStore) {
      text += `<strong>${escapeHtml(block.keyword)}</strong>: same lowest price on top row (from <strong>$${minPack.toFixed(2)}</strong>). `;
    } else {
      text += `<strong>${escapeHtml(block.keyword)}</strong>: ${cmp.cheaperStore} from <strong>$${minPack.toFixed(2)}</strong>`;
      if (cmp.saving > 0) {
        text += ` — save <strong>$${cmp.saving.toFixed(2)}</strong> on the top row`;
      }
      text += '. ';
    }
  });

  el.innerHTML = text;
  showRevealSection(section);
}

/** Giá rẻ nhất trong hàng — chỉ tính trên các siêu thị có hàng. */
function isRowCheapestProduct(product, rowPeers) {
  const available = (rowPeers || []).filter((p) => p && Number(p.price) > 0);
  if (!product || !available.length) return false;
  const minPrice = Math.min(...available.map((p) => p.price));
  return Math.abs(product.price - minPrice) <= PRICE_EPSILON;
}

/** Badge tiết kiệm khi so 2+ siêu thị trên cùng một hàng. */
function buildRowMultiStoreSavingBadge(rowPeers, storeForThisSide) {
  const peers = (rowPeers || []).filter((p) => p && Number(p.price) > 0);
  if (peers.length < 2) return '';
  const { saving, cheaperStore } = compareStoresForCheaper(peers);
  if (!cheaperStore || cheaperStore === 'tie' || saving <= 0) return '';
  if (cheaperStore !== storeForThisSide) return '';
  return `<span class="item-saving-badge">Save $${saving.toFixed(2)} by choosing ${escapeHtml(cheaperStore)}</span>`;
}

const ALIGNED_STORE_META = [
  { key: 'woolworths', name: 'Woolworths', labelClass: 'woolies' },
  { key: 'coles', name: 'Coles', labelClass: 'coles' },
];

const ALIGNED_STORE_ERROR_KEY = {
  woolworths: 'woolworths',
  coles: 'coles',
};

/**
 * Banner khi một số siêu thị timeout nhưng siêu thị khác vẫn có hàng.
 */
function renderPartialCompareBanner(container, data) {
  const err = data?.storeErrors || {};
  const labels = { woolworths: 'Woolworths', coles: 'Coles' };
  const failed = Object.keys(labels).filter(
    (k) => err[k] && /timed out|unable to load|temporarily unavailable/i.test(err[k])
  );
  if (!failed.length) return;

  const hasProducts = (data.items || []).length > 0;
  const hasMatrixProducts = (data.alignedRows || []).some((block) =>
    block.matrixRows?.some((row) => row.woolworths || row.coles)
  );
  if (!hasProducts && !hasMatrixProducts) return;

  const banner = document.createElement('p');
  banner.className = 'compare-partial-banner';
  banner.textContent = `Partial results: ${failed.map((k) => labels[k]).join(' and ')} could not be reached. Showing matches from other stores only.`;
  container.appendChild(banner);
}

/**
 * Ma trận nhiều hàng ngang: mỗi từ khóa → N hàng (Top 1, Top 2, …) × 2 cột siêu thị.
 */
function renderAlignedCompareRows(container, section, keywordBlocks, data = {}) {
  if (!container) return;

  if (!keywordBlocks?.length) {
    container.innerHTML = '<p class="error">No results to display.</p>';
    hideRevealSection(section);
    return;
  }

  container.innerHTML = '';
  container._keywordBlocks = keywordBlocks;
  container._alignedCompareData = data;
  showRevealSection(section);

  renderPartialCompareBanner(container, data);

  let globalRowIndex = 0;

  keywordBlocks.forEach((block) => {
    const matrixRows = block.matrixRows || [];
    if (!matrixRows.length) return;

    const group = document.createElement('div');
    group.className = 'aligned-keyword-group';

    const heading = document.createElement('h3');
    heading.className = 'aligned-keyword-heading';
    heading.textContent = block.keyword;

    const counts = block.storeCounts;
    if (counts) {
      const hint = document.createElement('p');
      hint.className = 'aligned-keyword-count';
      const pairNote =
        block.similarPairCount != null
          ? `${block.similarPairCount} matched pair${block.similarPairCount === 1 ? '' : 's'}`
          : '';
      const totalProducts = counts.woolworths + counts.coles;
      hint.textContent =
        totalProducts === 0
          ? 'No products loaded — see messages per store below'
          : `${matrixRows.length} row${matrixRows.length === 1 ? '' : 's'}${pairNote ? ` · ${pairNote}` : ''} · Woolworths ${counts.woolworths} · Coles ${counts.coles}${block.orphanRowsCapped ? ' · showing top matches only' : ''}`;
      group.appendChild(heading);
      group.appendChild(hint);
    } else {
      group.appendChild(heading);
    }

    matrixRows.forEach((matrixRow, indexInKeyword) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'aligned-compare-row reveal-animate';
      rowEl._matrixRow = matrixRow;
      rowEl._keyword = block.keyword;
      rowEl._storeErrors = {
        woolworths: data.storeErrors?.woolworths || '',
        coles: data.storeErrors?.coles || '',
      };
      rowEl.style.animationDelay = `${Math.min(globalRowIndex * 0.04, 0.5)}s`;
      globalRowIndex += 1;

      const rank = document.createElement('p');
      rank.className = 'aligned-row-rank';
      rank.textContent = `Row ${indexInKeyword + 1}`;

      const storesWrap = document.createElement('div');
      storesWrap.className = 'aligned-row-stores';

      const cellProducts = [];

      ALIGNED_STORE_META.forEach(({ key, name, labelClass }) => {
        const errKey = ALIGNED_STORE_ERROR_KEY[key];
        const storeError = data.storeErrors?.[errKey] || '';
        const product = matrixRow[key] || null;
        cellProducts.push({ key, product });

        const cellWrap = document.createElement('div');
        cellWrap.innerHTML = buildAlignedMatrixCellHtml(
          product,
          name,
          labelClass,
          key,
          [],
          block.keyword,
          storeError
        );
        const cell = cellWrap.firstElementChild;
        if (cell) {
          cell.dataset.store = key;
          storesWrap.appendChild(cell);
        }
      });

      rowEl.appendChild(rank);
      rowEl.appendChild(storesWrap);
      group.appendChild(rowEl);

      refreshMatrixRowPriceBadges(rowEl);

      rowEl.querySelectorAll('.aligned-add-btn').forEach((btn) => {
        const storeKey = btn.dataset.store;
        const entry = cellProducts.find((c) => c.key === storeKey);
        if (entry?.product) {
          btn.addEventListener('click', () => addToCart(entry.product));
        }
      });

      bindWatchlistButtons(rowEl, (watchId) => {
        for (const { product } of cellProducts) {
          if (product && getWatchlistProductId(product) === watchId) return product;
        }
        return null;
      });
    });

    container.appendChild(group);
  });

  syncWatchlistBellButtons();
}

/**
 * Cập nhật tag Lowest Price / Save trên một hàng (theo siêu thị đang bật).
 */
function refreshMatrixRowPriceBadges(rowEl) {
  const matrixRow = rowEl._matrixRow;
  const keyword = rowEl._keyword || '';
  if (!matrixRow) return;

  const peers = getMatrixRowPeers(matrixRow, compareStoreVisibility);
  const storeErrors = rowEl._storeErrors || {};

  ALIGNED_STORE_META.forEach(({ key, name, labelClass }) => {
    const cell = rowEl.querySelector(`.aligned-store-cell[data-store="${key}"]`);
    if (!cell) return;

    const product = matrixRow[key] || null;
    const body = cell.querySelector('.aligned-cell-body');
    const meta = cell.querySelector('.aligned-cell-meta');
    if (!body) return;

    cell.classList.remove('product-card', 'cheapest');
    cell.classList.toggle('store-col-hidden', !isCompareStoreVisible(key));

    if (!product) {
      return;
    }

    cell.classList.add('product-card');
    const isCheapest = isRowCheapestProduct(product, peers);
    if (isCheapest && peers.length >= 2) {
      cell.classList.add('cheapest');
    }

    const savingHtml = buildRowMultiStoreSavingBadge(peers, product.supermarket);
    const priceArea = body.querySelector('.aligned-price-area');
    if (priceArea) {
      priceArea.innerHTML = `
        ${buildPriceBlock(product)}
        <div class="aligned-saving-slot">${savingHtml}</div>
      `;
    }

    let cheapestLabel = meta?.querySelector('.cheapest-label');
    if (!cheapestLabel && meta) {
      cheapestLabel = document.createElement('p');
      cheapestLabel.className = 'cheapest-label';
      cheapestLabel.textContent = 'Lowest price';
      meta.insertBefore(cheapestLabel, meta.firstChild);
    }
    if (cheapestLabel) {
      cheapestLabel.hidden = !(isCheapest && peers.length >= 2);
    }
  });
}

/**
 * HTML một ô trong ma trận (có sản phẩm hoặc ô trống nét đứt).
 */
function buildAlignedMatrixCellHtml(
  product,
  storeName,
  labelClass,
  storeKey,
  rowPeers,
  keyword,
  storeError
) {
  if (!product) {
    const apiFailure =
      storeError &&
      /timed out|unable to load|temporarily unavailable|network|could not be reached/i.test(
        storeError
      );
    const statusLabel = apiFailure
      ? `Could not reach ${storeName}`
      : `❌ Not available at ${storeName}`;
    const detail = storeError
      ? `<p class="unavailable-error">${escapeHtml(storeError)}</p>`
      : '<p class="unavailable-hint">No matching product for this row.</p>';
    return `
      <div class="aligned-store-cell unavailable${apiFailure ? ' unavailable--api' : ''}" data-store="${escapeHtml(storeKey)}">
        <p class="store-label ${labelClass}">${escapeHtml(storeName)}</p>
        <div class="aligned-cell-body">
          <div class="unavailable-inner">
            <p class="unavailable-label">${escapeHtml(statusLabel)}</p>
            ${detail}
          </div>
        </div>
      </div>`;
  }

  const isCheapest = isRowCheapestProduct(product, rowPeers);
  const savingHtml = buildRowMultiStoreSavingBadge(rowPeers, product.supermarket);

  return `
    <div class="aligned-store-cell product-card${isCheapest ? ' cheapest' : ''}" data-store="${escapeHtml(storeKey)}">
      <p class="store-label ${labelClass}">${escapeHtml(storeName)}</p>
      <div class="aligned-cell-body">
        ${buildLinkedImage(product, 'product-thumb', keyword)}
        ${buildProductTitleRow(product)}
        <div class="aligned-price-area">
          ${buildPriceBlock(product)}
          <div class="aligned-saving-slot">${savingHtml}</div>
        </div>
      </div>
      <div class="aligned-cell-meta">
        ${isCheapest && rowPeers.length >= 2 ? '<p class="cheapest-label">Lowest price</p>' : ''}
        <button type="button" class="select-btn aligned-add-btn" data-store="${escapeHtml(storeKey)}">Add to list</button>
      </div>
    </div>`;
}

function showBarcodeScanBanner(barcode) {
  removeBarcodeScanBanner();
  const searchSection = document.querySelector('.search-section');
  if (!searchSection) return;
  const banner = document.createElement('p');
  banner.id = 'barcode-scan-banner';
  banner.className = 'barcode-scan-banner';
  banner.textContent = `Barcode scanned: ${barcode} — showing matched products below.`;
  searchSection.appendChild(banner);
}

function removeBarcodeScanBanner() {
  document.getElementById('barcode-scan-banner')?.remove();
}

function renderSummary(el, section, woolworths, coles, data = {}) {
  const mins = [
    { store: 'Coles', price: coles.length ? Math.min(...coles.map((p) => p.price)) : null },
    {
      store: 'Woolworths',
      price: woolworths.length ? Math.min(...woolworths.map((p) => p.price)) : null,
    },
  ].filter((row) => row.price != null);

  if (!mins.length) {
    hideRevealSection(section);
    return;
  }

  let text = '';
  if (data.searchMode === 'barcode') {
    text += '📷 Got a barcode hit! ';
  }

  mins.forEach((row) => {
    text += `${row.store} from <strong>$${row.price.toFixed(2)}</strong>. `;
  });

  if (mins.length >= 2) {
    const sorted = [...mins].sort((a, b) => a.price - b.price);
    const best = sorted[0];
    const runner = sorted[1];
    const diff = runner.price - best.price;
    if (diff <= PRICE_EPSILON) {
      text += '✨ Same lowest price across stores (within rounding).';
    } else {
      text += `👀 ${best.store} looks best here — save <strong>$${diff.toFixed(2)}</strong> vs ${runner.store} on the cheapest match.`;
    }
  }

  el.innerHTML = text;
  showRevealSection(section);
}

function renderStoreResults(container, products, storeName, storeError = '') {
  container.innerHTML = '';

  if (!products?.length) {
    if (storeError) {
      container.innerHTML = `<p class="error">${escapeHtml(storeError)}</p>`;
      return;
    }
    container.innerHTML = `<p class="error">No results at ${storeName}.</p>`;
    return;
  }

  const sorted = [...products].sort((a, b) => a.price - b.price);
  const cheapest = sorted[0].price;

  sorted.forEach((item, index) => {
    const card = document.createElement('div');
    const isCheapest = Math.abs(item.price - cheapest) <= PRICE_EPSILON;
    card.className = `product-card reveal-animate${isCheapest ? ' cheapest' : ''}`;
    card.style.animationDelay = `${Math.min(index * 0.04, 0.4)}s`;

    const pair = findPairForItem(item);
    const priceBlock = pair
      ? buildPriceBlockWithSaving(item, pair.coles, pair.woolworths)
      : buildPriceBlock(item);

    card.innerHTML = `
      ${buildLinkedImage(item, 'product-thumb')}
      ${buildProductTitleRow(item)}
      ${priceBlock}
      ${isCheapest ? '<p class="cheapest-label">Lowest price</p>' : ''}
      <button class="select-btn" type="button">Add to list</button>
    `;

    bindWatchlistButtons(card, (watchId) =>
      getWatchlistProductId(item) === watchId ? item : null
    );

    card.querySelector('.select-btn').addEventListener('click', () => {
      addToCart(item);
    });

    container.appendChild(card);
  });

  syncWatchlistBellButtons();
}

/** Wrap inner HTML in an external link (new tab). */
function buildProductLink(url, innerHtml) {
  const safeUrl = String(url || '').trim();
  if (!safeUrl || !/^https?:\/\//i.test(safeUrl)) {
    return innerHtml;
  }
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="product-link">${innerHtml}</a>`;
}

/** Product name linked to the store's official search (or product URL fallback). */
function buildProductLinkForItem(item, innerHtml, fallbackKeyword = '') {
  return buildProductLink(resolveStoreSearchUrl(item, fallbackKeyword), innerHtml);
}

function buildProductNameLink(item, fallbackKeyword = '') {
  return buildProductLinkForItem(item, escapeHtml(item.name), fallbackKeyword);
}

function buildLinkedImage(item, className = 'match-thumb', fallbackKeyword = '') {
  const img = buildSafeImageTag(item.image, `${item.supermarket} product`, className);
  return buildProductLinkForItem(item, img, fallbackKeyword);
}

/** Image + linked product name (Compare Prices and AI analyzer). */
function buildAiProductPreview(product, storeName, fallbackKeyword = '') {
  if (!product?.name) return '';
  const item = {
    ...product,
    supermarket: product.supermarket || storeName || 'Product',
  };
  return `
    <div class="ai-product-preview">
      ${buildLinkedImage(item, 'ai-product-thumb', fallbackKeyword)}
      <p class="ai-product-name">${buildProductNameLink(item, fallbackKeyword)}</p>
    </div>
  `;
}

function buildPriceBlock(item) {
  const specialTag = buildSpecialTag(item);
  const priceHtml = `<span class="price-tag">$${item.price.toFixed(2)}</span>`;
  const unitHtml = item.unit_price_text
    ? `<p class="unit-price-text">${escapeHtml(item.unit_price_text)}</p>`
    : '';

  return `
    <div class="price-block">
      <div class="price-row">${priceHtml}${specialTag}</div>
      ${unitHtml}
    </div>
  `;
}

/** SPECIAL or SAVE $X tag when product is on promotion */
function buildSpecialTag(item) {
  if (!item.isOnSpecial && !item.saveAmount) return '';

  if (item.saveAmount && item.saveAmount > 0) {
    return `<span class="special-tag">SAVE $${item.saveAmount.toFixed(2)}</span>`;
  }
  return '<span class="special-tag">SPECIAL</span>';
}

function buildSafeImageTag(imageUrl, altText, className) {
  const src = imageUrl ? escapeHtml(imageUrl) : FALLBACK_IMAGE_URL;
  const safeAlt = escapeHtml(altText || 'Product image');
  return `<img src="${src}" alt="${safeAlt}" class="${className}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${FALLBACK_IMAGE_URL}';" />`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.getElementById('brand-home-link')?.addEventListener('click', handleBrandHomeClick);
document.getElementById('brand-hero-link')?.addEventListener('click', handleBrandHomeClick);

// --- Compare search: rotating placeholder hints (Australian grocery examples) ---

/** Static fallback on first paint, on focus, and when rotation is paused. */
const COMPARE_SEARCH_PLACEHOLDER_STATIC =
  "Search for 'Jasmine rice', 'oyster blade beefsteak'...";

/** Rotates when the compare input is empty and unfocused. */
const COMPARE_SEARCH_PLACEHOLDER_HINTS = [
  "Search for 'Jasmine rice'...",
  "Search for 'oyster blade beefsteak'...",
  "Search for 'Devondale full cream milk'...",
];

const ROTATING_PLACEHOLDER_INTERVAL_MS = 4000;
const ROTATING_PLACEHOLDER_FADE_MS = 320;

/** Restarts the compare placeholder cycle after resetCompareView clears the input. */
let restartRotatingComparePlaceholder = () => {};

function initRotatingComparePlaceholder() {
  const input = document.getElementById('itemInput');
  if (!input || input.dataset.rotatingPlaceholder !== 'true') return;

  input.placeholder = COMPARE_SEARCH_PLACEHOLDER_STATIC;

  let hintIndex = 0;
  let timerId = null;
  let fading = false;

  const canRotate = () =>
    document.activeElement !== input && !input.value.trim() && !input.disabled;

  const scheduleNext = () => {
    clearTimeout(timerId);
    if (!canRotate()) return;
    timerId = window.setTimeout(rotateOnce, ROTATING_PLACEHOLDER_INTERVAL_MS);
  };

  const rotateOnce = () => {
    if (!canRotate() || fading) {
      scheduleNext();
      return;
    }

    fading = true;
    input.classList.add('search-input--placeholder-fade');

    window.setTimeout(() => {
      hintIndex = (hintIndex + 1) % COMPARE_SEARCH_PLACEHOLDER_HINTS.length;
      input.placeholder = COMPARE_SEARCH_PLACEHOLDER_HINTS[hintIndex];
      input.classList.remove('search-input--placeholder-fade');
      fading = false;
      scheduleNext();
    }, ROTATING_PLACEHOLDER_FADE_MS);
  };

  restartRotatingComparePlaceholder = () => {
    clearTimeout(timerId);
    fading = false;
    input.classList.remove('search-input--placeholder-fade');
    if (canRotate()) {
      input.placeholder = COMPARE_SEARCH_PLACEHOLDER_STATIC;
      scheduleNext();
    }
  };

  input.addEventListener('focus', () => {
    clearTimeout(timerId);
    input.classList.remove('search-input--placeholder-fade');
    input.placeholder = COMPARE_SEARCH_PLACEHOLDER_STATIC;
  });

  input.addEventListener('blur', () => {
    if (!input.value.trim()) scheduleNext();
  });

  input.addEventListener('input', () => {
    clearTimeout(timerId);
    if (input.value.trim()) {
      input.classList.remove('search-input--placeholder-fade');
      return;
    }
    input.placeholder = COMPARE_SEARCH_PLACEHOLDER_STATIC;
    scheduleNext();
  });

  scheduleNext();
}

document.getElementById('itemInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchProducts();
});

document.getElementById('clear-cart')?.addEventListener('click', clearCart);

document.getElementById('analyzeListBtn')?.addEventListener('click', analyzeShoppingList);

document.getElementById('ai-results-expand-bar')?.addEventListener('click', expandAiAnalyzeAccordion);
document.getElementById('ai-results-collapse-bar')?.addEventListener('click', collapseAiAnalyzeAccordion);

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

document.getElementById('refresh-watchlist-btn')?.addEventListener('click', refreshWatchlistPrices);

document.getElementById('clear-history-btn')?.addEventListener('click', () => {
  clearSearchHistory();
});

initTheme();
initLocationConsentUi();
initRotatingComparePlaceholder();
initMainTabs();
updateWatchlistTabBadge();
renderRecentSearches();
renderWatchlistPanel();
renderCartPanel();

// --- Main tabs: Compare prices / Price watchlist ---

function initMainTabs() {
  const tabs = document.querySelectorAll('.main-tab');
  const panels = {
    compare: document.getElementById('panel-compare'),
    watchlist: document.getElementById('panel-watchlist'),
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      Object.entries(panels).forEach(([key, panel]) => {
        if (!panel) return;
        const isActive = key === target;
        panel.classList.toggle('hidden', !isActive);
        panel.classList.toggle('active', isActive);
      });
      if (target === 'watchlist') {
        refreshWatchlistPrices();
      }
    });
  });
}

// --- Price watchlist panel ---

async function refreshWatchlistPrices() {
  const grid = document.getElementById('watchlist-grid');
  const statusEl = document.getElementById('watchlist-status');
  const refreshBtn = document.getElementById('refresh-watchlist-btn');
  const list = loadWatchlist();

  if (!grid) return;

  if (!list.length) {
    grid.innerHTML = `
      <p class="watchlist-empty">
        No items yet. Click 🔔 next to a product while comparing prices to watch for drops.
      </p>
    `;
    if (statusEl) statusEl.textContent = '';
    return;
  }

  if (refreshBtn) refreshBtn.disabled = true;
  if (statusEl) {
    statusEl.innerHTML = '<p class="loading">Fetching latest prices from stores...</p>';
  }

  try {
    const response = await apiFetch(`${API_BASE}/api/watchlist/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not refresh prices.');
    }

    const mergedList = mergeWatchlistRefreshIntoStorage(list, data.results || []);
    saveWatchlist(mergedList);
    renderWatchlistPanel(data.results || []);
    if (statusEl) {
      statusEl.textContent = `Updated at ${new Date().toLocaleTimeString('en-AU')}.`;
    }
  } catch (err) {
    if (statusEl) {
      statusEl.innerHTML = `<p class="error">${escapeHtml(err.message || 'Failed to refresh prices.')}</p>`;
    }
    renderWatchlistPanel();
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

/** Persist latest dual-store prices from a refresh response into localStorage. */
function mergeWatchlistRefreshIntoStorage(list, refreshResults) {
  const map = new Map();
  if (Array.isArray(refreshResults)) {
    refreshResults.forEach((r) => map.set(r.id, r));
  }
  return list.map((entry) => {
    const fresh = map.get(entry.id);
    if (!fresh) return entry;
    return {
      ...entry,
      lastColesPrice:
        fresh.colesPrice != null ? fresh.colesPrice : entry.lastColesPrice ?? null,
      lastWoolworthsPrice:
        fresh.woolworthsPrice != null ? fresh.woolworthsPrice : entry.lastWoolworthsPrice ?? null,
      lastCurrentPrice:
        fresh.currentPrice != null ? fresh.currentPrice : entry.lastCurrentPrice ?? null,
    };
  });
}

function formatWatchlistStorePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : '—';
}

/** Render watchlist accordion cards; refreshResults maps id → latest API row */
function renderWatchlistPanel(refreshResults = null) {
  const grid = document.getElementById('watchlist-grid');
  if (!grid) return;

  const list = loadWatchlist();
  updateWatchlistTabBadge();

  window.ShoppingSmartApp?.destroyAllWatchlistCharts?.();

  if (!list.length) {
    grid.innerHTML = `
      <p class="watchlist-empty">
        No items yet. Click 🔔 next to a product while comparing prices to watch for drops.
      </p>
    `;
    return;
  }

  const resultMap = new Map();
  if (Array.isArray(refreshResults)) {
    refreshResults.forEach((r) => resultMap.set(r.id, r));
  }

  grid.innerHTML = '';

  list.forEach((entry) => {
    const fresh = resultMap.get(entry.id);
    const colesPrice =
      fresh?.colesPrice != null ? fresh.colesPrice : entry.lastColesPrice ?? null;
    const woolworthsPrice =
      fresh?.woolworthsPrice != null ? fresh.woolworthsPrice : entry.lastWoolworthsPrice ?? null;
    const currentPrice =
      fresh?.found && fresh.currentPrice != null
        ? fresh.currentPrice
        : entry.lastCurrentPrice ?? null;
    const watchedPrice = Number(entry.watchedAtPrice);
    const priceDrop =
      fresh?.isPriceDown && fresh.priceDrop > 0
        ? fresh.priceDrop
        : currentPrice != null && currentPrice < watchedPrice
          ? Number((watchedPrice - currentPrice).toFixed(2))
          : 0;
    const isPriceDown = priceDrop > 0;

    const card = document.createElement('article');
    card.className = `watchlist-card${isPriceDown ? ' price-down' : ''}`;
    card.dataset.watchId = entry.id;

    const dropTag = isPriceDown
      ? `<span class="price-drop-tag">PRICE DROP! Down $${priceDrop.toFixed(2)} since you started watching</span>`
      : '';

    const watchedHint =
      currentPrice != null
        ? `<p class="watch-price-was">Watched at ${entry.supermarket}: $${watchedPrice.toFixed(2)} · now $${currentPrice.toFixed(2)}</p>`
        : `<p class="watch-price-pending">${
            fresh?.error
              ? escapeHtml(fresh.error)
              : 'Tap "Refresh prices", then expand for price history.'
          }</p>`;

    card.innerHTML = `
      ${dropTag}
      <div
        class="watchlist-card-summary"
        role="button"
        tabindex="0"
        aria-expanded="false"
        aria-label="Toggle price history for ${escapeHtml(entry.name)}"
      >
        <div class="watchlist-card-head">
          ${buildProductLink(
            entry.url,
            buildSafeImageTag(entry.image, entry.name, 'watchlist-thumb')
          )}
          <div class="watchlist-card-body">
            <h3 class="watch-name">${buildProductLink(entry.url, escapeHtml(entry.name))}</h3>
            <div class="watch-dual-prices" aria-label="Store prices">
              <span class="watch-dual-price watch-dual-price--ww">
                <span class="watch-dual-label">Woolworths</span>
                <strong>${formatWatchlistStorePrice(woolworthsPrice)}</strong>
              </span>
              <span class="watch-dual-price watch-dual-price--coles">
                <span class="watch-dual-label">Coles</span>
                <strong>${formatWatchlistStorePrice(colesPrice)}</strong>
              </span>
            </div>
            ${watchedHint}
          </div>
          <span class="watchlist-chevron" aria-hidden="true"></span>
          <button type="button" class="watchlist-remove" data-watch-id="${escapeHtml(entry.id)}" title="Remove from watchlist">✕</button>
        </div>
      </div>
      <div class="price-chart-container" hidden>
        <p class="price-chart-status" hidden></p>
        <div class="price-chart-canvas-wrap">
          <canvas class="watchlist-canvas" aria-label="Price history chart"></canvas>
        </div>
      </div>
    `;

    card.querySelector('.watchlist-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      window.ShoppingSmartApp?.destroyWatchlistChart?.(entry.id);
      saveWatchlist(loadWatchlist().filter((w) => w.id !== entry.id));
      updateWatchlistTabBadge();
      syncWatchlistBellButtons();
      renderWatchlistPanel(refreshResults);
    });

    window.ShoppingSmartApp?.attachWatchlistCard?.(card, entry);

    grid.appendChild(card);
  });
}

function buildProductLink(url, innerHtml) {
  const safeUrl = String(url || '').trim();
  if (!safeUrl || !/^https?:\/\//i.test(safeUrl)) {
    return innerHtml;
  }
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="product-link">${innerHtml}</a>`;
}

// --- AI Shopping List ---

/** Timer giả lập % loading (API không trả progress thật) */
let aiAnalyzeProgressTimer = null;

/**
 * Bắt đầu thanh loading dưới AI Shopping List — % tăng dần, màu xanh đậm hơn.
 */
function startAiAnalyzeProgress() {
  const wrap = document.getElementById('ai-analyze-progress');
  const fill = document.getElementById('ai-analyze-progress-fill');
  const label = document.getElementById('ai-analyze-progress-label');
  if (!wrap || !fill || !label) return;

  stopAiAnalyzeProgress(false);

  wrap.classList.remove('hidden');
  wrap.setAttribute('aria-hidden', 'false');

  let pct = 0;

  const setProgress = (value) => {
    pct = Math.min(100, Math.max(0, value));
    fill.style.width = `${pct}%`;
    label.textContent = `${Math.round(pct)}%`;
    wrap.setAttribute('aria-valuenow', String(Math.round(pct)));

    // Xanh nhạt (#93c5fd) → xanh đậm (#1d4ed8) theo %
    const t = pct / 100;
    const r = Math.round(147 + (29 - 147) * t);
    const g = Math.round(197 + (78 - 197) * t);
    const b = Math.round(253 + (216 - 253) * t);
    fill.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
  };

  setProgress(3);

  aiAnalyzeProgressTimer = window.setInterval(() => {
    if (pct >= 92) return;
    const step = pct < 35 ? 2.8 : pct < 65 ? 1.4 : 0.45;
    setProgress(pct + step);
  }, 140);
}

/** Hoàn tất 100% rồi ẩn thanh loading */
function finishAiAnalyzeProgress() {
  const wrap = document.getElementById('ai-analyze-progress');
  const fill = document.getElementById('ai-analyze-progress-fill');
  const label = document.getElementById('ai-analyze-progress-label');

  stopAiAnalyzeProgress(false);

  if (fill && label && wrap) {
    fill.style.width = '100%';
    fill.style.backgroundColor = '#1d4ed8';
    label.textContent = '100%';
    wrap.setAttribute('aria-valuenow', '100');
  }

  window.setTimeout(() => stopAiAnalyzeProgress(true), 450);
}

/** Dừng timer và tùy chọn reset thanh về 0% */
function stopAiAnalyzeProgress(reset = true) {
  if (aiAnalyzeProgressTimer) {
    clearInterval(aiAnalyzeProgressTimer);
    aiAnalyzeProgressTimer = null;
  }

  if (!reset) return;

  const wrap = document.getElementById('ai-analyze-progress');
  const fill = document.getElementById('ai-analyze-progress-fill');
  const label = document.getElementById('ai-analyze-progress-label');

  wrap?.classList.add('hidden');
  wrap?.setAttribute('aria-hidden', 'true');
  wrap?.setAttribute('aria-valuenow', '0');

  if (fill) {
    fill.style.width = '0%';
    fill.style.backgroundColor = '';
  }
  if (label) label.textContent = '0%';
}

async function analyzeShoppingList() {
  const textarea = document.getElementById('aiListInput');
  const btn = document.getElementById('analyzeListBtn');
  const section = document.getElementById('ai-results-section');
  const prompt = textarea?.value.trim();

  if (!prompt) {
    return alert('Enter your shopping list (e.g. 2 kg rice, 1 L milk).');
  }

  await ensureLocationConsent();

  btn.disabled = true;
  startAiAnalyzeProgress();
  showAiAnalyzeResults();
  section.querySelector('#ai-parse-info').innerHTML = '<p class="loading">Analyzing with AI and fetching prices...</p>';
  section.querySelector('#ai-totals-grid').innerHTML = '';
  section.querySelector('#ai-savings-banner').textContent = '';
  section.querySelector('#ai-split-details').innerHTML = '';
  section.querySelector('#ai-line-items').innerHTML = '';

  try {
    const response = await apiFetch(`${API_BASE}/api/analyze-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not analyze list.');
    }

    renderAiShoppingResults(data);
    finishAiAnalyzeProgress();
  } catch (err) {
    stopAiAnalyzeProgress(true);
    section.querySelector('#ai-parse-info').innerHTML = `<p class="error">${escapeHtml(err.message || 'Analysis failed.')}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function renderAiShoppingResults(data) {
  const { parsedItems, lineItems, optimization, parseSource } = data;
  const opt = optimization || {};

  /** Snapshot for PDF export (public/app.js). */
  window.lastAiShoppingExportData = data;

  showAiAnalyzeResults();

  document.getElementById('ai-parse-info').innerHTML = `
    <p>Detected <strong>${parsedItems.length}</strong> items
    ${parseSource === 'openai' ? '(via AI)' : '(via local parser)'}:</p>
    <ul class="ai-parsed-list">
      ${parsedItems
        .map((item) => `<li>${escapeHtml(formatRequestLabel(item))}</li>`)
        .join('')}
    </ul>
  `;

  const bestStrategy = opt.bestStrategy || 'split';
  const colesHighlight = bestStrategy === 'coles_only';
  const woolHighlight = bestStrategy === 'woolworths_only';
  const splitHighlight = bestStrategy === 'split';

  document.getElementById('ai-totals-grid').innerHTML = `
    <div class="ai-total-card${colesHighlight ? ' highlight' : ''}">
      <h3>All at Coles${colesHighlight ? ' (best)' : ''}</h3>
      <p class="amount">$${(opt.colesOnlyTotal || 0).toFixed(2)}</p>
      ${opt.colesOnlyIncomplete ? '<p class="cart-incomplete-note">Includes estimated prices for missing items (see item details).</p>' : ''}
    </div>
    <div class="ai-total-card${woolHighlight ? ' highlight' : ''}">
      <h3>All at Woolworths${woolHighlight ? ' (best)' : ''}</h3>
      <p class="amount">$${(opt.woolworthsOnlyTotal || 0).toFixed(2)}</p>
      ${opt.woolworthsOnlyIncomplete ? '<p class="cart-incomplete-note">Includes estimated prices for missing items (see item details).</p>' : ''}
    </div>
    <div class="ai-total-card${splitHighlight ? ' highlight' : ''}">
      <h3>Split cart${splitHighlight ? ' (best)' : ''}</h3>
      <p class="amount">$${(opt.splitTotal || 0).toFixed(2)}</p>
    </div>
  `;

  const savingsEl = document.getElementById('ai-savings-banner');
  const rec = opt.recommendation || opt.savings;
  if (rec?.message) {
    savingsEl.innerHTML = formatRecommendationMessage(rec.message);
  } else if (opt.splitTotal > 0) {
    savingsEl.textContent = 'No savings message available for this list.';
  } else {
    savingsEl.textContent = 'No matching products found. Try different keywords.';
  }

  renderAiSplitCart(opt.splitCart, bestStrategy, lineItems);
  renderAiLineItems(lineItems);

  aiAnalyzeHasContent = true;
  expandAiAnalyzeAccordion();
  const aiSection = document.getElementById('ai-results-section');
  if (aiSection) {
    aiSection.classList.add('reveal-animate');
  }

  const promptEl = document.getElementById('aiListInput');
  const promptText = promptEl?.value.trim();
  if (promptText) {
    addToSearchHistory(promptText, 'ai');
  }
}

function formatRecommendationMessage(message) {
  return String(message)
    .replace(/\$([\d.]+)/g, '<strong>$$$1</strong>')
    .replace(/([\d.]+)%/g, '<strong>$1%</strong>');
}

function lineItemsToStoreEntries(lineItems, store) {
  return lineItems.map((line) => {
    let product;
    let lineTotal;
    let incomplete;
    let incompleteNote;

    if (store === 'Coles') {
      product = line.coles;
      lineTotal = line.colesSingleStorePrice ?? line.colesLinePrice ?? 0;
      incomplete = line.colesIncomplete;
      incompleteNote = line.colesIncompleteNote;
    } else {
      product = line.woolworths;
      lineTotal = line.woolworthsSingleStorePrice ?? line.woolworthsLinePrice ?? 0;
      incomplete = line.woolIncomplete;
      incompleteNote = line.woolIncompleteNote;
    }

    return {
      request: line.request,
      product,
      lineTotal,
      incomplete,
      incompleteNote,
      noMatch: !product,
    };
  });
}

function renderAiSplitCart(splitCart, bestStrategy = 'split', lineItems = []) {
  const container = document.getElementById('ai-split-details');
  if (!splitCart) {
    container.innerHTML = '';
    return;
  }

  if (bestStrategy === 'woolworths_only') {
    const entries = lineItemsToStoreEntries(lineItems, 'Woolworths');
    container.innerHTML = `
      <h3>🛒 Woolworths all the way</h3>
      <p class="ai-single-store-hint">Your whole list is cheapest at Woolworths — one trip, no split needed!</p>
      <div class="ai-split-col woolies">
        <h3>All items at Woolworths</h3>
        ${renderSplitItems(entries, 'Woolworths')}
      </div>
    `;
    return;
  }

  if (bestStrategy === 'coles_only') {
    const entries = lineItemsToStoreEntries(lineItems, 'Coles');
    container.innerHTML = `
      <h3>🛒 Coles all the way</h3>
      <p class="ai-single-store-hint">Your whole list is cheapest at Coles — one trip, no split needed!</p>
      <div class="ai-split-col coles">
        <h3>All items at Coles</h3>
        ${renderSplitItems(entries, 'Coles')}
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <h3>Where to shop (split cart)</h3>
    <div class="ai-split-columns">
      <div class="ai-split-col coles">
        <h3>Buy at Coles</h3>
        ${renderSplitItems(splitCart.coles, 'Coles')}
      </div>
      <div class="ai-split-col woolies">
        <h3>Buy at Woolworths</h3>
        ${renderSplitItems(splitCart.woolworths, 'Woolworths')}
      </div>
    </div>
  `;
}

function renderSplitItems(items, storeLabel) {
  if (!items?.length) {
    return `<p class="missing">No items assigned to ${storeLabel}.</p>`;
  }

  return items
    .map((entry) => {
      const fallbackKw = entry.request?.keyword || '';
      return `
    <div class="ai-split-item">
      <p class="request-label">${escapeHtml(formatRequestLabel(entry.request))}</p>
      ${
        entry.product?.name
          ? buildAiProductPreview(entry.product, storeLabel, fallbackKw)
          : `<p class="product-title">${escapeHtml(entry.noMatch ? 'No match' : '—')}</p>`
      }
      ${entry.product?.pricingNote ? `<p class="pricing-note">${escapeHtml(entry.product.pricingNote)}</p>` : ''}
      ${entry.incompleteNote ? `<p class="imputed-note">${escapeHtml(entry.incompleteNote)}</p>` : ''}
      <p class="ai-line-price">$${entry.lineTotal.toFixed(2)}</p>
    </div>
  `;
    })
    .join('');
}

function renderAiLineItems(lineItems) {
  const container = document.getElementById('ai-line-items');
  if (!lineItems?.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '<h3>Item-by-item comparison</h3>';

  lineItems.forEach((line) => {
    const row = document.createElement('div');
    row.className = 'ai-line-row';

    const kw = line.request?.keyword || '';
    const colesClass =
      line.chosenStore === 'Coles' ? 'pick' : line.coles ? '' : 'missing';
    const woolClass =
      line.chosenStore === 'Woolworths' ? 'pick' : line.woolworths ? '' : 'missing';

    const colesUsable = line.coles && Number(line.colesLinePrice) > 0;
    const woolUsable = line.woolworths && Number(line.woolworthsLinePrice) > 0;

    const storeCell = (store, product, usable, linePrice, singlePrice, incomplete, incompleteNote, cssClass) => {
      if (usable) {
        return `
        <div class="${cssClass}">
          <strong>${store}</strong>
          ${buildAiProductPreview(product, store, kw)}
          ${product.pricingNote ? `<p class="pricing-note">${escapeHtml(product.pricingNote)}</p>` : ''}
          <p class="ai-line-price">$${linePrice.toFixed(2)}</p>
        </div>`;
      }
      if (incomplete) {
        return `
        <div class="${cssClass}">
          <strong>${store}</strong>
          <p class="missing">No match</p>
          <p class="ai-line-price imputed">$${singlePrice.toFixed(2)}</p>
          <p class="imputed-note">${escapeHtml(incompleteNote || '')}</p>
        </div>`;
      }
      return `
        <div class="${cssClass}">
          <strong>${store}</strong>
          <p class="missing">No match</p>
        </div>`;
    };

    row.innerHTML = `
      <p class="line-header">${escapeHtml(formatRequestLabel(line.request))}</p>
      <div class="ai-line-stores">
        ${storeCell(
          'Coles',
          line.coles,
          colesUsable,
          line.colesLinePrice,
          line.colesSingleStorePrice ?? 0,
          line.colesIncomplete,
          line.colesIncompleteNote,
          colesClass
        )}
        ${storeCell(
          'Woolworths',
          line.woolworths,
          woolUsable,
          line.woolworthsLinePrice,
          line.woolworthsSingleStorePrice ?? 0,
          line.woolIncomplete,
          line.woolIncompleteNote,
          woolClass
        )}
      </div>
    `;
    container.appendChild(row);
  });
}
