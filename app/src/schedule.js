export const DEFAULT_TIMES = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00'];
export const SCHEDULE_TASKS = ['login', 'article', 'video', 'daily'];
const DAY = 86400_000;
const OFFSET = 8 * 3600_000;

export function validateSchedule({ enabled, times } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('启用状态必须为开启或关闭');
  if (!Array.isArray(times) || times.length !== 7 || !times.every(t => typeof t === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) {
    throw new Error('请填写周一至周日的七个时间，格式为小时:分钟');
  }
}

export function scheduleDay(at) {
  return new Date(at + OFFSET).toISOString().slice(0, 10);
}

export function scheduledAt(times, at) {
  const local = new Date(at + OFFSET);
  const [hour, minute] = times[(local.getUTCDay() + 6) % 7].split(':').map(Number);
  return Math.floor((at + OFFSET) / DAY) * DAY - OFFSET + hour * 3600_000 + minute * 60_000;
}

export function nextScheduledAt(times, at) {
  const today = scheduledAt(times, at);
  return today > at ? today : scheduledAt(times, at + DAY);
}
