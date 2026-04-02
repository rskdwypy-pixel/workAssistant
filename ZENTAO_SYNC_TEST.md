# 禅道双向同步功能 - 测试验证文档

## 实现概述

已成功实现禅道双向同步功能，包括以下核心特性：

### ✅ 已完成功能

#### 1. 同步频率控制机制 (Phase 1)
- ✅ 使用 `chrome.storage.local` 存储同步时间戳
- ✅ 默认24小时同步一次
- ✅ 插件重新加载时自动检查是否需要同步
- ✅ 手动同步可跳过时间限制

**关键文件：**
- `extension/background.js`:
  - `getLastSyncTime()` - 获取上次同步时间
  - `updateLastSyncTime()` - 更新同步时间戳
  - `handlePluginReload()` - 处理插件重新加载事件
  - `chrome.runtime.onStartup/onInstalled` 监听器

#### 2. 后端服务 (Phase 2)
- ✅ 新增API端点：
  - `POST /api/zentao/login` - 登录禅道获取cookie
  - `POST /api/zentao/sync-tasks` - 同步任务到本地
  - `POST /api/zentao/sync-bugs` - 同步Bug到本地

- ✅ 数据导入函数：
  - `taskManager.importZentaoTasks()` - 批量导入任务（去重）
  - `bugManager.importZentaoBugs()` - 批量导入Bug（去重）

**关键文件：**
- `src/routes/api.js` - 新增同步API端点
- `src/services/taskManager.js` - 添加 `importZentaoTasks()` 函数
- `src/services/bugManager.js` - 添加 `importZentaoBugs()` 函数

#### 3. 浏览器扩展同步逻辑 (Phase 3)
- ✅ `syncFromZentaoInBackground()` - 后台同步主函数
- ✅ `parseMyDashboard()` - 解析我的地盘页面
- ✅ `parseTaskList()` - 解析任务列表页面
- ✅ `parseBugList()` - 解析Bug列表页面

**关键文件：**
- `extension/background.js` - 完整的同步逻辑实现

#### 4. UI更新 (Phase 4)
- ✅ 同步状态显示区域
- ✅ 最后同步时间显示（格式化为"X小时前"）
- ✅ 手动同步按钮
- ✅ 按钮状态控制（未到24小时禁用）
- ✅ 定时更新同步状态（每分钟）

**关键文件：**
- `extension/newtab.html` - 添加同步状态UI
- `extension/newtab.js` - 添加 `ZentaoSync` 对象

## 测试验证清单

### 1. 代码语法验证
- ✅ `src/routes/api.js` - 语法正确
- ✅ `src/services/taskManager.js` - 语法正确
- ✅ `src/services/bugManager.js` - 语法正确
- ✅ `extension/background.js` - 语法正确
- ✅ `extension/newtab.js` - 语法正确

### 2. 功能测试（需要手动验证）

#### 2.1 同步频率控制测试
- [ ] 首次重新加载插件，验证是否触发同步
- [ ] 立即再次重新加载插件，验证是否跳过同步
- [ ] 修改 `chrome.storage.local` 中的时间戳为25小时前，验证是否触发同步
- [ ] 测试手动同步按钮，验证是否跳过时间限制

**测试方法：**
```javascript
// 在浏览器控制台执行
chrome.storage.local.get(['zentao_last_sync_time'], (result) => {
  console.log('上次同步时间:', result.zentao_last_sync_time);
  // 修改为25小时前
  chrome.storage.local.set({
    zentao_last_sync_time: Date.now() - 25 * 60 * 60 * 1000
  });
});
```

#### 2.2 数据同步测试
- [ ] 在禅道中创建测试任务（wait/doing状态）
- [ ] 在禅道中创建测试Bug（各种状态）
- [ ] 重新加载插件或手动触发同步
- [ ] 验证任务和Bug是否出现在插件中
- [ ] 验证状态映射是否正确

#### 2.3 去重测试
- [ ] 手动创建一个本地任务
- [ ] 在禅道中创建相同ID的任务
- [ ] 执行同步
- [ ] 验证是否只保留一个任务（zentaoId匹配）

#### 2.4 UI测试
- [ ] 打开新标签页，查看同步状态显示
- [ ] 验证最后同步时间格式化显示正确
- [ ] 测试手动同步按钮的禁用/启用状态
- [ ] 验证同步通知是否正确显示

### 3. 数据映射验证

#### 任务状态映射
| 禅道状态 | 插件状态 | 验证 |
|---------|---------|------|
| wait | todo | ⬜ |
| doing | in_progress | ⬜ |
| done | done | ⬜（不同步） |
| closed | done | ⬜（不同步） |

#### Bug状态映射
| 禅道状态 | 插件状态 | 验证 |
|---------|---------|------|
| 未确认 | unconfirmed | ⬜ |
| 已确认 | activated | ⬜ |
| 激活 | activated | ⬜ |
| 已解决 | resolved | ⬜ |
| 已关闭 | closed | ⬜ |

### 4. 错误处理测试
- [ ] 测试禅道未登录时的错误处理
- [ ] 测试网络错误时的错误处理
- [ ] 测试解析失败时的错误处理
- [ ] 验证错误通知是否正确显示

### 5. 性能测试
- [ ] 测试大量任务（100+）的同步性能
- [ ] 验证同步过程是否阻塞UI
- [ ] 检查内存使用情况

## 已知限制和注意事项

1. **同步频率**：默认24小时，避免频繁请求禅道服务器
2. **数据范围**：只同步未开始和进行中的任务，所有状态的Bug
3. **去重逻辑**：基于 `zentaoId` 去重，禅道数据优先
4. **iframe处理**：禅道页面使用iframe，当前使用 fetch 获取HTML源码
5. **Cookie管理**：每次同步都重新登录，获取新鲜cookie

## 后续优化建议

1. **增量同步**：只同步有更新的数据（基于 `updatedAt` 时间戳）
2. **后台定时同步**：每小时检查一次，而不是只在插件加载时
3. **同步历史**：记录同步历史，支持回滚
4. **冲突解决**：更智能的冲突解决策略
5. **性能优化**：大量数据时分批处理

## 部署说明

1. **后端部署**：
   ```bash
   cd /Users/itreenewbee/Pictures/Github/workAssistant
   npm install  # 如果需要
   node src/index.js  # 启动后端服务
   ```

2. **浏览器扩展部署**：
   - 打开 `chrome://extensions/`
   - 开启开发者模式
   - 点击"重新加载"按钮

3. **首次使用**：
   - 配置禅道连接信息
   - 重新加载插件
   - 查看控制台日志确认同步触发
   - 验证任务和Bug是否正确同步

## 相关文件清单

### 修改的文件
- `extension/background.js` - 添加同步逻辑和频率控制
- `extension/newtab.js` - 添加同步状态UI
- `extension/newtab.html` - 添加同步状态显示区域
- `src/routes/api.js` - 添加同步API端点
- `src/services/taskManager.js` - 添加任务导入函数
- `src/services/bugManager.js` - 添加Bug导入函数

### 未修改的文件
- `extension/content.js` - 内容脚本（无需修改）
- `extension/sync.js` - WebDAV同步（独立功能）
- `src/services/zentaoService.js` - 禅道服务（已有loginZentao函数）
