const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const userDataDir = path.join(__dirname, 'user_data');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  });
  const page = context.pages()[0] || (await context.newPage());
  const jsonUrls = [];

  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const url = res.url();
    if (!url.includes('coles')) return;
    try {
      const body = await res.json();
      jsonUrls.push({
        url: url.slice(0, 150),
        topKeys: Object.keys(body),
        hasResults: !!body.Results,
        hasProducts: !!body.products,
        hasData: !!body.data,
      });
    } catch (_) {}
  });

  await page.goto('https://www.coles.com.au/search/products?q=milk', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForTimeout(15000);

  const dom = await page.evaluate(() => ({
    title: document.title,
    tiles: document.querySelectorAll('section[data-testid="product-tile"]').length,
    sample: Array.from(
      document.querySelectorAll('section[data-testid="product-tile"]')
    )
      .slice(0, 3)
      .map((el) => ({
        name: el.querySelector('.product__title')?.innerText?.trim(),
        price: el.querySelector('.price__value')?.innerText?.trim(),
      })),
  }));

  console.log('dom', JSON.stringify(dom, null, 2));
  console.log('json', JSON.stringify(jsonUrls.slice(0, 15), null, 2));
  await context.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
