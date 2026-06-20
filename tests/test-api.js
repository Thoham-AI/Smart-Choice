async function testWoolworths(query) {
  const res = await fetch('https://www.woolworths.com.au/apis/ui/Search/products', {
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
      PageSize: 12,
      SearchTerm: query,
      SortType: 'TraderRelevance',
      IsHideEverydayMarketProducts: false,
      IsRegisteredRewardCardPromotion: null,
      ExcludeSearchTypes: ['UntraceableVendors'],
      GpBoost: 0,
      GroupEdmVariants: false,
      EnableAdReRanking: false,
    }),
  });
  console.log('WW status', res.status);
  const data = await res.json();
  const flat = [];
  for (const group of data?.Products || []) {
    for (const p of group?.Products || []) {
      flat.push({
        name: p.DisplayName || p.Name,
        price: p.Price,
        unit: p.PackageSize,
      });
    }
  }
  console.log('WW', JSON.stringify(flat.slice(0, 5), null, 2));
}

async function testColesApi(query) {
  const url = new URL('https://api.coles.com.au/customer/v1/coles/products/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '12');
  url.searchParams.set('start', '0');
  url.searchParams.set('storeId', '7716');
  url.searchParams.set('type', 'SKU');

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-Coles-API-Key': 'coles-api-key',
    },
  });
  console.log('Coles API status', res.status);
  const text = await res.text();
  console.log('Coles API', text.slice(0, 800));
}

(async () => {
  await testWoolworths('milk');
  await testColesApi('milk');
})().catch(console.error);
