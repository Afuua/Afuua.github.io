---
title: "医疗RAG系统：从文档到可追溯问答的全链路工程实践"
date: 2026-06-24
description: "基于Spring Boot + Spring AI的医学循证RAG后端，涵盖文档清洗Pipeline、四策略切片、多向量库隔离、七类意图Prompt编排、文档去重与版本识别、RAGAS评估治理。"
category: "后端"
tags: ["RAG", "Spring Boot", "Spring AI", "DeepSeek", "向量检索", "后端"]
pinned: true
pinOrder: 30
draft: false
---

## 项目定位

面向执业医师的医学循证 RAG 后端系统。将 PDF、Word、TXT、Markdown、HTML 等医学资料导入知识库，经过清洗、切片、向量化、召回、Rerank 和 LLM 编排后，为医生提供带引用来源的辅助问答，并支持完整的评估闭环。

**技术栈**：Java 17 / Spring Boot 3 / Spring AI / MyBatis-Plus / MySQL / Apache Tika / Ollama bge-m3 / DashScope qwen3-rerank / DeepSeek Chat / SimpleVectorStore

**整体架构**：

```text
医学文档 → Tika解析 → 清洗Pipeline → 多策略切片 → Embedding向量化
→ 多向量库隔离存储 → 多查询召回 → Rerank重排序 → 医学Prompt编排
→ LLM回答 → 引用溯源与审计日志 → RAG评估
```

---

## 一、文档导入与清洗

### 多格式解析

基于 Apache Tika 统一解析 PDF、Word、TXT、Markdown、HTML 等格式，将异构文档转为纯文本进入下游清洗管道。

### 可组合清洗流水线

所有清洗器实现统一接口，Spring 自动注入后按 `order` 排序后链式执行：

```java
public MedicalDocumentCleanPipeline(List<MedicalDocumentCleaner> cleaners) {
    this.cleaners = cleaners.stream()
        .sorted(Comparator.comparingInt(MedicalDocumentCleaner::order))
        .toList();
}
```

清洗器清单：

| 清洗器 | 职责 |
|---|---|
| TextNormalizeCleaner | 统一换行符、去除不可见字符、全角半角转换 |
| PrivacyCleaner | 识别并脱敏姓名、身份证号、电话号码 |
| DuplicateLineCleaner | 基于内容指纹去重，保留首次出现位置 |
| BoilerplateCleaner | 去除页眉页脚、期刊版权声明等固定模板 |
| TableNoiseCleaner | 清洗表格中的合并单元格和空行噪声 |
| MedicalSectionCleaner | 识别医学文献的章节结构 |
| ReferenceSectionCleaner | 将文末参考文献独立抽取，不参与向量化 |

管道支持配置化开关和门控：

```java
// 清洗比例过高 → 告警；清洗后过短 → 拒绝导入
if (result.deleteRatio() > maxDeleteRatio) { log.warn(...); }
if (result.cleanedLength() < minContentLength) {
    throw new IllegalStateException("清洗后正文过短，无法导入");
}
```

**工程价值**：减少无效文本进入向量库，参考文献存为独立内容避免污染回答上下文，清洗异常可追溯。

---

## 二、多策略切片

通过策略模式 + 工厂路由实现四种切片策略，按枚举分发：

```java
public enum ChunkStrategy {
    STRUCTURED,  // 结构化切片：按章节/中文编号标题切分
    HEADING,     // Markdown标题切片：按 # / ## / ### 层级
    RECURSIVE,   // 递归降级：\n\n→\n→。→.→空格 逐级尝试
    SEMANTIC     // 语义切片：相邻句Embedding余弦相似度
}

// 工厂路由
public MedicalTextSplitter create(ChunkStrategy strategy, int chunkSize,
                                   int chunkOverlap, EmbeddingModel embeddingModel) {
    MedicalTextSplitterFactory factory = factories.get(strategy);
    if (factory == null) throw new IllegalArgumentException("不支持的切片策略: " + strategy);
    return factory.create(chunkSize, chunkOverlap, embeddingModel);
}
```

**优化点**：
- 语义切片增加批量 Embedding，降低调用开销
- 语义切片失败自动回退递归切片
- 修正语义 overlap 过大的问题，避免切片重复和向量污染

---

## 三、多向量库与知识库隔离

支持按知识库动态选择 EmbeddingModel、VectorStore 和命名空间，向量库支持 Simple / Redis / Qdrant / Milvus 四种后端。实现多知识库数据隔离，支持本地开发和生产环境不同向量库。

---

## 四、RAG 编排链路

核心入口 `MedicalRagService.diagnose()`：

```java
public DiagnoseResponse diagnose(Long doctorId, Long knowledgeId,
                                 Long modelId, String patientQuery) {
    // 1. 验证知识库状态
    knowledgeService.validateEnabledKnowledge(knowledgeId);

    // 2. 意图分类（7类）
    MedicalQueryIntent intent = queryPlanner.classify(patientQuery);

    // 3. Query改写
    String rewrittenQuery = rewriteQuery(chatModel, patientQuery);

    // 4. 多查询生成 + 检索
    List<String> queries = queryPlanner.buildRetrievalQueries(intent, patientQuery, rewrittenQuery);
    List<SearchResult> allResults = new ArrayList<>();
    for (String q : queries) {
        allResults.addAll(searchService.search(knowledgeId, q, null, null));
    }

    // 5. 按segmentId合并去重（保留高分）
    allResults = deduplicateBySegmentId(allResults);

    // 6. 构建医学Prompt → LLM生成
    String prompt = promptBuilder.build(intent, patientQuery, allResults);
    ChatResponse response = chatModel.call(new Prompt(prompt));

    // 7. 构建引用 + 保存审计日志
    List<Citation> citations = buildCitations(allResults);
    saveQueryLog(...);
    return result;
}
```

### 七类意图分类

```java
public MedicalQueryIntent classify(String query) {
    if (containsAny(q, "剂量","用量","禁忌","不良反应")) return DRUG_USAGE;
    if (containsAny(q, "治疗","方案","处理","干预"))    return TREATMENT;
    if (containsAny(q, "指南","共识","推荐"))           return GUIDELINE;
    if (containsAny(q, "机制","为什么","病理"))          return MECHANISM;
    if (containsAny(q, "检查","指标","化验","ct","mri")) return EXAMINATION;
    if (containsAny(q, "诊断","鉴别","可能是什么"))       return DIAGNOSIS;
    return GENERAL_QA;
}
```

每类意图不仅决定检索 query 的扩展方向（如诊断类追加"鉴别诊断 诊断标准"、治疗类追加"治疗方案 推荐"），还决定 Prompt 的输出格式模板。

### 医学 Prompt 构造

```java
public String build(MedicalQueryIntent intent, String patientQuery,
                    List<SearchResult> results) {
    return String.format("""
        你是一个医疗文献辅助系统，为执业医师提供基于循证医学的信息支持。

        ## 角色约束
        1. 不提供最终诊断，只整理相关医学文献信息。
        2. 每一条关键陈述必须标明来源 [文献片段 N]。
        3. 检索结果不足以回答时明确说明证据缺口，不要编造。

        ## 问题类型：%s
        ## 医生查询：%s
        ## 检索文献片段：%s
        ## 回答格式：%s
        """, intent.label(), patientQuery, buildContext(results), outputFormat(intent));
}
```

每条文献片段标注证据类型（诊断/治疗/用药/检查/指南/通用，自动推断）、来源元数据（PMID、DOI、期刊、年份、章节标题）。

### 引用溯源

```java
Citation {
    segmentId, documentId, title, pmid, doi,
    authors, journal, publishYear, sectionTitle,
    snippet (≤200字), score
}
```

生成的回答中所有关键陈述标注 `[文献片段 N]` 来源，医生可追溯到具体文献和章节。

---

## 五、文档去重与版本识别

三类标识实现精确去重：

- `file_hash`：原始文件哈希，识别完全相同文件 → `DUPLICATE_FILE`
- `content_hash`：清洗后正文哈希，识别不同文件但正文相同 → `SAME_CONTENT`
- `source_key`：优先 DOI/PMID/URL，其次文件名组合 → `UPDATED_CONTENT`（同源更新）或 `NEW_SOURCE`（新来源）

**工程价值**：避免重复向量化，支持文档更新后的版本追踪，降低向量库冗余。

---

## 六、RAG 评估与成本治理

支持两类评估模式：

### 评测集模式

基于 `medical_eval_dataset` 人工维护评测集，完整执行 RAGAS 离线评估。关键：评估上下文与生成答案时的召回片段数量保持一致，避免 `faithfulness` / `context_recall` 因片段数量不一致而假低。

### 历史日志抽样

基于 `medical_query_log` 真实问答日志，默认抽样最近 10 条，使用相关性和事实核查两个二值 judge 做轻量健康检查，同时补充可在无 ground truth 场景下计算的上下文精确度。

### 并发与超时治理

使用 `CompletableFuture` + 自定义评估线程池并发执行单条样本评估，隔离高成本模型调用，避免影响文档切片等其他异步任务。同时引入双层超时保护：模型 HTTP 调用配置真实连接/读取超时，样本级 `deadlineNanos` 在每轮评估前检查剩余时间，不足时提前终止当前样本。

```java
// CompletableFuture + 自定义评估线程池，隔离高成本模型调用
// 模型 HTTP 真实超时 + 样本级 deadline 检查
private void ensureEvaluationCanStart(long deadlineNanos, int timeoutSeconds,
                                       int bufferSeconds, String stage) {
    if (deadlineNanos <= 0) return;
    long remaining = deadlineNanos - System.nanoTime();
    long required = TimeUnit.SECONDS.toNanos(timeoutSeconds + bufferSeconds);
    if (remaining < required) {
        throw new IllegalStateException("deadline reached before " + stage);
    }
}
```

解决了仅依赖 `orTimeout()` 时 Future 已完成但底层 API 请求仍在后台运行的问题。单条样本失败、RAGAS 指标失败和超时降级写入 `errorMsg`，保留可复盘评估运行说明。

---

## 七、核心接口

```text
POST   /api/medical/knowledge              # 创建知识库
GET    /api/medical/knowledge/page         # 分页查询
POST   /api/medical/document/import        # URL导入文档
POST   /api/medical/document/upload        # 文件上传导入
POST   /api/medical/document/{id}/rebuild-index  # 重建单文档索引
POST   /api/medical/knowledge/{id}/rebuild-index # 重建知识库索引
POST   /api/medical/diagnose               # 医学诊断辅助问答
POST   /api/medical/evaluate/{knowledgeId} # 触发评估
GET    /api/medical/evaluate/{id}          # 查询评估结果
```

---

## 项目解决的问题

医疗文献检索场景有三个核心痛点：**文档质量参差**（PDF 排版噪声、隐私信息、参考文献混入正文）、**检索召回不准**（单一策略切片无法适配论文/指南/综述等不同结构）、**评估反馈缺失**（上线后不知道检索和回答质量到底如何）。

本项目中：

- **清洗管道**让进入向量库的文本干净可控，参考文献独立存储不污染语义
- **四策略切片 + 策略路由**让不同结构的文档用最合适的切法，语义切片失败自动回退
- **七类意图 Prompt 编排**让同一套检索结果按医生真实需求（诊断/用药/指南等）产出不同格式的回答，而不是千篇一律
- **文档去重与版本识别**避免重复向量化浪费存储和召回精度
- **评估体系**用评测集做离线全量 RAGAS、用历史日志做线上抽样健康检查，`CompletableFuture` 并发 + deadline 超时控制成本，失败降级写入 errorMsg 可复盘
