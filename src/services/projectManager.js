import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { config } from '../config.js';

// 数据目录取自 config.paths.data（调用时读取，测试可指向临时目录）
const PROJECTS_FILE_NAME = 'projects.json';
const projectsFile = () => join(config.paths.data, PROJECTS_FILE_NAME);

/**
 * 确保项目文件存在
 */
function ensureProjectsFile() {
  if (!existsSync(projectsFile())) {
    const defaultData = {
      projects: [],
      favoriteProjectIds: [],
      lastSync: null
    };
    writeFileSync(projectsFile(), JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  }
  return JSON.parse(readFileSync(projectsFile(), 'utf-8'));
}

/**
 * 写入项目文件
 */
function writeProjectsFile(data) {
  writeFileSync(projectsFile(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 获取所有项目列表
 */
async function getProjects() {
  const data = ensureProjectsFile();
  return data.projects || [];
}

/**
 * 从禅道同步项目列表（后端直连）
 * @returns {Promise<Array>} 项目列表
 * @throws {Error} 禅道不可达或返回异常时抛出（不再静默返回旧数据）
 */
async function syncProjectsFromZentao() {
  const { getZentaoCookies, cookiesToString, zentaoFetch, describeZentaoTransportError } = await import('./zentaoService.js');

  let inner;
  try {
    const cookies = await getZentaoCookies();
    const response = await zentaoFetch(`${config.zentao.url.replace(/\/$/, '')}/zentao/project-browse-all-all--------.json`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookiesToString(cookies),
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const outer = await response.json();
    inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
  } catch (err) {
    console.error('[ProjectManager] 同步项目列表失败:', err.message);
    throw new Error(describeZentaoTransportError(err));
  }

  const raw = inner?.projectStats || inner?.projects || [];
  const projects = Array.isArray(raw) ? raw : Object.values(raw);

  const formattedProjects = projects.map(p => ({
    id: String(p.id),
    name: p.name || p.title || `项目 ${p.id}`,
    status: p.status || 'open',
    type: p.type || 'sprint',
    begin: p.begin || '',
    end: p.end || '',
    openedBy: p.openedBy || '',
    openedDate: p.openedDate || ''
  }));

  // 保存到本地，保留原有的收藏设置
  const data = ensureProjectsFile();
  data.projects = formattedProjects;
  data.favoriteProjectIds = Array.from(new Set(data.favoriteProjectIds || []));
  data.lastSync = new Date().toISOString();
  writeProjectsFile(data);

  console.log('[ProjectManager] 同步成功，获取到', formattedProjects.length, '个项目');
  return formattedProjects;
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
