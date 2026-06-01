const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 100_000;

// TS 5.x types Uint8Array.buffer as ArrayBuffer|SharedArrayBuffer.
// WebCrypto requires a plain ArrayBuffer, so we always copy into a fresh one.
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(arr.byteLength);
	new Uint8Array(buf).set(arr);
	return buf;
}

async function pbkdf2Key(password: string, salt: Uint8Array): Promise<CryptoKey> {
	const raw = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(new TextEncoder().encode(password)),
		'PBKDF2',
		false,
		['deriveKey'],
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		raw,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

function toBase64(arr: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < arr.length; i += 8192) {
		binary += String.fromCharCode(...arr.subarray(i, i + 8192));
	}
	return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ── Batch API (key derived once, reused for N files) ─────────────────────────

/** Derive a fresh AES-GCM key from password + random salt. Call once per lock operation. */
export async function createBatchKey(
	password: string,
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const key = await pbkdf2Key(password, salt);
	return { key, salt };
}

/** Re-derive the AES-GCM key for a specific salt (for unlock, grouped by salt). */
export async function deriveKeyForSalt(password: string, salt: Uint8Array): Promise<CryptoKey> {
	return pbkdf2Key(password, salt);
}

/** Extract the salt embedded in the first SALT_LEN bytes of an encrypted blob. */
export function extractSalt(encryptedBase64: string): Uint8Array {
	return fromBase64(encryptedBase64).slice(0, SALT_LEN);
}

/** Encrypt with a pre-derived key. Salt is embedded in the output (self-contained .enc). */
export async function encryptWithKey(
	plaintext: string,
	key: CryptoKey,
	salt: Uint8Array,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	const combined = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
	combined.set(salt, 0);
	combined.set(iv, SALT_LEN);
	combined.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
	return toBase64(combined);
}

/** Decrypt with a pre-derived key. Salt bytes in the blob are skipped (key already derived). */
export async function decryptWithKey(encryptedBase64: string, key: CryptoKey): Promise<string> {
	const combined = fromBase64(encryptedBase64);
	const iv = combined.slice(SALT_LEN, SALT_LEN + IV_LEN);
	const ciphertext = combined.slice(SALT_LEN + IV_LEN);
	// Throws DOMException if key is wrong or data is corrupted
	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
	return new TextDecoder().decode(plaintext);
}

// ── Convenience wrappers (single-file operations and tests) ───────────────────

/** Derive a fresh key and encrypt. Convenience wrapper — derives key internally. */
export async function encryptText(plaintext: string, password: string): Promise<string> {
	const { key, salt } = await createBatchKey(password);
	return encryptWithKey(plaintext, key, salt);
}

/** Re-derive key from embedded salt and decrypt. Convenience wrapper. */
export async function decryptText(encryptedBase64: string, password: string): Promise<string> {
	const salt = extractSalt(encryptedBase64);
	const key = await deriveKeyForSalt(password, salt);
	return decryptWithKey(encryptedBase64, key);
}
