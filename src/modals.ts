import { App, Modal, Setting } from 'obsidian';

// Base class: resolves to the entered password, or null if the modal was dismissed.
// A Promise can only be settled once — calling resolve a second time is a no-op,
// so we can safely call resolve(null) in onClose even after a successful submit.
abstract class BasePasswordModal extends Modal {
	readonly result: Promise<string | null>;
	protected resolve!: (value: string | null) => void;

	constructor(app: App) {
		super(app);
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

		const submit = () => {
			this.resolve(password);
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
			this.resolve(password);
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

		new Setting(contentEl).addButton(btn =>
			btn.setButtonText('Lock files').setCta().onClick(submit),
		);
	}
}
