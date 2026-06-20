/**
 * Unit test: chicken thigh must not match Thigh Burger; prefer fresh $/kg.
 * Run: node tests/test-chicken-thigh-match.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { __matchingTest__ } = require('../api/index.js');
const {
  nameSuggestsProcessedNotCoreIngredient,
  searchIntentSuggestsRawIngredient,
  pickBestProductMatch,
  filterProductsForSearchIntent,
  getProductComparablePricePerKg,
} = __matchingTest__;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const keyword = 'chicken thigh';
const listItem = { keyword, quantity: 1, unit: 'kg' };

const mockProducts = [
  {
    name: 'Coles Finest Chicken Thigh Burger 4 Pack',
    price: 12,
    packShelfPrice: 12,
    pricePerKg: 250,
    packWeightKg: 0.048,
    supermarket: 'Coles',
    categoryBucket: 'meat_seafood',
  },
  {
    name: 'RSPCA Approved Chicken Thigh Fillet per kg',
    price: 9.5,
    packShelfPrice: 9.5,
    pricePerKg: 9.5,
    packWeightKg: 1,
    supermarket: 'Coles',
    categoryBucket: 'meat_seafood',
  },
  {
    name: 'Woolworths RSPCA Chicken Thigh Fillet per kg',
    price: 10,
    packShelfPrice: 10,
    pricePerKg: 10,
    packWeightKg: 1,
    supermarket: 'Woolworths',
    categoryBucket: 'meat_seafood',
  },
  {
    name: 'Chicken Thigh Schnitzel 400g',
    price: 8,
    packShelfPrice: 8,
    pricePerKg: 20,
    packWeightKg: 0.4,
    supermarket: 'Coles',
    categoryBucket: 'meat_seafood',
  },
];

if (!pickBestProductMatch) {
  console.error('Test hooks missing');
  process.exit(1);
}

const filtered = filterProductsForSearchIntent(mockProducts, keyword, listItem);
assert(
  !filtered.some((p) => /burger|schnitzel/i.test(p.name)),
  'Processed items should be filtered out'
);

const picked = pickBestProductMatch(mockProducts, keyword, listItem);
assert(picked.product, 'Should pick a product');
assert(/fillet|thigh/i.test(picked.product.name), 'Should pick fresh thigh');
assert(!/burger|schnitzel/i.test(picked.product.name), 'Must not pick processed food');
assert(
  getProductComparablePricePerKg(picked.product) < 50,
  'Should prefer sane $/kg not $250 burger'
);

assert(
  nameSuggestsProcessedNotCoreIngredient('Chicken Thigh Burger', keyword),
  'Thigh Burger must be flagged as processed mismatch'
);
assert(searchIntentSuggestsRawIngredient(keyword, listItem), 'chicken thigh is raw intent');

console.log('OK chicken thigh matching');
console.log('  picked:', picked.product.name, '@ $' + picked.product.pricePerKg + '/kg');
