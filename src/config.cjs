'use strict';

function configuredAddress(variableName) {
  return String(process.env[variableName] || 'briefing@example.invalid').trim();
}

const PROJECT_CONFIG = Object.freeze({
  timezone: 'Asia/Shanghai',
  timezoneLabel: '北京时间',
  utcOffsetHours: 8,
  cutoffHour: 7,
  senderName: '全球晨报',
  // 真实投递地址只能通过受保护的运行环境注入。无投递配置时仍可生成样例 .eml，
  // 但 SMTP 发送会在连接前被拒绝。
  senderAddress: configuredAddress('BRIEFING_SENDER_ADDRESS'),
  recipientAddress: configuredAddress('BRIEFING_RECIPIENT_ADDRESS'),
  displaySourceLimit: 2,
  dedupRetentionDays: 14,
  categories: Object.freeze([
    Object.freeze({ id: 'ai', number: '一', name: '人工智能' }),
    Object.freeze({ id: 'digital-economy', number: '二', name: '数字经济' }),
    Object.freeze({ id: 'china-economy-policy', number: '三', name: '中国经济与政策' }),
    Object.freeze({ id: 'global-economy-politics', number: '四', name: '全球经济与政治' }),
    Object.freeze({ id: 'open-source-tech', number: '五', name: '开源与技术生态' })
  ]),
  allowedEvidenceStatuses: Object.freeze(['confirmed', 'authoritative-exclusive']),
  authoritativeExclusiveOrganizations: Object.freeze(['路透社', '美联社', 'Reuters', 'Associated Press']),
  hardExclusionFlags: Object.freeze([
    'unrelated-disaster',
    'crime',
    'sports',
    'entertainment',
    'routine-election',
    'routine-conflict-update',
    'marketing-only',
    'unverified-leak',
    'low-density'
  ])
});

module.exports = { PROJECT_CONFIG };
