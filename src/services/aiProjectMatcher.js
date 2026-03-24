import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateResponse } from '../ai/openai.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LEARNING_FILE = join(__dirname, '../../data/projectLearning.json');

/**
 * 确保学习文件存在
 */
function ensureLearningFile() {
  if (!existsSync(LEARNING_FILE)) {
    const defaultData = {
      corrections: [] // { content: string, projectId: string, timestamp: string }
    };
    writeFileSync(LEARNING_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  }
  return JSON.parse(readFileSync(LEARNING_FILE, 'utf-8'));
}

/**
 * 写入学习文件
 */
function writeLearningFile(data) {
  writeFileSync(LEARNING_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 根据任务内容匹配项目
 * @param {string} taskContent - 任务内容
 * @param {Array} favoriteProjects - 收藏的项目列表
 * @returns {Promise<Object|null>} 匹配结果
 */
async function matchProject(taskContent, favoriteProjects) {
  if (!favoriteProjects || favoriteProjects.length === 0) {
    return null;
  }

  // 获取学习数据
  const learningData = ensureLearningFile();
  const recentCorrections = learningData.corrections.slice(-20); // 最近20条修正记录

  // 构建项目列表字符串
  const projectsList = favoriteProjects.map(p => `- ${p.id}: ${p.name}`).join('\n');

  // 构建学习提示
  let learningHint = '';
  if (recentCorrections.length > 0) {
    learningHint = '\n\n【历史修正参考】\n' + recentCorrections.map(c =>
      `- "${c.content}" → 项目 ${c.projectId}`
    ).join('\n');
  }

  const prompt = `你是项目分类助手。根据任务内容，判断其归属于哪个项目。

【可用项目列表】
${projectsList}${learningHint}

【分析规则】
1. 根据项目名称和任务关键词判断归属
2. 参考历史修正记录
3. 返回置信度（0-1）
4. 如果无法确定，返回 null

用户输入：${taskContent}

请只返回JSON：
{
  "projectId": "项目ID或null",
  "projectName": "项目名称或null",
  "confidence": 0.95,
  "reason": "判断原因"
}`;

  try {
    const aiResponse = await generateResponse(prompt);

    // 解析 AI 响应
    let matchResult = null;
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        matchResult = JSON.parse(jsonMatch[0]);

        // 验证项目ID是否在收藏列表中
        if (matchResult.projectId) {
          const isValid = favoriteProjects.some(p => p.id === matchResult.projectId);
          if (!isValid) {
            console.warn('[AIProjectMatcher] AI 返回的项目ID不在收藏列表中:', matchResult.projectId);
            matchResult = null;
          }
        }
      }
    } catch (e) {
      console.error('[AIProjectMatcher] 解析 AI 响应失败:', e);
    }

    return matchResult;
  } catch (err) {
    console.error('[AIProjectMatcher] AI 匹配失败:', err);
    return null;
  }
}

/**
 * 学习用户的修正选择
 * @param {string} taskContent - 任务内容
 * @param {string} correctProjectId - 正确的项目ID
 */
function learnFromCorrection(taskContent, correctProjectId) {
  const learningData = ensureLearningFile();

  // 添加修正记录
  learningData.corrections.push({
    content: taskContent,
    projectId: correctProjectId,
    timestamp: new Date().toISOString()
  });

  // 只保留最近100条记录
  if (learningData.corrections.length > 100) {
    learningData.corrections = learningData.corrections.slice(-100);
  }

  writeLearningFile(learningData);
  console.log('[AIProjectMatcher] 已学习修正:', taskContent, '→', correctProjectId);
}

/**
 * 获取学习统计
 */
function getLearningStats() {
  const learningData = ensureLearningFile();
  const stats = {};

  learningData.corrections.forEach(c => {
    stats[c.projectId] = (stats[c.projectId] || 0) + 1;
  });

  return {
    total: learningData.corrections.length,
    byProject: stats
  };
}

/**
 * 清除学习数据
 */
function clearLearningData() {
  const defaultData = {
    corrections: []
  };
  writeFileSync(LEARNING_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
  console.log('[AIProjectMatcher] 学习数据已清除');
}

export {
  matchProject,
  learnFromCorrection,
  getLearningStats,
  clearLearningData
};
