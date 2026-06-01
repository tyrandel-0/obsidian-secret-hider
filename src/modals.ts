import { App, Modal, Setting } from 'obsidian';

export class PasswordModal extends Modal {
	private onSubmit: (password: string) => void;

	constructor(app: App, onSubmit: (password: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: '🔒 Unlock secret files' });

		let password = '';

		new Setting(contentEl).setName('Password').addText(text => {
			text.inputEl.type = 'password';
			text.inputEl.style.width = '100%';
			text.onChange(v => (password = v));
			text.inputEl.addEventListener('keydown', e => {
				if (e.key === 'Enter') this.submit(password);
			});
			setTimeout(() => text.inputEl.focus(), 50);
		});

		new Setting(contentEl).addButton(btn =>
			btn
				.setButtonText('Unlock')
				.setCta()
				.onClick(() => this.submit(password)),
		);
	}

	private submit(password: string) {
		this.close();
		this.onSubmit(password);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class PasswordConfirmModal extends Modal {
	private onSubmit: (password: string) => void;

	constructor(app: App, onSubmit: (password: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: '🔑 Lock secret files' });

		let password = '';
		let confirm = '';

		const errorEl = contentEl.createEl('p', { cls: 'secret-hider-error' });
		errorEl.style.display = 'none';

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
				if (e.key === 'Enter') this.submit(password, confirm, errorEl);
			});
		});

		new Setting(contentEl).addButton(btn =>
			btn
				.setButtonText('Lock files')
				.setCta()
				.onClick(() => this.submit(password, confirm, errorEl)),
		);
	}

	private submit(password: string, confirm: string, errorEl: HTMLElement) {
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
		this.close();
		this.onSubmit(password);
	}

	onClose() {
		this.contentEl.empty();
	}
}
