'use strict';

// DeepSeek 的低峰时段按北京时间固定为 23:00 至次日 08:30。
// 中国标准时间没有夏令时，因此用 UTC+8 换算可避免运行器本地时区影响。
function beijingMinuteOfDay(now = new Date()) {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) throw new Error('模型调用时间无效。');
  const beijing = new Date(instant.getTime() + 8 * 60 * 60 * 1000);
  return beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
}

function isModelInvocationAllowed(now = new Date()) {
  const minute = beijingMinuteOfDay(now);
  return minute >= 23 * 60 || minute <= 8 * 60 + 30;
}

function modelWindowError(now = new Date()) {
  const error = new Error('模型调用仅允许在北京时间23:00至08:30进行；本次未向模型服务商发起请求。');
  error.code = 'MODEL_WINDOW_CLOSED';
  error.now = new Date(now).toISOString();
  return error;
}

function assertModelInvocationAllowed(now = new Date()) {
  if (!isModelInvocationAllowed(now)) throw modelWindowError(now);
}

module.exports = { assertModelInvocationAllowed, beijingMinuteOfDay, isModelInvocationAllowed, modelWindowError };
