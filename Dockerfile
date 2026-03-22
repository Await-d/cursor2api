FROM metacubex/mihomo:latest AS mihomo

# ==== Stage 1: 构建阶段 (Builder) ====
FROM node:22-alpine AS builder

# 设置工作目录
WORKDIR /app

# 仅拷贝包配置并安装所有依赖项（利用 Docker 缓存层）
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝项目源代码并执行 TypeScript 编译
COPY copy-public.mjs ./
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ==== Stage 2: 生产运行阶段 (Runner) ====
FROM node:22-alpine AS runner

WORKDIR /app

# 设置为生产环境
ENV NODE_ENV=production

# 出于安全考虑，避免使用 root 用户运行服务
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 cursor && \
    mkdir -p /app/.cursor2api-airport && \
    chown -R cursor:nodejs /app

# 拷贝包配置并仅安装生产环境依赖（极大减小镜像体积）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# 从 builder 阶段拷贝编译后的产物
COPY --from=builder --chown=cursor:nodejs /app/dist ./dist

COPY --from=builder --chown=cursor:nodejs /app/src/public ./src/public

# 拷贝 Mihomo 二进制，供机场订阅桥接使用
COPY --from=mihomo /mihomo /usr/local/bin/mihomo

# 拷贝默认配置文件（可通过 volume 挂载覆盖）
COPY --chown=cursor:nodejs config.yaml ./config.yaml

# 切换到非 root 用户
USER cursor

# 声明对外暴露的端口
EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3010/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# 启动服务
CMD ["npm", "start"]
