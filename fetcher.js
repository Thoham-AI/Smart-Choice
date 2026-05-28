const path = require('path');
const { chromium } = require('playwright');

const USER_DATA_DIR = path.join(__dirname, 'user_data');
const DEFAULT_LIMIT = 8;

let browserContextPromise = null;
let browserQueue = Promise.resolve();

function runInBrowserQueue(task) {
  const run = browserQueue.then(task, task);
  browserQueue = run.catch(() => {});
  return run;
}

function normalizePrice(value) {
  const num = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function getBrowserContext() {
  if (!browserContextPromise) {
    browserContextPromise = chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: process.env.HEADLESS !== 'false',
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      locale: 'en-AU',
    });
  }
  return browserContextPromise;
}

async function searchWoolworthsApi(query, limit) {
  const res = await fetch(
    'https://www.woolworths.com.au/apis/ui/Search/products',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: 'https://www.woolworths.com.au',
        Referer: `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(query)}`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        Filters: [],
        IsSpecial: false,
        Location: `/shop/search/products?searchTerm=${query}`,
        PageNumber: 1,
        PageSize: limit,
        SearchTerm: query,
        SortType: 'TraderRelevance',
        IsHideEverydayMarketProducts: false,
        IsRegisteredRewardCardPromotion: null,
        ExcludeSearchTypes: ['UntraceableVendors'],
        GpBoost: 0,
        GroupEdmVariants: false,
        EnableAdReRanking: false,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Woolworths API status ${res.status}`);
  }

  const data = await res.json();
  return parseWoolworthsPayload(data, limit);
}

function parseWoolworthsPayload(data, limit) {
  const products = [];
  for (const group of data?.Products || []) {
    for (const item of group?.Products || []) {
      const price = normalizePrice(item.Price);
      if (!price) continue;
      products.push({
        name: item.DisplayName || item.Name,
        price,
        unit: item.PackageSize || item.Unit || null,
        image: item.MediumImageFile || item.SmallImageFile || null,
        store: 'woolworths',
      });
      if (products.length >= limit) return products;
    }
  }
  return products;
}

async function searchWoolworthsBrowser(query, limit) {
  return runInBrowserQueue(async () => {
    const context = await getBrowserContext();
    const page = await context.newPage();
    try {
      await page.goto('https://www.woolworths.com.au/', {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });

      const data = await page.evaluate(
        async ({ searchTerm, pageSize }) => {
          const res = await fetch('/apis/ui/Search/products', {
            method: 'POST',
            headers: {
              Accept: 'application/json, text/plain, */*',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              Filters: [],
              IsSpecial: false,
              Location: `/shop/search/products?searchTerm=${searchTerm}`,
              PageNumber: 1,
              PageSize: pageSize,
              SearchTerm: searchTerm,
              SortType: 'TraderRelevance',
              IsHideEverydayMarketProducts: false,
              IsRegisteredRewardCardPromotion: null,
              ExcludeSearchTypes: ['UntraceableVendors'],
              GpBoost: 0,
              GroupEdmVariants: false,
              EnableAdReRanking: false,
            }),
          });
          if (!res.ok) {
            throw new Error(`Woolworths in-page API status ${res.status}`);
          }
          return res.json();
        },
        { searchTerm: query, pageSize: limit }
      );

      const fromApi = parseWoolworthsPayload(data, limit);
      if (fromApi.length) return fromApi;

      await page.goto(
        `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(query)}`,
        { waitUntil: 'domcontentloaded', timeout: 90000 }
      );
      await page.waitForTimeout(5000);
      const raw = await page.evaluate((max) => {
        const findDeepText = (root, selector) => {
          const el = root.querySelector(selector);
          if (el) return el.innerText;
          for (const node of root.querySelectorAll('*')) {
            if (node.shadowRoot) {
              const found = findDeepText(node.shadowRoot, selector);
              if (found) return found;
            }
          }
          return null;
        };

        const tiles = Array.from(
          document.querySelectorAll('wc-product-tile, .product-tile-v2')
        ).slice(0, max);

        return tiles.map((tile) => ({
          name: (
            findDeepText(tile, '.title') ||
            findDeepText(tile, '.product-title-link') ||
            tile.innerText?.trim() ||
            'Woolworths item'
          ).trim(),
          price: (
            findDeepText(tile, '.primary') ||
            findDeepText(tile, '.product-tile-price') ||
            ''
          ).trim(),
        }));
      }, limit);

      return raw
        .map((item) => ({
          name: item.name,
          price: normalizePrice(item.price),
          unit: null,
          image: null,
          store: 'woolworths',
        }))
        .filter((item) => item.price);
    } finally {
      await page.close().catch(() => {});
    }
  });
}

async function searchWoolworths(query, limit = DEFAULT_LIMIT) {
  try {
    const apiResults = await searchWoolworthsApi(query, limit);
    if (apiResults.length) return apiResults;
  } catch (err) {
    console.warn('Woolworths API failed, using browser:', err.message);
  }
  return searchWoolworthsBrowser(query, limit);
}

async function searchColes(query, limit = DEFAULT_LIMIT) {
  return runInBrowserQueue(async () => {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
  await page.goto(
    `https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`,
    { waitUntil: 'domcontentloaded', timeout: 90000 }
  );

  await page
    .waitForSelector('section[data-testid="product-tile"] .price__value', {
      timeout: 25000,
    })
    .catch(() => null);

  const raw = await page.evaluate((max) => {
    const tiles = Array.from(
      document.querySelectorAll('section[data-testid="product-tile"]')
    ).slice(0, max);

    return tiles.map((tile) => ({
      name: tile.querySelector('.product__title')?.innerText?.trim() || 'Coles item',
      price: tile.querySelector('.price__value')?.innerText?.trim() || '',
      image:
        tile.querySelector('img')?.src ||
        tile.querySelector('img')?.getAttribute('data-src') ||
        null,
    }));
  }, limit);

  return raw
    .map((item) => ({
      name: item.name,
      price: normalizePrice(item.price),
      unit: null,
      image: item.image,
      store: 'coles',
    }))
    .filter((item) => item.price);
  } finally {
    await page.close().catch(() => {});
  }
  });
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function similarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) {
    if (tb.has(t)) overlap += 1;
  }
  return overlap / Math.max(ta.size, tb.size);
}

function buildComparison(woolworths, coles) {
  const pairs = [];
  const usedColes = new Set();

  for (const wItem of woolworths) {
    let best = null;
    let bestScore = 0;

    coles.forEach((cItem, index) => {
      if (usedColes.has(index)) return;
      const score = similarity(wItem.name, cItem.name);
      if (score > bestScore) {
        bestScore = score;
        best = { cItem, index };
      }
    });

    if (!best || bestScore < 0.35) continue;
    usedColes.add(best.index);

    const colesPrice = best.cItem.price;
    const wooliesPrice = wItem.price;
    const cheaper =
      wooliesPrice < colesPrice
        ? 'woolworths'
        : colesPrice < wooliesPrice
          ? 'coles'
          : 'tie';
    const saving = Math.abs(wooliesPrice - colesPrice);

    pairs.push({
      woolworths: wItem,
      coles: best.cItem,
      cheaper,
      saving: Number(saving.toFixed(2)),
      matchScore: Number(bestScore.toFixed(2)),
    });
  }

  const wwMin = woolworths.length
    ? Math.min(...woolworths.map((p) => p.price))
    : null;
  const colesMin = coles.length ? Math.min(...coles.map((p) => p.price)) : null;

  return {
    pairs: pairs.slice(0, 6),
    cheapest: {
      woolworths: wwMin,
      coles: colesMin,
      store:
        wwMin == null || colesMin == null
          ? null
          : wwMin < colesMin
            ? 'woolworths'
            : colesMin < wwMin
              ? 'coles'
              : 'tie',
      difference:
        wwMin != null && colesMin != null
          ? Number(Math.abs(wwMin - colesMin).toFixed(2))
          : null,
    },
  };
}

async function searchBoth(query, limit = DEFAULT_LIMIT) {
  const woolworths = await searchWoolworths(query, limit);
  const coles = await searchColes(query, limit);

  return {
    query,
    woolworths,
    coles,
    comparison: buildComparison(woolworths, coles),
  };
}

async function closeBrowser() {
  if (browserContextPromise) {
    const ctx = await browserContextPromise;
    await ctx.close();
    browserContextPromise = null;
  }
}

module.exports = {
  searchWoolworths,
  searchColes,
  searchBoth,
  closeBrowser,
};
