/**
 * 真函数测试：备忘录（后端）
 *   - memoCrypto：加密 / 解密 / 前缀检测 / 篡改检测 / 用户不匹配
 *   - memoService：CRUD（本地，不涉及禅道）
 */
import { encryptMemo, decryptMemo, isMemoEncrypted } from '../src/utils/memoCrypto.js';
import { listMemos, createMemo, updateMemo, deleteMemo, togglePin, getSyncState, setSyncState, mergeRemoteMemos } from '../src/services/memoService.js';

let pass = 0, total = 0;
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`); };

// ==================== memoCrypto ====================

const memo = { content: '# 测试\n正文', tags: ['工作'], pinned: false, refs: [], createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' };
const userId = 123;

// 加密
const encrypted = encryptMemo(memo, userId);
check('加密：以 MEMO_V1: 开头', encrypted.startsWith('MEMO_V1:'));
check('加密：不含明文内容', !encrypted.includes('测试') && !encrypted.includes('工作'));
check('加密：base64 格式', /^MEMO_V1:[A-Za-z0-9+/=]+$/.test(encrypted));

// 解密
const decrypted = decryptMemo(encrypted, userId);
check('解密：内容正确', decrypted.content === memo.content);
check('解密：标签正确', JSON.stringify(decrypted.tags) === JSON.stringify(memo.tags));
check('解密：updatedAt 正确', decrypted.updatedAt === memo.updatedAt);

// 前缀检测
check('isMemoEncrypted：识别加密内容', isMemoEncrypted(encrypted));
check('isMemoEncrypted：拒绝普通文本', !isMemoEncrypted('普通文本'));
check('isMemoEncrypted：拒绝空', !isMemoEncrypted(''));
check('isMemoEncrypted：拒绝 null', !isMemoEncrypted(null));

// 用户不匹配
let errMsg = '';
try { decryptMemo(encrypted, 999); } catch (e) { errMsg = e.message; }
check('解密：用户 ID 不匹配报错', errMsg.includes('其他用户'));

// 篡改检测：整体篡改（可能先触发 JSON 解析或 GCM 报错）
const tampered = encrypted.slice(0, -10) + 'AAAAAAAAAA';
errMsg = '';
try { decryptMemo(tampered, userId); } catch (e) { errMsg = e.message; }
check('解密：篡改密文报错', errMsg !== '', `err: ${errMsg}`);

// 篡改检测：精确篡改 data 字段（不破坏 JSON 结构，GCM tag 必须拦住）
const body = JSON.parse(Buffer.from(encrypted.slice('MEMO_V1:'.length), 'base64').toString('utf-8'));
body.data = body.data.slice(0, -4) + 'AAAA';
const tamperedBody = Buffer.from(JSON.stringify(body), 'utf-8').toString('base64');
errMsg = '';
try { decryptMemo('MEMO_V1:' + tamperedBody, userId); } catch (e) { errMsg = e.message; }
check('解密：篡改 data 字段 GCM 报错', errMsg.includes('解密失败'), `err: ${errMsg}`);

// 空 / 非法输入
errMsg = '';
try { decryptMemo('not-memo', userId); } catch (e) { errMsg = e.message; }
check('解密：非备忘录内容报错', errMsg.includes('不是备忘录'));

// 不同用户加密的密文，同一用户解不开
const encrypted2 = encryptMemo(memo, 456);
errMsg = '';
try { decryptMemo(encrypted2, userId); } catch (e) { errMsg = e.message; }
check('解密：其他用户的密文报错', errMsg.includes('其他用户'));

// 两次加密结果不同（salt/iv 随机）
check('加密：两次加密结果不同', encryptMemo(memo, userId) !== encrypted);

// ==================== memoService CRUD ====================

// 清理：先删除所有已有备忘录 + 重置同步状态
const existing = await listMemos();
for (const m of existing) {
  try { await deleteMemo(m.id); } catch {}
}
await setSyncState({ enabled: false, defaultLibId: '' });

// 同步状态默认未启用
const syncState = await getSyncState();
check('同步状态：默认未启用', syncState.enabled === false);

// 新建
const m1 = await createMemo({ title: '测试备忘录 1', content: '正文内容 1', tags: ['工作', '测试'] });
check('新建：返回 id', !!m1.id);
check('新建：标题正确', m1.title === '测试备忘录 1');

// 列表
const list1 = await listMemos();
check('列表：包含新建的备忘录', list1.some(m => m.id === m1.id));
// 未配置任何同步目标 → 纯本地便签，不标 dirty（否则永远挂着「待同步」）
check('新建：未配同步目标不标 dirty', list1.find(m => m.id === m1.id).syncDirty === false);

// 显式带 syncLibId 创建 → 标 dirty
const m3 = await createMemo({ title: '同步目标测试', content: 'x', tags: [], syncLibId: '77' });
check('新建：显式 syncLibId 标 dirty', m3.syncDirty === true);
await deleteMemo(m3.id);

// 配置默认库后，之前纯本地的便签自动标 dirty（等上行入库）
await setSyncState({ defaultLibId: '185' });
const list1b = await listMemos();
check('同步配置：设默认库后纯本地便签自动标 dirty', list1b.find(m => m.id === m1.id).syncDirty === true);
check('同步配置：defaultLibId 已保存', (await getSyncState()).defaultLibId === '185');
// 恢复未配置，继续本地 CRUD 测试
await setSyncState({ defaultLibId: '' });

// 编辑
const m1upd = await updateMemo(m1.id, { content: '更新后的内容' });
check('编辑：内容更新', m1upd.content === '更新后的内容');
check('编辑：updatedAt 更新', m1upd.updatedAt >= m1.updatedAt);

// 置顶
const m1pin = await togglePin(m1.id);
check('置顶：pinned 切换为 true', m1pin.pinned === true);

// 列表排序：置顶优先
const list2 = await listMemos();
check('列表：置顶的排最前', list2[0].id === m1.id);

// 新建第二条
const m2 = await createMemo({ title: '测试备忘录 2', content: '正文内容 2', tags: [] });
const list3 = await listMemos();
check('列表：置顶的仍然排最前', list3[0].id === m1.id);
check('列表：第二条也在', list3.some(m => m.id === m2.id));

// 搜索：标题
const searched1 = await listMemos({ keyword: '备忘录 2' });
check('搜索：命中标题', searched1.some(m => m.id === m2.id));
check('搜索：不命中未匹配的', !searched1.some(m => m.id === m1.id));

// 搜索：正文
const searched2 = await listMemos({ keyword: '更新后的内容' });
check('搜索：命中正文', searched2.some(m => m.id === m1.id));

// 搜索：标签
const searched3 = await listMemos({ keyword: '工作' });
check('搜索：命中标签', searched3.some(m => m.id === m1.id));

// 编辑：改标签
const m1tags = await updateMemo(m1.id, { tags: ['生活', '购物'] });
check('编辑：标签更新', JSON.stringify(m1tags.tags) === JSON.stringify(['生活', '购物']));

// 删除
await deleteMemo(m2.id);
const list4 = await listMemos();
check('删除：列表中不再包含', !list4.some(m => m.id === m2.id));

// 再次置顶（取消置顶）
const m1unpin = await togglePin(m1.id);
check('置顶：再次切换为 false', m1unpin.pinned === false);

// 清理
await deleteMemo(m1.id);

// ==================== mergeRemoteMemos 下行合并（纯函数） ====================

const L = (over = {}) => ({ id: 'a', docId: '10', title: '旧标题', content: 'c', tags: [], pinned: false, refs: [], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', syncDirty: false, deleted: false, ...over });
const R = (over = {}) => ({ id: '10', docId: '10', title: '新标题', content: 'c2', tags: [], pinned: false, refs: [], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', syncDirty: false, deleted: false, syncLibId: '185', ...over });

// 两端都有 → 取新者
{
  const { merged } = mergeRemoteMemos([L()], [R({ updatedAt: '2026-11-02T00:00:00Z' })], new Set(['10']), new Set());
  check('合并：远端较新取远端', merged[0].title === '新标题');
}
{
  const { merged } = mergeRemoteMemos([L({ updatedAt: '2026-11-03T00:00:00Z' })], [R()], new Set(['10']), new Set());
  check('合并：本地较新取本地', merged[0].title === '旧标题');
}

// 文档真删了（列表里没有）→ 非 dirty 本地移除
{
  const { merged, removed } = mergeRemoteMemos([L()], [], new Set(), new Set());
  check('合并：远端真删除 → 本地移除', merged.length === 0 && removed === 1);
}
// 文档真删了但本地 dirty → 保留等重传
{
  const { merged } = mergeRemoteMemos([L({ syncDirty: true })], [], new Set(), new Set());
  check('合并：真删除但本地 dirty → 保留', merged.length === 1);
}
// 文档在但正文被改成普通文档（broken）→ 本地保留 + 标 dirty 修复
{
  const { merged, repaired } = mergeRemoteMemos([L()], [], new Set(['10']), new Set(['10']));
  check('合并：正文被改坏 → 保留并标 dirty 重传', merged.length === 1 && merged[0].syncDirty === true && repaired === 1);
}
// 文档在、是密文但解密失败（别人的 / 被篡改）→ 本地原样保留不动
{
  const { merged, repaired } = mergeRemoteMemos([L()], [], new Set(['10']), new Set());
  check('合并：解密失败 → 原样保留', merged.length === 1 && merged[0].syncDirty === false && repaired === 0);
}
// 本地新建未上传（无 docId）→ 保留
{
  const { merged } = mergeRemoteMemos([L({ id: 'b', docId: '' })], [], new Set(), new Set());
  check('合并：无 docId 新建 → 保留', merged.length === 1);
}
// 已删除且 dirty → 保留等上传删除
{
  const { merged } = mergeRemoteMemos([L({ deleted: true, syncDirty: true })], [], new Set(['10']), new Set());
  check('合并：删除待同步 → 保留', merged.length === 1 && merged[0].deleted === true);
}
// 远端新增（本地没有）→ 加入
{
  const { merged } = mergeRemoteMemos([], [R()], new Set(['10']), new Set());
  check('合并：远端新增 → 加入', merged.length === 1);
}
// 换库重建的旧副本（同 title+updatedAt、不同 docId）→ 不重复加入
{
  // 本地这条已经换库重建（docId 指向新文档 20），远端 10 是删除失败的旧副本，内容完全相同
  const local = [L({ docId: '20', syncLibId: '200', title: '新标题', updatedAt: '2026-11-02T00:00:00Z' })];
  const { merged } = mergeRemoteMemos(local, [R()], new Set(['10', '20']), new Set());
  check('合并：换库旧副本不重复加入', merged.length === 1 && merged[0].docId === '20');
}

console.log(`\n备忘录后端：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
