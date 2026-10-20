FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ffmpeg curl ca-certificates fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# бесплатные ресурсы Poly Haven (текстуры, HDRI-небо, модели) — по списку assets/manifest.json
RUN node scripts/fetch-assets.mjs
# модель шумоподавления RNNoise для очистки голоса
RUN mkdir -p assets && curl -fsSL -o assets/rnnoise.rnnn \
    https://raw.githubusercontent.com/GregorR/rnnoise-models/master/beguiling-drafter-2018-08-30/bd.rnnn || true
ENV CHROMIUM_PATH=/usr/bin/chromium NODE_ENV=production
CMD ["node", "src/bot/bot.mjs"]
