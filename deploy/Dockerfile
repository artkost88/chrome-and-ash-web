FROM node:24-slim

WORKDIR /app

# server dependencies (express + ws, no native modules)
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

COPY server server
COPY chrome-and-ash-web chrome-and-ash-web

ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=development \
    CLIENT_DIR=/app/chrome-and-ash-web

WORKDIR /app/server
EXPOSE 3000
CMD ["node", "src/server.js"]
