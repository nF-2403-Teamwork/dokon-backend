require('dotenv').config();
const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const { initSocket } = require('./socket');
const { initBot } = require('./services/telegram');
const { scheduleDailyMarketNotes } = require('./services/dailyMarketNotes');

const WEAK_SECRETS = new Set(['change-this-dev-secret', 'secret', '']);
if (!process.env.JWT_SECRET || WEAK_SECRETS.has(process.env.JWT_SECRET)) {
  console.error(
    'JWT_SECRET is missing or set to an insecure default. Set a strong secret in server/.env before starting (e.g. `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"`).'
  );
  process.exit(1);
}

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
initSocket(server);

connectDB()
  .then(async () => {
    await initBot();
    scheduleDailyMarketNotes();
    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  });
