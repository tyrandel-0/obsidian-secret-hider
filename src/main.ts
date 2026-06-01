import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { encryptText, decryptText } from './crypto';
import { PasswordModal, PasswordConfirmModal } from './modals';
import { SecretHiderSettings, DEFAULT_SETTINGS, SecretHiderSettingTab } from './settings';

const ENC_EXT = '.enc';
const FILE_MARKER = 'OBSIDIAN-SECRET-HIDER-V1\n';

export default class SecretHiderPlugin extends Plugin {
	settings!: SecretHiderSettings;
	private isLocked = false;
	private floatingBtn!: HTMLElement;

	async onload() {
		await this.loadSettings();
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
		this.floatingBtn = document.body.createEl('div', {
			cls: 'secret-hider-btn secret-hider-btn--unlocked',
		});
		this.updateButtonUI();
		this.registerDomEvent(this.floatingBtn, 'click', () => this.handleToggle());
	}

	private updateButtonUI() {
		if (this.isLocked) {
			this.floatingBtn.setText('🔒');
			this.floatingBtn.setAttribute('aria-label', 'Secret files locked — click to unlock');
			this.floatingBtn.removeClass('secret-hider-btn--unlocked');
			this.floatingBtn.addClass('secret-hider-btn--locked');
		} else {
			this.floatingBtn.setText('🔓');
			this.floatingBtn.setAttribute('aria-label', 'Click to lock secret files');
			this.floatingBtn.removeClass('secret-hider-btn--locked');
			this.floatingBtn.addClass('secret-hider-btn--unlocked');
		}
	}

	// ── Toggle ────────────────────────────────────────────────────────────────

	private async handleToggle() {
		if (this.isLocked) {
			await this.unlock();
		} else {
			await this.lock();
		}
	}

	// ── Lock ──────────────────────────────────────────────────────────────────

	private async lock() {
		const secretFiles = this.findSecretFiles();

		if (secretFiles.length === 0) {
			new Notice(
				`Secret Hider: no files with "${this.settings.secretProperty}: true" found.`,
			);
			return;
		}

		new PasswordConfirmModal(this.app, async password => {
			try {
				await this.lockFiles(secretFiles, password);
				this.isLocked = true;
				this.updateButtonUI();
				new Notice(`🔒 Secret Hider: locked ${secretFiles.length} file(s).`);
			} catch (e) {
				new Notice(`Secret Hider: error while locking — ${(e as Error).message}`);
			}
		}).open();
	}

	private findSecretFiles(): TFile[] {
		const prop = this.settings.secretProperty;
		return this.app.vault.getMarkdownFiles().filter(file => {
			const cache = this.app.metadataCache.getFileCache(file);
			return cache?.frontmatter?.[prop] === true;
		});
	}

	private async lockFiles(files: TFile[], password: string) {
		// Close any open tabs for these files first
		for (const file of files) {
			this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file?.path === file.path) {
					leaf.detach();
				}
			});
		}

		for (const file of files) {
			const content = await this.app.vault.read(file);
			const encrypted = await encryptText(content, password);
			const encPath = file.path + ENC_EXT;
			await this.app.vault.adapter.write(encPath, FILE_MARKER + encrypted);
			await this.app.vault.delete(file);
		}
	}

	// ── Unlock ────────────────────────────────────────────────────────────────

	private async unlock() {
		new PasswordModal(this.app, async password => {
			try {
				const count = await this.unlockFiles(password);
				this.isLocked = false;
				this.updateButtonUI();
				new Notice(`🔓 Secret Hider: unlocked ${count} file(s).`);
			} catch (e) {
				const msg = (e as Error).message;
				const isWrongPassword = msg.includes('operation-specific') || msg.includes('decrypt');
				new Notice(
					isWrongPassword
						? 'Secret Hider: wrong password or corrupted files.'
						: `Secret Hider: ${msg}`,
				);
			}
		}).open();
	}

	private async unlockFiles(password: string): Promise<number> {
		const encPaths = await this.findEncryptedFiles();

		if (encPaths.length === 0) {
			throw new Error('no encrypted files found');
		}

		// Decrypt everything in memory first — fail fast before touching disk
		const decrypted: Array<{ mdPath: string; encPath: string; content: string }> = [];
		for (const encPath of encPaths) {
			const raw = await this.app.vault.adapter.read(encPath);
			if (!raw.startsWith(FILE_MARKER)) continue;

			const encData = raw.slice(FILE_MARKER.length);
			const content = await decryptText(encData, password); // throws on wrong password
			decrypted.push({ mdPath: encPath.slice(0, -ENC_EXT.length), encPath, content });
		}

		// All decrypted — now write back and remove .enc files
		for (const { mdPath, encPath, content } of decrypted) {
			await this.app.vault.adapter.write(mdPath, content);
			await this.app.vault.adapter.remove(encPath);
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
			if (sub === '.obsidian') continue;
			await this.walkForEncFiles(sub, out);
		}
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SecretHiderSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
