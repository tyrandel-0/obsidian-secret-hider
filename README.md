# Secret Hider

One-click AES-256-GCM encryption for private Obsidian notes. Mark a note with a frontmatter property, tap the floating button — the file disappears from the vault. Tap again, enter your password — it comes back.

## Features

- **AES-256-GCM** authenticated encryption (256-bit key, 12-byte random IV per file)
- **PBKDF2-SHA256** key derivation (100,000 iterations, 16-byte random salt)
- **One-click** floating button — always visible, works from any note
- **Hidden encrypted files** — stored as dotfiles (`.note.md.enc`), invisible to Obsidian's index, search, Bases, and graph
- **Atomic operations** — files are never lost if Obsidian crashes mid-operation
- **OS keychain integration** on desktop (macOS Keychain / Windows DPAPI)
- **Works on mobile** (iOS, Android) — password kept in memory for the session
- **iCloud / Obsidian Sync compatible**

## How to mark a note as secret

Add a `secret` property to the note's frontmatter. The easiest way is via Obsidian's Properties panel — add a **Checkbox** property named `secret` and check it.

The raw YAML looks like this:

```yaml
---
secret: true
---

Your private content here.
```

The property name is **case-insensitive** — `Secret`, `SECRET`, and `secret` all work.

## Usage

| Action | Result |
|--------|--------|
| Click 🔓 (unlocked) | Enter password → secret files are encrypted and hidden |
| Click 🔒 (locked) | Enter password → secret files are restored |
| Wrong password | Nothing changes — files stay encrypted |

## Installation

### BRAT (recommended for now)

1. Install **[BRAT](https://github.com/TfTHacker/obsidian42-brat)** from the community plugin browser
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `tyrandel-0/obsidian-secret-hider`
4. Enable the plugin in **Settings → Community plugins**

### Manual

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/tyrandel-0/obsidian-secret-hider/releases/latest)
2. Copy them to `{your vault}/.obsidian/plugins/obsidian-secret-hider/`
3. Enable the plugin in **Settings → Community plugins**

## Settings

**Secret property** (default: `secret`)
The frontmatter key used to identify secret notes. Change this if you want to use a different property name. Case-insensitive.

**Remember password**
Tick the "Remember password" toggle in the lock/unlock dialog (or use the Save password field in settings). The password is then stored in the keychain, and locking/unlocking happens with a single tap — no prompt.

Storage backend, in order of preference:
- **Obsidian's built-in keychain** (`app.secretStorage`, Obsidian 1.11.4+) — works on **both desktop and mobile**. The password lives in your OS credential store (macOS Keychain, Windows Credential Manager, Linux libsecret, iOS Keychain, Android Keystore) and appears under **Settings → Keychain**. Nothing sensitive is written to the vault.
- **Electron safeStorage** (older desktop builds) — OS-encrypted blob stored in the plugin's `data.json`.
- **Session-only** (older mobile) — password kept in memory until the app closes.

If you previously saved a password via the old Electron path, it is automatically migrated to the built-in keychain on first load.

> **Note:** Obsidian's keychain is per-vault and per-device. On iCloud/Sync setups the password is **not** synced — you enter it once per device, then it's remembered there.

## Security model

```
Plaintext  ──PBKDF2──▶  AES-256-GCM key
               │                │
           salt(16B)        encrypt
           stored in           │
           .enc file      IV(12B) + ciphertext
                               │
                          FILE_MARKER
                          + base64(salt+IV+ciphertext)
                               │
                          .note.md.enc  (dotfile, hidden from Obsidian)
```

- **Authenticated encryption** — AES-GCM verifies integrity; a tampered file fails to decrypt with a clear error
- **Wrong password → nothing happens** — decryption fails before any file is written
- **Desktop password storage** — encrypted with OS-level key (macOS Keychain, Windows DPAPI); copying `data.json` to another machine exposes nothing
- **Mobile** — password never touches disk; lives in JS memory only

## Sync behaviour (iCloud / Obsidian Sync)

Encrypted `.enc` files sync across devices like any other file. The workflow across devices:

1. Lock on Mac → `.enc` files appear in iCloud
2. Wait for iCloud to finish syncing (check the status indicator)
3. Open Obsidian on iPhone → plugin shows 🔒 → tap → enter password → files restored

> **Always wait for sync to complete** before unlocking on another device. If you unlock while sync is still in progress, only the files that have already synced will be restored. The rest remain encrypted and can be unlocked in a second pass.

## Limitations

- Attachments and images linked to secret notes are **not** encrypted
- All files locked in one session share the same key; different sessions may use different passwords (both work independently on unlock)
- `electron.safeStorage` is desktop-only; password saving is not available on mobile

## Building from source

```sh
git clone https://github.com/tyrandel-0/obsidian-secret-hider
cd obsidian-secret-hider
npm install
npm run build   # produces main.js
npm test        # runs 19 crypto unit tests
```

## License

MIT
