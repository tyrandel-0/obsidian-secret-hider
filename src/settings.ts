import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SecretHiderPlugin from './main';
import { isSecureStorageAvailable } from './password-storage';

export interface SecretHiderSettings {
	secretProperty: string;
}

export const DEFAULT_SETTINGS: SecretHiderSettings = {
	secretProperty: 'secret',
};

export class SecretHiderSettingTab extends PluginSettingTab {
	plugin: SecretHiderPlugin;

	constructor(app: App, plugin: SecretHiderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		// ── General ───────────────────────────────────────────────────────────

		containerEl.createEl('h2', { text: 'Secret Hider' });

		new Setting(containerEl)
			.setName('Secret property')
			.setDesc(
				'YAML frontmatter property that marks a file as secret. ' +
				'Files with this property set to true will be encrypted when locked. ' +
				'Example: add "secret: true" to a note\'s frontmatter.',
			)
			.addText(text =>
				text
					.setPlaceholder('secret')
					.setValue(this.plugin.settings.secretProperty)
					.onChange(async value => {
						this.plugin.settings.secretProperty = value.trim() || 'secret';
						await this.plugin.saveSettings();
					}),
			);

		// ── Password storage ──────────────────────────────────────────────────

		containerEl.createEl('h2', { text: 'Password' });

		const available = isSecureStorageAvailable();

		if (!available) {
			// Show a warning if the OS cannot provide secure storage (some Linux configs)
			const warn = containerEl.createEl('p', {
				cls: 'secret-hider-error',
				text: '⚠ Secure OS storage is not available on this device (no GNOME Keyring / KWallet detected). '
					+ 'Password cannot be saved — you will need to enter it manually each time.',
			});
			warn.style.marginBottom = '12px';
			return;
		}

		const hasPassword = this.plugin.hasStoredPassword;

		if (hasPassword) {
			// Password is already saved — show status, reveal button, forget button
			new Setting(containerEl)
				.setName('Saved password')
				.setDesc(
					'Stored in the OS keychain. Lock/unlock happens without a prompt on this device. ' +
					'On other devices (iPhone, another Mac) you will need to type it manually — ' +
					'use "Show" to see it and memorise it.',
				)
				.addButton(btn => {
					let revealed = false;
					btn.setButtonText('Show').onClick(() => {
						revealed = !revealed;
						const pw = this.plugin.getStoredPasswordForDisplay();
						pwRevealEl.setText(revealed ? pw : '');
						pwRevealEl.style.display = revealed ? '' : 'none';
						btn.setButtonText(revealed ? 'Hide' : 'Show');
					});
				})
				.addButton(btn =>
					btn
						.setButtonText('Forget')
						.setWarning()
						.onClick(async () => {
							await this.plugin.forgetPassword();
							new Notice('Secret Hider: password forgotten.');
							this.display();
						}),
				);

			// Revealed password display (hidden by default)
			const pwRevealEl = containerEl.createEl('p');
			pwRevealEl.style.cssText =
				'font-family:monospace; font-size:1.1em; letter-spacing:0.05em; ' +
				'padding:8px 12px; background:var(--background-secondary); ' +
				'border-radius:4px; display:none; margin:0 0 12px;';

		} else {
			// No password saved — show input + Save button
			new Setting(containerEl)
				.setName('Save password')
				.setDesc(
					'Password will be encrypted by the OS and stored in the keychain. ' +
					'It is machine-specific: if you open this vault on another device, ' +
					'you will be prompted to enter the password once on that device too.',
				);

			let draft = '';
			let draftConfirm = '';

			const errorEl = containerEl.createEl('p', { cls: 'secret-hider-error' });
			errorEl.style.display = 'none';

			new Setting(containerEl).setName('New password').addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.width = '220px';
				text.onChange(v => (draft = v));
			});

			new Setting(containerEl).setName('Confirm password').addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.width = '220px';
				text.onChange(v => (draftConfirm = v));
			});

			new Setting(containerEl).addButton(btn =>
				btn
					.setButtonText('Save password')
					.setCta()
					.onClick(async () => {
						if (!draft) {
							errorEl.setText('Password cannot be empty.');
							errorEl.style.display = '';
							return;
						}
						if (draft !== draftConfirm) {
							errorEl.setText('Passwords do not match.');
							errorEl.style.display = '';
							return;
						}
						await this.plugin.setAndSavePassword(draft);
						new Notice('Secret Hider: password saved to OS keychain.');
						this.display(); // re-render to show "Saved" state
					}),
			);
		}

		// ── Hint ─────────────────────────────────────────────────────────────

		const hint = containerEl.createEl('p');
		hint.style.cssText = 'font-size:0.85em; color:var(--text-muted); margin-top:8px;';
		hint.setText(
			'Even with a saved password, the files on disk are always AES-256-GCM encrypted. ' +
			'The OS keychain only stores the key that unlocks them — it never touches your files directly.',
		);
	}
}
