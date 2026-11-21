import { MESSAGES } from "@mono/server-kit";

/** Auth-service copy that complements the kit's `MESSAGES`. */
export const MESSAGES_AUTH = {
  noAppAccess: "Anda tidak memiliki akses ke aplikasi ini",
  passwordChangeRequired: "Anda harus mengganti password terlebih dahulu",
  orgNotEligible: "Anda tidak memiliki akses ke organisasi ini",
  resetNotAllowed:
    "User ini juga anggota organisasi lain; reset password hanya bisa dilakukan admin platform",
  invalidCredentials: MESSAGES.invalidCredentials,
  loginTitle: "Masuk ke Monexa",
  identifierLabel: "Email atau username",
  passwordLabel: "Password",
  loginSubmit: "Masuk",
  selectOrgTitle: "Pilih organisasi",
  selectOrgSubmit: "Lanjutkan",
  changePasswordTitle: "Ganti password",
  currentPasswordLabel: "Password saat ini",
  newPasswordLabel: "Password baru",
  confirmPasswordLabel: "Ulangi password baru",
  changePasswordSubmit: "Simpan password",
  passwordTooShort: "Password baru minimal 8 karakter",
  passwordMismatch: "Konfirmasi password tidak sama",
  currentPasswordWrong: "Password saat ini salah",
  interactionNotFound:
    "Sesi login tidak ditemukan atau sudah kedaluwarsa, silakan ulangi dari aplikasi",
  errorTitle: "Terjadi kesalahan",
  logoutTitle: "Sedang keluar",
  logoutSubmit: "Keluar",
  loggedOutTitle: "Anda telah keluar",
  loggedOut:
    "Anda telah keluar dari Monexa. Silakan tutup halaman ini atau masuk kembali dari aplikasi.",
} as const;
