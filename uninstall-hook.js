const { findClaudeCodeExtDirs, removePatchFromDir } = require('./patcher');

function cleanupAll() {
  const dirs = findClaudeCodeExtDirs();
  for (const dir of dirs) {
    try {
      removePatchFromDir(dir);
    } catch (err) {
      console.warn('[Claude Code Context Fix] Failed to restore ' + dir + ': ' + err.message);
    }
  }
}

if (require.main === module) {
  cleanupAll();
}

module.exports = { cleanupAll };
