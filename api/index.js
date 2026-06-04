/**
 * SmartChoice – Backend Express (RapidAPI + OpenAI)
 * Local:  npm start  →  http://localhost:3000  (app.listen khi NODE_ENV !== 'production')
 * Vercel: export app cho serverless – không gọi listen
 */

const path = require('path');
const fs = require('fs');

// .env nằm ở thư mục gốc repo (một cấp trên api/)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const { AsyncLocalStorage } = require('async_hooks');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const stringSimilarity = require('string-similarity');
const { fetchAldiSearchRawList } = require('./aldi-client');

/** Thư mục front-end tĩnh: ../public (tương đối với api/index.js) */
const PUBLIC_DIR = path.join(__dirname, '../public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');

/** Link Tally mặc định (placeholder) — thay bằng FEEDBACK_TALLY_URL trong .env */
const FEEDBACK_TALLY_URL_FALLBACK = 'https://tally.so/r/your-form-id';

let cachedHomeHtml = null;
let cachedHomeHtmlTallyUrl = null;

/**
 * URL form Góp ý Tally — đọc từ biến môi trường FEEDBACK_TALLY_URL (local + Vercel).
 */
function getFeedbackTallyUrl() {
  const raw = String(process.env.FEEDBACK_TALLY_URL || '').trim();
  if (raw.startsWith('https://') || raw.startsWith('http://')) {
    return raw;
  }
  return FEEDBACK_TALLY_URL_FALLBACK;
}

/**
 * Chuỗi HTML nút Feedback nhúng trong Backend (href từ getFeedbackTallyUrl).
 * Giữ target="_blank" và rel="noopener noreferrer" — mở tab mới, không rời trang so sánh giá.
 */
function buildFeedbackFabHtml() {
  const tallyUrl = getFeedbackTallyUrl().replace(/"/g, '&quot;');

  return `    <!-- Nút Góp ý — link Tally từ FEEDBACK_TALLY_URL, mở tab mới -->
    <a
        href="${tallyUrl}"
        id="feedback-fab"
        class="feedback-fab"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Gửi góp ý — mở trong tab mới"
        title="Feedback"
    >💬 <span class="feedback-fab-text">Feedback</span></a>`;
}

/**
 * Đọc index.html, thay khối nút Feedback bằng chuỗi HTML chuẩn từ Backend.
 */
function buildHomePageHtml() {
  const tallyUrl = getFeedbackTallyUrl();
  if (cachedHomeHtml && cachedHomeHtmlTallyUrl === tallyUrl) {
    return cachedHomeHtml;
  }

  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  html = html.replace(
    /<!--\s*Góp ý[\s\S]*?<a[\s\S]*?id="feedback-fab"[\s\S]*?<\/a>/i,
    buildFeedbackFabHtml()
  );

  // Đồng bộ mọi href Tally còn sót trong file nguồn
  html = html.replace(/https:\/\/tally\.so\/r\/your-form-id/g, tallyUrl);

  cachedHomeHtml = html;
  cachedHomeHtmlTallyUrl = tallyUrl;
  return html;
}

/**
 * Chèn URL Tally đúng vào trang terms (nút feedback-fab).
 */
function injectFeedbackLinkIntoHtml(html) {
  const tallyUrl = getFeedbackTallyUrl();
  let out = html.replace(
    /<!--\s*Góp ý[\s\S]*?<a[\s\S]*?id="feedback-fab"[\s\S]*?<\/a>/i,
    buildFeedbackFabHtml()
  );
  out = out.replace(/https:\/\/tally\.so\/r\/your-form-id/g, tallyUrl);
  return out;
}

// ============================================================
// 1. CẤU HÌNH HẰNG SỐ
// ============================================================
const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || process.env.RAPID_API_KEY || '';
const COLES_HOST      = 'coles-australia-full-catalog-pricing-intelligence-api.p.rapidapi.com';
const WOOLWORTHS_HOST = 'woolworths-australia-product-category-api.p.rapidapi.com';
/** Supported supermarkets for compare + AI cart (ALDI via api.aldi.com.au). */
const SUPPORTED_SUPERMARKETS = ['Coles', 'Woolworths', 'ALDI'];

const RESULT_LIMIT = 20;   // số sản phẩm tối đa mỗi siêu thị
/** Khi không có cặp WW↔Coles, giới hạn hàng chỉ 1 siêu thị (tránh 20 dòng Coles-only). */
const MAX_ORPHAN_STORE_ROWS = 10;
const SIMILARITY_THRESHOLD = 0.58; // Ngưỡng sau khi đã tính điểm tổng hợp (tên + size + loại)
const LIST_MATCH_THRESHOLD = 0.38; // Ngưỡng chọn sản phẩm khớp nhất cho từng dòng giỏ AI
const API_TIMEOUT_MS = 28000; // RapidAPI search — tránh chờ 60s khi cache miss
const API_MAX_RETRIES = 2;
/** Compare/search ô chính: fail nhanh, 1 lần thử, ưu tiên cache. */
const COMPARE_API_TIMEOUT_MS = 14000;
const COMPARE_API_MAX_RETRIES = 1;
const COMPARE_ROUTE_MAX_MS = 36000;
/** MongoDB: fail nhanh nếu Atlas/local không phản hồi (không chặn search). */
const MONGO_CONNECT_TIMEOUT_MS = 2500;
const API_CACHE_READ_TIMEOUT_MS = 1500;
const API_CACHE_STALE_READ_MS = 2000;
const MONGO_COOLDOWN_MS = 90 * 1000;
/** Cache RAM — dùng ngay khi Mongo/API chậm (TTL 30 phút). */
const MEMORY_CACHE_TTL_MS = 30 * 60 * 1000;
const MEMORY_CACHE_MAX_ENTRIES = 300;
/** Tra cứu store ID tối đa — sau đó search chỉ dùng lat/lng. */
const STORE_LOOKUP_MAX_MS = 6000;
const COMPARE_STORE_LOOKUP_MS = 2500;
const STORE_LOCATOR_REQUEST_TIMEOUT_MS = 5000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/** Default map centre (Sydney CBD) when the client does not share GPS coordinates. */
const SYDNEY_DEFAULT_LOCATION = {
  latitude: -33.8688,
  longitude: 151.2093,
  source: 'default',
};

/** Per-request user coordinates (set by middleware from headers / query / body). */
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
// 1b. MONGODB – API CACHE (database from URI path, default smartchoice)
// ============================================================
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const DEFAULT_DB_NAME = 'smartchoice';
const API_CACHE_COLLECTION = 'api_cache';
/**
 * Cache tìm kiếm siêu thị (MongoDB native driver, KHÔNG dùng Mongoose model):
 * - Collection: api_cache
 * - _id: "{Supermarket}:{keyword}:{latitude},{longitude}"  (vd: Woolworths:croissant:-12.4586,130.8294)
 * - Fields: supermarket, keyword, payload[], updatedAt, expiresAt
 * - Production: KHÔNG xóa hàng loạt — chỉ deleteOne từng _id khi quá chu kỳ Thứ Tư (Sydney)
 */
const PRICE_HISTORY_COLLECTION = 'price_history';
const PRICE_HISTORY_MAX_POINTS = 90;
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

let mongoClient = null;
let mongoDb = null;
let mongoDbName = DEFAULT_DB_NAME;
let mongoConnectPromise = null;
/** Sau lỗi Mongo — bỏ qua kết nối một lúc để search vẫn chạy (RAM cache + API). */
let mongoCooldownUntil = 0;
/** Cache tìm kiếm trong RAM (supermarket:keyword:lat,lng → payload). */
const memoryApiCache = new Map();

/**
 * Parse database name from MongoDB URI path (e.g. ...mongodb.net/smartchoice?appName=...).
 * Falls back to "smartchoice" when the URI has no database segment.
 */
function parseDatabaseNameFromUri(uri) {
  if (!uri) return DEFAULT_DB_NAME;
  try {
    const normalized = uri
      .replace(/^mongodb\+srv:\/\//i, 'https://')
      .replace(/^mongodb:\/\//i, 'https://');
    const url = new URL(normalized);
    const segment = decodeURIComponent(
      (url.pathname || '').replace(/^\//, '').split('/')[0] || ''
    ).trim();
    return segment || DEFAULT_DB_NAME;
  } catch {
    return DEFAULT_DB_NAME;
  }
}

/** Lazy singleton MongoDB connection (safe for local + serverless cold starts). */
async function connectMongo() {
  if (!MONGODB_URI) return null;
  if (isMongoInCooldown()) return null;
  if (mongoDb) return mongoDb;
  if (mongoConnectPromise) return mongoConnectPromise;

  mongoConnectPromise = withTimeout(
    (async () => {
    mongoDbName = parseDatabaseNameFromUri(MONGODB_URI);
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
      connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
      socketTimeoutMS: 12000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(mongoDbName);
    await mongoDb.command({ ping: 1 });
    await mongoDb.collection(API_CACHE_COLLECTION).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'api_cache_ttl' }
    );
    await mongoDb.collection(PRICE_HISTORY_COLLECTION).createIndex(
      { watchId: 1, supermarket: 1 },
      { name: 'price_history_watch_store' }
    );
    return mongoDb;
    })(),
    MONGO_CONNECT_TIMEOUT_MS,
    'MongoDB connect'
  );

  try {
    return await mongoConnectPromise;
  } catch (error) {
    mongoConnectPromise = null;
    if (mongoClient) {
      try {
        await mongoClient.close();
      } catch {
        /* ignore */
      }
    }
    mongoClient = null;
    mongoDb = null;
    mongoCooldownUntil = Date.now() + MONGO_COOLDOWN_MS;
    throw error;
  }
}

function isMongoInCooldown() {
  return Date.now() < mongoCooldownUntil;
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
 * Chỉ áp dụng Woolworths & ALDI — Coles vẫn báo lỗi qua safeFetch nếu cần.
 */
function shouldSoftFailStoreRawList(supermarket) {
  return supermarket === 'Woolworths' || supermarket === 'ALDI';
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
  if (!mongoDb) return null;
  return mongoDb.collection(API_CACHE_COLLECTION);
}

function getPriceHistoryCollection() {
  if (!mongoDb) return null;
  return mongoDb.collection(PRICE_HISTORY_COLLECTION);
}

function getSiteStatsCollection() {
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
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
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
 * Đọc cache API — RAM trước, Mongo timeout ngắn; miss thì gọi API (scraper) ngay.
 */
async function tryReadApiCache(supermarket, keyword, location) {
  await purgeApiCacheIfBeforeWednesdayCycle(supermarket, keyword, location);

  const mem = readMemoryApiCache(supermarket, keyword, location);
  if (mem != null) {
    console.log(`  ⚡ ${supermarket} memory cache hit: "${keyword}"`);
    return supermarket === 'Woolworths' ? refreshWoolworthsUrlsInRawList(mem) : mem;
  }

  if (!MONGODB_URI || isMongoInCooldown()) return null;

  try {
    const payload = await withTimeout(
      (async () => {
        await connectMongo();
        return readApiCache(supermarket, keyword, location);
      })(),
      API_CACHE_READ_TIMEOUT_MS,
      'MongoDB cache read'
    );
    if (payload != null) {
      const normalized =
        supermarket === 'Woolworths'
          ? refreshWoolworthsUrlsInRawList(payload)
          : payload;
      writeMemoryApiCache(supermarket, keyword, normalized, location);
      return normalized;
    }
    return null;
  } catch (err) {
    console.warn(`  ⚠ Cache read skipped (${supermarket}):`, err.message);
    mongoCooldownUntil = Date.now() + MONGO_COOLDOWN_MS;
    return null;
  }
}

/**
 * Khi API timeout — thử cache Mongo đã hết TTL (nhưng vẫn trong chu kỳ giá sau Thứ Tư).
 * Cache trước Thứ Tư gần nhất bị readApiCache xóa — không dùng lại link/giá tuần cũ.
 */
async function tryReadStaleApiCache(supermarket, keyword, location) {
  await purgeApiCacheIfBeforeWednesdayCycle(supermarket, keyword, location);

  const mem = readMemoryApiCache(supermarket, keyword, location);
  if (mem != null) {
    return supermarket === 'Woolworths' ? refreshWoolworthsUrlsInRawList(mem) : mem;
  }

  if (!MONGODB_URI || isMongoInCooldown()) return null;

  try {
    const payload = await withTimeout(
      (async () => {
        await connectMongo();
        return readApiCache(supermarket, keyword, location, { allowStale: true });
      })(),
      API_CACHE_STALE_READ_MS,
      'MongoDB stale cache read'
    );
    if (payload != null) {
      const normalized =
        supermarket === 'Woolworths'
          ? refreshWoolworthsUrlsInRawList(payload)
          : payload;
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

function buildPriceHistoryId(watchId, supermarket) {
  return `${String(watchId)}::${supermarket}`;
}

/**
 * Append or update today's price point for a watchlist product (one point per calendar day).
 */
async function recordPriceHistoryPoint(watchId, supermarket, price, productName = '') {
  const collection = getPriceHistoryCollection();
  if (!collection) return;

  const numericPrice = Number(price);
  if (!watchId || !supermarket || !Number.isFinite(numericPrice) || numericPrice <= 0) {
    return;
  }

  const _id = buildPriceHistoryId(watchId, supermarket);
  const today = new Date().toISOString().slice(0, 10);
  const existing = await collection.findOne({ _id });
  const points = Array.isArray(existing?.points) ? [...existing.points] : [];
  const last = points[points.length - 1];

  if (last && last.date === today) {
    last.price = Number(numericPrice.toFixed(2));
  } else {
    points.push({ date: today, price: Number(numericPrice.toFixed(2)) });
  }

  const trimmed = points.slice(-PRICE_HISTORY_MAX_POINTS);
  await collection.updateOne(
    { _id },
    {
      $set: {
        watchId: String(watchId),
        supermarket,
        productName: String(productName || existing?.productName || '').trim(),
        points: trimmed,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/** Load Coles + Woolworths price series for a watchlist entry. */
async function getPriceHistoryForWatch(watchId) {
  const collection = getPriceHistoryCollection();
  if (!collection) return [];

  const docs = await collection
    .find({ watchId: String(watchId) })
    .toArray();

  return docs.map((doc) => ({
    supermarket: doc.supermarket,
    points: Array.isArray(doc.points) ? doc.points : [],
  }));
}

function roundGeoCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

/**
 * Read latitude/longitude from the incoming request (headers preferred, then query, then JSON body).
 * Falls back to Sydney CBD when coordinates are missing or invalid.
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

  if (latitude != null && longitude != null) {
    const sourceHeader = String(req.headers['x-location-source'] || '').trim().toLowerCase();
    const source =
      sourceHeader === 'gps' || sourceHeader === 'default' ? sourceHeader : 'client';
    return {
      latitude: roundGeoCoord(latitude),
      longitude: roundGeoCoord(longitude),
      source,
    };
  }

  return { ...SYDNEY_DEFAULT_LOCATION };
}

/** Active coordinates for the current HTTP request (AsyncLocalStorage). */
function getRequestLocation() {
  return requestLocationContext.getStore()?.location || { ...SYDNEY_DEFAULT_LOCATION };
}

function buildLocationSegment(location) {
  const loc = location || getRequestLocation();
  return `${loc.latitude},${loc.longitude}`;
}

function buildApiCacheId(supermarket, keyword, location) {
  const locKey = buildLocationSegment(location);
  return `${supermarket}:${String(keyword || '').trim().toLowerCase()}:${locKey}`;
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

  if (
    !allowStale &&
    doc.expiresAt &&
    doc.expiresAt <= new Date()
  ) {
    return null;
  }
  // Empty arrays are treated as cache miss so a bad write does not block forever.
  if (Array.isArray(doc.payload) && doc.payload.length === 0) return null;
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
}

/** Connect on local startup and print database name for easy verification. */
async function initMongoForLocalStartup() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI is not set – supermarket API cache disabled.');
    return;
  }
  await connectMongo();
  console.log(`Connected successfully to Database: ${mongoDbName}`);
}

// ============================================================
// 2. KHỞI TẠO EXPRESS
// ============================================================
const app = express();
app.use(cors());                       // Cho phép front-end trên origin khác gọi vào
app.use(express.json({ limit: '32kb' }));
// Attach parsed user coordinates to the async context for downstream RapidAPI calls.
app.use((req, _res, next) => {
  const location = parseUserLocationFromRequest(req);
  requestLocationContext.run({ location }, () => next());
});
// Tắt cache để tránh trình duyệt dùng JS/API cũ gây hiển thị dữ liệu "fake"
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// Trang Terms — chèn link Feedback Tally từ FEEDBACK_TALLY_URL rồi res.send
app.get(['/terms', '/terms/'], (_req, res) => {
  try {
    const termsPath = path.join(PUBLIC_DIR, 'terms', 'index.html');
    const html = injectFeedbackLinkIntoHtml(fs.readFileSync(termsPath, 'utf8'));
    res.type('html').send(html);
  } catch (error) {
    console.error('  ❌ Không tải được trang Terms:', error.message);
    res.status(500).send('Cannot load terms page.');
  }
});

/**
 * Trang chủ — gửi HTML qua res.send (monolithic string sau khi chèn nút Feedback chuẩn).
 * Không dùng script Front-end ghi đè href; trình duyệt mở link Tally bằng thẻ <a> thuần.
 */
app.get('/', (_req, res) => {
  try {
    if (!cachedHomeHtml) {
      cachedHomeHtml = buildHomePageHtml();
    }
    res.type('html').send(cachedHomeHtml);
  } catch (error) {
    console.error('  ❌ Không tải được trang chủ:', error.message);
    res.status(500).send('Cannot load home page.');
  }
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
  const multiMatch = source.match(
    /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i
  );
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
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') {
    return `${storeName} API timed out. Please try again in a few seconds.`;
  }
  if (apiMessage) return `${storeName} API error: ${apiMessage}`;
  return error?.message || `${storeName} API is temporarily unavailable.`;
}

const WOOLWORTHS_SITE_ORIGIN = 'https://www.woolworths.com.au';

/**
 * Link PDP Woolworths — chỉ StockCode, không slug (tránh 404).
 * https://www.woolworths.com.au/shop/productdetails/{StockCode}
 */
function buildWoolworthsProductUrl(raw) {
  const stockcode =
    raw.StockCode ??
    raw.stockCode ??
    raw.StoreProductNo ??
    raw.storeProductNo ??
    raw.stockcode ??
    raw.Stockcode ??
    raw.product_id ??
    raw.productId;
  if (stockcode == null || stockcode === '') return '';

  const code = String(stockcode).replace(/\D/g, '');
  if (!code) return '';

  return `${WOOLWORTHS_SITE_ORIGIN}/shop/productdetails/${code}`;
}

/** Rút stockcode từ URL/path Woolworths → URL chuẩn không slug. */
function normalizeWoolworthsUrlToStockcodeOnly(urlOrPath, raw = {}) {
  const trimmed = String(urlOrPath || '').trim();
  const stockFromPath = trimmed.match(/\/productdetails\/(\d+)/i);
  if (stockFromPath) {
    return `${WOOLWORTHS_SITE_ORIGIN}/shop/productdetails/${stockFromPath[1]}`;
  }
  return buildWoolworthsProductUrl(raw);
}

/**
 * Ghép domain đầy đủ khi Woolworths trả path tương đối, rồi chuẩn hóa về URL chỉ stockcode.
 */
function toAbsoluteWoolworthsProductUrl(urlOrPath, raw = {}) {
  const trimmed = String(urlOrPath || '').trim();
  if (!trimmed) return buildWoolworthsProductUrl(raw);

  if (/^https?:\/\//i.test(trimmed)) {
    return normalizeWoolworthsUrlToStockcodeOnly(trimmed, raw);
  }

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    const path = /\/productdetails\/\d+/i.test(trimmed)
      ? trimmed.startsWith('/shop/')
        ? trimmed
        : `/shop${trimmed.replace(/^\/+/, '')}`
      : trimmed;
    return normalizeWoolworthsUrlToStockcodeOnly(
      `${WOOLWORTHS_SITE_ORIGIN}${path.replace(/\/+$/, '')}`,
      raw
    );
  }

  return normalizeWoolworthsUrlToStockcodeOnly(trimmed, raw);
}

/** Ghi đè URL Woolworths trong cache — luôn dạng /productdetails/{stockcode} (không slug). */
function refreshWoolworthsUrlsInRawList(rawList) {
  if (!Array.isArray(rawList)) return rawList;
  return rawList.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;

    const legacy = String(raw.url || raw.product_url || '').trim();
    const fixed =
      buildWoolworthsProductUrl(raw) ||
      (legacy ? normalizeWoolworthsUrlToStockcodeOnly(legacy, raw) : '');

    if (!fixed) return raw;

    const legacyStockOnly = legacy
      ? normalizeWoolworthsUrlToStockcodeOnly(legacy, raw)
      : '';
    if (legacyStockOnly === fixed) return { ...raw, url: fixed, product_url: fixed };

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
      return toAbsoluteWoolworthsProductUrl(trimmed, raw);
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
    return buildWoolworthsProductUrl(raw);
  }

  if (supermarket === 'ALDI' && raw.slug && raw.sku) {
    const slug = String(raw.slug).replace(/^\//, '');
    const sku = String(raw.sku).replace(/\D/g, '');
    if (slug && sku) return `https://www.aldi.com.au/product/${slug}/p/${sku}`;
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
  let size = String(
    raw.size || raw.package_size || raw.pack_size || raw.unit_size || ''
  ).trim();

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
  if (supermarket === 'ALDI' && raw.sku) {
    return `aldi-${String(raw.sku).replace(/\D/g, '')}`;
  }
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
    'upc',
    'product_barcode',
    'productBarcode',
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
        return normalizeItem(raw, supermarket);
      }
    }
  }

  return null;
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
 * Compare prices across two or more normalized products (Coles / Woolworths / ALDI).
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
  return compareStoresForCheaper(
    [woolworthsItem, colesItem].filter(Boolean)
  );
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
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
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

  const fromSizeField = parseQuantityFromText(
    raw.size || raw.package_size || raw.pack_size || ''
  );
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
      parsePrice(raw.cupPrice) ??
      parsePrice(raw.CupPrice) ??
      parsePrice(raw.price_per_unit_price);
    if (fromCup != null) return fromCup;
  }

  const dollarMatch = String(metaText).match(
    /\$\s*([\d]+(?:\.\d+)?)\s*(?:\/|per)\s*kg/i
  );
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
    return { isWhole: false, isFractional: true, multiplier: 4, type: 'quarter', penalizeMatch: true };
  }

  if (/\bthird\b/i.test(lower) || /\b1\/3\b/.test(lower)) {
    return { isWhole: false, isFractional: true, multiplier: 3, type: 'third', penalizeMatch: true };
  }

  if (/\bslices?\b/i.test(lower)) {
    return { isWhole: false, isFractional: true, multiplier: 1, type: 'slices', penalizeMatch: true };
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
function applyListItemPricing(product, listItem) {
  if (!product || !listItem) return product;

  const unit = String(listItem.unit || 'each').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  const targetWeightKg = getTargetWeightKg(listItem);

  const packShelfPrice =
    product.packShelfPrice != null ? product.packShelfPrice : product.price;

  let pricePerKg = product.pricePerKg;
  if (pricePerKg == null && targetWeightKg != null) {
    const packKg = product.packWeightKg ?? getPackWeightKgFromProduct(product.name, {});
    pricePerKg = derivePricePerKgFromPack(packShelfPrice, packKg);
  }

  let finalPrice = packShelfPrice;
  let pricingNote = null;
  let isAdjustedPrice = false;

  if (pricePerKg != null && targetWeightKg != null) {
    finalPrice = Number((pricePerKg * targetWeightKg).toFixed(2));
    isAdjustedPrice = true;

    const weightLabel =
      unit === 'g' ? `${qty}g` : unit === 'kg' ? `${qty}kg` : `${targetWeightKg}kg`;

    pricingNote = `($${pricePerKg.toFixed(2)}/kg, converted for ${weightLabel})`;
  } else if (['each', 'ea', 'bunch', 'pack', 'pk'].includes(unit)) {
    const frac = detectFractionalUnit(product.name);

    if (frac.isFractional && frac.multiplier > 1) {
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
  const coreKeyword = stripWeightFromText(listItem?.keyword || searchText);
  const weightListItem =
    listItem || buildListItemFromSearchText(searchText, coreKeyword);
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
  const produceIntent = isProduceSearchIntent(coreKeyword, matchListItem);
  const maxQueries = fast && !produceIntent ? 1 : queries.length;

  const hasAcceptableMatch = () => {
    if (!items.length) return false;
    // Không phải trái/rau → chỉ cần API trả về sản phẩm
    if (!produceIntent) return true;
    const { product } = pickBestProductMatch(items, coreKeyword, matchListItem);
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

function normalizeItem(raw, supermarket) {
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
  let price = listedPrice ?? discountPrice ?? parsePrice(raw.selling_price) ?? parsePrice(raw.final_price);
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

  let url = extractProductUrl(raw, supermarket);
  if (supermarket === 'Woolworths') {
    url =
      normalizeWoolworthsUrlToStockcodeOnly(url, raw) ||
      buildWoolworthsProductUrl(raw);
  }

  const image =
    raw.image ||
    (Array.isArray(raw.images) ? raw.images[0] : null) ||
    raw.image_url ||
    raw.imageUrl ||
    raw.thumbnail ||
    raw.img ||
    '';

  const packShelfPrice = price;
  const { pricePerKg, packWeightKg, source: pricePerKgSource } = resolvePricePerKg(
    raw,
    name,
    packShelfPrice
  );
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
  const barcode = barcodes[0] || null;

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
  UNKNOWN: 'unknown',
};

/** Các cặp bucket không được ghép (điểm = 0 ngay lập tức). */
const CATEGORY_INCOMPATIBLE_PAIRS = [
  [CATEGORY_BUCKETS.DRINKS, CATEGORY_BUCKETS.FRESH_PRODUCE],
  [CATEGORY_BUCKETS.DRINKS, CATEGORY_BUCKETS.MEAT_SEAFOOD],
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
  if (
    /\b(juice|cordial|soft drink|soda|cola|lemonade|beverage|h2juice|drink)\b/.test(
      nameNorm
    )
  ) {
    return true;
  }

  // Chai/lon: có dung tích ml/L mà không phải rau quả bán lẻ
  const sizeInfo = extractSizeInfo(displayName);
  const hasBottleVolume =
    sizeInfo.grams != null &&
    (/\b\d+(?:\.\d+)?\s*ml\b/i.test(displayName) ||
      /\b\d+(?:\.\d+)?\s*l\b/i.test(displayName));
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

/** Sản phẩm chế biến chỉ “mượn” từ khóa (vd: prawn → crackers/sauce, không phải tôm tươi). */
function nameSuggestsProcessedNotCoreIngredient(displayName, keyword) {
  const nameNorm = normalizeNameForMatch(displayName);
  const kwNorm = normalizeNameForMatch(stripWeightFromText(keyword));
  const primary = kwNorm.split(' ').filter((w) => w.length > 2)[0];
  if (!primary) return false;
  if (!haystackHasWord(nameNorm, primary)) return false;

  return /\b(cracker|crackers|chip|chips|crisp|crisps|sauce|paste|stock|broth|powder|seasoning|noodle|noodles|instant|dim sim|spring roll|soup|dip|dips|marinade|rice paper|paper|flavour|flavor|flavoured|flavored)\b/.test(
    nameNorm
  );
}

/** Kẹo/snack/rượu – tên có "watermelon" nhưng không phải quả tươi. */
function nameSuggestsNonFreshProduceSnack(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  return /\b(sour|lollies|lolly|candy|chocolate|chips|crisps|snack|muesli|gin|vodka|beer|wine|liqueur|cordial concentrate)\b/.test(
    nameNorm
  );
}

/** Từ khóa đồ uống trong tên (không gọi looksLikeLooseFreshProduceName – tránh đệ quy). */
function hasPackagedDrinkKeywords(displayName) {
  const nameNorm = normalizeNameForMatch(displayName);
  return /\b(juice|cordial|soft drink|soda|cola|lemonade|beverage|h2juice|drink)\b/.test(
    nameNorm
  );
}

/** Tên gợi ý trái cây/rau bán tươi (không phải chai nước ép). */
function looksLikeLooseFreshProduceName(displayName) {
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
    (/\b\d+(?:\.\d+)?\s*ml\b/i.test(displayName) ||
      /\b\d+(?:\.\d+)?\s*l\b/i.test(displayName));

  if (!hasBottleVolume) return false;

  // Có dung tích chai nhưng tên là dưa/táo/rau tươi → không phải nước ép
  return !looksLikeLooseFreshProduceName(displayName);
}

/**
 * Gán bucket cho 1 sản phẩm: ưu tiên category API, sau đó heuristics tên.
 */
function classifyCategoryBucket(labels, displayName, raw = {}) {
  const haystack = buildCategoryHaystack(labels, displayName);

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
  if (/\b(pantry|grocery|snack|confectionery)\b/i.test(haystack)) {
    return CATEGORY_BUCKETS.PANTRY;
  }

  if (nameSuggestsPackagedDrink(displayName)) return CATEGORY_BUCKETS.DRINKS;
  if (looksLikeLooseFreshProduceName(displayName)) return CATEGORY_BUCKETS.FRESH_PRODUCE;

  const nameNorm = normalizeNameForMatch(displayName);
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
  if (PRODUCE_INTENT_KEYWORDS.some((kw) => haystackHasWord(nameNorm, kw))) {
    return CATEGORY_BUCKETS.FRESH_PRODUCE;
  }

  return CATEGORY_BUCKETS.UNKNOWN;
}

function resolveProductBucket(productOrName, rawFallback = null) {
  if (productOrName && typeof productOrName === 'object') {
    if (productOrName.categoryBucket) return productOrName.categoryBucket;
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
  const a = bucketA || CATEGORY_BUCKETS.UNKNOWN;
  const b = bucketB || CATEGORY_BUCKETS.UNKNOWN;
  if (a === b) return true;
  if (a === CATEGORY_BUCKETS.UNKNOWN || b === CATEGORY_BUCKETS.UNKNOWN) return true;

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

  const drinkA =
    bucketA === CATEGORY_BUCKETS.DRINKS || nameSuggestsPackagedDrink(nameA);
  const drinkB =
    bucketB === CATEGORY_BUCKETS.DRINKS || nameSuggestsPackagedDrink(nameB);
  const freshA =
    bucketA === CATEGORY_BUCKETS.FRESH_PRODUCE ||
    looksLikeLooseFreshProduceName(nameA);
  const freshB =
    bucketB === CATEGORY_BUCKETS.FRESH_PRODUCE ||
    looksLikeLooseFreshProduceName(nameB);

  if ((drinkA && freshB) || (drinkB && freshA)) return false;

  return areCategoryBucketsCompatible(bucketA, bucketB);
}

/**
 * Ý định tìm kiếm từ từ khóa người dùng / dòng giỏ AI.
 * "watermelon" → fresh_produce; "watermelon juice" → drinks.
 */
function inferIntentBucketFromKeyword(keyword, listItem = {}) {
  const combined = `${keyword || ''} ${listItem.keyword || ''}`.trim();
  const core = stripWeightFromText(combined);
  const norm = normalizeNameForMatch(core);
  if (!norm) return null;

  if (/\b(juice|drink|drinks|cordial|soda|beverage|soft drink)\b/.test(norm)) {
    return CATEGORY_BUCKETS.DRINKS;
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
    'seafood',
    'crab',
    'squid',
  ];
  if (
    meatSeaTokens.some((kw) => haystackHasWord(norm, kw)) &&
    !/\b(cracker|crackers|sauce|stock|powder|noodle|paste|juice)\b/.test(norm)
  ) {
    return CATEGORY_BUCKETS.MEAT_SEAFOOD;
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

    // Tên rõ là trái tươi dù API gán nhầm bucket "drinks"
    if (
      productNameMatchesProduceKeyword(name, keyword) &&
      !nameSuggestsPackagedDrink(name)
    ) {
      return true;
    }

    if (bucket === CATEGORY_BUCKETS.DRINKS) return false;
    if (bucket === CATEGORY_BUCKETS.FRESH_PRODUCE) return true;
    if (bucket === CATEGORY_BUCKETS.UNKNOWN) {
      return (
        looksLikeLooseFreshProduceName(name) ||
        productNameMatchesProduceKeyword(name, keyword)
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
      if (nameSuggestsPackagedDrink(name)) return false;
      if (nameSuggestsNonFreshProduceSnack(name)) return false;
      if (resolveProductBucket(p) === CATEGORY_BUCKETS.DRINKS) return false;
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

function extractVarieties(name) {
  const lower = String(name).toLowerCase();
  return VARIETY_KEYWORDS.filter((keyword) => lower.includes(keyword));
}

/** Hai tên có cùng “dòng” sản phẩm (không Jasmine vs Basmati) */
function varietiesCompatible(nameA, nameB) {
  const vA = extractVarieties(nameA);
  const vB = extractVarieties(nameB);
  if (!vA.length || !vB.length) return true;

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
function checkSizeCompatibility(nameA, nameB) {
  // Thịt/rau tươi: cân nặng khay thay đổi → không loại vì lệch 500g vs 1kg
  if (
    freshFoodCorePhraseMatch(nameA, nameB) ||
    (isFreshFoodCategory(nameA) && isFreshFoodCategory(nameB))
  ) {
    return 'ok';
  }

  const a = extractSizeInfo(nameA);
  const b = extractSizeInfo(nameB);

  if (a.packCount !== b.packCount && (a.packCount > 1 || b.packCount > 1)) {
    return 'conflict';
  }

  if (a.grams != null && b.grams != null) {
    const ratio = Math.min(a.grams, b.grams) / Math.max(a.grams, b.grams);
    if (ratio < 0.85) return 'conflict';
    return 'ok';
  }

  if (
    (a.grams != null && b.grams == null) ||
    (a.grams == null && b.grams != null)
  ) {
    return 'mismatch_one_sided';
  }

  return 'ok';
}

/** Điểm ghép cặp tổng hợp: danh mục + tên + loại + khối lượng */
function scoreProductPair(woolInput, colesInput) {
  const woolName = resolveProductName(woolInput);
  const colesName = resolveProductName(colesInput);
  const woolNorm = normalizeNameForMatch(woolName);
  const colesNorm = normalizeNameForMatch(colesName);
  if (!woolNorm || !colesNorm) return 0;

  // Drinks ↔ Fresh (vd: H2juice Watermelon vs Seedless Watermelon) → không ghép
  if (!areProductCategoriesCompatible(woolInput, colesInput)) return 0;

  // Cùng cụm "pork belly" → ghép dù khác Roast / Slices / Rind On
  if (freshFoodCorePhraseMatch(woolName, colesName)) {
    const base = stringSimilarity.compareTwoStrings(woolNorm, colesNorm);
    return Math.min(Math.max(base, FRESH_PAIR_SCORE_FLOOR), 1);
  }

  if (!varietiesCompatible(woolName, colesName)) return 0;

  const sizeStatus = checkSizeCompatibility(woolName, colesName);
  if (sizeStatus === 'conflict') return 0;

  let score = stringSimilarity.compareTwoStrings(woolNorm, colesNorm);

  if (sizeStatus === 'mismatch_one_sided') {
    const freshLoose =
      isFreshFoodCategory(woolName) || isFreshFoodCategory(colesName);
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

  if (!isProductEligibleForSearchIntent(productRef, keyword, listItem)) return 0;
  if (nameSuggestsNonFreshProduceSnack(displayName)) return 0;

  if (nameSuggestsProcessedNotCoreIngredient(displayName, keyword)) return 0;

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

  if (!produceNameHit && !varietiesCompatible(displayName, query)) return 0;

  const sizeStatus = checkSizeCompatibility(displayName, query);
  if (!produceNameHit && sizeStatus === 'conflict') return 0;

  let score = stringSimilarity.compareTwoStrings(productNorm, queryNorm);

  const words = queryNorm.split(' ').filter((w) => w.length > 2);
  for (const word of words) {
    if (productNorm.includes(word)) score += 0.04;
  }

  if (isFreshFoodCategory(displayName) && isFreshFoodCategory(coreKeyword)) {
    const coreWords = stripWeightFromText(coreKeyword).split(' ').filter((w) => w.length > 2);
    const allInProduct = coreWords.length > 0 && coreWords.every((w) => productNorm.includes(w));
    if (allInProduct) score = Math.max(score, 0.52);
  }

  const intent = inferIntentBucketFromKeyword(keyword, listItem);
  const productBucket = resolveProductBucket(productRef);
  if (intent && productBucket !== CATEGORY_BUCKETS.UNKNOWN && intent === productBucket) {
    score = Math.min(score + 0.08, 1);
  }

  // Trái/rau (watermelon, apple…): tên khớp từ khóa → điểm sàn cao, vẫn loại chai nước ép
  if (
    isProduceSearchIntent(keyword, listItem) &&
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

  const hint = buildQuantityHint(listItem);
  let best = null;
  let bestScore = 0;

  for (const product of candidates) {
    let score = scoreProductForKeyword(
      product.name,
      keyword,
      hint,
      listItem,
      product
    );
    if (resolveProductBucket(product) === CATEGORY_BUCKETS.FRESH_PRODUCE) {
      score = Math.min(score + 0.06, 1);
    }
    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }

  let threshold =
    isProduceSearchIntent(keyword, listItem) ||
    isFreshFoodCategory(keyword) ||
    isFreshFoodCategory(best?.name)
      ? FRESH_LIST_MATCH_THRESHOLD
      : LIST_MATCH_THRESHOLD;

  if (
    best &&
    isProduceSearchIntent(keyword, listItem) &&
    productNameMatchesProduceKeyword(best.name, keyword) &&
    !nameSuggestsPackagedDrink(best.name)
  ) {
    threshold = Math.min(threshold, 0.26);
  }

  if (!best || bestScore < threshold) {
    if (isProduceSearchIntent(keyword, listItem)) {
      const fallback = products.find((p) => {
        const name = p?.name || '';
        return (
          productNameMatchesProduceKeyword(name, keyword) &&
          !nameSuggestsPackagedDrink(name) &&
          !nameSuggestsNonFreshProduceSnack(name) &&
          resolveProductBucket(p) !== CATEGORY_BUCKETS.DRINKS
        );
      });
      if (fallback) {
        return { product: fallback, score: Number(Math.max(bestScore, 0.45).toFixed(2)) };
      }
    }
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
  const candidates = filterProductsForSearchIntent(products, keyword, listItem);
  if (!candidates.length) return [];

  const hint = buildQuantityHint(listItem);
  const kw = String(listItem.keyword || keyword || '').trim();

  const scored = candidates.map((product) => {
    let score = scoreProductForKeyword(product.name, kw, hint, listItem, product);
    if (resolveProductBucket(product) === CATEGORY_BUCKETS.FRESH_PRODUCE) {
      score = Math.min(score + 0.06, 1);
    }
    return { product, score };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.02) return b.score - a.score;
    return (a.product.price || 0) - (b.product.price || 0);
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
 * Lọc ALDI trước khi xếp hàng — tên PHẢI chứa từ khóa (loại Basa, Baked Beans, catalog lạ).
 */
function filterAldiProductsByKeywordTitle(products, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw || !Array.isArray(products)) return [];
  return products.filter(
    (item) => item && item.name && item.name.toLowerCase().includes(kw)
  );
}

/** Gắn so sánh giá rẻ nhất cho một hàng ma trận (chỉ các ô có sản phẩm). */
function attachMatrixRowComparison(matrixRow) {
  const available = [matrixRow.woolworths, matrixRow.coles, matrixRow.aldi].filter(Boolean);
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
 * Ma trận so sánh (alignedRows / synchronizedRows):
 * - Hàng gốc = cặp Similar Coles ↔ Woolworths + món WW/Coles chưa ghép
 * - ALDI: lọc tên chứa keyword → gán filteredAldi[i] || null theo chỉ số hàng
 * - Hết bánh croissant → ô ALDI null (nét đứt), không nhét cá basa / đậu hộp
 */
function buildAlignedCompareMatrix(keyword, listItem, woolItems, colesItems, aldiItems) {
  const item = listItem || buildListItemForKeywordSearch(keyword);
  const kw = String(keyword || item.keyword || '').trim();

  const woolworthsOptions = buildStoreOptionsForKeyword(woolItems, item.keyword, item);
  const colesOptions = buildStoreOptionsForKeyword(colesItems, item.keyword, item);

  // Lọc cứng ALDI — chỉ món có tên chứa từ khóa (vd "croissant")
  const filteredAldi = filterAldiProductsByKeywordTitle(aldiItems, kw);

  const similarPairs = buildSimilarPairs(woolworthsOptions, colesOptions);
  const usedWoolKeys = new Set();
  const usedColesKeys = new Set();
  const matrixRows = [];

  for (const pair of similarPairs) {
    if (matrixRows.length >= RESULT_LIMIT) break;

    usedWoolKeys.add(productStableKey(pair.woolworths));
    usedColesKeys.add(productStableKey(pair.coles));

    const rowIndex = matrixRows.length;
    matrixRows.push(
      attachMatrixRowComparison({
        rowIndex,
        woolworths: pair.woolworths,
        coles: pair.coles,
        aldi: filteredAldi[rowIndex] || null,
        matchType: 'similar_pair',
        similarity: pair.similarity,
      })
    );
  }

  for (const wool of woolworthsOptions) {
    if (matrixRows.length >= RESULT_LIMIT) break;
    const key = productStableKey(wool);
    if (usedWoolKeys.has(key)) continue;
    usedWoolKeys.add(key);

    const rowIndex = matrixRows.length;
    matrixRows.push(
      attachMatrixRowComparison({
        rowIndex,
        woolworths: wool,
        coles: null,
        aldi: filteredAldi[rowIndex] || null,
        matchType: 'woolworths_only',
      })
    );
  }

  for (const coles of colesOptions) {
    if (matrixRows.length >= RESULT_LIMIT) break;
    const key = productStableKey(coles);
    if (usedColesKeys.has(key)) continue;
    usedColesKeys.add(key);

    const rowIndex = matrixRows.length;
    matrixRows.push(
      attachMatrixRowComparison({
        rowIndex,
        woolworths: null,
        coles,
        aldi: filteredAldi[rowIndex] || null,
        matchType: 'coles_only',
      })
    );
  }

  return {
    keyword: kw,
    matrixRows,
    similarPairCount: similarPairs.length,
    orphanRowsCapped: false,
    storeCounts: {
      woolworths: woolworthsOptions.length,
      coles: colesOptions.length,
      aldi: filteredAldi.length,
    },
  };
}

/** Ma trận 1 hàng khi quét barcode — hiển thị trực tiếp sản phẩm từng siêu thị (không lọc ALDI). */
function buildAlignedCompareMatrixFromProducts(keyword, woolProduct, colesProduct, aldiProduct) {
  const kw = String(keyword || '').trim();

  const matrixRows = [
    attachMatrixRowComparison({
      rowIndex: 0,
      woolworths: woolProduct || null,
      coles: colesProduct || null,
      aldi: aldiProduct || null,
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
      aldi: aldiProduct ? 1 : 0,
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
  const keyword = String(listItem.keyword || '').trim();
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
  const candidates = filterProductsForSearchIntent(products, keyword, listItem);
  if (!candidates.length) return null;

  let best = null;

  for (const product of candidates) {
    const shelf = product.packShelfPrice ?? product.price;
    if (shelf == null || shelf <= 0) continue;

    const score = scoreProductForKeyword(
      product.name,
      keyword,
      '',
      listItem,
      product
    );
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
 * Resolve the best product for one store: direct match → pack fallback → smaller-pack search.
 */
async function resolveStoreLineMatch(supermarket, searchQuery, listItem) {
  let storeError = null;
  let allItems = [];

  try {
    const result = await fetchStoreProducts(supermarket, searchQuery, listItem);
    allItems = result.items;
    storeError = result.error;
  } catch (error) {
    storeError = formatStoreError(supermarket, error);
    return { product: null, score: 0, error: storeError, packageFallback: false };
  }

  let picked = pickBestProductMatch(allItems, listItem.keyword, listItem);
  if (picked.product) {
    return {
      product: applyListItemPricing(picked.product, listItem),
      score: picked.score,
      error: storeError,
      packageFallback: false,
    };
  }

  let pkg = pickPackageFallbackFromProducts(allItems, listItem);
  if (pkg) {
    console.log(`  📦 ${supermarket} package fallback: ${pkg.pricingNote}`);
    return {
      product: buildPackageFallbackPricedProduct(pkg, listItem),
      score: pkg.score,
      error: storeError,
      packageFallback: true,
    };
  }

  const extraItems = await fetchSmallerPackProductItems(supermarket, listItem);
  if (extraItems.length) {
    allItems = mergeProductLists(allItems, extraItems, RESULT_LIMIT * 2);
    pkg = pickPackageFallbackFromProducts(allItems, listItem);
    if (pkg) {
      console.log(`  📦 ${supermarket} package fallback (extra search): ${pkg.pricingNote}`);
      return {
        product: buildPackageFallbackPricedProduct(pkg, listItem),
        score: pkg.score,
        error: storeError,
        packageFallback: true,
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
  if (store === 'aldi') {
    return Boolean(line.aldi) && Number(line.aldiLinePrice) > 0;
  }
  return Boolean(line.woolworths) && Number(line.woolworthsLinePrice) > 0;
}

/**
 * Impute single-store cart totals when a supermarket has no match (never $0).
 */
function enrichLineWithSingleStorePricing(line) {
  const colesUsable = storeLineHasUsablePrice(line, 'coles');
  const woolUsable = storeLineHasUsablePrice(line, 'woolworths');
  const aldiUsable = storeLineHasUsablePrice(line, 'aldi');

  const colesActual = colesUsable ? Number(line.colesLinePrice) : 0;
  const woolActual = woolUsable ? Number(line.woolworthsLinePrice) : 0;
  const aldiActual = aldiUsable ? Number(line.aldiLinePrice) : 0;

  const itemLabel = formatRequestKeywordLabel(line.request);

  const rivalPrices = () => {
    const prices = [];
    if (colesUsable) prices.push(colesActual);
    if (woolUsable) prices.push(woolActual);
    if (aldiUsable) prices.push(aldiActual);
    return prices;
  };

  const imputeFromRivals = () => {
    const prices = rivalPrices();
    return prices.length ? Math.min(...prices) : 0;
  };

  let colesSingleStorePrice = colesUsable ? colesActual : imputeFromRivals();
  let woolSingleStorePrice = woolUsable ? woolActual : imputeFromRivals();
  let aldiSingleStorePrice = aldiUsable ? aldiActual : imputeFromRivals();

  let colesIncomplete = !colesUsable && rivalPrices().length > 0;
  let woolIncomplete = !woolUsable && rivalPrices().length > 0;
  let aldiIncomplete = !aldiUsable && rivalPrices().length > 0;

  const colesIncompleteNote = colesIncomplete
    ? `This store is missing ${itemLabel}; price estimated from other supermarkets for comparison.`
    : null;
  const woolIncompleteNote = woolIncomplete
    ? `This store is missing ${itemLabel}; price estimated from other supermarkets for comparison.`
    : null;
  const aldiIncompleteNote = aldiIncomplete
    ? `This store is missing ${itemLabel}; price estimated from other supermarkets for comparison.`
    : null;

  return {
    ...line,
    colesSingleStorePrice: Number(colesSingleStorePrice.toFixed(2)),
    woolworthsSingleStorePrice: Number(woolSingleStorePrice.toFixed(2)),
    aldiSingleStorePrice: Number(aldiSingleStorePrice.toFixed(2)),
    colesIncomplete,
    woolIncomplete,
    aldiIncomplete,
    colesIncompleteNote,
    woolIncompleteNote,
    aldiIncompleteNote,
    is_incomplete: colesIncomplete || woolIncomplete || aldiIncomplete,
  };
}

function formatRequestKeywordLabel(request) {
  if (!request) return 'item';
  return String(request.keyword || '').trim() || 'item';
}

// ============================================================
// 3c. AI SHOPPING LIST – PARSE PROMPT & TỐI ƯU GIỎ
// ============================================================

const SHOPPING_LIST_SYSTEM_PROMPT = `You extract grocery shopping list items from natural language.
Return ONLY valid JSON: an array of objects with exactly these fields:
- "keyword": English search term for Australian supermarkets (e.g. "rice", "belly pork", "milk")
- "quantity": number (default 1)
- "unit": one of kg, g, L, ml, each, pack, bunch

Rules:
- Use simple product keywords suitable for Coles, Woolworths, and ALDI search.
- Convert volumes: 2L → quantity 2, unit "L". 500ml → quantity 500, unit "ml".
- "2 kg rice" → keyword "rice", quantity 2, unit "kg".
- No markdown, no explanation, only the JSON array.`;

/** Gọi OpenAI để bóc tách danh sách món */
async function parseShoppingListWithAI(promptText) {
  if (!openaiClient) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Add it to .env to use AI list analysis.'
    );
  }

  const completion = await openaiClient.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SHOPPING_LIST_SYSTEM_PROMPT },
      { role: 'user', content: promptText },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  const jsonText = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(jsonText);

  if (!Array.isArray(parsed)) {
    throw new Error('AI did not return a JSON array.');
  }

  return parsed
    .map((row) => ({
      keyword: String(row.keyword || row.item || row.name || '').trim(),
      quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
      unit: String(row.unit || 'each').trim().toLowerCase(),
    }))
    .filter((row) => row.keyword);
}

/** Dự phòng khi không có OpenAI: regex tách từng dòng */
function parseShoppingListFallback(promptText) {
  const segments = String(promptText)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.map((part) => {
    const match = part.match(
      /^(\d+(?:\.\d+)?)\s*(kg|g|l|ml|each|pack|bunch)?\s+(.+)$/i
    );
    if (match) {
      return {
        keyword: match[3].trim(),
        quantity: parseFloat(match[1]),
        unit: (match[2] || 'each').toLowerCase(),
      };
    }
    return { keyword: part, quantity: 1, unit: 'each' };
  });
}

/** Pick the cheapest store for one cart line (PRICE_EPSILON tie → lowest wins). */
function pickCheapestStoreForLine(colesPriced, woolPriced, aldiPriced) {
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
  if (aldiPriced && Number(aldiPriced.price) > 0) {
    candidates.push({ store: 'ALDI', product: aldiPriced, price: Number(aldiPriced.price) });
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

/** Resolve best product match for one line at Coles, Woolworths, and ALDI (parallel). */
async function resolveListItem(listItem) {
  const searchQuery = buildSearchQueryFromListItem(listItem);

  const [colesSettled, woolSettled, aldiSettled] = await Promise.allSettled([
    resolveStoreLineMatch('Coles', searchQuery, listItem),
    resolveStoreLineMatch('Woolworths', searchQuery, listItem),
    resolveStoreLineMatch('ALDI', searchQuery, listItem),
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
  const aldiResult =
    aldiSettled.status === 'fulfilled'
      ? aldiSettled.value
      : {
          product: null,
          score: 0,
          error: formatStoreError('ALDI', aldiSettled.reason),
          packageFallback: false,
        };

  const colesPriced = colesResult.product;
  const woolPriced = woolResult.product;
  const aldiPriced = aldiResult.product;

  const colesPrice = colesPriced?.price ?? 0;
  const woolPrice = woolPriced?.price ?? 0;
  const aldiPrice = aldiPriced?.price ?? 0;

  const { chosenStore, chosenProduct, lineTotal } = pickCheapestStoreForLine(
    colesPriced,
    woolPriced,
    aldiPriced
  );

  const baseLine = {
    request: listItem,
    searchQuery,
    coles: colesPriced,
    woolworths: woolPriced,
    aldi: aldiPriced,
    colesLinePrice: colesPrice,
    woolworthsLinePrice: woolPrice,
    aldiLinePrice: aldiPrice,
    colesMatchScore: colesResult.score,
    woolworthsMatchScore: woolResult.score,
    aldiMatchScore: aldiResult.score,
    colesPackageFallback: Boolean(colesResult.packageFallback),
    woolworthsPackageFallback: Boolean(woolResult.packageFallback),
    aldiPackageFallback: Boolean(aldiResult.packageFallback),
    storeErrors: {
      coles: colesResult.error,
      woolworths: woolResult.error,
      aldi: aldiResult.error,
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
  let aldiOnlyTotal = 0;
  let splitTotal = 0;
  const splitCart = { coles: [], woolworths: [], aldi: [] };
  const unresolved = [];
  const incompleteWarnings = [];

  for (const line of lineItems) {
    const colesUsable = storeLineHasUsablePrice(line, 'coles');
    const woolUsable = storeLineHasUsablePrice(line, 'woolworths');
    const aldiUsable = storeLineHasUsablePrice(line, 'aldi');

    colesOnlyTotal += line.colesSingleStorePrice ?? line.colesLinePrice ?? 0;
    woolworthsOnlyTotal += line.woolworthsSingleStorePrice ?? line.woolworthsLinePrice ?? 0;
    aldiOnlyTotal += line.aldiSingleStorePrice ?? line.aldiLinePrice ?? 0;

    if (!colesUsable && !woolUsable && !aldiUsable && line.request?.keyword) {
      unresolved.push(line.request.keyword);
    }

    if (line.colesIncomplete && line.colesIncompleteNote) {
      incompleteWarnings.push({ store: 'Coles', message: line.colesIncompleteNote });
    }
    if (line.woolIncomplete && line.woolIncompleteNote) {
      incompleteWarnings.push({ store: 'Woolworths', message: line.woolIncompleteNote });
    }
    if (line.aldiIncomplete && line.aldiIncompleteNote) {
      incompleteWarnings.push({ store: 'ALDI', message: line.aldiIncompleteNote });
    }

    if (!colesUsable && !woolUsable && !aldiUsable) continue;

    splitTotal += line.lineTotal;

    const entry = {
      request: line.request,
      product: line.chosenProduct,
      lineTotal: line.lineTotal,
      coles: line.coles,
      woolworths: line.woolworths,
      aldi: line.aldi,
      colesLinePrice: line.colesLinePrice,
      woolworthsLinePrice: line.woolworthsLinePrice,
      aldiLinePrice: line.aldiLinePrice,
      colesSingleStorePrice: line.colesSingleStorePrice,
      woolworthsSingleStorePrice: line.woolworthsSingleStorePrice,
      aldiSingleStorePrice: line.aldiSingleStorePrice,
      colesIncomplete: line.colesIncomplete,
      woolIncomplete: line.woolIncomplete,
      aldiIncomplete: line.aldiIncomplete,
      is_incomplete: line.is_incomplete,
    };

    if (line.chosenStore === 'Coles') {
      splitCart.coles.push(entry);
    } else if (line.chosenStore === 'Woolworths') {
      splitCart.woolworths.push(entry);
    } else if (line.chosenStore === 'ALDI') {
      splitCart.aldi.push(entry);
    }
  }

  colesOnlyTotal = Number(colesOnlyTotal.toFixed(2));
  woolworthsOnlyTotal = Number(woolworthsOnlyTotal.toFixed(2));
  aldiOnlyTotal = Number(aldiOnlyTotal.toFixed(2));
  splitTotal = Number(splitTotal.toFixed(2));

  const totals = { colesOnlyTotal, woolworthsOnlyTotal, aldiOnlyTotal, splitTotal };
  const bestPick = pickBestCartStrategy(totals);
  const recommendation = buildCartRecommendationMessage(bestPick, totals);

  return {
    colesOnlyTotal,
    woolworthsOnlyTotal,
    aldiOnlyTotal,
    splitTotal,
    splitCart,
    bestStrategy: bestPick.strategy,
    recommendedStore: bestPick.store,
    bestTotal: bestPick.total,
    isSplitWorthIt: bestPick.strategy === 'split',
    is_incomplete: incompleteWarnings.length > 0,
    colesOnlyIncomplete: incompleteWarnings.some((w) => w.store === 'Coles'),
    woolworthsOnlyIncomplete: incompleteWarnings.some((w) => w.store === 'Woolworths'),
    aldiOnlyIncomplete: incompleteWarnings.some((w) => w.store === 'ALDI'),
    incompleteWarnings,
    recommendation,
    savings: recommendation,
    savingsVsColes: recommendation.savingsVsColes,
    savingsVsWoolworths: recommendation.savingsVsWoolworths,
    savingsVsAldi: recommendation.savingsVsAldi,
    unresolved,
  };
}

const PRICE_COMPARE_EPS = 0.01;

/**
 * Pick cheapest cart strategy among single-store totals and multi-store split.
 * Prefer one-store when totals tie within PRICE_COMPARE_EPS.
 */
function pickBestCartStrategy(totals) {
  const { colesOnlyTotal, woolworthsOnlyTotal, aldiOnlyTotal, splitTotal } = totals;
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
  if (aldiOnlyTotal > 0) {
    candidates.push({ strategy: 'aldi_only', store: 'ALDI', total: aldiOnlyTotal });
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

/** Savings message for the winning cart strategy (3 supermarkets). */
function buildCartRecommendationMessage(bestPick, totals) {
  const { colesOnlyTotal, woolworthsOnlyTotal, aldiOnlyTotal, splitTotal } = totals;
  const empty = {
    message: '',
    amount: 0,
    percent: 0,
    comparedTo: null,
    savingsVsColes: { amount: 0, percent: 0 },
    savingsVsWoolworths: { amount: 0, percent: 0 },
    savingsVsAldi: { amount: 0, percent: 0 },
  };

  if (!bestPick?.strategy || bestPick.strategy === 'none') return empty;

  const singleStoreBaselines = [
    { store: 'Coles', total: colesOnlyTotal },
    { store: 'Woolworths', total: woolworthsOnlyTotal },
    { store: 'ALDI', total: aldiOnlyTotal },
  ].filter((row) => row.total > 0);

  const maxSingle = singleStoreBaselines.reduce(
    (max, row) => (row.total > max.total ? row : max),
    { store: null, total: 0 }
  );

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
    const percent =
      maxSingle.total > 0 ? Number(((amount / maxSingle.total) * 100).toFixed(1)) : 0;

    return {
      message:
        amount > 0
          ? `💡 Best for your wallet: split across Coles, Woolworths & ALDI and save $${amount.toFixed(2)} (${percent}%) vs buying everything at ${maxSingle.store}.`
          : '✨ Split cart matches the cheapest single-store total — any one store works!',
      amount,
      percent,
      comparedTo: maxSingle.store,
      savingsVsColes: savingsBlock(colesOnlyTotal, 'Coles'),
      savingsVsWoolworths: savingsBlock(woolworthsOnlyTotal, 'Woolworths'),
      savingsVsAldi: savingsBlock(aldiOnlyTotal, 'ALDI'),
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
      savingsVsAldi: savingsBlock(aldiOnlyTotal, 'ALDI'),
    };
  }

  return {
    message: `🛒 ${winner} has the best total for your whole list — one stop and you're done!`,
    amount: 0,
    percent: 0,
    comparedTo: null,
    savingsVsColes: savingsBlock(colesOnlyTotal, 'Coles'),
    savingsVsWoolworths: savingsBlock(woolworthsOnlyTotal, 'Woolworths'),
    savingsVsAldi: savingsBlock(aldiOnlyTotal, 'ALDI'),
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
      const score = scoreProductPair(woolItem, colesItem);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    });

    const pairThreshold =
      bestIndex >= 0 &&
      freshFoodCorePhraseMatch(woolItem.name, colesItems[bestIndex].name)
        ? FRESH_PAIR_SCORE_FLOOR - 0.02
        : SIMILARITY_THRESHOLD;

    if (bestIndex < 0 || bestScore <= pairThreshold) continue;

    usedColesIndexes.add(bestIndex);
    const colesItem = colesItems[bestIndex];
    const { cheaper, saving, compareBasis } = compareProductsForCheaper(
      woolItem,
      colesItem
    );

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
  if (payload == null) return null;

  if (typeof payload === 'string' || typeof payload === 'number') {
    const digits = String(payload).replace(/\D/g, '');
    return digits.length >= 3 ? digits : null;
  }

  const direct =
    payload.storeId ??
    payload.store_id ??
    payload.storeNo ??
    payload.storeNumber ??
    payload.StoreNumber ??
    payload.id;
  if (direct != null && String(direct).trim()) return String(direct).trim();

  const list =
    payload.stores ??
    payload.Stores ??
    payload.locations ??
    payload.Locations ??
    payload.results ??
    payload.data;
  if (Array.isArray(list) && list.length) {
    return extractStoreIdFromPayload(list[0]);
  }

  return null;
}

/** RapidAPI store locator (một endpoint, timeout ngắn — fallback sau locator công khai). */
async function tryRapidApiNearestStoreId(supermarket, location) {
  if (!RAPIDAPI_KEY) return null;

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
    return extractStoreIdFromPayload(response.data);
  } catch {
    return null;
  }
}

/** Resolve the nearest Coles store number via the public store-locator service. */
async function resolveColesStoreId(location) {
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
    const xml = String(response.data || '');
    const match =
      xml.match(/<StoreNo[^>]*>(\d+)<\/StoreNo>/i) ||
      xml.match(/<storeno[^>]*>(\d+)<\/storeno>/i);
    if (match) return match[1];
  } catch (error) {
    console.warn('  ⚠ Coles store locator failed:', error.message);
  }

  return tryRapidApiNearestStoreId('Coles', location);
}

/** Resolve the nearest Woolworths store number via the public proximity service. */
async function resolveWoolworthsStoreId(location) {
  const divisions = ['SUPERMARKETS', 'WOOLWORTHS', 'supermarkets'];
  const attempts = divisions.map((division) => {
    const url =
      `https://www.woolworths.com.au/storelocator/service/proximity/${division}` +
      `/latitude/${location.latitude}/longitude/${location.longitude}/range/25/max/3`;
    return axios
      .get(url, {
        timeout: STORE_LOCATOR_REQUEST_TIMEOUT_MS,
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      .then((response) => extractStoreIdFromPayload(response.data));
  });

  const results = await Promise.allSettled(attempts);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value;
  }

  return tryRapidApiNearestStoreId('Woolworths', location);
}

/** Tra cứu store ID (chưa cache) — gọi song song Coles + Woolworths. */
async function resolveNearestStoreIdsUncached(location) {
  const [colesStoreId, woolworthsStoreId] = await Promise.all([
    resolveColesStoreId(location),
    resolveWoolworthsStoreId(location),
  ]);
  return {
    colesStoreId,
    woolworthsStoreId,
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
        woolworthsStoreId: null,
        expiresAt: Date.now() + NEAREST_STORE_CACHE_TTL_MS,
      };
    })
    .then((entry) => {
      if (entry.colesStoreId || entry.woolworthsStoreId) {
        console.log(
          `  🏪 Nearest stores @ ${cacheKey}: Coles=${entry.colesStoreId || 'n/a'} | WW=${entry.woolworthsStoreId || 'n/a'}`
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
// 5b. HÀM GỌI COLES / WOOLWORTHS RAPIDAPI
// ============================================================

/** Gọi search API và trả về mảng sản phẩm thô (dùng cho khớp barcode) */
async function fetchStoreRawList(supermarket, keyword, opts = {}) {
  const query = String(keyword || '').trim();
  if (!query) return [];

  const fast = opts.fast === true;
  const location = getRequestLocation();
  const apiTimeout = fast ? COMPARE_API_TIMEOUT_MS : API_TIMEOUT_MS;
  const maxRetries = fast ? COMPARE_API_MAX_RETRIES : API_MAX_RETRIES;

  // ALDI — public catalog API (no RapidAPI / store-locator); same MongoDB cache key pattern.
  if (supermarket === 'ALDI') {
    const cached = await tryReadApiCache('ALDI', query, location);
    if (cached != null) {
      console.log(`  💾 ALDI cache hit: "${query}" @ ${buildLocationSegment(location)}`);
      return cached;
    }

    try {
      const rawList = await fetchAldiSearchRawList(query, RESULT_LIMIT, {
        timeoutMs: fast ? 10000 : undefined,
      });
      scheduleWriteApiCache('ALDI', query, rawList, location);
      return rawList;
    } catch (error) {
      console.warn('  ⚠ ALDI search failed (returning empty):', error?.message || error);
      const stale = await tryReadStaleApiCache('ALDI', query, location);
      if (stale?.length) {
        console.log(`  💾 ALDI stale cache fallback: "${query}"`);
        return stale;
      }
      logStoreSoftFail('ALDI', query, error, fast ? 10000 : API_TIMEOUT_MS);
      return [];
    }
  }

  if (!RAPIDAPI_KEY) {
    throw new Error(
      'RAPIDAPI_KEY is not configured. Add it to .env or Vercel environment variables.'
    );
  }

  const cached = await tryReadApiCache(supermarket, query, location);
  if (cached != null) {
    console.log(`  💾 ${supermarket} cache hit: "${query}" @ ${buildLocationSegment(location)}`);
    return cached;
  }

  let storeIds = opts.storeIds || { colesStoreId: null, woolworthsStoreId: null };
  if (!opts.storeIds && !fast) {
    try {
      storeIds = await resolveNearestStoreIds(location);
    } catch (storeErr) {
      console.warn(`  ⚠ Nearest store lookup failed (${supermarket}):`, storeErr.message);
    }
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
      // Production: Woolworths lỗi (timeout / block IP / 5xx) → [] — Coles/ALDI vẫn hiển thị
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
 * Mảng rỗng [] (không có croissant ở ALDI) KHÔNG được gán message lỗi mặc định.
 */
function buildCompareStoreErrors(colesError, woolworthsError, aldiError) {
  return {
    coles: colesError || null,
    woolworths: woolworthsError || null,
    aldi: aldiError || null,
  };
}

/** Khi API fail hết — vẫn trả ma trận 1 hàng trống để UI Compare by item hiện đúng 3 cột. */
function buildEmptyAlignedBlocksForKeywords(keywords) {
  return keywords.map((kw) => ({
    keyword: kw,
    matrixRows: [
      {
        rowIndex: 0,
        woolworths: null,
        coles: null,
        aldi: null,
        cheapestStore: null,
        rowSaving: 0,
        compareBasis: null,
      },
    ],
    similarPairCount: 0,
    storeCounts: { woolworths: 0, coles: 0, aldi: 0 },
  }));
}

// ============================================================
// 7. ENDPOINT CHÍNH: GET /api/compare?keyword=...
// ============================================================
/**
 * Gọi song song 3 siêu thị cho một từ khóa (Promise.allSettled).
 * Trả về danh sách thô từng cửa hàng + lỗi (nếu có).
 */
async function fetchAllStoresForKeyword(keyword) {
  const searchListItem = buildListItemForKeywordSearch(keyword);
  const location = getRequestLocation();
  const fastOpts = { fast: true };

  let storeIds = { colesStoreId: null, woolworthsStoreId: null };
  try {
    storeIds = await withTimeout(
      resolveNearestStoreIds(location),
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

  const safeFetchAldi = async () => {
    try {
      const result = await fetchStoreProducts('ALDI', keyword, searchListItem, fastOpts);
      return { items: result.items || [], error: null };
    } catch (error) {
      logStoreSoftFail('ALDI', keyword, error, COMPARE_API_TIMEOUT_MS);
      return { items: [], error: null };
    }
  };

  const [colesSettled, woolSettled, aldiSettled] = await Promise.allSettled([
    safeFetchColes(),
    safeFetchWoolworths(),
    safeFetchAldi(),
  ]);

  let colesItems = [];
  let woolworthsItems = [];
  let aldiItems = [];
  let colesError = null;
  let woolworthsError = null;
  let aldiError = null;

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

  if (aldiSettled.status === 'fulfilled') {
    aldiItems = aldiSettled.value.items;
    aldiError = aldiSettled.value.error;
    console.log(`  ALDI ("${keyword}"): ${aldiItems.length} products`);
  } else {
    aldiError = formatStoreError('ALDI', aldiSettled.reason);
  }

  return {
    keyword,
    searchListItem,
    colesItems,
    woolworthsItems,
    aldiItems,
    colesError,
    woolworthsError,
    aldiError,
  };
}

/**
 * Gọi song song cả 3 API; response gồm alignedRows (mỗi hàng = một từ khóa)
 * và items (danh sách phẳng, tương thích client cũ).
 */
app.get('/api/compare', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();

  if (!keyword) {
    return res.status(400).json({ error: 'Missing keyword parameter.' });
  }

  const location = getRequestLocation();
  const keywords = parseCompareKeywords(keyword);

  console.log(
    `\n🔎 Searching: ${keywords.map((k) => `"${k}"`).join(', ')} @ ${location.latitude}, ${location.longitude} (${location.source})`
  );

  if (!RAPIDAPI_KEY) {
    return res.status(503).json({
      error:
        'RAPIDAPI_KEY is not configured. Add it to .env (local) or Vercel environment variables.',
      storeErrors: { coles: null, woolworths: null, aldi: null },
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
      `Woolworths search timed out. ${routeErr.message}`,
      `ALDI search timed out. ${routeErr.message}`
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
    });
  }

  let colesItems = [];
  let woolworthsItems = [];
  let aldiItems = [];
  let colesError = null;
  let woolworthsError = null;
  let aldiError = null;
  const alignedRows = [];

  for (const block of perKeyword) {
    colesItems = mergeProductLists(colesItems, block.colesItems, RESULT_LIMIT * 3);
    woolworthsItems = mergeProductLists(
      woolworthsItems,
      block.woolworthsItems,
      RESULT_LIMIT * 3
    );
    aldiItems = mergeProductLists(aldiItems, block.aldiItems, RESULT_LIMIT * 3);

    if (block.colesError) colesError = block.colesError;
    if (block.woolworthsError) woolworthsError = block.woolworthsError;
    if (block.aldiError) aldiError = block.aldiError;

    alignedRows.push(
      buildAlignedCompareMatrix(
        block.keyword,
        block.searchListItem,
        block.woolworthsItems,
        block.colesItems,
        block.aldiItems
      )
    );
  }

  const hasAnySlot = alignedRows.some((block) =>
    block.matrixRows?.some((row) => row.woolworths || row.coles || row.aldi)
  );

  if (!hasAnySlot) {
    const storeErrors = buildCompareStoreErrors(colesError, woolworthsError, aldiError);
    return res.json({
      items: [],
      alignedRows: buildEmptyAlignedBlocksForKeywords(keywords),
      searchKeyword: keywords[0] || keyword,
      searchKeywords: keywords,
      similarPairs: [],
      storeErrors,
      error:
        colesError || woolworthsError || aldiError
          ? 'One or more stores could not be reached. Details are shown per store below.'
          : 'No products found. Check API keys, network, or try another keyword.',
    });
  }

  const combined = [...colesItems, ...woolworthsItems, ...aldiItems].sort(
    (a, b) => a.price - b.price
  );
  const similarPairs = buildSimilarPairs(woolworthsItems, colesItems);

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
    storeErrors: buildCompareStoreErrors(colesError, woolworthsError, aldiError),
  });
});

// ============================================================
// 7a. QUÉT BARCODE: GET /api/compare/barcode?barcode=...
// ============================================================
/**
 * Tìm sản phẩm theo mã vạch (không theo tên):
 * - Gọi search API với chuỗi barcode (WW/Coles hỗ trợ tìm theo barcode)
 * - Lọc kết quả có field barcode khớp chính xác
 */
app.get('/api/compare/barcode', async (req, res) => {
  const barcode = normalizeBarcode(req.query.barcode);

  if (!barcode || barcode.length < 8) {
    return res.status(400).json({
      error: 'Invalid barcode. Provide at least 8 digits.',
    });
  }

  const location = getRequestLocation();
  console.log(
    `\n📷 Barcode lookup: ${barcode} @ ${location.latitude}, ${location.longitude} (${location.source})`
  );

  const safeFetchRaw = async (supermarket) => {
    try {
      const rawList = await fetchStoreRawList(supermarket, barcode);
      const product = findProductByBarcodeInRawList(rawList, barcode, supermarket);
      return { product, error: null };
    } catch (error) {
      if (shouldSoftFailStoreRawList(supermarket)) {
        logStoreSoftFail(supermarket, barcode, error, COMPARE_API_TIMEOUT_MS);
        return { product: null, error: null };
      }
      const message = formatStoreError(supermarket, error);
      console.error(`  ❌ ${supermarket} barcode error:`, message);
      return { product: null, error: message };
    }
  };

  const [colesSettled, woolSettled, aldiSettled] = await Promise.allSettled([
    safeFetchRaw('Coles'),
    safeFetchRaw('Woolworths'),
    safeFetchRaw('ALDI'),
  ]);

  const colesResult =
    colesSettled.status === 'fulfilled'
      ? colesSettled.value
      : { product: null, error: formatStoreError('Coles', colesSettled.reason) };
  const woolResult =
    woolSettled.status === 'fulfilled'
      ? woolSettled.value
      : { product: null, error: formatStoreError('Woolworths', woolSettled.reason) };
  const aldiResult =
    aldiSettled.status === 'fulfilled'
      ? aldiSettled.value
      : { product: null, error: formatStoreError('ALDI', aldiSettled.reason) };

  const colesItem = colesResult.product;
  const woolItem = woolResult.product;
  const aldiItem = aldiResult.product;

  if (!colesItem && !woolItem && !aldiItem) {
    return res.status(404).json({
      error: 'No product found with this barcode at Coles, Woolworths, or ALDI.',
      scannedBarcode: barcode,
      storeErrors: {
        coles: colesResult.error,
        woolworths: woolResult.error,
        aldi: aldiResult.error,
      },
    });
  }

  const colesItems = colesItem ? [colesItem] : [];
  const woolworthsItems = woolItem ? [woolItem] : [];
  const aldiItems = aldiItem ? [aldiItem] : [];
  const combined = [...colesItems, ...woolworthsItems, ...aldiItems];

  const directPair = buildDirectComparePair(woolItem, colesItem);
  const similarPairs = directPair
    ? [directPair]
    : buildSimilarPairs(woolworthsItems, colesItems);

  console.log(
    `  ✅ Barcode hit | Coles: ${colesItem ? 'yes' : 'no'} | WW: ${woolItem ? 'yes' : 'no'} | ALDI: ${aldiItem ? 'yes' : 'no'}\n`
  );

  const alignedRows = [
    buildAlignedCompareMatrixFromProducts(barcode, woolItem, colesItem, aldiItem),
  ];

  res.json({
    items: combined,
    alignedRows,
    searchKeyword: barcode,
    similarPairs,
    scannedBarcode: barcode,
    searchMode: 'barcode',
    storeErrors: {
      coles: colesResult.error,
      woolworths: woolResult.error,
      aldi: aldiResult.error,
    },
  });
});

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

  try {
    if (openaiClient) {
      parsedItems = await parseShoppingListWithAI(prompt);
    } else {
      parseSource = 'fallback';
      parsedItems = parseShoppingListFallback(prompt);
    }
  } catch (error) {
    console.error('  ❌ Parse error:', error.message);
    return res.status(502).json({
      error: error.message || 'Could not parse shopping list.',
    });
  }

  if (!parsedItems.length) {
    return res.status(400).json({
      error: 'No items found in your list. Try clearer lines like "2 kg rice, 1 L milk".',
    });
  }

  console.log(`  📋 ${parsedItems.length} items (${parseSource})`);

  // Gọi song song tất cả món – mỗi món lại gọi song song Coles + Woolworths
  const lineResults = await Promise.all(
    parsedItems.map((item) => resolveListItem(item))
  );

  const optimization = buildCartOptimization(lineResults);

  console.log(
    `  ✅ Split $${optimization.splitTotal} | Coles $${optimization.colesOnlyTotal} | WW $${optimization.woolworthsOnlyTotal} | ALDI $${optimization.aldiOnlyTotal}\n`
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

  const exact = products.find(
    (p) => normalizeNameForMatch(p.name) === targetNorm
  );
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

    const colesProducts =
      colesSettled.status === 'fulfilled' ? colesSettled.value : [];
    const woolProducts =
      woolSettled.status === 'fulfilled' ? woolSettled.value : [];

    const colesMatch = findWatchlistProduct(colesProducts, entry);
    const woolMatch = findWatchlistProduct(woolProducts, entry);
    const primary = supermarket === 'Coles' ? colesMatch : woolMatch;

    if (colesMatch?.price != null) {
      await recordPriceHistoryPoint(entry.id, 'Coles', colesMatch.price, entry.name);
    }
    if (woolMatch?.price != null) {
      await recordPriceHistoryPoint(entry.id, 'Woolworths', woolMatch.price, entry.name);
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
app.get('/api/watchlist/price-history', async (req, res) => {
  const watchId = String(req.query.watchId || '').trim();
  if (!watchId) {
    return res.status(400).json({ error: 'Missing watchId query parameter.' });
  }

  try {
    const series = await getPriceHistoryForWatch(watchId);
    return res.json({ watchId, series });
  } catch (error) {
    console.error('  ❌ Price history error:', error.message);
    return res.status(500).json({
      error: error.message || 'Could not load price history.',
    });
  }
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(openaiClient),
    mongoConfigured: Boolean(MONGODB_URI),
    mongoConnected: Boolean(mongoDb),
    database: mongoDb ? mongoDbName : null,
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
    console.log(`🚀 SmartChoice đang chạy mượt mà tại: http://localhost:${PORT}`);
    initMongoForLocalStartup().catch((err) => {
      console.error('MongoDB startup connection failed:', err.message);
    });
  });
}

module.exports = app;
