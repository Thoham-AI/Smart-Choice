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
  pickBestProductMatch,
  matchQualifiersCompatible,
  produceVariantConflict,
  varietiesCompatible,
  hasFoodStateFormMismatch,
  hasPackagingFormMismatch,
  evaluatePairingGuardrails,
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

// Fresh cucumber must not pair with pickled jar cucumber
const woolCucumber = {
  name: 'Fresh Cucumber Lebanese 1 each',
  price: 2.5,
  supermarket: 'Woolworths',
  categoryBucket: 'fruit_veg',
};
const colesPickledCucumber = {
  name: 'Coles Green Leaf Pickled Cucumber 680g Jar',
  price: 4.5,
  supermarket: 'Coles',
  categoryBucket: 'pantry',
};
const colesFreshCucumber = {
  name: 'Coles Fresh Lebanese Cucumber 1 each',
  price: 2.8,
  supermarket: 'Coles',
  categoryBucket: 'fruit_veg',
};

assert(hasFoodStateFormMismatch(woolCucumber.name, colesPickledCucumber.name), 'cucumber vs pickle state mismatch');
assert(
  evaluatePairingGuardrails(
    woolCucumber.name,
    woolCucumber,
    colesPickledCucumber.name,
    colesPickledCucumber
  ),
  'cucumber vs pickle guardrail reject'
);
assert(scoreSmartMatchPair(woolCucumber, colesPickledCucumber) < 0, 'pickled cucumber smart pair rejected');
assert(scoreProductPair(woolCucumber, colesPickledCucumber) === 0, 'pickled cucumber legacy pair rejected');
assert(scoreSmartMatchPair(woolCucumber, colesFreshCucumber) >= 0.55, 'fresh cucumber pair allowed');

const { pairs: cucumberPairs } = buildSmartComparePairs(
  [woolCucumber],
  [colesPickledCucumber, colesFreshCucumber]
);
assert(cucumberPairs.length === 1, 'cucumber should pair one row');
assert(!/pickled|jar/i.test(cucumberPairs[0].coles.name), 'must not pair pickled jar cucumber');

// Whole 8 kg watermelon must not pair with 600 g pre-cut fingers
const woolWatermelon = {
  name: 'Seedless Watermelon Whole 8kg',
  price: 12,
  supermarket: 'Woolworths',
  categoryBucket: 'fruit_veg',
};
const colesWatermelonFingers = {
  name: 'Coles Watermelon Fingers 600g',
  price: 6,
  supermarket: 'Coles',
  categoryBucket: 'fruit_veg',
};
const colesWholeWatermelon = {
  name: 'Coles Seedless Watermelon Whole Cut 8kg',
  price: 11.5,
  supermarket: 'Coles',
  categoryBucket: 'fruit_veg',
};

assert(
  hasPackagingFormMismatch(
    woolWatermelon.name,
    woolWatermelon,
    colesWatermelonFingers.name,
    colesWatermelonFingers
  ),
  'watermelon whole vs fingers packaging mismatch'
);
assert(scoreSmartMatchPair(woolWatermelon, colesWatermelonFingers) < 0, 'watermelon fingers smart pair rejected');
assert(scoreProductPair(woolWatermelon, colesWatermelonFingers) === 0, 'watermelon fingers legacy pair rejected');

const { pairs: melonPairs, unmatchedColes: melonUnmatched } = buildSmartComparePairs(
  [woolWatermelon],
  [colesWatermelonFingers, colesWholeWatermelon]
);
assert(melonPairs.length === 1, 'watermelon should pair one row');
assert(!/fingers/i.test(melonPairs[0].coles.name), 'must not pair watermelon fingers');
assert(melonUnmatched.some((p) => /fingers/i.test(p.name)), 'fingers should remain unmatched');

// Coles must never cross-pair with another Coles item
const colesOnlyA = { name: 'Coles Fresh Broccoli 1 each', price: 3.8, supermarket: 'Coles' };
const colesOnlyB = { name: 'Coles Broccoli Florets 350g', price: 4.1, supermarket: 'Coles' };
const { pairs: colesCrossPairs } = buildSmartComparePairs([colesOnlyA], [colesOnlyB]);
assert(colesCrossPairs.length === 0, 'Coles vs Coles must not pair');

// pickBestProductMatch should not return pickled cucumber for fresh intent
const cucumberListItem = { keyword: 'cucumber', quantity: 1, unit: 'each' };
const cucumberPick = pickBestProductMatch(
  [colesPickledCucumber, colesFreshCucumber],
  'cucumber',
  cucumberListItem
);
assert(cucumberPick.product && !/pickled|jar/i.test(cucumberPick.product.name), 'pickBest avoids pickled cucumber');

console.log('test-produce-match.js: all assertions passed');
