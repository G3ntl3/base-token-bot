# ==============================================================================
# Base Token-Launch Bot Production Dockerfile
# ==============================================================================

FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install native build tools required by better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package specifications
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies for TypeScript build)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Compile TypeScript into dist/
RUN npm run build

# ==============================================================================
# Runner Stage (Clean & Lightweight)
# ==============================================================================
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install runtime dependencies for SQLite
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Copy built artifacts and dependencies
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create directory for SQLite persistence
RUN mkdir -p /app/data

# Persistent storage mount point for SQLite
VOLUME ["/app/data"]

# Start the bot
CMD ["npm", "start"]
