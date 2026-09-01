FROM node:20-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production || npm install --omit=dev

# Copy source code and ensure non-root file ownership
COPY src/ ./src/
RUN chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
