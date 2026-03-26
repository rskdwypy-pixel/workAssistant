# 禅道 API 文档

本文档记录了禅道系统中与任务/执行/看板相关的API接口。

## 执行类型

禅道的执行(Execution)有三种类型：

| 类型 | 说明 | 前缀 |
|------|------|------|
| **kanban** | 看板 | `/zentao/kanban-` |
| **sprint** | 迭代（敏捷） | `/zentao/execution-` |
| **stage** | 阶段（瀑布） | `/zentao/execution-` |

## 1. 看板相关 API

### 1.1 获取看板空间列表

```
GET /zentao/kanban-space-[browseType]-[recTotal]-[recPerPage]-[pageID].json
```

**参数：**
- `browseType`: involved | cooperation | public | private
- `recTotal`: 总记录数
- `recPerPage`: 每页记录数
- `pageID`: 页码

### 1.2 获取看板视图

```
GET /zentao/kanban-view-[kanbanID].json
```

**参数：**
- `kanbanID`: 看板ID

**响应数据结构：**
```json
{
  "status": "success",
  "data": {
    "id": 149,
    "name": "看板名称",
    "regions": [
      {
        "id": 1,
        "name": "区域名称",
        "groups": [
          {
            "id": 1,
            "name": "分组名称",
            "columns": [
              {
                "id": 1,
                "name": "待办",
                "cards": []
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### 1.3 创建看板卡片

```
POST /zentao/kanban-createCard-[kanbanID]-[regionID]-[groupID]-[columnID].json
```

**参数：**
- `kanbanID`: 看板ID
- `regionID`: 区域ID
- `groupID`: 分组ID
- `columnID`: 列ID

**表单数据：**
| 字段 | 说明 |
|------|------|
| `name` | 卡片名称（必填） |
| `spec` | 卡片描述 |
| `pri` | 优先级（1-4） |
| `assignedTo[]` | 指派人 |
| `deadline` | 截止日期 |
| `begin` | 开始日期 |
| `estimate` | 预估工时 |
| `color` | 颜色 |

**响应：**
```json
{
  "result": "success",
  "id": 123,  // 新创建的卡片ID
  "message": "保存成功"
}
```

### 1.4 编辑看板卡片

```
POST /zentao/kanban-editCard-[cardID].json
```

**参数：**
- `cardID`: 卡片ID

### 1.5 完成看板卡片

```
POST /zentao/kanban-finishCard-[cardID]-[kanbanID].json
```

### 1.6 激活看板卡片

```
POST /zentao/kanban-activateCard-[cardID]-[kanbanID].json
```

### 1.7 移动看板卡片

```
GET /zentao/kanban-moveCard-[cardID]-[fromColID]-[toColID]-[fromLaneID]-[toLaneID]-[kanbanID].json
```

### 1.8 删除看板卡片

```
GET /zentao/kanban-deleteCard-[cardID]-[confirm].json
```

## 2. 普通任务 API（阶段/迭代）

### 2.1 创建任务

```
POST /zentao/task-create-[executionID]-0-0.html
```

**表单数据：**
| 字段 | 说明 |
|------|------|
| `execution` | 执行ID |
| `type` | 任务类型（devel/test等） |
| `name` | 任务名称 |
| `desc` | 任务描述 |
| `pri` | 优先级（1-4） |
| `assignedTo[]` | 指派人 |
| `deadline` | 截止日期 |
| `estimate` | 预估工时 |

### 2.2 更新任务状态

```
POST /zentao/task-{action}-{taskID}.json
```

**action:**
- `start` - 开始任务
- `finish` - 完成任务
- `pause` - 暂停任务
- `close` - 关闭任务
- `activate` - 激活任务

## 3. 执行列表 API

### 3.1 获取所有执行

```
GET /zentao/execution-all------1-50-1.json
```

### 3.2 获取执行详情

```
GET /zentao/execution-view-[executionID].json
```

## API 调用注意事项

1. **看板ID vs 执行ID**：
   - 看板类型的执行，其`kanbanID`就是执行ID
   - 但API路径不同：看板用`/zentao/kanban-`，普通执行用`/zentao/execution-`

2. **看板卡片参数**：
   - `regionID`、`groupID`、`columnID` 都是数字类型
   - 需要先通过 `kanban-view` 接口获取正确的ID
   - 不能使用字符串如 'backlog'，必须使用数字ID

3. **响应格式**：
   - 成功时 `result` 或 `status` 为 'success'
   - 卡片ID可能在不同字段中：`data.id`、`id`、`card.id` 等
