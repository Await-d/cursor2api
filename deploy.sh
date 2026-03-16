#!/bin/bash
set -euo pipefail

MODE="${1:-pm2}"

wait_for_service_health() {
    local service="$1"
    local retries="${2:-30}"
    local sleep_seconds="${3:-2}"
    local container_id=""

    for ((attempt=1; attempt<=retries; attempt++)); do
        container_id="$("${COMPOSE_CMD[@]}" ps -q "$service" 2>/dev/null || true)"
        if [[ -z "$container_id" ]]; then
            sleep "$sleep_seconds"
            continue
        fi

        local status
        status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"

        if [[ "$status" == "healthy" || "$status" == "running" ]]; then
            echo "[健康检查] 服务 $service 已就绪（$status）"
            return 0
        fi

        sleep "$sleep_seconds"
    done

    echo "[健康检查] 服务 $service 未在预期时间内进入 healthy 状态。"
    if [[ -n "$container_id" ]]; then
        docker inspect --format '{{json .State.Health}}' "$container_id" 2>/dev/null || true
    fi
    return 1
}

if [[ "$MODE" == "docker" || "$MODE" == "--docker" ]]; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "[环境检测] 未找到 docker，请先安装 Docker Engine / Docker Desktop。"
        exit 1
    fi

    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD=(docker compose)
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_CMD=(docker-compose)
    else
        echo "[环境检测] 未找到 docker compose / docker-compose。"
        exit 1
    fi

    echo "=========================================="
    echo "    Cursor2API Docker 部署"
    echo "=========================================="
    echo "正在校验 Compose 配置并重建容器..."

    "${COMPOSE_CMD[@]}" config >/dev/null
    "${COMPOSE_CMD[@]}" up -d --build --force-recreate --remove-orphans

    echo ""
    echo "等待服务健康检查通过..."
    mapfile -t SERVICES < <("${COMPOSE_CMD[@]}" config --services)
    for service in "${SERVICES[@]}"; do
        wait_for_service_health "$service"
    done

    echo ""
    echo "当前服务状态："
    "${COMPOSE_CMD[@]}" ps
    echo ""
    echo "常用 Docker 管理命令："
    echo "▶ 查看日志：        ${COMPOSE_CMD[*]} logs -f --tail=200"
    echo "▶ 重新部署代码：    ${COMPOSE_CMD[*]} up -d --build --force-recreate"
    echo "▶ 仅重启读取配置：  ${COMPOSE_CMD[*]} restart"
    echo "=========================================="
    exit 0
fi

echo "=========================================="
echo "    Cursor2API Linux 一键部署服务包"
echo "=========================================="
echo "正在检测 Linux 环境并开始部署..."

# 1. 检查并安装 Node.js (v20)
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "[环境检测] 未找到 Node.js，准备开始安装 (基于 NodeSource，适用于 Ubuntu/Debian/CentOS)..."
    if ! command -v curl >/dev/null 2>&1; then
        echo "正在安装基础工具 curl..."
        if command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update && sudo apt-get install -y curl
        elif command -v yum >/dev/null 2>&1; then
            sudo yum install -y curl
        fi
    fi
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y nodejs
    elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y nodejs
    fi
    echo "[环境检测] Node.js 安装完成: $(node -v) / npm: $(npm -v)"
else
    echo "[环境检测] Node.js 已安装: $(node -v) / npm: $(npm -v)"
fi

# 2. 检查并安装 PM2
if ! command -v pm2 >/dev/null 2>&1; then
    echo "[环境检测] 未找到 pm2，准备通过 npm 自动安装全局依赖..."
    sudo npm install -g pm2
    echo "[环境检测] pm2 安装完成: $(pm2 -v)"
else
    echo "[环境检测] pm2 已安装: $(pm2 -v)"
fi

# 3. 安装依赖与构建
echo "[项目构建] 开始安装生产级项目依赖..."
npm install

echo "[项目构建] 正在编译 TypeScript 代码 (npm run build)..."
npm run build

# 4. 配置 PM2 进程
echo "[项目部署] 正在清理旧的 PM2 进程（如果有的话）..."
pm2 delete cursor2api 2>/dev/null || true

# 5. 启动项目
echo "[项目部署] 使用 PM2 守护进程启动服务..."
# 设置生产环境变量
NODE_ENV=production pm2 start dist/index.js --name "cursor2api" 

# 6. 保存并且处理自启
echo "[项目部署] 配置 PM2 保存以便意外重启后恢复..."
pm2 save

echo "=========================================="
echo "部署与运行全部完成！🚀"
echo ""
echo "常用 PM2 管理命令："
echo "▶ 查看运行日志：  pm2 logs cursor2api"
echo "▶ 查看进程监控：  pm2 monit"
echo "▶ 重启服务：      pm2 restart cursor2api"
echo "=========================================="
