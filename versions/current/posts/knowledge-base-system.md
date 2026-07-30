---
title: "个人知识库系统：Claude Code对话入库与AI总结管道"
date: 2026-07-15
description: "基于Python + Flask + Obsidian的个人知识库自动化系统，实现Claude Code会话导入、幂等写入、状态恢复、DeepSeek中文总结与质量门校验。"
category: "工具"
tags: ["Python","Flask","Obsidian","DeepSeek","知识库","工具"]
cover: "cover_2.jpg"
pinned: true
pinOrder: 25
draft: false
---

## 项目定位

以 Obsidian 为核心的个人知识库自动化系统。将 Claude Code 编程对话中的思考、方案和决策沉淀为可检索、可复盘、可长期维护的 Markdown 知识资产。技术栈：Python 3 + Flask + DeepSeek API + Obsidian + YAML frontmatter。

**一句话**：把 AI 编程对话中的隐性知识沉淀为结构化笔记，而非随着会话窗口关闭而丢失。

**整体架构**：

```text
Claude Code JSONL
        ↓
pipeline/sources/claude.py     ← 解析会话，只抽取可见 User/Assistant turns
        ↓
pipeline/transform.py           ← 转为标准化 Markdown + frontmatter
        ↓
pipeline/write.py              ← 幂等写入 Vault/70-AI-Chats/Claude
        ↓
pipeline/summary.py            ← 扫描原始笔记，调用 DeepSeek
        ↓
pipeline/summary_quality.py    ← 五字段校验 + 全文长度/格式门控
        ↓
pipeline/summary_write.py      ← 写入 Vault/100-AI总结/Claude
```

本地 Web 控制台（Flask）作为人工触发入口，通过 SSE 实时推送运行日志：

```text
watcher.py --web → web_console/app.py
    ├── 导入 Claude 原始对话
    └── 生成 AI 总结
```

---

## 一、Claude Code 对话导入

从 `~/.claude/projects` 下的 JSONL 会话文件中解析用户与 Claude 的可见对话，过滤工具调用、系统事件、CLI 内部记录和附件等内部数据。

导入时生成标准化 frontmatter：

```yaml
source: claude-code
source_id: "<project-slug>/<session-id>"
platform: claude
routing_dir: 70-AI-Chats/Claude
raw_hash: "<sha256>"
```

每一对 `source + source_id` 只对应一个 Markdown 笔记，重复导入时返回 `skipped`。

---

## 二、幂等写入与状态恢复

写入管道 `pipeline/write.py` 的核心保障机制：

- **幂等**：重复导入同一内容时检测哈希不变，直接跳过，不产生无意义的 Git 改动
- **原地更新**：原始对话内容变化时更新目标笔记，保留人工编辑区域（frontmatter 中 `## 人工整理` 之后的内容）
- **状态索引恢复**：当 `runtime/state/claude-note-index.json` 缺失时，从已有 frontmatter 反向匹配恢复
- **损坏隔离**：当状态索引文件损坏或 frontmatter 冲突时显式报错，而非静默生成重复资产
- **CRLF 兼容**：行尾差异不触发无意义改写

---

## 三、AI 中文总结管道

从 `Vault/70-AI-Chats/Claude` 读取原始 Markdown 笔记，只提取标题和可见 User/Assistant turns 构建模型输入，调用 DeepSeek OpenAI-compatible API 生成一对一总结：

```json
{
  "summary": "短摘要（≤500字）",
  "full_summary": "全文总结（≤2000字，纯自然段落）",
  "key_takeaways": ["关键结论1", "关键结论2"],
  "suggested_tags": ["python", "flask"],
  "suggested_links": ["[[相关笔记标题]]"]
}
```

总结笔记写入 `Vault/100-AI总结/Claude`，body 按固定顺序排列：摘要 → 全文总结 → 关键结论 → 标签建议 → 候选链接。

### 双层缓存策略

```python
# 输入指纹：标题 + 可见对话内容变化 → 重新调用 Provider
summary_input_hash = _hash(title + turns_json)

# 生成指纹：模型/ Prompt / Schema / 质量策略变化 → 重新调用 Provider
generation_fingerprint = _hash(json.dumps({
    "provider": provider_name,
    "model": model,
    "prompt_version": PROMPT_VERSION,
    "schema_version": SCHEMA_VERSION,
    "max_tokens": max_tokens,
    "quality_policy_version": quality_payload["version"],
    "quality_policy_signature": quality_sig,
}))
```

仅当两个指纹都匹配时跳过 Provider 调用，避免重复 API 开销。Prompt 升级时指纹自动失效，触发全量重生成。

---

## 四、质量门与安全边界

输出质量校验由 `pipeline/summary_quality.py` 统一执行，不依赖 Provider 自觉：

| 规则 | 处理方式 |
|---|---|
| 五字段 JSON 必须精确匹配协议 | `invalid_response`，重试 |
| 短摘要 > 500 字 | `invalid_response`，重试 |
| 全文总结 > 2000 字 | `invalid_response`，重试 |
| 全文总结含 Markdown 标题/列表/表格/代码块 | `invalid_response`，重试 |
| 输出含托管区标记 `<!-- KB-AUTO-START -->` 等注入 | `invalid_response`，重试 |
| 标签不匹配 `[a-z0-9-]{1,40}` | `invalid_response`，重试 |
| 空摘要直接拒绝 | `invalid_response`，重试 |

`max_attempts` 次内重试，单篇失败不影响同批次其他笔记。

安全边界：

- API Key 只从环境变量 `DEEPSEEK_API_KEY` 读取，不写入 YAML、源码或日志
- 错误事件按 12 种安全类别分类展示（`configuration / authentication / rate_limit / timeout / invalid_response / ...`），不暴露 prompt、请求体、SDK 原始异常或密钥
- 对话文本不作任何假设性提升，不自动写入正式知识字段或创建自动 `[[links]]`

---

## 五、本地 Web 控制台

基于 Flask + SSE 构建，运行在 `http://127.0.0.1:5000`：

- **导入 Claude**：触发 `watcher.py --scan-once`，扫描新会话并入库
- **生成 AI 总结**：扫描前一次导入产生的原始笔记，批量调用 DeepSeek 生成一对一总结
- **实时日志**：通过 SSE 推送开始、处理中、结果、错误、汇总、完成等结构化事件
- **并发控制**：服务端任务锁保证同一时间只有一个任务运行
- **错误面板**：按 12 种类别分类展示错误事件

---

## 六、测试体系

默认离线测试覆盖 Claude 解析、Markdown 渲染、幂等写入、状态恢复、summary provider、质量门与 Web summary 入口：

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
# 90 项通过
```

可选 DeepSeek 真实 API 测试需显式 opt-in：

```powershell
$env:RUN_DEEPSEEK_LIVE = "1"
$env:DEEPSEEK_API_KEY = "your-key"
python -m unittest integration_tests.deepseek_live -v
```

---

## 工程取舍

- 当前只支持 Claude Code 单数据源，先保证身份、幂等、恢复和人工确认边界稳定
- `70-AI-Chats` 是来源证据层，不直接作为正式知识层
- AI 总结输出是建议，不自动写入正式字段，也不自动创建正式 `[[links]]`
- Web 控制台仅面向本机，默认绑定 localhost
- Vault 中的真实个人知识资产不适合作为公开简历内容

---

## 项目解决的问题

AI 编程对话有三个痛点：**会话关闭后内容丢失**（几十轮对话中的方案、决策和踩坑经验随时间遗忘）、**人工整理成本高**（手动归纳总结费时且不一致）、**质量不可控**（AI 生成内容可能格式错误、注入标记或超长）。

本项目中：

- **导入管道**将 Claude Code JSONL 稳定转为标准化 Markdown 笔记，幂等写入避免重复
- **双层指纹缓存**确保内容不变时不重复调用 AI，Prompt 升级时自动失效触发重生成
- **质量门**在 Provider 输出后做第二道防线，五字段校验、全文长度/格式限制、标签格式检查，失败自动重试
- **状态恢复**防止索引损坏导致重复资产，人工编辑区始终保留
- **Web 控制台**提供两个按钮的零门槛操作入口，SSE 实时反馈运行状态
