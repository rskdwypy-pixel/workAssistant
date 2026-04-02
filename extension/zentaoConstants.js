/**
 * 禅道同步相关常量
 */

// 时间常量
export const TIME_CONSTANTS = {
  HOUR_MS: 60 * 60 * 1000,
  DAY_MS: 24 * 60 * 60 * 1000
};

// 禅道任务状态
export const ZENTAO_TASK_STATUS = {
  WAIT: 'wait',
  DOING: 'doing',
  DONE: 'done',
  CLOSED: 'closed'
};

// 禅道Bug状态
export const ZENTAO_BUG_STATUS = {
  UNCONFIRMED: 'unconfirmed',
  ACTIVATED: 'activated',
  RESOLVED: 'resolved',
  CLOSED: 'closed'
};

// 插件任务状态映射
export const PLUGIN_TASK_STATUS = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  DONE: 'done'
};

// 状态映射：禅道任务 -> 插件任务
export const TASK_STATUS_MAP = {
  [ZENTAO_TASK_STATUS.WAIT]: PLUGIN_TASK_STATUS.TODO,
  [ZENTAO_TASK_STATUS.DOING]: PLUGIN_TASK_STATUS.IN_PROGRESS,
  [ZENTAO_TASK_STATUS.DONE]: PLUGIN_TASK_STATUS.DONE,
  [ZENTAO_TASK_STATUS.CLOSED]: PLUGIN_TASK_STATUS.DONE
};

// Bug状态映射
export const BUG_STATUS_MAP = {
  'resolved': ZENTAO_BUG_STATUS.RESOLVED,
  'confirmed': ZENTAO_BUG_STATUS.ACTIVATED,
  'default': ZENTAO_BUG_STATUS.UNCONFIRMED
};

// 存储键
export const STORAGE_KEYS = {
  ZENTAO_LAST_SYNC: 'zentao_last_sync_time'
};

// 同步配置
export const SYNC_CONFIG = {
  INTERVAL: TIME_CONSTANTS.DAY_MS, // 24小时
  STORAGE_KEY: STORAGE_KEYS.ZENTAO_LAST_SYNC
};
