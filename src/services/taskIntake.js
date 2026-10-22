/**
 * 新建任务的分析流程：字段抽取 + 执行归属
 *
 * 取数顺序（快 → 慢）：
 *   1. 本地规则解析字段（localTaskParser，毫秒级）
 *   2. 本地确定执行：用户已选 > 学习记录 > 关键词规则
 *   3. 需要时才调大模型（统一分析，8 秒超时、不重试）；失败/超时回落到 1、2 的结果
 *
 * 什么时候跳过大模型：
 *   - 没配置 AI
 *   - 短句（一行、≤20 字）且执行已经确定 —— 这类输入本地解析就够了
 *   - 调用方要求只做本地解析（allowAi=false，前端用于「先秒出本地结果，再等 AI 补充」）
 */
import { config } from '../config.js';
import { parseTaskLocally, isSimpleInput } from '../ai/localTaskParser.js';
import { getAiCandidateExecutions } from './executionManager.js';
import { lookupLearned } from './executionLearning.js';

/**
 * 本地确定执行归属（学习记录 > 关键词规则），不调用大模型
 * @returns {{executionId:string, matchedBy:string, confidence:number, reason:string}|null}
 */
async function matchExecutionLocally(content, candidates) {
  const learnedId = lookupLearned(content);
  if (learnedId) {
    const ex = candidates.find(e => String(e.id) === String(learnedId));
    if (ex) {
      return { executionId: String(ex.id), matchedBy: 'learning', confidence: 0.99, reason: `与历史记录「${ex.name}」一致` };
    }
  }
  const { ruleBasedMatch } = await import('../ai/openai.js');
  const ruleId = ruleBasedMatch(content, candidates);
  if (ruleId) {
    const ex = candidates.find(e => String(e.id) === String(ruleId));
    return { executionId: String(ruleId), matchedBy: 'rule', confidence: 0.9, reason: `任务中包含「${ex ? ex.name : ruleId}」关键词` };
  }
  return null;
}

/**
 * 分析一条任务描述
 *
 * @param {string} content
 * @param {Object} [options]
 * @param {string} [options.executionId] - 用户已选的执行（有则不做归属判断）
 * @param {boolean} [options.allowAi=true] - 是否允许调用大模型
 * @returns {Promise<{
 *   source: 'ai'|'local'|'ai-timeout'|'ai-failed', aiAvailable: boolean,
 *   fields: {title,status,progress,priority,dueDate,reminderTime,durationDays},
 *   execution: {executionId, matchedBy, confidence, reason}|null,
 *   needConfirm: boolean, candidates: Array, totalCount: number, aiError?: string
 * }>}
 */
async function analyzeTaskInput(content, options = {}) {
  const aiAvailable = !!(config.ai.apiKey && config.ai.apiKey.trim());
  const userExecutionId = options.executionId ? String(options.executionId) : '';
  const { candidates, totalCount } = await getAiCandidateExecutions();

  const local = parseTaskLocally(content);
  const localExec = userExecutionId
    ? { executionId: userExecutionId, matchedBy: 'user', confidence: 1, reason: '用户选择' }
    : await matchExecutionLocally(content, candidates);

  const base = { aiAvailable, candidates, totalCount };
  const localResult = (source, extra = {}) => ({
    ...base,
    source,
    fields: local,
    execution: localExec,
    needConfirm: false,
    ...extra
  });

  if (!aiAvailable || options.allowAi === false) {
    return localResult('local');
  }
  if (localExec && isSimpleInput(content)) {
    return localResult('local');
  }

  const { createOpenAIClient } = await import('../ai/openai.js');
  const { analyzeTaskUnified } = await import('../ai/unifiedAnalyzer.js');
  const { getRecentTaskTitles } = await import('./taskManager.js');

  const unified = await analyzeTaskUnified(content, {
    candidates,
    history: await getRecentTaskTitles(8),
    client: createOpenAIClient(),
    timeoutMs: options.timeoutMs || 8000
  });

  if (unified.failed) {
    const timedOut = /timeout|timed out|aborted/i.test(unified.error || '');
    console.warn('[TaskIntake] AI 分析失败，改用本地解析:', unified.error);
    return localResult(timedOut ? 'ai-timeout' : 'ai-failed', { aiError: unified.error });
  }

  // AI 字段为主；AI 没识别出的日期/提醒用本地结果补上
  const fields = {
    title: unified.title,
    status: unified.status,
    progress: unified.progress,
    priority: unified.priority,
    dueDate: unified.dueDate || local.dueDate,
    reminderTime: unified.reminderTime || local.reminderTime,
    durationDays: unified.durationDays ?? local.durationDays
  };

  // 执行归属：用户选择 > AI > 本地匹配
  let execution = localExec;
  if (!userExecutionId && unified.executionId) {
    execution = { executionId: unified.executionId, matchedBy: 'ai-unified', confidence: unified.confidence, reason: unified.reason };
  }

  const CONFIRM_THRESHOLD = 0.6;
  const needConfirm = !userExecutionId &&
    (!execution || (execution.matchedBy === 'ai-unified' && execution.confidence < CONFIRM_THRESHOLD));

  return { ...base, source: 'ai', fields, execution, needConfirm };
}

export { analyzeTaskInput, matchExecutionLocally };
