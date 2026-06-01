/**
 * Thin wrapper around electron.safeStorage.
 *
 * safeStorage encrypts/decrypts via the OS credential subsystem:
 *   macOS  → Keychain (tied to the user's login keychain)
 *   Windows → DPAPI   (tied to the Windows user account)
 *   Linux  → GNOME Keyring / KWallet (falls back to a static key if no daemon)
 *
 * The encrypted bytes are stored as base64 in data.json.
 * They are MACHINE-SPECIFIC: copying data.json to another device won't expose
 * the password because the decryption key lives in the OS, not in the file.
 */

interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

function getSafeStorage(): SafeStorage | null {
	try {
		// 'electron' is external in esbuild config — provided by Obsidian's runtime.
		const electron = require('electron') as { safeStorage?: SafeStorage };
		return electron.safeStorage ?? null;
	} catch {
		return null;
	}
}

/** Returns true when the OS can actually protect the key (always true on macOS/Windows). */
export function isSecureStorageAvailable(): boolean {
	return getSafeStorage()?.isEncryptionAvailable() ?? false;
}

/** Encrypt a plaintext password → base64 string safe to store in data.json. */
export function encryptPassword(password: string): string {
	const ss = getSafeStorage();
	if (!ss) throw new Error('electron.safeStorage is not available');
	return ss.encryptString(password).toString('base64');
}

/**
 * Decrypt a base64-encoded password previously encrypted by encryptPassword.
 * Throws if the encryption key has changed (different machine / OS reinstall).
 */
export function decryptPassword(encryptedBase64: string): string {
	const ss = getSafeStorage();
	if (!ss) throw new Error('electron.safeStorage is not available');
	return ss.decryptString(Buffer.from(encryptedBase64, 'base64'));
}
