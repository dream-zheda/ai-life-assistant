# syntax=docker/dockerfile:1
#
# ⚠️ 这个 Dockerfile 没有在本机实测过（开发机没有 Docker，见 ADR-001）。
# 首次在云服务器上部署时，请按 docs/runbook.md 的「首次部署」逐条验证，
# 不要假设它一定能构建成功。

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# 依赖层：只复制清单文件，最大化缓存命中
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/channels/package.json packages/channels/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/planning/package.json packages/planning/package.json
COPY packages/db/package.json packages/db/package.json
# 容器内可以正常跑安装脚本（本机受限的那套 --ignore-scripts 不需要带进来）
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 构建层：生成 Prisma Client + 构建 Next
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm db:generate
RUN pnpm --filter @life/web build

# ---------------------------------------------------------------------------
# 迁移：一次性容器，跑完即退出
# ---------------------------------------------------------------------------
FROM build AS migrate
CMD ["pnpm", "exec", "prisma", "migrate", "deploy", "--schema", "packages/db/prisma/schema.prisma"]

# ---------------------------------------------------------------------------
# Next 运行
# ---------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app ./
WORKDIR /app/apps/web
EXPOSE 3100
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-p", "3100"]

# ---------------------------------------------------------------------------
# worker 运行
# ---------------------------------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app ./
WORKDIR /app
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
