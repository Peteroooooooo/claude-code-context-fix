const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  readClaudeUserSettings,
  findClaudeCodeExtDirs,
  applyPatchToDir,
  removePatchFromDir,
  getPatchStatus,
} = require('./patcher');

const OUTPUT = vscode.window.createOutputChannel('Claude Code Context Fix');

function log(msg) {
  OUTPUT.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function getTargetDirs() {
  const dirs = new Set();
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext && ext.extensionPath) {
    dirs.add(ext.extensionPath);
  }
  for (const d of findClaudeCodeExtDirs()) {
    dirs.add(d);
  }
  return [...dirs];
}

function getPatchConfig() {
  const cfg = vscode.workspace.getConfiguration('claudeCodeContextFix');
  return {
    enabled: cfg.get('enabled', true),
    overrideWindow: cfg.get('overrideWindow', 0),
    showTokenCounts: cfg.get('showTokenCounts', true),
    showBeforeFirstReply: cfg.get('showBeforeFirstReply', true),
    fallback: readClaudeUserSettings(),
  };
}

async function promptReload(message) {
  const choice = await vscode.window.showInformationMessage(message, 'Reload Window');
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function syncPatch({ interactive = false } = {}) {
  const dirs = getTargetDirs();
  if (dirs.length === 0) {
    log('anthropic.claude-code extension directory not found.');
    if (interactive) {
      vscode.window.showWarningMessage('Claude Code extension (anthropic.claude-code) not found.');
    }
    return;
  }

  const config = getPatchConfig();
  let anyChanged = false;

  for (const dir of dirs) {
    try {
      if (config.enabled) {
        const res = applyPatchToDir(dir, config);
        log(`${res.status}: ${res.jsPath}`);
        if (res.status === 'patched') anyChanged = true;
      } else {
        const res = removePatchFromDir(dir);
        log(`remove -> ${res.status}: ${res.jsPath}`);
        if (res.status === 'restored') anyChanged = true;
      }
    } catch (err) {
      log(`ERROR (${dir}): ${err.stack || err.message}`);
      if (interactive) {
        vscode.window.showErrorMessage(`Claude Code Context Fix failed: ${err.message}`);
      }
    }
  }

  if (anyChanged) {
    const msg = config.enabled
      ? 'Claude Code context indicator patch applied. Reload window for open tabs to pick up the change.'
      : 'Claude Code context indicator patch removed. Reload window to restore original behavior.';
    void promptReload(msg);
  } else if (interactive) {
    vscode.window.showInformationMessage(
      config.enabled
        ? 'Claude Code context indicator patch is already up to date.'
        : 'Claude Code context indicator patch is disabled and clean.'
    );
  }
}

function activate(context) {
  log('Activating Claude Code Context Fix...');

  let debounceTimer = null;
  const scheduleSync = (delayMs = 500) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void syncPatch({ interactive: false });
    }, delayMs);
  };

  void syncPatch({ interactive: false });

  context.subscriptions.push(
    vscode.extensions.onDidChange(() => scheduleSync(1000)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeContextFix')) {
        scheduleSync(200);
      }
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.enable', async () => {
      await vscode.workspace
        .getConfiguration('claudeCodeContextFix')
        .update('enabled', true, vscode.ConfigurationTarget.Global);
      await syncPatch({ interactive: true });
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.disable', async () => {
      await vscode.workspace
        .getConfiguration('claudeCodeContextFix')
        .update('enabled', false, vscode.ConfigurationTarget.Global);
      await syncPatch({ interactive: true });
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.reapply', async () => {
      await syncPatch({ interactive: true });
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.status', () => {
      const dirs = getTargetDirs();
      const settings = readClaudeUserSettings();
      const cfg = vscode.workspace.getConfiguration('claudeCodeContextFix');
      if (dirs.length === 0) {
        vscode.window.showWarningMessage('Claude Code extension not found.');
        return;
      }
      const statuses = dirs.map((d) => {
        const s = getPatchStatus(d);
        return `${path.basename(d)}: ${s.patched ? `patched v${s.version}` : 'unpatched'}${s.hasKatex ? ' (+KaTeX)' : ''}`;
      });
      const detectedWin =
        cfg.get('overrideWindow', 0) ||
        settings.envAutoCompactWindow ||
        settings.autoCompactWindow ||
        'model default';
      vscode.window.showInformationMessage(
        `Context Fix: ${statuses.join('; ')} | Detected auto-compact window: ${detectedWin}`
      );
    })
  );

  // Watch ~/.claude/settings.json so changes to CLAUDE_CODE_AUTO_COMPACT_WINDOW sync automatically
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  try {
    if (fs.existsSync(claudeDir)) {
      const watcher = fs.watch(claudeDir, (_event, filename) => {
        if (!filename || filename === 'settings.json') {
          scheduleSync(500);
        }
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    }
  } catch (err) {
    log(`Could not watch ${settingsFile}: ${err.message}`);
  }

  context.subscriptions.push({
    dispose: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
