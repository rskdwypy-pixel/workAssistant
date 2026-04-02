# 禅道 Bug 接口文档

**基础地址**: `http://10.128.1.8:8088`

---

## 1. 编辑 Bug

```
POST {baseUrl}/zentao/bug-edit-{bugId}.html
Content-Type: multipart/form-data
```

### 关键参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | Bug 标题 |
| steps | string | 是 | 复现步骤 |
| product | int | 是 | 产品 ID |
| project | int | 是 | 项目 ID |
| execution | int | 是 | 执行 ID |
| severity | int | 否 | 严重程度 (1-4) |
| pri | int | 否 | 优先级 (0-4) |
| type | string | 否 | Bug 类型 (codeerror/config/install/security/performance/standard/automation/designdefect/others) |
| status | string | 是 | 状态 (active/resolved/closed) |
| assignedTo | string | 是 | 指派给 (账号) |
| comment | string | 否 | 备注 |
| uid | string | 是 | 唯一标识 (前端生成) |

### 示例

```bash
curl 'http://10.128.1.8:8088/zentao/bug-edit-456.html' \
  -H 'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryXA7KBlaCnpVTMGoG' \
  --data-raw $'------WebKitFormBoundaryXA7KBlaCnpVTMGoG\r\n
Content-Disposition: form-data; name="title"\r\n\r\n
测试 bug41\r\n
------WebKitFormBoundaryXA7KBlaCnpVTMGoG\r\n
Content-Disposition: form-data; name="steps"\r\n\r\n
测试 bug4\r\n
...'
```

---

## 2. 激活/确认 Bug

```
POST {baseUrl}/zentao/bug-confirmBug-{bugId}.html?onlybody=yes
Content-Type: application/x-www-form-urlencoded
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| assignedTo | string | 是 | 指派给 (账号) |
| type | string | 是 | Bug 类型 |
| pri | int | 否 | 优先级 |
| status | string | 是 | 状态 (active) |
| comment | string | 否 | 备注 |

### 示例

```bash
curl 'http://10.128.1.8:8088/zentao/bug-confirmBug-456.html?onlybody=yes' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-raw 'assignedTo=lijc&type=codeerror&pri=3&status=active&comment=&uid=69c5f6142a637'
```

---

## 3. 解决 Bug

```
POST {baseUrl}/zentao/bug-resolve-{bugId}.html?onlybody=yes
Content-Type: multipart/form-data
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| resolution | string | 是 | 解决方案 (fixed/bydesign/external/wontfix/postponed/duplicate/notrepro/willnotfix) |
| duplicateBug | int | 否 | 重复 Bug ID (resolution=duplicate 时必填) |
| buildExecution | int | 是 | 执行 ID |
| resolvedBuild | string | 是 | 解决版本 (如 trunk) |
| resolvedDate | string | 是 | 解决日期 (YYYY-MM-DD HH:mm:ss) |
| assignedTo | string | 是 | 指派给 (账号) |
| status | string | 是 | 状态 (resolved) |
| comment | string | 否 | 备注 |
| uid | string | 是 | 唯一标识 |

### 示例

```bash
curl 'http://10.128.1.8:8088/zentao/bug-resolve-456.html?onlybody=yes' \
  -H 'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryteMvfRyOPUJqL2TO' \
  --data-raw $'------WebKitFormBoundaryteMvfRyOPUJqL2TO\r\n
Content-Disposition: form-data; name="resolution"\r\n\r\n
fixed\r\n
...'
```

---

## 4. 删除 Bug

```
GET {baseUrl}/zentao/bug-delete-{bugId}-yes-.html
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| bugId | int | 是 | Bug ID |
| confirm | string | 是 | 确认标识 (yes) |

### 示例

```bash
curl 'http://10.128.1.8:8088/zentao/bug-delete-456-yes-.html'
```

---

## 5. 创建 Bug

```
POST {baseUrl}/zentao/bug-create-{productId}-{branch}-{extras}.html
Content-Type: multipart/form-data
```

### 关键参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| product | int | 是 | 产品 ID |
| title | string | 是 | Bug 标题 |
| openedBuild | string | 是 | 影响版本 (如 trunk) |
| execution | int | 否 | 执行 ID |
| assignedTo | string | 否 | 指派给 |
| type | string | 否 | Bug 类型 |
| severity | int | 否 | 严重程度 (1-4) |
| pri | int | 否 | 优先级 (0-4) |
| steps | string | 否 | 重现步骤 |

---

## 数据字典

### Bug 状态 (status)

| 值 | 说明 | 对应本地状态 |
|----|------|-------------|
| active | 激活 | activated |
| resolved | 已解决 | resolved |
| closed | 已关闭 | - |

### 严重程度 (severity)

| 值 | 说明 |
|----|------|
| 1 | 致命 |
| 2 | 严重 |
| 3 | 一般 |
| 4 | 提示 |

### Bug 类型 (type)

| 值 | 说明 |
|----|------|
| codeerror | 代码错误 |
| config | 配置相关 |
| install | 安装部署 |
| security | 安全相关 |
| performance | 性能问题 |
| standard | 标准规范 |
| automation | 测试脚本 |
| designdefect | 设计缺陷 |
| others | 其他 |

### 解决方案 (resolution)

| 值 | 说明 |
|----|------|
| fixed | 已修复 |
| bydesign | 设计如此 |
| external | 外部原因 |
| wontfix | 不予解决 |
| postponed | 延后处理 |
| duplicate | 重复 Bug |
| notrepro | 无法重现 |
| willnotfix | 永不解决 |
