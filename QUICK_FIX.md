# Quick Fix - Chrome Storage Permission Issue

## Problem Fixed

**Error:**
```
TypeError: Cannot read properties of undefined (reading 'local')
at Object.getLastSyncTime (newtab.js:37:41)
```

**Root Cause:** Missing `storage` permission in manifest.json

**Solution:** Added `"storage"` to permissions array in `extension/manifest.json`

## How to Test the Fix

### 1. Reload the Extension
1. Open `chrome://extensions/`
2. Find "工作助手" (Work Assistant)
3. Click the **reload icon** (🔄) to reload the extension

### 2. Open New Tab
1. Open a new tab (Ctrl+T or Cmd+T)
2. The Work Assistant new tab page should load without errors
3. Check the browser console (F12) - should see:
   ```
   ✓ [ZentaoSync] 初始化成功
   ✓ 上次同步: 从未同步
   ```

### 3. Verify Sync Status Display
1. Look at the left sidebar under "🔄 禅道同步" section
2. Should see:
   - **Status text**: "上次同步: 从未同步" (or "X 小时前")
   - **Button**: "立即同步" button (enabled or disabled based on 24-hour rule)

### 4. Enable Zentao Sync (if not already enabled)
The log shows "禅道未启用，跳过同步", which means Zentao sync is not configured.

To enable it:
1. Open the backend config file or API
2. Set Zentao configuration:
   ```json
   {
     "zentao": {
       "enabled": true,
       "url": "http://your-zentao-server:8088",
       "username": "your-username",
       "password": "your-password"
     }
   }
   ```
3. Reload the extension again
4. Should see: `[Background] 首次同步，开始从禅道同步数据...`

## Files Modified

- ✅ `extension/manifest.json` - Added `"storage"` permission

## Verification Checklist

- [ ] Extension reloads without errors
- [ ] New tab opens successfully
- [ ] Console shows no storage errors
- [ ] Sync status display appears in sidebar
- [ ] Manual sync button is visible
- [ ] Button state updates correctly (enabled/disabled)

## Expected Console Output (Success)

```
background.js:46 [Background] ========== 插件重新加载，检查是否需要同步禅道数据 ==========
background.js:52 [Background] 禅道未启用，跳过同步
newtab.js:4165 [ZentaoBrowser] 从缓存加载用户列表成功: 11 个用户
...
newtab.js:812 [ZentaoSync] 初始化成功 ✓ (no error)
```

## If Issues Persist

1. **Clear extension data:**
   - Go to `chrome://extensions/`
   - Click "Service worker" link for Work Assistant
   - In DevTools, Application → Clear storage → Clear site data

2. **Check permissions:**
   - Go to `chrome://extensions/`
   - Click "Details" for Work Assistant
   - Verify "Storage and cookies" permission is listed

3. **Reinstall extension:**
   - Go to `chrome://extensions/`
   - Click "Remove"
   - Click "Load unpacked"
   - Select the `extension` folder

## Additional Notes

- The `storage` permission is required for `chrome.storage.local` API
- This permission is safe and commonly used in Chrome extensions
- It allows storing sync timestamps and user preferences locally
- No special UI permission prompt is shown to users for this permission
