/** Cùng domain khi deploy (Vercel/điện thoại); localhost khi mở file trực tiếp */
const API_BASE =
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost:3000';
const FALLBACK_IMAGE_URL = 'https://placehold.co/150?text=No+Image';
const CART_STORAGE_KEY = 'smartchoice_cart';
const WATCHLIST_STORAGE_KEY = 'smartchoice_watchlist';
const THEME_STORAGE_KEY = 'smartchoice_theme';
const HISTORY_STORAGE_KEY = 'smartchoice_history';
const HISTORY_MAX_ITEMS = 5;
/** Persists in-app location choice so the banner does not reappear every visit. */
const LOCATION_CONSENT_STORAGE_KEY = 'smartchoice_location_consent';

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
 * Remove the location banner from view after the user has chosen Share or Not now.
 */
function dismissLocationConsentBanner() {
  const notice = document.getElementById('location-consent-notice');
  if (!notice || notice.classList.contains('location-notice--dismissed')) return;

  notice.classList.add('location-notice--dismissing');

  const finish = () => {
    notice.classList.add('location-notice--dismissed');
    notice.hidden = true;
    notice.setAttribute('aria-hidden', 'true');
  };

  notice.addEventListener('transitionend', finish, { once: true });
  window.setTimeout(finish, 450);
}

/**
 * Wire the location banner buttons. Does not touch the Geolocation API until the user agrees.
 */
function initLocationConsentUi() {
  const saved = loadSavedLocationConsent();
  if (saved) {
    userLocation = saved;
    dismissLocationConsentBanner();
    return;
  }

  const allowBtn = document.getElementById('location-allow-btn');
  const declineBtn = document.getElementById('location-decline-btn');

  allowBtn?.addEventListener('click', onLocationConsentAllow);
  declineBtn?.addEventListener('click', onLocationConsentDecline);

  updateLocationNoticeUi();
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
  dismissLocationConsentBanner();
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

/** Persist choice, tear down banner UI (no lingering status strip). */
function finalizeLocationConsentUi() {
  setLocationConsentButtonsDisabled(false);
  saveLocationConsentChoice();
  dismissLocationConsentBanner();
}

function setLocationConsentButtonsDisabled(disabled) {
  const allowBtn = document.getElementById('location-allow-btn');
  const declineBtn = document.getElementById('location-decline-btn');
  if (allowBtn) allowBtn.disabled = disabled;
  if (declineBtn) declineBtn.disabled = disabled;
}

/** Headers attached to every SmartChoice API request. */
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
 * So sánh hai sản phẩm tương đồng — ưu tiên $/kg, sau đó giá gói.
 * @returns {{ saving: number, cheaperStore: 'Coles'|'Woolworths'|'tie'|null, compareBasis?: 'per_kg'|'pack_price' }}
 */
function compareProductsForCheaper(woolProduct, colesProduct) {
  const woolKg = extractUnitPricePerKg(woolProduct);
  const colesKg = extractUnitPricePerKg(colesProduct);

  if (woolKg != null && colesKg != null) {
    const priceDiff = Math.abs(colesKg - woolKg);
    if (priceDiff <= PRICE_EPSILON) {
      return { saving: 0, cheaperStore: 'tie', compareBasis: 'per_kg' };
    }
    const cheaperStore = woolKg < colesKg ? 'Woolworths' : 'Coles';
    const woolW = woolProduct?.packWeightKg > 0 ? woolProduct.packWeightKg : 1;
    const colesW = colesProduct?.packWeightKg > 0 ? colesProduct.packWeightKg : 1;
    const refKg = Math.min(woolW, colesW);
    return {
      saving: roundMoney(priceDiff * refKg),
      cheaperStore,
      compareBasis: 'per_kg',
    };
  }

  const coles = Number(colesProduct?.packShelfPrice ?? colesProduct?.price);
  const wool = Number(woolProduct?.packShelfPrice ?? woolProduct?.price);
  if (!Number.isFinite(coles) || !Number.isFinite(wool) || coles <= 0 || wool <= 0) {
    return { saving: 0, cheaperStore: null };
  }
  const packDiff = Math.abs(coles - wool);
  if (packDiff <= PRICE_EPSILON) {
    return { saving: 0, cheaperStore: 'tie', compareBasis: 'pack_price' };
  }
  const saving = roundMoney(packDiff);
  const cheaperStore = wool < coles ? 'Woolworths' : 'Coles';
  return { saving, cheaperStore, compareBasis: 'pack_price' };
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
const WOOLWORTHS_SEARCH_BASE = 'https://www.woolworths.com.au/shop/search?searchTerm=';

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

/** Resolve href for image/name links: official search URL, or product page as fallback. */
function resolveStoreSearchUrl(item, fallbackKeyword = '') {
  const store = item?.supermarket;
  const query = getStoreSearchQuery(item, fallbackKeyword);
  if (query && (store === 'Coles' || store === 'Woolworths')) {
    return store === 'Coles' ? buildColesSearchUrl(query) : buildWoolworthsSearchUrl(query);
  }
  const direct = String(item?.url || '').trim();
  return /^https?:\/\//i.test(direct) ? direct : '';
}

/**
 * Per-line cart saving = Coles vs Woolworths price gap when both prices exist.
 */
function calcLineSavingForCartEntry(entry) {
  const woolProduct =
    entry.woolworthsPrice != null
      ? {
          price: entry.woolworthsPrice,
          packShelfPrice: entry.woolworthsPrice,
          packWeightKg: entry.woolworthsPackKg,
          pricePerKg: entry.woolworthsPricePerKg,
          unit_price_text: entry.woolworthsUnitText,
        }
      : null;
  const colesProduct =
    entry.colesPrice != null
      ? {
          price: entry.colesPrice,
          packShelfPrice: entry.colesPrice,
          packWeightKg: entry.colesPackKg,
          pricePerKg: entry.colesPricePerKg,
          unit_price_text: entry.colesUnitText,
        }
      : null;
  if (woolProduct && colesProduct) {
    return compareProductsForCheaper(woolProduct, colesProduct).saving;
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

// --- Search history (localStorage: smartchoice_history) ---

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

// --- Price watchlist (localStorage: smartchoice_watchlist) ---

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
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const watchId = btn.getAttribute('data-watch-id');
      const item = itemResolver(watchId, btn);
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

async function searchProducts() {
  const keyword = document.getElementById('itemInput').value.trim();
  if (!keyword) {
    return alert('Enter a product name (e.g. milk, rice 1kg).');
  }
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
  const summarySection = document.getElementById('summary-section');
  const summaryText = document.getElementById('summary-text');
  const matchedSection = document.getElementById('matched-section');
  const matchedResults = document.getElementById('matched-results');
  const searchBtn = document.getElementById('searchBtn');

  const url = barcode
    ? buildApiUrl(`/api/compare/barcode?barcode=${encodeURIComponent(barcode)}`)
    : buildApiUrl(`/api/compare?keyword=${encodeURIComponent(keyword)}`);

  searchBtn.disabled = true;
  wooliesCont.innerHTML = '<p class="loading">Loading...</p>';
  colesCont.innerHTML = '<p class="loading">Loading...</p>';
  hideRevealSection(summarySection);
  hideRevealSection(matchedSection);
  if (matchedResults) matchedResults.innerHTML = '';
  removeBarcodeScanBanner();

  try {
    const response = await apiFetch(url);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load data.');
    }

    displayCompareResults(data, { fromBarcode: Boolean(barcode) });

    if (keyword && !barcode) {
      addToSearchHistory(keyword, 'search');
    }
  } catch (err) {
    const message = err.message || 'Could not load results.';
    wooliesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
    colesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
  } finally {
    searchBtn.disabled = false;
  }
}

/** Render comparison results on screen */
function displayCompareResults(data, options = {}) {
  const wooliesCont = document.getElementById('woolworths-results');
  const colesCont = document.getElementById('coles-results');
  const summarySection = document.getElementById('summary-section');
  const summaryText = document.getElementById('summary-text');
  const matchedSection = document.getElementById('matched-section');
  const matchedResults = document.getElementById('matched-results');
  const browseGrid = document.querySelector('.comparison-grid--browse');

  const items = Array.isArray(data) ? data : data.items || [];
  const similarPairs = Array.isArray(data?.similarPairs) ? data.similarPairs : [];
  lastSimilarPairs = similarPairs;

  const woolworths = items.filter((item) => item.supermarket === 'Woolworths');
  const coles = items.filter((item) => item.supermarket === 'Coles');

  if (options.fromBarcode && data.scannedBarcode) {
    showBarcodeScanBanner(data.scannedBarcode);
  }

  renderSummary(summaryText, summarySection, woolworths, coles, data);
  renderMatchedPairs(matchedResults, matchedSection, similarPairs);

  renderStoreResults(wooliesCont, woolworths, 'Woolworths', data.storeErrors?.woolworths);
  renderStoreResults(colesCont, coles, 'Coles', data.storeErrors?.coles);

  if (browseGrid) {
    browseGrid.classList.toggle('hidden', similarPairs.length > 0);
  }

  if (options.fromBarcode && similarPairs.length) {
    matchedSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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
  const wwMin = woolworths.length ? Math.min(...woolworths.map((p) => p.price)) : null;
  const colesMin = coles.length ? Math.min(...coles.map((p) => p.price)) : null;

  if (colesMin == null && wwMin == null) {
    hideRevealSection(section);
    return;
  }

  let text = '';
  if (data.searchMode === 'barcode') {
    text += '📷 Got a barcode hit! ';
  }
  if (colesMin != null) text += `Coles from <strong>$${colesMin.toFixed(2)}</strong>. `;
  if (wwMin != null) text += `Woolworths from <strong>$${wwMin.toFixed(2)}</strong>. `;

  if (wwMin != null && colesMin != null) {
    const diff = Math.abs(wwMin - colesMin);
    if (wwMin < colesMin) {
      text += `👀 Woolworths looks better here — save <strong>$${diff.toFixed(2)}</strong> on the cheapest match.`;
    } else if (colesMin < wwMin) {
      text += `👀 Coles looks better here — save <strong>$${diff.toFixed(2)}</strong> on the cheapest match.`;
    } else {
      text += '✨ Same lowest price — either store works!';
    }
  } else if (colesMin != null && !woolworths.length) {
    text += 'Woolworths is taking a break for this search.';
  }

  el.innerHTML = text;
  showRevealSection(section);
}

/**
 * Lấy kết quả so sánh giá cho một cặp tương đồng (luôn tính lại trên client, khớp PRICE_EPSILON).
 */
function getPairComparison(pair) {
  const { cheaperStore, saving, compareBasis } = compareProductsForCheaper(
    pair.woolworths,
    pair.coles
  );
  const cheaper =
    cheaperStore === 'tie' || cheaperStore == null ? 'tie' : cheaperStore;
  return {
    cheaper,
    saving: Number(saving) || 0,
    compareBasis: compareBasis || pair.compareBasis || 'per_kg',
  };
}

/**
 * Dòng chú thích dưới thẻ cặp sản phẩm tương đồng.
 */
function formatPairSaveText(comparison) {
  if (!comparison) return '';
  if (comparison.cheaper === 'tie' || comparison.saving <= 0) {
    return comparison.compareBasis === 'per_kg'
      ? 'Same price per kg'
      : 'Same price';
  }
  return `Difference: $${Number(comparison.saving).toFixed(2)}`;
}

/**
 * Matched pairs (Similar products) — image/name link to store search; Add to list only.
 */
function renderMatchedPairs(container, section, pairs) {
  if (!pairs.length) {
    hideRevealSection(section);
    return;
  }

  container.innerHTML = '';
  pairs.forEach((pair, index) => {
    const row = document.createElement('div');
    row.className = 'match-row reveal-animate';
    row.style.animationDelay = `${index * 0.05}s`;

    const comparison = getPairComparison(pair);
    const badge =
      comparison.cheaper === 'Woolworths'
        ? '<span class="badge woolies-win">Woolworths cheaper</span>'
        : comparison.cheaper === 'Coles'
          ? '<span class="badge coles-win">Coles cheaper</span>'
          : `<span class="badge tie">${comparison.compareBasis === 'per_kg' ? 'Same price per kg' : 'Same price'}</span>`;

    row.innerHTML = `
      <div class="match-side" data-store="woolworths">
        <p class="store-label woolies">Woolworths</p>
        ${buildLinkedImage(pair.woolworths)}
        ${buildProductTitleRow(pair.woolworths)}
        ${buildPriceBlockWithSaving(pair.woolworths, pair.coles, pair.woolworths)}
        <button type="button" class="select-btn match-add-btn">Add to list</button>
      </div>
      <div class="match-vs">vs</div>
      <div class="match-side" data-store="coles">
        <p class="store-label coles">Coles</p>
        ${buildLinkedImage(pair.coles)}
        ${buildProductTitleRow(pair.coles)}
        ${buildPriceBlockWithSaving(pair.coles, pair.coles, pair.woolworths)}
        <button type="button" class="select-btn match-add-btn">Add to list</button>
      </div>
      <div class="match-meta">${badge}<p class="save-text">${formatPairSaveText(comparison)}</p></div>
    `;

    const addButtons = row.querySelectorAll('.match-add-btn');
    addButtons[0]?.addEventListener('click', () => addToCart(pair.woolworths));
    addButtons[1]?.addEventListener('click', () => addToCart(pair.coles));

    bindWatchlistButtons(row, (watchId) => {
      if (getWatchlistProductId(pair.woolworths) === watchId) return pair.woolworths;
      if (getWatchlistProductId(pair.coles) === watchId) return pair.coles;
      return null;
    });

    container.appendChild(row);
  });

  showRevealSection(section);
  syncWatchlistBellButtons();
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
    const isCheapest = item.price === cheapest;
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

  window.SmartChoiceApp?.destroyAllWatchlistCharts?.();

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
      window.SmartChoiceApp?.destroyWatchlistChart?.(entry.id);
      saveWatchlist(loadWatchlist().filter((w) => w.id !== entry.id));
      updateWatchlistTabBadge();
      syncWatchlistBellButtons();
      renderWatchlistPanel(refreshResults);
    });

    window.SmartChoiceApp?.attachWatchlistCard?.(card, entry);

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
  const isColes = store === 'Coles';
  return lineItems.map((line) => {
    const product = isColes ? line.coles : line.woolworths;
    const lineTotal = isColes
      ? (line.colesSingleStorePrice ?? line.colesLinePrice ?? 0)
      : (line.woolworthsSingleStorePrice ?? line.woolworthsLinePrice ?? 0);
    const incomplete = isColes ? line.colesIncomplete : line.woolIncomplete;
    const incompleteNote = isColes ? line.colesIncompleteNote : line.woolIncompleteNote;
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

    const colesClass =
      line.chosenStore === 'Coles' ? 'pick' : line.coles ? '' : 'missing';
    const woolClass =
      line.chosenStore === 'Woolworths' ? 'pick' : line.woolworths ? '' : 'missing';

    const colesUsable = line.coles && Number(line.colesLinePrice) > 0;
    const woolUsable = line.woolworths && Number(line.woolworthsLinePrice) > 0;
    const colesKw = line.request?.keyword || '';
    const woolKw = line.request?.keyword || '';

    row.innerHTML = `
      <p class="line-header">${escapeHtml(formatRequestLabel(line.request))}</p>
      <div class="ai-line-stores">
        <div class="${colesClass}">
          <strong>Coles</strong>
          ${
            colesUsable
              ? `${buildAiProductPreview(line.coles, 'Coles', colesKw)}
                 ${line.coles.pricingNote ? `<p class="pricing-note">${escapeHtml(line.coles.pricingNote)}</p>` : ''}
                 <p class="ai-line-price">$${line.colesLinePrice.toFixed(2)}</p>
                 ${woolUsable ? buildItemSavingBadge(line.coles, line.woolworths, 'Coles') : ''}`
              : line.colesIncomplete
                ? `<p class="missing">No match</p>
                   <p class="ai-line-price imputed">$${(line.colesSingleStorePrice ?? 0).toFixed(2)}</p>
                   <p class="imputed-note">${escapeHtml(line.colesIncompleteNote || '')}</p>`
                : '<p class="missing">No match</p>'
          }
        </div>
        <div class="${woolClass}">
          <strong>Woolworths</strong>
          ${
            woolUsable
              ? `${buildAiProductPreview(line.woolworths, 'Woolworths', woolKw)}
                 ${line.woolworths.pricingNote ? `<p class="pricing-note">${escapeHtml(line.woolworths.pricingNote)}</p>` : ''}
                 <p class="ai-line-price">$${line.woolworthsLinePrice.toFixed(2)}</p>
                 ${colesUsable ? buildItemSavingBadge(line.coles, line.woolworths, 'Woolworths') : ''}`
              : line.woolIncomplete
                ? `<p class="missing">No match</p>
                   <p class="ai-line-price imputed">$${(line.woolworthsSingleStorePrice ?? 0).toFixed(2)}</p>
                   <p class="imputed-note">${escapeHtml(line.woolIncompleteNote || '')}</p>`
                : '<p class="missing">No match</p>'
          }
        </div>
      </div>
    `;
    container.appendChild(row);
  });
}
