/**
 * Unit test: generic broccoli must not match Chinese/Asian broccoli variants.
 * Run: node test-produce-match.js
 * Debug logs: MATCH_DEBUG=1 node test-produce-match.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { __matchingTest__ } = require('./api/index.js');
const {
  scoreSmartMatchPair,
  scoreProductPair,
  buildSmartComparePairs,
  matchQualifiersCompatible,
  produceVariantConflict,
  varietiesCompatible,
} = __matchingTest__;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const woolBroccoli = {
  name: 'Fresh Broccoli each',
  price: 3.5,
  supermarket: 'Woolworths',
  categoryBucket: 'fruit_veg',
};

const colesChineseBroccoli = {
  name: 'Coles Asian Choy Chinese Broccoli 1 each',
  price: 4.2,
  supermarket: 'Coles',
  categoryBucket: 'fruit_veg',
};

const colesBroccoli = {
  name: 'Coles Fresh Broccoli 1 each',
  price: 3.8,
  supermarket: 'Coles',
  categoryBucket: 'fruit_veg',
};

const woolOrganicBroccoli = {
  name: 'Organic Broccoli each',
  price: 5,
  supermarket: 'Woolworths',
  categoryBucket: 'fruit_veg',
};

// Qualifier asymmetry
assert(
  !matchQualifiersCompatible(woolBroccoli.name, colesChineseBroccoli.name).ok,
  'Chinese/Asian/Choy qualifiers must not match generic broccoli'
);
assert(produceVariantConflict(woolBroccoli.name, colesChineseBroccoli.name), 'produce variant conflict');
assert(!varietiesCompatible(woolBroccoli.name, colesChineseBroccoli.name), 'varieties incompatible');

// Scoring rejects bad pair
const badSmart = scoreSmartMatchPair(woolBroccoli, colesChineseBroccoli);
const badLegacy = scoreProductPair(woolBroccoli, colesChineseBroccoli);
assert(badSmart < 0, `scoreSmartMatchPair should reject (got ${badSmart})`);
assert(badLegacy === 0, `scoreProductPair should reject (got ${badLegacy})`);

// Generic broccoli pairs OK
const goodSmart = scoreSmartMatchPair(woolBroccoli, colesBroccoli);
const goodLegacy = scoreProductPair(woolBroccoli, colesBroccoli);
assert(goodSmart >= 0.55, `generic pair should score high (got ${goodSmart})`);
assert(goodLegacy >= 0.58, `generic legacy pair should pass (got ${goodLegacy})`);

// Organic vs conventional rejected
assert(!matchQualifiersCompatible(woolOrganicBroccoli.name, colesBroccoli.name).ok, 'organic asymmetry');
assert(scoreSmartMatchPair(woolOrganicBroccoli, colesBroccoli) < 0, 'organic vs conventional rejected');

// Greedy pairing prefers correct Coles line
const { pairs } = buildSmartComparePairs([woolBroccoli], [colesChineseBroccoli, colesBroccoli]);
assert(pairs.length === 1, 'should pair one row');
assert(/broccoli/i.test(pairs[0].coles.name), 'should pair with broccoli');
assert(!/chinese|asian|choy/i.test(pairs[0].coles.name), 'must not pair Chinese broccoli variant');

console.log('test-produce-match.js: all assertions passed');
