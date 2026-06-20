/**
 * MongoDB connection for Vercel serverless + local Express.
 * Caches client/db on globalThis so warm invocations reuse one pool.
 */
const { MongoClient } = require('mongodb');

const MONGO_CONNECT_TIMEOUT_MS = 8000;
const MONGO_COOLDOWN_MS = 90 * 1000;
const SHOPPINGSMART_DB_NAME = 'shoppingsmart';

/** @type {{ client: import('mongodb').MongoClient | null, db: import('mongodb').Db | null, dbName: string, connectPromise: Promise<import('mongodb').Db | null> | null, cooldownUntil: number, indexesReady: boolean }} */
const cache = global.__shoppingSmartMongo ?? {
  client: null,
  db: null,
  dbName: SHOPPINGSMART_DB_NAME,
  connectPromise: null,
  cooldownUntil: 0,
  indexesReady: false,
};
global.__shoppingSmartMongo = cache;

for (const legacyMongoGlobalKey of ['__smartChoiceMongo']) {
  if (global[legacyMongoGlobalKey] && global[legacyMongoGlobalKey] !== cache) {
    const legacyClient = global[legacyMongoGlobalKey].client;
    if (legacyClient) legacyClient.close().catch(() => {});
    delete global[legacyMongoGlobalKey];
  }
}

function getUri() {
  return String(process.env.MONGODB_URI || '').trim();
}

function isConfigured() {
  return Boolean(getUri());
}

function getConfiguredDatabaseName() {
  return SHOPPINGSMART_DB_NAME;
}

function isInCooldown() {
  return Date.now() < cache.cooldownUntil;
}

function enterCooldown() {
  cache.cooldownUntil = Date.now() + MONGO_COOLDOWN_MS;
}

function getDb() {
  return cache.db;
}

function getDatabaseName() {
  return cache.dbName;
}

function isConnected() {
  return Boolean(cache.db);
}

function withConnectTimeout(promise, ms, label) {
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

async function ensureIndexes(
  db,
  { apiCacheCollection, priceHistoryCollection, barcodeScanCollection }
) {
  if (cache.indexesReady) return;
  await db
    .collection(apiCacheCollection)
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'api_cache_ttl' });
  await db
    .collection(apiCacheCollection)
    .createIndex(
      { supermarket: 1, keyword: 1, updatedAt: -1 },
      { name: 'api_cache_keyword_lookup' }
    );
  await db
    .collection(priceHistoryCollection)
    .createIndex({ watchId: 1, bucketMonth: -1 }, { name: 'price_history_watch_month' });
  await db
    .collection(priceHistoryCollection)
    .createIndex({ watchId: 1, supermarket: 1 }, { name: 'price_history_watch_store' });
  await db
    .collection(priceHistoryCollection)
    .createIndex({ productId: 1, bucketMonth: -1 }, { name: 'price_history_product_month' });
  await db
    .collection(priceHistoryCollection)
    .createIndex({ barcode: 1, bucketMonth: -1 }, { name: 'price_history_barcode_month' });
  if (barcodeScanCollection) {
    await db
      .collection(barcodeScanCollection)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'barcode_scans_ttl' });
  }
  cache.indexesReady = true;
}

function resetConnection() {
  cache.connectPromise = null;
  const client = cache.client;
  cache.client = null;
  cache.db = null;
  cache.dbName = SHOPPINGSMART_DB_NAME;
  cache.indexesReady = false;
  if (client) {
    client.close().catch(() => {});
  }
}

/**
 * @param {{ apiCacheCollection: string, priceHistoryCollection: string }} indexCollections
 * @returns {Promise<import('mongodb').Db | null>}
 */
async function connectMongo(indexCollections) {
  const uri = getUri();
  if (!uri) return null;
  if (isInCooldown()) return null;
  if (cache.db && cache.dbName === SHOPPINGSMART_DB_NAME) return cache.db;
  if (cache.db && cache.dbName !== SHOPPINGSMART_DB_NAME) resetConnection();
  if (cache.connectPromise) return cache.connectPromise;

  cache.connectPromise = withConnectTimeout(
    (async () => {
      cache.dbName = getConfiguredDatabaseName();
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
        connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
        socketTimeoutMS: 12000,
        maxPoolSize: 10,
        minPoolSize: 0,
        maxIdleTimeMS: 10000,
        waitQueueTimeoutMS: 5000,
        retryWrites: true,
        retryReads: true,
      });
      await client.connect();
      // MONGODB_URI may still contain an old database path.
      // Always select the single application database explicitly.
      const db = client.db(cache.dbName);
      await db.command({ ping: 1 });
      if (indexCollections) {
        await ensureIndexes(db, indexCollections);
      }
      cache.client = client;
      cache.db = db;
      return db;
    })(),
    MONGO_CONNECT_TIMEOUT_MS,
    'MongoDB connect'
  );

  try {
    return await cache.connectPromise;
  } catch (error) {
    resetConnection();
    enterCooldown();
    throw error;
  }
}

module.exports = {
  connectMongo,
  enterCooldown,
  getDb,
  getDatabaseName,
  getUri,
  isConfigured,
  isConnected,
  isInCooldown,
  getConfiguredDatabaseName,
  MONGO_CONNECT_TIMEOUT_MS,
  MONGO_COOLDOWN_MS,
};
