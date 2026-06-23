# Agent 配置指引

本目录下的扩展是 yuki-pi 的一部分，随 `pi install git:github.com/YukiagoTpf/yuki-pi` 自动加载，无需单独安装。
新电脑上只需配置好凭据和模型即可。以下按扩展分别说明。

## volcengine-agent-plan-usage-status

在 footer 显示火山方舟 Agent Plan 的 AFP 额度（5h / 日 / 周 / 月剩余百分比）。
选中 `volcengine/*` 或 baseUrl 含 `/api/plan/` 的模型时自动启用。

### 1. 配置模型

在 `~/.pi/agent/models.json` 的 `providers` 下加入 volcengine 提供方（示例只列必要字段）：

```json
{
  "providers": {
    "volcengine": {
      "name": "Volcano Engine",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
      "api": "openai-completions",
      "apiKey": "<Ark API Key，推理用>",
      "models": [
        {
          "id": "glm-5.2",
          "name": "GLM 5.2",
          "contextWindow": 1024000,
          "maxTokens": 4096,
          "input": ["text"],
          "reasoning": true
        }
      ]
    }
  }
}
```

推理用的 Ark API Key 可通过 pi 的 `/login` 存进 `~/.pi/agent/auth.json`（条目名 `volcengine`，`type: "api_key"`），
此时 `models.json` 的 `apiKey` 可留占位符。

### 2. 配置管控面 AK/SK（必须）

`GetAFPUsage` 是火山方舟**管控面 API**，走全局 OpenAPI 网关 `open.volcengineapi.com`，
**必须用 AK/SK 做 HMAC-SHA256 签名**，不接受 Bearer Ark API Key。

二选一：

**方式 A — 配置文件（推荐）**

写入 `~/.volc/config`：

```json
{
  "VOLC_ACCESSKEY": "<你的 Access Key ID>",
  "VOLC_SECRETKEY": "<你的 Secret Access Key>"
}
```

如有 STS 临时 token，加一行 `"VOLC_SESSION_TOKEN": "..."`。

**方式 B — 环境变量**

```bash
export VOLC_ACCESSKEY="<AK>"
export VOLC_SECRETKEY="<SK>"
```

AK/SK 获取：登录火山引擎主账号 → https://console.volcengine.com/iam/keymanage/ → 新建/查看访问密钥。

> 注意：子账号需有 ark 服务访问权限，否则会 401。

### 3. 命令

- `/volcengine-agent-plan-usage-reset-window` — 切换重置倒计时窗口（5h / daily / weekly / monthly）。

偏好存于 `~/.pi/agent/settings.json` 的 `pi-volcengine-agent-plan-usage` 键，首次运行自动写入默认值。

## codex-usage-status / opencode-go-usage-status

这两个扩展分别依赖各自的 OAuth / 凭据，与本目录的 volcengine 扩展无配置关联，按各自 README 段落配置即可。
