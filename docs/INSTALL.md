# 安装与部署

本文是 `install.sh` 的详细说明，适合第一次部署或需要手动排查的人。

## 1. 服务器要求

| 项目 | 最低 | 推荐 |
|---|---|---|
| 系统 | Ubuntu 22.04 | Ubuntu 22.04 / 24.04 |
| CPU / 内存 | 1 核 / 1GB | 2 核 / 2GB |
| 磁盘 | 10GB | 20GB+ |
| 网络 | 能访问 GitHub / DeepSeek / NapCat 镜像 | 同上 |

> 1GB 内存的机器建议加 2GB swap，否则加载全部 Skill 时可能 OOM。

## 2. 端口

| 端口 | 用途 | 绑定 |
|---|---|---|
| 3210 | Web 工作台 | 127.0.0.1 |
| 3000 | NapCat HTTP | 127.0.0.1 |
| 3001 | NapCat WebSocket | 127.0.0.1 |
| 6099 | NapCat WebUI | 127.0.0.1 |

全部只监听本机，外网通过 SSH 隧道访问。

## 3. 一键安装

```bash
sudo bash install.sh
```

或非交互：

```bash
sudo QQ_ACCOUNT=123456789 \
     DEEPSEEK_API_KEY=sk-xxxx \
     bash install.sh
```

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `INSTALL_DIR` | `/opt/qq-agent` | 安装目录 |
| `PORT` | `3210` | 工作台端口 |
| `MODEL` | `deepseek-chat` | 默认模型 |
| `NAPCAT_IMAGE` | `mlikiowa/napcat-docker:latest` | NapCat 镜像 |
| `REPO_URL` | 本项目地址 | 源码地址 |
| `BRANCH` | `v1.1.0` | 源码分支/标签 |

## 4. 安装后首次登录

1. 本地开隧道：

```bash
ssh -L 6099:127.0.0.1:6099 -L 3210:127.0.0.1:3210 root@<服务器IP>
```

2. 浏览器打开 `http://127.0.0.1:6099/webui`，扫码登录机器人 QQ。
3. 打开 `http://127.0.0.1:3210/`，在设置里确认模型 Key 和 OneBot 地址。

如果 WebUI 打不开，看日志里的二维码：

```bash
docker logs -f napcat
```

## 5. 配置文件

`/opt/qq-agent/data/config.json`（权限 600）关键字段：

```json
{
  "api": {
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-...",
    "model": "deepseek-chat"
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "",
    "httpAccessToken": ""
  }
}
```

改完重启：

```bash
sudo systemctl restart qq-agent
```

## 6. 服务管理

```bash
sudo systemctl status qq-agent
sudo systemctl restart qq-agent
sudo journalctl -u qq-agent -f
```

## 7. 更新

```bash
cd /opt/qq-agent
sudo git fetch --tags
sudo git checkout v1.1.0
sudo npm install --omit=dev
sudo systemctl restart qq-agent
```

> Release 包安装的目录没有 `.git`，更新时重新下载 Release 覆盖代码即可，`data/` 不会被覆盖。

## 8. 卸载

```bash
sudo systemctl disable --now qq-agent
sudo docker rm -f napcat
sudo rm -rf /opt/qq-agent /opt/napcat
sudo userdel -r qqagent 2>/dev/null || true
```

## 9. 常见问题

### `npm install` 很慢

```bash
npm config set registry https://registry.npmmirror.com
```

### NapCat 镜像拉不下来

```bash
docker pull docker.m.daocloud.io/mlikiowa/napcat-docker:latest
docker tag docker.m.daocloud.io/mlikiowa/napcat-docker:latest mlikiowa/napcat-docker:latest
```

### 服务启动但 QQ 不回复

1. `docker ps | grep napcat` 确认容器在运行；
2. `docker logs -f napcat` 确认 QQ 已登录；
3. 打开工作台「设置 → OneBot」，确认 `ws://127.0.0.1:3001`；
4. 查看 `journalctl -u qq-agent -n 100` 是否有 OneBot 连接错误。

### 3210 打不开

工作台只绑定 `127.0.0.1`，必须用 SSH 隧道：

```bash
ssh -L 3210:127.0.0.1:3210 root@<服务器IP>
```

### 内存不足 / 自动重启

```bash
free -m
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 10. 备份

```bash
sudo tar czf /root/qq-agent-data-$(date +%F).tar.gz -C /opt/qq-agent data
```

恢复时解压回 `/opt/qq-agent/data`，权限保持 700。
