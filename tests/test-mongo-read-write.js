require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongo = require('../lib/mongodb');

(async () => {
  if (mongo.getConfiguredDatabaseName() !== 'shoppingsmart') {
    throw new Error(`Unexpected MongoDB database: ${mongo.getConfiguredDatabaseName()}`);
  }

  const db = await mongo.connectMongo({
    apiCacheCollection: 'api_cache',
    priceHistoryCollection: 'price_history',
  });
  if (!db) throw new Error('MongoDB connect failed');
  if (mongo.getDatabaseName() !== 'shoppingsmart') {
    throw new Error(`Connected to wrong database: ${mongo.getDatabaseName()}`);
  }

  const col = db.collection('api_cache');
  const testId = 'Woolworths:__cache_test__:-33.8688,151.2093';
  const now = new Date();

  await col.updateOne(
    { _id: testId },
    {
      $set: {
        supermarket: 'Woolworths',
        keyword: '__cache_test__',
        payload: [{ name: 'Test Item', price: 1 }],
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 3600000),
      },
    },
    { upsert: true }
  );

  const doc = await col.findOne({ _id: testId });
  console.log('WRITE+READ OK:', doc?.payload?.length, 'item(s)');

  await col.deleteOne({ _id: testId });
  console.log('DELETE OK — cơ chế ghi/đọc MongoDB hoạt động bình thường.');
  process.exit(0);
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
