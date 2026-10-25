# --- Build stage ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json main.ts cli.ts ./
COPY src ./src
RUN pnpm exec tsc -p . && pnpm prune --prod

# --- Runtime stage ---
FROM node:24-bookworm-slim
# Dates are formatted in the server's local time, so pin it to Singapore
# ffmpeg converts GIFs to mp4, reads the first frame of GIFs/videos for the vision model, and makes Baileys' video thumbnails
# poppler-utils reads PDFs: text (pdftotext), pages as images (pdftoppm), embedded images (pdfimages)
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ffmpeg poppler-utils && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    TZ=Asia/Singapore
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The system prompt is read from src/static at runtime
COPY src/static ./src/static

# assets/ holds the Google Calendar credentials and stickers, mount it in.
# Environment variables (.env) should be passed with --env-file.
VOLUME ["/app/assets"]

# Scan the WhatsApp login QR code from `docker logs -f <container>` (or `docker attach`).
CMD ["node", "dist/main.js"]
