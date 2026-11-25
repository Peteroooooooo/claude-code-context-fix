const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  PATCH_VERSION,
  parseTokenSize,
  parsePctOverride,
  readClaudeUserSettings,
  patchWebviewCode,
  unpatchWebviewCode,
  getPatchVersion,
  applyPatchToDir,
  removePatchFromDir,
  getPatchStatus,
} = require('../patcher');

const EXT_DIR = path.join(
  os.homedir(),
  '.vscode',
  'extensions',
  'anthropic.claude-code-2.1.331-win32-x64'
);

function runInjectedHelpers(patchedCode) {
  const start = patchedCode.indexOf(';(function(G){');
  assert.notEqual(start, -1, 'Injected helper IIFE should exist');
  const end = patchedCode.indexOf('})(globalThis);', start);
  assert.notEqual(end, -1, 'Injected helper IIFE end should exist');
  const snippet = patchedCode.slice(start, end + '})(globalThis);'.length);
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(snippet, sandbox);
  return sandbox;
}

const gk = (win, maxOut) => win - Math.min(maxOut, 20000) - 13000;

test('parseTokenSize & parsePctOverride handle numbers, suffixes, and bounds', () => {
  assert.equal(parseTokenSize(350000), 350000);
  assert.equal(parseTokenSize('350k'), 350000);
  assert.equal(parseTokenSize('1M'), 1000000);
  assert.equal(parseTokenSize('auto'), undefined);
  assert.equal(parseTokenSize('50000'), undefined);
  assert.equal(parseTokenSize('99k'), undefined);
  assert.equal(parsePctOverride('80'), 80);
  assert.equal(parsePctOverride('0'), undefined);
  assert.equal(parsePctOverride('101'), undefined);
});

test('runtime helper matches Claude Code auto-compact threshold math', () => {
  const minimalBundle =
    'function GK(e,t){return e-Math.min(t,20000)-13000}' +
    'function nfe({usedTokens:e,contextWindow:t,threshold:n,onCompact:o,buttonClassName:r}){let i=t>0?Math.min(e/t*100,100):0;if(t===0||i<=n)return null;return u(iWe,{percentageUsed:i,onCompact:o,buttonClassName:r})}' +
    'function iWe({percentageUsed:e,onCompact:t,buttonClassName:n}){let[o,r]=T(!1),i=100-e;return h("div",{className:jl.host,children:[u("button",{type:"button",className:`${U9.usage} ${n??""}`,"aria-label":`${Math.round(e)}% context used — click to compact`,onClick:t,onMouseEnter:()=>r(!0),onMouseLeave:()=>r(!1),children:u(tfe,{percentage:e,className:U9.pie})}),o&&u(l0,{text:`${Math.round(i)}% of context remaining until auto-compact.`,hint:"Click to compact now."})]})}' +
    'u(nfe,{usedTokens:e.usageData.value.totalTokens,contextWindow:GK(e.usageData.value.contextWindow,e.usageData.value.maxOutputTokens),threshold:t,onCompact:c,buttonClassName:Hn.usageButtonV2});';

  const patched = patchWebviewCode(minimalBundle, { showTokenCounts: true });
  const sb = runInjectedHelpers(patched);

  // Case 1: 1M model + 350k CLAUDE_CODE_AUTO_COMPACT_WINDOW
  const sess1 = {
    usageData: { value: { totalTokens: 28648, contextWindow: 1000000, maxOutputTokens: 64000 } },
    currentMainLoopModel: { value: 'claude-sonnet-5[1m]' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(sess1, gk), 317000);
  assert.equal(sb.__ccCtxFixFmt(28648), '28.6k');
  assert.equal(sb.__ccCtxFixFmt(317000), '317k');

  // Case 2: per-model autoCompactWindow when no env override
  const sess2 = {
    usageData: { value: { totalTokens: 50000, contextWindow: 1000000, maxOutputTokens: 64000 } },
    currentModelInfo: { value: { resolvedModel: 'claude-sonnet-5[1m]' } },
    config: {
      value: {
        claudeSettings: {
          effective: {
            env: {},
            modelSettings: { 'claude-sonnet-5': { autoCompactWindow: 400000 } },
          },
        },
      },
    },
  };
  assert.equal(sb.__ccCtxFixLimit(sess2, gk), 367000);

  // Case 3: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 lowers threshold further
  const sess3 = {
    usageData: { value: { totalTokens: 50000, contextWindow: 1000000, maxOutputTokens: 64000 } },
    config: {
      value: {
        claudeSettings: {
          effective: {
            env: {
              CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000',
              CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
            },
          },
        },
      },
    },
  };
  assert.equal(sb.__ccCtxFixLimit(sess3, gk), 264000);

  // Case 4: no auto-compact cap -> raw 967000
  const sess4 = {
    usageData: { value: { totalTokens: 50000, contextWindow: 1000000, maxOutputTokens: 64000 } },
    config: { value: { claudeSettings: { effective: { env: {} } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(sess4, gk), 967000);

  // Case 5: manual VS Code overrideWindow wins
  const patchedOverride = patchWebviewCode(minimalBundle, { overrideWindow: 500000 });
  const sbOverride = runInjectedHelpers(patchedOverride);
  assert.equal(sbOverride.__ccCtxFixLimit(sess1, gk), 467000);

  // Case 6: empty new session before first reply (usageData all zeros)
  const emptySess1m = {
    usageData: { value: { totalTokens: 0, contextWindow: 0, maxOutputTokens: 0 } },
    currentMainLoopModel: { value: 'claude-sonnet-5[1m]' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(emptySess1m, gk), 317000);
  assert.equal(sb.__ccCtxFixRawLimit(emptySess1m, gk), 967000);

  const emptySess200k = {
    usageData: { value: { totalTokens: 0, contextWindow: 0, maxOutputTokens: 0 } },
    currentMainLoopModel: { value: 'claude-haiku-4-5' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(emptySess200k, gk), 167000);

  // Unpatch restores byte-for-byte
  const { code: restored, changed } = unpatchWebviewCode(patched);
  assert.equal(changed, true);
  assert.equal(restored, minimalBundle);

  // Also execute the patched nfe + iWe + callsite in a mock Preact/React sandbox
  const uMock = (comp, props) => (typeof comp === 'function' ? comp(props) : { comp, props });
  const hMock = (tag, props) => ({ tag, props });
  const sb2 = {
    globalThis: null,
    u: uMock,
    h: hMock,
    T: () => [true, () => {}],
    jl: { host: 'host_cls' },
    U9: { usage: 'usage_cls', pie: 'pie_cls' },
    tfe: 'PIE',
    l0: 'TOOLTIP',
    Hn: { usageButtonV2: 'btn_v2' },
    GK: gk,
    e: sess1,
    t: 0,
    c: () => {},
  };
  sb2.globalThis = sb2;
  const callIdx = patched.lastIndexOf('/* === Claude Code Context Fix Patch');
  assert.notEqual(callIdx, -1);
  const evalCode = patched.slice(0, callIdx) + ';sbResult=' + patched.slice(callIdx);
  vm.runInNewContext(evalCode, sb2);
  const rendered = sb2.sbResult;
  assert.equal(rendered.tag, 'div');
  const buttonNode = rendered.props.children[0];
  const tooltipNode = rendered.props.children[1];
  assert.equal(buttonNode.props['aria-label'], '9% context used (28.6k / 317k) — click to compact');
  assert.equal(tooltipNode.props.text, '91% of context remaining until auto-compact. (28.6k / 317k) · Model max 967k');

  // Empty new session with threshold=0 renders 0 / 317k immediately
  sb2.e = emptySess1m;
  sb2.t = 0;
  vm.runInNewContext(evalCode, sb2);
  assert.equal(sb2.sbResult.props.children[0].props['aria-label'], '0% context used (0 / 317k) — click to compact');
  assert.equal(sb2.sbResult.props.children[1].props.text, '100% of context remaining until auto-compact. (0 / 317k) · Model max 967k');

  // Empty new session with threshold=50 remains hidden
  sb2.t = 50;
  vm.runInNewContext(evalCode, sb2);
  assert.equal(sb2.sbResult, null);

  // Empty new session with showBeforeFirstReply=false remains hidden even at threshold=0
  const patchedNoZero = patchWebviewCode(minimalBundle, { showBeforeFirstReply: false });
  const sb3 = { ...sb2, globalThis: null, e: emptySess1m, t: 0, sbResult: undefined };
  sb3.globalThis = sb3;
  const callIdx3 = patchedNoZero.lastIndexOf('/* === Claude Code Context Fix Patch');
  vm.runInNewContext(patchedNoZero.slice(0, callIdx3) + ';sbResult=' + patchedNoZero.slice(callIdx3), sb3);
  assert.equal(sb3.sbResult, null);
});

test('real Claude Code webview/index.js (and katex-bak if present) patches, validates, and restores cleanly', (t) => {
  if (!fs.existsSync(path.join(EXT_DIR, 'webview', 'index.js'))) {
    t.skip('Local anthropic.claude-code extension not installed');
    return;
  }

  const targets = [path.join(EXT_DIR, 'webview', 'index.js')];
  const bak = path.join(EXT_DIR, 'webview', 'index.js.katex-bak');
  if (fs.existsSync(bak)) targets.push(bak);

  const userSettings = readClaudeUserSettings();
  for (const target of targets) {
    const onDisk = fs.readFileSync(target, 'utf8');
    const { code: baseline } = unpatchWebviewCode(onDisk);
    const patched = patchWebviewCode(onDisk, { fallback: userSettings, showTokenCounts: true });
    assert.equal(getPatchVersion(patched), PATCH_VERSION);

    // Check KaTeX patch stayed intact if present
    if (baseline.includes('/* === KaTeX LaTeX Rendering Patch === */')) {
      assert.ok(patched.includes('/* === KaTeX LaTeX Rendering Patch === */'));
    }

    // Re-patching with different config must remain idempotent and reversible
    const repatched = patchWebviewCode(patched, { overrideWindow: 400000, showTokenCounts: false });
    assert.equal(getPatchVersion(repatched), PATCH_VERSION);

    const { code: restored, changed } = unpatchWebviewCode(repatched);
    assert.equal(changed, true);
    assert.equal(restored, baseline, `Byte-for-byte mismatch when restoring ${path.basename(target)}`);
  }
});

test('applyPatchToDir & removePatchFromDir work atomically in temp extension copy', () => {
  const realJs = path.join(EXT_DIR, 'webview', 'index.js');
  if (!fs.existsSync(realJs)) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-fix-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'webview'));
    const origContent = fs.readFileSync(realJs, 'utf8');
    const { code: baseline } = unpatchWebviewCode(origContent);
    fs.writeFileSync(path.join(tmpDir, 'webview', 'index.js'), origContent, 'utf8');

    const r1 = applyPatchToDir(tmpDir, { fallback: readClaudeUserSettings(), showTokenCounts: true });
    assert.equal(r1.status, 'patched');
    assert.equal(getPatchStatus(tmpDir).patched, true);

    const r2 = applyPatchToDir(tmpDir, { fallback: readClaudeUserSettings(), showTokenCounts: true });
    assert.equal(r2.status, 'unchanged');

    const r3 = removePatchFromDir(tmpDir);
    assert.equal(r3.status, 'restored');
    assert.equal(getPatchStatus(tmpDir).patched, false);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'webview', 'index.js'), 'utf8'), baseline);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
