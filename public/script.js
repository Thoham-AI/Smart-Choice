let itemsInList = [];

const API_BASE = 'http://localhost:3000';

const WOOLWORTHS_UNAVAILABLE_MSG =
  'Woolworths API is not connected yet. Only Coles results are shown.';

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
    const woolworths = items.filter((item) => item.supermarket === 'Woolworths');
    const coles = items.filter((item) => item.supermarket === 'Coles');

    renderWoolworthsColumn(wooliesCont, woolworths);
    renderStoreResults(colesCont, coles, 'Coles');
    renderSummary(summaryText, summarySection, woolworths, coles);
    renderMatchedPairs(matchedResults, matchedSection, woolworths, coles);
  } catch (err) {
    const message = err.message || 'Could not load results.';
    wooliesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
    colesCont.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
  } finally {
    searchBtn.disabled = false;
  }
}

function renderWoolworthsColumn(container, products) {
  container.innerHTML = '';
  if (!products.length) {
    container.innerHTML = `<p class="status-text">${WOOLWORTHS_UNAVAILABLE_MSG}</p>`;
    return;
  }
  renderStoreResults(container, products, 'Woolworths');
}

function renderSummary(el, section, woolworths, coles) {
  const wwMin = woolworths.length
    ? Math.min(...woolworths.map((p) => p.price))
    : null;
  const colesMin = coles.length ? Math.min(...coles.map((p) => p.price)) : null;

  if (colesMin == null && wwMin == null) {
    section.classList.add('hidden');
    return;
  }

  let text = '';

  if (colesMin != null) {
    text += `Lowest Coles price: <strong>$${colesMin.toFixed(2)}</strong>. `;
  }

  if (wwMin != null) {
    text += `Lowest Woolworths price: <strong>$${wwMin.toFixed(2)}</strong>. `;
  }

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
    text += 'Woolworths comparison is unavailable until its API is connected.';
  }

  el.innerHTML = text;
  section.classList.remove('hidden');
}

function renderMatchedPairs(container, section, woolworths, coles) {
  if (!woolworths.length || !coles.length) {
    section.classList.add('hidden');
    return;
  }

  const pairs = buildSimplePairs(woolworths, coles);
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
        <p class="product-name">${escapeHtml(pair.woolworths.name)}</p>
        <p class="price-tag">$${pair.woolworths.price.toFixed(2)}</p>
      </div>
      <div class="match-vs">vs</div>
      <div class="match-side">
        <p class="store-label coles">Coles</p>
        <p class="product-name">${escapeHtml(pair.coles.name)}</p>
        <p class="price-tag">$${pair.coles.price.toFixed(2)}</p>
      </div>
      <div class="match-meta">${badge}<p class="save-text">Difference: $${pair.saving.toFixed(2)}</p></div>
    `;
    container.appendChild(row);
  });

  section.classList.remove('hidden');
}

function buildSimplePairs(woolworths, coles) {
  const pairs = [];
  const usedColes = new Set();

  for (const wItem of woolworths.slice(0, 6)) {
    let bestIndex = -1;
    let bestScore = 0;

    coles.forEach((cItem, index) => {
      if (usedColes.has(index)) return;
      const score = nameSimilarity(wItem.name, cItem.name);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex < 0 || bestScore < 0.35) continue;
    usedColes.add(bestIndex);

    const cItem = coles[bestIndex];
    const saving = Math.abs(wItem.price - cItem.price);
    let cheaper = 'tie';
    if (wItem.price < cItem.price) cheaper = 'Woolworths';
    else if (cItem.price < wItem.price) cheaper = 'Coles';

    pairs.push({ woolworths: wItem, coles: cItem, cheaper, saving });
  }

  return pairs;
}

function nameSimilarity(a, b) {
  const ta = new Set(
    String(a)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
  const tb = new Set(
    String(b)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) {
    if (tb.has(t)) overlap += 1;
  }
  return overlap / Math.max(ta.size, tb.size);
}

function renderStoreResults(container, products, storeName) {
  container.innerHTML = '';

  if (!products?.length) {
    container.innerHTML = `<p class="error">No results at ${storeName}.</p>`;
    return;
  }

  const sorted = [...products].sort((a, b) => a.price - b.price);
  const cheapest = sorted[0].price;

  sorted.forEach((item) => {
    const card = document.createElement('div');
    const isCheapest = item.price === cheapest;
    card.className = `product-card${isCheapest ? ' cheapest' : ''}`;

    const imageHtml = item.image
      ? `<img src="${escapeHtml(item.image)}" alt="" class="product-thumb" loading="lazy" />`
      : '';

    card.innerHTML = `
      ${imageHtml}
      <p class="product-name">${escapeHtml(item.name)}</p>
      <p class="price-tag">$${item.price.toFixed(2)}</p>
      ${isCheapest ? '<p class="cheapest-label">Lowest price</p>' : ''}
      <button class="select-btn" type="button">Add to list</button>
    `;

    card.querySelector('.select-btn').addEventListener('click', () => {
      addToShoppingList(item.name, item.price);
    });

    container.appendChild(card);
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addToShoppingList(name, price) {
  if (!price || Number.isNaN(price)) {
    return alert('Cannot add an item without a price.');
  }

  itemsInList.push({ name, price });
  const total = itemsInList.reduce((sum, item) => sum + item.price, 0);

  let totalDisplay = document.getElementById('shopping-total');
  if (!totalDisplay) {
    totalDisplay = document.createElement('div');
    totalDisplay.id = 'shopping-total';
    document.querySelector('.app-container').appendChild(totalDisplay);
  }
  totalDisplay.innerHTML = `<h3>List total: $${total.toFixed(2)} (${itemsInList.length} items)</h3>`;
}

document.getElementById('itemInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchProducts();
});
