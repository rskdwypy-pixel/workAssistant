# 禅道双向同步 - 配置和测试指南

## 当前状态

✅ 禅道配置已存在（.env 文件）
✅ ZENTAO_ENABLED=true
✅ 代码实现完成
✅ 扩展已安装

⚠️ **需要操作：重启后端服务**

## 快速启动步骤

### 1️⃣ 启动后端服务

```bash
cd /Users/itreenewbee/Pictures/Github/workAssistant
node src/index.js
```

应该看到：
```
[Server] 工作助手后端服务运行在 http://localhost:3721
[Config] 已加载禅道用户列表，用户数量: XX
```

### 2️⃣ 重新加载浏览器扩展

1. 打开 `chrome://extensions/`
2. 找到"工作助手"
3. 点击重新加载图标 🔄

### 3️⃣ 打开新标签页测试

1. 按 `Ctrl+T` (或 `Cmd+T`)
2. 查看控制台日志

**应该看到：**
```
[Background] ========== 插件重新加载，检查是否需要同步禅道数据 ==========
[Background] 首次同步，开始从禅道同步数据...
[Background] ========== 开始从禅道同步数据 ==========
[Background] 步骤1: 登录禅道...
[Background] ✓ 登录成功
[Background] 步骤2: 获取任务和Bug数量...
[Background] ✓ 禅道数据统计 - 任务: XX, Bug: XX
[Background] 步骤3: 获取任务列表...
[Background] ✓ 解析到 XX 个任务
[Background] 步骤4: 获取Bug列表...
[Background] ✓ 解析到 XX 个Bug
[Background] 步骤5: 保存到本地数据库...
[Background] ✓ 同步结果 - 任务: {...}, Bug: {...}
[Background] ========== 禅道同步完成 ==========
```

### 4️⃣ 验证同步结果

**在新标签页中：**
- 左侧边栏显示：`上次同步: 刚刚`
- "立即同步"按钮显示为禁用状态（24小时内不能再次同步）

**查看同步的任务：**
- 任务标签页应该显示从禅道同步的任务
- Bug标签页应该显示从禅道同步的Bug

## 当前禅道配置

你的 `.env` 文件中已配置：
- ✅ ZENTAO_ENABLED=true
- ✅ ZENTAO_URL=http://10.128.1.8:8088
- ✅ ZENTAO_USERNAME=lijc
- ✅ ZENTAO_PASSWORD=***

## 同步规则

### 自动同步
- **触发时机：** 插件重新加载时
- **频率限制：** 24小时一次
- **数据范围：**
  - 任务：只同步 `wait`（未开始）和 `doing`（进行中）状态
  - Bug：同步所有状态的Bug

### 手动同步
- 点击左侧边栏的"立即同步"按钮
- 可跳过24小时限制

### 去重机制
- 基于 `zentaoId` 去重
- 如果本地已存在相同zentaoId的任务/Bug，则更新
- 否则创建新记录

## 测试场景

### 场景1：首次同步
1. 确保 `data/tasks.json` 中没有从禅道同步的数据
2. 重启后端服务
3. 重新加载扩展
4. ✅ 应该自动触发同步

### 场景2：24小时内不重复同步
1. 首次同步完成后
2. 立即重新加载扩展
3. ✅ 应该跳过同步，显示"还需等待 X 小时"

### 场景3：手动同步
1. 点击"立即同步"按钮
2. ✅ 应该立即触发同步，跳过时间限制

### 场景4：数据去重
1. 在禅道中创建任务A
2. 在插件中手动创建任务A（不同zentaoId）
3. 执行同步
4. ✅ 应该有两个任务（基于zentaoId去重）

## 常见问题

### Q: 看到错误"访问我的地盘页面失败"
**A:** 检查禅道服务器是否可访问，检查Cookie是否有效

### Q: 看到"登录禅道失败"
**A:** 检查 `.env` 中的用户名密码是否正确

### Q: 同步成功但任务列表为空
**A:** 正常现象，只同步 `wait` 和 `doing` 状态的任务。检查禅道中是否有这两种状态的任务。

### Q: Bug列表为空
**A:** 检查禅道中是否有分配给你的Bug

## 调试技巧

### 查看详细日志
打开浏览器控制台（F12），查看所有带 `[Background]` 前缀的日志

### 查看同步时间戳
```javascript
// 在控制台执行
chrome.storage.local.get(['zentao_last_sync_time'], (result) => {
  console.log('上次同步时间:', new Date(result.zentao_last_sync_time));
});
```

### 重置同步时间（用于测试）
```javascript
// 在控制台执行，设置为25小时前
chrome.storage.local.set({
  zentao_last_sync_time: Date.now() - 25 * 60 * 60 * 1000
});
```

### 清空同步记录
```javascript
// 在控制台执行，设置为从未同步
chrome.storage.local.set({
  zentao_last_sync_time: 0
});
```

## 监控同步状态

在控制台中可以看到：
- 同步开始时间
- 每个步骤的执行情况
- 解析到的任务和Bug数量
- 同步结果统计

成功通知示例：
```
🔔 工作助手 - 禅道同步
已从禅道同步 XX 个任务和 XX 个Bug
```

## 下一步

同步成功后，你可以：
1. ✅ 在任务看板中查看从禅道同步的任务
2. ✅ 在Bug看板中查看从禅道同步的Bug
3. ✅ 更新任务状态，进度会自动同步到禅道
4. ✅ 记录工时，数据会同步到禅道

祝使用愉快！🎉
