#!/usr/bin/env bash
#
# DorisMan 一键发版脚本
#
# 用法:
#   ./release.sh                 # 补丁版本 +1 (0.1.0 -> 0.1.1)，默认
#   ./release.sh minor           # 次版本 +1 (0.1.0 -> 0.2.0)
#   ./release.sh major           # 主版本 +1 (0.1.0 -> 1.0.0)
#   ./release.sh --skip-build    # 跳过前端构建与后端 bundle（源码无改动时）
#   ./release.sh --skip-push     # 只提交与打包，不推送远程
#   ./release.sh --dry-run       # 只打印计划，不做任何修改
#
# 流程: 递增两处版本号（package.json / server/src/config.js）
#       -> 提交 -> 打 tag -> 构建前端 + bundle 后端（注入构建时间）
#       -> pkg 打 linux/win 二进制 -> tar.gz 发布包 -> 推送 main 和 tag
# 说明: scripts/package.js 的版本号直接读 package.json，无需单独维护；
#       单独执行 node scripts/package.js 时会默认 patch+1（--no-bump 保持，
#       --version=x.y.z 指定），release.sh 已递增故传 --no-bump。
#
set -euo pipefail
cd "$(dirname "$0")"

# --- 工具链（兼容本机常见安装位置） ---
export PATH="$PATH:/c/Program Files/nodejs"
export PATH="$PATH:/c/Users/luosh/AppData/Roaming/kimi-desktop/daimon-share/daimon/npm-global"
command -v git  >/dev/null || { echo "ERROR: 未找到 git"; exit 1; }
command -v node >/dev/null || { echo "ERROR: 未找到 node"; exit 1; }
command -v npm  >/dev/null || { echo "ERROR: 未找到 npm"; exit 1; }

ROOT_PKG="package.json"
SERVER_CONFIG="server/src/config.js"
BUMP="patch"
SKIP_BUILD=0
SKIP_PUSH=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --skip-build)      SKIP_BUILD=1 ;;
    --skip-push)       SKIP_PUSH=1 ;;
    --dry-run)         DRY_RUN=1 ;;
    *) echo "用法: $0 [patch|minor|major] [--skip-build] [--skip-push] [--dry-run]"; exit 2 ;;
  esac
done

# --- 从根 package.json 读取当前版本号 ---
CUR=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\(.*\)".*/\1/p' "$ROOT_PKG" | head -1)
[ -n "$CUR" ] || { echo "ERROR: 无法从 $ROOT_PKG 读取 version"; exit 1; }

IFS=. read -r MAJ MIN PAT <<<"$CUR"
case "$BUMP" in
  patch) PAT=$((PAT + 1)) ;;
  minor) MIN=$((MIN + 1)); PAT=0 ;;
  major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
esac
NEW="$MAJ.$MIN.$PAT"
TAG="v$NEW"

echo "当前版本 : $CUR"
echo "递增方式 : $BUMP"
echo "新版本   : $NEW (tag $TAG)"

# --- tag 冲突检查 ---
if [ "$SKIP_PUSH" -eq 0 ] && GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "ERROR: $TAG 已存在于远程仓库（已经发布过）。如需重发，请先删除远程 tag。"
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "ERROR: 本地已存在标签 $TAG，请先 git tag -d $TAG 或换递增级别。"
  exit 1
fi

# --- 要求工作区干净 ---
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: 工作区有未提交的改动，请先 commit 或 stash。"
  git status --short
  exit 1
fi

BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "[dry-run] 将执行以下步骤（未做任何修改）:"
  echo "  1. 版本号 -> $NEW : $ROOT_PKG / $SERVER_CONFIG"
  echo "  2. git commit: chore(release): $TAG"
  echo "  3. git tag: $TAG"
  if [ "$SKIP_BUILD" -eq 0 ]; then echo "  4. npm run build（vite + esbuild bundle）"; else echo "  4. (跳过构建)"; fi
  echo "  5. node scripts/package.js --no-bump -> release/ 二进制 + tar.gz"
  if [ "$SKIP_PUSH" -eq 0 ]; then echo "  6. git push origin main + $TAG"; else echo "  6. (跳过推送)"; fi
  exit 0
fi

# 1. 递增两处版本号（scripts/package.js 运行时读 package.json，无需改）
sed -i "s/^\([[:space:]]*\"version\":[[:space:]]*\)\".*\"/\1\"$NEW\"/" "$ROOT_PKG"
grep -q "\"version\": \"$NEW\"" "$ROOT_PKG" || { echo "ERROR: $ROOT_PKG 版本号写入失败"; exit 1; }

sed -i "s/^const VERSION = '.*';/const VERSION = '$NEW';/" "$SERVER_CONFIG"
grep -q "const VERSION = '$NEW';" "$SERVER_CONFIG" || { echo "ERROR: $SERVER_CONFIG 版本号写入失败"; exit 1; }

# 2. 提交版本号
git add "$ROOT_PKG" "$SERVER_CONFIG"
git commit -m "chore(release): $TAG"
GIT_COMMIT=$(git log -n 1 --format=%h)

# 3. 打 tag
git tag -a "$TAG" -m "DorisMan $TAG"

# 4. 构建前端 + bundle 后端
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> 构建前端并 bundle 后端 ..."
  npm run build
fi

# 5. pkg 打包 + tar.gz 发布包（--no-bump：版本号已在本脚本第 1 步递增）
echo "==> 打包 release/ ..."
node scripts/package.js --no-bump

# 6. 推送（release/ 与 dist/ 在 .gitignore 内，产物不入库，仅本地留存）
if [ "$SKIP_PUSH" -eq 0 ]; then
  echo "==> 推送 main 和 $TAG ..."
  GIT_TERMINAL_PROMPT=0 git push origin main
  GIT_TERMINAL_PROMPT=0 git push origin "$TAG"
fi

echo
echo "✔ 发版完成: $TAG (commit $GIT_COMMIT, 构建时间 $BUILD_TIME UTC)"
echo "  发布包: $(pwd)/release/dorisman-web-v$NEW-linux-x64.tar.gz"
