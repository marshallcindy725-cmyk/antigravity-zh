# 词典格式说明

## 普通词条（module-*.json / core.json）

```json
{
  "New Conversation": "新建对话",
  "Search conversations...": "搜索对话..."
}
```

规则：
- **key 必须与界面英文逐字符一致**（包括省略号个数、括号、冒号）；
- key 使用**真实字符**；若你在源码里看到的是转义形式（如 `\u2026`），请还原为实际字符（`…`）再写——加载器会自动还原常见的 `\uXXXX` 形式，但直接写真实字符最稳；
- 单个英文单词（Save/Delete 等）**只参与 DOM 显示层**翻译，不会进入 JS 源替换层（安全设计，见 README）；
- 以 `//` 开头的键会被忽略，可作注释。

## 句式模式（patterns.json）

带动态数字/名称的句子用正则规则，**只对整节点文本完整匹配**：

```json
{
  "patterns": [
    { "re": "^(\\d+)m ago$", "result": "$1 分钟前" },
    { "re": "^Turn (\\d+) of (\\d+)$", "result": "第 $1 轮，共 $2 轮" }
  ]
}
```

`$1`、`$2` 为捕获组回填。

## 术语表（保持一致）

| English | 中文 |
|---|---|
| conversation | 对话 |
| workspace | 工作区 |
| project | 项目 |
| agent | Agent |
| subagent | 子代理 |
| coordinator | 协调者 |
| automation | 自动化 |
| skill | 技能 |
| rule | 规则 |
| hook | Hook |
| sidecar | sidecar（保留） |
| Best of N | Best of N（保留） |
| MCP / Model Context Protocol | MCP / 模型上下文协议 |
| staged / unstaged | 已暂存 / 未暂存 |
| worktree | 工作树 |
| quota | 配额 |
| credits | 额度 |
| tokens | Token |
| onboarding | 新手引导 |
| 专名（Antigravity、Git、GitHub、VS Code） | 保留英文（模型显示名统一在 `module-10-models.json` 维护） |
