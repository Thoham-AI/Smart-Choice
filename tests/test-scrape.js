const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
  );

  console.log('WW...');
  await page.goto('https://www.woolworths.com.au/shop/search/products?searchTerm=milk', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 8000));
  const ww = await page.evaluate(() => {
    const selectors = [
      'wc-product-tile',
      '.product-tile-v2',
      '[data-testid="product-tile"]',
      'article',
    ];
    const counts = {};
    for (const s of selectors) counts[s] = document.querySelectorAll(s).length;
    return { counts, title: document.title, bodyLen: document.body?.innerText?.length };
  });
  console.log('WW', JSON.stringify(ww, null, 2));

  console.log('Coles...');
  await page.goto('https://www.coles.com.au/search?q=milk', {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 8000));
  const coles = await page.evaluate(() => {
    const selectors = [
      'section[data-testid="product-tile"]',
      '.price__value',
      '[data-testid="product-tile"]',
      'article',
    ];
    const counts = {};
    for (const s of selectors) counts[s] = document.querySelectorAll(s).length;
    return {
      counts,
      title: document.title,
      samplePrice: document.querySelector('.price__value')?.innerText,
    };
  });
  console.log('Coles', JSON.stringify(coles, null, 2));

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
