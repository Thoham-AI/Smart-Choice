/**
 * Kiểm tra cache MongoDB: đọc/ghi api_cache khi tìm kiếm.
 * Run: node scripts/verify-mongo-cache.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongo = require('../lib/mongodb');

const API_CACHE_COLLECTION = 'api_cache';

async function main() {
  const uri = mongo.getUri();
  if (!uri) {
    console.log('❌ MONGODB_URI chưa cấu hình — cache database bị tắt.');
    process.exit(1);
  }

  console.log('🔗 Đang kết nối MongoDB...');
  const db = await mongo.connectMongo({
    apiCacheCollection: API_CACHE_COLLECTION,
    priceHistoryCollection: 'price_history',
  });

  if (!db) {
    console.log('❌ Không kết nối được MongoDB (cooldown hoặc lỗi mạng).');
    process.exit(1);
  }

  const dbName = mongo.getDatabaseName();
  const col = db.collection(API_CACHE_COLLECTION);
  const total = await col.countDocuments();
  console.log(`✅ Database: ${dbName} | Collection: ${API_CACHE_COLLECTION} | Documents: ${total}`);

  const recent = await col
    .find({})
    .sort({ updatedAt: -1 })
    .limit(5)
    .project({
      _id: 1,
      supermarket: 1,
      keyword: 1,
      updatedAt: 1,
      expiresAt: 1,
      payloadCount: { $size: { $ifNull: ['$payload', []] } },
    })
    .toArray();

  if (!recent.length) {
    console.log('\n⚠️  Chưa có bản ghi cache nào.');
    console.log('   → Tìm kiếm lần đầu (có RAPIDAPI_KEY) sẽ ghi vào api_cache qua scheduleWriteApiCache().');
    console.log('   → Tìm kiếm lại cùng keyword + vị trí sẽ đọc từ MongoDB qua tryReadApiCache().');
  } else {
    console.log('\n📋 5 bản ghi cache mới nhất:');
    for (const doc of recent) {
      console.log(
        `  • ${doc.supermarket} | "${doc.keyword}" | ${doc.payloadCount} sản phẩm | cập nhật ${doc.updatedAt?.toISOString?.() || doc.updatedAt}`
      );
      console.log(`    _id: ${doc._id}`);
    }
  }

  const byStore = await col
    .aggregate([
      { $group: { _id: '$supermarket', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  console.log('\n📊 Theo siêu thị:', byStore.map((r) => `${r._id}: ${r.count}`).join(', ') || '(trống)');

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
