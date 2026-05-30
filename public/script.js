const API_BASE = 'http://localhost:3000';
const FALLBACK_IMAGE_URL = 'https://placehold.co/150?text=No+Image';
const CART_STORAGE_KEY = 'smartchoice_cart';
const WATCHLIST_STORAGE_KEY = 'smartchoice_watchlist';
const THEME_STORAGE_KEY = 'smartchoice_theme';
const HISTORY_STORAGE_KEY = 'smartchoice_history';
const HISTORY_MAX_ITEMS = 5;

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
    woolworthsUrl: pair?.woolworths?.url || (item.supermarket === 'Woolworths' ? item.url : ''),
    colesUrl: pair?.coles?.url || (item.supermarket === 'Coles' ? item.url : ''),
  };

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
 * Shows results and scrolls to Similar products when scanning.
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
    ? `${API_BASE}/api/compare/barcode?barcode=${encodeURIComponent(barcode)}`
    : `${API_BASE}/api/compare?keyword=${encodeURIComponent(keyword)}`;

  searchBtn.disabled = true;
  wooliesCont.innerHTML = '<p class="loading">Loading...</p>';
  colesCont.innerHTML = '<p class="loading">Loading...</p>';
  hideRevealSection(summarySection);
  hideRevealSection(matchedSection);
  matchedResults.innerHTML = '';
  removeBarcodeScanBanner();

  try {
    const response = await fetch(url);
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

  const items = Array.isArray(data) ? data : data.items || [];
  const similarPairs = Array.isArray(data?.similarPairs) ? data.similarPairs : [];
  lastSimilarPairs = similarPairs;

  const woolworths = items.filter((item) => item.supermarket === 'Woolworths');
  const coles = items.filter((item) => item.supermarket === 'Coles');

  if (options.fromBarcode && data.scannedBarcode) {
    showBarcodeScanBanner(data.scannedBarcode);
  }

  renderStoreResults(wooliesCont, woolworths, 'Woolworths', data.storeErrors?.woolworths);
  renderStoreResults(colesCont, coles, 'Coles', data.storeErrors?.coles);
  renderSummary(summaryText, summarySection, woolworths, coles, data);
  renderMatchedPairs(matchedResults, matchedSection, similarPairs);

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
  banner.textContent = `Barcode scanned: ${barcode} — showing matched product comparison below.`;
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

    const badge =
      pair.cheaper === 'Woolworths'
        ? '<span class="badge woolies-win">Woolworths cheaper</span>'
        : pair.cheaper === 'Coles'
          ? '<span class="badge coles-win">Coles cheaper</span>'
          : '<span class="badge tie">Same price</span>';

    row.innerHTML = `
      <div class="match-side" data-store="woolworths">
        <p class="store-label woolies">Woolworths</p>
        ${buildLinkedImage(pair.woolworths)}
        ${buildProductTitleRow(pair.woolworths)}
        ${buildPriceBlock(pair.woolworths)}
      </div>
      <div class="match-vs">vs</div>
      <div class="match-side" data-store="coles">
        <p class="store-label coles">Coles</p>
        ${buildLinkedImage(pair.coles)}
        ${buildProductTitleRow(pair.coles)}
        ${buildPriceBlock(pair.coles)}
      </div>
      <div class="match-meta">${badge}<p class="save-text">Difference: $${pair.saving.toFixed(2)}</p></div>
    `;

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

    card.innerHTML = `
      ${buildLinkedImage(item, 'product-thumb')}
      ${buildProductTitleRow(item)}
      ${buildPriceBlock(item)}
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

/** Link to store product page (new tab) */
function buildProductLink(url, innerHtml) {
  const safeUrl = String(url || '').trim();
  if (!safeUrl || !/^https?:\/\//i.test(safeUrl)) {
    return innerHtml;
  }
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="product-link">${innerHtml}</a>`;
}

function buildProductNameLink(item) {
  return buildProductLink(item.url, escapeHtml(item.name));
}

function buildLinkedImage(item, className = 'match-thumb') {
  const img = buildSafeImageTag(item.image, `${item.supermarket} product`, className);
  return buildProductLink(item.url, img);
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
    const response = await fetch(`${API_BASE}/api/watchlist/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not refresh prices.');
    }

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

/** Render watchlist; refreshResults maps id → latest price from API */
function renderWatchlistPanel(refreshResults = null) {
  const grid = document.getElementById('watchlist-grid');
  if (!grid) return;

  const list = loadWatchlist();
  updateWatchlistTabBadge();

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
    const currentPrice = fresh?.found ? fresh.currentPrice : null;
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
    const storeClass = entry.supermarket === 'Coles' ? 'coles' : 'woolies';

    const dropTag = isPriceDown
      ? `<span class="price-drop-tag">PRICE DROP! Down $${priceDrop.toFixed(2)} since you started watching</span>`
      : '';

    const priceBlock =
      currentPrice != null
        ? `
        <p class="watch-price-current">Current price: <strong>$${currentPrice.toFixed(2)}</strong></p>
        <p class="watch-price-was">Price when added: $${watchedPrice.toFixed(2)}</p>
      `
        : `<p class="watch-price-was">Price when added: $${watchedPrice.toFixed(2)}</p>
           <p class="watch-price-pending">${fresh?.error ? escapeHtml(fresh.error) : 'Click "Refresh prices" to fetch the latest price.'}</p>`;

    card.innerHTML = `
      ${dropTag}
      <div class="watchlist-card-head">
        ${buildProductLink(
          entry.url,
          buildSafeImageTag(entry.image, entry.name, 'watchlist-thumb')
        )}
        <div class="watchlist-card-body">
          <span class="watch-store ${storeClass}">${escapeHtml(entry.supermarket)}</span>
          <h3 class="watch-name">${buildProductLink(entry.url, escapeHtml(entry.name))}</h3>
          ${priceBlock}
        </div>
        <button type="button" class="watchlist-remove" data-watch-id="${escapeHtml(entry.id)}" title="Remove from watchlist">✕</button>
      </div>
    `;

    card.querySelector('.watchlist-remove').addEventListener('click', () => {
      saveWatchlist(loadWatchlist().filter((w) => w.id !== entry.id));
      updateWatchlistTabBadge();
      syncWatchlistBellButtons();
      renderWatchlistPanel(refreshResults);
    });

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

async function analyzeShoppingList() {
  const textarea = document.getElementById('aiListInput');
  const btn = document.getElementById('analyzeListBtn');
  const section = document.getElementById('ai-results-section');
  const prompt = textarea?.value.trim();

  if (!prompt) {
    return alert('Enter your shopping list (e.g. 2 kg rice, 1 L milk).');
  }

  btn.disabled = true;
  showAiAnalyzeResults();
  section.querySelector('#ai-parse-info').innerHTML = '<p class="loading">Analyzing with AI and fetching prices...</p>';
  section.querySelector('#ai-totals-grid').innerHTML = '';
  section.querySelector('#ai-savings-banner').textContent = '';
  section.querySelector('#ai-split-details').innerHTML = '';
  section.querySelector('#ai-line-items').innerHTML = '';

  try {
    const response = await fetch(`${API_BASE}/api/analyze-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not analyze list.');
    }

    renderAiShoppingResults(data);
  } catch (err) {
    section.querySelector('#ai-parse-info').innerHTML = `<p class="error">${escapeHtml(err.message || 'Analysis failed.')}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function renderAiShoppingResults(data) {
  const { parsedItems, lineItems, optimization, parseSource } = data;
  const opt = optimization || {};

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
    </div>
    <div class="ai-total-card${woolHighlight ? ' highlight' : ''}">
      <h3>All at Woolworths${woolHighlight ? ' (best)' : ''}</h3>
      <p class="amount">$${(opt.woolworthsOnlyTotal || 0).toFixed(2)}</p>
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
  return lineItems
    .filter((line) => (store === 'Coles' ? line.coles : line.woolworths))
    .map((line) => ({
      request: line.request,
      product: store === 'Coles' ? line.coles : line.woolworths,
      lineTotal: store === 'Coles' ? line.colesLinePrice : line.woolworthsLinePrice,
    }));
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
    .map(
      (entry) => `
    <div class="ai-split-item">
      <p class="request-label">${escapeHtml(formatRequestLabel(entry.request))}</p>
      <p class="product-title">${escapeHtml(entry.product?.name || '—')}</p>
      ${entry.product?.pricingNote ? `<p class="pricing-note">${escapeHtml(entry.product.pricingNote)}</p>` : ''}
      <p>$${entry.lineTotal.toFixed(2)}</p>
    </div>
  `
    )
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

    row.innerHTML = `
      <p class="line-header">${escapeHtml(formatRequestLabel(line.request))}</p>
      <div class="ai-line-stores">
        <div class="${colesClass}">
          <strong>Coles</strong>
          ${
            line.coles
              ? `<p>${escapeHtml(line.coles.name)}</p>
                 ${line.coles.pricingNote ? `<p class="pricing-note">${escapeHtml(line.coles.pricingNote)}</p>` : ''}
                 <p class="ai-line-price">$${line.colesLinePrice.toFixed(2)}</p>`
              : '<p class="missing">No match</p>'
          }
        </div>
        <div class="${woolClass}">
          <strong>Woolworths</strong>
          ${
            line.woolworths
              ? `<p>${escapeHtml(line.woolworths.name)}</p>
                 ${line.woolworths.pricingNote ? `<p class="pricing-note">${escapeHtml(line.woolworths.pricingNote)}</p>` : ''}
                 <p class="ai-line-price">$${line.woolworthsLinePrice.toFixed(2)}</p>`
              : '<p class="missing">No match</p>'
          }
        </div>
      </div>
    `;
    container.appendChild(row);
  });
}
