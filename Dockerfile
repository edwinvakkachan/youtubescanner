FROM node:20-alpine

ENV NODE_ENV=production \
    YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp

WORKDIR /app

# Install yt-dlp in an isolated Python environment. The Python package provides
# ARM64-compatible wheels/releases through pip and does not require video codecs
# for metadata-only extraction.
RUN apk add --no-cache python3 py3-pip py3-virtualenv \
    && python3 -m virtualenv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip yt-dlp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

USER node
EXPOSE 3000

CMD ["npm", "start"]
