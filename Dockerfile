# --- Stage 1: Build & Dependency Resolution ---
FROM node:20-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production

# --- Stage 2: Minimalist Production Image ---
FROM node:20-alpine
WORKDIR /usr/src/app

# Pull only optimized runtime binaries from the builder image
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY server.js .
COPY package.json .

# Enforce secure non-root user behavior
USER node
EXPOSE 8080
ENV NODE_ENV=production

CMD ["node", "server.js"]