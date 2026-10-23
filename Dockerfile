FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY stdio ./stdio
# No dependencies to install; the server is plain Node.js (>=18).
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "stdio/index.js"]
