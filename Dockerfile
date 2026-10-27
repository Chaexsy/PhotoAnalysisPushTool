FROM kasmweb/chrome:1.16.0_zspace_1.8

USER root
ENTRYPOINT []

WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev --offline --no-audit --no-fund

ENV NODE_ENV=production
ENV PORT=8787
ENV XHS_BROWSER_PATH=/opt/google/chrome/chrome
EXPOSE 8787
VOLUME ["/photos", "/data"]
CMD ["node", "dist/index.js"]
