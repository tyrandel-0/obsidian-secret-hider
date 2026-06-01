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
import { isSecureStorageAvailable, encryptPassword, decryptPassword } from './password-storage';

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
	encryptedPassword?: string; // safeStorage-encrypted base64; never the plaintext
}

export default class SecretHiderPlugin extends Plugin {
	settings!: SecretHiderSettings;
	private isLocked = false;
	private lockedFiles: LockedFileEntry[] = [];
	private busy = false;
	private floatingBtn!: HTMLElement;

	// Password in memory (decrypted). Never written to disk in plain form.
	private storedPassword: string | null = null;
	// Encrypted password blob stored in data.json.
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
		this.encryptedPassword = encryptPassword(password);
		await this.savePluginData();
	}

	async forgetPassword() {
		this.storedPassword = null;
		this.encryptedPassword = undefined;
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
	 *   - If a password is saved in the OS keychain → return it immediately (no UI).
	 *   - Otherwise → open the appropriate modal and wait for user input.
	 *     mode='lock'   → PasswordConfirmModal (requires confirmation, sets password for this op)
	 *     mode='unlock' → PasswordModal (single field)
	 */
	private async getPassword(mode: 'lock' | 'unlock'): Promise<string | null> {
		if (this.storedPassword) return this.storedPassword;

		if (mode === 'lock') {
			const modal = new PasswordConfirmModal(this.app);
			modal.open();
			return modal.result;
		} else {
			const modal = new PasswordModal(this.app);
			modal.open();
			return modal.result;
		}
	}

	// ── Lock ──────────────────────────────────────────────────────────────────

	private async lock() {
		const secretFiles = this.findSecretFiles();
		if (secretFiles.length === 0) {
			new Notice(`Secret Hider: no files with "${this.settings.secretProperty}: true" found.`);
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

	private findSecretFiles(): TFile[] {
		const prop = this.settings.secretProperty;
		return this.app.vault.getMarkdownFiles().filter(file => {
			const cache = this.app.metadataCache.getFileCache(file);
			return cache?.frontmatter?.[prop] === true;
		});
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
				return { file, encPath: file.path + ENC_EXT, encData: FILE_MARKER + encrypted };
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
				encPath.slice(0, -ENC_EXT.length);

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
			if (f.endsWith(ENC_EXT)) out.push(f);
		}
		for (const sub of folders) {
			const name = sub.split('/').pop() ?? sub;
			if (name.startsWith('.')) continue;
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

		// Decrypt stored password if safeStorage is available on this machine
		if (this.encryptedPassword && isSecureStorageAvailable()) {
			try {
				this.storedPassword = decryptPassword(this.encryptedPassword);
			} catch {
				// Different machine / OS reinstall — key changed, treat as "no password"
				this.storedPassword = null;
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
