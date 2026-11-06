# 生产 MVP 研读与重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付现有应用的完整架构/接口/运维资料，并在业务行为不变的前提下修复资源生命周期和重复工作。

**Architecture:** 保留模块化单体 API、独立 worker、SQLite WAL 与原生单页。只分离 HTTP 应用和进程入口，不引入服务框架、数据库或队列依赖。

**Tech Stack:** Node 24、Express 4、node:sqlite、Playwright、原生 DOM/EventSource。

**Spec:** [ARCHITECTURE.md](../../ARCHITECTURE.md)

## Global Constraints

- 保留扫码、任务节奏、账号隔离、积分真实性与人工安全验证行为。
- 不操作真实账号，不处理真实验证码，不推送、不部署。
- 保留现有 data、密钥、用户改动；不提交敏感数据。
- 不把单机 SQLite 宣称为跨服务器扩容能力。

## Review Focus

- 两个账号并发首次请求浏览器：只启动一个进程，各自上下文保持独立。
- 启动失败及启动中关闭：允许后续正常重试，不泄漏迟到的浏览器实例。
- HTTP 应用被测试导入：不监听固定端口，不注册进程退出处理。
- 完全相同的轮询结果：不重建账号 DOM；变化后的积分和选择仍即时显示。
- 混合任务事件历史：按 job_id 和游标利用索引，输出顺序与归属不变。

## Tasks

### 1. HTTP 边界与架构交付
- [x] 编写应用可导入/临时端口监听的集成测试，确认重构前失败。
- [x] 将路由应用移到 `app/src/app.js`，`server.js` 只保留 listen 与退出。
- [x] 补齐 `docs/API.md`、交付手册；复用既有 API 契约，不增加产品功能。

### 2. 浏览器生命周期
- [x] 在 `app/test/browser-lifecycle.test.js` 用模拟启动器复现重复启动、启动失败、启动期间关闭。
- [x] 只修改 `getBrowser` / `closeBrowser`，共享启动 Promise，防旧实例断开清除新实例。
- [x] 运行生命周期回归和现有验证码回归。

### 3. 数据库读取与 UI 绘制
- [x] 在存储回归加入日志顺序/隔离与查询计划证明；现有索引已生效，回归直接通过。
- [x] 不重复创建索引，不修改数据库或旧数据。
- [x] 在多账号回归观察相同轮询的 DOM 变更次数；先观察失败。
- [x] 账号状态相同时跳过绘制，保留现有数据加载与事件处理。

### 4. 总体验证与交付
- [x] 完整隔离回归、必要端到端、代码审查；记录具体结果与未测事项。
- [x] 更新审查清单、交接与 README 的交付入口；不提交、不推送、不部署。

## Rulings

- 用户已要求自主推进，且最新要求明确“业务行为不变”，因此不实施新产品功能或整体重写。
- 扫码查分失败后仍绑定账号并清除暂停的候选问题涉及业务失败语义，记录为后续风险；本轮不擅自改变登录成功条件。
- 事件索引已经存在，最初的瓶颈假设被查询计划否定。保留性能回归证据，不为通过测试而改动正确实现。
