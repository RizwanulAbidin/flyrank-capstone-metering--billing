'use strict';

// One error type carrying the status code and a machine-readable reason, so the
// HTTP layer never has to guess what a service meant. Every rejection a client
// sees comes from here.

class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody() {
    const body = { error: this.message, code: this.code };

    if (this.details !== undefined) {
      body.details = this.details;
    }

    return body;
  }
}

module.exports = { ApiError };
