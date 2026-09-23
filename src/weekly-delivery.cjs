'use strict';

function latestSunday(now = new Date()) {
  const date = new Date(new Date(now).getTime() + 8 * 3600000);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0,10);
}

function weeklyDeliveryReceipt(state, now = new Date()) {
  const date = latestSunday(now);
  const delivered = (state.runs || []).find(run => run.date === date && run.kind === 'business-case'
    && run.sent === true && run.delivery?.smtpStatus === 250);
  return { date, accepted: Boolean(delivered), runId: delivered?.runId || null };
}

module.exports = { latestSunday, weeklyDeliveryReceipt };
