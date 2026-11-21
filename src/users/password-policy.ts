import { MESSAGES_AUTH } from "../messages.js";

const MIN_PASSWORD_LENGTH = 8;

/** The shared rule for a new password; returns the Indonesian error, or `undefined` when fine. */
export function newPasswordError(next: string, confirm: string | undefined): string | undefined {
  if (next.length < MIN_PASSWORD_LENGTH) return MESSAGES_AUTH.passwordTooShort;
  if (next !== confirm) return MESSAGES_AUTH.passwordMismatch;
  return undefined;
}
