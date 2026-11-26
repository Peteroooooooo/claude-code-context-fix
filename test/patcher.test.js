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
  compareExtVersion,
  findClaudeCodeExtDirs,
  applyPatchToDir,
  removePatchFromDir,
  getPatchStatus,
} = require('../patcher');

const EXT_DIR = findClaudeCodeExtDirs()[0] || '';

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

function stripPatchComments(code) {
  return code;
}

const gk = (win, maxOut) => win - Math.min(maxOut, 20000) - 13000;

test('parseTokenSize, parsePctOverride & compareExtVersion handle edge cases', () => {
  assert.equal(parseTokenSize(350000), 350000);
  assert.equal(parseTokenSize('350k'), 350000);
  assert.equal(parseTokenSize('1M'), 1000000);
  assert.equal(parseTokenSize('auto'), undefined);
  assert.equal(parseTokenSize('50000'), undefined);
  assert.equal(parseTokenSize('99k'), undefined);
  assert.equal(parsePctOverride('80'), 80);
  assert.equal(parsePctOverride('0'), undefined);
  assert.equal(parsePctOverride('101'), undefined);
  assert.ok(compareExtVersion('anthropic.claude-code-2.1.10-win32-x64', 'anthropic.claude-code-2.1.9-win32-x64') > 0);
  assert.ok(compareExtVersion('anthropic.claude-code-2.1.332-win32-x64', 'anthropic.claude-code-2.1.331-win32-x64') > 0);
});

test('patches legacy 2.1.331 format and matches auto-compact threshold math', () => {
  const bundle331 =
    'function GK(e,t){return e-Math.min(t,20000)-13000}' +
    'function nfe({usedTokens:e,contextWindow:t,threshold:n,onCompact:o,buttonClassName:r}){let i=t>0?Math.min(e/t*100,100):0;if(t===0||i<=n)return null;return u(iWe,{percentageUsed:i,onCompact:o,buttonClassName:r})}' +
    'function iWe({percentageUsed:e,onCompact:t,buttonClassName:n}){let[o,r]=T(!1),i=100-e;return h("div",{className:jl.host,children:[u("button",{type:"button",className:`${U9.usage} ${n??""}`,"aria-label":`${Math.round(e)}% context used — click to compact`,onClick:t,onMouseEnter:()=>r(!0),onMouseLeave:()=>r(!1),children:u(tfe,{percentage:e,className:U9.pie})}),o&&u(l0,{text:`${Math.round(i)}% of context remaining until auto-compact.`,hint:"Click to compact now."})]})}' +
    'u(nfe,{usedTokens:e.usageData.value.totalTokens,contextWindow:GK(e.usageData.value.contextWindow,e.usageData.value.maxOutputTokens),threshold:t,onCompact:c,buttonClassName:Hn.usageButtonV2});';

  const patched = patchWebviewCode(bundle331, { showTokenCounts: true });
  const sb = runInjectedHelpers(patched);

  const sess1 = {
    usageData: { value: { totalTokens: 28648, contextWindow: 1000000, maxOutputTokens: 64000 } },
    currentMainLoopModel: { value: 'claude-sonnet-5[1m]' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(sess1, gk), 317000);
  assert.equal(sb.__ccCtxFixFmt(28648), '28.6k');
  assert.equal(sb.__ccCtxFixFmt(317000), '317k');

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

  const sess4 = {
    usageData: { value: { totalTokens: 50000, contextWindow: 1000000, maxOutputTokens: 64000 } },
    config: { value: { claudeSettings: { effective: { env: {} } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(sess4, gk), 967000);

  const patchedOverride = patchWebviewCode(bundle331, { overrideWindow: 500000 });
  const sbOverride = runInjectedHelpers(patchedOverride);
  assert.equal(sbOverride.__ccCtxFixLimit(sess1, gk), 467000);

  const emptySess1m = {
    usageData: { value: { totalTokens: 0, contextWindow: 0, maxOutputTokens: 0 } },
    currentMainLoopModel: { value: 'claude-sonnet-5[1m]' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(emptySess1m, 0), 317000);
  assert.equal(sb.__ccCtxFixRawLimit(emptySess1m, 0), 967000);

  const emptySess200k = {
    usageData: { value: { totalTokens: 0, contextWindow: 0, maxOutputTokens: 0 } },
    currentMainLoopModel: { value: 'claude-haiku-4-5' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  assert.equal(sb.__ccCtxFixLimit(emptySess200k, 0), 167000);

  const { code: restored, changed } = unpatchWebviewCode(patched);
  assert.equal(changed, true);
  assert.equal(restored, bundle331);
});

test('patches 2.1.332 contextGaugeFull + accessible kFe format while preserving keyboard handlers', () => {
  const bundle332 =
    'function vle({usedTokens:e,contextWindow:t,threshold:n,onCompact:o,onShowContextUsage:r,buttonClassName:i}){let s=t>0?Math.min(e/t*100,100):0;if(t===0||s<=n)return null;return u(kFe,{percentageUsed:s,onCompact:o,...void 0,buttonClassName:i})}' +
    'function kFe({percentageUsed:e,onCompact:t,onShowContextUsage:n,buttonClassName:o}){let[r,i]=_(!1),[s,a]=_(!1),l=100-e;return g("div",{className:rl.host,children:[u("button",{type:"button",className:`${J4.usage} ${o??""}`,"aria-label":`${Math.round(e)}% context used, click to compact`,onClick:()=>{a(!1),t()},...void 0,onMouseEnter:()=>i(!0),onMouseLeave:()=>i(!1),onFocus:(d)=>a(d.currentTarget.matches(":focus-visible")),onBlur:()=>a(!1),onKeyDown:(d)=>{if(d.key==="Escape"&&s)d.preventDefault(),a(!1),i(!1)},children:u(yle,{percentage:e,className:J4.pie})}),(r||s)&&u(Vg,{text:`${Math.round(l)}% of context remaining until auto-compact.`,hint:r?"Click to compact now.":"Press Enter to compact now.",...void 0})]})}' +
    'var __callResult=u(vle,{usedTokens:e.usageData.value.totalTokens,contextWindow:e.contextGaugeFull.value,threshold:t,onCompact:d,...void 0,buttonClassName:Sn.usageButtonV2});';

  const patched = patchWebviewCode(bundle332, { showTokenCounts: true, showBeforeFirstReply: true });

  const { code: restored, changed } = unpatchWebviewCode(patched);
  assert.equal(changed, true);
  assert.equal(restored, bundle332);

  const sess1mCapped = {
    usageData: { value: { totalTokens: 28648, contextWindow: 1000000, maxOutputTokens: 64000 } },
    contextGaugeFull: { value: 967000 },
    currentMainLoopModel: { value: 'claude-sonnet-5[1m]' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  const emptySess1m = {
    usageData: { value: { totalTokens: 0, contextWindow: 0, maxOutputTokens: 0 } },
    contextGaugeFull: { value: 0 },
    currentMainLoopModel: { value: 'claude-sonnet-5[1m]' },
    config: { value: { claudeSettings: { effective: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' } } } } },
  };
  const sessUncapped = {
    usageData: { value: { totalTokens: 50000, contextWindow: 1000000, maxOutputTokens: 64000 } },
    contextGaugeFull: { value: 967000 },
    config: { value: { claudeSettings: { effective: { env: {} } } } },
  };

  const uMock = (comp, props) => (typeof comp === 'function' ? comp(props) : { comp, props });
  const gMock = (tag, props) => ({ tag, props });
  const makeSb = (sess, thr) => {
    const sb = {
      globalThis: null,
      u: uMock,
      g: gMock,
      _: () => [true, () => {}],
      rl: { host: 'host_cls' },
      J4: { usage: 'usage_cls', pie: 'pie_cls' },
      yle: 'PIE',
      Vg: 'TOOLTIP',
      Sn: { usageButtonV2: 'btn_v2' },
      e: sess,
      t: thr,
      d: () => {},
      __callResult: undefined,
    };
    sb.globalThis = sb;
    vm.runInNewContext(stripPatchComments(patched), sb);
    return sb.__callResult;
  };

  const r1 = makeSb(sess1mCapped, 0);
  assert.equal(r1.tag, 'div');
  assert.equal(r1.props.children[0].props['aria-label'], '9% context used (28.6k / 317k), click to compact');
  assert.equal(typeof r1.props.children[0].props.onFocus, 'function');
  assert.equal(typeof r1.props.children[0].props.onKeyDown, 'function');
  assert.equal(
    r1.props.children[1].props.text,
    '91% of context remaining until auto-compact. (28.6k / 317k) · Model max 967k'
  );
  assert.equal(r1.props.children[1].props.hint, 'Click to compact now.');

  const rEmpty = makeSb(emptySess1m, 0);
  assert.equal(rEmpty.props.children[0].props['aria-label'], '0% context used (0 / 317k), click to compact');
  assert.equal(
    rEmpty.props.children[1].props.text,
    '100% of context remaining until auto-compact. (0 / 317k) · Model max 967k'
  );

  assert.equal(makeSb(emptySess1m, 50), null);

  const rUncapped = makeSb(sessUncapped, 0);
  assert.equal(rUncapped.props.children[0].props['aria-label'], '5% context used (50k / 967k), click to compact');
  assert.equal(
    rUncapped.props.children[1].props.text,
    '95% of context remaining until auto-compact. (50k / 967k)'
  );
});

test('patches arrow-function components with rest props and trailing commas', () => {
  const futureBundle =
    'const Outer=({usedTokens:a,contextWindow:b,threshold:c,onCompact:d,...rest})=>{let p=b>0?Math.min(a/b*100,100):0;if(b===0||p<=c){return null;}return u(Inner,{percentageUsed:p,onCompact:d,extra:1,});};' +
    'const Inner=({percentageUsed:p,onCompact:d,...rest})=>{let[h,sh]=_(!1);return g("div",{children:[u("button",{"aria-label":`${Math.round(p)}% context used!`,onClick:d}),h&&u(Tip,{text:`${Math.round(100-p)}% remaining before auto-compact.`,})]});};' +
    'var __out=u(Outer,{usedTokens:s.usageData.value.totalTokens,contextWindow:s.gauge.value,threshold:0,onCompact:fn,});';

  const patched = patchWebviewCode(futureBundle, { overrideWindow: 350000 });
  const { code: restored } = unpatchWebviewCode(patched);
  assert.equal(restored, futureBundle);

  const sb = {
    globalThis: null,
    u: (comp, props) => (typeof comp === 'function' ? comp(props) : { comp, props }),
    g: (tag, props) => ({ tag, props }),
    _: () => [true, () => {}],
    Tip: 'TIP',
    s: {
      usageData: { value: { totalTokens: 31700, contextWindow: 1000000, maxOutputTokens: 64000 } },
      gauge: { value: 967000 },
    },
    fn: () => {},
    __out: undefined,
  };
  sb.globalThis = sb;
  vm.runInNewContext(patched, sb);
  assert.equal(sb.__out.props.children[0].props['aria-label'], '10% context used (31.7k / 317k)!');
  assert.equal(
    sb.__out.props.children[1].props.text,
    '90% remaining before auto-compact. (31.7k / 317k) · Model max 967k'
  );
});

test('real Claude Code webview/index.js (and katex-bak if present) patches, validates, and restores cleanly', (t) => {
  if (!EXT_DIR || !fs.existsSync(path.join(EXT_DIR, 'webview', 'index.js'))) {
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

    if (baseline.includes('/* === KaTeX LaTeX Rendering Patch === */')) {
      assert.ok(patched.includes('/* === KaTeX LaTeX Rendering Patch === */'));
    }

    const repatched = patchWebviewCode(patched, { overrideWindow: 400000, showTokenCounts: false });
    assert.equal(getPatchVersion(repatched), PATCH_VERSION);

    const { code: restored, changed } = unpatchWebviewCode(repatched);
    assert.equal(changed, true);
    assert.equal(restored, baseline, `Byte-for-byte mismatch when restoring ${path.basename(target)}`);
  }
});

test('applyPatchToDir & removePatchFromDir work atomically in temp extension copy', () => {
  if (!EXT_DIR) return;
  const realJs = path.join(EXT_DIR, 'webview', 'index.js');
  if (!fs.existsSync(realJs)) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-fix-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'webview'));
    const origContent = fs.readFileSync(realJs, 'utf8');
    const { code: baseline } = unpatchWebviewCode(origContent);
    fs.writeFileSync(path.join(tmpDir, 'webview', 'index.js'), baseline, 'utf8');

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
