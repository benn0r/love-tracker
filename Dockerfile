FROM node:24.18.1-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY scripts ./scripts
COPY public ./public
COPY server.js ./
RUN npm run build

FROM node:24.18.1-alpine AS runtime

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/server.js ./server.js
COPY --from=build --chown=node:node /app/public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER node

CMD ["node", "server.js"]
