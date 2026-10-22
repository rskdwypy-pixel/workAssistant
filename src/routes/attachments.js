/**
 * 附件接口
 *
 *   GET    /api/records/:id/attachments?remote=1     附件列表（本地待上传 + 禅道里的附件）
 *   POST   /api/records/:id/attachments?name=&mime=&inline=1&hold=1&push=0
 *                                                   上传一个附件（请求体为文件二进制）
 *   POST   /api/records/:id/attachments/sync         立即推送待上传 / 失败的附件（手动重试）
 *   DELETE /api/records/:id/attachments/:key         删除附件（key = local:<附件ID> 或 zentao:<禅道文件ID>）
 *   GET    /api/records/:id/attachments/:attId/content   待上传附件的内容（预览）
 *   GET    /api/zentao/files/:fileId/content?ext=&download=1&name=  禅道附件内容（后端转发）
 *
 * 记录 ID 即本地任务 / Bug 的 ID（两者存在同一个库里，由 record.type 区分）。
 */
import express from 'express';
import { Readable } from 'stream';
import {
  addAttachment,
  getRecord,
  readAttachmentContent,
  removeAttachment,
  describeAttachment,
  kindOf,
  MAX_FILE_BYTES
} from '../services/attachmentStore.js';
import { pushRecordAttachments, schedulePush, withRecordLock } from '../services/attachmentSync.js';

const router = express.Router();

/** Content-Disposition：中文文件名用 RFC 5987 编码 */
function contentDisposition(type, name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendError(res, err) {
  res.status(err.status || 500).json({ success: false, message: err.message });
}

/**
 * 附件列表：本地元数据 + 禅道实时附件（remote=1 时）
 * 在禅道网页上加的附件也会出现；本地已上传、但禅道里已删除的附件会被清理。
 */
router.get('/records/:id/attachments', async (req, res) => {
  try {
    const record = await getRecord(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: '任务或 Bug 不存在' });
    const local = (record.attachments || []).map(describeAttachment);
    const items = [];
    let remoteError = '';
    let remote = null;
    let fileLabel = null;

    if (req.query.remote && record.zentaoId) {
      try {
        const { listObjectFiles, zentaoFileLabel } = await import('../services/zentaoService.js');
        fileLabel = zentaoFileLabel;
        remote = await listObjectFiles(record.type === 'bug' ? 'bug' : 'task', String(record.zentaoId));
      } catch (err) {
        remoteError = err.message;
      }
    }

    const remoteIds = remote ? new Set(remote.map(f => f.id)) : null;
    const knownRemote = new Set();
    for (const a of local) {
      if (a.status === 'uploaded') {
        if (a.zentaoFileId) knownRemote.add(String(a.zentaoFileId));
        // 禅道里已删除（例如在禅道网页上删的）：不再展示，并清掉本地记录
        if (remoteIds && a.zentaoFileId && !remoteIds.has(String(a.zentaoFileId))) {
          removeAttachment(record.id, a.id).catch(() => {});
          continue;
        }
        items.push({
          key: a.zentaoFileId ? `zentao:${a.zentaoFileId}` : `local:${a.id}`,
          source: 'zentao', localId: a.id, zentaoFileId: a.zentaoFileId,
          name: a.name, size: a.size, ext: a.ext, kind: a.kind, status: 'uploaded', inline: a.inline,
          createdAt: a.createdAt
        });
      } else {
        items.push({
          key: `local:${a.id}`, source: 'local', localId: a.id,
          name: a.name, size: a.size, ext: a.ext, kind: a.kind, status: a.status, inline: a.inline,
          error: a.error, stale: a.stale, autoRetry: a.autoRetry, attempts: a.attempts, createdAt: a.createdAt
        });
      }
    }
    // 正在推送的附件：禅道里已经有了，本地还没回写禅道文件 ID（推送收尾前的一两秒）。
    // 这时禅道列表里的那份就是它本身，不能再单独列一条，否则界面上 1 个附件显示成 2 个。
    const inFlight = local.filter(a => a.status === 'uploading' || a.status === 'pending');
    const isInFlightCopy = (f) => {
      const i = inFlight.findIndex(a => fileLabel(a.name) === f.title && Number(a.size) === Number(f.size));
      if (i < 0) return false;
      inFlight.splice(i, 1);
      return true;
    };
    for (const f of remote || []) {
      if (knownRemote.has(f.id)) continue;
      if (isInFlightCopy(f)) continue;
      const name = f.extension ? `${f.title}.${f.extension}` : f.title;
      items.push({
        key: `zentao:${f.id}`, source: 'zentao', zentaoFileId: f.id,
        name, size: f.size, ext: f.extension, kind: kindOf(name) || 'other', status: 'uploaded',
        addedBy: f.addedBy, createdAt: f.addedDate
      });
    }

    res.json({ success: true, zentaoId: record.zentaoId || null, items, remoteError });
  } catch (err) {
    sendError(res, err);
  }
});

/** 上传一个附件：请求体为文件二进制，元信息放在查询参数里 */
router.post(
  '/records/:id/attachments',
  express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ success: false, message: '文件为空' });
      }
      const meta = await addAttachment(req.params.id, {
        name: req.query.name,
        mime: req.query.mime,
        buffer: req.body,
        inline: req.query.inline === '1',
        hold: req.query.hold === '1'
      });
      const record = await getRecord(req.params.id);
      if (meta.status === 'pending' && record && record.zentaoId && req.query.push !== '0') {
        schedulePush(req.params.id);
      }
      res.json({ success: true, data: describeAttachment(meta) });
    } catch (err) {
      sendError(res, err);
    }
  }
);

/** 立即推送（用户点「重试」或调用方需要等推送完成） */
router.post('/records/:id/attachments/sync', async (req, res) => {
  try {
    const result = await pushRecordAttachments(req.params.id, { force: true });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/** 删除附件：本地未上传的直接删；已在禅道的同时删除禅道里的文件 */
router.delete('/records/:id/attachments/:key', async (req, res) => {
  try {
    const recordId = req.params.id;
    const [kind, value] = String(req.params.key).split(':');
    const record = await getRecord(recordId);
    if (!record) return res.status(404).json({ success: false, message: '任务或 Bug 不存在' });

    const result = await withRecordLock(recordId, async () => {
      let localMeta = null;
      let zentaoFileId = null;
      if (kind === 'local') {
        localMeta = (record.attachments || []).find(a => a.id === value) || null;
        if (!localMeta) return { success: false, status: 404, message: '附件不存在' };
        if (localMeta.status === 'uploading') return { success: false, status: 409, message: '附件正在上传，请稍后再删' };
        zentaoFileId = localMeta.status === 'uploaded' ? localMeta.zentaoFileId : null;
      } else if (kind === 'zentao' && /^\d+$/.test(value)) {
        zentaoFileId = value;
        localMeta = (record.attachments || []).find(a => String(a.zentaoFileId) === value) || null;
      } else {
        return { success: false, status: 400, message: '非法的附件标识' };
      }

      let inlineNote = '';
      if (zentaoFileId) {
        const z = await import('../services/zentaoService.js');
        const type = record.type === 'bug' ? 'bug' : 'task';
        // 只有禅道里的附件（没有本地记录）：删之前先取到文件名，用来找正文里的同名图片
        let name = localMeta ? localMeta.name : '';
        if (!name && record.zentaoId) {
          const f = (await z.listObjectFiles(type, String(record.zentaoId)).catch(() => [])).find(x => x.id === String(zentaoFileId));
          if (f) name = f.extension ? `${f.title}.${f.extension}` : f.title;
        }
        const r = await z.deleteZentaoFile(zentaoFileId);
        if (!r.success) return { success: false, status: 502, message: `删除禅道附件失败：${r.message}` };
        // 截图上传时同时插进了正文：附件删了，正文里那张也要去掉
        const isImage = localMeta ? localMeta.kind === 'image' : kindOf(name) === 'image';
        if (isImage && record.zentaoId) {
          const ri = await z.removeInlineImage(type, String(record.zentaoId), {
            inlineUrl: localMeta && localMeta.inlineUrl, name, zentaoFileId: String(zentaoFileId)
          });
          if (!ri.success) inlineNote = `，但正文里的图片未能移除：${ri.message}`;
        }
      }
      if (localMeta) await removeAttachment(recordId, localMeta.id);
      return { success: true, message: `附件已删除${inlineNote}` };
    });

    res.status(result.success ? 200 : (result.status || 500)).json({ success: result.success, message: result.message });
  } catch (err) {
    sendError(res, err);
  }
});

/** 待上传附件的内容（预览 / 下载） */
router.get('/records/:id/attachments/:attId/content', async (req, res) => {
  try {
    const record = await getRecord(req.params.id);
    const meta = record && (record.attachments || []).find(a => a.id === req.params.attId);
    if (!meta) return res.status(404).json({ success: false, message: '附件不存在' });
    const buf = await readAttachmentContent(req.params.id, meta.id).catch(() => null);
    if (!buf) return res.status(404).json({ success: false, message: '本地暂存文件已不存在（可能已上传到禅道）' });
    res.setHeader('Content-Type', meta.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(req.query.download ? 'attachment' : 'inline', meta.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (err) {
    sendError(res, err);
  }
});

/** 禅道附件内容：后端带着禅道会话转发（插件页面拿不到禅道 cookie） */
router.get('/zentao/files/:fileId/content', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.fileId)) return res.status(400).json({ success: false, message: '非法的文件 ID' });
    const { fetchZentaoFile } = await import('../services/zentaoService.js');
    const download = req.query.download === '1';
    const upstream = await fetchZentaoFile(req.params.fileId, req.query.ext, { download });
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    // 返回的是 HTML 多半是会话失效 / 文件不存在的提示页，不当成文件内容转发
    if (!upstream.ok || /text\/html/i.test(type)) {
      return res.status(502).json({ success: false, message: `读取禅道附件失败（HTTP ${upstream.status}）` });
    }
    res.setHeader('Content-Type', type);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    const name = String(req.query.name || `附件-${req.params.fileId}${req.query.ext ? '.' + req.query.ext : ''}`);
    res.setHeader('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    sendError(res, err);
  }
});

/** 请求体超限（单个文件超过 50MB）等解析错误：给出可读的原因，而不是笼统的服务器错误 */
router.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ success: false, message: '单个文件不能超过 50MB' });
  }
  next(err);
});

export default router;
