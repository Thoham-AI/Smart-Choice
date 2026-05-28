const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext(
    path.join(__dirname, 'user_data'),
    { headless: false, viewport: { width: 1280, height: 900 } }
  );
  const page = await context.newPage();
  await page.goto(
    'https://www.woolworths.com.au/shop/search/products?searchTerm=milk',
    { waitUntil: 'domcontentloaded', timeout: 90000 }
  );
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(8000);

  const raw = await page.evaluate(() => {
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

    const tile = document.querySelector('wc-product-tile, .product-tile-v2');
    if (!tile) return { error: 'no tile' };

    const selectors = [
      '.title',
      '.product-title-link',
      '.primary',
      '.product-tile-price',
      '[class*="price"]',
      'span',
    ];
    const found = {};
    for (const s of selectors) {
      found[s] = findDeepText(tile, s);
    }
    return {
      tag: tile.tagName,
      found,
      innerSample: tile.innerText?.slice(0, 200),
    };
  });

  console.log(JSON.stringify(raw, null, 2));
  await context.close();
})();
