#!/usr/bin/env bash
#
# DorisMan GitHub 发布脚本（压缩历史推送）
#
# 为什么需要它：本地 main 分支含完整开发历史，早期提交中可能混入过敏感信息
# （如测试集群地址/密码，虽已清洗当前文件，但历史不可改写地存在）。
# 本脚本把当前源码快照打成【单 commit 的 github-main 分支】再 force 推送到
# origin/main，GitHub 上永远只有一份干净的压缩历史。
#
# 用法:
#   ./scripts/publish-github.sh                 # 以当前分支快照发布，默认提交信息
#   ./scripts/publish-github.sh "v0.2.0 更新"   # 自定义提交信息
#
set -euo pipefail
cd "$(dirname "$0")/.."

command -v git >/dev/null || { echo "ERROR: 未找到 git"; exit 1; }
git remote get-url origin >/dev/null 2>&1 || {
  echo "ERROR: 未配置 origin 远程（git remote add origin <url>）"; exit 1;
}

MSG="${1:-DorisMan 更新 $(date +%Y-%m-%d)}"
SRC_BRANCH=$(git rev-parse --abbrev-ref HEAD)
TMP_BRANCH="github-publish-tmp"

# --- 要求工作区干净 ---
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: 工作区有未提交的改动，请先 commit 或 stash。"
  git status --short
  exit 1
fi

echo "源分支   : $SRC_BRANCH"
echo "提交信息 : $MSG"
echo "==> 生成单 commit 快照分支 ..."

git branch -D "$TMP_BRANCH" >/dev/null 2>&1 || true
git checkout -q --orphan "$TMP_BRANCH"
git commit -q -m "$MSG"

# 切回源分支，再把临时分支改名为 github-main
git checkout -q "$SRC_BRANCH"
git branch -M -f "$TMP_BRANCH" github-main

echo "==> force 推送 github-main -> origin/main ..."
GIT_TERMINAL_PROMPT=0 git push -f origin github-main:main

echo
echo "✔ 已发布到 GitHub（单 commit 压缩历史，不携带本地开发历史）"
