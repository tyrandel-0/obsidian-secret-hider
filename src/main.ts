import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import {
	createBatchKey,
	deriveKeyForSalt,
	encryptWithKey,
	decryptWithKey,
	extractSalt,
} from './crypto';
import { PasswordModal, PasswordConfirmModal } from './modals';
import { SecretHiderSettings, DEFAULT_SETTINGS, SecretHiderSettingTab } from './settings';
import {
	canPersistPassword,
	savePassword,
	loadPassword,
	clearPassword,
	secureStorageDiagnostic,
} from './password-storage';

const ENC_EXT = '.enc';
const FILE_MARKER = 'OBSIDIAN-SECRET-HIDER-V1\n';

class WrongPasswordError extends Error {
	constructor() { super('wrong-password'); }
}

interface LockedFileEntry {
	originalPath: string;
	encPath: string;
}

interface PluginData {
	settings: SecretHiderSettings;
	isLocked: boolean;
	lockedFiles: LockedFileEntry[];
	// Legacy: safeStorage-encrypted base64 from older versions. Migrated to the
	// native Obsidian keychain on load, then cleared. Never the plaintext.
	encryptedPassword?: string;
}

export default class SecretHiderPlugin extends Plugin {
	settings!: SecretHiderSettings;
	private isLocked = false;
	private lockedFiles: LockedFileEntry[] = [];
	private busy = false;
	private floatingBtn!: HTMLElement;

	// Password in memory. Never written to disk in plain form.
	private storedPassword: string | null = null;
	// Legacy safeStorage blob, kept only until migrated to the native keychain.
	private encryptedPassword: string | undefined;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async onload() {
		await this.loadPluginData();
		this.addSettingTab(new SecretHiderSettingTab(this.app, this));
		this.createFloatingButton();
		this.addCommand({
			id: 'toggle-secret-files',
			name: 'Toggle lock/unlock secret files',
			callback: () => this.handleToggle(),
		});
		this.addCommand({
			id: 'debug-secure-storage',
			name: 'Debug: secure storage availability',
			callback: () => {
				const report = secureStorageDiagnostic(this.app);
				console.log('[Secret Hider] secure storage diagnostic:\n' + report);
				new Notice(report, 15000);
			},
		});

		// Keep the button in sync when another device locks/unlocks via sync.
		// data.json is synced (iCloud / Obsidian Sync), but we only read it on
		// load — so we re-read it periodically and whenever the app regains focus.
		this.registerInterval(window.setInterval(() => this.refreshLockState(), 5000));
		this.registerDomEvent(window, 'focus', () => this.refreshLockState());
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.refreshLockState()),
		);
	}

	onunload() {
		this.floatingBtn?.remove();
		this.storedPassword = null; // wipe from memory on plugin unload
	}

	// ── Public API for settings tab ───────────────────────────────────────────

	get hasStoredPassword(): boolean {
		return this.storedPassword !== null;
	}

	/** For the settings UI "Show password" button — reveals the saved password. */
	getStoredPasswordForDisplay(): string {
		return this.storedPassword ?? '';
	}

	async setAndSavePassword(password: string) {
		this.storedPassword = password;
		// Prefer the native keychain; safeStorage fallback returns a blob for data.json
		const { legacyBlob } = savePassword(this.app, password);
		this.encryptedPassword = legacyBlob ?? undefined;
		await this.savePluginData();
	}

	async forgetPassword() {
		this.storedPassword = null;
		this.encryptedPassword = undefined;
		clearPassword(this.app);
		await this.savePluginData();
	}

	// ── Floating button ───────────────────────────────────────────────────────

	private createFloatingButton() {
		this.floatingBtn = document.body.createEl('div', { cls: 'secret-hider-btn' });
		this.updateButtonUI();
		this.registerDomEvent(this.floatingBtn, 'click', () => this.handleToggle());
	}

	private updateButtonUI() {
		const locked = this.isLocked;
		this.floatingBtn.setText(locked ? '🔒' : '🔓');
		this.floatingBtn.setAttribute(
			'aria-label',
			locked ? 'Secret files locked — click to unlock' : 'Click to lock secret files',
		);
		this.floatingBtn.toggleClass('secret-hider-btn--locked', locked);
		this.floatingBtn.toggleClass('secret-hider-btn--unlocked', !locked);
	}

	// ── Sync state refresh ──────────────────────────────────────────────────────

	/**
	 * Re-read the lock state from data.json (which syncs across devices) and
	 * update the button if it changed elsewhere. Skipped while an operation is
	 * in progress to avoid clobbering an in-flight lock/unlock.
	 */
	private async refreshLockState() {
		if (this.busy) return;
		try {
			const raw = (await this.loadData()) as PluginData | null;
			if (!raw) return;

			const remoteLocked = raw.isLocked ?? false;
			// Keep the manifest fresh so unlock knows the original paths
			if (raw.lockedFiles) this.lockedFiles = raw.lockedFiles;

			if (remoteLocked !== this.isLocked) {
				this.isLocked = remoteLocked;
				this.updateButtonUI();
			}
		} catch {
			// Transient read error (e.g. mid-sync) — ignore, next tick will retry
		}
	}

	// ── Toggle ────────────────────────────────────────────────────────────────

	private async handleToggle() {
		if (this.busy) {
			new Notice('Secret Hider: operation already in progress, please wait.');
			return;
		}
		this.busy = true;
		this.floatingBtn.addClass('secret-hider-btn--busy');
		try {
			if (this.isLocked) {
				await this.unlock();
			} else {
				await this.lock();
			}
		} finally {
			this.busy = false;
			this.floatingBtn.removeClass('secret-hider-btn--busy');
		}
	}

	// ── Password resolution ───────────────────────────────────────────────────

	/**
	 * Returns the password to use for the current operation.
	 *   - If a password is saved in the keychain → return it immediately (no UI).
	 *   - Otherwise → open a modal. If the user ticks "Remember password" (when a
	 *     keychain is available — desktop, or mobile on Obsidian 1.11.4+), the
	 *     password is saved so future operations on this device skip the prompt.
	 */
	private async getPassword(mode: 'lock' | 'unlock'): Promise<string | null> {
		if (this.storedPassword) return this.storedPassword;

		const canRemember = canPersistPassword(this.app);
		const modal =
			mode === 'lock'
				? new PasswordConfirmModal(this.app, canRemember)
				: new PasswordModal(this.app, canRemember);
		modal.open();

		const res = await modal.result;
		if (!res) return null;

		if (res.remember && canRemember) {
			try {
				await this.setAndSavePassword(res.password);
			} catch (e) {
				new Notice(`Secret Hider: could not save password — ${(e as Error).message}`);
			}
		}
		return res.password;
	}

	// ── Lock ──────────────────────────────────────────────────────────────────

	private async lock() {
		const secretFiles = await this.findSecretFiles();
		if (secretFiles.length === 0) {
			const total = this.app.vault.getMarkdownFiles().length;
			new Notice(
				`Secret Hider: no files found with property "${this.settings.secretProperty}" set to true` +
				` (scanned ${total} markdown files).`,
			);
			return;
		}

		const password = await this.getPassword('lock');
		if (!password) return;

		try {
			const manifest = await this.lockFiles(secretFiles, password);
			this.isLocked = true;
			this.lockedFiles = manifest;
			await this.savePluginData();
			this.updateButtonUI();
			new Notice(`🔒 Secret Hider: locked ${manifest.length} file(s).`);
		} catch (e) {
			new Notice(`Secret Hider: lock failed — ${(e as Error).message}`);
		}
	}

	/**
	 * Find all markdown files where the secret property is truthy.
	 * - Tries metadata cache first (fast path).
	 * - Falls back to reading the file directly when cache is empty
	 *   (common on mobile for recently edited / freshly created files).
	 * - Accepts both boolean true and string "true" / "yes" / "on"
	 *   since Obsidian may store checkbox values differently across platforms.
	 */
	private async findSecretFiles(): Promise<TFile[]> {
		// Compare case-insensitively: "Secret" and "secret" are the same property
		const prop = this.settings.secretProperty.toLowerCase();
		const result: TFile[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);

			if (cache?.frontmatter) {
				// Find the key ignoring case ("Secret", "SECRET", "secret" all match)
				const key = Object.keys(cache.frontmatter).find(k => k.toLowerCase() === prop);
				if (key && isSecretValue(cache.frontmatter[key])) result.push(file);
			} else {
				// Cache miss — read the raw file and parse frontmatter ourselves
				try {
					const content = await this.app.vault.read(file);
					if (rawFrontmatterHasProp(content, prop)) result.push(file);
				} catch {
					// Unreadable file — skip silently
				}
			}
		}

		return result;
	}

	/**
	 * Atomic lock — 3 phases:
	 *   1. Derive key ONCE. Read + encrypt all files in parallel (no disk writes yet).
	 *   2. Write ALL .enc files sequentially. Rollback on any failure — originals untouched.
	 *   3. All .enc confirmed → delete originals in parallel. Delete failures are safe.
	 */
	private async lockFiles(files: TFile[], password: string): Promise<LockedFileEntry[]> {
		for (const file of files) {
			this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file?.path === file.path) leaf.detach();
			});
		}

		const { key, salt } = await createBatchKey(password);

		type Prepared = { file: TFile; encPath: string; encData: string };
		const prepared = await Promise.all(
			files.map(async (file): Promise<Prepared> => {
				const content = await this.app.vault.read(file);
				const encrypted = await encryptWithKey(content, key, salt);
				return { file, encPath: toEncPath(file.path), encData: FILE_MARKER + encrypted };
			}),
		);

		const written: string[] = [];
		try {
			for (const { encPath, encData } of prepared) {
				await this.app.vault.adapter.write(encPath, encData);
				written.push(encPath);
			}
		} catch (e) {
			await Promise.allSettled(written.map(p => this.app.vault.adapter.remove(p)));
			throw new Error(
				`Could not write encrypted files (${(e as Error).message}). No original files were deleted.`,
			);
		}

		await Promise.allSettled(
			prepared.map(({ file }) =>
				this.app.vault.delete(file).catch(e => {
					console.error(`Secret Hider: could not delete ${file.path}:`, e);
				}),
			),
		);

		return prepared.map(({ file, encPath }) => ({ originalPath: file.path, encPath }));
	}

	// ── Unlock ────────────────────────────────────────────────────────────────

	private async unlock() {
		const password = await this.getPassword('unlock');
		if (!password) return;

		try {
			const count = await this.unlockFiles(password);
			this.isLocked = false;
			this.lockedFiles = [];
			await this.savePluginData();
			this.updateButtonUI();
			new Notice(`🔓 Secret Hider: unlocked ${count} file(s).`);
		} catch (e) {
			if (e instanceof WrongPasswordError) {
				new Notice('Secret Hider: wrong password — no files were changed.');
			} else {
				new Notice(`Secret Hider: ${(e as Error).message}`);
			}
		}
	}

	/**
	 * Atomic unlock — 2 phases:
	 *   1. Resolve paths (manifest → O(1), fallback → vault walk).
	 *      Read all .enc in parallel. Group by salt → 1 PBKDF2 per unique salt.
	 *      Decrypt all in parallel. Wrong password → throw before any disk write.
	 *   2. Write .md files sequentially (stop on first failure; .enc files stay intact).
	 *      Remove .enc files in parallel after all writes succeed.
	 */
	private async unlockFiles(password: string): Promise<number> {
		const encPaths =
			this.lockedFiles.length > 0
				? this.lockedFiles.map(e => e.encPath)
				: await this.findEncryptedFilesFallback();

		if (encPaths.length === 0) throw new Error('no encrypted files found in vault');

		const readResults = await Promise.allSettled(
			encPaths.map(async encPath => ({ encPath, raw: await this.app.vault.adapter.read(encPath) })),
		);

		const ourFiles = readResults
			.filter(
				(r): r is PromiseFulfilledResult<{ encPath: string; raw: string }> =>
					r.status === 'fulfilled' && r.value.raw.startsWith(FILE_MARKER),
			)
			.map(r => r.value);

		if (ourFiles.length === 0) throw new Error('no Secret Hider encrypted files found');

		type DecEntry = { encPath: string; encData: string; mdPath: string };
		type SaltGroup = { salt: Uint8Array; entries: DecEntry[] };
		const saltGroups: SaltGroup[] = [];

		for (const { encPath, raw } of ourFiles) {
			const encData = raw.slice(FILE_MARKER.length);
			const salt = extractSalt(encData);
			const mdPath =
				this.lockedFiles.find(e => e.encPath === encPath)?.originalPath ??
				fromEncPath(encPath);

			const group = saltGroups.find(
				g => g.salt.length === salt.length && g.salt.every((b, i) => b === salt[i]),
			);
			if (group) group.entries.push({ encPath, encData, mdPath });
			else saltGroups.push({ salt, entries: [{ encPath, encData, mdPath }] });
		}

		type Decrypted = { mdPath: string; encPath: string; content: string };
		const decrypted: Decrypted[] = [];

		for (const { salt, entries } of saltGroups) {
			const key = await deriveKeyForSalt(password, salt);
			const results = await Promise.all(
				entries.map(async ({ encPath, encData, mdPath }): Promise<Decrypted> => {
					try {
						return { mdPath, encPath, content: await decryptWithKey(encData, key) };
					} catch {
						throw new WrongPasswordError();
					}
				}),
			);
			decrypted.push(...results);
		}

		for (const { mdPath, content } of decrypted) {
			await this.app.vault.adapter.write(mdPath, content);
		}

		await Promise.allSettled(
			decrypted.map(({ encPath }) =>
				this.app.vault.adapter.remove(encPath).catch(e => {
					console.error(`Secret Hider: could not remove ${encPath}:`, e);
				}),
			),
		);

		return decrypted.length;
	}

	private async findEncryptedFilesFallback(): Promise<string[]> {
		const results: string[] = [];
		await this.walkForEncFiles('/', results);
		return results;
	}

	private async walkForEncFiles(dir: string, out: string[]) {
		const { files, folders } = await this.app.vault.adapter.list(dir);
		for (const f of files) {
			const name = f.split('/').pop() ?? f;
			// Our encrypted files are hidden dotfiles: .filename.md.enc
			if (name.startsWith('.') && name.endsWith(ENC_EXT)) out.push(f);
		}
		for (const sub of folders) {
			const name = sub.split('/').pop() ?? sub;
			if (name.startsWith('.')) continue; // skip .obsidian, .trash, etc.
			await this.walkForEncFiles(sub, out);
		}
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	async loadPluginData() {
		const raw = (await this.loadData()) as PluginData | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		this.isLocked = raw?.isLocked ?? false;
		this.lockedFiles = raw?.lockedFiles ?? [];
		this.encryptedPassword = raw?.encryptedPassword;

		// Load the saved password from the native keychain, falling back to a
		// legacy safeStorage blob in data.json (returns null if undecryptable here).
		this.storedPassword = loadPassword(this.app, this.encryptedPassword);

		// One-time migration: if the password came from the legacy safeStorage blob
		// and the native keychain is now available, move it over and drop the blob.
		if (this.storedPassword && this.encryptedPassword && canPersistPassword(this.app)) {
			try {
				const { legacyBlob } = savePassword(this.app, this.storedPassword);
				if (legacyBlob === null) {
					// Successfully stored in the native keychain — remove the legacy blob
					this.encryptedPassword = undefined;
					await this.savePluginData();
				}
			} catch {
				// Migration is best-effort; keep using the legacy blob if it fails
			}
		}
	}

	async savePluginData() {
		const data: PluginData = {
			settings: this.settings,
			isLocked: this.isLocked,
			lockedFiles: this.lockedFiles,
			encryptedPassword: this.encryptedPassword,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Build the encrypted file path: insert a leading dot before the filename.
 *   'Notes/diary.md'  →  'Notes/.diary.md.enc'
 *   'diary.md'        →  '.diary.md.enc'
 *
 * Dotfiles are not indexed by Obsidian — they disappear from the file
 * explorer, search, Bases, and graph without any extra configuration.
 */
function toEncPath(filePath: string): string {
	const slash = filePath.lastIndexOf('/');
	return slash === -1
		? '.' + filePath + ENC_EXT
		: filePath.slice(0, slash + 1) + '.' + filePath.slice(slash + 1) + ENC_EXT;
}

/**
 * Reverse of toEncPath — used only in the fallback vault walk (no manifest).
 *   'Notes/.diary.md.enc'  →  'Notes/diary.md'
 *   '.diary.md.enc'        →  'diary.md'
 */
function fromEncPath(encPath: string): string {
	const withoutExt = encPath.slice(0, -ENC_EXT.length); // 'Notes/.diary.md'
	const slash = withoutExt.lastIndexOf('/');
	return slash === -1
		? withoutExt.slice(1)                                          // remove leading dot
		: withoutExt.slice(0, slash + 1) + withoutExt.slice(slash + 2); // remove dot after /
}

/**
 * Returns true when a frontmatter value should be treated as "secret = on".
 * Handles: boolean true, strings "true" / "yes" / "on" (YAML truthy aliases),
 * and the number 1 — covers all ways Obsidian may serialise a checkbox.
 */
function isSecretValue(val: unknown): boolean {
	return val === true || val === 1 || val === 'true' || val === 'yes' || val === 'on';
}

/**
 * Parse the raw YAML frontmatter block from file content and check whether
 * `prop` is set to a truthy value. Used when the metadata cache is empty.
 */
function rawFrontmatterHasProp(content: string, prop: string): boolean {
	const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!block) return false;
	const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Matches: prop: true  |  prop: "true"  |  prop: yes  |  prop: on  |  prop: 1
	return new RegExp(
		`^${escaped}\\s*:\\s*(true|"true"|'true'|yes|on|1)\\s*$`,
		'im',
	).test(block[1] ?? '');
}
