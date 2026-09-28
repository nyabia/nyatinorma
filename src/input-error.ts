// SPDX-License-Identifier: MIT OR Apache-2.0
/** Preflight failed before any input was dispatched. Never use for transport errors after send. */
export class InputNotSentError extends Error {
  constructor(cause:unknown){super(cause instanceof Error?cause.message:String(cause),{cause});this.name='InputNotSentError';}
}
