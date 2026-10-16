/**
 * 统一错误类型。
 * code 用于前端区分处理；hint 是给用户看的「怎么修」，不是给你看的堆栈。
 */

export class AppError extends Error {
  constructor(code, message, hint = "", status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

/** 环境变量缺失 / 未配置：明确告诉用户缺什么 */
export class ConfigError extends AppError {
  constructor(message, hint) {
    super("NOT_CONFIGURED", message, hint, 503);
  }
}

/** 渠道侧失败：凭证、限流、签名、接口变更 */
export class ChannelError extends AppError {
  constructor(message, hint, code = "CHANNEL_FAILED") {
    super(code, message, hint, 502);
  }
}

/** 数据库不可用 */
export class DbError extends AppError {
  constructor(message, hint) {
    super("DB_ERROR", message, hint, 503);
  }
}
