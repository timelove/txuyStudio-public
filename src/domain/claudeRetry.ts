/**
 * claude API error 自动重试的判定纯函数与常量(零 React/Tauri 依赖,便于单测)。
 *
 * 背景:glm 代理下 claude 调底层 API 偶发接口报错(5xx/overloaded/超时/连接失败/限流),
 * result 事件 success=false、error 取 result 文本。`claudeTransport` 据此函数判断是否
 * 自动重试(最多 5 次指数退避),而非立即终止。
 *
 * 匹配策略:error 文本小写化,**先判不可重试(命中即 false),再判可重试(命中即 true)**,
 * 顺序不可反——如 "API Error: 401" 两类词都沾,不可重试(权限类)必须优先,否则误重试。
 * 都不命中(未知错误)→ 默认重试:glm 下 is_error 绝大多数是网关/上游抖动,重试有硬上限
 * (5 次/≤30s)误判成本低;权限/输入类已被不可重试关键词兜住。
 */

/** 最大重试次数(首次失败 + 最多 5 次重试,仍失败才终止)。 */
export const RETRY_MAX_ATTEMPTS = 5;

/** 指数退避间隔(ms):第 1..5 次重试前的等待,总 ≤30s,给服务端恢复时间。 */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/** 不可重试的 HTTP 状态码(word boundary 防误伤普通数字):客户端/权限/输入类,重试无意义。 */
const NON_RETRYABLE_STATUS = /\b(400|401|403|404|413|422)\b/;

/** 不可重试关键词:权限 / 配额 / 计费 / 输入非法。重试不会成功,立即终止。 */
const NON_RETRYABLE_KEYWORDS = [
  "unauthorized",
  "forbidden",
  "permission",
  "invalid",
  "authentication",
  "api key",
  "quota",
  "insufficient",
  "credit",
  "balance",
  "billing",
  "too long",
  "context length",
];

/** 可重试的 HTTP 状态码:限流 + 服务端。过载恢复后可成功。 */
const RETRYABLE_STATUS = /\b(429|500|502|503|504|529)\b/;

/** 可重试关键词:过载 / 限流 / 超时 / 网络连接类。瞬时故障,重试可能成功。 */
const RETRYABLE_KEYWORDS = [
  "overloaded",
  "rate limit",
  "rate_limit",
  "timeout",
  "timed out",
  "etimedout",
  "econnrefused",
  "econnreset",
  "eai_again",
  "socket hang up",
  "fetch failed",
  "network",
  "connection",
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
];

/**
 * 判断 result error 是否为可自动重试的接口/网络类错误。
 *
 * @param error 后端 result 事件的 error 文本(可能为 null:is_error 但 result 非字符串)。
 * @returns true=可重试(进 5 次退避重试);false=不可重试(权限/输入类,立即终止)。
 *   error 为 null/空(未知)→ 默认 true(宽松,符合「类似接口报错都重试」意图)。
 */
export function isRetryableApiError(error: string | null | undefined): boolean {
  if (!error) return true;
  const text = error.toLowerCase();
  if (NON_RETRYABLE_STATUS.test(text)) return false;
  if (NON_RETRYABLE_KEYWORDS.some((k) => text.includes(k))) return false;
  if (RETRYABLE_STATUS.test(text)) return true;
  if (RETRYABLE_KEYWORDS.some((k) => text.includes(k))) return true;
  return true;
}
