import { App, Modal, Setting } from 'obsidian';

export interface PasswordResult {
	password: string;
	remember: boolean;
}

// Base class: resolves to a PasswordResult, or null if the modal was dismissed.
// A Promise can only be settled once — calling resolve a second time is a no-op,
// so we can safely call resolve(null) in onClose even after a successful submit.
abstract class BasePasswordModal extends Modal {
	readonly result: Promise<PasswordResult | null>;
	protected resolve!: (value: PasswordResult | null) => void;
	// When true, show a "Remember password" checkbox (desktop with OS keychain).
	protected canRemember: boolean;

	constructor(app: App, canRemember: boolean) {
		super(app);
		this.canRemember = canRemember;
		this.result = new Promise(r => (this.resolve = r));
	}

	onClose() {
		this.resolve(null); // no-op if already resolved by submit
		this.contentEl.empty();
	}
}

export class PasswordModal extends BasePasswordModal {
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: '🔒 Unlock secret files' });

		let password = '';
		let remember = false;

		const submit = () => {
			this.resolve({ password, remember });
			this.close();
		};

		new Setting(contentEl).setName('Password').addText(text => {
			text.inputEl.type = 'password';
			text.inputEl.style.width = '100%';
			text.onChange(v => (password = v));
			text.inputEl.addEventListener('keydown', e => {
				if (e.key === 'Enter') submit();
			});
			setTimeout(() => text.inputEl.focus(), 50);
		});

		if (this.canRemember) {
			new Setting(contentEl)
				.setName('Remember password')
				.setDesc('Store it in the OS keychain so you are not asked again on this device.')
				.addToggle(t => t.onChange(v => (remember = v)));
		} else {
			const hint = contentEl.createEl('p');
			hint.style.cssText = 'font-size:0.85em; color:var(--text-muted); margin:4px 0 0;';
			hint.setText('Password is remembered until the app is closed.');
		}

		new Setting(contentEl).addButton(btn =>
			btn.setButtonText('Unlock').setCta().onClick(submit),
		);
	}
}

export class PasswordConfirmModal extends BasePasswordModal {
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: '🔑 Lock secret files' });

		let password = '';
		let confirm = '';
		let remember = false;

		const errorEl = contentEl.createEl('p', { cls: 'secret-hider-error' });
		errorEl.style.display = 'none';

		const submit = () => {
			if (!password) {
				errorEl.setText('Password cannot be empty.');
				errorEl.style.display = '';
				return;
			}
			if (password !== confirm) {
				errorEl.setText('Passwords do not match.');
				errorEl.style.display = '';
				return;
			}
			this.resolve({ password, remember });
			this.close();
		};

		new Setting(contentEl).setName('Password').addText(text => {
			text.inputEl.type = 'password';
			text.inputEl.style.width = '100%';
			text.onChange(v => (password = v));
			setTimeout(() => text.inputEl.focus(), 50);
		});

		new Setting(contentEl).setName('Confirm password').addText(text => {
			text.inputEl.type = 'password';
			text.inputEl.style.width = '100%';
			text.onChange(v => (confirm = v));
			text.inputEl.addEventListener('keydown', e => {
				if (e.key === 'Enter') submit();
			});
		});

		if (this.canRemember) {
			new Setting(contentEl)
				.setName('Remember password')
				.setDesc('Store it in the OS keychain so you are not asked again on this device.')
				.addToggle(t => t.onChange(v => (remember = v)));
		}

		new Setting(contentEl).addButton(btn =>
			btn.setButtonText('Lock files').setCta().onClick(submit),
		);
	}
}
