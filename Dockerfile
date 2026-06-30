FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV RETURN_AUTOMATION_HOST=0.0.0.0
ENV RETURN_AUTOMATION_PORT=3206
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3206
CMD ["node", "src/server.js"]
