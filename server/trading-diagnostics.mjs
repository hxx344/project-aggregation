const OPERATIONS = Object.freeze({ permissions: '只读权限检查', account: '账户检查', positions: '仓位读取', funding: '资金费读取' });
const CODES = new Set(['upstream', 'transport', 'http', 'api', 'timeout', 'response_limit', 'permissions', 'account_mode', 'credentials', 'invalid_data', 'pagination', 'page_limit', 'record_limit', 'duplicate', 'duplicate_conflict', 'window_range', 'currency', 'range']);
const FIELDS = new Set(['result', 'list', 'record', 'symbol', 'transactionTime', 'type', 'category', 'funding', 'id', 'nextPageCursor']);
const VALUE_TYPES = Object.freeze({ missing: '缺失', null: '空值', string: '字符串', number: '数字', boolean: '布尔值', array: '数组', object: '对象' });
const REASONS = Object.freeze({ format: '格式无效', empty: '为空', type: '类型不符', unexpected: '与请求不符', limit: '超过支持范围' });

// Persist only bounded protocol metadata. Upstream messages, URLs and credentials
// are never part of this schema, including when restoring old disk snapshots.
export function normalizeTradingDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !['binance', 'bybit', 'okx'].includes(value.exchange) || typeof value.operation !== 'string' || !Object.hasOwn(OPERATIONS, value.operation) || !CODES.has(value.code)
    || !(value.exchange === 'binance' ? ['standard', 'portfolio-margin'] : ['unified']).includes(value.accountMode)) return null;
  const result = { version: 1, exchange: value.exchange, operation: value.operation, accountMode: value.accountMode, code: value.code };
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
  if (Number.isSafeInteger(value.providerCode)) result.providerCode = value.providerCode;
  if (value.exchange === 'bybit' && value.operation === 'funding' && value.code === 'invalid_data' && FIELDS.has(value.field)) {
    result.field = value.field;
    if (typeof value.valueType === 'string' && Object.hasOwn(VALUE_TYPES, value.valueType)) result.valueType = value.valueType;
    if (typeof value.reason === 'string' && Object.hasOwn(REASONS, value.reason)) result.reason = value.reason;
  }
  return result;
}

export function formatTradingDiagnostic(value) {
  const diagnostic = normalizeTradingDiagnostic(value);
  if (!diagnostic) return null;
  const { exchange, accountMode, operation, code, httpStatus, providerCode } = diagnostic;
  const name = exchange === 'binance' ? 'Binance' : exchange === 'okx' ? 'OKX' : 'Bybit';
  const label = exchange === 'binance' ? `${name} ${accountMode === 'portfolio-margin' ? '组合保证金' : '普通 U 本位'}${OPERATIONS[operation]}` : `${name} ${OPERATIONS[operation]}`;
  const details = [];
  if (httpStatus !== undefined) details.push(`HTTP ${httpStatus}`);
  if (providerCode !== undefined) details.push(`${name} ${providerCode}`);
  const suffix = details.length ? `（${details.join('，')}）` : '';
  switch (code) {
    case 'http': case 'api': return `${label}失败${suffix}，请检查账户模式、API 读取权限、IP 白名单与服务器时间`;
    case 'timeout': return `${label}超时，请稍后重试`;
    case 'response_limit': return `${label}响应超过大小限制`;
    case 'permissions': return `${name} API 无法确认只读权限，请使用只读密钥`;
    case 'account_mode': return exchange !== 'binance' ? `${name} 账户模式无效，请使用支持合约的统一交易账户` : 'Binance 账户模式无效，请选择普通 U 本位或组合保证金';
    case 'credentials': return exchange === 'okx' ? 'API Key、Secret 或 Passphrase 无效或为空' : 'API Key 与 Secret 无效或为空';
    case 'invalid_data': return diagnostic.field
      ? `${label}返回字段 ${diagnostic.field} ${REASONS[diagnostic.reason] || '格式无效'}${diagnostic.valueType ? `（收到${VALUE_TYPES[diagnostic.valueType]}）` : ''}`
      : `${label}返回的数据不完整或格式无效`;
    case 'pagination': return `${label}分页未取得进展，当前结果不完整`;
    case 'page_limit': return `${label}达到请求或分页上限，当前结果不完整`;
    case 'record_limit': return '资金费记录达到读取上限，当前结果不完整';
    case 'duplicate': return `${label}返回重复记录，无法确认持仓`;
    case 'duplicate_conflict': return '资金费账本出现冲突记录，当前结果不完整';
    case 'window_range': return '资金费记录超出请求时间范围，当前结果不完整';
    case 'currency': return '原油资金费返回了非 USDT 币种，本次账本不完整';
    case 'range': return '资金费读取仅支持最近 30 天内的有效时间范围';
    default: return `${label}失败，请检查连接与服务器时间`;
  }
}
