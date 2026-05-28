const { searchWoolworths, closeBrowser } = require('./fetcher');

(async () => {
  const items = await searchWoolworths('milk', 5);
  console.log(JSON.stringify(items, null, 2));
  await closeBrowser();
})().catch(async (e) => {
  console.error(e);
  await closeBrowser();
});
