/**
 * Unit test: generic broccoli must not match Chinese/Asian broccoli variants.
 * Run: node test-produce-match.js
 * Debug logs: MATCH_DEBUG=1 node test-produce-match.js
 */
const path = require('path');
process.env.NODE_ENV = 'production';
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
  hasCrossDepartmentFoodNonFoodMismatch,
  hasBulkVsMicroWeightMismatch,
  nameSuggestsNonFoodProductTitle,
  nameBorrowedProduceKeywordForPantry,
  nameSuggestsShelfStableProducePack,
  isGenuineFreshProduceForIntent,
  productConflictsWithWholeProduceRequest,
  evaluatePairingGuardrails,
  normalizeParsedLineItem,
  productMatchesParsedLineMongoFilters,
  filterProductsByParsedLineMongoRules,
  buildMongoProductQueryFilters,
  freshProduceRankingScoreOverride,
  buildAlignedCompareMatrix,
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
const cucumberListItem = {
  clean_query: 'cucumber',
  keyword: 'cucumber',
  is_fresh_produce: true,
  category: 'Fruit & Veg',
  quantity: 1,
  unit: 'each',
};
const cucumberPick = pickBestProductMatch(
  [colesPickledCucumber, colesFreshCucumber],
  'cucumber',
  cucumberListItem
);
assert(cucumberPick.product && !/pickled|jar/i.test(cucumberPick.product.name), 'pickBest avoids pickled cucumber');

// Fresh cucumber must not pair with soap sharing the keyword
const colesCucumberSoap = {
  name: 'Dettol Soap Bar Honeydew & Cucumber 60g',
  price: 4.2,
  supermarket: 'Coles',
  categoryBucket: 'health_beauty',
  categoryLabels: ['Health & Beauty', 'Soap & Body Wash'],
};
assert(nameSuggestsNonFoodProductTitle(colesCucumberSoap.name), 'soap title flagged non-food');
assert(
  hasCrossDepartmentFoodNonFoodMismatch(
    woolCucumber.name,
    woolCucumber,
    colesCucumberSoap.name,
    colesCucumberSoap
  ),
  'cucumber vs soap cross-department mismatch'
);
assert(scoreSmartMatchPair(woolCucumber, colesCucumberSoap) < 0, 'cucumber vs soap smart pair rejected');
assert(scoreProductPair(woolCucumber, colesCucumberSoap) === 0, 'cucumber vs soap legacy pair rejected');

const { pairs: soapPairs } = buildSmartComparePairs(
  [woolCucumber],
  [colesCucumberSoap, colesFreshCucumber]
);
assert(soapPairs.length === 1, 'cucumber should pair despite soap candidate');
assert(!/soap|dettol/i.test(soapPairs[0].coles.name), 'must not pair cucumber with soap');

// Whole watermelon must not pair with candy roller
const colesWatermelonRoller = {
  name: 'Watermelon Roller 20g',
  price: 1.5,
  supermarket: 'Coles',
  categoryBucket: 'confectionery',
  categoryLabels: ['Confectionery', 'Candy'],
};
assert(nameSuggestsNonFoodProductTitle(colesWatermelonRoller.name), 'candy roller flagged non-food');
assert(
  hasBulkVsMicroWeightMismatch(
    woolWatermelon.name,
    woolWatermelon,
    colesWatermelonRoller.name,
    colesWatermelonRoller
  ),
  '8kg watermelon vs 20g roller weight mismatch'
);
assert(scoreSmartMatchPair(woolWatermelon, colesWatermelonRoller) < 0, 'watermelon vs roller rejected');

const { pairs: rollerPairs } = buildSmartComparePairs(
  [woolWatermelon],
  [colesWatermelonRoller, colesWholeWatermelon]
);
assert(rollerPairs.length === 1, 'watermelon should pair despite roller candidate');
assert(!/roller|candy/i.test(rollerPairs[0].coles.name), 'must not pair watermelon with candy roller');

// pickBest must not return soap for cucumber search
const soapPick = pickBestProductMatch(
  [colesCucumberSoap, colesFreshCucumber],
  'cucumber',
  cucumberListItem
);
assert(soapPick.product && !/soap|dettol/i.test(soapPick.product.name), 'pickBest avoids soap');

// Watermelon intent must not match broken rice (brand keyword trap)
const colesWatermelonRice = {
  name: 'Watermelon Broken Rice 1kg',
  price: 3,
  supermarket: 'Coles',
  categoryBucket: 'pantry',
};
const watermelonListItem = {
  clean_query: 'watermelon',
  keyword: 'watermelon',
  is_fresh_produce: true,
  category: 'Fruit & Veg',
  quantity: 2,
  unit: 'each',
};
const cucumberKgListItem = {
  clean_query: 'cucumber',
  keyword: 'cucumber',
  is_fresh_produce: true,
  category: 'Fruit & Veg',
  quantity: 2,
  unit: 'kg',
};

assert(
  nameBorrowedProduceKeywordForPantry(colesWatermelonRice.name, 'watermelon', watermelonListItem),
  'watermelon broken rice pantry trap'
);
assert(
  !isGenuineFreshProduceForIntent(
    colesWatermelonRice.name,
    colesWatermelonRice,
    'watermelon',
    watermelonListItem
  ),
  'broken rice not genuine watermelon'
);
const ricePick = pickBestProductMatch(
  [colesWatermelonRice, colesWholeWatermelon],
  'watermelon',
  watermelonListItem
);
assert(ricePick.product && /watermelon/i.test(ricePick.product.name), 'should pick real watermelon');
assert(!/rice/i.test(ricePick.product.name), 'must not pick broken rice for watermelon');

// Pickled jar cucumber must not match 2kg fresh cucumber intent
const woolPickledCucumber = {
  name: 'Always Fresh Cucumbers Baby 350g',
  price: 4.7,
  supermarket: 'Woolworths',
  categoryBucket: 'pantry',
};
assert(
  nameSuggestsShelfStableProducePack(woolPickledCucumber.name, woolPickledCucumber),
  'always fresh baby cucumber jar flagged'
);
const pickledPick = pickBestProductMatch(
  [woolPickledCucumber, colesFreshCucumber],
  'cucumber',
  cucumberKgListItem
);
assert(
  pickledPick.product && !/always fresh|baby/i.test(pickledPick.product.name),
  'pickBest avoids pickled baby cucumber jar'
);

// Quarter watermelon must not satisfy x2 whole watermelon request
const woolQuarterMelon = {
  name: 'Woolworths Red Watermelon Cut Quarter each',
  price: 8.58,
  supermarket: 'Woolworths',
  categoryBucket: 'fruit_veg',
};
assert(
  productConflictsWithWholeProduceRequest(woolQuarterMelon.name, watermelonListItem),
  'quarter melon conflicts with whole-unit request'
);
const melonPick = pickBestProductMatch([woolQuarterMelon], 'watermelon', watermelonListItem);
assert(melonPick.product == null, 'no match when only quarter melon available for x2 whole');

// 2-step pipeline: parse schema + programmatic Mongo-style filters
const parsedCucumber = normalizeParsedLineItem({
  original_text: 'fresh cucumber (2 kg)',
  clean_query: 'cucumber',
  is_fresh_produce: true,
  category: 'Fruit & Veg',
});
assert(parsedCucumber.clean_query === 'cucumber', 'clean_query normalized');
assert(parsedCucumber.is_fresh_produce === true, 'fresh produce flag');
assert(parsedCucumber.quantity === 2 && parsedCucumber.unit === 'kg', 'qty from original_text');

const arizonaJuice = {
  name: 'Arizona Cucumber Lemonade Fruit Juice Drink 680mL',
  categoryBucket: 'drinks',
  categoryPath: 'Drinks / Juice',
};
const dettolSoap = {
  name: 'Dettol Soap Bar Honeydew & Cucumber 100g',
  categoryBucket: 'household',
  categoryPath: 'Health & Beauty / Soap',
};
const woolworthsCucumberMask = {
  name: 'Sheet Mask - Cucumber',
  categoryBucket: 'health_beauty',
  categoryPath: 'Health & Beauty / Skincare / Face Masks',
  categoryLabels: ['Health & Beauty', 'Skincare'],
};
assert(
  !productMatchesParsedLineMongoFilters(arizonaJuice, cucumberListItem),
  'juice excluded for fresh cucumber'
);
assert(
  !productMatchesParsedLineMongoFilters(dettolSoap, cucumberListItem),
  'soap excluded for fresh cucumber'
);
assert(
  !productMatchesParsedLineMongoFilters(woolworthsCucumberMask, cucumberListItem),
  'skincare sheet mask excluded for fresh cucumber'
);
assert(
  !productMatchesParsedLineMongoFilters(colesWatermelonRice, watermelonListItem),
  'broken rice excluded for fresh watermelon'
);

const h2MelonWater = {
  name: 'H2Melon Watermelon Water 500mL',
  price: 5,
  supermarket: 'Woolworths',
  categoryBucket: 'fruit_veg',
  categoryPath: 'Fruit & Veg',
};
assert(
  !productMatchesParsedLineMongoFilters(h2MelonWater, watermelonListItem),
  'watermelon water excluded for fresh watermelon'
);
assert(
  pickBestProductMatch([h2MelonWater], 'watermelon', watermelonListItem).product == null,
  'only watermelon water returns null'
);
const watermelonWithDrinkPick = pickBestProductMatch(
  [h2MelonWater, colesWholeWatermelon],
  'watermelon',
  watermelonListItem
);
assert(
  watermelonWithDrinkPick.product &&
    /watermelon/i.test(watermelonWithDrinkPick.product.name) &&
    !/water\b|juice|drink|beverage/i.test(watermelonWithDrinkPick.product.name),
  'real watermelon beats watermelon water'
);
assert(
  freshProduceRankingScoreOverride(colesWholeWatermelon, 'watermelon', watermelonListItem) >=
    1000,
  'real watermelon gets massive fresh produce boost'
);
assert(
  freshProduceRankingScoreOverride(h2MelonWater, 'watermelon', watermelonListItem) < 0,
  'watermelon water gets strict fresh produce penalty'
);

const freshCucumberMongoFilter = buildMongoProductQueryFilters(cucumberListItem, 'Woolworths');
assert(
  freshCucumberMongoFilter.$and.some(
    (clause) =>
      clause.department &&
      Array.isArray(clause.department.$in) &&
      clause.department.$in.length === 3 &&
      clause.department.$in.includes('Fruit & Veg') &&
      clause.department.$in.includes('Produce') &&
      clause.department.$in.includes('Fresh')
  ),
  'fresh produce mongo filter allows only produce departments'
);
assert(
  freshCucumberMongoFilter.$and.some(
    (clause) => clause.name?.$not && clause.name.$not.test('Sheet Mask - Cucumber')
  ),
  'fresh produce mongo filter blocks skincare names'
);

const filteredCucumber = filterProductsByParsedLineMongoRules(
  [woolPickledCucumber, colesFreshCucumber, arizonaJuice, woolworthsCucumberMask],
  cucumberKgListItem
);
assert(
  filteredCucumber.length === 1 &&
    /cucumber/i.test(filteredCucumber[0].name) &&
    !/juice|soap|pickled/i.test(filteredCucumber[0].name),
  'mongo filter keeps only genuine fresh cucumber'
);

// Numeric barcode-like searches must not bypass similarity/text filters anymore.
const barcodeKeyword = '9310012345678';
const woolBarcodeHit = {
  name: 'Woolworths Home Brand Milk 2L',
  price: 3.1,
  supermarket: 'Woolworths',
};
const colesBarcodeHit = {
  name: 'Coles Full Cream Milk 2L',
  price: 3,
  supermarket: 'Coles',
};
const barcodeMatrix = buildAlignedCompareMatrix(
  barcodeKeyword,
  { keyword: barcodeKeyword, quantity: 1, unit: 'each' },
  [woolBarcodeHit, woolWatermelon],
  [colesBarcodeHit, colesWholeWatermelon]
);
assert(
  !barcodeMatrix.matrixRows.some(
    (row) => row.woolworths === woolBarcodeHit && row.coles === colesBarcodeHit
  ),
  'numeric search does not blindly pair first Woolworths and Coles hits'
);

// Generic short keywords should survive filtering/scoring even when product names are long.
const toiletMatrix = buildAlignedCompareMatrix(
  'toilet paper',
  { keyword: 'toilet paper', quantity: 1, unit: 'each' },
  [
    {
      name: 'Quilton Toilet Tissue 12pk',
      price: 10,
      supermarket: 'Woolworths',
      categoryBucket: 'household',
    },
  ],
  [
    {
      name: 'Coles Toilet Paper Soft 12 Rolls',
      price: 9,
      supermarket: 'Coles',
      categoryBucket: 'household',
    },
  ]
);
assert(
  toiletMatrix.matrixRows.some((row) => row.woolworths || row.coles),
  'toilet paper generic search should show store results'
);
assert(
  toiletMatrix.matrixRows.some((row) => /toilet tissue/i.test(row.woolworths?.name || '')),
  'toilet paper should match toilet tissue synonym'
);

const eggsMatrix = buildAlignedCompareMatrix(
  'eggs',
  { keyword: 'eggs', quantity: 1, unit: 'each' },
  [
    {
      name: 'Woolworths Free Range Egg 12 Pack',
      price: 6,
      supermarket: 'Woolworths',
      categoryBucket: 'dairy',
    },
  ],
  [
    {
      name: 'Coles Cage Free Eggs 12 Pack',
      price: 5.8,
      supermarket: 'Coles',
      categoryBucket: 'dairy',
    },
  ]
);
assert(
  eggsMatrix.matrixRows.some((row) => row.woolworths || row.coles),
  'eggs generic search should show store results'
);

console.log('test-produce-match.js: all assertions passed');
