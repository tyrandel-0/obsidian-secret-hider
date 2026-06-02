import { App, Platform } from 'obsidian';

/**
 * Password storage with a layered strategy:
 *
 *   1. Obsidian SecretStorage (app.secretStorage, since v1.11.4) — PREFERRED.
 *      Cross-platform: the value lives in the OS keychain (macOS Keychain,
 *      Windows Credential Manager, Linux libsecret, iOS Keychain, Android
 *      Keystore). Works identically on desktop and mobile. Shown to the user
 *      under Settings → Keychain. data.json stores nothing sensitive.
 *
 *   2. electron.safeStorage via @electron/remote (desktop, older Obsidian) —
 *      FALLBACK when SecretStorage is unavailable. Encrypted blob is kept in
 *      data.json by the caller.
 *
 *   3. Neither available (old mobile) — caller keeps the password in memory
 *      for the session only.
 */

const SECRET_ID = 'secret-hider-password';

// ── Obsidian SecretStorage (preferred, cross-platform) ───────────────────────

interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
	listSecrets(): string[];
}

function getSecretStorage(app: App): SecretStorageLike | null {
	const ss = (app as App & { secretStorage?: SecretStorageLike }).secretStorage;
	return ss && typeof ss.getSecret === 'function' ? ss : null;
}

/** True when the cross-platform Obsidian keychain is available (Obsidian 1.11.4+). */
export function isNativeKeychainAvailable(app: App): boolean {
	return getSecretStorage(app) !== null;
}

// ── electron.safeStorage (desktop fallback) ──────────────────────────────────

interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

let cachedSafe: SafeStorage | null | undefined;

function getSafeStorage(): SafeStorage | null {
	if (cachedSafe !== undefined) return cachedSafe;
	if (!Platform.isDesktopApp) {
		cachedSafe = null;
		return cachedSafe;
	}
	const candidates: Array<() => SafeStorage | undefined> = [
		() => (require('@electron/remote') as { safeStorage?: SafeStorage }).safeStorage,
		() => (require('electron') as { remote?: { safeStorage?: SafeStorage } }).remote?.safeStorage,
		() => (require('electron') as { safeStorage?: SafeStorage }).safeStorage,
	];
	for (const get of candidates) {
		try {
			const ss = get();
			if (ss && typeof ss.isEncryptionAvailable === 'function') {
				cachedSafe = ss;
				return cachedSafe;
			}
		} catch {
			// try next
		}
	}
	cachedSafe = null;
	return cachedSafe;
}

function isSafeStorageAvailable(): boolean {
	try {
		return getSafeStorage()?.isEncryptionAvailable() ?? false;
	} catch {
		return false;
	}
}

// ── Public API ───────────────────────────────────────────────────────────────

/** True when the password can be persisted on this device (any backend). */
export function canPersistPassword(app: App): boolean {
	return isNativeKeychainAvailable(app) || isSafeStorageAvailable();
}

/**
 * Persist the password. Prefers the native cross-platform keychain.
 * Returns a legacy encrypted blob ONLY when falling back to safeStorage
 * (the caller must store it in data.json); returns null when the native
 * keychain handled it (nothing to store in data.json).
 */
export function savePassword(app: App, password: string): { legacyBlob: string | null } {
	const native = getSecretStorage(app);
	if (native) {
		native.setSecret(SECRET_ID, password);
		return { legacyBlob: null };
	}
	const safe = getSafeStorage();
	if (safe) {
		return { legacyBlob: safe.encryptString(password).toString('base64') };
	}
	throw new Error('no secure storage available on this device');
}

/**
 * Load the saved password.
 * @param legacyBlob optional safeStorage blob from data.json (older versions)
 * @returns the password, or null if none / undecryptable on this machine
 */
export function loadPassword(app: App, legacyBlob?: string): string | null {
	const native = getSecretStorage(app);
	if (native) {
		const v = native.getSecret(SECRET_ID);
		if (v) return v;
	}
	if (legacyBlob) {
		const safe = getSafeStorage();
		if (safe) {
			try {
				return safe.decryptString(Buffer.from(legacyBlob, 'base64'));
			} catch {
				return null; // different machine / key changed
			}
		}
	}
	return null;
}

/** Remove the saved password. SecretStorage has no delete, so we blank it. */
export function clearPassword(app: App): void {
	const native = getSecretStorage(app);
	if (native) {
		try {
			native.setSecret(SECRET_ID, '');
		} catch {
			// ignore
		}
	}
}

/** Diagnostic report for the debug command. */
export function secureStorageDiagnostic(app: App): string {
	const lines: string[] = [];
	lines.push(`Platform.isDesktopApp: ${Platform.isDesktopApp}`);
	lines.push(`Obsidian SecretStorage (app.secretStorage): ${isNativeKeychainAvailable(app) ? 'available ✓' : 'not available'}`);
	lines.push(`electron safeStorage fallback: ${isSafeStorageAvailable() ? 'available' : 'not available'}`);
	lines.push(`Can persist password: ${canPersistPassword(app) ? 'YES' : 'no (session-only)'}`);
	return lines.join('\n');
}
