const { searchBoth, closeBrowser } = require('../fetcher');

(async () => {
  const result = await searchBoth('milk', 5);
  console.log('WW', result.woolworths.length, result.woolworths[0]);
  console.log('Coles', result.coles.length, result.coles[0]);
  console.log('Comparison', result.comparison.cheapest);
  console.log('Pairs', result.comparison.pairs.length);
  await closeBrowser();
})().catch(async (e) => {
  console.error(e);
  await closeBrowser();
  process.exit(1);
});
