# BotGathering MCP server (stdio). Zero runtime dependencies.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY recipes ./recipes
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "src/index.js"]
