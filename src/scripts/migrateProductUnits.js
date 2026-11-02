// One-off migration: every product created before the donalik/kilolik
// (piece vs. weight) feature has no `unit` field in Mongo yet. The schema
// default only applies when Mongoose hydrates a document in memory — it
// never gets backfilled into the stored document — so raw queries like
// `Product.find({ unit: 'kg' })` would silently miss these rows unless we
// write the field explicitly. Idempotent: safe to run more than once.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');

async function run() {
  await connectDB();
  const result = await Product.updateMany({ unit: { $exists: false } }, { $set: { unit: 'dona' } });
  console.log(`Updated ${result.modifiedCount} product(s) to unit: 'dona'.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed', err);
  process.exit(1);
});
