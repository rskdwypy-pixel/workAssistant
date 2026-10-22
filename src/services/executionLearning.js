import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { config } from '../config.js';
import { join, dirname } from 'path';

// 数据目录取自 config.paths.data（调用时读取，测试可指向临时目录）
const LEARNING_FILE_NAME = 'executionLearning.json';
const learningFile = () => join(config.paths.data, LEARNING_FILE_NAME);

const MAX_RECORDS = 200;

/**
 * 确保学习文件存在
 * @returns {Object} 学习数据 { corrections: [] }
 */
function ensureLearningFile() {
  if (!existsSync(learningFile())) {
    const dir = dirname(learningFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const defaultData = { corrections: [] };
    writeFileSync(learningFile(), JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  }
  try {
    return JSON.parse(readFileSync(learningFile(), 'utf-8'));
  } catch (e) {
    console.error('[ExecutionLearning] 学习文件损坏，重建:', e.message);
    const fresh = { corrections: [] };
    writeFileSync(learningFile(), JSON.stringify(fresh, null, 2), 'utf-8');
    return fresh;
  }
}

function writeLearningFile(data) {
  writeFileSync(learningFile(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 规范化文本，用于历史记录的模糊匹配
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * 判断两条任务描述是否「说的是同一件事」
 * 用于匹配用户修正记录：完全一致 → 2分；一方包含另一方 → 1分
 * @param {string} a
 * @param {string} b
 * @returns {number} 0 | 1 | 2
 */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 2;
  if (na.includes(nb) || nb.includes(na)) return 1;
  return 0;
}

/**
 * 查找历史修正记录中是否已有该任务描述的归属
 * 用于「先查历史、再问 AI」，避免每次都花钱调模型
 * @param {string} taskContent
 * @returns {string|null} 历史命中的 executionId
 */
function lookupLearned(taskContent) {
  const data = ensureLearningFile();
  const records = data.corrections || [];
  if (records.length === 0) return null;

  // 优先精确匹配，其次包含匹配；同分取时间最近的一条
  let best = null;
  for (const r of records) {
    const score = similarity(taskContent, r.content);
    if (score === 0 || !r.executionId) continue;
    if (!best || score > best.score || (score === best.score && r.timestamp > best.timestamp)) {
      best = { score, executionId: r.executionId };
    }
  }
  return best ? String(best.executionId) : null;
}

/**
 * 记录一条 AI 匹配命中（供后续统计准确率，非纠错）
 * @param {string} taskContent
 * @param {string} executionId
 */
function recordMatch(taskContent, executionId) {
  const data = ensureLearningFile();
  if (!data.matches) data.matches = [];
  data.matches.push({
    content: String(taskContent || '').slice(0, 200),
    executionId: String(executionId),
    timestamp: new Date().toISOString()
  });
  if (data.matches.length > MAX_RECORDS) {
    data.matches = data.matches.slice(-MAX_RECORDS);
  }
  writeLearningFile(data);
}

/**
 * 学习用户的修正选择：同一描述重复修正时提升权重
 * @param {string} taskContent
 * @param {string} correctExecutionId
 */
function learnFromCorrection(taskContent, correctExecutionId) {
  if (!taskContent || !correctExecutionId) return;
  const data = ensureLearningFile();
  if (!data.corrections) data.corrections = [];

  const norm = normalize(taskContent);
  const existing = data.corrections.find(
    c => normalize(c.content) === norm && String(c.executionId) === String(correctExecutionId)
  );

  if (existing) {
    // 同一组合重复修正 → 权重累加，AI 会更倾向于这个结果
    existing.count = (existing.count || 1) + 1;
    existing.timestamp = new Date().toISOString();
  } else {
    data.corrections.push({
      content: String(taskContent).slice(0, 200),
      executionId: String(correctExecutionId),
      count: 1,
      timestamp: new Date().toISOString()
    });
  }

  if (data.corrections.length > MAX_RECORDS) {
    data.corrections = data.corrections.slice(-MAX_RECORDS);
  }
  writeLearningFile(data);
  console.log('[ExecutionLearning] 已学习修正:', taskContent, '→', correctExecutionId);
}

/**
 * 生成供 AI 参考的历史修正提示片段
 * @param {string} taskContent - 当前任务描述
 * @param {number} limit - 最多取几条
 * @returns {string} 空字符串或提示片段
 */
function buildLearningHint(taskContent, limit = 8) {
  const data = ensureLearningFile();
  const records = (data.corrections || [])
    .slice()
    .sort((a, b) => (b.count || 1) - (a.count || 1) || String(b.timestamp).localeCompare(String(a.timestamp)));

  if (records.length === 0) return '';

  const lines = records.slice(0, limit).map(r =>
    `- "${r.content}" → 执行 ${r.executionId}${(r.count || 1) > 1 ? `（用户已纠正 ${r.count} 次）` : ''}`
  );

  return '\n\n【用户历史修正记录（最高优先级参考）】\n' + lines.join('\n');
}

/**
 * 获取学习统计
 */
function getLearningStats() {
  const data = ensureLearningFile();
  const byExecution = {};
  (data.corrections || []).forEach(c => {
    const key = String(c.executionId);
    byExecution[key] = (byExecution[key] || 0) + (c.count || 1);
  });
  return {
    corrections: (data.corrections || []).length,
    matches: (data.matches || []).length,
    byExecution
  };
}

/**
 * 清除学习数据
 */
function clearLearningData() {
  writeLearningFile({ corrections: [], matches: [] });
  console.log('[ExecutionLearning] 学习数据已清除');
}

export {
  lookupLearned,
  recordMatch,
  learnFromCorrection,
  buildLearningHint,
  getLearningStats,
  clearLearningData
};