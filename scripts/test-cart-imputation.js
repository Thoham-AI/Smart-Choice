/**
 * Quick offline test for single-store price imputation (no API calls).
 */
function storeLineHasUsablePrice(line, store) {
  if (store === 'coles') {
    return Boolean(line.coles) && Number(line.colesLinePrice) > 0;
  }
  return Boolean(line.woolworths) && Number(line.woolworthsLinePrice) > 0;
}

function enrichLineWithSingleStorePricing(line) {
  const colesUsable = storeLineHasUsablePrice(line, 'coles');
  const woolUsable = storeLineHasUsablePrice(line, 'woolworths');
  const colesActual = colesUsable ? Number(line.colesLinePrice) : 0;
  const woolActual = woolUsable ? Number(line.woolworthsLinePrice) : 0;

  let colesSingleStorePrice = colesActual;
  let woolSingleStorePrice = woolActual;
  let colesIncomplete = false;
  let woolIncomplete = false;

  if (!colesUsable && woolUsable) {
    colesSingleStorePrice = woolActual;
    colesIncomplete = true;
  }
  if (!woolUsable && colesUsable) {
    woolSingleStorePrice = colesActual;
    woolIncomplete = true;
  }

  return {
    ...line,
    colesSingleStorePrice: Number(colesSingleStorePrice.toFixed(2)),
    woolworthsSingleStorePrice: Number(woolSingleStorePrice.toFixed(2)),
    colesIncomplete,
    woolIncomplete,
  };
}

function buildCartOptimization(lineItems) {
  let colesOnlyTotal = 0;
  let woolworthsOnlyTotal = 0;
  for (const line of lineItems) {
    colesOnlyTotal += line.colesSingleStorePrice ?? line.colesLinePrice ?? 0;
    woolworthsOnlyTotal += line.woolworthsSingleStorePrice ?? line.woolworthsLinePrice ?? 0;
  }
  return { colesOnlyTotal, woolworthsOnlyTotal };
}

const rice = enrichLineWithSingleStorePricing({
  request: { keyword: 'rice' },
  coles: null,
  woolworths: { name: 'SunRice 10kg', price: 48 },
  colesLinePrice: 0,
  woolworthsLinePrice: 48,
});

const milk = enrichLineWithSingleStorePricing({
  request: { keyword: 'milk' },
  coles: { name: 'Coles Milk', price: 3.55 },
  woolworths: { name: 'WW Milk', price: 3.55 },
  colesLinePrice: 3.55,
  woolworthsLinePrice: 3.55,
});

const totals = buildCartOptimization([rice, milk]);

console.assert(rice.colesSingleStorePrice === 48, 'rice Coles imputed price');
console.assert(rice.colesIncomplete === true, 'rice Coles incomplete flag');
console.assert(totals.colesOnlyTotal === 51.55, 'Coles-only total includes imputed rice');
console.log('OK', totals);
