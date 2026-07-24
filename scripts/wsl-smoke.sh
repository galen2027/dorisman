#!/usr/bin/env bash
# WSL 内冒烟测试 linux-x64 二进制（从 /mnt/c 读取最新发布包，全程在 /tmp 操作，结束后自清理）
set -e
# 可选：设置环境变量后追加真实集群连通测试（避免把集群地址/密码写进脚本）
#   DORIS_SMOKE_HOST=1.2.3.4 DORIS_SMOKE_PWD=xxx bash wsl-smoke.sh
DORIS_SMOKE_HOST="${DORIS_SMOKE_HOST:-}"
DORIS_SMOKE_PWD="${DORIS_SMOKE_PWD:-}"
TAR=$(ls -t /mnt/c/DevAIOps/dorismanweb/release/dorisman-web-v*-linux-x64.tar.gz | head -1)
echo "--- 测试包：$TAR ---"
cd /tmp
rm -rf dorisman-smoke && mkdir dorisman-smoke && cd dorisman-smoke
tar xzf "$TAR"
chmod +x bin/dorisman bin/start.sh bin/stop.sh
echo "--- 布局 ---"; ls -la; ls bin conf
echo "--- 环境 ---"
uname -m && ldd --version | head -1 && cat /etc/os-release | head -2

echo "--- --version ---"; ./bin/dorisman --version
PORT=8096 ./bin/start.sh
for i in $(seq 1 25); do curl -s http://localhost:8096/api/health >/dev/null 2>&1 && break; sleep 1; done
echo "--- health ---"; curl -s http://localhost:8096/api/health; echo
echo "--- 首页 ---"; curl -s -o /dev/null -w "HTTP=%{http_code}\n" http://localhost:8096/
echo "--- data/logs 目录（应在解压根目录） ---"; ls data logs
echo "--- 启动横幅 ---"; head -12 logs/dorisman.log

PWD0=$(cat data/INIT_ADMIN_PASSWORD.txt)
TOKEN=$(curl -s -X POST http://localhost:8096/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"$PWD0\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo "--- 登录 OK: ${TOKEN:0:8}... ---"
if [ -n "$DORIS_SMOKE_HOST" ] && [ -n "$DORIS_SMOKE_PWD" ]; then
  CID=$(curl -s -X POST http://localhost:8096/api/clusters -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"name\":\"WSL冒烟\",\"host\":\"$DORIS_SMOKE_HOST\",\"port\":9030,\"username\":\"admin\",\"password\":\"$DORIS_SMOKE_PWD\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or d)")
  echo "clusterId=$CID"
  echo "--- 测试连接 ---"; curl -s -X POST "http://localhost:8096/api/clusters/$CID/test" -H "Authorization: Bearer $TOKEN"; echo
  echo "--- catalogs ---"; curl -s "http://localhost:8096/api/c/$CID/catalogs" -H "Authorization: Bearer $TOKEN"; echo
  echo "--- users(截断) ---"; curl -s "http://localhost:8096/api/c/$CID/users" -H "Authorization: Bearer $TOKEN" | head -c 150; echo
else
  echo "--- 未设置 DORIS_SMOKE_HOST/DORIS_SMOKE_PWD，跳过真实集群连通测试 ---"
fi

./bin/stop.sh
echo "--- dorisman.log 末尾 ---"; tail -3 logs/dorisman.log || true
cd /tmp && rm -rf dorisman-smoke
echo "WSL_SMOKE_DONE"
