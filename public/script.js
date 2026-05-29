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

document.getElementById('analyzeListBtn')?.addEventListener('click', analyzeShoppingList);

renderCartPanel();

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
  section.classList.remove('hidden');
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

  document.getElementById('ai-parse-info').innerHTML = `
    <p>Detected <strong>${parsedItems.length}</strong> items
    ${parseSource === 'openai' ? '(via AI)' : '(via local parser)'}:</p>
    <ul class="ai-parsed-list">
      ${parsedItems
        .map(
          (item) =>
            `<li>${escapeHtml(item.keyword)} — ${item.quantity} ${escapeHtml(item.unit)}</li>`
        )
        .join('')}
    </ul>
  `;

  document.getElementById('ai-totals-grid').innerHTML = `
    <div class="ai-total-card">
      <h3>All at Coles</h3>
      <p class="amount">$${(opt.colesOnlyTotal || 0).toFixed(2)}</p>
    </div>
    <div class="ai-total-card">
      <h3>All at Woolworths</h3>
      <p class="amount">$${(opt.woolworthsOnlyTotal || 0).toFixed(2)}</p>
    </div>
    <div class="ai-total-card highlight">
      <h3>Split cart (best)</h3>
      <p class="amount">$${(opt.splitTotal || 0).toFixed(2)}</p>
    </div>
  `;

  const savingsEl = document.getElementById('ai-savings-banner');
  if (opt.savings?.amount > 0) {
    savingsEl.innerHTML = `Split cart saves <strong>$${opt.savings.amount.toFixed(2)}</strong> (<strong>${opt.savings.percent}%</strong>) compared to buying everything at ${escapeHtml(opt.savings.comparedTo || 'one store')}.`;
  } else if (opt.splitTotal > 0) {
    savingsEl.textContent =
      'Split cart matches the cheapest single-store total for this list.';
  } else {
    savingsEl.textContent = 'No matching products found. Try different keywords.';
  }

  renderAiSplitCart(opt.splitCart);
  renderAiLineItems(lineItems);
}

function renderAiSplitCart(splitCart) {
  const container = document.getElementById('ai-split-details');
  if (!splitCart) {
    container.innerHTML = '';
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
      <p class="request-label">${escapeHtml(entry.request.keyword)} (${entry.request.quantity} ${escapeHtml(entry.request.unit)})</p>
      <p class="product-title">${escapeHtml(entry.product?.name || '—')}</p>
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
      <p class="line-header">${escapeHtml(line.request.keyword)} — ${line.request.quantity} ${escapeHtml(line.request.unit)}</p>
      <div class="ai-line-stores">
        <div class="${colesClass}">
          <strong>Coles</strong>
          ${
            line.coles
              ? `<p>${escapeHtml(line.coles.name)}</p><p>$${line.colesLinePrice.toFixed(2)}</p>`
              : '<p class="missing">No match</p>'
          }
        </div>
        <div class="${woolClass}">
          <strong>Woolworths</strong>
          ${
            line.woolworths
              ? `<p>${escapeHtml(line.woolworths.name)}</p><p>$${line.woolworthsLinePrice.toFixed(2)}</p>`
              : '<p class="missing">No match</p>'
          }
        </div>
      </div>
    `;
    container.appendChild(row);
  });
}
