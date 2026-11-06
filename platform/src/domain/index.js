/**
 * 领域驱动注册表：只负责选驱动，不承载业务规则。
 * 任务清单/归一化见 ./tasks.js，避免这里变成第二个「什么都放」的模块。
 */
import { config } from '../config.js';

let cached = null;

export async function getDriver() {
  if (cached) return cached;
  const mod = config.domainDriver === 'xxqg' ? await import('./xxqg-driver.js') : await import('./mock-driver.js');
  cached = await mod.createDriver();
  return cached;
}

export const driverName = () => config.domainDriver;

export { TASK_KINDS, TASK_LABEL, normalizeTasks } from './tasks.js';
