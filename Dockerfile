# messaging-mcp in a container. Channels are configured through environment variables;
# with none set the server starts with every channel off (try --demo for sample data).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Optional webhook receiver for Meta channels: --webhook-port 8787
EXPOSE 8787
ENTRYPOINT ["node", "dist/index.js"]
