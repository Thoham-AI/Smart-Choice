require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI missing');
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('smartchoice');
  const col = db.collection('site_stats');
  const id = 'page_views';

  let doc = await col.findOne({ _id: id });
  console.log('before:', doc);

  const result = await col.updateOne(
    { _id: id },
    { $inc: { views: 1 }, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
  console.log('update:', result);

  doc = await col.findOne({ _id: id });
  console.log('after:', doc);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
