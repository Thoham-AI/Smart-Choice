/**
 * ALDI Australia product search via the public catalog API (api.aldi.com.au).
 * Used by SmartChoice api/index.js — results are cached in MongoDB like Coles/Woolworths.
 */

const axios = require('axios');

const ALDI_SEARCH_BASE = 'https://api.aldi.com.au/v3/product-search';
/** API only accepts specific page sizes. */
const ALDI_VALID_LIMITS = [12, 16, 24, 30, 32, 48, 60];
const ALDI_SEARCH_TIMEOUT_MS = 15000;

/** Header giống trình duyệt thật — giảm chặn bot trên Vercel/serverless. */
const ALDI_BROWSER_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: 'https://www.aldi.com.au',
  Referer: 'https://www.aldi.com.au/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
};

/**
 * Pick the smallest valid limit >= desired count (capped at 60).
 * @param {number} desired
 * @returns {number}
 */
function pickAldiPageLimit(desired) {
  const n = Math.max(1, Math.min(60, Number(desired) || 24));
  for (const limit of ALDI_VALID_LIMITS) {
    if (limit >= n) return limit;
  }
  return 60;
}

/**
 * Build a product page URL on aldi.com.au.
 * @param {string} slug
 * @param {string} sku
 */
function buildAldiProductUrl(slug, sku) {
  const s = String(slug || '').trim();
  const id = String(sku || '').replace(/\D/g, '');
  if (!s || !id) return '';
  return `https://www.aldi.com.au/product/${s}/p/${id}`;
}

/**
 * Resolve a display-ready image URL from ALDI asset templates.
 * @param {object} item
 * @returns {string}
 */
function resolveAldiImageUrl(item) {
  const asset = Array.isArray(item?.assets)
    ? item.assets.find((a) => a?.url && a.assetType === 'FR01') || item.assets[0]
    : null;
  if (!asset?.url) return '';

  const slug = String(item.urlSlugText || item.sku || 'product').trim();
  return String(asset.url)
    .replace('{width}', '400')
    .replace('{slug}', encodeURIComponent(slug));
}

/**
 * Map one ALDI API product to a raw object consumed by normalizeItem() in index.js.
 * @param {object} item
 * @returns {object|null}
 */
function mapAldiApiProductToRaw(item) {
  if (!item || typeof item !== 'object') return null;

  const cents = Number(item.price?.amount);
  if (!Number.isFinite(cents) || cents <= 0) return null;

  const price = Number((cents / 100).toFixed(2));
  const brand = String(item.brandName || '').trim();
  const size = String(item.sellingSize || '').trim();
  const name = String(item.name || '').trim();
  if (!name) return null;

  const displayName = brand ? `${brand} ${name}`.trim() : name;
  const comparisonDisplay = String(item.price?.comparisonDisplay || '').trim();
  const slug = String(item.urlSlugText || '').trim();
  const sku = String(item.sku || '').trim();

  let unit_price_text = comparisonDisplay || null;
  const per100Cents = Number(item.price?.comparison);
  if (!unit_price_text && Number.isFinite(per100Cents) && per100Cents > 0) {
    unit_price_text = `$${(per100Cents / 100).toFixed(2)} / 100 g`;
  }

  return {
    name: displayName,
    brand,
    size,
    price,
    current_price: price,
    unit_price: unit_price_text,
    image: resolveAldiImageUrl(item),
    sku,
    slug,
    url: buildAldiProductUrl(slug, sku),
    product_id: sku,
    _aldiSku: sku,
    notForSale: Boolean(item.notForSale),
  };
}

/**
 * Search ALDI Australia and return raw product rows for normalizeRawList().
 * Không throw — lỗi mạng / 403 → [] để UI hiện ô trống nét đứt, không “Could not reach ALDI”.
 * @param {string} keyword
 * @param {number} [maxItems]
 * @returns {Promise<object[]>}
 */
async function fetchAldiSearchRawList(keyword, maxItems = 24, opts = {}) {
  const query = String(keyword || '').trim();
  if (!query) return [];

  const limit = pickAldiPageLimit(maxItems);
  const timeout =
    Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : ALDI_SEARCH_TIMEOUT_MS;

  try {
    const response = await axios.get(ALDI_SEARCH_BASE, {
      params: { query, limit, page: 1 },
      headers: {
        ...ALDI_BROWSER_HEADERS,
        Referer: `https://www.aldi.com.au/results?q=${encodeURIComponent(query)}`,
      },
      timeout,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 404 || response.status === 204) {
      return [];
    }
    if (response.status >= 400) {
      console.warn(`  ⚠ ALDI API HTTP ${response.status} for "${query}"`);
      return [];
    }

    const list = Array.isArray(response.data?.data) ? response.data.data : [];
    const mapped = list.map(mapAldiApiProductToRaw).filter(Boolean);

    const qLower = query.toLowerCase();
    const tokens = qLower.split(/\s+/).filter((t) => t.length > 1);

    mapped.sort((a, b) => {
      const saleDiff = Number(a.notForSale) - Number(b.notForSale);
      if (saleDiff !== 0) return saleDiff;

      const score = (item) => {
        const name = String(item.name || '').toLowerCase();
        if (!tokens.length) return 0;
        if (name.includes(qLower)) return 0;
        if (tokens.some((t) => name.includes(t))) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

    return mapped.slice(0, maxItems);
  } catch (error) {
    const code = error?.code || '';
    const status = error?.response?.status;
    console.warn(
      `  ⚠ ALDI search error (${code || status || 'unknown'}):`,
      error?.message || error
    );
    return [];
  }
}

module.exports = {
  fetchAldiSearchRawList,
  pickAldiPageLimit,
  mapAldiApiProductToRaw,
};
