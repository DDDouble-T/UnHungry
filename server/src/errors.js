class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function badRequest(code, message, details) {
  return new HttpError(400, code, message, details)
}

function notFound(message = '资源不存在') {
  return new HttpError(404, 'NOT_FOUND', message)
}

function conflict(code, message) {
  return new HttpError(409, code, message)
}

function unauthorized(message = '未识别到用户身份') {
  return new HttpError(401, 'AUTH_REQUIRED', message)
}

module.exports = { HttpError, badRequest, notFound, conflict, unauthorized }
