import { Platform } from 'obsidian';

/**
 * Wrapper around Electron's safeStorage.
 *
 * IMPORTANT: safeStorage lives in the Electron MAIN process. Obsidian plugins
 * run in the RENDERER process, where `require('electron').safeStorage` is
 * undefined. We reach the main-process module through @electron/remote
 * (Obsidian bundles it and uses it for menus, dialogs, etc.).
 *
 * safeStorage encrypts/decrypts via the OS credential subsystem:
 *   macOS  → Keychain (tied to the user's login keychain)
 *   Windows → DPAPI   (tied to the Windows user account)
 *   Linux  → GNOME Keyring / KWallet (falls back to a static key if no daemon)
 *
 * Encrypted bytes are stored as base64 in data.json. They are MACHINE-SPECIFIC:
 * copying data.json to another device won't expose the password because the
 * decryption key lives in the OS, not in the file.
 */

interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

let cached: SafeStorage | null | undefined;

function getSafeStorage(): SafeStorage | null {
	if (cached !== undefined) return cached;

	// Only desktop has Electron / Node at all.
	if (!Platform.isDesktopApp) {
		cached = null;
		return cached;
	}

	const candidates: Array<() => SafeStorage | undefined> = [
		// Preferred: main-process module bridged into the renderer
		() => (require('@electron/remote') as { safeStorage?: SafeStorage }).safeStorage,
		// Legacy Electron (<14): electron.remote
		() => (require('electron') as { remote?: { safeStorage?: SafeStorage } }).remote?.safeStorage,
		// Fallback: in case this ever runs in the main process directly
		() => (require('electron') as { safeStorage?: SafeStorage }).safeStorage,
	];

	for (const get of candidates) {
		try {
			const ss = get();
			if (ss && typeof ss.isEncryptionAvailable === 'function') {
				cached = ss;
				return cached;
			}
		} catch {
			// module not resolvable via this path — try the next
		}
	}

	cached = null;
	return cached;
}

/** True when the OS can protect the key (always true on macOS/Windows desktop). */
export function isSecureStorageAvailable(): boolean {
	try {
		return getSafeStorage()?.isEncryptionAvailable() ?? false;
	} catch {
		return false;
	}
}

/** Human-readable diagnostic for the debug command. */
export function secureStorageDiagnostic(): string {
	const lines: string[] = [];
	lines.push(`Platform.isDesktopApp: ${Platform.isDesktopApp}`);

	const probe = (label: string, get: () => unknown) => {
		try {
			const v = get();
			lines.push(`${label}: ${v ? 'found' : 'undefined'}`);
		} catch (e) {
			lines.push(`${label}: error (${(e as Error).message})`);
		}
	};

	probe('@electron/remote .safeStorage', () =>
		(require('@electron/remote') as { safeStorage?: unknown }).safeStorage);
	probe('electron.remote .safeStorage', () =>
		(require('electron') as { remote?: { safeStorage?: unknown } }).remote?.safeStorage);
	probe('electron .safeStorage', () =>
		(require('electron') as { safeStorage?: unknown }).safeStorage);

	const ss = getSafeStorage();
	lines.push(`resolved safeStorage: ${ss ? 'yes' : 'no'}`);
	if (ss) {
		try {
			lines.push(`isEncryptionAvailable(): ${ss.isEncryptionAvailable()}`);
		} catch (e) {
			lines.push(`isEncryptionAvailable() threw: ${(e as Error).message}`);
		}
	}
	return lines.join('\n');
}

/** Encrypt a plaintext password → base64 string safe to store in data.json. */
export function encryptPassword(password: string): string {
	const ss = getSafeStorage();
	if (!ss) throw new Error('OS secure storage is not available');
	return ss.encryptString(password).toString('base64');
}

/**
 * Decrypt a base64-encoded password previously encrypted by encryptPassword.
 * Throws if the encryption key has changed (different machine / OS reinstall).
 */
export function decryptPassword(encryptedBase64: string): string {
	const ss = getSafeStorage();
	if (!ss) throw new Error('OS secure storage is not available');
	return ss.decryptString(Buffer.from(encryptedBase64, 'base64'));
}
