import { App, PluginSettingTab, Setting } from 'obsidian';
import type SecretHiderPlugin from './main';

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
	}
}
