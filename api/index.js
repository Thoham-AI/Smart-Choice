/**
 * ShoppingSmart – Backend Express (RapidAPI + OpenAI)
 * Local:  npm start  →  http://localhost:3000  (app.listen khi NODE_ENV !== 'production')
 * Vercel: export app cho serverless – không gọi listen
 */

const path = require('path');
const fs = require('fs');

// .env nằm ở thư mục gốc repo (một cấp trên api/)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { AsyncLocalStorage } = require('async_hooks');
const OpenAI = require('openai');
const stringSimilarity = require('string-similarity');
const mongo = require('../lib/mongodb');

/** Thư mục front-end tĩnh: ../public (tương đối với api/index.js) */
const PUBLIC_DIR = path.join(__dirname, '../public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const TERMS_HTML_PATH = path.join(PUBLIC_DIR, 'terms', 'index.html');

// ============================================================
// 1. CẤU HÌNH HẰNG SỐ
// ============================================================
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.RAPID_API_KEY || '';
/** Coles mobile app search API (barcode + keyword) — set COLES_API_KEY / COLES_API_SECRET in .env */
const COLES_MOBILE_API_KEY = String(process.env.COLES_API_KEY || '').trim();
const COLES_MOBILE_API_SECRET = String(process.env.COLES_API_SECRET || '').trim();
const COLES_MOBILE_SEARCH_URL = 'https://api.coles.com.au/customer/v1/coles/products/search';
const BARCODE_DIRECT_API_TIMEOUT_MS = 8000;
const BARCODE_NAME_LOOKUP_TIMEOUT_MS = 4000;
const BARCODE_SCAN_ROUTE_MAX_MS = 28000;
const BARCODE_STORE_LOOKUP_MAX_MS = 4000;
const BARCODE_SCAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COLES_HOST = 'coles-australia-full-catalog-pricing-intelligence-api.p.rapidapi.com';
const WOOLWORTHS_HOST = 'woolworths-australia-product-category-api.p.rapidapi.com';
/** Supported supermarkets for compare + AI cart. */
const SUPPORTED_SUPERMARKETS = ['Coles', 'Woolworths'];

const RESULT_LIMIT = 20; // số sản phẩm tối đa mỗi siêu thị
/** Khi không có cặp WW↔Coles, giới hạn hàng chỉ 1 siêu thị (tránh 20 dòng Coles-only). */
const MAX_ORPHAN_STORE_ROWS = 10;
const SIMILARITY_THRESHOLD = 0.65; // Ngưỡng sau khi đã tính điểm tổng hợp (tên + size + loại)
/** Bật log chi tiết ghép cặp: MATCH_DEBUG=1 node api/index.js */
const MATCH_DEBUG = process.env.MATCH_DEBUG === '1' || process.env.MATCH_DEBUG === 'true';
const LIST_MATCH_THRESHOLD = 0.38; // Ngưỡng chọn sản phẩm khớp nhất cho từng dòng giỏ AI
const API_TIMEOUT_MS = 28000; // RapidAPI search — tránh chờ 60s khi cache miss
const API_MAX_RETRIES = 2;
/** Compare/search ô chính: đủ thời gian RapidAPI phản hồi, ưu tiên cache. */
const COMPARE_API_TIMEOUT_MS = 24000;
const COMPARE_API_MAX_RETRIES = 2;
const COMPARE_ROUTE_MAX_MS = 55000;
const AI_PARSE_TIMEOUT_MS = 12000;
const AI_ANALYZE_ROUTE_MAX_MS = 65000;
/** MongoDB: đủ thời gian cho Atlas local hit cache trước khi phải scrape. */
const MONGO_CONNECT_TIMEOUT_MS = mongo.MONGO_CONNECT_TIMEOUT_MS;
const API_CACHE_READ_TIMEOUT_MS = 5000;
const API_CACHE_STALE_READ_MS = 2000;
const MONGO_COOLDOWN_MS = 90 * 1000;
/** Cache RAM — dùng ngay khi Mongo/API chậm (TTL 30 phút). */
const MEMORY_CACHE_TTL_MS = 30 * 60 * 1000;
const MEMORY_CACHE_MAX_ENTRIES = 300;
/** Tra cứu store ID tối đa — sau đó search chỉ dùng lat/lng. */
const STORE_LOOKUP_MAX_MS = 6000;
const COMPARE_STORE_LOOKUP_MS = 5000;
const STORE_LOCATOR_REQUEST_TIMEOUT_MS = 5000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/** Default map centre (Sydney CBD) when the client does not share GPS coordinates. */
const SYDNEY_DEFAULT_LOCATION = {
  latitude: -33.8688,
  longitude: 151.2093,
  source: 'default',
};

/** State capitals — fallback when only state or postcode prefix is known. */
const AU_STATE_CENTROIDS = {
  NSW: { latitude: -33.8688, longitude: 151.2093 },
  ACT: { latitude: -35.2809, longitude: 149.13 },
  VIC: { latitude: -37.8136, longitude: 144.9631 },
  QLD: { latitude: -27.4698, longitude: 153.0251 },
  SA: { latitude: -34.9285, longitude: 138.6007 },
  WA: { latitude: -31.9505, longitude: 115.8605 },
  TAS: { latitude: -42.8821, longitude: 147.3272 },
  NT: { latitude: -12.4634, longitude: 130.8456 },
};

const AU_STATE_ALIASES = {
  nsw: 'NSW',
  'new south wales': 'NSW',
  act: 'ACT',
  vic: 'VIC',
  victoria: 'VIC',
  qld: 'QLD',
  queensland: 'QLD',
  sa: 'SA',
  'south australia': 'SA',
  wa: 'WA',
  'western australia': 'WA',
  tas: 'TAS',
  tasmania: 'TAS',
  nt: 'NT',
  'northern territory': 'NT',
};

/** In-memory postcode → lat/lng (avoid repeat Nominatim calls). */
const postcodeGeocodeCache = new Map();

/** Per-request user coordinates + optional store overrides (AsyncLocalStorage). */
const requestLocationContext = new AsyncLocalStorage();

/** In-memory cache for nearest store IDs resolved from lat/lng (1 hour TTL). */
const nearestStoreIdCache = new Map();
/** Gom request song song Coles+WW — tránh gọi locator 2 lần cùng lúc. */
const nearestStoreLookupInflight = new Map();
const NEAREST_STORE_CACHE_TTL_MS = 60 * 60 * 1000;

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ============================================================
// 1b. MONGODB – API CACHE (single application database: shoppingsmart)
// ============================================================
const MONGODB_URI = mongo.getUri();
const API_CACHE_COLLECTION = 'api_cache';
/** Normalized search hits — queried by backend matcher (not OpenAI). */
const PRODUCTS_COLLECTION = 'products';
const FRESH_PRODUCE_ALLOWED_DEPARTMENTS = ['Fruit & Veg', 'Produce', 'Fresh'];
const FRESH_PRODUCE_DEPARTMENT_EXCLUSION_RE =
  /health\s*(?:&|and)?\s*beauty|beauty|cosmetics?|baby|household|pet|pets|animals?|sport|sports|fitness|gym/i;
const FRESH_PRODUCE_NAME_EXCLUSION_RE =
  /soap|juice|drink|aloe|arizona|pickled|mix|candy|pack|mask|sheet|cream|lotion|scrub|gel|shampoo|conditioner|skincare|wipes|essential oil|exercise|exerciser|gripper|strengthener|trainer|forearm|vest|weighted|strap|straps|shoulder|breathable|running|hiit|gym|iron sand|sausage|sausages|pork|beef|chicken|meat|cat|cats|dog|dogs|pet|pets|pipette|pipettes|revolution|flea|worm|tick/i;
const FRESH_PRODUCE_REAL_UNIT_SIGNAL_RE = /\b(?:kg|whole|cut|half|quarter|each|pack of|per)\b/i;
const FRESH_PRODUCE_PROCESSED_DRINK_RE =
  /\b(?:water|juice|drink|can|soda|sparkling|powder|beverage)\b/i;
/**
 * Cache tìm kiếm siêu thị (MongoDB native driver, KHÔNG dùng Mongoose model):
 * - Collection: api_cache
 * - _id: "{Supermarket}:{keyword}:{latitude},{longitude}"  (vd: Woolworths:croissant:-12.4586,130.8294)
 * - Fields: supermarket, keyword, payload[], updatedAt, expiresAt
 * - Production: KHÔNG xóa hàng loạt — chỉ deleteOne từng _id khi quá chu kỳ Thứ Tư (Sydney)
 */
/**
 * Price history — MongoDB Bucket Pattern (one document per watchId per calendar month).
 *
 * Collection: price_history
 * _id: "{watchId}::{YYYY-MM}"  e.g. "coles-milk-2L::2026-06"
 *
 * {
 *   watchId, productId, barcode, productName, bucketMonth: "2026-06",
 *   coles_history:    [{ date: "2026-06-07", price: 4.50 }, ...],
 *   woolies_history:  [{ date: "2026-06-07", price: 5.00 }, ...],
 *   createdAt, updatedAt
 * }
 *
 * Daily scraper upserts today's price into the month bucket (no new doc per day).
 * Chart API merges buckets and returns last 100 days as unified chartData[].
 */
const PRICE_HISTORY_COLLECTION = 'price_history';
const PRICE_HISTORY_MAX_DAYS = 100;
const BARCODE_SCAN_COLLECTION = 'barcode_scans';
const SITE_STATS_COLLECTION = 'site_stats';
/** Single document id for global page view counter. */
const SITE_STATS_PAGE_VIEWS_ID = 'page_views';
const API_CACHE_TTL_MS =
  Number(process.env.API_CACHE_TTL_MINUTES) > 0
    ? Number(process.env.API_CACHE_TTL_MINUTES) * 60 * 1000
    : 6 * 60 * 60 * 1000; // 6 hours

/**
 * Siêu thị Úc thường đổi giá khuyến mãi vào Thứ Tư — cache trước mốc Thứ Tư gần nhất (Sydney) coi là quá hạn.
 */
const AU_PRICE_CYCLE_TIMEZONE = 'Australia/Sydney';

/** Ngưỡng $/kg — trên ngưỡng này thường là lỗi chia khối lượng (ví dụ gà ~$50+/kg). */
const MAX_SANE_PRICE_PER_KG = 50;

/** Cache tìm kiếm trong RAM (supermarket:keyword:lat,lng → payload). */
const memoryApiCache = new Map();

async function connectMongo() {
  return mongo.connectMongo({
    apiCacheCollection: API_CACHE_COLLECTION,
    priceHistoryCollection: PRICE_HISTORY_COLLECTION,
    barcodeScanCollection: BARCODE_SCAN_COLLECTION,
  });
}

function isMongoInCooldown() {
  return mongo.isInCooldown();
}

/**
 * 00:00 Thứ Tư gần nhất (đã qua) theo giờ Sydney — mốc bắt đầu chu kỳ giá tuần hiện tại.
 */
function getLastWednesdaySydneyMidnightUtcMs(referenceDate = new Date()) {
  for (let daysBack = 0; daysBack < 8; daysBack += 1) {
    const probe = new Date(referenceDate.getTime() - daysBack * 86400000);
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: AU_PRICE_CYCLE_TIMEZONE,
      weekday: 'long',
    }).format(probe);
    if (weekday !== 'Wednesday') continue;

    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: AU_PRICE_CYCLE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(probe);

    for (let hourUtc = -36; hourUtc <= 36; hourUtc += 1) {
      const [y, m, d] = ymd.split('-').map(Number);
      const instant = Date.UTC(y, m - 1, d, hourUtc, 0, 0, 0);
      const sydneyDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: AU_PRICE_CYCLE_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(instant));
      const sydneyHour = Number(
        new Intl.DateTimeFormat('en-AU', {
          timeZone: AU_PRICE_CYCLE_TIMEZONE,
          hour: 'numeric',
          hour12: false,
        }).format(new Date(instant))
      );
      if (sydneyDate === ymd && sydneyHour === 0) {
        return instant;
      }
    }
  }
  return referenceDate.getTime() - 7 * 86400000;
}

/** Cache Mongo/RAM thuộc chu kỳ giá tuần trước (trước Thứ Tư gần nhất Sydney). */
function isApiCacheBeforeCurrentPriceCycle(updatedAt) {
  if (!updatedAt) return true;
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return true;
  return updatedMs < getLastWednesdaySydneyMidnightUtcMs();
}

function purgeMemoryApiCacheEntry(supermarket, keyword, location) {
  memoryApiCache.delete(buildApiCacheId(supermarket, keyword, location));
}

/**
 * Xóa cache quá chu kỳ Thứ Tư — ép gọi lại API siêu thị lấy giá mới.
 */
async function deleteApiCacheRecord(supermarket, keyword, location) {
  purgeMemoryApiCacheEntry(supermarket, keyword, location);
  const collection = getApiCacheCollection();
  if (!collection) return;
  await collection.deleteOne({
    _id: buildApiCacheId(supermarket, keyword, location),
  });
}

function isApiTimeoutError(error) {
  return (
    error?.code === 'ECONNABORTED' ||
    error?.code === 'ETIMEDOUT' ||
    /timed out after \d+ms/i.test(String(error?.message || ''))
  );
}

/**
 * Production-safe: siêu thị lỗi (timeout, block IP, 403/429/5xx) → trả [] thay vì throw.
 * Chỉ áp dụng Woolworths — Coles vẫn báo lỗi qua safeFetch nếu cần.
 */
function shouldSoftFailStoreRawList(supermarket) {
  return supermarket === 'Woolworths';
}

function logStoreSoftFail(supermarket, keyword, error, apiTimeout) {
  const status = error?.response?.status;
  const detail = status
    ? `HTTP ${status}`
    : isApiTimeoutError(error)
      ? `timeout ${apiTimeout}ms`
      : error?.code || error?.message || 'unknown';
  console.warn(`  ⚠ ${supermarket} soft-fail ("${keyword}"): ${detail} — trả []`);
}

function readMemoryApiCache(supermarket, keyword, location) {
  const id = buildApiCacheId(supermarket, keyword, location);
  const entry = memoryApiCache.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryApiCache.delete(id);
    return null;
  }
  if (isApiCacheBeforeCurrentPriceCycle(entry.updatedAt)) {
    memoryApiCache.delete(id);
    return null;
  }
  if (Array.isArray(entry.payload) && entry.payload.length === 0) return null;
  return entry.payload;
}

function writeMemoryApiCache(supermarket, keyword, payload, location) {
  if (!Array.isArray(payload) || payload.length === 0) return;
  const id = buildApiCacheId(supermarket, keyword, location);
  if (memoryApiCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const firstKey = memoryApiCache.keys().next().value;
    if (firstKey) memoryApiCache.delete(firstKey);
  }
  const now = new Date();
  memoryApiCache.set(id, {
    payload,
    updatedAt: now,
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
  });
}

function getApiCacheCollection() {
  const mongoDb = mongo.getDb();
  if (!mongoDb) return null;
  return mongoDb.collection(API_CACHE_COLLECTION);
}

function getProductsCollection() {
  const mongoDb = mongo.getDb();
  if (!mongoDb) return null;
  return mongoDb.collection(PRODUCTS_COLLECTION);
}

let productsIndexesReady = false;

async function ensureProductsIndexes() {
  if (productsIndexesReady) return;
  const collection = getProductsCollection();
  if (!collection) return;
  await collection.createIndex(
    { supermarket: 1, department: 1, name: 1 },
    { name: 'products_store_dept_name' }
  );
  await collection.createIndex(
    { supermarket: 1, searchKeyword: 1, updatedAt: -1 },
    { name: 'products_store_keyword' }
  );
  productsIndexesReady = true;
}

function resolveProductDepartmentLabel(product) {
  const labels = product?.categoryLabels || [];
  const path = String(product?.categoryPath || '');
  const haystack = `${labels.join(' ')} ${path}`.toLowerCase();

  if (/fruit\s*(?:&|and)\s*veg|fruit\s*&\s*vegetables|fresh produce/.test(haystack)) {
    return 'Fruit & Veg';
  }
  if (/\bproduce\b/.test(haystack)) return 'Produce';
  if (/\bfresh\b/.test(haystack) && /fruit|veg|vegetable/.test(haystack)) return 'Fresh';

  const bucket = normalizeCategoryBucketLabel(product?.categoryBucket);
  if (bucket === CATEGORY_BUCKETS.FRESH_PRODUCE) return 'Produce';

  return labels[labels.length - 1] || labels[0] || 'Unknown';
}

function departmentAllowedForFreshProduce(department) {
  const dept = String(department || '').trim();
  if (!dept) return false;
  if (FRESH_PRODUCE_DEPARTMENT_EXCLUSION_RE.test(dept)) return false;
  return FRESH_PRODUCE_ALLOWED_DEPARTMENTS.some(
    (allowed) => dept.toLowerCase() === allowed.toLowerCase()
  );
}

function productHasExcludedFreshProduceDepartment(product, department) {
  const labels = Array.isArray(product?.categoryLabels) ? product.categoryLabels.join(' ') : '';
  const haystack = [
    department,
    product?.department,
    product?.categoryPath,
    labels,
    product?.categoryBucket,
  ]
    .filter(Boolean)
    .join(' ');

  return FRESH_PRODUCE_DEPARTMENT_EXCLUSION_RE.test(haystack);
}

function freshProduceProductText(product, name = '') {
  return [
    name || product?.name,
    product?.size,
    product?.unit,
    product?.unit_price_text,
    product?.unit_price,
    product?.unitPrice,
    product?.cupString,
    product?.CupString,
    product?.package_size,
    product?.pack_size,
  ]
    .filter(Boolean)
    .join(' ');
}

function bareFreshProduceSearchIntent(keyword, listItem = {}) {
  if (!isProduceSearchIntent(keyword, listItem)) return false;
  const query = normalizeNameForMatch(
    stripWeightFromText(listItem?.clean_query || keyword || listItem?.keyword || '')
  );
  if (!query || FRESH_PRODUCE_PROCESSED_DRINK_RE.test(query)) return false;
  return PRODUCE_INTENT_KEYWORDS.some((kw) => haystackHasWord(query, kw));
}

function freshProduceCandidateHasProcessedDrinkTerms(product, keyword, listItem = {}) {
  if (!bareFreshProduceSearchIntent(keyword, listItem)) return false;
  return FRESH_PRODUCE_PROCESSED_DRINK_RE.test(
    freshProduceProductText(product, product?.name || '')
  );
}

function freshProduceCandidateHasRealUnitSignal(product) {
  const text = freshProduceProductText(product, product?.name || '');
  if (FRESH_PRODUCE_PROCESSED_DRINK_RE.test(text)) return false;
  return (
    FRESH_PRODUCE_REAL_UNIT_SIGNAL_RE.test(text) ||
    product?.pricePerKg != null ||
    product?.isPerKgPricing === true
  );
}

function freshProduceRankingScoreOverride(product, keyword, listItem = {}) {
  if (listItem?.is_fresh_produce !== true) return 0;
  if (freshProduceCandidateHasProcessedDrinkTerms(product, keyword, listItem)) {
    return -0.9;
  }
  return freshProduceCandidateHasRealUnitSignal(product) ? 1000 : 0;
}

/** Programmatic Mongo-style filter — OpenAI never picks products. */
function productMatchesParsedLineMongoFilters(product, listItem) {
  const name = String(product?.name || '');
  const cleanQuery = String(listItem?.clean_query || listItem?.keyword || '').trim();
  if (!name || !cleanQuery) return false;

  const queryWords = normalizeNameForMatch(cleanQuery)
    .split(' ')
    .filter((w) => w.length > 2);
  const nameNorm = normalizeNameForMatch(name);
  const nameHit =
    queryWords.length > 0
      ? queryWords.some((w) => haystackHasWord(nameNorm, w))
      : nameNorm.includes(normalizeNameForMatch(cleanQuery));

  if (!nameHit) return false;

  if (!listItem?.is_fresh_produce) return true;

  if (FRESH_PRODUCE_NAME_EXCLUSION_RE.test(name)) return false;
  if (freshProduceCandidateHasProcessedDrinkTerms(product, cleanQuery, listItem)) return false;

  const department = resolveProductDepartmentLabel(product);
  if (
    productHasExcludedFreshProduceDepartment(product, department) ||
    !departmentAllowedForFreshProduce(department)
  ) {
    return false;
  }

  return isGenuineFreshProduceForIntent(name, product, cleanQuery, listItem);
}

function filterProductsByParsedLineMongoRules(products, listItem) {
  if (!Array.isArray(products) || !products.length) return [];
  return products.filter((p) => productMatchesParsedLineMongoFilters(p, listItem));
}

function buildMongoProductQueryFilters(listItem, supermarket) {
  const cleanQuery = String(listItem?.clean_query || listItem?.keyword || '').trim();
  const filter = { supermarket: String(supermarket) };

  if (!cleanQuery) return filter;

  const queryPattern = cleanQuery
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => escapeRegex(w))
    .join('|');
  const nameInclude = queryPattern || escapeRegex(cleanQuery);

  if (listItem?.is_fresh_produce) {
    filter.$and = [
      { name: { $regex: nameInclude, $options: 'i' } },
      { name: { $not: FRESH_PRODUCE_NAME_EXCLUSION_RE } },
      { name: { $not: FRESH_PRODUCE_PROCESSED_DRINK_RE } },
      { department: { $in: FRESH_PRODUCE_ALLOWED_DEPARTMENTS } },
      { department: { $not: FRESH_PRODUCE_DEPARTMENT_EXCLUSION_RE } },
      { categoryPath: { $not: FRESH_PRODUCE_DEPARTMENT_EXCLUSION_RE } },
    ];
  } else {
    filter.name = { $regex: nameInclude, $options: 'i' };
  }

  return filter;
}

async function syncProductsToMongo(supermarket, searchKeyword, products) {
  const collection = getProductsCollection();
  if (!collection || !Array.isArray(products) || !products.length) return;

  await ensureProductsIndexes();

  const keyword = String(searchKeyword || '').trim();
  const now = new Date();
  const ops = [];

  for (const product of products) {
    if (!product?.name) continue;
    const productId = product.productId || normalizeNameForMatch(product.name);
    const department = resolveProductDepartmentLabel(product);
    ops.push({
      updateOne: {
        filter: { _id: `${supermarket}:${productId}` },
        update: {
          $set: {
            supermarket,
            searchKeyword: keyword,
            name: product.name,
            department,
            categoryPath: product.categoryPath || '',
            categoryBucket: product.categoryBucket || CATEGORY_BUCKETS.UNKNOWN,
            price: product.price ?? product.packShelfPrice ?? null,
            payload: product,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    });
  }

  if (!ops.length) return;
  try {
    await collection.bulkWrite(ops, { ordered: false });
  } catch (err) {
    console.warn(`  ⚠ products sync failed (${supermarket} "${keyword}"):`, err.message);
  }
}

async function findBestProductInMongo(supermarket, listItem) {
  const collection = getProductsCollection();
  if (!collection) return null;

  await ensureProductsIndexes();

  const filter = buildMongoProductQueryFilters(listItem, supermarket);
  const docs = await collection.find(filter, { sort: { price: 1 }, limit: RESULT_LIMIT }).toArray();
  const products = docs.map((doc) => doc?.payload).filter(Boolean);
  const eligible = filterProductsByParsedLineMongoRules(products, listItem);
  if (!eligible.length) return null;

  const keyword = listItem.clean_query || listItem.keyword;
  const { product } = pickBestProductMatch(eligible, keyword, listItem);
  return product || null;
}

function getPriceHistoryCollection() {
  const mongoDb = mongo.getDb();
  if (!mongoDb) return null;
  return mongoDb.collection(PRICE_HISTORY_COLLECTION);
}

function getBarcodeScanCollection() {
  const mongoDb = mongo.getDb();
  if (!mongoDb) return null;
  return mongoDb.collection(BARCODE_SCAN_COLLECTION);
}

function getSiteStatsCollection() {
  const mongoDb = mongo.getDb();
  if (!mongoDb) return null;
  return mongoDb.collection(SITE_STATS_COLLECTION);
}

/**
 * Giới hạn thời gian chờ — dùng cho MongoDB / tra cứu store khi không có cache.
 */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Trước mỗi lượt đọc/ghi cache: nếu updatedAt thuộc chu kỳ giá trước Thứ Tư (Sydney)
 * → xóa Mongo + RAM ngay (100% tự động, không cần xóa tay DB).
 */
async function purgeApiCacheIfBeforeWednesdayCycle(supermarket, keyword, location) {
  const id = buildApiCacheId(supermarket, keyword, location);
  const memEntry = memoryApiCache.get(id);
  if (memEntry && isApiCacheBeforeCurrentPriceCycle(memEntry.updatedAt)) {
    purgeMemoryApiCacheEntry(supermarket, keyword, location);
  }

  if (!MONGODB_URI || isMongoInCooldown()) return;

  try {
    await withTimeout(
      (async () => {
        await connectMongo();
        const collection = getApiCacheCollection();
        if (!collection) return;
        const doc = await collection.findOne({ _id: id }, { projection: { updatedAt: 1 } });
        if (doc && isApiCacheBeforeCurrentPriceCycle(doc.updatedAt)) {
          await deleteApiCacheRecord(supermarket, keyword, location);
        }
      })(),
      API_CACHE_READ_TIMEOUT_MS,
      'MongoDB cache purge check'
    );
  } catch (err) {
    console.warn(`  ⚠ Wednesday purge check skipped (${supermarket}):`, err.message);
  }
}

/**
 * Đọc cache — MongoDB trước, RAM sau; miss thì caller gọi RapidAPI.
 */
async function tryReadApiCache(supermarket, keyword, location) {
  await purgeApiCacheIfBeforeWednesdayCycle(supermarket, keyword, location);

  if (MONGODB_URI && !isMongoInCooldown()) {
    try {
      const payload = await withTimeout(
        (async () => {
          await connectMongo();
          return readApiCacheWithFallback(supermarket, keyword, location);
        })(),
        API_CACHE_READ_TIMEOUT_MS,
        'MongoDB cache read'
      );
      if (payload != null) {
        const normalized = refreshStoreUrlsInRawList(supermarket, payload);
        writeMemoryApiCache(supermarket, keyword, normalized, location);
        return normalized;
      }
    } catch (err) {
      console.warn(`  ⚠ MongoDB cache read failed (${supermarket}):`, err.message);
    }
  }

  const mem = readMemoryApiCache(supermarket, keyword, location);
  if (mem != null) {
    console.log(`  ⚡ ${supermarket} memory cache hit: "${keyword}"`);
    return refreshStoreUrlsInRawList(supermarket, mem);
  }

  return null;
}

/**
 * Khi API timeout — thử cache Mongo đã hết TTL (nhưng vẫn trong chu kỳ giá sau Thứ Tư).
 * Cache trước Thứ Tư gần nhất bị readApiCache xóa — không dùng lại link/giá tuần cũ.
 */
async function tryReadStaleApiCache(supermarket, keyword, location) {
  await purgeApiCacheIfBeforeWednesdayCycle(supermarket, keyword, location);

  const mem = readMemoryApiCache(supermarket, keyword, location);
  if (mem != null) {
    return refreshStoreUrlsInRawList(supermarket, mem);
  }

  if (!MONGODB_URI || isMongoInCooldown()) return null;

  try {
    const payload = await withTimeout(
      (async () => {
        await connectMongo();
        return readApiCacheWithFallback(supermarket, keyword, location, { allowStale: true });
      })(),
      API_CACHE_STALE_READ_MS,
      'MongoDB stale cache read'
    );
    if (payload != null) {
      const normalized = refreshStoreUrlsInRawList(supermarket, payload);
      writeMemoryApiCache(supermarket, keyword, normalized, location);
      return normalized;
    }
  } catch (err) {
    console.warn(`  ⚠ Stale cache skipped (${supermarket}):`, err.message);
  }
  return null;
}

/**
 * Ghi cache nền — không chặn response trả về cho người dùng.
 */
function scheduleWriteApiCache(supermarket, keyword, payload, location) {
  writeMemoryApiCache(supermarket, keyword, payload, location);
  if (!MONGODB_URI) return;
  if (Array.isArray(payload) && payload.length === 0) return;
  void (async () => {
    try {
      await connectMongo();
      await writeApiCache(supermarket, keyword, payload, location);
    } catch (err) {
      console.warn(`  ⚠ MongoDB cache write failed (${supermarket}):`, err.message);
    }
  })();
}

/**
 * Tăng bộ đếm lượt xem (document _id: "page_views" trong site_stats), mỗi GET +1.
 * Không dùng baseline — đếm từ 1, 2, 3… theo lượt truy cập thực tế.
 */
async function incrementPageViews() {
  const collection = getSiteStatsCollection();
  if (!collection) return null;

  const now = new Date();
  let doc = null;

  try {
    const result = await collection.findOneAndUpdate(
      { _id: SITE_STATS_PAGE_VIEWS_ID },
      {
        $inc: { views: 1 },
        $set: { updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: 'after' }
    );

    if (result && typeof result === 'object' && 'value' in result) {
      doc = result.value;
    } else {
      doc = result;
    }
  } catch (err) {
    console.error('  ❌ incrementPageViews findOneAndUpdate:', err.message);
    return null;
  }

  let views = Number(doc?.views);
  if (!Number.isFinite(views) || views < 0) {
    try {
      const fallback = await collection.findOne({ _id: SITE_STATS_PAGE_VIEWS_ID });
      views = Number(fallback?.views);
    } catch (readErr) {
      console.error('  ❌ incrementPageViews fallback read:', readErr.message);
      return null;
    }
  }

  return Number.isFinite(views) && views >= 0 ? views : null;
}

function buildPriceHistoryBucketId(watchId, yearMonth) {
  return `${String(watchId)}::${yearMonth}`;
}

function getYearMonthFromIsoDate(isoDate) {
  return String(isoDate || '').slice(0, 7);
}

function upsertDailyPriceInArray(arr, date, price) {
  const list = Array.isArray(arr) ? [...arr] : [];
  const point = { date, price: Number(Number(price).toFixed(2)) };
  const idx = list.findIndex((entry) => entry.date === date);
  if (idx >= 0) list[idx] = point;
  else list.push(point);
  return list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function dedupeAndSortPricePoints(points) {
  const byDate = new Map();
  for (const point of points || []) {
    if (!point?.date || point.price == null) continue;
    byDate.set(String(point.date), {
      date: String(point.date),
      price: Number(Number(point.price).toFixed(2)),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function formatChartDateLabel(isoDate) {
  const parts = String(isoDate).split('-').map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return isoDate;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return dt.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function getPriceHistoryCutoffIso() {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (PRICE_HISTORY_MAX_DAYS - 1));
  return cutoff.toISOString().slice(0, 10);
}

function buildUnifiedChartData(colesPoints, woolPoints) {
  const colesMap = new Map(colesPoints.map((p) => [p.date, p.price]));
  const woolMap = new Map(woolPoints.map((p) => [p.date, p.price]));
  const dates = new Set([...colesMap.keys(), ...woolMap.keys()]);

  return [...dates].sort().map((dateIso) => ({
    date: formatChartDateLabel(dateIso),
    dateIso,
    colesPrice: colesMap.has(dateIso) ? colesMap.get(dateIso) : null,
    wooliesPrice: woolMap.has(dateIso) ? woolMap.get(dateIso) : null,
  }));
}

/**
 * Append or update today's price in the month bucket (Bucket Pattern upsert).
 * One document per watchId per YYYY-MM — both chains live in the same bucket.
 */
async function recordPriceHistoryPoint(watchId, supermarket, price, productName = '', meta = {}) {
  const collection = getPriceHistoryCollection();
  if (!collection) return;

  const numericPrice = Number(price);
  if (!watchId || !supermarket || !Number.isFinite(numericPrice) || numericPrice <= 0) {
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const bucketMonth = getYearMonthFromIsoDate(today);
  const _id = buildPriceHistoryBucketId(watchId, bucketMonth);
  const historyField = supermarket === 'Coles' ? 'coles_history' : 'woolies_history';

  const existing = await collection.findOne({ _id });
  const currentArr = Array.isArray(existing?.[historyField]) ? existing[historyField] : [];
  const updatedArr = upsertDailyPriceInArray(currentArr, today, numericPrice);

  await collection.updateOne(
    { _id },
    {
      $set: {
        watchId: String(watchId),
        productId: meta.productId || existing?.productId || null,
        barcode: meta.barcode || existing?.barcode || null,
        productName: String(productName || existing?.productName || '').trim(),
        bucketMonth,
        [historyField]: updatedArr,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

/** Merge Mongo price_history bucket docs into Coles/Woolworths series + chartData. */
function buildPriceHistoryResultFromDocs(docs) {
  let colesPoints = [];
  let woolPoints = [];

  for (const doc of docs) {
    if (Array.isArray(doc.coles_history)) colesPoints.push(...doc.coles_history);
    if (Array.isArray(doc.woolies_history)) woolPoints.push(...doc.woolies_history);
    // Legacy: one doc per supermarket with `points[]`
    if (Array.isArray(doc.points)) {
      if (doc.supermarket === 'Coles') colesPoints.push(...doc.points);
      if (doc.supermarket === 'Woolworths') woolPoints.push(...doc.points);
    }
  }

  colesPoints = dedupeAndSortPricePoints(colesPoints);
  woolPoints = dedupeAndSortPricePoints(woolPoints);

  const cutoffIso = getPriceHistoryCutoffIso();
  colesPoints = colesPoints.filter((p) => p.date >= cutoffIso).slice(-PRICE_HISTORY_MAX_DAYS);
  woolPoints = woolPoints.filter((p) => p.date >= cutoffIso).slice(-PRICE_HISTORY_MAX_DAYS);

  const chartData = buildUnifiedChartData(colesPoints, woolPoints);

  return {
    series: [
      { supermarket: 'Coles', points: colesPoints },
      { supermarket: 'Woolworths', points: woolPoints },
    ],
    chartData,
    days: chartData.length,
    maxDays: PRICE_HISTORY_MAX_DAYS,
  };
}

/** Load up to 100 days of Coles + Woolworths history; returns unified chartData for Chart.js. */
async function getPriceHistoryForWatch(watchId) {
  const collection = getPriceHistoryCollection();
  if (!collection) {
    return { series: [], chartData: [], days: 0, maxDays: PRICE_HISTORY_MAX_DAYS };
  }

  const docs = await collection
    .find({ watchId: String(watchId) })
    .sort({ bucketMonth: 1 })
    .toArray();

  return buildPriceHistoryResultFromDocs(docs);
}

/** Lookup history by indexed productId or barcode (any watchlist bucket that tracked this product). */
async function getPriceHistoryByIndexedField(field, value) {
  const collection = getPriceHistoryCollection();
  if (!collection || !value) {
    return { series: [], chartData: [], days: 0, maxDays: PRICE_HISTORY_MAX_DAYS };
  }

  const docs = await collection
    .find({ [field]: String(value) })
    .sort({ bucketMonth: 1 })
    .toArray();

  return buildPriceHistoryResultFromDocs(docs);
}

/** Resolve history from watchId, product id, or barcode (first match with data wins). */
async function resolvePriceHistory({ watchId = '', productId = '', barcode = '' } = {}) {
  const empty = { series: [], chartData: [], days: 0, maxDays: PRICE_HISTORY_MAX_DAYS };

  if (watchId) {
    const byWatch = await getPriceHistoryForWatch(watchId);
    if (byWatch.chartData.length) return byWatch;
  }

  if (productId) {
    const byProduct = await getPriceHistoryByIndexedField('productId', productId);
    if (byProduct.chartData.length) return byProduct;
    if (!watchId) {
      const byProductAsWatch = await getPriceHistoryForWatch(productId);
      if (byProductAsWatch.chartData.length) return byProductAsWatch;
    }
  }

  if (barcode) {
    const normalized = String(barcode).replace(/\D/g, '');
    if (normalized.length >= 8) {
      const byBarcode = await getPriceHistoryByIndexedField('barcode', normalized);
      if (byBarcode.chartData.length) return byBarcode;
    }
  }

  if (watchId) {
    return getPriceHistoryForWatch(watchId);
  }

  return empty;
}

function roundGeoCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

/**
 * Read latitude/longitude from the incoming request (headers preferred, then query, then JSON body).
 * Returns null coordinates when only postcode/state is supplied — use resolveRequestLocation().
 */
function parseUserLocationFromRequest(req) {
  const readNumber = (...candidates) => {
    for (const raw of candidates) {
      if (raw == null || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n) && Math.abs(n) <= 180) return n;
    }
    return null;
  };

  const readString = (...candidates) => {
    for (const raw of candidates) {
      if (raw == null || raw === '') continue;
      const text = String(raw).trim();
      if (text) return text;
    }
    return null;
  };

  const latitude = readNumber(
    req.headers['x-latitude'],
    req.headers['x-lat'],
    req.query?.latitude,
    req.query?.lat,
    req.body?.latitude,
    req.body?.lat
  );
  const longitude = readNumber(
    req.headers['x-longitude'],
    req.headers['x-lng'],
    req.headers['x-lon'],
    req.query?.longitude,
    req.query?.lng,
    req.query?.lon,
    req.body?.longitude,
    req.body?.lng,
    req.body?.lon
  );

  const postcode = readString(req.headers['x-postcode'], req.query?.postcode, req.body?.postcode);
  const state = normalizeAustralianState(
    readString(req.headers['x-state'], req.query?.state, req.body?.state)
  );

  if (latitude != null && longitude != null) {
    const sourceHeader = String(req.headers['x-location-source'] || '')
      .trim()
      .toLowerCase();
    const source =
      sourceHeader === 'gps' ||
      sourceHeader === 'default' ||
      sourceHeader === 'postcode' ||
      sourceHeader === 'state' ||
      sourceHeader === 'client'
        ? sourceHeader
        : 'client';
    return {
      latitude: roundGeoCoord(latitude),
      longitude: roundGeoCoord(longitude),
      source,
      postcode: postcode || null,
      state: state || null,
    };
  }

  return {
    latitude: null,
    longitude: null,
    source: 'pending',
    postcode,
    state,
  };
}

function normalizeAustralianState(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  if (AU_STATE_CENTROIDS[key.toUpperCase()]) return key.toUpperCase();
  return AU_STATE_ALIASES[key] || null;
}

function normalizeAustralianPostcode(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(0, 4);
}

function inferLocationFromPostcodePrefix(postcode) {
  const prefix = postcode.charAt(0);
  const stateByPrefix = {
    0: 'NT',
    2: 'NSW',
    3: 'VIC',
    4: 'QLD',
    5: 'SA',
    6: 'WA',
    7: 'TAS',
  };
  const state = stateByPrefix[prefix] || 'NSW';
  const centroid = AU_STATE_CENTROIDS[state];
  return {
    latitude: centroid.latitude,
    longitude: centroid.longitude,
    source: 'postcode_fallback',
    postcode,
    state,
  };
}

/** Geocode AU postcode → lat/lng (Nominatim with state-prefix fallback). */
async function geocodeAustralianPostcode(postcode) {
  const normalized = normalizeAustralianPostcode(postcode);
  if (!normalized) return null;

  if (postcodeGeocodeCache.has(normalized)) {
    return postcodeGeocodeCache.get(normalized);
  }

  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        postalcode: normalized,
        country: 'Australia',
        format: 'json',
        limit: 1,
      },
      headers: {
        'User-Agent': 'ShoppingSmart/1.0 (grocery price comparison)',
      },
      timeout: 4500,
    });
    const hit = Array.isArray(response.data) ? response.data[0] : null;
    if (hit?.lat != null && hit?.lon != null) {
      const resolved = {
        latitude: roundGeoCoord(hit.lat),
        longitude: roundGeoCoord(hit.lon),
        source: 'postcode',
        postcode: normalized,
        state: null,
      };
      postcodeGeocodeCache.set(normalized, resolved);
      console.log(`  📍 Postcode ${normalized} → ${resolved.latitude}, ${resolved.longitude}`);
      return resolved;
    }
  } catch (err) {
    console.warn(`  ⚠ Postcode geocode failed (${normalized}):`, err.message);
  }

  const fallback = inferLocationFromPostcodePrefix(normalized);
  postcodeGeocodeCache.set(normalized, fallback);
  console.log(
    `  📍 Postcode ${normalized} → state fallback ${fallback.state} (${fallback.latitude}, ${fallback.longitude})`
  );
  return fallback;
}

function parseStoreOverridesFromRequest(req) {
  const readId = (...candidates) => {
    for (const raw of candidates) {
      if (raw == null || raw === '') continue;
      const text = String(raw).trim();
      if (text) return text;
    }
    return null;
  };
  return {
    colesStoreId: readId(
      req.headers['x-coles-store-id'],
      req.query?.colesStoreId,
      req.body?.colesStoreId
    ),
    woolworthsStoreId: readId(
      req.headers['x-woolworths-store-id'],
      req.query?.woolworthsStoreId,
      req.body?.woolworthsStoreId
    ),
  };
}

/** Resolve coordinates: GPS/client → postcode → state → Sydney default. */
async function resolveRequestLocation(req) {
  const parsed = parseUserLocationFromRequest(req);

  if (parsed.latitude != null && parsed.longitude != null) {
    return parsed;
  }

  if (parsed.postcode) {
    const geo = await geocodeAustralianPostcode(parsed.postcode);
    if (geo) return geo;
  }

  if (parsed.state && AU_STATE_CENTROIDS[parsed.state]) {
    const centroid = AU_STATE_CENTROIDS[parsed.state];
    return {
      latitude: centroid.latitude,
      longitude: centroid.longitude,
      source: 'state',
      postcode: parsed.postcode || null,
      state: parsed.state,
    };
  }

  return { ...SYDNEY_DEFAULT_LOCATION, postcode: null, state: 'NSW' };
}

function getRequestStoreOverrides() {
  return (
    requestLocationContext.getStore()?.storeOverrides || {
      colesStoreId: null,
      woolworthsStoreId: null,
    }
  );
}

/** Active coordinates for the current HTTP request (AsyncLocalStorage). */
function getRequestLocation() {
  return (
    requestLocationContext.getStore()?.location || { ...SYDNEY_DEFAULT_LOCATION, state: 'NSW' }
  );
}

function buildLocationSegment(location) {
  const loc = location || getRequestLocation();
  return `${loc.latitude},${loc.longitude}`;
}

function buildApiCacheId(supermarket, keyword, location) {
  const locKey = buildLocationSegment(location);
  return `${supermarket}:${String(keyword || '')
    .trim()
    .toLowerCase()}:${locKey}`;
}

async function readApiCache(supermarket, keyword, location, { allowStale = false } = {}) {
  const collection = getApiCacheCollection();
  if (!collection) return null;

  const cacheId = buildApiCacheId(supermarket, keyword, location);
  const doc = await collection.findOne({ _id: cacheId });
  if (!doc?.payload) return null;

  /**
   * Production — tự xóa cache chu kỳ giá cũ (trước 00:00 Thứ Tư gần nhất, Australia/Sydney).
   * Chỉ deleteOne đúng _id từ khóa này; các keyword khác trong api_cache không bị ảnh hưởng.
   */
  if (isApiCacheBeforeCurrentPriceCycle(doc.updatedAt)) {
    console.log(
      `  🗓 ${supermarket} cache quá hạn (trước Thứ Tư gần nhất AU): "${keyword}" — deleteOne`
    );
    await collection.deleteOne({ _id: cacheId });
    purgeMemoryApiCacheEntry(supermarket, keyword, location);
    return null;
  }

  if (!allowStale && doc.expiresAt && doc.expiresAt <= new Date()) {
    return null;
  }
  // Empty arrays are treated as cache miss so a bad write does not block forever.
  if (Array.isArray(doc.payload) && doc.payload.length === 0) return null;
  return doc.payload;
}

/** Escape chuỗi dùng trong RegExp. */
function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Đọc MongoDB: vị trí hiện tại → Sydney mặc định → bất kỳ vị trí nào (mới nhất).
 */
async function readApiCacheWithFallback(supermarket, keyword, location, options = {}) {
  const exact = await readApiCache(supermarket, keyword, location, options);
  if (exact != null) return exact;

  const loc = location || getRequestLocation();
  const isDefaultLoc =
    loc.latitude === SYDNEY_DEFAULT_LOCATION.latitude &&
    loc.longitude === SYDNEY_DEFAULT_LOCATION.longitude;
  if (!isDefaultLoc) {
    const sydneyHit = await readApiCache(supermarket, keyword, SYDNEY_DEFAULT_LOCATION, options);
    if (sydneyHit != null) {
      console.log(`  💾 ${supermarket} cache hit (Sydney fallback): "${keyword}"`);
      return sydneyHit;
    }
  }

  const collection = getApiCacheCollection();
  if (!collection) return null;

  const trimmed = String(keyword || '').trim();
  if (!trimmed) return null;

  const doc = await collection
    .find({
      supermarket,
      keyword: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') },
    })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();

  if (!doc?.payload) return null;

  if (isApiCacheBeforeCurrentPriceCycle(doc.updatedAt)) {
    return null;
  }
  if (!options.allowStale && doc.expiresAt && doc.expiresAt <= new Date()) {
    return null;
  }
  if (Array.isArray(doc.payload) && doc.payload.length === 0) return null;

  console.log(`  💾 ${supermarket} cache hit (keyword fallback): "${keyword}"`);
  return doc.payload;
}

async function writeApiCache(supermarket, keyword, payload, location) {
  const collection = getApiCacheCollection();
  if (!collection) return;

  const now = new Date();
  await collection.updateOne(
    { _id: buildApiCacheId(supermarket, keyword, location) },
    {
      $set: {
        supermarket,
        keyword: String(keyword || '').trim(),
        payload,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + API_CACHE_TTL_MS),
      },
    },
    { upsert: true }
  );
  console.log(
    `  💾 ${supermarket} cache saved: "${keyword}" @ ${buildLocationSegment(location)} (${payload.length} items)`
  );
}

/** Connect on local startup and print database name for easy verification. */
async function initMongoForLocalStartup() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI is not set – supermarket API cache disabled.');
    return;
  }
  await connectMongo();
  console.log(`Connected successfully to Database: ${mongo.getDatabaseName()}`);
}

// ============================================================
// 2. KHỞI TẠO EXPRESS
// ============================================================
const app = express();
app.use(cors()); // Cho phép front-end trên origin khác gọi vào
app.use(express.json({ limit: '32kb' }));
// Attach parsed user coordinates to the async context for downstream RapidAPI calls.
app.use(async (req, res, next) => {
  try {
    const location = await resolveRequestLocation(req);
    const storeOverrides = parseStoreOverridesFromRequest(req);
    requestLocationContext.run({ location, storeOverrides }, () => next());
  } catch (err) {
    console.warn('  ⚠ Location resolution failed:', err.message);
    requestLocationContext.run(
      { location: { ...SYDNEY_DEFAULT_LOCATION, state: 'NSW' }, storeOverrides: {} },
      () => next()
    );
  }
});
// Tắt cache để tránh trình duyệt dùng JS/API cũ gây hiển thị dữ liệu "fake"
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// Trang Terms — phục vụ trực tiếp public/terms/index.html (không patch HTML)
app.get(['/terms', '/terms/'], (_req, res) => {
  res.sendFile(TERMS_HTML_PATH, (error) => {
    if (error) {
      console.error('  ❌ Không tải được trang Terms:', error.message);
      res.status(500).send('Cannot load terms page.');
    }
  });
});

/** Trang chủ — phục vụ trực tiếp public/index.html (không patch/replace HTML) */
app.get('/', (_req, res) => {
  res.sendFile(INDEX_HTML_PATH, (error) => {
    if (error) {
      console.error('  ❌ Không tải được trang chủ:', error.message);
      res.status(500).send('Cannot load home page.');
    }
  });
});

/** html5-qrcode: repo root hoặc public/ (Vercel static chỉ phục vụ public/). */
const HTML5_QR_PUBLIC = path.join(PUBLIC_DIR, 'html5-qrcode.min.js');
const HTML5_QR_ROOT = path.join(__dirname, '../html5-qrcode.min.js');

app.get('/html5-qrcode.min.js', (_req, res, next) => {
  const file = fs.existsSync(HTML5_QR_PUBLIC)
    ? HTML5_QR_PUBLIC
    : fs.existsSync(HTML5_QR_ROOT)
      ? HTML5_QR_ROOT
      : null;
  if (!file) return next();
  res.type('application/javascript');
  return res.sendFile(file);
});

/**
 * Pageviews — đăng ký TRƯỚC express.static để /api/pageviews không bị static chặn.
 */
app.get('/api/pageviews', async (_req, res) => {
  if (!MONGODB_URI) {
    return res.status(503).json({
      error: 'Chưa cấu hình MONGODB_URI — bộ đếm pageviews tạm tắt.',
      total_views: null,
    });
  }

  if (isMongoInCooldown()) {
    return res.status(503).json({
      error: 'MongoDB tạm không khả dụng — thử lại sau.',
      total_views: null,
    });
  }

  try {
    const db = await connectMongo();
    if (!db) {
      return res.status(503).json({
        error: 'Không kết nối được MongoDB.',
        total_views: null,
      });
    }

    const totalViews = await withTimeout(
      incrementPageViews(),
      MONGO_CONNECT_TIMEOUT_MS,
      'pageviews increment'
    );
    if (totalViews == null) {
      return res.status(503).json({
        error: 'Không cập nhật được bộ đếm pageviews.',
        total_views: null,
      });
    }

    return res.json({ total_views: totalViews });
  } catch (error) {
    console.error('  ❌ Pageviews error:', error.message);
    return res.status(503).json({
      error: error.message || 'Không đọc/ghi được pageviews.',
      total_views: null,
    });
  }
});

// Phục vụ CSS/JS/HTML từ public/ (đường dẫn tuyệt đối, không phụ thuộc cwd)
app.use(express.static(PUBLIC_DIR));

// ============================================================
// 3. HÀM TIỆN ÍCH: CHUẨN HÓA GIÁ
// ============================================================
/**
 * Chuyển bất kỳ dạng giá nào (string "$4.50", number 4.5, ...) về number.
 * Trả null nếu không parse được hoặc giá <= 0.
 */
function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Number(value.toFixed(2));
  }
  const num = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? Number(num.toFixed(2)) : null;
}

// ============================================================
// 3b. UNIT PRICING – BÓC TÁCH KHỐI LƯỢNG & TÍNH GIÁ / 100g|100ml
// ============================================================

/** Quy đổi kg/L về gram/ml */
function normalizeToBaseUnit(value, unit) {
  const u = String(unit).toLowerCase();
  if (u === 'kg') return value * 1000;
  if (u === 'g') return value;
  if (u === 'l') return value * 1000;
  if (u === 'ml') return value;
  return value;
}

/**
 * Bóc tách khối lượng từ chuỗi (tên sản phẩm, size, …).
 * Hỗ trợ: 250g, 1kg, 500ml, 1L, 2x125g, approx. 200g each
 */
function parseQuantityFromText(text) {
  const source = String(text || '').toLowerCase();

  if (!source.trim()) {
    return { unknown: true };
  }

  // Sản phẩm bán theo cái / each
  if (/\bwhole\s+each\b/i.test(source)) {
    return { isEach: true };
  }

  // Gói nhiều: 2x125g, 6 x 330ml
  const multiMatch = source.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i);
  if (multiMatch) {
    const count = parseInt(multiMatch[1], 10);
    const value = parseFloat(multiMatch[2]);
    const unit = multiMatch[3].toLowerCase();
    const baseUnit = unit === 'ml' || unit === 'l' ? 'ml' : 'g';
    return {
      amountInBaseUnit: normalizeToBaseUnit(value, unit) * count,
      baseUnit,
    };
  }

  // Đơn lẻ: 1kg, 450g, 1.5l, 500ml
  const singleMatch = source.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i);
  if (singleMatch) {
    const value = parseFloat(singleMatch[1]);
    const unit = singleMatch[2].toLowerCase();
    const baseUnit = unit === 'ml' || unit === 'l' ? 'ml' : 'g';
    return {
      amountInBaseUnit: normalizeToBaseUnit(value, unit),
      baseUnit,
    };
  }

  if (/\beach\b/i.test(source) && !/\d+\s*(?:g|kg|ml|l)\b/i.test(source)) {
    return { isEach: true };
  }

  return { unknown: true };
}

/** Gộp nguồn: tên hiển thị → field size → unit API */
function resolveProductQuantity(displayName, raw = {}) {
  const fromName = parseQuantityFromText(displayName);
  if (fromName.amountInBaseUnit) return fromName;
  if (fromName.isEach) return fromName;

  const sizeText = raw.size || raw.package_size || raw.pack_size || '';
  const fromSize = parseQuantityFromText(sizeText);
  if (fromSize.amountInBaseUnit) return fromSize;
  if (fromSize.isEach) return fromSize;

  const unitField = String(raw.unit || '').toLowerCase();
  if (unitField === 'each' || unitField === 'ea') {
    return { isEach: true };
  }

  return fromName.unknown ? { unknown: true } : fromName;
}

/** Chuẩn hóa chuỗi unit price từ API Woolworths (vd: "$0.88 / 100G") */
function normalizeApiUnitPriceText(apiText) {
  const cleaned = String(apiText).trim().replace(/\s+/g, ' ');
  const match = cleaned.match(/\$?\s*([\d.]+)\s*\/\s*100\s*(g|ml)/i);
  if (match) {
    const amount = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (Number.isFinite(amount)) {
      return `$${amount.toFixed(2)} / 100${unit}`;
    }
  }
  return cleaned;
}

/**
 * Tạo chuỗi unit_price_text cho front-end.
 * - Có khối lượng: "$X.XX / 100g" hoặc "/ 100ml"
 * - Each / không parse được: "$X.XX / each"
 */
function buildUnitPriceText(price, displayName, raw = {}) {
  const apiUnit = raw.unit_price || raw.unitPrice;
  if (apiUnit && typeof apiUnit === 'string' && /\//.test(apiUnit)) {
    return normalizeApiUnitPriceText(apiUnit);
  }

  // Coles: price_per_unit trên 100g
  if (
    raw.price_per_unit_price != null &&
    raw.price_per_unit_quantity === 100 &&
    raw.price_per_unit_unit
  ) {
    const u = String(raw.price_per_unit_unit).toLowerCase();
    if (u === 'g' || u === 'ml') {
      return `$${Number(raw.price_per_unit_price).toFixed(2)} / 100${u}`;
    }
  }

  const quantity = resolveProductQuantity(displayName, raw);

  if (quantity.isEach || quantity.unknown) {
    return `$${price.toFixed(2)} / each`;
  }

  const per100 = (price / quantity.amountInBaseUnit) * 100;
  const label = quantity.baseUnit === 'ml' ? '100ml' : '100g';
  return `$${per100.toFixed(2)} / ${label}`;
}

// ============================================================
// 4. HÀM CHUẨN HÓA 1 SẢN PHẨM → CẤU TRÚC THỐNG NHẤT
// ============================================================
/**
 * Nhận object sản phẩm thô từ RapidAPI,
 * trả về: { supermarket, name, price, image }
 *
 * Thứ tự ưu tiên khi mapping:
 *  - price      : item.price > item.discount_price
 *  - image      : item.image > item.image_url > ''
 */
/** Lấy mảng results từ nhiều dạng JSON RapidAPI có thể trả về */
function extractResultsArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data?.results)) return payload.data.results;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableApiError(error) {
  const status = error?.response?.status;
  const code = error?.code;
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ECONNRESET' ||
    status === 429 ||
    (status != null && status >= 500)
  );
}

function formatStoreError(storeName, error) {
  const status = error?.response?.status;
  const apiMessage = error?.response?.data?.message;
  if (status === 429) {
    return `${storeName} API rate limit reached. Please wait a moment and try again.`;
  }
  if (isApiTimeoutError(error)) {
    return `${storeName} API timed out. Please try again in a few seconds.`;
  }
  if (apiMessage) return `${storeName} API error: ${apiMessage}`;
  return error?.message || `${storeName} API is temporarily unavailable.`;
}

const WOOLWORTHS_SITE_ORIGIN = 'https://www.woolworths.com.au';
/** URL tìm kiếm công khai chuẩn Woolworths AU (có /products — KHÔNG dùng /shop/search?searchTerm=). */
const WOOLWORTHS_SEARCH_PRODUCTS_PATH = '/shop/search/products';

/**
 * Ưu tiên 1 — Link PDP Woolworths chỉ cần StockCode (không slug):
 * https://www.woolworths.com.au/shop/productdetails/{StockCode}
 */
function buildWoolworthsProductUrl(raw) {
  const stockcode =
    raw.StockCode ??
    raw.stockCode ??
    raw.stockcode ??
    raw.Stockcode ??
    raw.StoreProductNo ??
    raw.storeProductNo ??
    raw.product_id ??
    raw.productId;
  if (stockcode == null || stockcode === '') return '';

  const code = String(stockcode).replace(/\D/g, '');
  if (!code) return '';

  return `${WOOLWORTHS_SITE_ORIGIN}/shop/productdetails/${code}`;
}

/**
 * Ưu tiên 2 — Tìm kiếm công khai (barcode / fallback khi không có StockCode):
 * https://www.woolworths.com.au/shop/search/products?searchTerm={term}
 */
function buildWoolworthsSearchUrl(searchTerm) {
  const term = String(searchTerm || '').trim();
  if (!term) return '';
  return `${WOOLWORTHS_SITE_ORIGIN}${WOOLWORTHS_SEARCH_PRODUCTS_PATH}?searchTerm=${encodeURIComponent(term)}`;
}

/** Trích searchTerm từ URL Woolworths (cả dạng sai /shop/search? và chuẩn /search/products?). */
function extractWoolworthsSearchTermFromUrl(url) {
  const match = String(url || '').match(/[?&]searchTerm=([^&#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
  } catch {
    return String(match[1]).trim();
  }
}

/**
 * Sửa URL tìm kiếm lỗi từ API/cache: /shop/search?searchTerm= → /shop/search/products?searchTerm=
 */
function fixLegacyWoolworthsSearchUrl(urlOrPath) {
  const trimmed = String(urlOrPath || '').trim();
  if (!trimmed) return '';

  const term = extractWoolworthsSearchTermFromUrl(trimmed);
  if (!term) return '';

  const isSearchUrl = /\/shop\/search/i.test(trimmed);
  const isCorrectProductsPath = /\/shop\/search\/products/i.test(trimmed);

  if (isSearchUrl) {
    return buildWoolworthsSearchUrl(term);
  }

  if (isCorrectProductsPath) {
    return buildWoolworthsSearchUrl(term);
  }

  return '';
}

/** Rút stockcode từ URL/path Woolworths → URL PDP chuẩn không slug. */
function normalizeWoolworthsUrlToStockcodeOnly(urlOrPath, raw = {}) {
  const trimmed = String(urlOrPath || '').trim();
  const stockFromPath = trimmed.match(/\/productdetails\/(\d+)/i);
  if (stockFromPath) {
    return `${WOOLWORTHS_SITE_ORIGIN}/shop/productdetails/${stockFromPath[1]}`;
  }
  return buildWoolworthsProductUrl(raw);
}

/**
 * Ghép domain đầy đủ khi Woolworths trả path tương đối, rồi chuẩn hóa về PDP hoặc search/products.
 */
function toAbsoluteWoolworthsProductUrl(urlOrPath, raw = {}) {
  const trimmed = String(urlOrPath || '').trim();
  if (!trimmed) return buildWoolworthsProductUrl(raw);

  let absolute = trimmed;
  if (!/^https?:\/\//i.test(trimmed) && trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    absolute = `${WOOLWORTHS_SITE_ORIGIN}${trimmed.replace(/\/+$/, '')}`;
  }

  if (/\/productdetails\/\d+/i.test(absolute)) {
    return normalizeWoolworthsUrlToStockcodeOnly(absolute, raw);
  }

  const fixedSearch = fixLegacyWoolworthsSearchUrl(absolute);
  if (fixedSearch) return fixedSearch;

  return buildWoolworthsProductUrl(raw);
}

/**
 * Hàm trung tâm gán url Woolworths — dùng cho keyword search, barcode lookup, cache refresh.
 * 1) Có StockCode/stockcode → /shop/productdetails/{code}
 * 2) Không có → /shop/search/products?searchTerm={barcode|searchTerm}
 */
function resolveWoolworthsProductUrl(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return '';

  const pdpUrl = buildWoolworthsProductUrl(raw);
  if (pdpUrl) return pdpUrl;

  const direct =
    raw.source_url ||
    raw.url ||
    raw.product_url ||
    raw.productUrl ||
    raw.link ||
    raw.product_link ||
    raw.canonical_url ||
    raw.href;

  if (direct) {
    const trimmed = String(direct).trim();
    if (/\/productdetails\/\d+/i.test(trimmed)) {
      return toAbsoluteWoolworthsProductUrl(trimmed, raw);
    }
    const fixedSearch = fixLegacyWoolworthsSearchUrl(trimmed);
    if (fixedSearch) return fixedSearch;
  }

  const barcodeFallback =
    options.scannedBarcode || options.searchTerm || [...collectBarcodesFromRaw(raw)][0] || '';

  if (barcodeFallback) {
    return buildWoolworthsSearchUrl(barcodeFallback);
  }

  return '';
}

function refreshStoreUrlsInRawList(supermarket, rawList) {
  if (supermarket === 'Woolworths') return refreshWoolworthsUrlsInRawList(rawList);
  return rawList;
}

/** Ghi đè URL Woolworths trong cache — PDP (StockCode) hoặc search/products chuẩn. */
function refreshWoolworthsUrlsInRawList(rawList) {
  if (!Array.isArray(rawList)) return rawList;
  return rawList.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;

    const fixed = resolveWoolworthsProductUrl(raw);
    if (!fixed) return raw;

    return { ...raw, url: fixed, product_url: fixed };
  });
}

/**
 * Lấy link trang sản phẩm gốc.
 * Coles (Dromb) thường dùng source_url + slug, không phải field url.
 */
function extractProductUrl(raw, supermarket) {
  const direct =
    raw.source_url ||
    raw.url ||
    raw.product_url ||
    raw.productUrl ||
    raw.link ||
    raw.product_link ||
    raw.canonical_url ||
    raw.href;

  if (direct) {
    const trimmed = String(direct).trim();

    if (supermarket === 'Woolworths') {
      return resolveWoolworthsProductUrl(raw);
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
  }

  if (supermarket === 'Coles' && raw.slug) {
    const slug = String(raw.slug).replace(/^\//, '');
    return `https://www.coles.com.au/product/${slug}`;
  }

  if (supermarket === 'Woolworths') {
    return resolveWoolworthsProductUrl(raw);
  }

  return '';
}

/**
 * Ghép tên hiển thị đầy đủ (Coles thường tách brand + name + size).
 * Ví dụ: brand=Sunrice, name="Microwave Jasmine Rice Pouch", size="450g"
 *   → "Sunrice Microwave Jasmine Rice Pouch 450g"
 */
function buildDisplayName(raw) {
  let baseName = String(
    raw.name || raw.productName || raw.product_name || raw.title || raw.product_title || ''
  ).trim();

  const brand = String(raw.brand || raw.brand_name || '').trim();
  let size = String(raw.size || raw.package_size || raw.pack_size || raw.unit_size || '').trim();

  if (!size) {
    size = extractSizeFromSlug(raw.slug);
  }

  if (brand) {
    const brandLower = brand.toLowerCase();
    const nameLower = baseName.toLowerCase();

    // Thêm thương hiệu nếu chưa có trong tên (Sunrice, …)
    if (!nameLower.includes(brandLower)) {
      baseName = `${brand} ${baseName}`;
    }
  }

  if (size) {
    const compactSize = size.replace(/^approx\.?\s*/i, '').trim();
    if (compactSize && !baseName.toLowerCase().includes(compactSize.toLowerCase())) {
      baseName = `${baseName} ${compactSize}`;
    }
  }

  return baseName.trim();
}

/** Lấy khối lượng từ slug Coles/Woolworths khi API không có field size */
function extractSizeFromSlug(slug) {
  if (!slug) return '';
  const match = String(slug).match(/(\d+(?:\.\d+)?\s*(?:kg|g|l|ml))/i);
  if (!match) return '';
  return match[1].replace(/\s+/g, '');
}

/** ID ổn định từ stockcode (WW) hoặc slug (Coles) – dùng cho watchlist */
function extractProductId(raw, supermarket) {
  if (supermarket === 'Woolworths' && raw.stockcode != null) {
    return `ww-${raw.stockcode}`;
  }
  if (supermarket === 'Coles' && raw.slug) {
    return `coles-${String(raw.slug).replace(/^\//, '')}`;
  }
  if (raw.product_id != null) return `${supermarket}-${raw.product_id}`;
  if (raw.id != null) return `${supermarket}-${raw.id}`;
  return null;
}

// ============================================================
// 3d. BARCODE – TRÍCH & SO KHỚP MÃ VẠCH TỪ API
// ============================================================

/** Chuẩn hóa mã vạch: chỉ giữ chữ số */
function normalizeBarcode(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Thu thập mọi mã vạch có thể có trên object thô RapidAPI */
function collectBarcodesFromRaw(raw, found = new Set()) {
  if (!raw || typeof raw !== 'object') return found;

  const fields = [
    'barcode',
    'barcodes',
    'ean',
    'ean13',
    'gtin',
    'gtin13',
    'gtin14',
    'upc',
    'apn',
    'product_barcode',
    'productBarcode',
    'sku',
  ];

  for (const key of fields) {
    const val = raw[key];
    if (val == null) continue;
    if (Array.isArray(val)) {
      val.forEach((entry) => {
        const digits = normalizeBarcode(entry);
        if (digits.length >= 8) found.add(digits);
      });
    } else {
      const digits = normalizeBarcode(val);
      if (digits.length >= 8) found.add(digits);
    }
  }

  if (raw.product && typeof raw.product === 'object') {
    collectBarcodesFromRaw(raw.product, found);
  }

  return found;
}

/** So khớp EAN-13 / UPC (có thể khác số 0 đầu) */
function barcodesMatch(codeA, codeB) {
  const a = normalizeBarcode(codeA);
  const b = normalizeBarcode(codeB);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 13 && a.startsWith('0') && a.slice(1) === b) return true;
  if (b.length === 13 && b.startsWith('0') && b.slice(1) === a) return true;
  return false;
}

/** Tìm sản phẩm có trường barcode khớp chính xác trong danh sách thô */
function findProductByBarcodeInRawList(rawList, barcode, supermarket) {
  const target = normalizeBarcode(barcode);
  if (target.length < 8) return null;

  for (const raw of rawList) {
    const codes = collectBarcodesFromRaw(raw);
    for (const code of codes) {
      if (barcodesMatch(code, target)) {
        return normalizeItem(raw, supermarket, { scannedBarcode: target });
      }
    }
  }

  return null;
}

function barcodeSearchVariants(barcode) {
  const target = normalizeBarcode(barcode);
  const variants = new Set([target]);
  if (target.length === 12) variants.add(`0${target}`);
  if (target.length === 13 && target.startsWith('0')) variants.add(target.slice(1));
  return [...variants];
}

/** Walk nested API payload for digit strings that look like barcodes. */
function deepScanBarcodeDigits(value, found = new Set(), depth = 0) {
  if (depth > 6 || value == null) return found;
  if (typeof value === 'string' || typeof value === 'number') {
    const digits = normalizeBarcode(value);
    if (digits.length >= 8 && digits.length <= 14) found.add(digits);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => deepScanBarcodeDigits(entry, found, depth + 1));
    return found;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((entry) => deepScanBarcodeDigits(entry, found, depth + 1));
  }
  return found;
}

function logBarcodeRawSample(supermarket, rawList, limit = 3) {
  if (!MATCH_DEBUG) return;
  const sample = rawList.slice(0, limit).map((raw, idx) => {
    const name = raw?.name || raw?.productName || raw?.title || raw?.product?.name || '(no name)';
    const codes = [...collectBarcodesFromRaw(raw), ...deepScanBarcodeDigits(raw)];
    return `#${idx + 1} "${String(name).slice(0, 60)}" codes=[${[...new Set(codes)].slice(0, 4).join(', ')}]`;
  });
  console.log(`  📷 ${supermarket} raw sample:\n    ${sample.join('\n    ')}`);
}

/**
 * Strict barcode match — only accept products whose API payload contains the scanned barcode.
 * Avoids false positives (e.g. Woolworths column showing unrelated single search hits).
 */
function findProductByBarcodeStrict(rawList, barcode, supermarket) {
  const exact = findProductByBarcodeInRawList(rawList, barcode, supermarket);
  if (exact?.supermarket === supermarket) {
    return { product: exact, matchKind: 'barcode_field' };
  }

  for (const raw of rawList) {
    const codes = new Set([...collectBarcodesFromRaw(raw), ...deepScanBarcodeDigits(raw)]);
    for (const code of codes) {
      if (!barcodesMatch(code, barcode)) continue;
      const product = normalizeItem(raw, supermarket, {
        scannedBarcode: barcode,
        barcodeVerified: true,
      });
      if (product?.supermarket === supermarket) {
        return { product, matchKind: 'deep_scan' };
      }
    }
  }

  return { product: null, matchKind: null };
}

/**
 * Name-based fallback when barcode digits return nothing (Open Food Facts → text search).
 */
function findProductByNameInRawList(rawList, searchName, supermarket, scannedBarcode) {
  if (!Array.isArray(rawList) || !rawList.length || !searchName) {
    return { product: null, matchKind: null };
  }

  const target = String(searchName).toLowerCase().trim();
  let bestProduct = null;
  let bestScore = 0;

  for (const raw of rawList.slice(0, 12)) {
    const product = normalizeItem(raw, supermarket, {
      scannedBarcode,
      barcodeVerified: false,
      searchTerm: searchName,
    });
    if (!product || product.supermarket !== supermarket) continue;

    const score = stringSimilarity.compareTwoStrings(target, String(product.name).toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  }

  if (bestProduct && bestScore >= 0.42) {
    return { product: bestProduct, matchKind: 'name_similarity' };
  }

  return { product: null, matchKind: null };
}

/**
 * Match barcode in search results — exact field match, deep scan, then single-result fallback.
 * @deprecated Prefer findProductByBarcodeStrict for barcode scans.
 */
function findProductByBarcodeWithFallback(rawList, barcode, supermarket) {
  return findProductByBarcodeStrict(rawList, barcode, supermarket);
}

async function fetchBarcodeProductForStore(supermarket, barcode, storeIds, options = {}) {
  const productName = String(options.productName || '').trim();
  const isNameSearch = Boolean(productName);
  const variants = isNameSearch ? [productName] : barcodeSearchVariants(barcode).slice(0, 2);

  const matchRawList = (rawList, sourceLabel) => {
    if (!Array.isArray(rawList) || !rawList.length) return null;

    if (MATCH_DEBUG) {
      console.log(`  📷 ${supermarket} barcode ${sourceLabel} → ${rawList.length} result(s)`);
      logBarcodeRawSample(supermarket, rawList);
    }

    const { product, matchKind } = isNameSearch
      ? findProductByNameInRawList(rawList, productName, supermarket, barcode)
      : findProductByBarcodeStrict(rawList, barcode, supermarket);

    if (!product) return null;

    if (MATCH_DEBUG) {
      console.log(
        `  📷 ${supermarket} barcode HIT (${sourceLabel}/${matchKind}): "${product.name}" @ $${product.price ?? 'n/a'}`
      );
    }
    return { product, rawList, matchKind: `${sourceLabel}_${matchKind}`, error: null };
  };

  // Direct supermarket APIs only — skip slow RapidAPI path for barcode scans.
  for (const query of variants) {
    const directRaw = await fetchDirectStoreRawListForBarcode(supermarket, query, storeIds);
    const hit = matchRawList(directRaw, isNameSearch ? 'direct_name' : 'direct_api');
    if (hit) {
      const location = getRequestLocation();
      scheduleWriteApiCache(supermarket, query, directRaw, location);
      if (!isNameSearch && query !== barcode) {
        scheduleWriteApiCache(supermarket, barcode, directRaw, location);
      }
      return hit;
    }
  }

  console.log(
    `  📷 ${supermarket} barcode MISS for ${barcode}${isNameSearch ? ` (name: "${productName}")` : ''}`
  );
  return { product: null, rawList: [], matchKind: null, error: null };
}

/** Resolve a human-readable product name from public barcode databases (Open Food Facts). */
async function lookupBarcodeProductName(barcode) {
  const variants = barcodeSearchVariants(barcode);
  for (const variant of variants) {
    try {
      const response = await axios.get(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(variant)}.json`,
        {
          timeout: BARCODE_NAME_LOOKUP_TIMEOUT_MS,
          headers: { Accept: 'application/json', 'User-Agent': 'ShoppingSmart/1.0' },
        }
      );
      const product = response.data?.product;
      if (!product || product.status === 0 || product.status === '0') continue;

      const brand = String(product.brands || product.brand_owner || '')
        .split(',')[0]
        .trim();
      const title = String(
        product.product_name || product.product_name_en || product.generic_name || ''
      ).trim();
      const quantity = String(product.quantity || product.product_quantity || '').trim();

      let name = title;
      if (brand && title && !title.toLowerCase().includes(brand.toLowerCase())) {
        name = `${brand} ${title}`;
      }
      if (quantity && name && !name.toLowerCase().includes(quantity.toLowerCase())) {
        name = `${name} ${quantity}`;
      }

      name = name.replace(/\s+/g, ' ').trim();
      if (name.length >= 3) {
        console.log(`  📷 Barcode name lookup (Open Food Facts): "${name}"`);
        return name;
      }
    } catch (error) {
      console.warn('  ⚠ Open Food Facts lookup failed:', error.message);
    }
  }
  return null;
}

/** Read a previously saved barcode scan from MongoDB (instant repeat scans). */
async function tryReadBarcodeScanCache(barcode) {
  if (!MONGODB_URI || isMongoInCooldown()) return null;

  try {
    return await withTimeout(
      (async () => {
        await connectMongo();
        const collection = getBarcodeScanCollection();
        if (!collection) return null;

        const normalized = normalizeBarcode(barcode);
        const doc = await collection.findOne({ _id: normalized });
        if (!doc) return null;
        if (doc.expiresAt && new Date(doc.expiresAt) <= new Date()) return null;

        const colesItem = doc.coles ? { ...doc.coles, supermarket: 'Coles' } : null;
        const woolItem = doc.woolworths ? { ...doc.woolworths, supermarket: 'Woolworths' } : null;
        if (!colesItem && !woolItem) return null;

        console.log(`  💾 Barcode cache hit: ${normalized}`);
        return { colesItem, woolItem, fromCache: true };
      })(),
      API_CACHE_READ_TIMEOUT_MS,
      'barcode scan cache read'
    );
  } catch (error) {
    console.warn('  ⚠ Barcode scan cache read failed:', error.message);
    return null;
  }
}

/** Save full barcode scan result for instant repeat lookups. */
async function saveBarcodeScanCache(barcode, colesItem, woolItem) {
  const collection = getBarcodeScanCollection();
  if (!collection) return false;

  const normalized = normalizeBarcode(barcode);
  const now = new Date();
  const attachBarcode = (item) =>
    item
      ? {
          ...item,
          barcode: item.barcode || normalized,
          barcodes: item.barcodes?.length ? item.barcodes : [normalized],
        }
      : null;

  await collection.updateOne(
    { _id: normalized },
    {
      $set: {
        barcode: normalized,
        coles: attachBarcode(colesItem),
        woolworths: attachBarcode(woolItem),
        updatedAt: now,
        expiresAt: new Date(now.getTime() + BARCODE_SCAN_TTL_MS),
      },
    },
    { upsert: true }
  );
  console.log(`  💾 Barcode scan saved: ${normalized}`);
  return true;
}

/** Persist scanned barcode hits so the next scan can match from MongoDB. */
async function seedScannedBarcodeToMongo(barcode, colesItem, woolItem) {
  if (!MONGODB_URI) {
    console.warn('  ⚠ Barcode seed skipped — MONGODB_URI not set');
    return;
  }

  try {
    await connectMongo();
  } catch (error) {
    console.warn('  ⚠ Barcode seed skipped — MongoDB connect failed:', error.message);
    return;
  }

  const normalized = normalizeBarcode(barcode);
  const watchId = `barcode::${normalized}`;
  const seeds = [];

  const queueSeed = (item, supermarket) => {
    if (!item || item.price == null || Number(item.price) <= 0) return;
    const meta = {
      productId: item.productId || null,
      barcode: normalized,
    };
    seeds.push(recordPriceHistoryPoint(watchId, supermarket, item.price, item.name, meta));
    if (item.productId) {
      seeds.push(recordPriceHistoryPoint(item.productId, supermarket, item.price, item.name, meta));
    }
  };

  queueSeed(colesItem, 'Coles');
  queueSeed(woolItem, 'Woolworths');

  try {
    await saveBarcodeScanCache(barcode, colesItem, woolItem);
  } catch (error) {
    console.warn('  ⚠ Barcode scan cache write failed:', error.message);
  }

  if (!seeds.length) return;

  const results = await Promise.allSettled(seeds);
  const saved = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.warn(
      `  ⚠ Barcode price_history seed partial failure (${failed.length}/${results.length})`
    );
  }
  if (saved) {
    console.log(`  💾 Barcode ${normalized} seeded to price_history (${saved} point(s))`);
  }
}

function buildBarcodeScanResponse(
  barcode,
  colesItem,
  woolItem,
  { colesResult = {}, woolResult = {}, nearestStores = null, fromCache = false } = {}
) {
  const colesItems = colesItem ? [colesItem] : [];
  const woolworthsItems = woolItem ? [woolItem] : [];
  const combined = [...colesItems, ...woolworthsItems];
  const directPair = buildDirectComparePair(woolItem, colesItem);
  const similarPairs = directPair ? [directPair] : buildSimilarPairs(woolworthsItems, colesItems);

  return {
    items: combined,
    alignedRows: [buildAlignedCompareMatrixFromProducts(barcode, woolItem, colesItem)],
    searchKeyword: barcode,
    similarPairs,
    scannedBarcode: barcode,
    searchMode: 'barcode',
    fromCache,
    storeErrors: {
      coles: colesResult.error || null,
      woolworths: woolResult.error || null,
    },
    nearestStores,
  };
}

/**
 * Rounding tolerance ($) when comparing $/kg or pack price across supermarkets.
 * If spread ≤ PRICE_EPSILON → treat as same price (no "cheaper" badge).
 */
const PRICE_EPSILON = 0.05;

/**
 * Chuẩn hóa giá trên kg từ sản phẩm (field API hoặc suy ra từ giá gói + khối lượng).
 */
function extractUnitPricePerKg(product) {
  if (!product) return null;
  if (product.pricePerKg != null && Number(product.pricePerKg) > 0) {
    return Number(product.pricePerKg);
  }
  const text = String(product.unit_price_text || '');
  const kgMatch = text.match(/\$?\s*([\d.]+)\s*\/\s*kg\b/i);
  if (kgMatch) {
    const v = parseFloat(kgMatch[1]);
    if (Number.isFinite(v) && v > 0) return Number(v.toFixed(4));
  }
  const per100g = text.match(/\$?\s*([\d.]+)\s*\/\s*100\s*g\b/i);
  if (per100g) {
    const v = parseFloat(per100g[1]);
    if (Number.isFinite(v) && v > 0) return Number((v * 10).toFixed(4));
  }
  const shelf = product.packShelfPrice ?? product.price;
  const kg = product.packWeightKg;
  if (shelf != null && kg != null && kg > 0) {
    return Number((shelf / kg).toFixed(4));
  }
  return null;
}

/**
 * Compare prices across two or more normalized products (Coles / Woolworths).
 * @param {object[]} products — normalized product objects with .supermarket set
 */
function compareStoresForCheaper(products) {
  const list = (products || []).filter(Boolean);
  if (list.length < 2) {
    return { cheaper: 'tie', saving: 0, compareBasis: 'pack_price' };
  }

  const kgRows = list
    .map((product) => ({
      store: product.supermarket,
      kg: extractUnitPricePerKg(product),
      product,
    }))
    .filter((row) => row.kg != null && row.kg > 0);

  if (kgRows.length >= 2) {
    const minRow = kgRows.reduce((a, b) => (a.kg <= b.kg ? a : b));
    const maxRow = kgRows.reduce((a, b) => (a.kg >= b.kg ? a : b));
    const priceDiff = maxRow.kg - minRow.kg;
    if (priceDiff <= PRICE_EPSILON) {
      return { cheaper: 'tie', saving: 0, compareBasis: 'per_kg' };
    }
    const refKg = Math.min(
      minRow.product.packWeightKg > 0 ? minRow.product.packWeightKg : 1,
      maxRow.product.packWeightKg > 0 ? maxRow.product.packWeightKg : 1
    );
    return {
      cheaper: minRow.store,
      saving: Number((priceDiff * refKg).toFixed(2)),
      compareBasis: 'per_kg',
    };
  }

  const packRows = list
    .map((product) => ({
      store: product.supermarket,
      pack: Number(product.packShelfPrice ?? product.price ?? 0),
    }))
    .filter((row) => row.pack > 0);

  if (packRows.length < 2) {
    return { cheaper: 'tie', saving: 0, compareBasis: 'pack_price' };
  }

  packRows.sort((a, b) => a.pack - b.pack);
  const min = packRows[0];
  const max = packRows[packRows.length - 1];
  const packDiff = max.pack - min.pack;
  if (packDiff <= PRICE_EPSILON) {
    return { cheaper: 'tie', saving: 0, compareBasis: 'pack_price' };
  }

  return {
    cheaper: min.store,
    saving: Number(packDiff.toFixed(2)),
    compareBasis: 'pack_price',
  };
}

/** Woolworths vs Coles pair comparison (similar-product rows). */
function compareProductsForCheaper(woolworthsItem, colesItem) {
  return compareStoresForCheaper([woolworthsItem, colesItem].filter(Boolean));
}

/** Ghép cặp so sánh khi quét barcode trúng cả 2 siêu thị */
function buildDirectComparePair(woolworthsItem, colesItem) {
  if (!woolworthsItem || !colesItem) return null;

  const { cheaper, saving } = compareProductsForCheaper(woolworthsItem, colesItem);

  return {
    woolworths: woolworthsItem,
    coles: colesItem,
    cheaper,
    saving,
    similarity: 1,
    matchType: 'barcode',
  };
}

/** Từ khóa tìm kiếm ngắn khi làm mới giá watchlist */
function deriveSearchKeyword(productName) {
  const words = normalizeNameForMatch(productName)
    .split(' ')
    .filter((w) => w.length > 2);
  if (words.length >= 2) return words.slice(0, 5).join(' ');
  return String(productName).split(/\s+/).slice(0, 4).join(' ');
}

// ============================================================
// 3e. THỰC PHẨM TƯƠI – FALLBACK TÌM KIẾM, GIÁ / KG, GHÉP CẶP
// ============================================================

/** Cụm từ cốt lõi thịt/rau – dùng ghép cặp dù tên có đuôi Roast, Slices, Rind On */
const FRESH_CORE_PHRASES = [
  'pork belly',
  'belly pork',
  'pork mince',
  'pork loin',
  'pork chop',
  'pork shoulder',
  'pork leg',
  'beef mince',
  'beef rump',
  'beef steak',
  'beef brisket',
  'beef roast',
  'lamb leg',
  'lamb chop',
  'lamb mince',
  'chicken breast',
  'chicken thigh',
  'chicken drumstick',
  'chicken wing',
  'whole chicken',
  'salmon fillet',
  'barramundi',
  'prawn',
  'fish fillet',
].sort((a, b) => b.length - a.length);

/** Từ khóa nhận diện danh mục tươi sống */
const FRESH_FOOD_TOKENS = [
  'pork',
  'beef',
  'lamb',
  'veal',
  'chicken',
  'turkey',
  'duck',
  'mince',
  'steak',
  'fillet',
  'rump',
  'belly',
  'thigh',
  'breast',
  'drumstick',
  'salmon',
  'prawn',
  'fish',
  'tomato',
  'potato',
  'onion',
  'carrot',
  'broccoli',
  'lettuce',
  'cucumber',
  'mushroom',
  'cabbage',
  'cauliflower',
  'zucchini',
  'capsicum',
  'spinach',
  'celery',
  'pumpkin',
  'corn',
  'watermelon',
  'melon',
  'mango',
  'pineapple',
  'avocado',
  'apple',
  'banana',
  'orange',
  'grape',
  'berry',
  'herb',
  'parsley',
  'coriander',
  'vegetable',
];

const FRESH_PAIR_SCORE_FLOOR = 0.62;
const FRESH_LIST_MATCH_THRESHOLD = 0.32;

/** Top N sản phẩm rẻ nhất ($/kg) được quét trước khi chọn khớp bản chất. */
const MATCH_PRICE_PER_KG_POOL = 5;

/** Từ khóa ý định thịt/nguyên liệu tươi (không đồ chế biến sẵn). */
const RAW_MEAT_CUT_KEYWORDS = [
  'thigh',
  'breast',
  'fillet',
  'mince',
  'steak',
  'rump',
  'chop',
  'cutlet',
  'drumstick',
  'shoulder',
  'belly',
  'loin',
  'backstrap',
  'tenderloin',
  'cut',
  'roast',
  'rack',
  'shank',
  'neck',
];

/** Người dùng chủ đích tìm đồ chế biến — cho phép burger/nuggets. */
const PROCESSED_FOOD_INTENT_KEYWORDS = [
  'burger',
  'burgers',
  'nugget',
  'nuggets',
  'pizza',
  'schnitzel',
  'schnitzels',
  'ready meal',
  'ready meals',
  'pie',
  'pies',
  'sausage roll',
  'hot dog',
  'kiev',
  'parmigiana',
  'tender',
  'tenders',
];

/** Loại ngay khi tìm nguyên liệu tươi nhưng tên sản phẩm là đồ chế biến. */
const PROCESSED_FOOD_NEGATIVE_PATTERNS = [
  /\bburgers?\b/,
  /\bpizzas?\b/,
  /\bnuggets?\b/,
  /\bschnitzels?\b/,
  /\bready meals?\b/,
  /\bheat and eat\b/,
  /\bmicrowave meal\b/,
  /\bmeal kit\b/,
  /\bcrumbed\b/,
  /\bbattered\b/,
  /\bcoated\b/,
  /\bpatties?\b/,
  /\bmeatballs?\b/,
  /\bdumplings?\b/,
  /\bdim sim\b/,
  /\bspring rolls?\b/,
  /\bcordon bleu\b/,
  /\b(kiev|kyiv)\b/,
  /\bparmigiana\b/,
  /\bsausage rolls?\b/,
  /\bhot dogs?\b/,
  /\bpies?\b/,
  /\bpast(?:y|ies)\b/,
  /\bsauces?\b/,
  /\bseasonings?\b/,
  /\bpastes?\b/,
  /\bmarinades?\b/,
  /\bstocks?\b/,
  /\bbroths?\b/,
  /\bpowders?\b/,
  /\bnoodles?\b/,
  /\binstant\b/,
  /\bsoups?\b/,
  /\bdips?\b/,
  /\bcrackers?\b/,
  /\bchips?\b/,
  /\bcrisps?\b/,
  /\bflavou?red\b/,
  /\bflavou?r\b/,
];

/**
 * Bước 1 — Lọc từ khóa rác: đồ gia dụng / quà tặng lẫn vào kết quả thực phẩm.
 * Chỉ giữ nếu người dùng cố ý tìm (từ khóa cũng chứa mug, cup, …).
 */
const SEARCH_NOISE_NEGATIVE_KEYWORDS = [
  'mug',
  'cup',
  'plate',
  'bowl',
  'toy',
  'book',
  'equipment',
  'apron',
  'tote',
  'storage',
  'container',
  'rack',
  'tray',
  'candle',
  'gift',
  'merchandise',
  'homewares',
  'kitchenware',
];

/** Bước 2 — Modifier phân loại: cùng modifier trên 2 sản phẩm → +2 điểm/ghép. */
const SMART_MATCH_CATEGORY_MODIFIERS = [
  'free range',
  'sliced',
  'diced',
  'mince',
  'roast',
  'boneless',
  'smoked',
  'cooked',
  'bites',
  'fillet',
  'fillets',
  'thigh',
  'breast',
  'wing',
  'rump',
  'leg',
  'whole',
  'skinless',
  'trim',
  'lean',
];

/** Gợi ý thịt/nguyên liệu sống (chưa chế biến). */
const SMART_MATCH_RAW_MEAT_HINTS = [
  'sliced',
  'diced',
  'mince',
  'roast',
  'boneless',
  'fillet',
  'fillets',
  'thigh',
  'breast',
  'rump',
  'leg',
  'whole',
  'skinless',
  'trim',
  'raw',
  'fresh',
];

/** Gợi ý đồ chín / tẩm ướp / BBQ — không ghép với thịt sống. */
const SMART_MATCH_COOKED_PREPARED_HINTS = [
  'bbq',
  'barbecue',
  'cooked',
  'marinated',
  'honey',
  'bites',
  'smoked',
  'crumbed',
  'battered',
  'grilled',
  'roasted',
  'heat and eat',
  'ready to eat',
  'pre cooked',
  'precooked',
  'marinade',
  'glazed',
  'teriyaki',
  'schnitzel',
  'nugget',
  'burger',
  'sausage',
  'meatball',
  'pattie',
  'patty',
];

/** Điểm tối thiểu để chấp nhận ghép cặp (tránh ghép bừa khi điểm âm). */
const SMART_MATCH_MIN_PAIR_SCORE = 0.55;
/** Độ tương đồng Jaro-Winkler tối thiểu trên toàn tên — một từ chung không đủ. */
const MIN_PAIR_NAME_SIMILARITY = 0.52;
/** Rau/trái cây chỉ trùng một từ gốc (vd. "broccoli") cần sim cao hơn. */
const MIN_FRESH_SHALLOW_TOKEN_SIMILARITY = 0.68;

const PRODUCT_MATCHING_RULES = `You are a strict grocery price analyzer for Australian supermarkets (Coles and Woolworths). When matching or pairing products across stores, you MUST obey these rules in order:

1. STATE/FORM CONSISTENCY (Đồng nhất trạng thái thực phẩm):
   - Fresh/Raw produce must NEVER be paired with Processed, Pickled, Canned, Jarred, Frozen, Dried, or other value-added prepared items — even if they share a keyword.
   - FORBIDDEN pairs include: fresh cucumber ↔ pickled jar cucumber ("Green Leaf Pickled Cucumber"); whole fresh watermelon ↔ pre-cut fruit tray ("Watermelon Fingers"); raw chicken thigh ↔ chicken nuggets/burgers.
   - Fresh cucumber matches only fresh cucumber. Whole fruit matches only whole fresh fruit of the same type.

2. UNIT & PACK-TYPE GUARDRAILS (Chặn lệch kích thước quá lớn):
   - Do NOT pair whole bulk produce (e.g. 8 kg whole watermelon, per-kg loose cucumber) with small convenience pre-cut packs (e.g. 600 g fruit fingers/slices/trays) unless absolutely no equivalent exists in that store.
   - If forced to pair mismatched pack types, you MUST NOT present a direct apples-to-apples price comparison — flag a major packaging discrepancy explicitly (e.g. "whole 8 kg vs 600 g pre-cut tray — not directly comparable").
   - Prefer same pack form: whole↔whole, per-kg↔per-kg, pre-cut tray↔pre-cut tray, jar↔jar.

3. MATHEMATICAL SANITIZATION:
   - Before generating any unit-conversion pricing note (e.g. "$X/kg, converted for 2kg"), verify the target product's base category AND food state match the requested item.
   - Never convert weights/volumes of liquids, pickles, jams, sauces, or processed jarred goods to match fresh raw produce weights.
   - Never apply per-kg scaling across mismatched forms (pickled ≠ fresh, tray ≠ whole, drained weight ≠ fresh weight).

4. INTENT VS BRAND MATCH (Không nhầm tên thương hiệu với nguyên liệu):
   - NEVER match a fruit/vegetable intent to a dry packaged product that only shares the produce name in its brand title.
   - FORBIDDEN: "watermelon" (fresh fruit) ↔ "Watermelon Broken Rice" (gạo tấm / pantry rice).
   - FORBIDDEN: "cucumber" (fresh vegetable) ↔ "Always Fresh Cucumbers Baby 350g" (pickled jar) or "Cucumber Soap".
   - Brand words like "Fresh", "Natural", or "Always Fresh" do NOT prove the item is fresh produce.

5. CONTEXT CHECKING — SAME NATURE ONLY:
   - "Fresh cucumber" means the raw vegetable — not pickled cucumber (dưa muối), not cucumber soap (xà bông).
   - Verify the CORE nature of the item (fresh produce vs pantry vs health/beauty) before any match or price math.

6. STRICT JSON OUTPUT — NO FORCED BAD MATCHES / NO HALLUCINATIONS:
   - When resolving each list item across stores, return a JSON object per line with "coles" and "woolworths" fields.
   - If a store lacks a product of the EXACT SAME type/nature, set that store field to null — never pick a random keyword collision.
   - Do not hallucinate matches just because one word overlaps (watermelon ≠ rice, cucumber ≠ soap).
   - Prefer null over a misleading forced pair; downstream logic may impute rival prices rather than show $0.

Always prioritize the lowest $/kg only among products that pass ALL rules above.`;

function searchIntentSuggestsProcessedFood(keyword, listItem = {}) {
  const norm = normalizeNameForMatch(stripWeightFromText(keyword || listItem.keyword || ''));
  if (!norm) return false;
  return PROCESSED_FOOD_INTENT_KEYWORDS.some((token) => haystackHasWord(norm, token));
}

/** Ý định mua nguyên liệu tươi (thịt/cá cắt), không burger/pizza. */
function searchIntentSuggestsRawIngredient(keyword, listItem = {}) {
  const norm = normalizeNameForMatch(stripWeightFromText(keyword || listItem.keyword || ''));
  if (!norm) return false;
  if (searchIntentSuggestsProcessedFood(keyword, listItem)) return false;

  if (RAW_MEAT_CUT_KEYWORDS.some((token) => haystackHasWord(norm, token))) return true;
  if (haystackHasWord(norm, 'meat')) return true;

  const meatSeaTokens = [
    'prawn',
    'shrimp',
    'salmon',
    'barramundi',
    'fish',
    'pork',
    'beef',
    'lamb',
    'chicken',
    'turkey',
    'duck',
    'seafood',
    'crab',
    'squid',
  ];
  if (
    meatSeaTokens.some((kw) => haystackHasWord(norm, kw)) &&
    !/\b(cracker|crackers|sauce|stock|powder|noodle|paste|juice)\b/.test(norm)
  ) {
    return true;
  }

  return isFreshFoodCategory(keyword) && !searchIntentSuggestsProcessedFood(keyword, listItem);
}

function nameSuggestsProcessedPreparedFood(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  if (!nameNorm) return false;
  return PROCESSED_FOOD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(nameNorm));
}

/** Pickled / jarred / canned — không ghép với tươi sống. */
const PRESERVED_FOOD_STATE_KEYWORDS = [
  'pickled',
  'pickle',
  'pickles',
  'jar',
  'jarred',
  'canned',
  'tinned',
  'brine',
  'preserved',
];

/** Gói tiện lợi cắt sẵn — fingers, tray, pre-cut… */
const CONVENIENCE_PRECUT_HINTS = [
  'fingers',
  'finger',
  'pre cut',
  'precut',
  'pre-cut',
  'pre sliced',
  'presliced',
  'pre-sliced',
  'fruit salad',
  'snack pack',
  'snack cup',
  'ready to eat',
  'cut fruit',
  'fruit tray',
  'fruit platter',
];

/** Trái/rau nguyên khối / bán theo kg — whole, loose, ≥2 kg. */
const BULK_WHOLE_PRODUCE_HINTS = ['whole', 'loose', 'seedless'];

/** Tỷ lệ khối lượng tối thiểu khi ghép trái/rau tươi (600 g vs 8 kg → loại). */
const FRESH_PRODUCE_MIN_WEIGHT_RATIO = 0.35;

/** Gói siêu nhỏ (kẹo roller, xà phòng) — không ghép nguyên khối ≥2 kg. */
const MICRO_PACK_MAX_GRAMS = 100;

/** Tín hiệu ý định trái/rau tươi trong tên hoặc query. */
const FRESH_PRODUCE_SIGNAL_KEYWORDS = ['fresh', 'cucumber', 'watermelon', 'vegetable', 'fruit'];

/** Từ khóa cấm khi ghép với trái/rau tươi (xà phòng, kẹo, v.v.). */
const NON_FOOD_PRODUCT_BLACKLIST_KEYWORDS = [
  'soap',
  'dettol',
  'shampoo',
  'body wash',
  'toiletries',
  'roller',
  'candy',
  'sweets',
  'jelly',
  'gummy',
  'pickled',
  'jar',
  'bar',
  'lollies',
  'lolly',
  'chocolate',
  'confectionery',
  'hygiene',
  'cleanser',
  'moisturiser',
  'moisturizer',
];

/** Pantry / dry goods — tên mượn từ khóa trái/rau (vd: Watermelon Broken Rice). */
const PANTRY_STAPLE_KEYWORDS = [
  'rice',
  'broken rice',
  'grain',
  'grains',
  'flour',
  'noodle',
  'noodles',
  'pasta',
  'cereal',
  'oats',
  'semolina',
  'couscous',
  'cracker',
  'crackers',
  'biscuit',
  'biscuits',
  'bread mix',
  'cake mix',
  'muesli',
  'granola',
  'sauce',
  'paste',
  'powder',
  'stock',
  'seasoning',
  'chips',
  'crisps',
  'tea',
  'coffee',
];

/** Gói gram nhỏ vẫn có thể là tươi (cà chua, nho…) — không loại nhầm. */
const SHELF_STABLE_PACK_EXCEPTIONS = [
  'tomato',
  'tomatoes',
  'berry',
  'berries',
  'grape',
  'grapes',
  'herb',
  'herbs',
  'mint',
  'parsley',
  'basil',
  'coriander',
];

/** Nhãn department API — Health & Beauty, Household, Confectionery… */
const NON_FOOD_DEPARTMENT_TERMS = [
  'health',
  'beauty',
  'personal care',
  'toiletries',
  'hygiene',
  'home care',
  'cleaning',
  'laundry',
  'confectionery',
  'candy',
  'snack food',
  'soap',
];

function nameSuggestsPreservedFoodState(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  if (!nameNorm) return false;
  return PRESERVED_FOOD_STATE_KEYWORDS.some((hint) =>
    hint.includes(' ') ? nameNorm.includes(hint) : haystackHasWord(nameNorm, hint)
  );
}

function nameSuggestsFrozenFoodState(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  return /\bfrozen\b/.test(nameNorm);
}

function searchIntentSuggestsConveniencePack(keyword, listItem = {}) {
  const norm = normalizeNameForMatch(stripWeightFromText(keyword || listItem.keyword || ''));
  if (!norm) return false;
  return nameNormHasAnyHint(norm, CONVENIENCE_PRECUT_HINTS);
}

function getProductWeightGrams(name, product = null) {
  const size = extractSizeInfo(name);
  if (size.grams != null && size.grams > 0) return size.grams;
  const packKg = product?.packWeightKg ?? getPackWeightKgFromProduct(name, product || {});
  if (packKg != null && packKg > 0) return packKg * 1000;
  return null;
}

function nameSuggestsBulkWholeProduce(name, product = null) {
  const nameNorm = normalizeNameForMatch(name);
  if (!nameNorm) return false;
  if (nameNormHasAnyHint(nameNorm, BULK_WHOLE_PRODUCE_HINTS)) return true;
  if (/\bper\s*kg\b/.test(nameNorm) || /\bper\s*kilo\b/.test(nameNorm)) return true;
  const grams = getProductWeightGrams(name, product);
  return grams != null && grams >= 2000;
}

function nameSuggestsConveniencePreCut(name, product = null) {
  const nameNorm = normalizeNameForMatch(name);
  if (!nameNorm) return false;
  if (nameNormHasAnyHint(nameNorm, CONVENIENCE_PRECUT_HINTS)) return true;
  if (/\b(tray|wedges?|slices?)\b/.test(nameNorm) && isFreshFoodCategory(name)) return true;
  const grams = getProductWeightGrams(name, product);
  return (
    grams != null && grams > 0 && grams <= 800 && /\b(tray|wedge|slice|finger|cut)\b/.test(nameNorm)
  );
}

/** Một bên muối/ngâm/hộp — bên kia tươi sống → không ghép. */
function hasFoodStateFormMismatch(nameA, nameB) {
  const preservedA = nameSuggestsPreservedFoodState(nameA);
  const preservedB = nameSuggestsPreservedFoodState(nameB);
  if (preservedA !== preservedB) return true;
  const frozenA = nameSuggestsFrozenFoodState(nameA);
  const frozenB = nameSuggestsFrozenFoodState(nameB);
  if (frozenA !== frozenB) return true;
  return false;
}

/** Nguyên khối / số lượng lớn ↔ gói cắt sẵn nhỏ → không ghép. */
function hasPackagingFormMismatch(nameA, productA, nameB, productB) {
  const bulkA = nameSuggestsBulkWholeProduce(nameA, productA);
  const bulkB = nameSuggestsBulkWholeProduce(nameB, productB);
  const convA = nameSuggestsConveniencePreCut(nameA, productA);
  const convB = nameSuggestsConveniencePreCut(nameB, productB);
  if ((bulkA && convB) || (convA && bulkB)) return true;

  const gramsA = getProductWeightGrams(nameA, productA);
  const gramsB = getProductWeightGrams(nameB, productB);
  const freshPair = isFreshFoodCategory(nameA) && isFreshFoodCategory(nameB);

  if (freshPair && gramsA != null && gramsB != null) {
    const ratio = Math.min(gramsA, gramsB) / Math.max(gramsA, gramsB);
    if (ratio < FRESH_PRODUCE_MIN_WEIGHT_RATIO) return true;
    const maxG = Math.max(gramsA, gramsB);
    const minG = Math.min(gramsA, gramsB);
    if (maxG >= 3000 && minG <= 1000) return true;
  }

  return false;
}

function isSameSupermarketCrossPair(productA, productB) {
  const storeA = productA?.supermarket;
  const storeB = productB?.supermarket;
  return Boolean(storeA && storeB && storeA === storeB);
}

/** Guardrails chung — dùng ở scoreProductPair, scoreSmartMatchPair, buildSmartComparePairs. */
function evaluatePairingGuardrails(nameA, productA, nameB, productB, opts = {}) {
  if (isSameSupermarketCrossPair(productA, productB)) {
    return 'same supermarket cross-pair';
  }
  if (hasCrossDepartmentFoodNonFoodMismatch(nameA, productA, nameB, productB)) {
    return 'cross-department ban (fresh produce vs non-food department)';
  }
  if (
    hasFreshProduceNonFoodKeywordConflict(
      nameA,
      productA,
      nameB,
      productB,
      opts.keyword,
      opts.listItem
    )
  ) {
    return 'fresh produce keyword vs non-food product blacklist';
  }
  if (hasFoodStateFormMismatch(nameA, nameB)) {
    return 'food state/form mismatch (fresh vs preserved/processed)';
  }
  if (hasPackagingFormMismatch(nameA, productA, nameB, productB)) {
    return 'packaging/weight mismatch (bulk whole vs convenience pre-cut)';
  }
  if (hasBulkVsMicroWeightMismatch(nameA, productA, nameB, productB)) {
    return 'bulk produce vs micro-pack weight mismatch (<100g)';
  }
  return null;
}

function produceKeywordAppearsInName(name, keyword, listItem = {}) {
  const core = stripWeightFromText(keyword || listItem.keyword || '');
  return productNameMatchesProduceKeyword(name, core);
}

/** Trái/rau trong tên nhưng sản phẩm thực chất là pantry (Watermelon Broken Rice). */
function nameBorrowedProduceKeywordForPantry(name, keyword, listItem = {}) {
  if (!isProduceSearchIntent(keyword, listItem)) return false;
  if (!produceKeywordAppearsInName(name, keyword, listItem)) return false;
  const nameNorm = normalizeNameForMatch(name);
  return PANTRY_STAPLE_KEYWORDS.some((kw) =>
    kw.includes(' ') ? nameNorm.includes(kw) : haystackHasWord(nameNorm, kw)
  );
}

/** Hộp/jar/gherkin/baby pack — không phải dưa chuột tươi bán each. */
function nameSuggestsShelfStableProducePack(name, product = null) {
  const nameNorm = normalizeNameForMatch(name);
  if (!nameNorm) return false;
  if (nameSuggestsPreservedFoodState(name)) return true;
  if (/\b(in brine|in vinegar|cornichon|gherkin|muoi|pickled)\b/.test(nameNorm)) return true;
  if (/\balways fresh\b/.test(nameNorm) && /\b(cucumber|onion|beetroot|olive)\b/.test(nameNorm)) {
    return true;
  }

  const grams = getProductWeightGrams(name, product);
  const hasEach = /\beach\b/.test(nameNorm);
  const hasLoose = /\b(loose|per kg|per kilo|whole)\b/.test(nameNorm);
  if (hasEach || hasLoose) return false;

  if (grams != null && grams > 0 && grams <= 1000) {
    if (SHELF_STABLE_PACK_EXCEPTIONS.some((ex) => haystackHasWord(nameNorm, ex))) return false;
    if (/\b(baby|mini|gherkin|cornichon)\b/.test(nameNorm)) return true;
    if (/\b(cucumber|onion|beetroot|olive|capsicum|chilli)\b/.test(nameNorm)) return true;
  }

  return false;
}

function listItemWantsWholeProduceUnits(listItem = {}) {
  const unit = String(listItem?.unit || '').toLowerCase();
  const qty = Number(listItem?.quantity) > 0 ? Number(listItem.quantity) : 1;
  return ['each', 'ea'].includes(unit) && qty >= 1;
}

/** Khách muốn 2 quả nguyên — không ghép quarter/half/cut. */
function productConflictsWithWholeProduceRequest(name, listItem = {}) {
  if (!listItemWantsWholeProduceUnits(listItem)) return false;
  if (!isProduceSearchIntent(listItem.keyword, listItem)) return false;
  const frac = detectFractionalUnit(name);
  if (frac.penalizeMatch) return true;
  if (nameSuggestsConveniencePreCut(name)) return true;
  const nameNorm = normalizeNameForMatch(name);
  if (
    /\b(quarter|half)\b/.test(nameNorm) &&
    /\b(watermelon|melon|pineapple|pumpkin)\b/.test(nameNorm)
  ) {
    return true;
  }
  if (/\b(wedge|fingers)\b/.test(nameNorm) && /\b(watermelon|melon)\b/.test(nameNorm)) {
    return true;
  }
  return false;
}

/**
 * Trái/rau tươi thật cho ý định produce — không rice/soap/jar mượn từ khóa.
 */
function isGenuineFreshProduceForIntent(name, product, keyword, listItem = {}) {
  if (!isProduceSearchIntent(keyword, listItem)) return true;
  if (searchIntentSuggestsProcessedFood(keyword, listItem)) return true;
  if (!isFreshProduceCandidateForIntent(name, product, keyword, listItem)) return false;
  if (nameBorrowedProduceKeywordForPantry(name, keyword, listItem)) return false;
  if (nameSuggestsShelfStableProducePack(name, product)) return false;
  if (productConflictsWithWholeProduceRequest(name, listItem)) return false;

  const bucket = normalizeCategoryBucketLabel(
    product?.categoryBucket || resolveProductBucket(product || { name })
  );
  if (bucket === CATEGORY_BUCKETS.PANTRY) return false;

  const nameNorm = normalizeNameForMatch(name);
  return (
    bucket === CATEGORY_BUCKETS.FRESH_PRODUCE ||
    looksLikeLooseFreshProduceName(name) ||
    /\b(each|loose|per kg|whole|fresh)\b/.test(nameNorm)
  );
}

function isFreshProduceCandidateForIntent(name, product, keyword, listItem = {}) {
  if (!isProduceSearchIntent(keyword, listItem)) return true;
  if (searchIntentSuggestsProcessedFood(keyword, listItem)) return true;
  if (nameSuggestsNonFoodProductTitle(name)) return false;
  if (productInNonFoodDepartment(product, name)) return false;
  if (nameSuggestsPreservedFoodState(name)) return false;
  if (nameBorrowedProduceKeywordForPantry(name, keyword, listItem)) return false;
  if (nameSuggestsShelfStableProducePack(name, product)) return false;
  if (productConflictsWithWholeProduceRequest(name, listItem)) return false;
  if (
    !searchIntentSuggestsConveniencePack(keyword, listItem) &&
    nameSuggestsConveniencePreCut(name, product)
  ) {
    return false;
  }
  return true;
}

function normalizeCategoryBucketLabel(bucket) {
  const raw = String(bucket || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (Object.values(CATEGORY_BUCKETS).includes(raw)) return raw;
  return CATEGORY_BUCKET_ALIASES[raw] || raw;
}

function haystackSuggestsNonFoodDepartment(haystack) {
  const lower = String(haystack || '').toLowerCase();
  return NON_FOOD_DEPARTMENT_TERMS.some((term) => lower.includes(term));
}

/** Kẹo/xà phòng/kẹo roller — tên mượn từ khóa trái/rau (vd: Honeydew & Cucumber soap). */
function nameSuggestsNonFoodProductTitle(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  if (!nameNorm) return false;
  if (/\bchilli\s+350\s*g\b/.test(nameNorm) || /\bchili\s+350\s*g\b/.test(nameNorm)) {
    return true;
  }
  if (
    NON_FOOD_PRODUCT_BLACKLIST_KEYWORDS.some((kw) =>
      kw.includes(' ') ? nameNorm.includes(kw) : haystackHasWord(nameNorm, kw)
    )
  ) {
    return true;
  }
  return nameSuggestsNonFreshProduceSnack(displayName);
}

function nameHasFreshProduceSignal(name) {
  const norm = normalizeNameForMatch(name);
  if (!norm) return false;
  if (FRESH_PRODUCE_SIGNAL_KEYWORDS.some((kw) => haystackHasWord(norm, kw))) return true;
  return PRODUCE_INTENT_KEYWORDS.some((kw) => haystackHasWord(norm, kw));
}

function searchIntentHasFreshProduceSignal(keyword, listItem = {}) {
  const combined = `${keyword || ''} ${listItem.keyword || ''}`.trim();
  return nameHasFreshProduceSignal(stripWeightFromText(combined));
}

function productInNonFoodDepartment(product, name) {
  const labels = product?.categoryLabels || [];
  const haystack = buildCategoryHaystack(labels, name);
  if (haystackSuggestsNonFoodDepartment(haystack)) return true;
  const bucket = normalizeCategoryBucketLabel(
    product?.categoryBucket || resolveProductBucket(product || { name })
  );
  return bucket === CATEGORY_BUCKETS.HEALTH_BEAUTY || bucket === CATEGORY_BUCKETS.CONFECTIONERY;
}

function nameLooksLikePantryProduceBrandTrap(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  const hasProduce = PRODUCE_INTENT_KEYWORDS.some((kw) => haystackHasWord(nameNorm, kw));
  if (!hasProduce) return false;
  return PANTRY_STAPLE_KEYWORDS.some((kw) =>
    kw.includes(' ') ? nameNorm.includes(kw) : haystackHasWord(nameNorm, kw)
  );
}

function productInFreshProduceContext(name, product) {
  if (nameSuggestsNonFoodProductTitle(name) || productInNonFoodDepartment(product, name)) {
    return false;
  }
  if (
    nameLooksLikePantryProduceBrandTrap(name) ||
    nameSuggestsShelfStableProducePack(name, product)
  ) {
    return false;
  }
  const bucket = normalizeCategoryBucketLabel(
    product?.categoryBucket || resolveProductBucket(product || { name })
  );
  if (bucket === CATEGORY_BUCKETS.PANTRY) return false;
  if (bucket === CATEGORY_BUCKETS.FRESH_PRODUCE) return true;
  if (looksLikeLooseFreshProduceName(name)) return true;
  return nameHasFreshProduceSignal(name);
}

/** Một bên trái/rau tươi — bên kia xà phòng/kẹo/nhãn department phi thực phẩm. */
function hasCrossDepartmentFoodNonFoodMismatch(nameA, productA, nameB, productB) {
  const freshA = productInFreshProduceContext(nameA, productA);
  const freshB = productInFreshProduceContext(nameB, productB);
  const nonFoodA =
    nameSuggestsNonFoodProductTitle(nameA) || productInNonFoodDepartment(productA, nameA);
  const nonFoodB =
    nameSuggestsNonFoodProductTitle(nameB) || productInNonFoodDepartment(productB, nameB);

  if (freshA && nonFoodB) return true;
  if (freshB && nonFoodA) return true;

  const bucketA = normalizeCategoryBucketLabel(
    productA?.categoryBucket || resolveProductBucket(productA || { name: nameA })
  );
  const bucketB = normalizeCategoryBucketLabel(
    productB?.categoryBucket || resolveProductBucket(productB || { name: nameB })
  );

  if (freshA && bucketB && FRESH_PRODUCE_INCOMPATIBLE_BUCKETS.has(bucketB)) return true;
  if (freshB && bucketA && FRESH_PRODUCE_INCOMPATIBLE_BUCKETS.has(bucketA)) return true;

  if (
    bucketA === CATEGORY_BUCKETS.FRESH_PRODUCE &&
    bucketB === CATEGORY_BUCKETS.PANTRY &&
    nonFoodB
  ) {
    return true;
  }
  if (
    bucketB === CATEGORY_BUCKETS.FRESH_PRODUCE &&
    bucketA === CATEGORY_BUCKETS.PANTRY &&
    nonFoodA
  ) {
    return true;
  }

  return false;
}

/** Ý định/query hoặc tên tươi ↔ tên blacklist phi thực phẩm. */
function hasFreshProduceNonFoodKeywordConflict(
  nameA,
  productA,
  nameB,
  productB,
  keyword = '',
  listItem = {}
) {
  const freshContextA =
    productInFreshProduceContext(nameA, productA) || nameHasFreshProduceSignal(nameA);
  const freshContextB =
    productInFreshProduceContext(nameB, productB) || nameHasFreshProduceSignal(nameB);
  const intentFresh = searchIntentHasFreshProduceSignal(keyword, listItem);
  const nonFoodA =
    nameSuggestsNonFoodProductTitle(nameA) || productInNonFoodDepartment(productA, nameA);
  const nonFoodB =
    nameSuggestsNonFoodProductTitle(nameB) || productInNonFoodDepartment(productB, nameB);

  if ((freshContextA || intentFresh) && nonFoodB) return true;
  if ((freshContextB || intentFresh) && nonFoodA) return true;
  return false;
}

/** Nguyên khối / ≥2 kg ↔ gói <100 g (kẹo roller, xà phòng). */
function hasBulkVsMicroWeightMismatch(nameA, productA, nameB, productB) {
  const gramsA = getProductWeightGrams(nameA, productA);
  const gramsB = getProductWeightGrams(nameB, productB);
  const bulkA = nameSuggestsBulkWholeProduce(nameA, productA);
  const bulkB = nameSuggestsBulkWholeProduce(nameB, productB);

  if (bulkA && gramsB != null && gramsB < MICRO_PACK_MAX_GRAMS) return true;
  if (bulkB && gramsA != null && gramsA < MICRO_PACK_MAX_GRAMS) return true;

  if (gramsA != null && gramsB != null) {
    const maxG = Math.max(gramsA, gramsB);
    const minG = Math.min(gramsA, gramsB);
    if (maxG >= 2000 && minG < MICRO_PACK_MAX_GRAMS) return true;
  }

  return false;
}

/** $/kg để sort — ưu tiên pricePerKg, suy ra từ gói, cuối cùng pack price. */
function getProductComparablePricePerKg(product) {
  if (!product) return Number.POSITIVE_INFINITY;

  const direct = Number(product.pricePerKg);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const shelf = Number(product.packShelfPrice ?? product.price);
  const packKg =
    product.packWeightKg != null && product.packWeightKg > 0
      ? Number(product.packWeightKg)
      : getPackWeightKgFromProduct(product.name || '', product);

  if (Number.isFinite(shelf) && shelf > 0 && packKg != null && packKg > 0) {
    return shelf / packKg;
  }

  if (Number.isFinite(shelf) && shelf > 0) return shelf * 1000;

  return Number.POSITIVE_INFINITY;
}

const GENERIC_SHORT_KEYWORD_IGNORE_WORDS = new Set([
  'fresh',
  'free',
  'range',
  'organic',
  'the',
  'and',
  'for',
]);

const GENERIC_KEYWORD_SYNONYM_PHRASES = [
  {
    query: ['toilet', 'paper'],
    alternatives: [
      ['toilet', 'tissue'],
      ['bathroom', 'tissue'],
    ],
  },
];

function getSignificantKeywordWords(keyword, listItem = {}) {
  const core = stripWeightFromText(keyword || listItem.keyword || '');
  return normalizeNameForMatch(core)
    .split(' ')
    .filter((w) => w.length > 2 && !GENERIC_SHORT_KEYWORD_IGNORE_WORDS.has(w));
}

function keywordWordMatchesName(nameNorm, word) {
  if (haystackHasWord(nameNorm, word)) return true;

  // Các từ khóa chung rất hay khác số ít/số nhiều: egg ↔ eggs.
  if (word.endsWith('s') && word.length > 3 && haystackHasWord(nameNorm, word.slice(0, -1))) {
    return true;
  }
  if (!word.endsWith('s') && haystackHasWord(nameNorm, `${word}s`)) {
    return true;
  }

  return false;
}

function shortKeywordSynonymPhraseMatches(nameNorm, words) {
  return GENERIC_KEYWORD_SYNONYM_PHRASES.some((entry) => {
    const queryMatches =
      entry.query.length === words.length && entry.query.every((word) => words.includes(word));
    if (!queryMatches) return false;

    return entry.alternatives.some((phrase) =>
      phrase.every((word) => keywordWordMatchesName(nameNorm, word))
    );
  });
}

function productNameHasFullShortKeywordMatch(displayName, keyword, listItem = {}) {
  const words = getSignificantKeywordWords(keyword, listItem);
  if (!words.length || words.length > 3) return false;

  const nameNorm = normalizeNameForMatch(displayName);
  if (!nameNorm) return false;

  return (
    words.every((word) => keywordWordMatchesName(nameNorm, word)) ||
    shortKeywordSynonymPhraseMatches(nameNorm, words)
  );
}

function getListMatchThresholdForKeyword(keyword, listItem = {}) {
  const wordCount = getSignificantKeywordWords(keyword, listItem).length;
  return wordCount > 0 && wordCount <= 3 ? 0.22 : LIST_MATCH_THRESHOLD;
}

/** Tên phải chứa keyword đủ mạnh; generic ngắn được pass nếu match đủ từ/synonym. */
function productNameContainsSearchKeywords(displayName, keyword, listItem = {}) {
  if (productNameHasFullShortKeywordMatch(displayName, keyword, listItem)) return true;

  const words = getSignificantKeywordWords(keyword, listItem);

  if (!words.length) return true;

  const nameNorm = normalizeNameForMatch(displayName);
  return words.some((word) => keywordWordMatchesName(nameNorm, word));
}

function scoreProductForMatching(product, keyword, listItem = {}) {
  const hint = buildQuantityHint(listItem);
  let score = scoreProductForKeyword(product.name, keyword, hint, listItem, product);
  const freshProduceOverride = freshProduceRankingScoreOverride(product, keyword, listItem);
  if (freshProduceOverride >= 1000) {
    score += freshProduceOverride;
  } else if (freshProduceOverride < 0) {
    score *= 0.1;
  }
  if (resolveProductBucket(product) === CATEGORY_BUCKETS.FRESH_PRODUCE) {
    score = score >= 1000 ? score + 0.06 : Math.min(score + 0.06, 1);
  }
  return score;
}

/**
 * Trong pool rẻ nhất theo $/kg, chọn sản phẩm khớp bản chất nhất.
 */
function pickBestFromPricePerKgPool(scoredEntries, keyword, listItem = {}) {
  if (!scoredEntries.length) return { product: null, score: 0 };

  const boostedFreshProduce = scoredEntries
    .filter((entry) => entry.score >= 1000)
    .slice()
    .sort((a, b) => b.score - a.score);
  if (boostedFreshProduce.length) {
    return {
      product: boostedFreshProduce[0].product,
      score: boostedFreshProduce[0].score,
    };
  }

  const priced = scoredEntries
    .filter((entry) => entry.score > 0)
    .slice()
    .sort(
      (a, b) =>
        getProductComparablePricePerKg(a.product) - getProductComparablePricePerKg(b.product)
    );

  const pool = priced.slice(0, MATCH_PRICE_PER_KG_POOL);
  if (!pool.length) return { product: null, score: 0 };

  pool.sort((a, b) => b.score - a.score);
  return { product: pool[0].product, score: pool[0].score };
}

/** Bỏ phần cân nặng khỏi chuỗi tìm kiếm (1kg, 500g, 2 L, …) */
function stripWeightFromText(text) {
  return String(text || '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|ml|l)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trích số lượng kg/g từ câu tìm kiếm (vd: "pork belly 1kg") */
function parseWeightFromSearchText(text) {
  const source = String(text || '');
  const kgMatch = source.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (kgMatch) {
    return { quantity: parseFloat(kgMatch[1]), unit: 'kg' };
  }
  const gMatch = source.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gMatch && !kgMatch) {
    return { quantity: parseFloat(gMatch[1]), unit: 'g' };
  }
  return null;
}

/** Tạo listItem giả từ ô search để tính giá theo kg */
function buildListItemFromSearchText(searchText, coreKeyword) {
  const weight = parseWeightFromSearchText(searchText);
  if (weight) {
    return { keyword: coreKeyword, quantity: weight.quantity, unit: weight.unit };
  }
  return { keyword: coreKeyword, quantity: 1, unit: 'each' };
}

function normalizeSearchQuery(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Có thuộc nhóm thực phẩm tươi không */
function isFreshFoodCategory(name) {
  const norm = normalizeNameForMatch(name);
  if (detectFreshCorePhrase(name)) return true;
  return FRESH_FOOD_TOKENS.some((token) => {
    const re = new RegExp(`\\b${token}\\b`, 'i');
    return re.test(norm);
  });
}

/** Lấy cụm cốt lõi (vd: "pork belly") từ tên sản phẩm */
function detectFreshCorePhrase(name) {
  const norm = normalizeNameForMatch(name);
  for (const phrase of FRESH_CORE_PHRASES) {
    if (norm.includes(phrase)) return phrase;
  }
  return null;
}

/** Hai tên cùng cụm cốt lõi → chấp nhận ghép dù khác Roast / Slices / Rind On */
function freshFoodCorePhraseMatch(nameA, nameB) {
  const phraseA = detectFreshCorePhrase(nameA);
  const phraseB = detectFreshCorePhrase(nameB);
  if (phraseA && phraseB && phraseA === phraseB) return true;

  const normA = normalizeNameForMatch(nameA);
  const normB = normalizeNameForMatch(nameB);
  if (phraseA && normB.includes(phraseA)) return true;
  if (phraseB && normA.includes(phraseB)) return true;

  return false;
}

// ============================================================
// 3f. TOÁN HỌC GIÁ GIỎ HÀNG – / KG, QUY ĐỔI KHỐI LƯỢNG, ĐƠN VỊ LẺ
// ============================================================

/**
 * Trích khối lượng gói/khay (kg) từ tên hoặc field size API.
 * VD: khay 1.3kg giá $26 → dùng suy ra $20/kg.
 */
function getPackWeightKgFromProduct(displayName, raw = {}) {
  const sizeInfo = extractSizeInfo(displayName);
  if (sizeInfo.grams != null && sizeInfo.grams > 0) {
    return Number((sizeInfo.grams / 1000).toFixed(4));
  }

  const fromSizeField = parseQuantityFromText(raw.size || raw.package_size || raw.pack_size || '');
  if (fromSizeField.amountInBaseUnit && fromSizeField.baseUnit === 'g') {
    return Number((fromSizeField.amountInBaseUnit / 1000).toFixed(4));
  }

  return null;
}

/** Công thức: Price_Per_KG = Giá_khay / Khối_lượng_khay (kg) */
function derivePricePerKgFromPack(shelfPrice, packWeightKg) {
  if (shelfPrice == null || packWeightKg == null || packWeightKg <= 0) return null;
  return Number((shelfPrice / packWeightKg).toFixed(4));
}

/**
 * Đọc giá/kg từ unit_price, price_info, price_per_unit… trên payload API.
 */
function extractPricePerKgFromApiFields(raw, displayName) {
  const direct =
    parsePrice(raw.price_per_kg) ??
    parsePrice(raw.pricePerKg) ??
    parsePrice(raw.per_kg_price) ??
    parsePrice(raw.price_per_kilo) ??
    parsePrice(raw.pricePerKilo);

  if (direct != null) return direct;

  const priceInfo = raw.price_info || raw.priceInfo;
  if (priceInfo && typeof priceInfo === 'object') {
    const fromInfo =
      parsePrice(priceInfo.price_per_kg) ??
      parsePrice(priceInfo.per_kg) ??
      parsePrice(priceInfo.unit_price_per_kg);
    if (fromInfo != null) return fromInfo;
  }

  const unitField = String(
    raw.price_per_unit_unit || raw.unit_of_measure || raw.selling_unit || ''
  ).toLowerCase();

  if (unitField === 'kg' && raw.price_per_unit_price != null) {
    const ppu = parsePrice(raw.price_per_unit_price);
    if (ppu != null) return ppu;
  }

  const unitPriceRaw = raw.unit_price || raw.unitPrice || raw.UnitPrice;
  if (typeof unitPriceRaw === 'string') {
    const perKgInUnit = unitPriceRaw.match(/\$?\s*([\d.]+)\s*\/\s*1?\s*kg\b/i);
    if (perKgInUnit) return parsePrice(perKgInUnit[1]);

    const per100g = unitPriceRaw.match(/\$?\s*([\d.]+)\s*\/\s*100\s*g\b/i);
    if (per100g) {
      const per100 = parsePrice(per100g[1]);
      if (per100 != null) return Number((per100 * 10).toFixed(4));
    }
  }

  const metaText = [
    displayName,
    raw.size,
    raw.package_size,
    raw.unit,
    unitPriceRaw,
    raw.cupString,
    raw.CupString,
  ]
    .filter(Boolean)
    .join(' ');

  const perKgLabel = /\b(per\s*kg|\/\s*kg|kg\s*each)\b/i.test(metaText);
  if (perKgLabel) {
    const fromCup =
      parsePrice(raw.cupPrice) ?? parsePrice(raw.CupPrice) ?? parsePrice(raw.price_per_unit_price);
    if (fromCup != null) return fromCup;
  }

  const dollarMatch = String(metaText).match(/\$\s*([\d]+(?:\.\d+)?)\s*(?:\/|per)\s*kg/i);
  if (dollarMatch) return parsePrice(dollarMatch[1]);

  return null;
}

/**
 * Xác định Price_Per_KG: ưu tiên API, không có thì suy từ giá khay ÷ cân nặng khay.
 */
function resolvePricePerKg(raw, displayName, shelfPrice) {
  const packWeightKg = getPackWeightKgFromProduct(displayName, raw);
  let pricePerKg = extractPricePerKgFromApiFields(raw, displayName);
  let source = pricePerKg != null ? 'api' : null;

  if (pricePerKg == null && shelfPrice != null && packWeightKg != null) {
    pricePerKg = derivePricePerKgFromPack(shelfPrice, packWeightKg);
    if (pricePerKg != null) source = 'derived_pack';
  }

  return { pricePerKg, packWeightKg, source };
}

/** Target_Weight (kg) từ prompt khách: 1 kg → 1, 500g → 0.5 */
function getTargetWeightKg(listItem) {
  if (!listItem) return null;
  const unit = String(listItem.unit || '').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  if (unit === 'kg') return qty;
  if (unit === 'g') return qty / 1000;
  return null;
}

/**
 * Nhận diện đơn vị lẻ: Half, Quarter, Slices…
 * multiplier: hệ số quy đổi về 1 đơn vị nguyên (half → ×2).
 */
function detectFractionalUnit(productName) {
  const name = String(productName || '');
  const lower = name.toLowerCase();

  if (/\bwhole\b/i.test(lower)) {
    return { isWhole: true, isFractional: false, multiplier: 1, type: 'whole' };
  }

  if (/\bhalf\b/i.test(lower) || /\b1\/2\b/.test(lower)) {
    return { isWhole: false, isFractional: true, multiplier: 2, type: 'half', penalizeMatch: true };
  }

  if (/\bquarter\b/i.test(lower) || /\b1\/4\b/.test(lower)) {
    return {
      isWhole: false,
      isFractional: true,
      multiplier: 4,
      type: 'quarter',
      penalizeMatch: true,
    };
  }

  if (/\bthird\b/i.test(lower) || /\b1\/3\b/.test(lower)) {
    return {
      isWhole: false,
      isFractional: true,
      multiplier: 3,
      type: 'third',
      penalizeMatch: true,
    };
  }

  if (/\bslices?\b/i.test(lower)) {
    return {
      isWhole: false,
      isFractional: true,
      multiplier: 1,
      type: 'slices',
      penalizeMatch: true,
    };
  }

  return { isWhole: false, isFractional: false, multiplier: 1, type: null, penalizeMatch: false };
}

/** Khách yêu cầu 1 quả/cây nguyên (each × 1) */
function wantsWholeUnitEach(listItem) {
  if (!listItem) return false;
  const unit = String(listItem.unit || '').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  return ['each', 'ea', 'bunch'].includes(unit) && qty === 1;
}

/**
 * Quy đổi giá hiển thị theo đúng số lượng/khối lượng trong prompt.
 * - Weight: Final_Displayed_Price = Price_Per_KG × Target_Weight
 * - Each + fractional: giá_khay × multiplier (half ×2, quarter ×4)
 */
function shouldApplyWeightScaling(product, listItem) {
  const keyword = listItem?.keyword || '';
  if (getTargetWeightKg(listItem) == null) return true;
  if (nameSuggestsPreservedFoodState(product?.name || '')) return false;
  if (nameBorrowedProduceKeywordForPantry(product?.name || '', keyword, listItem)) return false;
  if (nameSuggestsShelfStableProducePack(product?.name || '', product)) return false;
  if (isProduceSearchIntent(keyword, listItem)) {
    return isGenuineFreshProduceForIntent(product?.name || '', product, keyword, listItem);
  }
  return true;
}

function estimateEachFruitWeightKg(product, listItem) {
  const targetWeightKg = getTargetWeightKg(listItem);
  if (targetWeightKg == null || !listItem?.is_fresh_produce) return null;
  if (product?.pricePerKg != null || product?.packWeightKg != null) return null;
  if (getPackWeightKgFromProduct(product?.name || '', product || {}) != null) return null;

  const hay = normalizeNameForMatch(
    `${listItem.clean_query || listItem.keyword || ''} ${product?.name || ''}`
  );

  const estimates = [
    { re: /\b(apples?|royal gala|pink lady|granny smith)\b/, kg: 0.18 },
    { re: /\b(oranges?|navel|naval|mandarin)\b/, kg: 0.25 },
    { re: /\bbananas?\b/, kg: 0.18 },
    { re: /\bpears?\b/, kg: 0.18 },
    { re: /\blemons?\b/, kg: 0.12 },
    { re: /\blimes?\b/, kg: 0.08 },
    { re: /\bavocados?\b/, kg: 0.2 },
    { re: /\bmango(?:es|s)?\b/, kg: 0.3 },
    { re: /\bkiwi(?:fruit)?s?\b/, kg: 0.09 },
  ];

  const match = estimates.find((entry) => entry.re.test(hay));
  if (!match) return null;

  const nameNorm = normalizeNameForMatch(product?.name || '');
  const looksEach =
    /\beach\b|\bea\b/.test(nameNorm) || !/\b\d+(?:\.\d+)?\s*(?:kg|g)\b/.test(nameNorm);
  return looksEach ? match.kg : null;
}

function applyListItemPricing(product, listItem) {
  if (!product || !listItem) return product;

  const unit = String(listItem.unit || 'each').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  const targetWeightKg = getTargetWeightKg(listItem);
  const keyword = listItem.keyword || '';

  const packShelfPrice = product.packShelfPrice != null ? product.packShelfPrice : product.price;

  let pricePerKg = product.pricePerKg;
  if (pricePerKg == null && targetWeightKg != null) {
    const packKg = product.packWeightKg ?? getPackWeightKgFromProduct(product.name, {});
    pricePerKg = derivePricePerKgFromPack(packShelfPrice, packKg);
  }

  let finalPrice = packShelfPrice;
  let pricingNote = null;
  let isAdjustedPrice = false;

  const estimatedEachKg = estimateEachFruitWeightKg(product, listItem);

  if (pricePerKg != null && targetWeightKg != null && shouldApplyWeightScaling(product, listItem)) {
    finalPrice = Number((pricePerKg * targetWeightKg).toFixed(2));
    isAdjustedPrice = true;

    const weightLabel =
      unit === 'g' ? `${qty}g` : unit === 'kg' ? `${qty}kg` : `${targetWeightKg}kg`;

    pricingNote = `($${pricePerKg.toFixed(2)}/kg, converted for ${weightLabel})`;
  } else if (
    estimatedEachKg != null &&
    targetWeightKg != null &&
    shouldApplyWeightScaling(product, listItem)
  ) {
    const eachCount = Math.ceil(targetWeightKg / estimatedEachKg);
    finalPrice = Number((packShelfPrice * eachCount).toFixed(2));
    isAdjustedPrice = true;
    pricingNote = `(Weight estimate: ${eachCount} × each @ $${packShelfPrice.toFixed(2)} (est. ${targetWeightKg}kg))`;
  } else if (['each', 'ea', 'bunch', 'pack', 'pk'].includes(unit)) {
    const frac = detectFractionalUnit(product.name);

    if (
      frac.isFractional &&
      frac.multiplier > 1 &&
      !productConflictsWithWholeProduceRequest(product.name, listItem)
    ) {
      finalPrice = Number((packShelfPrice * frac.multiplier * qty).toFixed(2));
      isAdjustedPrice = true;
      pricingNote = `($${packShelfPrice.toFixed(2)} per ${frac.type}, ×${frac.multiplier} → est. 1 whole unit)`;
    } else {
      finalPrice = Number((packShelfPrice * qty).toFixed(2));
      if (qty > 1) {
        isAdjustedPrice = true;
        pricingNote = `($${packShelfPrice.toFixed(2)} each × ${qty})`;
      }
    }
  } else {
    const countable = ['pack', 'pk', 'dozen', 'loaf', 'bottle', 'can'];
    const multiplier = countable.includes(unit) ? qty : 1;
    finalPrice = Number((packShelfPrice * multiplier).toFixed(2));
    if (multiplier > 1) isAdjustedPrice = true;
  }

  return {
    ...product,
    price: finalPrice,
    packShelfPrice,
    pricePerKg: pricePerKg ?? product.pricePerKg,
    isPerKgPricing: pricePerKg != null,
    isAdjustedPrice,
    pricingNote,
    targetQuantity: qty,
    targetUnit: unit,
    targetWeightKg,
    unit_price_text: pricingNote || product.unit_price_text,
  };
}

/** Giữ tên cũ – gọi module quy đổi mới */
function applyWeightContextToProduct(product, listItem) {
  return applyListItemPricing(product, listItem);
}

/**
 * Tìm kiếm RapidAPI với nhiều biến thể từ khóa (đặc biệt trái tươi: melon / rockmelon).
 */
async function fetchStoreProducts(supermarket, searchText, listItem = null, opts = {}) {
  const fast = opts.fast === true;
  const coreKeyword = stripWeightFromText(listItem?.clean_query || listItem?.keyword || searchText);
  const weightListItem = listItem || buildListItemFromSearchText(searchText, coreKeyword);
  const matchListItem = listItem || weightListItem;

  const runSearch = async (query) => {
    const rawList = await fetchStoreRawList(supermarket, query, {
      fast,
      storeIds: opts.storeIds,
    });
    return normalizeRawList(rawList, supermarket).map((product) =>
      applyWeightContextToProduct(product, weightListItem)
    );
  };

  const queries = expandProduceSearchQueries(
    listItem ? buildSearchQueryFromListItem(listItem) : searchText,
    matchListItem
  );

  let items = [];
  let usedFallback = false;
  const produceIntent =
    matchListItem?.is_fresh_produce === true || isProduceSearchIntent(coreKeyword, matchListItem);
  const maxQueries = fast && !produceIntent ? 1 : queries.length;

  const hasAcceptableMatch = () => {
    if (!items.length) return false;
    if (!produceIntent) return true;
    const filtered = filterProductsByParsedLineMongoRules(items, matchListItem);
    const { product } = pickBestProductMatch(filtered, coreKeyword, matchListItem);
    return Boolean(product);
  };

  for (let i = 0; i < maxQueries && i < queries.length; i++) {
    const query = queries[i];
    if (i > 0) {
      console.log(`  ↩ ${supermarket} search variant: "${query}"`);
      usedFallback = true;
    }

    const batch = await runSearch(query);
    items = mergeProductLists(items, batch);

    if (items.length >= RESULT_LIMIT && hasAcceptableMatch()) break;
    if (hasAcceptableMatch()) break;
  }

  return {
    items: items.slice(0, RESULT_LIMIT),
    usedFallback,
    coreKeyword,
    primaryQuery: queries[0] || searchText,
  };
}

/** Dùng cho ô tìm kiếm chính – bật logic trái tươi giống giỏ AI */
function buildListItemForKeywordSearch(keyword) {
  const core = stripWeightFromText(keyword);
  return buildListItemFromSearchText(keyword, core || keyword);
}

/**
 * Ẩn sản phẩm có $/kg bất thường (thường do API chia sai khối lượng gói).
 */
function isSuspiciousUnitPricePerKg(pricePerKg, name = '', categoryBucket = '') {
  const perKg = Number(pricePerKg);
  if (!Number.isFinite(perKg) || perKg <= MAX_SANE_PRICE_PER_KG) return false;

  const hay = `${name}`.toLowerCase();
  const luxuryHints =
    /(caviar|saffron|wagyu|truffle|lobster|abalone|yabbies|oyster|scallop|king prawn|jumbo prawn)/i;
  if (luxuryHints.test(hay)) return false;

  const bucket = String(categoryBucket || '').toLowerCase();
  if (bucket === 'pantry' && /(spice|vanilla|saffron)/i.test(hay)) return false;

  return true;
}

function normalizeItem(raw, supermarket, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const name = buildDisplayName(raw);

  const listedPrice = parsePrice(raw.price) ?? parsePrice(raw.current_price);
  const discountPrice = parsePrice(raw.discount_price) ?? parsePrice(raw.sale_price);
  const wasPrice =
    parsePrice(raw.was_price) ??
    parsePrice(raw.original_price) ??
    parsePrice(raw.list_price) ??
    parsePrice(raw.regular_price);

  // Giá hiển thị: ưu tiên giá khuyến mãi nếu thấp hơn giá gốc
  let price =
    listedPrice ?? discountPrice ?? parsePrice(raw.selling_price) ?? parsePrice(raw.final_price);
  let originalPrice = null;
  let isOnSpecial =
    raw.is_on_special === true ||
    raw.on_special === true ||
    raw.isSpecial === true ||
    raw.special === true;

  if (discountPrice != null && listedPrice != null && discountPrice < listedPrice) {
    price = discountPrice;
    originalPrice = listedPrice;
    isOnSpecial = true;
  } else if (wasPrice != null && price != null && wasPrice > price) {
    originalPrice = wasPrice;
    isOnSpecial = true;
  } else if (isOnSpecial && wasPrice != null && price != null && wasPrice > price) {
    originalPrice = wasPrice;
  }

  const saveAmount =
    originalPrice != null && price != null && originalPrice > price
      ? Number((originalPrice - price).toFixed(2))
      : null;

  const url =
    supermarket === 'Woolworths'
      ? resolveWoolworthsProductUrl(raw, {
          scannedBarcode: opts.scannedBarcode,
          searchTerm: opts.searchTerm,
        })
      : extractProductUrl(raw, supermarket);

  const image =
    raw.image ||
    (Array.isArray(raw.images) ? raw.images[0] : null) ||
    raw.image_url ||
    raw.imageUrl ||
    raw.thumbnail ||
    raw.img ||
    '';

  const packShelfPrice = price;
  const {
    pricePerKg,
    packWeightKg,
    source: pricePerKgSource,
  } = resolvePricePerKg(raw, name, packShelfPrice);
  const isPerKgPricing = pricePerKg != null;

  if (!name || (packShelfPrice == null && pricePerKg == null)) return null;

  let unit_price_text = buildUnitPriceText(packShelfPrice, name, raw);
  if (isPerKgPricing) {
    unit_price_text = `$${pricePerKg.toFixed(2)} / kg`;
    if (pricePerKgSource === 'derived_pack' && packWeightKg) {
      unit_price_text += ` (from ${packWeightKg}kg pack $${packShelfPrice.toFixed(2)})`;
    }
  }

  const productId = extractProductId(raw, supermarket);
  const searchKeyword = deriveSearchKeyword(name);
  const barcodeSet = collectBarcodesFromRaw(raw);
  const barcodes = [...barcodeSet];
  const scannedBarcode = opts.scannedBarcode ? normalizeBarcode(opts.scannedBarcode) : '';
  const barcode =
    barcodes[0] || (opts.barcodeVerified && scannedBarcode ? scannedBarcode : null) || null;

  const categoryMeta = buildCategoryMetaFromRaw(raw, name);

  if (isSuspiciousUnitPricePerKg(pricePerKg, name, categoryMeta.bucket)) {
    return null;
  }

  return {
    productId,
    searchKeyword,
    barcode,
    barcodes,
    supermarket,
    name,
    categoryBucket: categoryMeta.bucket,
    categoryLabels: categoryMeta.labels,
    categoryPath: categoryMeta.path,
    brand: String(raw.brand || raw.brand_name || '').trim(),
    size: String(raw.size || raw.package_size || '').trim(),
    price: packShelfPrice ?? pricePerKg,
    packShelfPrice,
    packWeightKg,
    pricePerKg,
    pricePerKgSource,
    isPerKgPricing,
    pricingNote: null,
    isAdjustedPrice: false,
    originalPrice,
    isOnSpecial: Boolean(isOnSpecial || saveAmount),
    saveAmount,
    unit_price_text,
    url: String(url).trim(),
    image: String(image),
  };
}

// ============================================================
// 3a. DANH MỤC NGÀNH HÀNG – TRÍCH TỪ API & LỌC GHÉP CẶP
// ============================================================

/**
 * Nhóm ngành hàng gộp (bucket) dùng khi so khớp Coles ↔ Woolworths.
 * unknown = API/thuật toán không chắc → xử lý bằng heuristics tên sản phẩm.
 */
const CATEGORY_BUCKETS = {
  FRESH_PRODUCE: 'fresh_produce',
  DRINKS: 'drinks',
  MEAT_SEAFOOD: 'meat_seafood',
  DAIRY: 'dairy',
  BAKERY: 'bakery',
  PANTRY: 'pantry',
  FROZEN: 'frozen',
  HEALTH_BEAUTY: 'health_beauty',
  HOUSEHOLD: 'household',
  CONFECTIONERY: 'confectionery',
  UNKNOWN: 'unknown',
};

/** API / siêu thị trả nhãn khác tên bucket nội bộ. */
const CATEGORY_BUCKET_ALIASES = {
  fruit_veg: CATEGORY_BUCKETS.FRESH_PRODUCE,
  'fruit & veg': CATEGORY_BUCKETS.FRESH_PRODUCE,
  'fresh vegetables': CATEGORY_BUCKETS.FRESH_PRODUCE,
  'fresh fruits': CATEGORY_BUCKETS.FRESH_PRODUCE,
  'fresh produce': CATEGORY_BUCKETS.FRESH_PRODUCE,
  produce: CATEGORY_BUCKETS.FRESH_PRODUCE,
  'health & beauty': CATEGORY_BUCKETS.HEALTH_BEAUTY,
  'health and beauty': CATEGORY_BUCKETS.HEALTH_BEAUTY,
  'personal care': CATEGORY_BUCKETS.HEALTH_BEAUTY,
  toiletries: CATEGORY_BUCKETS.HEALTH_BEAUTY,
  household: CATEGORY_BUCKETS.HOUSEHOLD,
  'home care': CATEGORY_BUCKETS.HOUSEHOLD,
  confectionery: CATEGORY_BUCKETS.CONFECTIONERY,
  candy: CATEGORY_BUCKETS.CONFECTIONERY,
};

/** Bucket không được ghép với trái/rau tươi. */
const FRESH_PRODUCE_INCOMPATIBLE_BUCKETS = new Set([
  CATEGORY_BUCKETS.DRINKS,
  CATEGORY_BUCKETS.HEALTH_BEAUTY,
  CATEGORY_BUCKETS.HOUSEHOLD,
  CATEGORY_BUCKETS.CONFECTIONERY,
]);

/** Các cặp bucket không được ghép (điểm = 0 ngay lập tức). */
const CATEGORY_INCOMPATIBLE_PAIRS = [
  [CATEGORY_BUCKETS.DRINKS, CATEGORY_BUCKETS.FRESH_PRODUCE],
  [CATEGORY_BUCKETS.DRINKS, CATEGORY_BUCKETS.MEAT_SEAFOOD],
  [CATEGORY_BUCKETS.FRESH_PRODUCE, CATEGORY_BUCKETS.HEALTH_BEAUTY],
  [CATEGORY_BUCKETS.FRESH_PRODUCE, CATEGORY_BUCKETS.HOUSEHOLD],
  [CATEGORY_BUCKETS.FRESH_PRODUCE, CATEGORY_BUCKETS.CONFECTIONERY],
];

/** Từ khóa tìm kiếm thường là trái cây/rau tươi (vd: watermelon) – không fallback sang nước ép. */
const PRODUCE_INTENT_KEYWORDS = [
  'watermelon',
  'melon',
  'mango',
  'pineapple',
  'avocado',
  'apple',
  'banana',
  'orange',
  'grape',
  'berry',
  'strawberry',
  'blueberry',
  'tomato',
  'potato',
  'onion',
  'carrot',
  'broccoli',
  'lettuce',
  'cucumber',
  'mushroom',
  'cabbage',
  'cauliflower',
  'zucchini',
  'capsicum',
  'spinach',
  'celery',
  'pumpkin',
  'corn',
  'herb',
  'parsley',
  'coriander',
  'rockmelon',
  'rock melon',
  'honeydew',
  'cantaloupe',
];

/**
 * Biến thể từ khóa tìm RapidAPI (úc: rockmelon = rock melon).
 * Giúp Coles/Woolworths trả đủ trái tươi dù tên khác nhau.
 */
const PRODUCE_QUERY_ALIASES = {
  watermelon: ['watermelon', 'watermelon fresh'],
  melon: ['rockmelon', 'honeydew', 'melon fresh', 'cantaloupe'],
  rockmelon: ['rockmelon', 'rock melon', 'rockmelon fresh'],
  'rock melon': ['rockmelon', 'rock melon', 'rock melon fresh', 'cantaloupe'],
  honeydew: ['honeydew', 'honey dew', 'honeydew melon'],
  apple: ['apple', 'apples', 'apple fresh'],
  lettuce: ['lettuce', 'lettuce fresh', 'iceberg lettuce'],
};

const CATEGORY_FIELD_KEYS = new Set([
  'category',
  'categories',
  'department',
  'departments',
  'aisle',
  'aisle_name',
  'subcategory',
  'sub_category',
  'breadcrumb',
  'breadcrumbs',
  'category_path',
  'categorypath',
  'product_category',
  'productcategory',
  'department_name',
  'categoryname',
  'category_name',
  'groupname',
  'group_name',
  'shelf',
  'taxonomy',
  'taxonomies',
]);

/** Gom chuỗi từ giá trị JSON (string | number | object | array). */
function flattenCategoryValue(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => flattenCategoryValue(entry, out));
    return out;
  }
  if (typeof value === 'object') {
    const label =
      value.name ||
      value.label ||
      value.title ||
      value.displayName ||
      value.DisplayName ||
      value.CategoryName ||
      value.category_name;
    if (label) flattenCategoryValue(label, out);
    if (value.path) flattenCategoryValue(value.path, out);
    if (value.breadcrumbs) flattenCategoryValue(value.breadcrumbs, out);
  }
  return out;
}

/** Quét object thô RapidAPI (kể cả nested product) để lấy mọi nhãn danh mục. */
function extractCategoryLabelsFromRaw(raw, depth = 0) {
  const labels = [];
  if (!raw || typeof raw !== 'object' || depth > 3) return labels;

  // Chỉ đọc field danh mục đã biết – tránh key kiểu "department_id" gây nhãn sai
  for (const [key, value] of Object.entries(raw)) {
    const keyLower = key.toLowerCase();
    if (CATEGORY_FIELD_KEYS.has(keyLower)) {
      flattenCategoryValue(value, labels);
    }
  }

  if (raw.product && typeof raw.product === 'object') {
    labels.push(...extractCategoryLabelsFromRaw(raw.product, depth + 1));
  }

  return [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))];
}

function buildCategoryMetaFromRaw(raw, displayName) {
  const labels = extractCategoryLabelsFromRaw(raw);
  const path = labels.join(' > ');
  const bucket = classifyCategoryBucket(labels, displayName, raw);
  return { labels, path, bucket };
}

/** Chuỗi danh mục + tên – dùng regex nhận diện bucket. */
function buildCategoryHaystack(labels, displayName) {
  return `${labels.join(' ')} ${displayName}`.toLowerCase().replace(/\s+/g, ' ');
}

function haystackHasWord(haystack, word) {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);
}

/** Tên sản phẩm có chứa đúng từ khóa trái/rau (vd: "watermelon" trong "Red Seedless Watermelon"). */
function productNameMatchesProduceKeyword(name, keyword) {
  const core = stripWeightFromText(keyword);
  const nameNorm = normalizeNameForMatch(name);
  const kwNorm = normalizeNameForMatch(core);
  if (!nameNorm || !kwNorm) return false;

  if (haystackHasWord(nameNorm, kwNorm)) return true;

  const parts = kwNorm.split(' ').filter((w) => w.length > 2);
  if (parts.length > 0 && parts.every((part) => nameNorm.includes(part))) return true;

  // rockmelon / rock melon (một từ ghép – \bmelon\b không khớp trong "rockmelon")
  if (kwNorm === 'rockmelon' || kwNorm === 'rock melon') {
    return /rock\s*melon/i.test(nameNorm);
  }
  if (kwNorm === 'melon') {
    return (
      /rock\s*melon/i.test(nameNorm) ||
      /\bhoneydew\b/i.test(nameNorm) ||
      /\bcantaloupe\b/i.test(nameNorm) ||
      /\bmelon\b/i.test(nameNorm)
    );
  }

  return nameNorm.replace(/\s+/g, '').includes(kwNorm.replace(/\s+/g, ''));
}

/**
 * Danh sách truy vấn RapidAPI (ưu tiên từ gốc, sau đó alias + "fresh").
 */
function expandProduceSearchQueries(searchText, listItem = null) {
  const trimmed = String(searchText || '').trim();
  const core = stripWeightFromText(listItem?.keyword || trimmed);
  const normalized = normalizeSearchQuery(core);
  const queries = [];

  if (trimmed) queries.push(trimmed);
  if (core && normalizeSearchQuery(trimmed) !== normalized) queries.push(core);

  const aliases = PRODUCE_QUERY_ALIASES[normalized];
  if (aliases) queries.push(...aliases);

  if (inferIntentBucketFromKeyword(core, listItem) === CATEGORY_BUCKETS.FRESH_PRODUCE) {
    if (core) queries.push(`${core} fresh`);
  }

  return [...new Set(queries.map((q) => String(q).trim()).filter(Boolean))];
}

/** Gộp kết quả tìm kiếm, bỏ trùng theo productId / tên */
function mergeProductLists(listA, listB, limit = RESULT_LIMIT) {
  const seen = new Set();
  const merged = [];

  const addList = (list) => {
    for (const product of list) {
      const key = product.productId || `${product.supermarket}:${product.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(product);
      if (merged.length >= limit) return;
    }
  };

  addList(listA);
  addList(listB);
  return merged;
}

function isProduceSearchIntent(keyword, listItem = {}) {
  return inferIntentBucketFromKeyword(keyword, listItem) === CATEGORY_BUCKETS.FRESH_PRODUCE;
}

/** Nước ép / đồ uống đóng chai – từ API hoặc tên (H2juice … 1.25L). */
function haystackSuggestsDrinks(haystack, displayName) {
  const drinkTerms = [
    'drink',
    'drinks',
    'beverage',
    'beverages',
    'juice',
    'juices',
    'cordial',
    'soft drink',
    'soda',
    'cola',
    'lemonade',
    'kombucha',
    'energy drink',
    'iced tea',
    'milk drink',
    'flavoured milk',
    'smoothie',
    'h2juice',
    'bottled',
  ];
  if (
    drinkTerms.some((term) =>
      term.includes(' ') ? haystack.includes(term) : haystackHasWord(haystack, term)
    )
  ) {
    return true;
  }

  const nameNorm = normalizeNameForMatch(displayName);
  if (/\b(juice|cordial|soft drink|soda|cola|lemonade|beverage|h2juice|drink)\b/.test(nameNorm)) {
    return true;
  }

  // Chai/lon: có dung tích ml/L mà không phải rau quả bán lẻ
  const sizeInfo = extractSizeInfo(displayName);
  const hasBottleVolume =
    sizeInfo.grams != null &&
    (/\b\d+(?:\.\d+)?\s*ml\b/i.test(displayName) || /\b\d+(?:\.\d+)?\s*l\b/i.test(displayName));
  if (hasBottleVolume && !looksLikeLooseFreshProduceName(displayName)) {
    return true;
  }

  return false;
}

/** Trái cây / rau củ tươi – từ breadcrumbs hoặc tên (seedless watermelon, per kg). */
function haystackSuggestsFreshProduce(haystack, displayName, raw = {}) {
  const freshTerms = [
    'fruit',
    'fruits',
    'vegetable',
    'vegetables',
    'fruit & veg',
    'fruit and veg',
    'fresh food',
    'fresh produce',
    'produce',
    'salad',
    'herbs',
  ];
  if (freshTerms.some((term) => haystack.includes(term))) return true;
  if (looksLikeLooseFreshProduceName(displayName)) return true;
  if (isFreshFoodCategory(displayName)) return true;

  const perKg =
    resolvePricePerKg(raw, displayName, parsePrice(raw.price) ?? parsePrice(raw.current_price))
      .pricePerKg != null;
  if (perKg && !haystackSuggestsDrinks(haystack, displayName)) return true;

  return false;
}

function haystackSuggestsMeatSeafood(haystack) {
  return /\b(meat|seafood|poultry|butcher|deli meat|fish)\b/i.test(haystack);
}

/** Sản phẩm chế biến chỉ “mượn” từ khóa (vd: chicken thigh → Thigh Burger, prawn → crackers). */
function nameSuggestsProcessedNotCoreIngredient(displayName, keyword) {
  const nameNorm = normalizeNameForMatch(displayName);
  const kwNorm = normalizeNameForMatch(stripWeightFromText(keyword));
  const primary = kwNorm.split(' ').filter((w) => w.length > 2)[0];
  if (!primary) return false;

  const sharesKeyword = haystackHasWord(nameNorm, primary);

  if (searchIntentSuggestsProcessedFood(keyword)) {
    return false;
  }

  if (
    searchIntentSuggestsRawIngredient(keyword) &&
    nameSuggestsProcessedPreparedFood(displayName)
  ) {
    return true;
  }

  if (!sharesKeyword) return false;

  return nameSuggestsProcessedPreparedFood(displayName);
}

/** Kẹo/snack/rượu – tên có "watermelon" nhưng không phải quả tươi. */
function nameSuggestsNonFreshProduceSnack(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  return /\b(sour|lollies|lolly|candy|chocolate|chips|crisps|snack|muesli|gin|vodka|beer|wine|liqueur|cordial concentrate|roller|dettol|soap|shampoo)\b/.test(
    nameNorm
  );
}

/** Từ khóa đồ uống trong tên (không gọi looksLikeLooseFreshProduceName – tránh đệ quy). */
function hasPackagedDrinkKeywords(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  return /\b(water|juice|cordial|soft drink|soda|cola|lemonade|beverage|h2juice|drink|can|sparkling|powder)\b/.test(
    nameNorm
  );
}

/** Tên gợi ý trái cây/rau bán tươi (không phải chai nước ép). */
function looksLikeLooseFreshProduceName(displayName) {
  if (nameSuggestsNonFoodProductTitle(displayName)) return false;
  if (nameLooksLikePantryProduceBrandTrap(displayName)) return false;
  if (nameSuggestsShelfStableProducePack(displayName)) return false;
  const nameNorm = normalizeNameForMatch(displayName);
  if (hasPackagedDrinkKeywords(displayName)) return false;

  if (
    /\b(seedless|cut|half|quarter|whole|sliced|wedge|loose)\b/.test(nameNorm) &&
    /\b(watermelon|melon|pineapple|pumpkin|rockmelon|honeydew)\b/.test(nameNorm)
  ) {
    return true;
  }

  if (PRODUCE_INTENT_KEYWORDS.some((kw) => haystackHasWord(nameNorm, kw))) {
    if (!/\b(juice|cordial|drink|beverage|soda)\b/.test(nameNorm)) return true;
  }

  return false;
}

/** Chai/lon nước – dùng khi bucket API là unknown. */
function nameSuggestsPackagedDrink(displayName) {
  if (hasPackagedDrinkKeywords(displayName)) return true;

  const sizeInfo = extractSizeInfo(displayName);
  const hasBottleVolume =
    sizeInfo.grams != null &&
    (/\b\d+(?:\.\d+)?\s*ml\b/i.test(displayName) || /\b\d+(?:\.\d+)?\s*l\b/i.test(displayName));

  if (!hasBottleVolume) return false;

  // Có dung tích chai nhưng tên là dưa/táo/rau tươi → không phải nước ép
  return !looksLikeLooseFreshProduceName(displayName);
}

/**
 * Gán bucket cho 1 sản phẩm: ưu tiên category API, sau đó heuristics tên.
 */
function classifyCategoryBucket(labels, displayName, raw = {}) {
  const haystack = buildCategoryHaystack(labels, displayName);
  const nameNorm = normalizeNameForMatch(displayName);

  if (nameSuggestsNonFoodProductTitle(displayName) || haystackSuggestsNonFoodDepartment(haystack)) {
    if (
      /\b(soap|dettol|shampoo|body wash|toiletries|hygiene|cleanser)\b/i.test(nameNorm + haystack)
    ) {
      return CATEGORY_BUCKETS.HEALTH_BEAUTY;
    }
    if (/\b(household|cleaning|laundry|detergent|home care)\b/i.test(haystack)) {
      return CATEGORY_BUCKETS.HOUSEHOLD;
    }
    return CATEGORY_BUCKETS.CONFECTIONERY;
  }

  // Tên đã rõ là trái/rau tươi → ưu tiên trước nhãn "Drinks" từ API
  if (
    looksLikeLooseFreshProduceName(displayName) ||
    (PRODUCE_INTENT_KEYWORDS.some((kw) =>
      haystackHasWord(normalizeNameForMatch(displayName), kw)
    ) &&
      !hasPackagedDrinkKeywords(displayName))
  ) {
    return CATEGORY_BUCKETS.FRESH_PRODUCE;
  }

  const isDrink = haystackSuggestsDrinks(haystack, displayName);
  const isFresh = haystackSuggestsFreshProduce(haystack, displayName, raw);
  const isMeat = haystackSuggestsMeatSeafood(haystack);

  if (isDrink && isFresh) {
    return nameSuggestsPackagedDrink(displayName)
      ? CATEGORY_BUCKETS.DRINKS
      : CATEGORY_BUCKETS.FRESH_PRODUCE;
  }
  if (isDrink) return CATEGORY_BUCKETS.DRINKS;
  if (isFresh) return CATEGORY_BUCKETS.FRESH_PRODUCE;
  if (isMeat) return CATEGORY_BUCKETS.MEAT_SEAFOOD;

  if (/\b(dairy|milk|cheese|yoghurt|yogurt|butter)\b/i.test(haystack)) {
    return CATEGORY_BUCKETS.DAIRY;
  }
  if (/\b(bakery|bread|baked)\b/i.test(haystack)) return CATEGORY_BUCKETS.BAKERY;
  if (/\b(frozen|freezer)\b/i.test(haystack)) return CATEGORY_BUCKETS.FROZEN;
  if (/\b(confectionery|candy|lollies|snack bar)\b/i.test(haystack)) {
    return CATEGORY_BUCKETS.CONFECTIONERY;
  }
  if (/\b(health|beauty|personal care|toiletries|soap|shampoo)\b/i.test(haystack)) {
    return CATEGORY_BUCKETS.HEALTH_BEAUTY;
  }
  if (/\b(household|cleaning|laundry|home care)\b/i.test(haystack)) {
    return CATEGORY_BUCKETS.HOUSEHOLD;
  }
  if (/\b(pantry|grocery|snack)\b/i.test(haystack)) {
    return CATEGORY_BUCKETS.PANTRY;
  }

  if (nameSuggestsPackagedDrink(displayName)) return CATEGORY_BUCKETS.DRINKS;
  if (looksLikeLooseFreshProduceName(displayName)) return CATEGORY_BUCKETS.FRESH_PRODUCE;

  const meatTokens = [
    'pork',
    'beef',
    'lamb',
    'veal',
    'chicken',
    'turkey',
    'duck',
    'mince',
    'steak',
    'fillet',
    'salmon',
    'prawn',
    'fish',
  ];
  if (meatTokens.some((token) => haystackHasWord(nameNorm, token))) {
    return CATEGORY_BUCKETS.MEAT_SEAFOOD;
  }
  if (
    PRODUCE_INTENT_KEYWORDS.some((kw) => haystackHasWord(nameNorm, kw)) &&
    !nameSuggestsNonFoodProductTitle(displayName)
  ) {
    return CATEGORY_BUCKETS.FRESH_PRODUCE;
  }

  return CATEGORY_BUCKETS.UNKNOWN;
}

function resolveProductBucket(productOrName, rawFallback = null) {
  if (productOrName && typeof productOrName === 'object') {
    if (productOrName.categoryBucket) {
      return (
        normalizeCategoryBucketLabel(productOrName.categoryBucket) || productOrName.categoryBucket
      );
    }
    return classifyCategoryBucket(
      productOrName.categoryLabels || [],
      productOrName.name || '',
      rawFallback || {}
    );
  }
  return classifyCategoryBucket([], String(productOrName || ''), rawFallback || {});
}

function resolveProductName(input) {
  if (input && typeof input === 'object') return input.name || '';
  return String(input || '');
}

/** Hai bucket có được ghép / so sánh với nhau không. */
function areCategoryBucketsCompatible(bucketA, bucketB) {
  const a = normalizeCategoryBucketLabel(bucketA) || CATEGORY_BUCKETS.UNKNOWN;
  const b = normalizeCategoryBucketLabel(bucketB) || CATEGORY_BUCKETS.UNKNOWN;
  if (a === b) return true;
  if (a === CATEGORY_BUCKETS.UNKNOWN || b === CATEGORY_BUCKETS.UNKNOWN) return true;

  if (a === CATEGORY_BUCKETS.FRESH_PRODUCE && FRESH_PRODUCE_INCOMPATIBLE_BUCKETS.has(b)) {
    return false;
  }
  if (b === CATEGORY_BUCKETS.FRESH_PRODUCE && FRESH_PRODUCE_INCOMPATIBLE_BUCKETS.has(a)) {
    return false;
  }

  return !CATEGORY_INCOMPATIBLE_PAIRS.some(
    ([left, right]) => (a === left && b === right) || (a === right && b === left)
  );
}

/**
 * Ghép cặp 2 sản phẩm đã chuẩn hóa – chặn Drinks ↔ Fresh.
 * Kể cả khi API thiếu category (unknown) nhưng tên đã rõ (chai 1.25L vs seedless).
 */
function areProductCategoriesCompatible(productA, productB) {
  const nameA = resolveProductName(productA);
  const nameB = resolveProductName(productB);
  const bucketA = resolveProductBucket(productA);
  const bucketB = resolveProductBucket(productB);

  if (hasCrossDepartmentFoodNonFoodMismatch(nameA, productA, nameB, productB)) {
    return false;
  }
  if (hasFreshProduceNonFoodKeywordConflict(nameA, productA, nameB, productB)) {
    return false;
  }

  const drinkA = bucketA === CATEGORY_BUCKETS.DRINKS || nameSuggestsPackagedDrink(nameA);
  const drinkB = bucketB === CATEGORY_BUCKETS.DRINKS || nameSuggestsPackagedDrink(nameB);
  const freshA = productInFreshProduceContext(nameA, productA);
  const freshB = productInFreshProduceContext(nameB, productB);

  if ((drinkA && freshB) || (drinkB && freshA)) return false;

  const procA = nameSuggestsProcessedPreparedFood(nameA);
  const procB = nameSuggestsProcessedPreparedFood(nameB);
  if (procA !== procB) return false;

  return areCategoryBucketsCompatible(bucketA, bucketB);
}

/**
 * Ý định tìm kiếm từ từ khóa người dùng / dòng giỏ AI.
 * "watermelon" → fresh_produce; "watermelon juice" → drinks.
 */
function inferIntentBucketFromKeyword(keyword, listItem = {}) {
  if (listItem?.is_fresh_produce === true) {
    return CATEGORY_BUCKETS.FRESH_PRODUCE;
  }
  const combined = `${keyword || ''} ${listItem.clean_query || listItem.keyword || ''}`.trim();
  const core = stripWeightFromText(combined);
  const norm = normalizeNameForMatch(core);
  if (!norm) return null;

  if (/\b(juice|drink|drinks|cordial|soda|beverage|soft drink)\b/.test(norm)) {
    return CATEGORY_BUCKETS.DRINKS;
  }

  const meatSeaTokens = [
    'prawn',
    'shrimp',
    'salmon',
    'barramundi',
    'fish',
    'pork',
    'beef',
    'lamb',
    'chicken',
    'turkey',
    'duck',
    'mince',
    'steak',
    'fillet',
    'thigh',
    'breast',
    'drumstick',
    'seafood',
    'crab',
    'squid',
  ];
  const looksLikeMeatSeafood =
    meatSeaTokens.some((kw) => haystackHasWord(norm, kw)) &&
    !/\b(cracker|crackers|sauce|stock|powder|noodle|paste|juice)\b/.test(norm);

  if (looksLikeMeatSeafood) {
    if (searchIntentSuggestsProcessedFood(keyword, listItem)) {
      return null;
    }
    return CATEGORY_BUCKETS.MEAT_SEAFOOD;
  }

  if (PRODUCE_INTENT_KEYWORDS.some((kw) => haystackHasWord(norm, kw))) {
    return CATEGORY_BUCKETS.FRESH_PRODUCE;
  }

  if (isFreshFoodCategory(core)) {
    const unit = String(listItem.unit || '').toLowerCase();
    if (['kg', 'g', 'each', 'bunch'].includes(unit)) {
      return CATEGORY_BUCKETS.FRESH_PRODUCE;
    }
  }

  return null;
}

/** Sản phẩm có phù hợp ý định tìm kiếm không (vd: không chọn chai nước khi tìm "watermelon"). */
function isProductEligibleForSearchIntent(product, keyword, listItem = {}) {
  const intent = inferIntentBucketFromKeyword(keyword, listItem);
  if (!intent) return true;

  const bucket = resolveProductBucket(product);
  const name = product?.name || '';

  if (intent === CATEGORY_BUCKETS.FRESH_PRODUCE) {
    if (nameSuggestsPackagedDrink(name)) return false;
    if (nameSuggestsNonFreshProduceSnack(name)) return false;
    if (nameSuggestsNonFoodProductTitle(name)) return false;
    if (productInNonFoodDepartment(product, name)) return false;

    // Tên rõ là trái tươi dù API gán nhầm bucket "drinks"
    if (
      productNameMatchesProduceKeyword(name, keyword) &&
      !nameSuggestsPackagedDrink(name) &&
      !nameSuggestsNonFoodProductTitle(name)
    ) {
      return true;
    }

    if (bucket === CATEGORY_BUCKETS.DRINKS) return false;
    if (FRESH_PRODUCE_INCOMPATIBLE_BUCKETS.has(bucket)) return false;
    if (bucket === CATEGORY_BUCKETS.FRESH_PRODUCE) return true;
    if (bucket === CATEGORY_BUCKETS.UNKNOWN) {
      return (
        looksLikeLooseFreshProduceName(name) ||
        (productNameMatchesProduceKeyword(name, keyword) && !nameSuggestsNonFoodProductTitle(name))
      );
    }
    return areCategoryBucketsCompatible(intent, bucket);
  }

  if (intent === CATEGORY_BUCKETS.DRINKS) {
    if (bucket === CATEGORY_BUCKETS.FRESH_PRODUCE && !nameSuggestsPackagedDrink(name)) {
      return false;
    }
  }

  if (intent === CATEGORY_BUCKETS.MEAT_SEAFOOD) {
    if (nameSuggestsProcessedNotCoreIngredient(name, keyword)) return false;
    if (nameSuggestsPackagedDrink(name)) return false;
    if (bucket === CATEGORY_BUCKETS.DRINKS || bucket === CATEGORY_BUCKETS.PANTRY) return false;
    return (
      bucket === CATEGORY_BUCKETS.MEAT_SEAFOOD ||
      bucket === CATEGORY_BUCKETS.FROZEN ||
      isFreshFoodCategory(name)
    );
  }

  if (bucket === CATEGORY_BUCKETS.UNKNOWN) return true;
  return areCategoryBucketsCompatible(intent, bucket);
}

/**
 * Lọc danh sách kết quả theo ngành hàng trước khi chấm điểm.
 * Với trái cây tươi: không fallback sang đồ uống nếu không có hàng tươi.
 */
function filterProductsForSearchIntent(products, keyword, listItem = {}) {
  const intent = inferIntentBucketFromKeyword(keyword, listItem);
  if (!intent || !products?.length) return products;

  if (intent === CATEGORY_BUCKETS.FRESH_PRODUCE) {
    return products.filter((p) => {
      const name = p?.name || '';
      if (nameSuggestsProcessedNotCoreIngredient(name, keyword)) return false;
      if (nameSuggestsPackagedDrink(name)) return false;
      if (nameSuggestsNonFreshProduceSnack(name)) return false;
      if (nameSuggestsNonFoodProductTitle(name)) return false;
      if (productInNonFoodDepartment(p, name)) return false;
      if (resolveProductBucket(p) === CATEGORY_BUCKETS.DRINKS) return false;
      if (FRESH_PRODUCE_INCOMPATIBLE_BUCKETS.has(resolveProductBucket(p))) return false;
      if (!isFreshProduceCandidateForIntent(name, p, keyword, listItem)) return false;
      return (
        productNameMatchesProduceKeyword(name, keyword) ||
        looksLikeLooseFreshProduceName(name) ||
        isFreshFoodCategory(name) ||
        resolveProductBucket(p) === CATEGORY_BUCKETS.FRESH_PRODUCE
      );
    });
  }

  if (intent === CATEGORY_BUCKETS.MEAT_SEAFOOD) {
    const kwNorm = normalizeNameForMatch(stripWeightFromText(keyword));
    const kwPrimary = kwNorm.split(' ').filter((w) => w.length > 2)[0] || kwNorm;
    return products.filter((p) => {
      const name = p?.name || '';
      if (nameSuggestsProcessedNotCoreIngredient(name, keyword)) return false;
      if (nameSuggestsPackagedDrink(name)) return false;
      const bucket = resolveProductBucket(p);
      if (bucket === CATEGORY_BUCKETS.DRINKS || bucket === CATEGORY_BUCKETS.PANTRY) {
        return false;
      }
      const nameNorm = normalizeNameForMatch(name);
      return (
        bucket === CATEGORY_BUCKETS.MEAT_SEAFOOD ||
        bucket === CATEGORY_BUCKETS.FROZEN ||
        (isFreshFoodCategory(name) && haystackHasWord(nameNorm, kwPrimary))
      );
    });
  }

  return products.filter((p) => {
    const name = p?.name || '';
    if (nameSuggestsProcessedNotCoreIngredient(name, keyword)) return false;
    return isProductEligibleForSearchIntent(p, keyword, listItem);
  });
}

/** Chuẩn hóa tên trước khi so khớp (bỏ tiền tố siêu thị, ký tự thừa) */
function normalizeNameForMatch(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b(woolworths|coles|essentials|macro|sunrice|riviana|bens original)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Các nhãn loại sản phẩm – dùng để tránh ghép Jasmine với Basmati, v.v. */
const VARIETY_KEYWORDS = [
  'jasmine',
  'basmati',
  'long grain',
  'brown',
  'white',
  'full cream',
  'skim',
  'lite',
  'light',
  'organic',
  'microwave',
  'greek',
  'coconut',
  'sparkling',
  'spring water',
];

const VARIETY_CONFLICTS = [
  ['jasmine', 'basmati'],
  ['brown', 'white'],
  ['full cream', 'skim'],
  ['full cream', 'lite'],
  ['full cream', 'light'],
];

/**
 * Từ qualifier — phải xuất hiện ở CẢ HAI tên hoặc KHÔNG tên nào.
 * Ngăn ghép rau phương Tây ↔ biến thể Á/châu Á, organic ↔ thường, v.v.
 */
const MATCH_ASYMMETRIC_QUALIFIERS = [
  'chinese broccoli',
  'kai lan',
  'gai lan',
  'choy sum',
  'bok choy',
  'pak choy',
  'free range',
  'barn laid',
  'chinese',
  'asian',
  'choy',
  'sprouted',
  'organic',
  'broccolini',
  'romanesco',
  'baby',
  'purple',
  'wombok',
  'continental',
  'lebanese',
  'english',
  'persian',
  'dutch',
  'kent',
  'sebago',
  'truss',
  'vine',
  'snacking',
].sort((a, b) => b.length - a.length);

/** Đánh dấu dòng rau/trái cây chuyên biệt hoặc theo vùng — không ghép với generic cùng loài. */
const PRODUCE_SPECIALIZATION_MARKERS = [
  'chinese',
  'asian',
  'choy',
  'choy sum',
  'bok choy',
  'gai lan',
  'kai lan',
  'broccolini',
  'romanesco',
  'sprouted',
  'wombok',
  'persian',
  'lebanese',
  'continental',
  'kent',
  'sebago',
  'snacking',
  'truss',
  'vine',
];

const MATCH_STOP_WORDS = new Set([
  'fresh',
  'each',
  'loose',
  'per',
  'pack',
  'coles',
  'woolworths',
  'woolies',
  'the',
  'and',
  'with',
  'for',
  'from',
  'free',
  'range',
  'australian',
  'aust',
  'locally',
  'grown',
  'piece',
  'bunch',
  'tray',
  'approx',
  'whole',
  'half',
  'red',
  'green',
  'large',
  'small',
  'medium',
]);

function titleHasQualifier(nameNorm, qualifier) {
  if (qualifier.includes(' ')) return nameNorm.includes(qualifier);
  return haystackHasWord(nameNorm, qualifier);
}

function extractMatchQualifiers(name) {
  const norm = normalizeNameForMatch(name);
  if (!norm) return [];
  const found = [];
  for (const q of MATCH_ASYMMETRIC_QUALIFIERS) {
    if (titleHasQualifier(norm, q)) found.push(q);
  }
  return found;
}

function matchQualifiersCompatible(nameA, nameB) {
  const qA = extractMatchQualifiers(nameA);
  const qB = extractMatchQualifiers(nameB);
  const onlyA = qA.filter((q) => !qB.includes(q));
  const onlyB = qB.filter((q) => !qA.includes(q));
  if (onlyA.length || onlyB.length) {
    return {
      ok: false,
      reason: `qualifier mismatch (only WW: [${onlyA.join(', ')}], only Coles: [${onlyB.join(', ')}])`,
    };
  }
  return { ok: true };
}

function produceVariantConflict(nameA, nameB) {
  if (!isFreshFoodCategory(nameA) || !isFreshFoodCategory(nameB)) return false;

  const normA = normalizeNameForMatch(nameA);
  const normB = normalizeNameForMatch(nameB);
  const basesA = FRESH_FOOD_TOKENS.filter((token) => haystackHasWord(normA, token));
  const basesB = FRESH_FOOD_TOKENS.filter((token) => haystackHasWord(normB, token));
  const shared = basesA.filter((token) => basesB.includes(token));
  if (!shared.length) return false;

  const hasSpec = (norm) =>
    PRODUCE_SPECIALIZATION_MARKERS.some((marker) => titleHasQualifier(norm, marker));
  return hasSpec(normA) !== hasSpec(normB);
}

function extractSignificantMatchTokens(nameNorm) {
  return nameNorm
    .split(' ')
    .filter((word) => word.length > 2 && !MATCH_STOP_WORDS.has(word) && !/^\d+$/.test(word));
}

function isShallowProduceTokenMatch(nameA, nameB) {
  if (!isFreshFoodCategory(nameA) || !isFreshFoodCategory(nameB)) return false;

  const normA = normalizeNameForMatch(nameA);
  const normB = normalizeNameForMatch(nameB);
  const tokensA = extractSignificantMatchTokens(normA);
  const tokensB = extractSignificantMatchTokens(normB);
  const shared = tokensA.filter((token) => tokensB.includes(token));
  const produceShared = shared.filter((token) =>
    FRESH_FOOD_TOKENS.some((ft) => token === ft || haystackHasWord(token, ft))
  );
  if (!produceShared.length) return false;

  const sim = stringSimilarity.compareTwoStrings(normA, normB);
  return (
    produceShared.length <= 1 && shared.length <= 2 && sim < MIN_FRESH_SHALLOW_TOKEN_SIMILARITY
  );
}

function logMatchDecision(woolName, colesName, score, detail) {
  const tag =
    typeof score === 'number' && score >= SMART_MATCH_MIN_PAIR_SCORE ? 'ACCEPT' : 'REJECT';
  const scoreText = typeof score === 'number' ? score.toFixed(2) : 'N/A';
  console.log(
    `[Match:${tag}] score=${scoreText} | WW="${woolName}" ↔ Coles="${colesName}" | ${detail}`
  );
}

function extractVarieties(name) {
  const lower = String(name).toLowerCase();
  return VARIETY_KEYWORDS.filter((keyword) => lower.includes(keyword));
}

/** Hai tên có cùng “dòng” sản phẩm (không Jasmine vs Basmati, không Broccoli vs Chinese Broccoli) */
function varietiesCompatible(nameA, nameB) {
  if (!matchQualifiersCompatible(nameA, nameB).ok) return false;
  if (produceVariantConflict(nameA, nameB)) return false;

  const vA = extractVarieties(nameA);
  const vB = extractVarieties(nameB);
  if (!vA.length && !vB.length) return true;

  if (!vA.length || !vB.length) {
    const normA = normalizeNameForMatch(nameA);
    const normB = normalizeNameForMatch(nameB);
    const organicA = vA.includes('organic') || haystackHasWord(normA, 'organic');
    const organicB = vB.includes('organic') || haystackHasWord(normB, 'organic');
    if (organicA !== organicB) return false;
    if (isFreshFoodCategory(nameA) && isFreshFoodCategory(nameB)) return false;
    return true;
  }

  for (const [left, right] of VARIETY_CONFLICTS) {
    const aHasLeft = vA.includes(left);
    const aHasRight = vA.includes(right);
    const bHasLeft = vB.includes(left);
    const bHasRight = vB.includes(right);
    if ((aHasLeft && bHasRight) || (aHasRight && bHasLeft)) return false;
  }

  return vA.some((v) => vB.includes(v));
}

/** Trích khối lượng / dung tích / số pack từ tên sản phẩm */
function extractSizeInfo(name) {
  const text = String(name).toLowerCase();
  let grams = null;
  let packCount = 1;

  const kgMatch = text.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  const gMatch = text.match(/(\d+(?:\.\d+)?)\s*g\b/);
  const lMatch = text.match(/(\d+(?:\.\d+)?)\s*l\b/);
  const mlMatch = text.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  const packMatch = text.match(/(?:x\s*)?(\d+)\s*(?:pack|pk)\b/);

  if (kgMatch) grams = parseFloat(kgMatch[1]) * 1000;
  else if (gMatch && !kgMatch) grams = parseFloat(gMatch[1]);
  else if (lMatch) grams = parseFloat(lMatch[1]) * 1000;
  else if (mlMatch) grams = parseFloat(mlMatch[1]);

  if (packMatch) packCount = parseInt(packMatch[1], 10);

  return { grams, packCount };
}

/**
 * Kiểm tra size/pack có tương thích không.
 * - conflict: 2kg vs 1kg, 6-pack vs đơn lẻ → không ghép
 * - mismatch_one_sided: một bên có size, bên kia không → phạt điểm
 */
function checkSizeCompatibility(nameA, nameB, productA = null, productB = null) {
  if (hasPackagingFormMismatch(nameA, productA, nameB, productB)) {
    return 'conflict';
  }

  const a = extractSizeInfo(nameA);
  const b = extractSizeInfo(nameB);
  const freshPair =
    freshFoodCorePhraseMatch(nameA, nameB) ||
    (isFreshFoodCategory(nameA) && isFreshFoodCategory(nameB));
  const minWeightRatio = freshPair ? FRESH_PRODUCE_MIN_WEIGHT_RATIO : 0.85;

  if (a.packCount !== b.packCount && (a.packCount > 1 || b.packCount > 1)) {
    return 'conflict';
  }

  if (a.grams != null && b.grams != null) {
    const ratio = Math.min(a.grams, b.grams) / Math.max(a.grams, b.grams);
    if (ratio < minWeightRatio) return 'conflict';
    return 'ok';
  }

  if ((a.grams != null && b.grams == null) || (a.grams == null && b.grams != null)) {
    return 'mismatch_one_sided';
  }

  return 'ok';
}

/**
 * Cross-store compare pair scorer (scoreProductPairForCompare).
 * Danh mục + tên + loại + khối lượng + guardrails phi thực phẩm.
 */
function scoreProductPair(woolInput, colesInput) {
  const woolName = resolveProductName(woolInput);
  const colesName = resolveProductName(colesInput);
  const woolNorm = normalizeNameForMatch(woolName);
  const colesNorm = normalizeNameForMatch(colesName);
  if (!woolNorm || !colesNorm) return 0;

  const guardrailReason = evaluatePairingGuardrails(woolName, woolInput, colesName, colesInput);
  if (guardrailReason) return 0;

  // Drinks ↔ Fresh (vd: H2juice Watermelon vs Seedless Watermelon) → không ghép
  if (!areProductCategoriesCompatible(woolInput, colesInput)) return 0;

  if (
    nameSuggestsProcessedPreparedFood(woolName) !== nameSuggestsProcessedPreparedFood(colesName)
  ) {
    return 0;
  }

  if (!matchQualifiersCompatible(woolName, colesName).ok) return 0;
  if (produceVariantConflict(woolName, colesName)) return 0;

  const nameSim = stringSimilarity.compareTwoStrings(woolNorm, colesNorm);
  if (nameSim < MIN_PAIR_NAME_SIMILARITY) return 0;
  if (isShallowProduceTokenMatch(woolName, colesName)) return 0;

  // Cùng cụm "pork belly" → ghép dù khác Roast / Slices / Rind On
  if (freshFoodCorePhraseMatch(woolName, colesName)) {
    return Math.min(Math.max(nameSim, FRESH_PAIR_SCORE_FLOOR), 1);
  }

  if (!varietiesCompatible(woolName, colesName)) return 0;

  const sizeStatus = checkSizeCompatibility(woolName, colesName, woolInput, colesInput);
  if (sizeStatus === 'conflict') return 0;

  let score = nameSim;

  if (sizeStatus === 'mismatch_one_sided') {
    const freshLoose = isFreshFoodCategory(woolName) || isFreshFoodCategory(colesName);
    score *= freshLoose ? 0.9 : 0.72;
  }

  return score;
}

/**
 * Chấm điểm 1 sản phẩm so với từ khóa người dùng (AI shopping list).
 * Dùng cùng logic loại/size như ghép cặp similar.
 */
function scoreProductForKeyword(
  productName,
  keyword,
  hintText = '',
  listItem = {},
  product = null
) {
  const productRef = product || { name: productName };
  const displayName = productRef.name || productName;
  const fullShortKeywordMatch = productNameHasFullShortKeywordMatch(displayName, keyword, listItem);

  if (fullShortKeywordMatch && !isProduceSearchIntent(keyword, listItem)) {
    const productNorm = normalizeNameForMatch(displayName);
    const queryNorm = normalizeNameForMatch(stripWeightFromText(keyword));
    const base = stringSimilarity.compareTwoStrings(productNorm, queryNorm);
    return Math.max(base, 0.5);
  }

  if (!isProductEligibleForSearchIntent(productRef, keyword, listItem)) return 0;
  if (nameSuggestsNonFreshProduceSnack(displayName)) return 0;
  if (nameSuggestsNonFoodProductTitle(displayName)) return 0;
  if (productInNonFoodDepartment(productRef, displayName)) return 0;

  if (!fullShortKeywordMatch && nameSuggestsProcessedNotCoreIngredient(displayName, keyword)) {
    return 0;
  }
  if (!isFreshProduceCandidateForIntent(displayName, productRef, keyword, listItem)) return 0;

  const coreKeyword = stripWeightFromText(keyword);
  const query = `${coreKeyword} ${hintText}`.trim();
  const productNorm = normalizeNameForMatch(displayName);
  const queryNorm = normalizeNameForMatch(query);
  if (!productNorm || !queryNorm) return 0;

  if (freshFoodCorePhraseMatch(displayName, coreKeyword)) {
    const base = stringSimilarity.compareTwoStrings(productNorm, queryNorm);
    return Math.min(Math.max(base, FRESH_PAIR_SCORE_FLOOR - 0.05), 1);
  }

  const produceNameHit =
    isProduceSearchIntent(keyword, listItem) &&
    productNameMatchesProduceKeyword(displayName, keyword) &&
    !nameSuggestsPackagedDrink(displayName);

  if (!produceNameHit && !fullShortKeywordMatch && !varietiesCompatible(displayName, query)) {
    return 0;
  }

  const sizeStatus = checkSizeCompatibility(displayName, query);
  if (!produceNameHit && sizeStatus === 'conflict') return 0;

  let score = stringSimilarity.compareTwoStrings(productNorm, queryNorm);

  const words = queryNorm.split(' ').filter((w) => w.length > 2);
  for (const word of words) {
    if (productNorm.includes(word)) score += 0.04;
  }

  if (fullShortKeywordMatch) {
    // Generic queries như "eggs", "milk", "toilet paper" thường có tên dài/brand.
    // Nếu tên chứa đủ từ khóa (hoặc synonym như toilet tissue), cho điểm sàn để không bị rớt.
    score = Math.max(score, 0.5);
  }

  if (isFreshFoodCategory(displayName) && isFreshFoodCategory(coreKeyword)) {
    const coreWords = stripWeightFromText(coreKeyword)
      .split(' ')
      .filter((w) => w.length > 2);
    const allInProduct = coreWords.length > 0 && coreWords.every((w) => productNorm.includes(w));
    if (allInProduct) score = Math.max(score, 0.52);
  }

  const intent = inferIntentBucketFromKeyword(keyword, listItem);
  const productBucket = resolveProductBucket(productRef);
  if (intent && productBucket !== CATEGORY_BUCKETS.UNKNOWN && intent === productBucket) {
    score = Math.min(score + 0.08, 1);
  }

  // Trái/rau (watermelon, apple…): điểm sàn chỉ khi đúng loại tươi — không rice/soap/jar
  if (
    isProduceSearchIntent(keyword, listItem) &&
    isGenuineFreshProduceForIntent(displayName, productRef, keyword, listItem) &&
    productNameMatchesProduceKeyword(displayName, keyword) &&
    !nameSuggestsPackagedDrink(displayName)
  ) {
    score = Math.max(score, 0.58);
  }

  // Rau/quả each: ưu tiên "Whole"; với trái tươi vẫn chấp nhận cắt miếng (không phạt quá nặng)
  if (wantsWholeUnitEach(listItem)) {
    const frac = detectFractionalUnit(displayName);
    if (frac.isWhole) {
      score = Math.min(score + 0.14, 1);
    } else if (frac.penalizeMatch) {
      if (
        isProduceSearchIntent(keyword, listItem) &&
        productNameMatchesProduceKeyword(displayName, keyword)
      ) {
        score *= 0.88;
      } else {
        score *= frac.type === 'slices' ? 0.42 : 0.36;
      }
    }
  }

  if (sizeStatus === 'mismatch_one_sided') {
    score *= isFreshFoodCategory(displayName) ? 0.92 : 0.85;
  }

  return Math.min(score, 1);
}

/** Chọn sản phẩm khớp nhất trong danh sách kết quả tìm kiếm */
function pickBestProductMatch(products, keyword, listItem = {}) {
  if (!products?.length) return { product: null, score: 0 };

  const candidates = filterProductsForSearchIntent(products, keyword, listItem);
  if (!candidates.length) {
    return { product: null, score: 0 };
  }

  const scored = candidates
    .filter((product) => productNameContainsSearchKeywords(product.name, keyword, listItem))
    .filter((product) => isGenuineFreshProduceForIntent(product.name, product, keyword, listItem))
    .map((product) => ({
      product,
      score: scoreProductForMatching(product, keyword, listItem),
    }));

  const { product: best, score: bestScore } = pickBestFromPricePerKgPool(scored, keyword, listItem);

  let threshold =
    isProduceSearchIntent(keyword, listItem) ||
    isFreshFoodCategory(keyword) ||
    isFreshFoodCategory(best?.name) ||
    searchIntentSuggestsRawIngredient(keyword, listItem)
      ? FRESH_LIST_MATCH_THRESHOLD
      : getListMatchThresholdForKeyword(keyword, listItem);

  if (
    best &&
    isProduceSearchIntent(keyword, listItem) &&
    productNameMatchesProduceKeyword(best.name, keyword) &&
    !nameSuggestsPackagedDrink(best.name)
  ) {
    threshold = Math.min(threshold, 0.26);
  }

  if (
    best &&
    searchIntentSuggestsRawIngredient(keyword, listItem) &&
    freshFoodCorePhraseMatch(best.name, keyword)
  ) {
    threshold = Math.min(threshold, 0.28);
  }

  if (
    best &&
    isProduceSearchIntent(keyword, listItem) &&
    !isGenuineFreshProduceForIntent(best.name, best, keyword, listItem)
  ) {
    return { product: null, score: bestScore };
  }

  if (!best || bestScore < threshold) {
    return { product: null, score: bestScore };
  }

  return { product: best, score: Number(bestScore.toFixed(2)) };
}

/**
 * Tách nhiều từ khóa từ ô tìm kiếm (xuống dòng / dấu phẩy / chấm phẩy).
 * Không tách theo khoảng trắng — "pork belly" vẫn là một món.
 */
function parseCompareKeywords(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (/[\n,;]/.test(text)) {
    return text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [text];
}

/**
 * Danh sách sản phẩm khớp từ khóa cho một siêu thị (đã lọc intent, xếp độ khớp rồi giá).
 * Hàng i của ma trận UI = phần tử thứ i trong mảng này — không lấy món khác loại đắp chỗ.
 */
function buildStoreOptionsForKeyword(products, keyword, listItem = {}) {
  const noiseFiltered = filterSearchNoiseProducts(products, keyword);
  const candidates = filterProductsForSearchIntent(noiseFiltered, keyword, listItem);
  if (!candidates.length) return [];

  const scored = candidates
    .filter((product) => productNameContainsSearchKeywords(product.name, keyword, listItem))
    .map((product) => ({
      product,
      score: scoreProductForMatching(product, keyword, listItem),
    }))
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.02) return b.score - a.score;
    return getProductComparablePricePerKg(a.product) - getProductComparablePricePerKg(b.product);
  });

  return scored.map((entry) => entry.product);
}

/** Khóa dedupe sản phẩm khi ghép hàng (tránh lặp cặp / dòng thừa). */
function productStableKey(product) {
  if (!product) return '';
  if (product.id != null && String(product.id).trim()) return String(product.id);
  return `${product.supermarket || ''}:${product.name || ''}:${product.price ?? ''}`;
}

/**
 * Bước 1 — Loại sản phẩm chứa từ rác (mug, cup, …) khi query không nhắc tới chúng.
 */
function filterSearchNoiseProducts(products, keyword) {
  if (!Array.isArray(products) || !products.length) return [];

  const kwNorm = normalizeNameForMatch(stripWeightFromText(keyword || ''));

  return products.filter((product) => {
    const nameNorm = normalizeNameForMatch(product?.name || '');
    if (!nameNorm) return false;

    for (const noiseTerm of SEARCH_NOISE_NEGATIVE_KEYWORDS) {
      if (searchKeywordAllowsNoiseTerm(kwNorm, noiseTerm)) continue;
      if (haystackHasWord(nameNorm, noiseTerm)) return false;
    }
    return true;
  });
}

function searchKeywordAllowsNoiseTerm(keywordNorm, noiseTerm) {
  if (!keywordNorm || !noiseTerm) return false;
  if (haystackHasWord(keywordNorm, noiseTerm)) return true;
  if (noiseTerm.includes(' ') && keywordNorm.includes(noiseTerm)) return true;
  return false;
}

/** Trích modifier phân loại có trong tên sản phẩm. */
function extractSmartMatchModifiers(nameNorm) {
  if (!nameNorm) return [];
  const found = [];
  for (const mod of SMART_MATCH_CATEGORY_MODIFIERS) {
    if (mod.includes(' ')) {
      if (nameNorm.includes(mod)) found.push(mod);
    } else if (haystackHasWord(nameNorm, mod)) {
      found.push(mod);
    }
  }
  return found;
}

function nameNormHasAnyHint(nameNorm, hints) {
  return hints.some((hint) =>
    hint.includes(' ') ? nameNorm.includes(hint) : haystackHasWord(nameNorm, hint)
  );
}

/** Chênh lệch $/kg hoặc pack price — trong 20% thì +1 điểm. */
function smartMatchPriceWithinTwentyPercent(productA, productB) {
  const priceA = getProductComparablePricePerKg(productA);
  const priceB = getProductComparablePricePerKg(productB);
  if (!Number.isFinite(priceA) || !Number.isFinite(priceB) || priceA <= 0 || priceB <= 0) {
    return false;
  }
  const ratio = Math.min(priceA, priceB) / Math.max(priceA, priceB);
  return ratio >= 0.8;
}

/**
 * Bước 2 — Chấm điểm ghép 1 cặp Woolworths ↔ Coles (càng cao càng giống bản chất).
 * +2/modifier chung · -3 raw↔cooked · +1 giá gần nhau · cộng thêm độ tương đồng tên.
 */
function scoreSmartMatchPair(woolProduct, colesProduct, opts = {}) {
  const woolName = resolveProductName(woolProduct);
  const colesName = resolveProductName(colesProduct);
  const woolNorm = normalizeNameForMatch(woolName);
  const colesNorm = normalizeNameForMatch(colesName);
  const debug = opts.debug ?? MATCH_DEBUG;

  const reject = (reason) => {
    if (debug) logMatchDecision(woolName, colesName, -999, reason);
    return -999;
  };

  if (!woolNorm || !colesNorm) return reject('empty product name');

  const guardrailReason = evaluatePairingGuardrails(woolName, woolProduct, colesName, colesProduct);
  if (guardrailReason) return reject(guardrailReason);

  if (!areProductCategoriesCompatible(woolProduct, colesProduct)) {
    return reject('incompatible product categories');
  }

  const qualifierCheck = matchQualifiersCompatible(woolName, colesName);
  if (!qualifierCheck.ok) return reject(qualifierCheck.reason);

  if (produceVariantConflict(woolName, colesName)) {
    return reject('produce variant conflict (generic vs regional/specialized line)');
  }

  const nameSim = stringSimilarity.compareTwoStrings(woolNorm, colesNorm);
  if (nameSim < MIN_PAIR_NAME_SIMILARITY) {
    return reject(
      `name similarity ${nameSim.toFixed(2)} below minimum ${MIN_PAIR_NAME_SIMILARITY}`
    );
  }

  if (isShallowProduceTokenMatch(woolName, colesName)) {
    return reject(
      `shallow produce token overlap (sim=${nameSim.toFixed(2)} < ${MIN_FRESH_SHALLOW_TOKEN_SIMILARITY})`
    );
  }

  if (!varietiesCompatible(woolName, colesName)) {
    return reject('variety or botanical line incompatible');
  }

  let score = 0;
  let modBonus = 0;

  const woolMods = extractSmartMatchModifiers(woolNorm);
  const colesMods = extractSmartMatchModifiers(colesNorm);
  for (const mod of woolMods) {
    if (colesMods.includes(mod)) {
      score += 2;
      modBonus += 2;
    }
  }

  const woolRaw = nameNormHasAnyHint(woolNorm, SMART_MATCH_RAW_MEAT_HINTS);
  const woolCooked =
    nameNormHasAnyHint(woolNorm, SMART_MATCH_COOKED_PREPARED_HINTS) ||
    nameSuggestsProcessedPreparedFood(woolName);
  const colesRaw = nameNormHasAnyHint(colesNorm, SMART_MATCH_RAW_MEAT_HINTS);
  const colesCooked =
    nameNormHasAnyHint(colesNorm, SMART_MATCH_COOKED_PREPARED_HINTS) ||
    nameSuggestsProcessedPreparedFood(colesName);

  let rawCookedAdj = 0;
  if ((woolRaw && !woolCooked && colesCooked) || (colesRaw && !colesCooked && woolCooked)) {
    score -= 3;
    rawCookedAdj = -3;
  } else if (woolCooked !== colesCooked && (woolCooked || colesCooked)) {
    score -= 3;
    rawCookedAdj = -3;
  }

  let priceBonus = 0;
  if (smartMatchPriceWithinTwentyPercent(woolProduct, colesProduct)) {
    score += 1;
    priceBonus = 1;
  }

  const nameSimBonus = nameSim * 0.75;
  score += nameSimBonus;

  let freshPhraseBonus = 0;
  if (freshFoodCorePhraseMatch(woolName, colesName)) {
    score += 1.5;
    freshPhraseBonus = 1.5;
  }

  const sizeStatus = checkSizeCompatibility(woolName, colesName, woolProduct, colesProduct);
  let sizeAdj = 0;
  if (sizeStatus === 'conflict') {
    return reject(`size/pack conflict (${sizeStatus})`);
  }
  if (sizeStatus === 'ok') {
    score += 0.5;
    sizeAdj = 0.5;
  }

  if (debug) {
    logMatchDecision(
      woolName,
      colesName,
      score,
      [
        `nameSim=${nameSim.toFixed(2)} (+${nameSimBonus.toFixed(2)})`,
        `mods=+${modBonus}`,
        `raw/cooked=${rawCookedAdj}`,
        `price=+${priceBonus}`,
        `freshPhrase=+${freshPhraseBonus}`,
        `size=${sizeStatus} (${sizeAdj >= 0 ? '+' : ''}${sizeAdj})`,
        `threshold=${SMART_MATCH_MIN_PAIR_SCORE}`,
      ].join(', ')
    );
  }

  return score;
}

/**
 * Bước 2+3 — Ghép cặp thông minh: mỗi WW chọn Coles điểm cao nhất, Coles đã ghép bị loại.
 * Sản phẩm thừa → trả về unmatched* để xếp hàng cuối (fallback).
 */
function buildSmartComparePairs(woolworthsOptions, colesOptions) {
  const pairs = [];
  const usedWoolKeys = new Set();
  const usedColesIndexes = new Set();

  if (!woolworthsOptions.length || !colesOptions.length) {
    return {
      pairs,
      unmatchedWool: woolworthsOptions.slice(),
      unmatchedColes: colesOptions.slice(),
    };
  }

  for (const woolItem of woolworthsOptions) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    let bestPricePerKg = Number.POSITIVE_INFINITY;

    colesOptions.forEach((colesItem, idx) => {
      if (usedColesIndexes.has(idx)) return;
      if (isSameSupermarketCrossPair(woolItem, colesItem)) return;

      const score = scoreSmartMatchPair(woolItem, colesItem);
      if (score < SMART_MATCH_MIN_PAIR_SCORE) return;

      const ppkg = getProductComparablePricePerKg(colesItem);
      if (score > bestScore || (score === bestScore && ppkg < bestPricePerKg)) {
        bestScore = score;
        bestIdx = idx;
        bestPricePerKg = ppkg;
      }
    });

    if (bestIdx < 0) {
      if (MATCH_DEBUG) {
        console.log(
          `[Match:PAIR] no Coles match for WW="${resolveProductName(woolItem)}" (all candidates below ${SMART_MATCH_MIN_PAIR_SCORE})`
        );
      }
      continue;
    }

    usedColesIndexes.add(bestIdx);
    usedWoolKeys.add(productStableKey(woolItem));

    const colesPick = colesOptions[bestIdx];
    if (MATCH_DEBUG) {
      console.log(
        `[Match:PAIR] paired score=${bestScore.toFixed(2)} | WW="${resolveProductName(woolItem)}" ↔ Coles="${resolveProductName(colesPick)}"`
      );
    }

    pairs.push({
      woolworths: woolItem,
      coles: colesPick,
      matchScore: Number(bestScore.toFixed(2)),
    });
  }

  const unmatchedWool = woolworthsOptions.filter(
    (item) => !usedWoolKeys.has(productStableKey(item))
  );
  const unmatchedColes = colesOptions.filter((_, idx) => !usedColesIndexes.has(idx));

  return { pairs, unmatchedWool, unmatchedColes };
}

/** Gắn so sánh giá rẻ nhất cho một hàng ma trận (chỉ các ô có sản phẩm). */
function attachMatrixRowComparison(matrixRow) {
  const available = [matrixRow.woolworths, matrixRow.coles].filter(Boolean);
  if (available.length >= 2) {
    const cmp = compareStoresForCheaper(available);
    matrixRow.cheapestStore = cmp.cheaper === 'tie' ? null : cmp.cheaper;
    matrixRow.rowSaving = cmp.saving;
    matrixRow.compareBasis = cmp.compareBasis;
  } else if (available.length === 1) {
    matrixRow.cheapestStore = available[0].supermarket;
    matrixRow.rowSaving = 0;
    matrixRow.compareBasis = 'pack_price';
  } else {
    matrixRow.cheapestStore = null;
    matrixRow.rowSaving = 0;
    matrixRow.compareBasis = null;
  }
  return matrixRow;
}

/**
 * Ma trận 2 cột Coles ↔ Woolworths — Smart Matching:
 * 1) Lọc rác (mug, cup, …) · 2) Chấm điểm ghép cặp · 3) Hàng thừa xuống cuối.
 */
function buildAlignedCompareMatrix(keyword, listItem, woolItems, colesItems) {
  const item = listItem || buildListItemForKeywordSearch(keyword);
  const kw = String(keyword || item.keyword || '').trim();

  const woolworthsOptions = buildStoreOptionsForKeyword(woolItems, item.keyword, item);
  const colesOptions = buildStoreOptionsForKeyword(colesItems, item.keyword, item);

  const { pairs, unmatchedWool, unmatchedColes } = buildSmartComparePairs(
    woolworthsOptions,
    colesOptions
  );

  const matrixRows = [];

  for (const pair of pairs) {
    if (matrixRows.length >= RESULT_LIMIT) break;
    matrixRows.push(
      attachMatrixRowComparison({
        rowIndex: matrixRows.length,
        woolworths: pair.woolworths,
        coles: pair.coles,
        matchType: 'smart_pair',
        similarity: pair.matchScore,
      })
    );
  }

  for (const woolworths of unmatchedWool) {
    if (matrixRows.length >= RESULT_LIMIT) break;
    matrixRows.push(
      attachMatrixRowComparison({
        rowIndex: matrixRows.length,
        woolworths,
        coles: null,
        matchType: 'woolworths_only',
      })
    );
  }

  for (const coles of unmatchedColes) {
    if (matrixRows.length >= RESULT_LIMIT) break;
    matrixRows.push(
      attachMatrixRowComparison({
        rowIndex: matrixRows.length,
        woolworths: null,
        coles,
        matchType: 'coles_only',
      })
    );
  }

  const similarPairCount = pairs.length;
  const totalPossible = woolworthsOptions.length + colesOptions.length - similarPairCount;

  return {
    keyword: kw,
    matrixRows,
    similarPairCount,
    orphanRowsCapped: totalPossible > RESULT_LIMIT,
    storeCounts: {
      woolworths: woolworthsOptions.length,
      coles: colesOptions.length,
    },
  };
}

/** Ma trận 1 hàng khi quét barcode — hiển thị trực tiếp sản phẩm từng siêu thị. */
function buildAlignedCompareMatrixFromProducts(keyword, woolProduct, colesProduct) {
  const kw = String(keyword || '').trim();

  const matrixRows = [
    attachMatrixRowComparison({
      rowIndex: 0,
      woolworths: woolProduct || null,
      coles: colesProduct || null,
      matchType: 'barcode',
    }),
  ];

  return {
    keyword: kw,
    matrixRows,
    similarPairCount: woolProduct && colesProduct ? 1 : 0,
    storeCounts: {
      woolworths: woolProduct ? 1 : 0,
      coles: colesProduct ? 1 : 0,
    },
  };
}

/** Gợi ý khối lượng cho câu truy vấn (vd: rice + 2kg → "2 kg") */
function buildQuantityHint(listItem) {
  const qty = listItem.quantity;
  const unit = String(listItem.unit || '').toLowerCase();
  if (qty != null && unit && ['kg', 'g', 'l', 'ml'].includes(unit)) {
    return `${qty}${unit}`;
  }
  return '';
}

/** Chuỗi tìm kiếm RapidAPI từ 1 dòng giỏ đã parse */
function buildSearchQueryFromListItem(listItem) {
  const keyword = String(listItem.clean_query || listItem.keyword || '').trim();
  const hint = buildQuantityHint(listItem);
  return hint ? `${keyword} ${hint}` : keyword;
}

/**
 * Compute line price (shared with applyListItemPricing).
 */
function computeLinePrice(product, listItem) {
  if (!product) return 0;
  return applyListItemPricing(product, listItem).price;
}

// ============================================================
// 3b2. PACKAGE FALLBACK & SINGLE-STORE PRICE IMPUTATION
// ============================================================

/** Pack weight in kg from normalized product fields or product name. */
function getProductPackWeightKg(product) {
  if (!product) return null;
  if (product.packWeightKg != null && product.packWeightKg > 0) {
    return product.packWeightKg;
  }
  const fromFields = getPackWeightKgFromProduct(product.name, product);
  if (fromFields != null && fromFields > 0) return fromFields;
  const sizeInfo = extractSizeInfo(product.name);
  if (sizeInfo.grams != null && sizeInfo.grams > 0) {
    return Number((sizeInfo.grams / 1000).toFixed(4));
  }
  return null;
}

/** Target volume in litres (for pack scaling of liquids). */
function getTargetVolumeL(listItem) {
  if (!listItem) return null;
  const unit = String(listItem.unit || '').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  if (unit === 'l') return qty;
  if (unit === 'ml') return qty / 1000;
  return null;
}

/** Pack volume in litres from product name / size fields. */
function getProductPackVolumeL(product) {
  if (!product) return null;
  const sizeInfo = extractSizeInfo(product.name);
  if (sizeInfo.grams == null) return null;
  const fromName = String(product.name || '').toLowerCase();
  if (/\bml\b/.test(fromName) || /\b\d+(?:\.\d+)?\s*l\b/.test(fromName)) {
    return sizeInfo.grams / 1000;
  }
  return null;
}

/**
 * Search queries with smaller pack sizes when the requested weight is large
 * (e.g. "rice 10kg" → try "rice 5kg", "rice 1kg", then "rice").
 */
function buildSmallerPackSearchQueries(listItem) {
  const keyword = String(listItem.keyword || '').trim();
  if (!keyword) return [];

  const queries = [];
  const targetKg = getTargetWeightKg(listItem);
  const targetL = getTargetVolumeL(listItem);

  if (targetKg != null && targetKg > 0) {
    for (const size of [5, 2, 1, 0.5]) {
      if (size < targetKg) {
        queries.push(`${keyword} ${size}kg`);
      }
    }
    queries.push(keyword);
    return [...new Set(queries)];
  }

  if (targetL != null && targetL > 0) {
    for (const size of [2, 1, 0.5]) {
      if (size < targetL) {
        queries.push(`${keyword} ${size}l`);
      }
    }
    queries.push(keyword);
    return [...new Set(queries)];
  }

  return [];
}

/**
 * Pick a smaller pack (or per-kg price) and scale up to the requested amount.
 * Used when no exact match exists for "rice 10kg" etc.
 */
function pickPackageFallbackFromProducts(products, listItem) {
  const targetKg = getTargetWeightKg(listItem);
  const targetL = getTargetVolumeL(listItem);
  if ((targetKg == null || targetKg <= 0) && (targetL == null || targetL <= 0)) {
    return null;
  }

  const keyword = listItem.keyword;
  const candidates = filterProductsForSearchIntent(products, keyword, listItem).filter((product) =>
    isGenuineFreshProduceForIntent(product.name, product, keyword, listItem)
  );
  if (!candidates.length) return null;

  let best = null;

  for (const product of candidates) {
    const shelf = product.packShelfPrice ?? product.price;
    if (shelf == null || shelf <= 0) continue;

    const score = scoreProductForKeyword(product.name, keyword, '', listItem, product);
    if (score < 0.18) continue;

    let estimatedTotal = null;
    let pricingNote = null;
    let packsNeeded = null;

    if (targetKg != null && targetKg > 0) {
      const packKg = getProductPackWeightKg(product);
      if (packKg != null && packKg > 0) {
        packsNeeded = Math.ceil(targetKg / packKg);
        estimatedTotal = shelf * packsNeeded;
        pricingNote = `${packsNeeded} × ${packKg}kg pack @ $${shelf.toFixed(2)} (est. ${targetKg}kg)`;
      } else if (product.pricePerKg != null && product.pricePerKg > 0) {
        estimatedTotal = product.pricePerKg * targetKg;
        pricingNote = `$${product.pricePerKg.toFixed(2)}/kg × ${targetKg}kg`;
      }
    } else if (targetL != null && targetL > 0) {
      const packL = getProductPackVolumeL(product);
      if (packL != null && packL > 0) {
        packsNeeded = Math.ceil(targetL / packL);
        estimatedTotal = shelf * packsNeeded;
        pricingNote = `${packsNeeded} × ${packL}L pack @ $${shelf.toFixed(2)} (est. ${targetL}L)`;
      }
    }

    if (estimatedTotal == null || estimatedTotal <= 0) continue;

    if (!best || estimatedTotal < best.estimatedTotal) {
      best = {
        product,
        estimatedTotal: Number(estimatedTotal.toFixed(2)),
        pricingNote,
        packsNeeded,
        score,
      };
    }
  }

  return best;
}

/** Apply scaled pack pricing onto a matched product for the cart line. */
function buildPackageFallbackPricedProduct(fallback, listItem) {
  const base = applyListItemPricing(fallback.product, listItem);
  return {
    ...base,
    price: fallback.estimatedTotal,
    isPackageFallback: true,
    isAdjustedPrice: true,
    pricingNote: `(Package estimate: ${fallback.pricingNote})`,
  };
}

/** Fetch extra search results using smaller pack queries. */
async function fetchSmallerPackProductItems(supermarket, listItem) {
  const queries = buildSmallerPackSearchQueries(listItem);
  if (!queries.length) return [];

  const weightListItem = listItem;
  let merged = [];

  for (const query of queries) {
    try {
      const rawList = await fetchStoreRawList(supermarket, query);
      const batch = normalizeRawList(rawList, supermarket).map((product) =>
        applyWeightContextToProduct(product, weightListItem)
      );
      merged = mergeProductLists(merged, batch, RESULT_LIMIT * 2);
    } catch (err) {
      console.warn(`  ⚠ ${supermarket} smaller-pack search failed for "${query}":`, err.message);
    }
  }

  return merged;
}

/**
 * Resolve the best product for one store (strict 2-step pipeline):
 * 1) OpenAI already returned clean_query + is_fresh_produce (no product IDs).
 * 2) Programmatic Mongo filter → RapidAPI fetch → sync → filter → score.
 */
async function resolveStoreLineMatch(supermarket, searchQuery, listItem) {
  let storeError = null;
  const matchKeyword = listItem.clean_query || listItem.keyword;

  try {
    const mongoProduct = await findBestProductInMongo(supermarket, listItem);
    if (mongoProduct) {
      console.log(`  ✓ ${supermarket} Mongo match: ${mongoProduct.name}`);
      return {
        product: applyListItemPricing(mongoProduct, listItem),
        score: 1,
        error: null,
        packageFallback: false,
        matchSource: 'mongo',
      };
    }
  } catch (error) {
    console.warn(`  ⚠ ${supermarket} Mongo lookup failed:`, error.message);
  }

  let allItems = [];

  try {
    const result = await fetchStoreProducts(supermarket, searchQuery, listItem);
    allItems = result.items;
    storeError = result.error;
    await syncProductsToMongo(supermarket, matchKeyword, allItems);
  } catch (error) {
    storeError = formatStoreError(supermarket, error);
    return { product: null, score: 0, error: storeError, packageFallback: false };
  }

  const eligible = filterProductsByParsedLineMongoRules(allItems, listItem);
  const requiresStrictFreshProduce = listItem?.is_fresh_produce === true;

  let picked = pickBestProductMatch(eligible, matchKeyword, listItem);
  if (picked.product) {
    return {
      product: applyListItemPricing(picked.product, listItem),
      score: picked.score,
      error: storeError,
      packageFallback: false,
      matchSource: 'programmatic',
    };
  }

  let pkg = requiresStrictFreshProduce
    ? null
    : pickPackageFallbackFromProducts(eligible.length ? eligible : allItems, listItem);
  if (pkg) {
    console.log(`  📦 ${supermarket} package fallback: ${pkg.pricingNote}`);
    return {
      product: buildPackageFallbackPricedProduct(pkg, listItem),
      score: pkg.score,
      error: storeError,
      packageFallback: true,
      matchSource: 'package_fallback',
    };
  }

  const extraItems = await fetchSmallerPackProductItems(supermarket, listItem);
  if (extraItems.length) {
    allItems = mergeProductLists(allItems, extraItems, RESULT_LIMIT * 2);
    await syncProductsToMongo(supermarket, matchKeyword, extraItems);
    const mergedEligible = filterProductsByParsedLineMongoRules(allItems, listItem);
    pkg = requiresStrictFreshProduce
      ? null
      : pickPackageFallbackFromProducts(
          mergedEligible.length ? mergedEligible : allItems,
          listItem
        );
    if (pkg) {
      console.log(`  📦 ${supermarket} package fallback (extra search): ${pkg.pricingNote}`);
      return {
        product: buildPackageFallbackPricedProduct(pkg, listItem),
        score: pkg.score,
        error: storeError,
        packageFallback: true,
        matchSource: 'package_fallback',
      };
    }
  }

  return { product: null, score: picked.score, error: storeError, packageFallback: false };
}

/**
 * When a store has no match, impute that store's single-cart price from the rival store
 * so "All at Coles" / "All at Woolworths" totals are not artificially cheap.
 */
function storeLineHasUsablePrice(line, store) {
  if (store === 'coles') {
    return Boolean(line.coles) && Number(line.colesLinePrice) > 0;
  }
  return Boolean(line.woolworths) && Number(line.woolworthsLinePrice) > 0;
}

/**
 * Impute single-store cart totals when a supermarket has no match (never $0).
 */
function enrichLineWithSingleStorePricing(line) {
  const colesUsable = storeLineHasUsablePrice(line, 'coles');
  const woolUsable = storeLineHasUsablePrice(line, 'woolworths');

  const colesActual = colesUsable ? Number(line.colesLinePrice) : 0;
  const woolActual = woolUsable ? Number(line.woolworthsLinePrice) : 0;

  const itemLabel = formatRequestKeywordLabel(line.request);

  const rivalPrices = () => {
    const prices = [];
    if (colesUsable) prices.push(colesActual);
    if (woolUsable) prices.push(woolActual);
    return prices;
  };

  const imputeFromRivals = () => {
    const prices = rivalPrices();
    return prices.length ? Math.min(...prices) : 0;
  };

  let colesSingleStorePrice = colesUsable ? colesActual : imputeFromRivals();
  let woolSingleStorePrice = woolUsable ? woolActual : imputeFromRivals();

  let colesIncomplete = !colesUsable && rivalPrices().length > 0;
  let woolIncomplete = !woolUsable && rivalPrices().length > 0;

  const colesIncompleteNote = colesIncomplete
    ? `This store is missing ${itemLabel}; price estimated from other supermarkets for comparison.`
    : null;
  const woolIncompleteNote = woolIncomplete
    ? `This store is missing ${itemLabel}; price estimated from other supermarkets for comparison.`
    : null;

  return {
    ...line,
    colesSingleStorePrice: Number(colesSingleStorePrice.toFixed(2)),
    woolworthsSingleStorePrice: Number(woolSingleStorePrice.toFixed(2)),
    colesIncomplete,
    woolIncomplete,
    colesIncompleteNote,
    woolIncompleteNote,
    is_incomplete: colesIncomplete || woolIncomplete,
  };
}

function formatRequestKeywordLabel(request) {
  if (!request) return 'item';
  return String(request.keyword || '').trim() || 'item';
}

// ============================================================
// 3c. AI SHOPPING LIST – PARSE PROMPT & TỐI ƯU GIỎ
// ============================================================

const SHOPPING_LIST_SYSTEM_PROMPT = `You parse grocery shopping lists for Australian supermarkets (Coles, Woolworths).

Return ONLY a valid JSON array. Each object must have EXACTLY these four fields — nothing else:
- "original_text": the user's line as written (e.g. "fresh cucumber (2 kg)", "watermelon (x2)")
- "clean_query": bare English product name for database search — NO weights, NO quantities (e.g. "cucumber", "watermelon", "rice", "pork belly")
- "category": supermarket department string (e.g. "Fruit & Veg", "Meat", "Dairy", "Pantry", "Drinks", "Frozen")
- "is_fresh_produce": boolean — true ONLY for raw whole fruit/vegetables the user wants fresh (cucumber, watermelon, broccoli, apple, etc.)

Rules:
- Do NOT return product IDs, prices, brands, or matched product objects.
- clean_query must be the core ingredient only: "cucumber" not "pickled cucumber", "watermelon" not "watermelon juice".
- is_fresh_produce: true for fresh fruit/veg; false for juice, drinks, pickled, canned, frozen meals, soap, snacks, rice, meat, dairy, pantry.
- If the user explicitly asks for juice/pickled/canned/frozen, set is_fresh_produce false and reflect that form in clean_query only if they asked for it.
- Keep multi-word ingredients intact ("pork belly", "chicken thigh", "beef mince").
- No markdown, no explanation — only the JSON array.`;

function parseQuantityUnitFromOriginalText(originalText) {
  const raw = String(originalText || '');

  const parenMatch = raw.match(/\((\d+(?:\.\d+)?)\s*(kg|g|l|ml|each|pack|bunch)?\)/i);
  if (parenMatch) {
    return {
      quantity: parseFloat(parenMatch[1]),
      unit: (parenMatch[2] || 'each').toLowerCase(),
    };
  }

  const xMatch = raw.match(/\(x\s*(\d+)\)/i) || raw.match(/\bx\s*(\d+)\b/i);
  if (xMatch) {
    return { quantity: parseInt(xMatch[1], 10), unit: 'each' };
  }

  const prefixMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(kg|g|l|ml|each|pack|bunch)?\s+/i);
  if (prefixMatch) {
    return {
      quantity: parseFloat(prefixMatch[1]),
      unit: (prefixMatch[2] || 'each').toLowerCase(),
    };
  }

  return { quantity: 1, unit: 'each' };
}

function textHasFreshProduceIntentKeyword(text) {
  const norm = normalizeNameForMatch(stripWeightFromText(text));
  if (!norm) return false;
  return PRODUCE_INTENT_KEYWORDS.some((kw) => {
    if (haystackHasWord(norm, kw)) return true;
    if (!kw.endsWith('s') && haystackHasWord(norm, `${kw}s`)) return true;
    return false;
  });
}

function inferIsFreshProduceFromLine(row, originalText, cleanQuery) {
  const combined = `${originalText} ${cleanQuery}`.toLowerCase();
  const explicitlyProcessed =
    /\b(juice|drink|pickled|canned|frozen meal|soap|sausage|sausages|pork|beef|chicken)\b/.test(
      combined
    );

  if (row?.is_fresh_produce === true) return !explicitlyProcessed;

  const deterministicFreshProduce = textHasFreshProduceIntentKeyword(cleanQuery || originalText);
  if (deterministicFreshProduce && !explicitlyProcessed) return true;
  if (row?.is_fresh_produce === false) return false;

  const cat = String(row?.category || '').toLowerCase();
  if (/fruit|veg|produce/.test(cat)) return true;

  if (explicitlyProcessed) return false;

  return textHasFreshProduceIntentKeyword(cleanQuery);
}

/** Map OpenAI / fallback row → internal list item (qty derived from original_text). */
function normalizeParsedLineItem(row, fallbackOriginal = '') {
  const original_text = String(row.original_text || row.text || fallbackOriginal || '').trim();
  let clean_query = String(row.clean_query || row.keyword || row.item || row.name || '')
    .trim()
    .replace(/^fresh\s+/i, '')
    .trim();

  if (!clean_query && original_text) {
    clean_query = stripWeightFromText(original_text)
      .replace(/^fresh\s+/i, '')
      .trim();
  }
  clean_query = clean_query.replace(/\bnaval\s+oranges?\b/i, (match) =>
    /oranges$/i.test(match) ? 'navel oranges' : 'navel orange'
  );
  if (!clean_query && !original_text) return null;

  const is_fresh_produce = inferIsFreshProduceFromLine(row, original_text, clean_query);
  const category = String(row.category || (is_fresh_produce ? 'Fruit & Veg' : 'Grocery')).trim();
  const qty = parseQuantityUnitFromOriginalText(original_text);

  return {
    original_text: original_text || clean_query,
    clean_query,
    is_fresh_produce,
    category,
    keyword: clean_query,
    quantity: qty.quantity,
    unit: qty.unit,
  };
}

/** Gọi OpenAI — chỉ parse, không chọn sản phẩm */
async function parseShoppingListWithAI(promptText) {
  if (!openaiClient) {
    throw new Error('OPENAI_API_KEY is not configured. Add it to .env to use AI list analysis.');
  }

  const completion = await openaiClient.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SHOPPING_LIST_SYSTEM_PROMPT },
      { role: 'user', content: promptText },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  const jsonText = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  const parsed = JSON.parse(jsonText);

  if (!Array.isArray(parsed)) {
    throw new Error('AI did not return a JSON array.');
  }

  return parsed.map((row) => normalizeParsedLineItem(row)).filter(Boolean);
}

/** Dự phòng khi không có OpenAI: regex tách từng dòng */
function parseShoppingListFallback(promptText) {
  const segments = String(promptText)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.map((part) => normalizeParsedLineItem({}, part)).filter(Boolean);
}

/** Pick the cheapest store for one cart line (PRICE_EPSILON tie → lowest wins). */
function pickCheapestStoreForLine(colesPriced, woolPriced) {
  const candidates = [];
  if (colesPriced && Number(colesPriced.price) > 0) {
    candidates.push({ store: 'Coles', product: colesPriced, price: Number(colesPriced.price) });
  }
  if (woolPriced && Number(woolPriced.price) > 0) {
    candidates.push({
      store: 'Woolworths',
      product: woolPriced,
      price: Number(woolPriced.price),
    });
  }

  if (!candidates.length) {
    return { chosenStore: null, chosenProduct: null, lineTotal: 0 };
  }

  candidates.sort((a, b) => a.price - b.price);
  const minPrice = candidates[0].price;
  const best =
    candidates.find((c) => Math.abs(c.price - minPrice) <= PRICE_EPSILON) || candidates[0];

  return {
    chosenStore: best.store,
    chosenProduct: best.product,
    lineTotal: best.price,
  };
}

/** Resolve best product match for one line at Coles and Woolworths (parallel). */
async function resolveListItem(listItem) {
  const searchQuery = buildSearchQueryFromListItem(listItem);

  const [colesSettled, woolSettled] = await Promise.allSettled([
    resolveStoreLineMatch('Coles', searchQuery, listItem),
    resolveStoreLineMatch('Woolworths', searchQuery, listItem),
  ]);

  const colesResult =
    colesSettled.status === 'fulfilled'
      ? colesSettled.value
      : {
          product: null,
          score: 0,
          error: formatStoreError('Coles', colesSettled.reason),
          packageFallback: false,
        };
  const woolResult =
    woolSettled.status === 'fulfilled'
      ? woolSettled.value
      : {
          product: null,
          score: 0,
          error: formatStoreError('Woolworths', woolSettled.reason),
          packageFallback: false,
        };

  const colesPriced = colesResult.product;
  const woolPriced = woolResult.product;

  const colesPrice = colesPriced?.price ?? 0;
  const woolPrice = woolPriced?.price ?? 0;

  const { chosenStore, chosenProduct, lineTotal } = pickCheapestStoreForLine(
    colesPriced,
    woolPriced
  );

  const baseLine = {
    request: listItem,
    searchQuery,
    coles: colesPriced,
    woolworths: woolPriced,
    colesLinePrice: colesPrice,
    woolworthsLinePrice: woolPrice,
    colesMatchScore: colesResult.score,
    woolworthsMatchScore: woolResult.score,
    colesPackageFallback: Boolean(colesResult.packageFallback),
    woolworthsPackageFallback: Boolean(woolResult.packageFallback),
    storeErrors: {
      coles: colesResult.error,
      woolworths: woolResult.error,
    },
    chosenStore,
    chosenProduct,
    lineTotal,
  };

  return enrichLineWithSingleStorePricing(baseLine);
}

/**
 * Aggregate split / single-store cart totals.
 * Single-store totals use imputed rival prices when a store has no match (never $0).
 */
function buildCartOptimization(lineItems) {
  let colesOnlyTotal = 0;
  let woolworthsOnlyTotal = 0;
  let splitTotal = 0;
  const splitCart = { coles: [], woolworths: [] };
  const unresolved = [];
  const incompleteWarnings = [];

  for (const line of lineItems) {
    const colesUsable = storeLineHasUsablePrice(line, 'coles');
    const woolUsable = storeLineHasUsablePrice(line, 'woolworths');

    colesOnlyTotal += line.colesSingleStorePrice ?? line.colesLinePrice ?? 0;
    woolworthsOnlyTotal += line.woolworthsSingleStorePrice ?? line.woolworthsLinePrice ?? 0;

    if (!colesUsable && !woolUsable && line.request?.keyword) {
      unresolved.push(line.request.keyword);
    }

    if (line.colesIncomplete && line.colesIncompleteNote) {
      incompleteWarnings.push({ store: 'Coles', message: line.colesIncompleteNote });
    }
    if (line.woolIncomplete && line.woolIncompleteNote) {
      incompleteWarnings.push({ store: 'Woolworths', message: line.woolIncompleteNote });
    }

    if (!colesUsable && !woolUsable) continue;

    splitTotal += line.lineTotal;

    const entry = {
      request: line.request,
      product: line.chosenProduct,
      lineTotal: line.lineTotal,
      coles: line.coles,
      woolworths: line.woolworths,
      colesLinePrice: line.colesLinePrice,
      woolworthsLinePrice: line.woolworthsLinePrice,
      colesSingleStorePrice: line.colesSingleStorePrice,
      woolworthsSingleStorePrice: line.woolworthsSingleStorePrice,
      colesIncomplete: line.colesIncomplete,
      woolIncomplete: line.woolIncomplete,
      is_incomplete: line.is_incomplete,
    };

    if (line.chosenStore === 'Coles') {
      splitCart.coles.push(entry);
    } else if (line.chosenStore === 'Woolworths') {
      splitCart.woolworths.push(entry);
    }
  }

  colesOnlyTotal = Number(colesOnlyTotal.toFixed(2));
  woolworthsOnlyTotal = Number(woolworthsOnlyTotal.toFixed(2));
  splitTotal = Number(splitTotal.toFixed(2));

  const totals = { colesOnlyTotal, woolworthsOnlyTotal, splitTotal };
  const bestPick = pickBestCartStrategy(totals);
  const recommendation = buildCartRecommendationMessage(bestPick, totals);

  return {
    colesOnlyTotal,
    woolworthsOnlyTotal,
    splitTotal,
    splitCart,
    bestStrategy: bestPick.strategy,
    recommendedStore: bestPick.store,
    bestTotal: bestPick.total,
    isSplitWorthIt: bestPick.strategy === 'split',
    is_incomplete: incompleteWarnings.length > 0,
    colesOnlyIncomplete: incompleteWarnings.some((w) => w.store === 'Coles'),
    woolworthsOnlyIncomplete: incompleteWarnings.some((w) => w.store === 'Woolworths'),
    incompleteWarnings,
    recommendation,
    savings: recommendation,
    savingsVsColes: recommendation.savingsVsColes,
    savingsVsWoolworths: recommendation.savingsVsWoolworths,
    unresolved,
  };
}

const PRICE_COMPARE_EPS = 0.01;

/**
 * Pick cheapest cart strategy among single-store totals and multi-store split.
 * Prefer one-store when totals tie within PRICE_COMPARE_EPS.
 */
function pickBestCartStrategy(totals) {
  const { colesOnlyTotal, woolworthsOnlyTotal, splitTotal } = totals;
  const candidates = [];

  if (colesOnlyTotal > 0) {
    candidates.push({ strategy: 'coles_only', store: 'Coles', total: colesOnlyTotal });
  }
  if (woolworthsOnlyTotal > 0) {
    candidates.push({
      strategy: 'woolworths_only',
      store: 'Woolworths',
      total: woolworthsOnlyTotal,
    });
  }
  if (splitTotal > 0) {
    candidates.push({ strategy: 'split', store: 'Split', total: splitTotal });
  }

  if (!candidates.length) {
    return { strategy: 'none', store: null, total: 0 };
  }

  candidates.sort((a, b) => {
    const diff = a.total - b.total;
    if (Math.abs(diff) > PRICE_COMPARE_EPS) return diff;
    const rank = (strategy) => (strategy === 'split' ? 1 : 0);
    return rank(a.strategy) - rank(b.strategy);
  });

  return candidates[0];
}

/** Savings message for the winning cart strategy (Coles & Woolworths). */
function buildCartRecommendationMessage(bestPick, totals) {
  const { colesOnlyTotal, woolworthsOnlyTotal, splitTotal } = totals;
  const empty = {
    message: '',
    amount: 0,
    percent: 0,
    comparedTo: null,
    savingsVsColes: { amount: 0, percent: 0 },
    savingsVsWoolworths: { amount: 0, percent: 0 },
  };

  if (!bestPick?.strategy || bestPick.strategy === 'none') return empty;

  const singleStoreBaselines = [
    { store: 'Coles', total: colesOnlyTotal },
    { store: 'Woolworths', total: woolworthsOnlyTotal },
  ].filter((row) => row.total > 0);

  const maxSingle = singleStoreBaselines.reduce((max, row) => (row.total > max.total ? row : max), {
    store: null,
    total: 0,
  });

  const savingsBlock = (baselineTotal, label) => {
    if (baselineTotal <= 0 || bestPick.total >= baselineTotal) {
      return { amount: 0, percent: 0 };
    }
    const amount = Number((baselineTotal - bestPick.total).toFixed(2));
    const percent = Number(((amount / baselineTotal) * 100).toFixed(1));
    return { amount, percent, label };
  };

  if (bestPick.strategy === 'split') {
    const amount = Number(Math.max(0, maxSingle.total - splitTotal).toFixed(2));
    const percent = maxSingle.total > 0 ? Number(((amount / maxSingle.total) * 100).toFixed(1)) : 0;

    return {
      message:
        amount > 0
          ? `💡 Best for your wallet: split across Coles & Woolworths and save $${amount.toFixed(2)} (${percent}%) vs buying everything at ${maxSingle.store}.`
          : '✨ Split cart matches the cheapest single-store total — any one store works!',
      amount,
      percent,
      comparedTo: maxSingle.store,
      savingsVsColes: savingsBlock(colesOnlyTotal, 'Coles'),
      savingsVsWoolworths: savingsBlock(woolworthsOnlyTotal, 'Woolworths'),
    };
  }

  const winner = bestPick.store;
  const winnerTotal = bestPick.total;
  const runner = singleStoreBaselines
    .filter((row) => row.store !== winner)
    .sort((a, b) => b.total - a.total)[0];

  if (runner && runner.total > winnerTotal) {
    const amount = Number((runner.total - winnerTotal).toFixed(2));
    const percent = Number(((amount / runner.total) * 100).toFixed(1));
    return {
      message: `🎉 ${winner} wins this list! You'll save $${amount.toFixed(2)} (${percent}%) vs buying everything at ${runner.store}.`,
      amount,
      percent,
      comparedTo: runner.store,
      savingsVsColes: savingsBlock(colesOnlyTotal, 'Coles'),
      savingsVsWoolworths: savingsBlock(woolworthsOnlyTotal, 'Woolworths'),
    };
  }

  return {
    message: `🛒 ${winner} has the best total for your whole list — one stop and you're done!`,
    amount: 0,
    percent: 0,
    comparedTo: null,
    savingsVsColes: savingsBlock(colesOnlyTotal, 'Coles'),
    savingsVsWoolworths: savingsBlock(woolworthsOnlyTotal, 'Woolworths'),
  };
}

/**
 * Ghép cặp Similar products:
 * - Duyệt từng sản phẩm Woolworths
 * - Tìm Coles có điểm ghép cao nhất (danh mục + tên + loại + size)
 * - Loại ngay cặp Drinks ↔ Fresh (vd: nước ép vs dưa hấu tươi)
 * - Chỉ giữ cặp vượt ngưỡng SIMILARITY_THRESHOLD
 */
function buildSimilarPairs(woolworthsItems, colesItems) {
  const pairs = [];
  const usedColesIndexes = new Set();

  if (!woolworthsItems.length || !colesItems.length) return pairs;

  for (const woolItem of woolworthsItems) {
    let bestIndex = -1;
    let bestScore = 0;

    colesItems.forEach((colesItem, idx) => {
      if (usedColesIndexes.has(idx)) return;
      if (isSameSupermarketCrossPair(woolItem, colesItem)) return;
      const score = scoreProductPair(woolItem, colesItem);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    });

    const pairThreshold =
      bestIndex >= 0 && freshFoodCorePhraseMatch(woolItem.name, colesItems[bestIndex].name)
        ? FRESH_PAIR_SCORE_FLOOR - 0.02
        : SIMILARITY_THRESHOLD;

    if (bestIndex < 0 || bestScore <= pairThreshold) continue;

    usedColesIndexes.add(bestIndex);
    const colesItem = colesItems[bestIndex];
    const { cheaper, saving, compareBasis } = compareProductsForCheaper(woolItem, colesItem);

    pairs.push({
      woolworths: woolItem,
      coles: colesItem,
      cheaper,
      saving,
      compareBasis,
      similarity: Number(bestScore.toFixed(2)),
    });
  }

  return pairs;
}

// ============================================================
// 5. GEOLOCATION → NEAREST STORE + RAPIDAPI SEARCH
// ============================================================

function extractStoreIdFromPayload(payload) {
  return extractNearestStoreFromPayload(payload).storeId;
}

/** Extract nearest store id + display name from locator JSON/XML-derived objects. */
function extractNearestStoreFromPayload(payload) {
  if (payload == null) return { storeId: null, storeName: null };

  if (typeof payload === 'string' || typeof payload === 'number') {
    const digits = String(payload).replace(/\D/g, '');
    return { storeId: digits.length >= 3 ? digits : null, storeName: null };
  }

  const list =
    payload.stores ??
    payload.Stores ??
    payload.locations ??
    payload.Locations ??
    payload.results ??
    payload.data;
  if (Array.isArray(list) && list.length) {
    return extractNearestStoreFromPayload(list[0]);
  }

  const storeId =
    payload.storeId ??
    payload.store_id ??
    payload.storeNo ??
    payload.storeNumber ??
    payload.StoreNumber ??
    payload.no ??
    payload.id;
  const storeName =
    payload.name ??
    payload.Name ??
    payload.storeName ??
    payload.StoreName ??
    payload.description ??
    payload.suburb ??
    payload.Suburb ??
    payload.addressLine1 ??
    null;

  return {
    storeId: storeId != null && String(storeId).trim() ? String(storeId).trim() : null,
    storeName: storeName != null ? String(storeName).trim() : null,
  };
}

function extractColesStoreFromXml(xml) {
  const text = String(xml || '');
  const locationBlock = text.match(/<Location[^>]*>[\s\S]*?<\/Location>/i)?.[0] || text;
  const storeNo =
    locationBlock.match(/<StoreNo[^>]*>(\d+)<\/StoreNo>/i)?.[1] ||
    text.match(/<StoreNo[^>]*>(\d+)<\/StoreNo>/i)?.[1] ||
    null;
  const storeName =
    locationBlock.match(/<Name[^>]*>([^<]+)<\/Name>/i)?.[1]?.trim() ||
    locationBlock.match(/<StoreName[^>]*>([^<]+)<\/StoreName>/i)?.[1]?.trim() ||
    text.match(/<Name[^>]*>([^<]+)<\/Name>/i)?.[1]?.trim() ||
    null;
  return { storeId: storeNo, storeName };
}

/** Woolworths storelocator returns XML (not JSON) — parse first <storeDetail> block. */
function extractWoolworthsStoreFromXml(xml) {
  const text = String(xml || '');
  const storeBlock = text.match(/<storeDetail[^>]*>[\s\S]*?<\/storeDetail>/i)?.[0] || text;
  const storeNo =
    storeBlock.match(/<no[^>]*>(\d+)<\/no>/i)?.[1] ||
    text.match(/<no[^>]*>(\d+)<\/no>/i)?.[1] ||
    null;
  const storeName =
    storeBlock.match(/<name[^>]*>([^<]+)<\/name>/i)?.[1]?.trim() ||
    text.match(/<name[^>]*>([^<]+)<\/name>/i)?.[1]?.trim() ||
    null;
  const suburb =
    storeBlock.match(/<suburb[^>]*>([^<]+)<\/suburb>/i)?.[1]?.trim() ||
    text.match(/<suburb[^>]*>([^<]+)<\/suburb>/i)?.[1]?.trim() ||
    null;

  const displayName =
    storeName && suburb && !storeName.toLowerCase().includes(suburb.toLowerCase())
      ? `${storeName} (${suburb})`
      : storeName || suburb || null;

  return { storeId: storeNo, storeName: displayName };
}

function extractWoolworthsStoreFromPayload(payload) {
  const text = String(payload ?? '').trim();
  if (text.startsWith('<?xml') || text.includes('<storeDetail')) {
    return extractWoolworthsStoreFromXml(text);
  }
  return extractNearestStoreFromPayload(payload);
}

function buildNearestStoresPayload(entry = {}) {
  const colesName = entry.colesStoreName || null;
  const woolName = entry.woolworthsStoreName || null;
  const colesId = entry.colesStoreId || null;
  const woolId = entry.woolworthsStoreId || null;

  const colesLabel = colesName || (colesId ? `Store #${colesId}` : null);
  const woolLabel = woolName || (woolId ? `Store #${woolId}` : null);

  return {
    coles: colesId || colesLabel ? { id: colesId, name: colesName, label: colesLabel } : null,
    woolworths: woolId || woolLabel ? { id: woolId, name: woolName, label: woolLabel } : null,
  };
}

/** RapidAPI store locator (một endpoint, timeout ngắn — fallback sau locator công khai). */
async function tryRapidApiNearestStore(supermarket, location) {
  if (!RAPIDAPI_KEY) return { storeId: null, storeName: null };

  const isColes = supermarket === 'Coles';
  const host = isColes ? COLES_HOST : WOOLWORTHS_HOST;
  const path = isColes ? '/coles/stores/nearby' : '/woolworths/stores/nearby';

  try {
    const response = await axios.get(`https://${host}${path}`, {
      params: {
        latitude: location.latitude,
        longitude: location.longitude,
        lat: location.latitude,
        lng: location.longitude,
        range: 25,
        max: 3,
      },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': host,
      },
      timeout: STORE_LOCATOR_REQUEST_TIMEOUT_MS,
    });
    return extractNearestStoreFromPayload(response.data);
  } catch {
    return { storeId: null, storeName: null };
  }
}

async function tryRapidApiNearestStoreId(supermarket, location) {
  const store = await tryRapidApiNearestStore(supermarket, location);
  return store.storeId;
}

/** Resolve the nearest Coles store via the public store-locator service. */
async function resolveColesStore(location) {
  try {
    const response = await axios.get(
      'http://locator.coles.com.au/services/storelocator.asmx/GetLocationsNearGeoPoint',
      {
        params: {
          latitude: location.latitude,
          longitude: location.longitude,
        },
        timeout: STORE_LOCATOR_REQUEST_TIMEOUT_MS,
        responseType: 'text',
      }
    );
    const store = extractColesStoreFromXml(response.data);
    if (store.storeId) return store;
  } catch (error) {
    console.warn('  ⚠ Coles store locator failed:', error.message);
  }

  return tryRapidApiNearestStore('Coles', location);
}

async function resolveColesStoreId(location) {
  const store = await resolveColesStore(location);
  return store.storeId;
}

/** Resolve the nearest Woolworths store via the public proximity service. */
async function resolveWoolworthsStore(location) {
  const divisions = ['SUPERMARKETS', 'WOOLWORTHS', 'supermarkets'];
  const attempts = divisions.map((division) => {
    const url =
      `https://www.woolworths.com.au/storelocator/service/proximity/${division}` +
      `/latitude/${location.latitude}/longitude/${location.longitude}/range/25/max/3`;
    return axios
      .get(url, {
        timeout: STORE_LOCATOR_REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/json, text/plain, application/xml, text/xml, */*',
          'User-Agent': 'ShoppingSmart/1.0',
        },
        responseType: 'text',
      })
      .then((response) => extractWoolworthsStoreFromPayload(response.data));
  });

  const results = await Promise.allSettled(attempts);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value?.storeId) return result.value;
  }

  return tryRapidApiNearestStore('Woolworths', location);
}

async function resolveWoolworthsStoreId(location) {
  const store = await resolveWoolworthsStore(location);
  return store.storeId;
}

/** Tra cứu store ID + tên (chưa cache) — gọi song song Coles + Woolworths. */
async function resolveNearestStoreIdsUncached(location) {
  const [coles, woolworths] = await Promise.all([
    resolveColesStore(location),
    resolveWoolworthsStore(location),
  ]);
  return {
    colesStoreId: coles.storeId,
    colesStoreName: coles.storeName,
    woolworthsStoreId: woolworths.storeId,
    woolworthsStoreName: woolworths.storeName,
    expiresAt: Date.now() + NEAREST_STORE_CACHE_TTL_MS,
  };
}

/**
 * Resolve (and cache) nearest Coles / Woolworths store IDs for the user's coordinates.
 * Timeout + dedupe inflight — tránh chậm gấp đôi khi search Coles và WW song song.
 */
async function resolveNearestStoreIds(location) {
  const cacheKey = buildLocationSegment(location);
  const cached = nearestStoreIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  if (nearestStoreLookupInflight.has(cacheKey)) {
    return nearestStoreLookupInflight.get(cacheKey);
  }

  const lookupPromise = withTimeout(
    resolveNearestStoreIdsUncached(location),
    STORE_LOOKUP_MAX_MS,
    'nearest store lookup'
  )
    .catch((err) => {
      console.warn('  ⚠ Nearest store lookup skipped:', err.message);
      return {
        colesStoreId: null,
        colesStoreName: null,
        woolworthsStoreId: null,
        woolworthsStoreName: null,
        expiresAt: Date.now() + NEAREST_STORE_CACHE_TTL_MS,
      };
    })
    .then((entry) => {
      if (entry.colesStoreId || entry.woolworthsStoreId) {
        console.log(
          `  🏪 Nearest stores @ ${cacheKey}: Coles=${entry.colesStoreName || entry.colesStoreId || 'n/a'} | WW=${entry.woolworthsStoreName || entry.woolworthsStoreId || 'n/a'}`
        );
      }
      nearestStoreIdCache.set(cacheKey, entry);
      return entry;
    })
    .finally(() => {
      nearestStoreLookupInflight.delete(cacheKey);
    });

  nearestStoreLookupInflight.set(cacheKey, lookupPromise);
  return lookupPromise;
}

/** Nearest store IDs merged with optional client overrides (postcode/GPS-aware). */
async function resolveStoreIdsForRequest(location) {
  const overrides = getRequestStoreOverrides();
  let colesStoreId = overrides.colesStoreId;
  let woolworthsStoreId = overrides.woolworthsStoreId;
  let colesStoreName = null;
  let woolworthsStoreName = null;

  if (!colesStoreId || !woolworthsStoreId) {
    const nearest = await resolveNearestStoreIds(location);
    colesStoreId = colesStoreId || nearest.colesStoreId;
    woolworthsStoreId = woolworthsStoreId || nearest.woolworthsStoreId;
    colesStoreName = nearest.colesStoreName || null;
    woolworthsStoreName = nearest.woolworthsStoreName || null;
  }

  return { colesStoreId, woolworthsStoreId, colesStoreName, woolworthsStoreName };
}

/** Build RapidAPI query params including geo coordinates and optional storeId. */
function buildStoreSearchParams(supermarket, query, location, storeIds) {
  const params = {
    query,
    page: 1,
    latitude: location.latitude,
    longitude: location.longitude,
    lat: location.latitude,
    lng: location.longitude,
  };

  if (supermarket === 'Coles' && storeIds?.colesStoreId) {
    params.storeId = storeIds.colesStoreId;
  }
  if (supermarket === 'Woolworths' && storeIds?.woolworthsStoreId) {
    params.storeId = storeIds.woolworthsStoreId;
    params.storeNumber = storeIds.woolworthsStoreId;
  }

  return params;
}

// ============================================================
// 5b. HÀM GỌI COLES / WOOLWORTHS RAPIDAPI (+ fallback WW trực tiếp)
// ============================================================

/** Map one Woolworths UI API product object → raw list item (includes Barcode field). */
function mapWoolworthsDirectItemToRaw(item) {
  const price = parsePrice(item.InstorePrice ?? item.Price);
  if (price == null) return null;

  const barcodeDigits = normalizeBarcode(item.Barcode || item.Ean || item.Gtin);
  return {
    name: item.DisplayName || item.Name,
    price,
    stockcode: item.Stockcode ?? item.StockCode,
    StockCode: item.Stockcode ?? item.StockCode,
    barcode: barcodeDigits || item.Barcode || null,
    barcodes: barcodeDigits ? [barcodeDigits] : item.Barcode ? [item.Barcode] : [],
    size: item.PackageSize || item.Unit || null,
    image: item.MediumImageFile || item.SmallImageFile || null,
    brand: item.Brand || item.AdditionalAttributes?.brand || null,
    was_price: parsePrice(item.WasPrice),
    is_on_special: item.IsOnSpecial === true || item.InstoreIsOnSpecial === true,
  };
}

/** Fallback khi RapidAPI Woolworths timeout — gọi API công khai của Woolworths AU. */
async function fetchWoolworthsDirectApiRawList(query, limit = RESULT_LIMIT) {
  try {
    const response = await axios.post(
      'https://www.woolworths.com.au/apis/ui/Search/products',
      {
        Filters: [],
        IsSpecial: false,
        Location: `/shop/search/products?searchTerm=${query}`,
        PageNumber: 1,
        PageSize: limit,
        SearchTerm: String(query),
        SortType: 'TraderRelevance',
        IsHideEverydayMarketProducts: false,
        IsRegisteredRewardCardPromotion: null,
        ExcludeSearchTypes: ['UntraceableVendors'],
        GpBoost: 0,
        GroupEdmVariants: false,
        EnableAdReRanking: false,
      },
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Origin: 'https://www.woolworths.com.au',
          Referer: `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(query)}`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        },
        timeout: BARCODE_DIRECT_API_TIMEOUT_MS,
      }
    );

    const rawList = [];
    for (const group of response.data?.Products || []) {
      for (const item of group?.Products || []) {
        const mapped = mapWoolworthsDirectItemToRaw(item);
        if (mapped) rawList.push(mapped);
        if (rawList.length >= limit) return rawList;
      }
    }
    return rawList;
  } catch (error) {
    console.warn('  ⚠ Woolworths direct API fallback failed:', error?.message || error);
    return null;
  }
}

function extractColesMobileApiPrice(result) {
  const promos = result?.Promotions;
  if (Array.isArray(promos)) {
    for (const promo of promos) {
      const price = parsePrice(promo?.Price ?? promo?.price ?? promo?.SalePrice);
      if (price != null) return price;
    }
  }
  return parsePrice(result?.Price) ?? parsePrice(result?.price) ?? parsePrice(result?.CurrentPrice);
}

/** Map Coles mobile search API result → raw list item. */
function mapColesMobileResultToRaw(result) {
  const price = extractColesMobileApiPrice(result);
  if (price == null) return null;

  const slug = result?.SeoToken || result?.UrlSlug || result?.Slug || result?.slug || null;
  const barcodeDigits = normalizeBarcode(
    result?.Barcode ?? result?.Ean ?? result?.Gtin ?? result?.Apn
  );

  return {
    name: buildDisplayName(result),
    brand: result?.Brand || result?.brand || null,
    size: result?.Size || result?.size || null,
    price,
    slug: slug ? String(slug).replace(/^\//, '') : null,
    barcode: barcodeDigits || null,
    barcodes: barcodeDigits ? [barcodeDigits] : [],
    image:
      result?.ImageUrl || result?.imageUrl || result?.ThumbnailUrl || result?.Images?.[0] || null,
    is_on_special: Array.isArray(result?.Promotions) && result.Promotions.length > 0,
  };
}

/** Coles mobile app search API — supports barcode digits and product names. */
async function fetchColesDirectApiRawList(query, storeId, limit = RESULT_LIMIT) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (!COLES_MOBILE_API_KEY || !COLES_MOBILE_API_SECRET) return null;

  try {
    const response = await axios.get(COLES_MOBILE_SEARCH_URL, {
      params: {
        q,
        limit,
        start: 0,
        storeId: storeId || '7716',
        type: 'SKU',
      },
      headers: {
        Accept: '*/*',
        'Accept-Language': 'en-AU;q=1',
        'User-Agent': 'Shopmate/3.4.1 (iPhone; iOS 17.0; Scale/3.00)',
        'X-Coles-API-Key': COLES_MOBILE_API_KEY,
        'X-Coles-API-Secret': COLES_MOBILE_API_SECRET,
      },
      timeout: BARCODE_DIRECT_API_TIMEOUT_MS,
    });

    const results = response.data?.Results || response.data?.results || [];
    const rawList = [];
    for (const row of results) {
      const mapped = mapColesMobileResultToRaw(row);
      if (mapped) rawList.push(mapped);
      if (rawList.length >= limit) break;
    }
    return rawList;
  } catch (error) {
    console.warn(
      '  ⚠ Coles direct API fallback failed:',
      error?.response?.status || error?.message
    );
    return null;
  }
}

/** Direct chain API lookup for barcode scans (Woolworths UI + Coles mobile). */
async function fetchDirectStoreRawListForBarcode(supermarket, query, storeIds) {
  const q = String(query || '').trim();
  if (!q) return [];

  if (supermarket === 'Woolworths') {
    const raw = await fetchWoolworthsDirectApiRawList(q, RESULT_LIMIT);
    return Array.isArray(raw) ? raw : [];
  }

  if (supermarket === 'Coles') {
    const raw = await fetchColesDirectApiRawList(q, storeIds?.colesStoreId, RESULT_LIMIT);
    return Array.isArray(raw) ? raw : [];
  }

  return [];
}

/** Gọi search API và trả về mảng sản phẩm thô (dùng cho khớp barcode) */
async function fetchStoreRawList(supermarket, keyword, opts = {}) {
  const query = String(keyword || '').trim();
  if (!query) return [];

  const fast = opts.fast === true;
  const location = getRequestLocation();
  const apiTimeout = fast ? COMPARE_API_TIMEOUT_MS : API_TIMEOUT_MS;
  const maxRetries = fast ? COMPARE_API_MAX_RETRIES : API_MAX_RETRIES;

  const cached = opts.forceRefresh ? null : await tryReadApiCache(supermarket, query, location);
  if (cached != null) {
    console.log(`  💾 ${supermarket} cache hit: "${query}" @ ${buildLocationSegment(location)}`);
    return cached;
  }

  if (!RAPIDAPI_KEY) {
    throw new Error(
      'No cached results and RAPIDAPI_KEY is not configured. Add it to .env or Vercel environment variables.'
    );
  }

  let storeIds = opts.storeIds || { colesStoreId: null, woolworthsStoreId: null };
  if (!storeIds.colesStoreId || !storeIds.woolworthsStoreId) {
    try {
      const resolved = await resolveStoreIdsForRequest(location);
      storeIds = {
        colesStoreId: storeIds.colesStoreId || resolved.colesStoreId,
        woolworthsStoreId: storeIds.woolworthsStoreId || resolved.woolworthsStoreId,
      };
    } catch (storeErr) {
      console.warn(`  ⚠ Nearest store lookup failed (${supermarket}):`, storeErr.message);
    }
  }

  if (storeIds.colesStoreId || storeIds.woolworthsStoreId) {
    console.log(
      `  🏪 Store IDs for "${query}": Coles=${storeIds.colesStoreId || 'n/a'} | WW=${storeIds.woolworthsStoreId || 'n/a'}`
    );
  }

  const isColes = supermarket === 'Coles';
  const host = isColes ? COLES_HOST : WOOLWORTHS_HOST;
  const path = isColes ? '/coles/search' : '/woolworths/search';
  const url = `https://${host}${path}`;
  const searchParams = buildStoreSearchParams(supermarket, query, location, storeIds);
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        params: searchParams,
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': host,
        },
        timeout: apiTimeout,
      });

      let rawList = extractResultsArray(response.data);
      if (supermarket === 'Woolworths') {
        rawList = refreshWoolworthsUrlsInRawList(rawList);
      }
      scheduleWriteApiCache(supermarket, query, rawList, location);
      return rawList;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableApiError(error);
      console.error(
        `  ❌ ${supermarket} attempt ${attempt}/${maxRetries} failed:`,
        error?.response?.data || error?.message || error?.code
      );
      if (retryable && attempt < maxRetries) {
        await sleep(fast ? 800 : 1500 * attempt);
        continue;
      }
      const stale = await tryReadStaleApiCache(supermarket, query, location);
      if (stale) {
        console.log(`  💾 ${supermarket} stale cache fallback: "${query}"`);
        return stale;
      }
      // Woolworths: thử API trực tiếp trước khi trả rỗng
      if (supermarket === 'Woolworths') {
        const direct = await fetchWoolworthsDirectApiRawList(query, RESULT_LIMIT);
        if (direct?.length) {
          const refreshed = refreshWoolworthsUrlsInRawList(direct);
          console.log(
            `  ↩ Woolworths direct API fallback: ${refreshed.length} items for "${query}"`
          );
          scheduleWriteApiCache(supermarket, query, refreshed, location);
          return refreshed;
        }
      }
      // Production: Woolworths lỗi → [] — Coles vẫn hiển thị lỗi
      if (shouldSoftFailStoreRawList(supermarket)) {
        logStoreSoftFail(supermarket, query, error, apiTimeout);
        return [];
      }
      throw lastError;
    }
  }

  if (shouldSoftFailStoreRawList(supermarket)) {
    logStoreSoftFail(supermarket, query, lastError, apiTimeout);
    return [];
  }

  throw lastError || new Error(`${supermarket} API failed.`);
}

function normalizeRawList(rawList, supermarket) {
  const items = rawList
    .map((item) => normalizeItem(item, supermarket))
    .filter(Boolean)
    .slice(0, RESULT_LIMIT);

  if (!items.length && rawList.length) {
    console.warn(`  ⚠️ ${supermarket} returned items but none could be normalized.`);
  }

  return items;
}

async function fetchColes(keyword, listItem = null) {
  const { items } = await fetchStoreProducts('Coles', keyword, listItem);
  return items;
}

async function fetchWoolworths(keyword, listItem = null) {
  const { items } = await fetchStoreProducts('Woolworths', keyword, listItem);
  return items;
}

/**
 * Lỗi riêng từng siêu thị — chỉ set khi thật sự fail API.
 * Mảng rỗng [] KHÔNG được gán message lỗi mặc định.
 */
function buildCompareStoreErrors(colesError, woolworthsError) {
  return {
    coles: colesError || null,
    woolworths: woolworthsError || null,
  };
}

/** Khi API fail hết — vẫn trả ma trận 1 hàng trống để UI Compare by item hiện đúng 2 cột. */
function buildEmptyAlignedBlocksForKeywords(keywords) {
  return keywords.map((kw) => ({
    keyword: kw,
    matrixRows: [
      {
        rowIndex: 0,
        woolworths: null,
        coles: null,
        cheapestStore: null,
        rowSaving: 0,
        compareBasis: null,
      },
    ],
    similarPairCount: 0,
    storeCounts: { woolworths: 0, coles: 0 },
  }));
}

// ============================================================
// 7. ENDPOINT CHÍNH: GET /api/compare?keyword=...
// ============================================================
/**
 * Gọi song song Coles + Woolworths cho một từ khóa (Promise.allSettled).
 * Trả về danh sách thô từng cửa hàng + lỗi (nếu có).
 */
async function fetchAllStoresForKeyword(keyword) {
  const searchListItem = buildListItemForKeywordSearch(keyword);
  const location = getRequestLocation();
  const fastOpts = { fast: true };

  let storeIds = { colesStoreId: null, woolworthsStoreId: null };
  try {
    storeIds = await withTimeout(
      resolveStoreIdsForRequest(location),
      COMPARE_STORE_LOOKUP_MS,
      'compare store lookup'
    );
  } catch (storeErr) {
    console.warn(`  ⚠ Compare store lookup skipped:`, storeErr.message);
  }
  fastOpts.storeIds = storeIds;

  const safeFetchColes = async () => {
    try {
      const result = await fetchStoreProducts('Coles', keyword, searchListItem, fastOpts);
      return { items: result.items, error: null };
    } catch (error) {
      const message = formatStoreError('Coles', error);
      console.error(`  ❌ Coles error ("${keyword}"):`, message);
      return { items: [], error: message };
    }
  };

  const safeFetchWoolworths = async () => {
    try {
      const result = await fetchStoreProducts('Woolworths', keyword, searchListItem, fastOpts);
      return { items: result.items || [], error: null };
    } catch (error) {
      logStoreSoftFail('Woolworths', keyword, error, COMPARE_API_TIMEOUT_MS);
      return { items: [], error: null };
    }
  };

  const [colesSettled, woolSettled] = await Promise.allSettled([
    safeFetchColes(),
    safeFetchWoolworths(),
  ]);

  let colesItems = [];
  let woolworthsItems = [];
  let colesError = null;
  let woolworthsError = null;

  if (colesSettled.status === 'fulfilled') {
    colesItems = colesSettled.value.items;
    colesError = colesSettled.value.error;
    console.log(`  Coles ("${keyword}"): ${colesItems.length} products`);
  } else {
    colesError = formatStoreError('Coles', colesSettled.reason);
  }

  if (woolSettled.status === 'fulfilled') {
    woolworthsItems = woolSettled.value.items;
    woolworthsError = woolSettled.value.error;
    console.log(`  Woolworths ("${keyword}"): ${woolworthsItems.length} products`);
  } else {
    woolworthsError = formatStoreError('Woolworths', woolSettled.reason);
  }

  return {
    keyword,
    searchListItem,
    colesItems,
    woolworthsItems,
    colesError,
    woolworthsError,
  };
}

/**
 * Gọi song song Coles + Woolworths; response gồm alignedRows (mỗi hàng = một từ khóa)
 * và items (danh sách phẳng, tương thích client cũ).
 */
app.get('/api/compare', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();

  if (!keyword) {
    return res.status(400).json({ error: 'Missing keyword parameter.' });
  }

  if (/^\d{12,14}$/.test(keyword)) {
    return res.status(400).json({
      error: 'Barcode searches must be translated to a product name before comparing prices.',
      items: [],
      alignedRows: buildEmptyAlignedBlocksForKeywords([keyword]),
      searchKeyword: keyword,
      searchKeywords: [keyword],
      similarPairs: [],
      storeErrors: { coles: null, woolworths: null },
    });
  }

  const location = getRequestLocation();
  const keywords = parseCompareKeywords(keyword);

  let nearestStores = null;
  try {
    nearestStores = buildNearestStoresPayload(await resolveStoreIdsForRequest(location));
  } catch (storeErr) {
    console.warn('  ⚠ Compare nearest store names skipped:', storeErr.message);
  }

  console.log(
    `\n🔎 Searching: ${keywords.map((k) => `"${k}"`).join(', ')} @ ${location.latitude}, ${location.longitude} (${location.source}${location.postcode ? `, postcode ${location.postcode}` : location.state ? `, ${location.state}` : ''})`
  );

  if (!RAPIDAPI_KEY && !MONGODB_URI) {
    return res.status(503).json({
      error:
        'Neither MongoDB cache nor RAPIDAPI_KEY is configured. Add MONGODB_URI and/or RAPIDAPI_KEY to .env / Vercel.',
      storeErrors: { coles: null, woolworths: null },
    });
  }

  let perKeyword;
  try {
    perKeyword = await withTimeout(
      Promise.all(keywords.map((kw) => fetchAllStoresForKeyword(kw))),
      COMPARE_ROUTE_MAX_MS,
      'compare search'
    );
  } catch (routeErr) {
    console.error('  ❌ Compare route timeout:', routeErr.message);
    const storeErrors = buildCompareStoreErrors(
      `Coles search timed out. ${routeErr.message}`,
      `Woolworths search timed out. ${routeErr.message}`
    );
    return res.status(504).json({
      error:
        'Search took too long. MongoDB or supermarket APIs may be slow — try again in a moment, or check your network.',
      items: [],
      alignedRows: buildEmptyAlignedBlocksForKeywords(keywords),
      searchKeyword: keywords[0] || keyword,
      searchKeywords: keywords,
      similarPairs: [],
      storeErrors,
      nearestStores,
    });
  }

  let colesItems = [];
  let woolworthsItems = [];
  let colesError = null;
  let woolworthsError = null;
  const alignedRows = [];

  for (const block of perKeyword) {
    colesItems = mergeProductLists(colesItems, block.colesItems, RESULT_LIMIT * 3);
    woolworthsItems = mergeProductLists(woolworthsItems, block.woolworthsItems, RESULT_LIMIT * 3);

    if (block.colesError) colesError = block.colesError;
    if (block.woolworthsError) woolworthsError = block.woolworthsError;

    alignedRows.push(
      buildAlignedCompareMatrix(
        block.keyword,
        block.searchListItem,
        block.woolworthsItems,
        block.colesItems
      )
    );
  }

  const hasAnySlot = alignedRows.some((block) =>
    block.matrixRows?.some((row) => row.woolworths || row.coles)
  );

  if (!hasAnySlot) {
    const storeErrors = buildCompareStoreErrors(colesError, woolworthsError);
    return res.json({
      items: [],
      alignedRows: buildEmptyAlignedBlocksForKeywords(keywords),
      searchKeyword: keywords[0] || keyword,
      searchKeywords: keywords,
      similarPairs: [],
      storeErrors,
      nearestStores,
      error:
        colesError || woolworthsError
          ? 'One or more stores could not be reached. Details are shown per store below.'
          : 'No products found. Check API keys, network, or try another keyword.',
    });
  }

  const combined = [...colesItems, ...woolworthsItems].sort((a, b) => a.price - b.price);
  const similarPairs = alignedRows.flatMap((block) =>
    (block.matrixRows || [])
      .filter((row) => row.woolworths && row.coles)
      .map((row) => ({
        woolworths: row.woolworths,
        coles: row.coles,
        cheaper: row.cheapestStore,
        saving: row.rowSaving,
        compareBasis: row.compareBasis,
        similarity: row.similarity ?? 0.35,
        matchType: row.matchType || 'ranked_pair',
      }))
  );

  const matrixRowTotal = alignedRows.reduce(
    (sum, block) => sum + (block.matrixRows?.length || 0),
    0
  );
  console.log(
    `  ✅ Total: ${combined.length} products | Aligned rows: ${matrixRowTotal} | Similar pairs: ${similarPairs.length}\n`
  );

  res.json({
    items: combined,
    alignedRows,
    searchKeyword: keywords[0] || keyword,
    searchKeywords: keywords,
    similarPairs,
    storeErrors: buildCompareStoreErrors(colesError, woolworthsError),
    nearestStores,
  });
});

// ============================================================
// 7a. QUÉT BARCODE: GET /api/compare/barcode?barcode=...
//     Alias: GET /api/scan?barcode=...
// ============================================================
/**
 * Tìm sản phẩm theo mã vạch (không theo tên):
 * 1. Direct Woolworths UI + Coles mobile APIs (barcode as search term)
 * 2. RapidAPI search fallback
 * 3. Open Food Facts product name → text search on both chains
 * 4. Seed MongoDB price_history on hit
 */
async function handleBarcodeScanRequest(req, res) {
  const barcode = normalizeBarcode(req.query.barcode);

  if (!barcode || barcode.length < 8) {
    return res.status(400).json({
      error: 'Invalid barcode. Provide at least 8 digits.',
      scannedBarcode: barcode || null,
    });
  }

  try {
    await withTimeout(
      (async () => {
        const location = getRequestLocation();

        const cached = await tryReadBarcodeScanCache(barcode);
        if (cached?.colesItem || cached?.woolItem) {
          let nearestStores = null;
          try {
            nearestStores = buildNearestStoresPayload(
              await withTimeout(
                resolveStoreIdsForRequest(location),
                BARCODE_STORE_LOOKUP_MAX_MS,
                'barcode store lookup'
              )
            );
          } catch {
            /* optional */
          }
          return res.json(
            buildBarcodeScanResponse(barcode, cached.colesItem, cached.woolItem, {
              nearestStores,
              fromCache: true,
            })
          );
        }

        let storeIds = {
          colesStoreId: null,
          woolworthsStoreId: null,
          colesStoreName: null,
          woolworthsStoreName: null,
        };
        let nearestStores = null;
        try {
          storeIds = await withTimeout(
            resolveStoreIdsForRequest(location),
            BARCODE_STORE_LOOKUP_MAX_MS,
            'barcode store lookup'
          );
          nearestStores = buildNearestStoresPayload(storeIds);
        } catch (storeErr) {
          console.warn('  ⚠ Barcode store lookup failed:', storeErr.message);
        }

        console.log(
          `\n📷 Barcode lookup: ${barcode} @ ${location.latitude}, ${location.longitude} (${location.source}${location.postcode ? `, postcode ${location.postcode}` : ''})`
        );
        console.log(
          `  📷 Store IDs: Coles=${storeIds.colesStoreName || storeIds.colesStoreId || 'n/a'} | Woolworths=${storeIds.woolworthsStoreName || storeIds.woolworthsStoreId || 'n/a'}`
        );

        const safeFetchRaw = async (supermarket, options = {}) => {
          try {
            const result = await fetchBarcodeProductForStore(
              supermarket,
              barcode,
              storeIds,
              options
            );
            return { product: result.product, error: null, matchKind: result.matchKind };
          } catch (error) {
            if (shouldSoftFailStoreRawList(supermarket)) {
              logStoreSoftFail(supermarket, barcode, error, BARCODE_DIRECT_API_TIMEOUT_MS);
              return { product: null, error: null, matchKind: null };
            }
            const message = formatStoreError(supermarket, error);
            console.error(`  ❌ ${supermarket} barcode error:`, message);
            return { product: null, error: message, matchKind: null };
          }
        };

        let [colesResult, woolResult] = await Promise.all([
          safeFetchRaw('Coles'),
          safeFetchRaw('Woolworths'),
        ]);

        let colesItem = colesResult.product;
        let woolItem = woolResult.product;

        if (!colesItem && !woolItem) {
          const productName = await lookupBarcodeProductName(barcode);
          if (productName) {
            console.log(`  📷 Retrying barcode lookup via product name: "${productName}"`);
            [colesResult, woolResult] = await Promise.all([
              safeFetchRaw('Coles', { productName }),
              safeFetchRaw('Woolworths', { productName }),
            ]);
            colesItem = colesResult.product;
            woolItem = woolResult.product;
          }
        }

        if (!colesItem && !woolItem) {
          console.log(`  📷 Barcode lookup FAILED — no match at either store for ${barcode}\n`);
          return res.status(404).json({
            error: 'Barcode not found. Try typing the product name instead.',
            scannedBarcode: barcode,
            storeErrors: {
              coles: colesResult.error,
              woolworths: woolResult.error,
            },
          });
        }

        const attachScanBarcode = (item) => {
          if (!item) return null;
          return {
            ...item,
            barcode: item.barcode || barcode,
            barcodes: item.barcodes?.length ? item.barcodes : [barcode],
          };
        };
        colesItem = attachScanBarcode(colesItem);
        woolItem = attachScanBarcode(woolItem);

        await seedScannedBarcodeToMongo(barcode, colesItem, woolItem);

        console.log(
          `  ✅ Barcode hit | Coles: ${colesItem ? `yes (${colesResult.matchKind})` : 'no'} | WW: ${woolItem ? `yes (${woolResult.matchKind})` : 'no'}\n`
        );

        return res.json(
          buildBarcodeScanResponse(barcode, colesItem, woolItem, {
            colesResult,
            woolResult,
            nearestStores,
          })
        );
      })(),
      BARCODE_SCAN_ROUTE_MAX_MS,
      'barcode scan'
    );
  } catch (error) {
    console.error('  ❌ Barcode route error:', error.message);
    return res.status(504).json({
      error:
        'Barcode lookup timed out. Try again in a moment — repeat scans are faster once cached.',
      scannedBarcode: barcode,
    });
  }
}

app.get('/api/compare/barcode', handleBarcodeScanRequest);
app.get('/api/scan', handleBarcodeScanRequest);

// ============================================================
// 7b. AI SHOPPING LIST: POST /api/analyze-prompt
// ============================================================
/**
 * Nhận văn bản tự nhiên → OpenAI parse → tìm từng món song song
 * → trả tổng Coles / Woolworths / split tối ưu.
 */
app.post('/api/analyze-prompt', async (req, res) => {
  const prompt = String(req.body?.prompt || req.body?.text || '').trim();

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt. Send { "prompt": "..." }.' });
  }

  const location = getRequestLocation();
  console.log(
    `\n🤖 AI shopping list (${prompt.length} chars) @ ${location.latitude}, ${location.longitude} (${location.source})`
  );

  let parsedItems;
  let parseSource = 'openai';

  if (openaiClient) {
    try {
      parsedItems = await withTimeout(
        parseShoppingListWithAI(prompt),
        AI_PARSE_TIMEOUT_MS,
        'OpenAI shopping list parse'
      );
    } catch (error) {
      console.warn(`  ⚠ OpenAI parse failed, using local parser: ${error.message}`);
      parseSource = 'fallback';
      parsedItems = parseShoppingListFallback(prompt);
    }
  } else {
    parseSource = 'fallback';
    parsedItems = parseShoppingListFallback(prompt);
  }

  if (!parsedItems.length) {
    return res.status(400).json({
      error: 'No items found in your list. Try clearer lines like "2 kg rice, 1 L milk".',
    });
  }

  console.log(`  📋 ${parsedItems.length} items (${parseSource})`);

  let lineResults;
  try {
    // Gọi song song tất cả món – mỗi món lại gọi song song Coles + Woolworths
    lineResults = await withTimeout(
      Promise.all(parsedItems.map((item) => resolveListItem(item))),
      AI_ANALYZE_ROUTE_MAX_MS,
      'AI shopping list product matching'
    );
  } catch (error) {
    console.error('  ❌ AI analysis timeout/error:', error.message);
    return res.status(504).json({
      error:
        'AI Analyzer took too long while fetching supermarket prices. Try a shorter list or run it again.',
      parseSource,
      parsedItems,
      lineItems: [],
      optimization: null,
    });
  }

  const optimization = buildCartOptimization(lineResults);

  console.log(
    `  ✅ Split $${optimization.splitTotal} | Coles $${optimization.colesOnlyTotal} | WW $${optimization.woolworthsOnlyTotal}\n`
  );

  res.json({
    parseSource,
    parsedItems,
    lineItems: lineResults,
    optimization,
  });
});

// ============================================================
// 7c. WATCHLIST: POST /api/watchlist/refresh
// ============================================================

/** Tìm đúng sản phẩm trong kết quả search theo tên / URL đã lưu */
function findWatchlistProduct(products, watchEntry) {
  if (!products?.length) return null;

  const targetNorm = normalizeNameForMatch(watchEntry.name);
  const savedUrl = String(watchEntry.url || '').trim();

  if (savedUrl) {
    const byUrl = products.find((p) => p.url === savedUrl);
    if (byUrl) return byUrl;
  }

  const exact = products.find((p) => normalizeNameForMatch(p.name) === targetNorm);
  if (exact) return exact;

  const keyword = watchEntry.searchKeyword || deriveSearchKeyword(watchEntry.name);
  const { product } = pickBestProductMatch(products, keyword);
  return product;
}

/** Refresh one watchlist row: dual-store prices + record history for Chart.js. */
async function refreshSingleWatchItem(entry) {
  const supermarket = entry.supermarket;
  const keyword = String(entry.searchKeyword || deriveSearchKeyword(entry.name)).trim();

  try {
    const [colesSettled, woolSettled] = await Promise.allSettled([
      fetchColes(keyword),
      fetchWoolworths(keyword),
    ]);

    const colesProducts = colesSettled.status === 'fulfilled' ? colesSettled.value : [];
    const woolProducts = woolSettled.status === 'fulfilled' ? woolSettled.value : [];

    const colesMatch = findWatchlistProduct(colesProducts, entry);
    const woolMatch = findWatchlistProduct(woolProducts, entry);
    const primary = supermarket === 'Coles' ? colesMatch : woolMatch;

    if (colesMatch?.price != null) {
      await recordPriceHistoryPoint(entry.id, 'Coles', colesMatch.price, entry.name, {
        productId: colesMatch.productId,
        barcode: colesMatch.barcode,
      });
    }
    if (woolMatch?.price != null) {
      await recordPriceHistoryPoint(entry.id, 'Woolworths', woolMatch.price, entry.name, {
        productId: woolMatch.productId,
        barcode: woolMatch.barcode,
      });
    }

    if (!primary) {
      return {
        id: entry.id,
        found: false,
        colesPrice: colesMatch?.price ?? null,
        woolworthsPrice: woolMatch?.price ?? null,
        error: 'Product not found in latest search results.',
      };
    }

    const watchedPrice = Number(entry.watchedAtPrice);
    const currentPrice = primary.price;
    const priceDrop =
      Number.isFinite(watchedPrice) && currentPrice < watchedPrice
        ? Number((watchedPrice - currentPrice).toFixed(2))
        : 0;

    return {
      id: entry.id,
      found: true,
      currentPrice,
      colesPrice: colesMatch?.price ?? null,
      woolworthsPrice: woolMatch?.price ?? null,
      watchedAtPrice: watchedPrice,
      priceDrop,
      isPriceDown: priceDrop > 0,
      product: primary,
    };
  } catch (error) {
    return {
      id: entry.id,
      found: false,
      error: formatStoreError(supermarket, error),
    };
  }
}

/**
 * Nhận danh sách sản phẩm đang theo dõi → gọi API song song → trả giá mới.
 * Body: { items: [{ id, name, supermarket, watchedAtPrice, url?, searchKeyword? }] }
 */
app.post('/api/watchlist/refresh', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!items.length) {
    return res.status(400).json({ error: 'Missing items array.' });
  }

  if (items.length > 30) {
    return res.status(400).json({ error: 'Maximum 30 watchlist items per request.' });
  }

  const location = getRequestLocation();
  console.log(
    `\n🔔 Refresh watchlist: ${items.length} items @ ${location.latitude}, ${location.longitude} (${location.source})`
  );

  const results = await Promise.all(
    items.map((entry) =>
      refreshSingleWatchItem({
        id: entry.id,
        name: entry.name,
        supermarket: entry.supermarket,
        watchedAtPrice: entry.watchedAtPrice,
        url: entry.url,
        searchKeyword: entry.searchKeyword,
      })
    )
  );

  console.log(`  ✅ Refreshed ${results.filter((r) => r.found).length}/${items.length}\n`);

  res.json({ results });
});

// ============================================================
// 7d. WATCHLIST: GET /api/watchlist/price-history?watchId=...
// ============================================================

/**
 * Price history for Chart.js accordion (Coles + Woolworths series per watchlist id).
 */
app.get('/api/watchlist/price-history', handlePriceHistoryRequest);
app.get('/api/price-history', handlePriceHistoryRequest);

async function handlePriceHistoryRequest(req, res) {
  const watchId = String(req.query.watchId || req.query.id || '').trim();
  const productId = String(req.query.productId || '').trim();
  const barcode = String(req.query.barcode || '').trim();

  if (!watchId && !productId && !barcode) {
    return res.status(400).json({
      error: 'Missing query parameter: provide watchId, id, productId, or barcode.',
    });
  }

  try {
    const history = await resolvePriceHistory({ watchId, productId, barcode });
    return res.json({
      watchId: watchId || null,
      productId: productId || null,
      barcode: barcode || null,
      ...history,
    });
  } catch (error) {
    console.error('  ❌ Price history error:', error.message);
    return res.status(500).json({
      error: error.message || 'Could not load price history.',
    });
  }
}

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(openaiClient),
    mongoConfigured: mongo.isConfigured(),
    mongoConnected: mongo.isConnected(),
    database: mongo.isConnected() ? mongo.getDatabaseName() : null,
    apiCacheCollection: API_CACHE_COLLECTION,
    siteStatsCollection: SITE_STATS_COLLECTION,
  });
});

// ============================================================
// 8. KHỞI ĐỘNG SERVER (Local vs Vercel)
// ============================================================

// Local: bắt buộc listen. Vercel production: chỉ export app.
if (process.env.NODE_ENV !== 'production') {
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`🚀 ShoppingSmart đang chạy mượt mà tại: http://localhost:${PORT}`);
    initMongoForLocalStartup().catch((err) => {
      console.error('MongoDB startup connection failed:', err.message);
    });
  });
}

module.exports = app;
module.exports.__matchingTest__ = {
  normalizeParsedLineItem,
  parseQuantityUnitFromOriginalText,
  productMatchesParsedLineMongoFilters,
  filterProductsByParsedLineMongoRules,
  buildMongoProductQueryFilters,
  freshProduceRankingScoreOverride,
  nameSuggestsProcessedNotCoreIngredient,
  searchIntentSuggestsRawIngredient,
  nameSuggestsProcessedPreparedFood,
  nameSuggestsNonFoodProductTitle,
  nameSuggestsPreservedFoodState,
  nameSuggestsConveniencePreCut,
  nameSuggestsBulkWholeProduce,
  hasFoodStateFormMismatch,
  hasPackagingFormMismatch,
  hasCrossDepartmentFoodNonFoodMismatch,
  hasFreshProduceNonFoodKeywordConflict,
  hasBulkVsMicroWeightMismatch,
  nameBorrowedProduceKeywordForPantry,
  nameSuggestsShelfStableProducePack,
  isGenuineFreshProduceForIntent,
  productConflictsWithWholeProduceRequest,
  evaluatePairingGuardrails,
  productNameHasFullShortKeywordMatch,
  scoreProductForMatching,
  applyListItemPricing,
  estimateEachFruitWeightKg,
  pickBestProductMatch,
  filterProductsForSearchIntent,
  filterSearchNoiseProducts,
  scoreSmartMatchPair,
  scoreProductPair,
  buildSmartComparePairs,
  buildAlignedCompareMatrix,
  getProductComparablePricePerKg,
  matchQualifiersCompatible,
  produceVariantConflict,
  isShallowProduceTokenMatch,
  varietiesCompatible,
};
