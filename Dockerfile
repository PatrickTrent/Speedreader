FROM node:22-slim

WORKDIR /app

RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error('Node >= 22.13 required, got ' + process.versions.node); process.exit(1); }"

COPY package.json package-lock.json ./
RUN npm ci

COPY server.js index.html index.tsx App.tsx vite.config.ts tsconfig.json tailwind.config.js metadata.json Dockerfile .dockerignore ./
COPY lib ./lib
COPY public ./public
COPY src ./src
COPY test ./test
COPY DEPLOY.md README.md ./
RUN npm run build && npm test && npm prune --omit=dev

ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node","server.js"]
