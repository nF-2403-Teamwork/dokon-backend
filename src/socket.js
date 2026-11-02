const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const corsOrigins = require('./config/corsOrigins');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: corsOrigins } });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.user.market) {
      socket.join(`market:${socket.user.market}`);
    }
  });

  return io;
}

function emitToMarket(marketId, event, payload) {
  if (io) io.to(`market:${marketId}`).emit(event, payload);
}

module.exports = { initSocket, emitToMarket };
