FROM node:22-alpine

# Local OCR for reading ticket photos without sending them anywhere
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng

WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data

COPY package.json server.js ticket-reader.js ./
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
