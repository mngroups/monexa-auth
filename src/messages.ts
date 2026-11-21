import { MESSAGES } from "@mono/server-kit";

/** Auth-service copy that complements the kit's `MESSAGES`. */
export const MESSAGES_AUTH = {
  noAppAccess: "Anda tidak memiliki akses ke aplikasi ini",
  passwordChangeRequired: "Anda harus mengganti password terlebih dahulu",
  orgNotEligible: "Anda tidak memiliki akses ke organisasi ini",
  resetNotAllowed:
    "User ini juga anggota organisasi lain; reset password hanya bisa dilakukan admin platform",
  invalidCredentials: MESSAGES.invalidCredentials,
} as const;
