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

const ENC_EXT = '.enc';
const FILE_MARKER = 'OBSIDIAN-SECRET-HIDER-V1\n';

class WrongPasswordError extends Error {
	constructor() {
		super('wrong-password');
	}
}

/** Saved during lock so unlock can find the exact original paths without a vault walk. */
interface LockedFileEntry {
	originalPath: string; // 'Notes/diary.md'
	encPath: string;      // 'Notes/diary.md.enc'
}

interface PluginData {
	settings: SecretHiderSettings;
	isLocked: boolean;
	lockedFiles: LockedFileEntry[];
}

export default class SecretHiderPlugin extends Plugin {
	settings!: SecretHiderSettings;
	private isLocked = false;
	private lockedFiles: LockedFileEntry[] = [];
	private busy = false;
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
	 *
	 *   Phase 1: Derive key ONCE. Read + encrypt ALL files in parallel.
	 *            No disk writes yet — a failure here leaves everything intact.
	 *
	 *   Phase 2: Write ALL .enc files sequentially.
	 *            On any failure: roll back every .enc already written, throw.
	 *            Originals are untouched.
	 *
	 *   Phase 3: All .enc confirmed on disk → delete originals in parallel.
	 *            A delete failure is safe: .enc already holds the data.
	 *
	 * Returns a manifest of {originalPath, encPath} pairs for fast unlock.
	 */
	private async lockFiles(files: TFile[], password: string): Promise<LockedFileEntry[]> {
		// Close any open editor tabs first
		for (const file of files) {
			this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file?.path === file.path) {
					leaf.detach();
				}
			});
		}

		// Phase 1: derive key ONCE, then read + encrypt all files in parallel
		const { key, salt } = await createBatchKey(password);

		type Prepared = { file: TFile; encPath: string; encData: string };
		const prepared = await Promise.all(
			files.map(async (file): Promise<Prepared> => {
				const content = await this.app.vault.read(file);
				const encrypted = await encryptWithKey(content, key, salt);
				return { file, encPath: file.path + ENC_EXT, encData: FILE_MARKER + encrypted };
			}),
		);

		// Phase 2: write .enc files sequentially — roll back on any failure
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

		// Phase 3: all .enc files safely on disk — delete originals in parallel
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
		const modal = new PasswordModal(this.app);
		modal.open();
		const password = await modal.result;
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
	 *
	 *   Phase 1: Find .enc files via manifest (fast) or vault walk (fallback).
	 *            Read all in parallel. Group by embedded salt — derive 1 key per
	 *            unique salt (usually just 1 if locked in a single session).
	 *            Decrypt all in parallel. Wrong password → throw before any disk write.
	 *
	 *   Phase 2: Write all .md files sequentially (stop on first failure — .enc intact).
	 *            Remove all .enc files in parallel after writes succeed.
	 */
	private async unlockFiles(password: string): Promise<number> {
		// Resolve .enc paths: prefer manifest (O(1)), fall back to vault walk (O(vault))
		const encPaths =
			this.lockedFiles.length > 0
				? this.lockedFiles.map(e => e.encPath)
				: await this.findEncryptedFilesFallback();

		if (encPaths.length === 0) {
			throw new Error('no encrypted files found in vault');
		}

		// Phase 1a: read all .enc files in parallel (skip missing — may have been restored already)
		const readResults = await Promise.allSettled(
			encPaths.map(async encPath => ({ encPath, raw: await this.app.vault.adapter.read(encPath) })),
		);

		const ourFiles = readResults
			.filter(
				(r): r is PromiseFulfilledResult<{ encPath: string; raw: string }> =>
					r.status === 'fulfilled' && r.value.raw.startsWith(FILE_MARKER),
			)
			.map(r => r.value);

		if (ourFiles.length === 0) {
			throw new Error('no Secret Hider encrypted files found');
		}

		// Phase 1b: group by embedded salt → 1 PBKDF2 derivation per unique salt
		type DecEntry = { encPath: string; encData: string; mdPath: string };
		type SaltGroup = { salt: Uint8Array; entries: DecEntry[] };
		const saltGroups: SaltGroup[] = [];

		for (const { encPath, raw } of ourFiles) {
			const encData = raw.slice(FILE_MARKER.length);
			const salt = extractSalt(encData);

			// Use manifest's originalPath if available (prevents path-derivation bugs)
			const mdPath =
				this.lockedFiles.find(e => e.encPath === encPath)?.originalPath ??
				encPath.slice(0, -ENC_EXT.length);

			const group = saltGroups.find(
				g => g.salt.length === salt.length && g.salt.every((b, i) => b === salt[i]),
			);
			if (group) {
				group.entries.push({ encPath, encData, mdPath });
			} else {
				saltGroups.push({ salt, entries: [{ encPath, encData, mdPath }] });
			}
		}

		// Phase 1c: decrypt all in parallel, grouped by salt (1 PBKDF2 per group)
		type Decrypted = { mdPath: string; encPath: string; content: string };
		const decrypted: Decrypted[] = [];

		for (const { salt, entries } of saltGroups) {
			const key = await deriveKeyForSalt(password, salt);

			const results = await Promise.all(
				entries.map(async ({ encPath, encData, mdPath }): Promise<Decrypted> => {
					try {
						const content = await decryptWithKey(encData, key);
						return { mdPath, encPath, content };
					} catch {
						throw new WrongPasswordError();
					}
				}),
			);
			decrypted.push(...results);
		}

		// Phase 2a: write all .md files sequentially
		// Stop on first failure — unwritten files still have their .enc intact.
		for (const { mdPath, content } of decrypted) {
			await this.app.vault.adapter.write(mdPath, content);
		}

		// Phase 2b: all .md written — remove .enc files in parallel
		await Promise.allSettled(
			decrypted.map(({ encPath }) =>
				this.app.vault.adapter.remove(encPath).catch(e => {
					console.error(`Secret Hider: could not remove ${encPath}:`, e);
				}),
			),
		);

		return decrypted.length;
	}

	/** Fallback vault walk — used only when manifest is missing (migration / data loss recovery). */
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
			if (name.startsWith('.')) continue; // skip .obsidian, .trash, .git, etc.
			await this.walkForEncFiles(sub, out);
		}
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	async loadPluginData() {
		const raw = (await this.loadData()) as PluginData | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		this.isLocked = raw?.isLocked ?? false;
		this.lockedFiles = raw?.lockedFiles ?? [];
	}

	async savePluginData() {
		const data: PluginData = {
			settings: this.settings,
			isLocked: this.isLocked,
			lockedFiles: this.lockedFiles,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}
}
