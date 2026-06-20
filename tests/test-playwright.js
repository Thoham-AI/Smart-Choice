const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const apiHits = [];

  page.on('response', async (res) => {
    const url = res.url();
    if (
      url.includes('coles') &&
      (url.includes('search') || url.includes('product')) &&
      res.headers()['content-type']?.includes('json')
    ) {
      try {
        const json = await res.json();
        apiHits.push({ url: url.slice(0, 120), keys: Object.keys(json) });
      } catch (_) {}
    }
  });

  await page.goto('https://www.coles.com.au/search/products?q=milk', {
    waitUntil: 'networkidle',
    timeout: 120000,
  });
  await page.waitForTimeout(12000);

  const coles = await page.evaluate(() => ({
    title: document.title,
    htmlLen: document.documentElement?.outerHTML?.length,
    tiles: document.querySelectorAll('section[data-testid="product-tile"]').length,
    nextData: !!document.querySelector('#__NEXT_DATA__'),
    nextSnippet: document.querySelector('#__NEXT_DATA__')?.textContent?.slice(0, 200),
  }));

  console.log('page', JSON.stringify(coles, null, 2));
  console.log('apiHits', JSON.stringify(apiHits.slice(0, 8), null, 2));

  await page.screenshot({ path: 'test-coles.png', fullPage: false });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
