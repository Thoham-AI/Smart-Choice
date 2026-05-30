process.env.NODE_ENV = 'production';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const api = require('./api/index.js');

async function testKeyword(keyword) {
  const listItem = { keyword, quantity: 1, unit: 'each' };
  console.log(`\n==== ${keyword} ====`);

  for (const store of ['Coles', 'Woolworths']) {
    const raw = await api.fetchStoreRawList(store, keyword);
    const items = api.normalizeRawList(raw, store).map((p) =>
      api.applyListItemPricing(p, listItem)
    );
    const match = api.pickBestProductMatch(items, keyword, listItem);
    console.log(
      store,
      'items',
      items.length,
      '→',
      match.product ? `${match.product.name} (${match.score})` : `NO MATCH (top score ${match.score})`
    );
  }
}

(async () => {
  for (const kw of ['watermelon', 'apple', 'lettuce']) {
    await testKeyword(kw);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
