# Comandia en Docker (para el VPS). Dos etapas: compila TypeScript y deja solo lo necesario para correr.
FROM node:22-bookworm-slim AS construir
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=construir /app/dist ./dist
COPY public ./public
COPY database ./database
COPY plantillas ./plantillas
RUN mkdir -p /datos/uploads && chown -R node:node /app /datos
USER node
ENV HOST=0.0.0.0 PORT=3000 UPLOADS_DIR=/datos/uploads CONFIAR_PROXY=true
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:3000/favicon.ico').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
