require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function testColes(query) {
  const apiKey = process.env.COLES_API_KEY || '';
  const apiSecret = process.env.COLES_API_SECRET || '';
  if (!apiKey || !apiSecret) {
    console.error('Set COLES_API_KEY and COLES_API_SECRET in .env before running this test.');
    process.exit(1);
  }

  const url = new URL('https://api.coles.com.au/customer/v1/coles/products/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '8');
  url.searchParams.set('start', '0');
  url.searchParams.set('storeId', '7716');
  url.searchParams.set('type', 'SKU');

  const res = await fetch(url, {
    headers: {
      Accept: '*/*',
      'Accept-Language': 'en-AU;q=1',
      'User-Agent': 'Shopmate/3.4.1 (iPhone; iOS 11.4.1; Scale/3.00)',
      'X-Coles-API-Key': apiKey,
      'X-Coles-API-Secret': apiSecret,
    },
  });
  console.log('status', res.status);
  const data = await res.json();
  const results = data?.Results || [];
  console.log(
    JSON.stringify(
      results.slice(0, 5).map((r) => ({
        name: r.Name,
        size: r.Size,
        brand: r.Brand,
        promos: r.Promotions?.map((p) => p.Price),
      })),
      null,
      2
    )
  );
}

testColes('milk').catch(console.error);
