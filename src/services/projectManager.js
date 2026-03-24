import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECTS_FILE = join(__dirname, '../../data/projects.json');

/**
 * 确保项目文件存在
 */
function ensureProjectsFile() {
  if (!existsSync(PROJECTS_FILE)) {
    const defaultData = {
      projects: [],
      favoriteProjectIds: [],
      lastSync: null
    };
    writeFileSync(PROJECTS_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  }
  return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));
}

/**
 * 写入项目文件
 */
function writeProjectsFile(data) {
  writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 获取所有项目列表
 */
async function getProjects() {
  const data = ensureProjectsFile();
  return data.projects || [];
}

/**
 * 从禅道同步项目列表
 */
async function syncProjectsFromZentao() {
  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }

  if (!config.zentao.url) {
    throw new Error('禅道 URL 未配置');
  }

  try {
    // 动态导入 zentaoService
    const { getZentaoCookies, cookiesToString } = await import('./zentaoService.js');

    // 获取 cookie
    const cookies = await getZentaoCookies();
    const cookieHeader = cookiesToString(cookies);

    // 调用禅道 API 获取项目列表
    const response = await fetch(`${config.zentao.url}/zentao/project-browse-all-all--------.json`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookieHeader,
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    console.log('[ProjectManager] 禅道响应:', result);

    // 解析项目列表
    let projects = [];

    // 禅道返回的数据结构可能是 { projects: [...] } 或者直接是数组
    if (result && result.projects && Array.isArray(result.projects)) {
      projects = result.projects;
    } else if (result && result.data && Array.isArray(result.data)) {
      projects = result.data;
    } else if (Array.isArray(result)) {
      projects = result;
    }

    // 转换为我们的格式
    const formattedProjects = projects.map(p => ({
      id: String(p.id),
      name: p.name || p.title || `项目 ${p.id}`,
      status: p.status || 'open',
      type: p.type || 'sprint',
      begin: p.begin || '',
      end: p.end || '',
      openedBy: p.openedBy || '',
      openedDate: p.openedDate || '',
      teams: p.teams || []
    }));

    // 保存到本地
    const data = ensureProjectsFile();

    // 合并项目列表，保留原有的收藏设置
    const existingFavorites = new Set(data.favoriteProjectIds || []);
    data.projects = formattedProjects;
    data.favoriteProjectIds = Array.from(existingFavorites);
    data.lastSync = new Date().toISOString();

    writeProjectsFile(data);

    console.log('[ProjectManager] 同步成功，获取到', formattedProjects.length, '个项目');

    return formattedProjects;
  } catch (err) {
    console.error('[ProjectManager] 同步项目列表失败:', err.message);

    // 返回现有的项目列表
    const data = ensureProjectsFile();
    return data.projects || [];
  }
}

/**
 * 获取用户收藏的项目
 */
async function getFavoriteProjects() {
  const data = ensureProjectsFile();
  const favoriteIds = data.favoriteProjectIds || [];
  const projects = data.projects || [];

  return projects.filter(p => favoriteIds.includes(p.id));
}

/**
 * 设置用户收藏的项目
 */
async function setFavoriteProjects(projectIds) {
  const data = ensureProjectsFile();
  data.favoriteProjectIds = projectIds;
  writeProjectsFile(data);
  return true;
}

/**
 * 添加收藏项目
 */
async function addFavoriteProject(projectId) {
  const data = ensureProjectsFile();
  if (!data.favoriteProjectIds) {
    data.favoriteProjectIds = [];
  }
  if (!data.favoriteProjectIds.includes(projectId)) {
    data.favoriteProjectIds.push(projectId);
    writeProjectsFile(data);
  }
  return true;
}

/**
 * 移除收藏项目
 */
async function removeFavoriteProject(projectId) {
  const data = ensureProjectsFile();
  if (data.favoriteProjectIds) {
    data.favoriteProjectIds = data.favoriteProjectIds.filter(id => id !== projectId);
    writeProjectsFile(data);
  }
  return true;
}

/**
 * 根据ID获取项目
 */
async function getProjectById(projectId) {
  const data = ensureProjectsFile();
  const projects = data.projects || [];
  return projects.find(p => p.id === String(projectId));
}

export {
  getProjects,
  syncProjectsFromZentao,
  getFavoriteProjects,
  setFavoriteProjects,
  addFavoriteProject,
  removeFavoriteProject,
  getProjectById
};
