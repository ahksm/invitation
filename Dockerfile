FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY public ./public
# Исходники дизайна: сервер собирает из них фронтенд при старте (React и qrcode берутся из node_modules).
COPY web ./web
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
