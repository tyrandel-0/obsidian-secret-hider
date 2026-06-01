import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { encryptText, decryptText } from './crypto';
import { PasswordModal, PasswordConfirmModal } from './modals';
import { SecretHiderSettings, DEFAULT_SETTINGS, SecretHiderSettingTab } from './settings';

const ENC_EXT = '.enc';
const FILE_MARKER = 'OBSIDIAN-SECRET-HIDER-V1\n';

// Sentinel thrown when AES-GCM authentication fails (wrong password / corrupted data).
// Using a typed error lets us distinguish it from I/O errors without fragile string matching.
class WrongPasswordError extends Error {
	constructor() {
		super('wrong-password');
	}
}

interface PluginData {
	settings: SecretHiderSettings;
	isLocked: boolean;
}

export default class SecretHiderPlugin extends Plugin {
	settings!: SecretHiderSettings;
	private isLocked = false;
	private busy = false; // prevents concurrent lock/unlock operations
	private floatingBtn!: HTMLElement;

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

	// ── Lock ──────────────────────────────────────────────────────────────────

	private async lock() {
		const secretFiles = this.findSecretFiles();
		if (secretFiles.length === 0) {
			new Notice(`Secret Hider: no files with "${this.settings.secretProperty}: true" found.`);
			return;
		}

		const modal = new PasswordConfirmModal(this.app);
		modal.open();
		const password = await modal.result;
		if (!password) return; // user dismissed the modal

		try {
			await this.lockFiles(secretFiles, password);
			this.isLocked = true;
			await this.savePluginData();
			this.updateButtonUI();
			new Notice(`🔒 Secret Hider: locked ${secretFiles.length} file(s).`);
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
	 * Atomic lock sequence:
	 *   1. Read + encrypt all files to memory (no disk writes yet).
	 *   2. Write ALL .enc files. On any failure: roll back every .enc already written,
	 *      then throw — originals are untouched.
	 *   3. Only after all .enc writes succeed: delete the original .md files.
	 *      A delete failure here is safe because the .enc file already holds the data.
	 */
	private async lockFiles(files: TFile[], password: string) {
		// Close any open editor tabs before we delete the files
		for (const file of files) {
			this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file?.path === file.path) {
					leaf.detach();
				}
			});
		}

		// Phase 1: read + encrypt all to memory
		type Prepared = { file: TFile; encPath: string; encData: string };
		const prepared: Prepared[] = [];
		for (const file of files) {
			const content = await this.app.vault.read(file);
			const encrypted = await encryptText(content, password);
			prepared.push({
				file,
				encPath: file.path + ENC_EXT,
				encData: FILE_MARKER + encrypted,
			});
		}

		// Phase 2: write .enc files — roll back entirely on any failure
		const written: string[] = [];
		try {
			for (const { encPath, encData } of prepared) {
				await this.app.vault.adapter.write(encPath, encData);
				written.push(encPath);
			}
		} catch (e) {
			await Promise.allSettled(written.map(p => this.app.vault.adapter.remove(p)));
			throw new Error(
				`Could not write encrypted files (${(e as Error).message}). ` +
				`No original files were deleted.`,
			);
		}

		// Phase 3: all .enc files safely on disk — now delete originals
		for (const { file } of prepared) {
			try {
				await this.app.vault.delete(file);
			} catch (e) {
				// .enc file exists, so data is safe. Log and continue.
				console.error(`Secret Hider: could not delete ${file.path}:`, e);
			}
		}
	}

	// ── Unlock ────────────────────────────────────────────────────────────────

	private async unlock() {
		const modal = new PasswordModal(this.app);
		modal.open();
		const password = await modal.result;
		if (!password) return; // user dismissed

		try {
			const count = await this.unlockFiles(password);
			this.isLocked = false;
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
	 * Atomic unlock sequence:
	 *   1. Find all .enc files that belong to this plugin (FILE_MARKER check).
	 *   2. Decrypt ALL of them to memory first. Wrong password → throw before touching disk.
	 *   3. Write each .md back, then remove its .enc counterpart.
	 *      If a write fails: remaining .enc files are intact; user can retry.
	 *      If a remove fails: both .md and .enc exist — not data loss, retry cleans up.
	 */
	private async unlockFiles(password: string): Promise<number> {
		const encPaths = await this.findEncryptedFiles();
		if (encPaths.length === 0) {
			throw new Error('no encrypted files found in vault');
		}

		// Phase 1: decrypt all to memory — fail fast, no disk writes
		type Decrypted = { mdPath: string; encPath: string; content: string };
		const decrypted: Decrypted[] = [];
		for (const encPath of encPaths) {
			const raw = await this.app.vault.adapter.read(encPath);
			if (!raw.startsWith(FILE_MARKER)) continue; // not our file

			const encData = raw.slice(FILE_MARKER.length);
			try {
				const content = await decryptText(encData, password);
				decrypted.push({ mdPath: encPath.slice(0, -ENC_EXT.length), encPath, content });
			} catch {
				throw new WrongPasswordError();
			}
		}

		if (decrypted.length === 0) {
			throw new Error('no Secret Hider encrypted files found — wrong vault?');
		}

		// Phase 2: restore .md files and remove .enc counterparts, per-file
		for (const { mdPath, encPath, content } of decrypted) {
			await this.app.vault.adapter.write(mdPath, content);
			// Remove .enc only after .md is safely written
			try {
				await this.app.vault.adapter.remove(encPath);
			} catch (e) {
				// Both .md and .enc exist — not data loss. Log and continue.
				console.error(`Secret Hider: could not remove ${encPath}:`, e);
			}
		}

		return decrypted.length;
	}

	private async findEncryptedFiles(): Promise<string[]> {
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
			// Skip ALL hidden folders (.obsidian, .trash, .git, etc.)
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
	}

	async savePluginData() {
		const data: PluginData = { settings: this.settings, isLocked: this.isLocked };
		await this.saveData(data);
	}

	// Called by SecretHiderSettingTab after settings change
	async saveSettings() {
		await this.savePluginData();
	}
}
