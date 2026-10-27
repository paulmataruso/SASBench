# SASBench — single container: SAS-CBSD protocol on HTTP (8000) and HTTPS/mTLS (8443),
# web UI + REST API on 8080. State (SQLite database, lab PKI, terrain tiles) lives in /data.

# ---- web UI build -------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- runtime ------------------------------------------------------------------
FROM node:24-alpine
# openssl: certificate / CRL / PKCS#12 operations of the lab PKI; tini: signal handling as PID 1.
RUN apk add --no-cache openssl tini
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/src ./server/src
COPY server/data ./server/data
COPY --from=web /build/web/dist ./web/dist
COPY THIRD_PARTY_NOTICES.md ./
# License texts for the runtime this image ships (referenced from THIRD_PARTY_NOTICES.md).
RUN mkdir -p licenses && apk list --installed > licenses/alpine-packages.txt \
 && node -e "fetch('https://raw.githubusercontent.com/nodejs/node/v' + process.versions.node + '/LICENSE').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then((t) => require('fs').writeFileSync('licenses/node-LICENSE', t))"

ENV NODE_ENV=production \
    SAS_DATA_DIR=/data \
    UI_PORT=8080
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 8000 8443

# Any HTTP answer from the UI port means the process is serving. Uses SAS_BIND_IP when the
# listeners are bound to one address.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const b=(process.env.SAS_BIND_IP||'').trim(),h=!b||b==='0.0.0.0'||b==='::'?'127.0.0.1':b.includes(':')?'['+b+']':b;fetch('http://'+h+':'+(process.env.UI_PORT||8080)+'/api/v1/health').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.ts"]
