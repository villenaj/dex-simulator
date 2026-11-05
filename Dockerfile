FROM node:24-slim

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENTRYPOINT ["node_modules/.bin/tsx", "src/index.ts"]
CMD ["live"]
