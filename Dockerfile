# ---------------------------------------------------------------
# SMART TOPOLOGY — Network Monitoring (NOC)
# Image ขนาดเล็ก (Alpine) · รันด้วยผู้ใช้ทั่วไป (ไม่ใช่ root)
# ---------------------------------------------------------------
FROM node:24-alpine

LABEL org.opencontainers.image.title="smart-topology" \
      org.opencontainers.image.description="Smart Topology NOC — ระบบเฝ้าระวังเครือข่ายและอุปกรณ์ (ICMP/TCP, Topology, MOPH Notify, MySQL log & reports)" \
      org.opencontainers.image.licenses="MIT"

# iputils = คำสั่ง ping ที่รายงานเวลาแม่นยำ, libcap-utils = ใช้ setcap, tzdata = เวลาประเทศไทย
# setcap ให้ ping ส่ง ICMP ได้โดยไม่ต้องเป็น root
RUN apk add --no-cache iputils tzdata libcap-utils \
 && PING="$(readlink -f "$(command -v ping)")" && setcap cap_net_raw+ep "$PING" && ping -V \
 && apk del libcap-utils \
 && mkdir -p /data && chown node:node /data

ENV TZ=Asia/Bangkok \
    NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

# ติดตั้งไลบรารี (mysql2) ก่อน เพื่อใช้ layer cache เมื่อแก้แค่โค้ด
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node sql ./sql
COPY --chown=node:node public ./public

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/login" || exit 1

CMD ["node", "server.js"]
