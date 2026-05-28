async function testColes(query) {
  const url = new URL(
    'https://api.coles.com.au/customer/v1/coles/products/search'
  );
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
      'X-Coles-API-Key': '046bc0d4-3854-481f-80dc-85f9e846503d',
      'X-Coles-API-Secret': 'e6ab96ff-453b-45ba-a2be-ae8d7c12cadf',
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
