const fs = require('fs');
const path = require('path');
const os = require('os');
const acorn = require('acorn');
const { replaceFiles } = require('./patch-files');

const PATCH_VERSION = '1.1.0';
const PATCH_BEGIN = '/* === Claude Code Context Fix Patch';
const PATCH_END = '/* === End Claude Code Context Fix Patch === */';
const ORIG_PREFIX = '/* === ORIG_BASE64:';
const ORIG_SUFFIX = ' === */';

function validateJavaScript(code, filename = 'webview/index.js') {
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (err) {
    throw new SyntaxError(`${filename}: ${err.message}`);
  }
}

const CALLSITE_RE =
  /([$\w]+)\(([$\w]+),\{usedTokens:([$\w]+)\.usageData\.value\.totalTokens,contextWindow:([$\w]+)\(\3\.usageData\.value\.contextWindow,\3\.usageData\.value\.maxOutputTokens\),threshold:([^,}]+),onCompact:([^,}]+),buttonClassName:([^}]+)\}\)/g;

const COMPONENT_RE =
  /function ([$\w]+)\(\{usedTokens:([$\w]+),contextWindow:([$\w]+),threshold:([$\w]+),onCompact:([$\w]+),buttonClassName:([$\w]+)\}\)\{let ([$\w]+)=\3>0\?Math\.min\(\2\/\3\*100,100\):0;if\(\3===0\|\|\7<=\4\)return null;return ([$\w]+)\(([$\w]+),\{percentageUsed:\7,onCompact:\5,buttonClassName:\6\}\)\}function \9\(\{percentageUsed:([$\w]+),onCompact:([$\w]+),buttonClassName:([$\w]+)\}\)\{let\[([$\w]+),([$\w]+)\]=([$\w]+)\(!1\),([$\w]+)=100-\10;return ([$\w]+)\("div",\{className:([$\w]+\.host),children:\[\8\("button",\{type:"button",className:`\$\{([$\w]+\.usage)\} \$\{\12\?\?""\}`,"aria-label":`\$\{Math\.round\(\10\)\}% context used — click to compact`,onClick:\11,onMouseEnter:\(\)=>\14\(!0\),onMouseLeave:\(\)=>\14\(!1\),children:\8\(([$\w]+),\{percentage:\10,className:([$\w]+\.pie)\}\)\}\),\13&&\8\(([$\w]+),\{text:`\$\{Math\.round\(\16\)\}% of context remaining until auto-compact\.`,hint:"Click to compact now\."\}\)\]\}\)\}/g;

function wrapPatch(patchedCode, originalCode) {
  const b64 = Buffer.from(originalCode, 'utf8').toString('base64');
  return (
    `${PATCH_BEGIN} v${PATCH_VERSION} === */` +
    patchedCode +
    `${ORIG_PREFIX}${b64}${ORIG_SUFFIX}` +
    PATCH_END
  );
}

function unpatchWebviewCode(source) {
  let out = source;
  let changed = false;
  let searchFrom = 0;
  while (true) {
    const start = out.indexOf(PATCH_BEGIN, searchFrom);
    if (start === -1) break;
    const endIdx = out.indexOf(PATCH_END, start);
    if (endIdx === -1) {
      throw new Error('Malformed context fix patch marker: missing end tag');
    }
    const block = out.slice(start, endIdx + PATCH_END.length);
    const origStart = block.lastIndexOf(ORIG_PREFIX);
    const origEnd = origStart !== -1 ? block.indexOf(ORIG_SUFFIX, origStart + ORIG_PREFIX.length) : -1;
    if (origStart === -1 || origEnd === -1) {
      throw new Error('Malformed context fix patch marker: missing original backup payload');
    }
    const b64 = block.slice(origStart + ORIG_PREFIX.length, origEnd);
    const original = Buffer.from(b64, 'base64').toString('utf8');
    out = out.slice(0, start) + original + out.slice(endIdx + PATCH_END.length);
    searchFrom = start + original.length;
    changed = true;
  }
  return { code: out, changed };
}

function parseTokenSize(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 100000 ? Math.floor(raw) : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (!s || s === 'auto') return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
  if (!m) return undefined;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return undefined;
  const mult = m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1;
  const val = Math.floor(num * mult);
  return val >= 100000 ? val : undefined;
}

function parsePctOverride(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(num) && num > 0 && num <= 100 ? num : undefined;
}

function resolveDefaultModelId(parsed, env) {
  const raw = env.ANTHROPIC_MODEL ?? parsed.model;
  if (!raw || typeof raw !== 'string') {
    return env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-5';
  }
  const lower = raw.trim().toLowerCase();
  if (lower === 'sonnet') return env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-5';
  if (lower === 'opus') return env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-4-7';
  if (lower === 'haiku') return env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5';
  if (lower === 'fable') return env.ANTHROPIC_DEFAULT_FABLE_MODEL || 'claude-fable-5';
  return raw;
}

function readClaudeUserSettings(envObj = process.env) {
  const candidates = [];
  if (envObj.CLAUDE_CONFIG_DIR) {
    candidates.push(path.join(envObj.CLAUDE_CONFIG_DIR, 'settings.json'));
  }
  candidates.push(path.join(os.homedir(), '.claude', 'settings.json'));

  let parsed = {};
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        break;
      }
    } catch {
      // ignore malformed or unreadable settings
    }
  }

  const settingsEnv = parsed && typeof parsed.env === 'object' && parsed.env ? parsed.env : {};
  const mergedEnv = { ...settingsEnv, ...envObj };
  const modelWindows = {};
  if (parsed && typeof parsed.modelSettings === 'object' && parsed.modelSettings) {
    for (const [k, v] of Object.entries(parsed.modelSettings)) {
      if (v && v.autoCompactWindow !== undefined) {
        const parsedWin = parseTokenSize(v.autoCompactWindow);
        if (parsedWin !== undefined) modelWindows[k] = parsedWin;
      }
    }
  }

  const maxOutRaw = mergedEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  const maxOutNum = maxOutRaw !== undefined ? parseInt(String(maxOutRaw), 10) : NaN;
  const disable1mRaw = mergedEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT;

  return {
    envAutoCompactWindow: parseTokenSize(mergedEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
    pctOverride: parsePctOverride(mergedEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE),
    autoCompactWindow: parseTokenSize(parsed.autoCompactWindow),
    modelWindows,
    maxOutputTokens: Number.isFinite(maxOutNum) && maxOutNum > 0 ? maxOutNum : 20000,
    disable1m: disable1mRaw === '1' || disable1mRaw === 'true',
    defaultModel: resolveDefaultModelId(parsed, mergedEnv),
  };
}

function buildRuntimeHelpers(config) {
  const cfg = {
    overrideWindow: Number(config?.overrideWindow) > 0 ? Math.floor(Number(config.overrideWindow)) : 0,
    showTokenCounts: config?.showTokenCounts !== false,
    showBeforeFirstReply: config?.showBeforeFirstReply !== false,
    fallback: config?.fallback || {
      envAutoCompactWindow: undefined,
      pctOverride: undefined,
      autoCompactWindow: undefined,
      modelWindows: {},
      maxOutputTokens: 20000,
      disable1m: false,
      defaultModel: '',
    },
  };

  return (
    `;(function(G){` +
    `var C=${JSON.stringify(cfg)};` +
    `function P(v){if(typeof v==="number")return Number.isFinite(v)&&v>=1e5?Math.floor(v):void 0;if(typeof v!=="string")return;var s=v.trim().toLowerCase();if(!s||s==="auto")return;var m=/^(\\d+(?:\\.\\d+)?)\\s*([km])?$/.exec(s);if(!m)return;var n=parseFloat(m[1])*(m[2]==="m"?1e6:m[2]==="k"?1e3:1);return Number.isFinite(n)&&n>=1e5?Math.floor(n):void 0}` +
    `function Q(v){if(v===void 0||v===null||v==="")return;var n=typeof v==="number"?v:parseFloat(String(v));return Number.isFinite(n)&&n>0&&n<=100?n:void 0}` +
    `function M(map,model){if(!map||typeof map!=="object"||!model)return;var norm=String(model).replace(/\\[1m\\]$/i,"").toLowerCase();if(Object.prototype.hasOwnProperty.call(map,model))return map[model];for(var k in map){if(!Object.prototype.hasOwnProperty.call(map,k))continue;var kn=k.replace(/\\[1m\\]$/i,"").toLowerCase();if(norm===kn||norm.indexOf(kn+"-")===0||norm.indexOf(kn+"@")===0||norm.indexOf(kn+"[")===0)return map[k]}}` +
    `function I(model,env,w){var dis=C.fallback.disable1m||(env&&(env.CLAUDE_CODE_DISABLE_1M_CONTEXT==="1"||env.CLAUDE_CODE_DISABLE_1M_CONTEXT==="true"));var m=String(model||"");if(/\\[1m\\]/i.test(m))return dis?2e5:1e6;if(/sonnet-5|opus-4-[78]|opus-5|haiku-5-5|fable-5/i.test(m))return 1e6;if(/claude-3|haiku-4-5|opus-4-[015]|sonnet-4/i.test(m))return 2e5;return w>0?w:(dis?2e5:1e6)}` +
    `function R(sess){` +
    `var ud=sess&&sess.usageData&&sess.usageData.value;` +
    `var eff=sess&&sess.config&&sess.config.value&&sess.config.value.claudeSettings&&sess.config.value.claudeSettings.effective;` +
    `var env=(eff&&eff.env)||{};` +
    `var model=(sess&&sess.currentModelInfo&&sess.currentModelInfo.value&&sess.currentModelInfo.value.resolvedModel)||(sess&&sess.currentMainLoopModel&&sess.currentMainLoopModel.value)||(sess&&sess.lastServedModel&&sess.lastServedModel.value)||(sess&&sess.modelSelection&&sess.modelSelection.value)||C.fallback.defaultModel||"";` +
    `if(model==="default")model=C.fallback.defaultModel||"";` +
    `var w=C.overrideWindow>0?C.overrideWindow:void 0;` +
    `if(w===void 0)w=P(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);` +
    `if(w===void 0)w=C.fallback.envAutoCompactWindow;` +
    `if(w===void 0&&eff&&eff.modelSettings){var ms=M(eff.modelSettings,model);if(ms&&ms.autoCompactWindow!==void 0)w=P(ms.autoCompactWindow)}` +
    `if(w===void 0&&C.fallback.modelWindows)w=M(C.fallback.modelWindows,model);` +
    `if(w===void 0&&eff&&eff.autoCompactWindow!==void 0)w=P(eff.autoCompactWindow);` +
    `if(w===void 0)w=C.fallback.autoCompactWindow;` +
    `var raw=ud&&ud.contextWindow>0?ud.contextWindow:(C.showBeforeFirstReply?I(model,env,w||0):0);` +
    `if(!(raw>0))return{raw:0,win:0,mo:0,pct:void 0};` +
    `var mo=ud&&ud.maxOutputTokens>0?ud.maxOutputTokens:(C.fallback.maxOutputTokens||2e4);` +
    `var win=w!==void 0?Math.min(raw,w):raw;` +
    `var pct=Q(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);if(pct===void 0)pct=C.fallback.pctOverride;` +
    `return{raw:raw,win:win,mo:mo,pct:pct}}` +
    `function L(win,mo,pct,gk){var thr=gk(win,mo);if(pct!==void 0){var outBuf=Math.min(mo,2e4);thr=Math.min(Math.floor((win-outBuf)*(pct/100)),thr)}return thr>0?thr:0}` +
    `G.__ccCtxFixLimit=function(sess,gk){var d=R(sess);return d.win>0?L(d.win,d.mo,d.pct,gk):0};` +
    `G.__ccCtxFixRawLimit=function(sess,gk){var d=R(sess);return d.raw>0?gk(d.raw,d.mo):0};` +
    `G.__ccCtxFixFmt=function(n){if(!(n>=0))return"0";if(n<1e3)return String(Math.round(n));if(n<1e6){var k=n/1e3;return(k>=100||Math.abs(k-Math.round(k))<0.05?String(Math.round(k)):k.toFixed(1).replace(/\\.0$/,""))+"k"}var m=n/1e6;return m.toFixed(2).replace(/\\.?0+$/,"")+"M"};` +
    `G.__ccCtxFixCfg=C;` +
    `})(globalThis);`
  );
}

function patchWebviewCode(source, config = {}) {
  const { code: clean } = unpatchWebviewCode(source);

  const callMatches = [...clean.matchAll(CALLSITE_RE)];
  if (callMatches.length !== 1) {
    throw new Error(`Expected 1 context indicator callsite, found ${callMatches.length}`);
  }
  const compMatches = [...clean.matchAll(COMPONENT_RE)];
  if (compMatches.length !== 1) {
    throw new Error(`Expected 1 context indicator component definition, found ${compMatches.length}`);
  }

  const cm = callMatches[0];
  const [fullCall, uFn, nfeFn, sessVar, gkFn, thrExpr, onCompactExpr, btnClsExpr] = cm;
  const helpers = buildRuntimeHelpers(config);
  const patchedCallBody =
    `${uFn}(${nfeFn},{` +
    `usedTokens:${sessVar}.usageData.value.totalTokens,` +
    `contextWindow:(globalThis.__ccCtxFixLimit?globalThis.__ccCtxFixLimit(${sessVar},${gkFn}):${gkFn}(${sessVar}.usageData.value.contextWindow,${sessVar}.usageData.value.maxOutputTokens)),` +
    `rawContextWindow:(globalThis.__ccCtxFixRawLimit?globalThis.__ccCtxFixRawLimit(${sessVar},${gkFn}):${gkFn}(${sessVar}.usageData.value.contextWindow,${sessVar}.usageData.value.maxOutputTokens)),` +
    `threshold:${thrExpr},onCompact:${onCompactExpr},buttonClassName:${btnClsExpr}` +
    `})`;

  const km = compMatches[0];
  const [
    fullComp,
    fnNfe, pUsed, pCtx, pThr, pCompact, pBtnCls, vPct,
    fnU, fnIwe,
    pPct, pIweCompact, pIweBtnCls,
    sOpen, sSetOpen, fnHook, vRem,
    fnH, clsHost, clsUsage, fnPie, clsPie, fnTooltip,
  ] = km;

  const patchedCompBody =
    `${helpers}` +
    `function ${fnNfe}({usedTokens:${pUsed},contextWindow:${pCtx},rawContextWindow:_rw,threshold:${pThr},onCompact:${pCompact},buttonClassName:${pBtnCls}}){` +
    `let ${vPct}=${pCtx}>0?Math.min(${pUsed}/${pCtx}*100,100):0;` +
    `let _allowZero=${pThr}===0&&globalThis.__ccCtxFixCfg&&globalThis.__ccCtxFixCfg.showBeforeFirstReply;` +
    `if(${pCtx}===0||(${vPct}===0?!_allowZero:${vPct}<=${pThr}))return null;` +
    `return ${fnU}(${fnIwe},{percentageUsed:${vPct},usedTokens:${pUsed},contextWindow:${pCtx},rawContextWindow:_rw,onCompact:${pCompact},buttonClassName:${pBtnCls}})` +
    `}` +
    `function ${fnIwe}({percentageUsed:${pPct},usedTokens:_ut,contextWindow:_cw,rawContextWindow:_rw,onCompact:${pIweCompact},buttonClassName:${pIweBtnCls}}){` +
    `let[${sOpen},${sSetOpen}]=${fnHook}(!1),${vRem}=100-${pPct};` +
    `let _f=globalThis.__ccCtxFixFmt,_show=globalThis.__ccCtxFixCfg&&globalThis.__ccCtxFixCfg.showTokenCounts;` +
    `let _counts=_show&&_f&&_cw>0?" ("+_f(_ut)+" / "+_f(_cw)+")"+(_rw>_cw?" · Model max "+_f(_rw):""):"";` +
    `let _aria=Math.round(${pPct})+"% context used"+(_show&&_f&&_cw>0?" ("+_f(_ut)+" / "+_f(_cw)+")":"")+" — click to compact";` +
    `let _tip=Math.round(${vRem})+"% of context remaining until auto-compact."+_counts;` +
    `return ${fnH}("div",{className:${clsHost},children:[` +
    `${fnU}("button",{type:"button",className:\`\${${clsUsage}} \${${pIweBtnCls}??""}\`,"aria-label":_aria,onClick:${pIweCompact},onMouseEnter:()=>${sSetOpen}(!0),onMouseLeave:()=>${sSetOpen}(!1),children:${fnU}(${fnPie},{percentage:${pPct},className:${clsPie}})}),` +
    `${sOpen}&&${fnU}(${fnTooltip},{text:_tip,hint:"Click to compact now."})` +
    `]})` +
    `}`;

  const replacements = [
    { start: cm.index, end: cm.index + fullCall.length, replacement: wrapPatch(patchedCallBody, fullCall) },
    { start: km.index, end: km.index + fullComp.length, replacement: wrapPatch(patchedCompBody, fullComp) },
  ].sort((a, b) => b.start - a.start);

  let patched = clean;
  for (const r of replacements) {
    patched = patched.slice(0, r.start) + r.replacement + patched.slice(r.end);
  }

  validateJavaScript(patched, 'webview/index.js');
  return patched;
}

function getPatchVersion(source) {
  const idx = source.indexOf(PATCH_BEGIN);
  if (idx === -1) return null;
  const m = /\/\* === Claude Code Context Fix Patch v([^\s]+)\s+=== \*\//.exec(
    source.slice(idx, idx + 120)
  );
  return m ? m[1] : 'unknown';
}

function findClaudeCodeExtDirs() {
  const home = os.homedir();
  const bases = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ];
  const found = [];
  for (const base of bases) {
    try {
      const entries = fs.readdirSync(base);
      const matches = entries
        .filter((e) => e.startsWith('anthropic.claude-code-'))
        .map((e) => path.join(base, e))
        .filter((p) => fs.existsSync(path.join(p, 'webview', 'index.js')));
      if (matches.length > 0) {
        matches.sort();
        found.push(matches[matches.length - 1]);
      }
    } catch {
      // directory may not exist
    }
  }
  return found;
}

function applyPatchToDir(extDir, config = {}) {
  const jsPath = path.join(extDir, 'webview', 'index.js');
  if (!fs.existsSync(jsPath)) {
    throw new Error('Claude Code webview/index.js not found at ' + jsPath);
  }
  const originalBuffer = fs.readFileSync(jsPath);
  const currentText = originalBuffer.toString('utf8');
  const nextText = patchWebviewCode(currentText, config);
  if (nextText === currentText) {
    return { status: 'unchanged', jsPath, version: PATCH_VERSION };
  }
  replaceFiles([{ target: jsPath, body: nextText, expected: originalBuffer }]);
  return { status: 'patched', jsPath, version: PATCH_VERSION };
}

function removePatchFromDir(extDir) {
  const jsPath = path.join(extDir, 'webview', 'index.js');
  if (!fs.existsSync(jsPath)) {
    return { status: 'missing', jsPath };
  }
  const originalBuffer = fs.readFileSync(jsPath);
  const currentText = originalBuffer.toString('utf8');
  const { code: restored, changed } = unpatchWebviewCode(currentText);
  if (!changed) {
    return { status: 'clean', jsPath };
  }
  validateJavaScript(restored, 'webview/index.js');
  replaceFiles([{ target: jsPath, body: restored, expected: originalBuffer }]);
  return { status: 'restored', jsPath };
}

function getPatchStatus(extDir) {
  const jsPath = path.join(extDir, 'webview', 'index.js');
  if (!fs.existsSync(jsPath)) {
    return { exists: false, patched: false, version: null, hasKatex: false, jsPath };
  }
  const text = fs.readFileSync(jsPath, 'utf8');
  const version = getPatchVersion(text);
  return {
    exists: true,
    patched: version !== null,
    version,
    hasKatex: text.includes('/* === KaTeX LaTeX Rendering Patch === */'),
    jsPath,
  };
}

module.exports = {
  PATCH_VERSION,
  parseTokenSize,
  parsePctOverride,
  readClaudeUserSettings,
  patchWebviewCode,
  unpatchWebviewCode,
  getPatchVersion,
  findClaudeCodeExtDirs,
  applyPatchToDir,
  removePatchFromDir,
  getPatchStatus,
};
