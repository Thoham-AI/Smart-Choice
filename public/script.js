const API_BASE = 'http://localhost:3000';
const FALLBACK_IMAGE_URL = 'https://placehold.co/150?text=No+Image';
const CART_STORAGE_KEY = 'smartchoice_cart';

/** Cặp similar products từ lần tìm kiếm gần nhất – dùng khi Add to list */
let lastSimilarPairs = [];

// --- Giỏ hàng (localStorage) ---

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

// --- Tìm kiếm ---

async function searchProducts() {
  const keyword = document.getElementById('itemInput').value.trim();
  const wooliesCont = document.getElementById('woolworths-results');
  const colesCont = document.getElementById('coles-results');
  const summarySection = document.getElementById('summary-section');
  const summaryText = document.getElementById('summary-text');
  const matchedSection = document.getElementById('matched-section');
  const matchedResults = document.getElementById('matched-results');
  const searchBtn = document.getElementById('searchBtn');

  if (!keyword) {
    return alert('Enter a product name (e.g. milk, rice 1kg).');
  }

  searchBtn.disabled = true;
  wooliesCont.innerHTML = '<p class="loading">Loading...</p>';
  colesCont.innerHTML = '<p class="loading">Loading...</p>';
  summarySection.classList.add('hidden');
  matchedSection.classList.add('hidden');
  matchedResults.innerHTML = '';

  try {
    const response = await fetch(
      `${API_BASE}/api/compare?keyword=${encodeURIComponent(keyword)}`
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load data.');
    }

    const items = Array.isArray(data) ? data : data.items || [];
    const similarPairs = Array.isArray(data?.similarPairs) ? data.similarPairs : [];
    lastSimilarPairs = similarPairs;

    const woolworths = items.filter((item) => item.supermarket === 'Woolworths');
    const coles = items.filter((item) => item.supermarket === 'Coles');

    renderStoreResults(wooliesCont, woolworths, 'Woolworths', data.storeErrors?.woolworths);
    renderStoreResults(colesCont, coles, 'Coles', data.storeErrors?.coles);
    renderSummary(summaryText, summarySection, woolworths, coles);
    renderMatchedPairs(matchedResults, matchedSection, similarPairs);
  } catch (err) {
    const message = err.message || 'Could not load results.';
    wooliesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
    colesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
  } finally {
    searchBtn.disabled = false;
  }
}

function renderSummary(el, section, woolworths, coles) {
  const wwMin = woolworths.length ? Math.min(...woolworths.map((p) => p.price)) : null;
  const colesMin = coles.length ? Math.min(...coles.map((p) => p.price)) : null;

  if (colesMin == null && wwMin == null) {
    section.classList.add('hidden');
    return;
  }

  let text = '';
  if (colesMin != null) text += `Lowest Coles price: <strong>$${colesMin.toFixed(2)}</strong>. `;
  if (wwMin != null) text += `Lowest Woolworths price: <strong>$${wwMin.toFixed(2)}</strong>. `;

  if (wwMin != null && colesMin != null) {
    const diff = Math.abs(wwMin - colesMin);
    if (wwMin < colesMin) {
      text += `Woolworths is <strong>$${diff.toFixed(2)}</strong> cheaper on the lowest item.`;
    } else if (colesMin < wwMin) {
      text += `Coles is <strong>$${diff.toFixed(2)}</strong> cheaper on the lowest item.`;
    } else {
      text += 'Both stores have the same lowest price.';
    }
  } else if (colesMin != null && !woolworths.length) {
    text += 'Woolworths results are unavailable for this search.';
  }

  el.innerHTML = text;
  section.classList.remove('hidden');
}

function renderMatchedPairs(container, section, pairs) {
  if (!pairs.length) {
    section.classList.add('hidden');
    return;
  }

  container.innerHTML = '';
  pairs.forEach((pair) => {
    const row = document.createElement('div');
    row.className = 'match-row';

    const badge =
      pair.cheaper === 'Woolworths'
        ? '<span class="badge woolies-win">Woolworths cheaper</span>'
        : pair.cheaper === 'Coles'
          ? '<span class="badge coles-win">Coles cheaper</span>'
          : '<span class="badge tie">Same price</span>';

    row.innerHTML = `
      <div class="match-side">
        <p class="store-label woolies">Woolworths</p>
        ${buildLinkedImage(pair.woolworths)}
        <p class="product-name">${buildProductNameLink(pair.woolworths)}</p>
        ${buildPriceBlock(pair.woolworths)}
      </div>
      <div class="match-vs">vs</div>
      <div class="match-side">
        <p class="store-label coles">Coles</p>
        ${buildLinkedImage(pair.coles)}
        <p class="product-name">${buildProductNameLink(pair.coles)}</p>
        ${buildPriceBlock(pair.coles)}
      </div>
      <div class="match-meta">${badge}<p class="save-text">Difference: $${pair.saving.toFixed(2)}</p></div>
    `;
    container.appendChild(row);
  });

  section.classList.remove('hidden');
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

  sorted.forEach((item) => {
    const card = document.createElement('div');
    const isCheapest = item.price === cheapest;
    card.className = `product-card${isCheapest ? ' cheapest' : ''}`;

    card.innerHTML = `
      ${buildLinkedImage(item, 'product-thumb')}
      <p class="product-name">${buildProductNameLink(item)}</p>
      ${buildPriceBlock(item)}
      ${isCheapest ? '<p class="cheapest-label">Lowest price</p>' : ''}
      <button class="select-btn" type="button">Add to list</button>
    `;

    card.querySelector('.select-btn').addEventListener('click', () => {
      addToCart(item);
    });

    container.appendChild(card);
  });
}

/** Link tới trang sản phẩm gốc (mở tab mới) */
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
  return `<div class="price-row">${priceHtml}${specialTag}</div>`;
}

/** Tag SPECIAL hoặc SAVE $X khi sản phẩm đang giảm giá */
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

renderCartPanel();
