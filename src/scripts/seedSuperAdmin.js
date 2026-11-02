require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');

const NAME = process.env.SEED_ADMIN_NAME || 'Super Admin';
const USERNAME = process.env.SEED_ADMIN_USERNAME || 'superadmin';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'superadmin123';

async function seedSuperAdmin() {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ role: 'superadmin' });
  if (existing) {
    console.log(`Superadmin already exists (username: ${existing.username}). Skipping.`);
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const admin = await User.create({
    name: NAME,
    username: USERNAME,
    passwordHash,
    role: 'superadmin',
    market: null,
    active: true,
  });

  console.log(`Superadmin created: username="${admin.username}"`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log('Using default password "superadmin123" — change it after first login.');
  }
  await mongoose.disconnect();
}

seedSuperAdmin().catch((err) => {
  console.error('Failed to seed superadmin', err);
  process.exit(1);
});
