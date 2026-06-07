/**
 * MongoDB connection for Vercel serverless + local Express.
 * Caches client/db on globalThis so warm invocations reuse one pool.
 */
const { MongoClient } = require('mongodb');

const MONGO_CONNECT_TIMEOUT_MS = 2500;
const MONGO_COOLDOWN_MS = 90 * 1000;
const DEFAULT_DB_NAME = 'shoppingsmart';

/** @type {{ client: import('mongodb').MongoClient | null, db: import('mongodb').Db | null, dbName: string, connectPromise: Promise<import('mongodb').Db | null> | null, cooldownUntil: number, indexesReady: boolean }} */
const cache = global.__shoppingSmartMongo ?? {
  client: null,
  db: null,
  dbName: DEFAULT_DB_NAME,
  connectPromise: null,
  cooldownUntil: 0,
  indexesReady: false,
};
global.__shoppingSmartMongo = cache;

function getUri() {
  return String(process.env.MONGODB_URI || '').trim();
}

function isConfigured() {
  return Boolean(getUri());
}

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
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function ensureIndexes(db, { apiCacheCollection, priceHistoryCollection }) {
  if (cache.indexesReady) return;
  await db.collection(apiCacheCollection).createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'api_cache_ttl' }
  );
  await db.collection(apiCacheCollection).createIndex(
    { supermarket: 1, keyword: 1, updatedAt: -1 },
    { name: 'api_cache_keyword_lookup' }
  );
  await db.collection(priceHistoryCollection).createIndex(
    { watchId: 1, bucketMonth: -1 },
    { name: 'price_history_watch_month' }
  );
  await db.collection(priceHistoryCollection).createIndex(
    { watchId: 1, supermarket: 1 },
    { name: 'price_history_watch_store' }
  );
  cache.indexesReady = true;
}

function resetConnection() {
  cache.connectPromise = null;
  const client = cache.client;
  cache.client = null;
  cache.db = null;
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
  if (cache.db) return cache.db;
  if (cache.connectPromise) return cache.connectPromise;

  cache.connectPromise = withConnectTimeout(
    (async () => {
      cache.dbName = parseDatabaseNameFromUri(uri);
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
  parseDatabaseNameFromUri,
  MONGO_CONNECT_TIMEOUT_MS,
  MONGO_COOLDOWN_MS,
};
