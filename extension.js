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
const { FILES_CHANGED_ERROR_CODE } = require('./patch-files');

const OUTPUT = vscode.window.createOutputChannel('Claude Code Context Fix');
const RETRY_DELAYS_MS = [1000, 3000, 8000, 15000];
const TRANSIENT_FS_CODES = new Set([FILES_CHANGED_ERROR_CODE, 'EBUSY', 'EPERM', 'EACCES', 'ENOENT']);

function log(msg) {
  OUTPUT.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function getTargetDirs() {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext && ext.extensionPath && fs.existsSync(path.join(ext.extensionPath, 'webview', 'index.js'))) {
    return [ext.extensionPath];
  }
  return findClaudeCodeExtDirs();
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

function isTransientError(err) {
  return Boolean(err && TRANSIENT_FS_CODES.has(err.code));
}

async function promptReload(message, { autoReloadWebview = false } = {}) {
  if (autoReloadWebview) {
    try {
      await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
    } catch {
      // webview reload command may be unavailable if no webview is focused
    }
  }
  const choice = await vscode.window.showInformationMessage(
    message,
    'Reload Webview',
    'Reload Window'
  );
  if (choice === 'Reload Webview') {
    try {
      await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
    } catch {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

function activate(context) {
  log('Activating Claude Code Context Fix...');

  let debounceTimer = null;
  let retryTimer = null;
  let lastNotifiedError = null;
  let syncInFlight = false;
  let pendingSyncOpts = null;

  function clearTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  async function runSync({ interactive = false, autoReloadWebview = false, attempt = 0 } = {}) {
    if (syncInFlight) {
      pendingSyncOpts = {
        interactive: Boolean(pendingSyncOpts?.interactive || interactive),
        autoReloadWebview: Boolean(pendingSyncOpts?.autoReloadWebview || autoReloadWebview),
        attempt: 0,
      };
      return;
    }

    syncInFlight = true;
    try {
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
      let retryNeeded = false;
      const errors = [];

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
          log(`ERROR (${dir}, attempt ${attempt + 1}): ${err.stack || err.message}`);
          if (isTransientError(err) && attempt < RETRY_DELAYS_MS.length) {
            retryNeeded = true;
          } else {
            errors.push(err);
          }
        }
      }

      if (errors.length === 0 && !retryNeeded) {
        lastNotifiedError = null;
      }

      if (retryNeeded) {
        const delay = RETRY_DELAYS_MS[attempt];
        log(`Transient file change/lock; scheduling retry #${attempt + 2} in ${delay}ms.`);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void runSync({ interactive, autoReloadWebview, attempt: attempt + 1 });
        }, delay);
      } else if (errors.length > 0) {
        const errMsg = errors[0].message || String(errors[0]);
        if (interactive) {
          const choice = await vscode.window.showErrorMessage(
            `Claude Code Context Fix failed: ${errMsg}`,
            'Show Log'
          );
          if (choice === 'Show Log') OUTPUT.show(true);
        } else if (lastNotifiedError !== errMsg) {
          lastNotifiedError = errMsg;
          const choice = await vscode.window.showWarningMessage(
            `Claude Code Context Fix could not patch Claude Code (${errMsg}). The context ring fell back to Claude Code's native behavior.`,
            'Show Log',
            'Retry'
          );
          if (choice === 'Show Log') {
            OUTPUT.show(true);
          } else if (choice === 'Retry') {
            void runSync({ interactive: true, autoReloadWebview: true, attempt: 0 });
          }
        }
      }

      if (anyChanged) {
        const msg = config.enabled
          ? 'Claude Code context indicator patch applied. Reload webview or window if open tabs still show the old limit.'
          : 'Claude Code context indicator patch removed. Reload webview or window to restore original behavior.';
        void promptReload(msg, { autoReloadWebview });
      } else if (interactive && errors.length === 0 && !retryNeeded) {
        vscode.window.showInformationMessage(
          config.enabled
            ? 'Claude Code context indicator patch is already up to date.'
            : 'Claude Code context indicator patch is disabled and clean.'
        );
      }
    } finally {
      syncInFlight = false;
      if (pendingSyncOpts) {
        const next = pendingSyncOpts;
        pendingSyncOpts = null;
        void runSync(next);
      }
    }
  }

  const scheduleSync = (delayMs = 500, opts = {}) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSync({ interactive: false, ...opts, attempt: 0 });
    }, delayMs);
  };

  void runSync({ interactive: false, autoReloadWebview: true, attempt: 0 });

  context.subscriptions.push(
    vscode.extensions.onDidChange(() => scheduleSync(1000, { autoReloadWebview: true })),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeContextFix')) {
        scheduleSync(200, { autoReloadWebview: false });
      }
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.enable', async () => {
      await vscode.workspace
        .getConfiguration('claudeCodeContextFix')
        .update('enabled', true, vscode.ConfigurationTarget.Global);
      await runSync({ interactive: true, autoReloadWebview: true });
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.disable', async () => {
      await vscode.workspace
        .getConfiguration('claudeCodeContextFix')
        .update('enabled', false, vscode.ConfigurationTarget.Global);
      await runSync({ interactive: true, autoReloadWebview: true });
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.reapply', async () => {
      await runSync({ interactive: true, autoReloadWebview: true });
    }),
    vscode.commands.registerCommand('claudeCodeContextFix.status', async () => {
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
      const anyUnpatched = dirs.some((d) => !getPatchStatus(d).patched);
      const buttons = anyUnpatched && cfg.get('enabled', true)
        ? ['Reapply Patch', 'Show Log']
        : ['Show Log'];
      const choice = await vscode.window.showInformationMessage(
        `Context Fix: ${statuses.join('; ')} | Auto-compact window: ${detectedWin}`,
        ...buttons
      );
      if (choice === 'Reapply Patch') {
        await runSync({ interactive: true, autoReloadWebview: true });
      } else if (choice === 'Show Log') {
        OUTPUT.show(true);
      }
    })
  );

  // Watch ~/.claude/settings.json so changes to CLAUDE_CODE_AUTO_COMPACT_WINDOW sync automatically
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  try {
    if (fs.existsSync(claudeDir)) {
      const watcher = fs.watch(claudeDir, (_event, filename) => {
        if (!filename || filename === 'settings.json') {
          scheduleSync(500, { autoReloadWebview: false });
        }
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    }
  } catch (err) {
    log(`Could not watch ${settingsFile}: ${err.message}`);
  }

  context.subscriptions.push({
    dispose: () => {
      clearTimers();
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
