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

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
	const encoded = new TextEncoder().encode(password);
	const raw = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(encoded),
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

export async function encryptText(plaintext: string, password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const key = await deriveKey(password, salt);

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

export async function decryptText(encryptedBase64: string, password: string): Promise<string> {
	const combined = fromBase64(encryptedBase64);

	const salt = combined.slice(0, SALT_LEN);
	const iv = combined.slice(SALT_LEN, SALT_LEN + IV_LEN);
	const ciphertext = combined.slice(SALT_LEN + IV_LEN);

	const key = await deriveKey(password, salt);

	// Throws DOMException on wrong password or corrupted data
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		key,
		ciphertext,
	);

	return new TextDecoder().decode(plaintext);
}
