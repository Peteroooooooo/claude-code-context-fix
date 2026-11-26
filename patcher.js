const fs = require('fs');
const path = require('path');
const os = require('os');
const acorn = require('acorn');
const { replaceFiles } = require('./patch-files');

const PATCH_VERSION = '1.2.0';
const PATCH_BEGIN = '/* === Claude Code Context Fix Patch';
const PATCH_END = '/* === End Claude Code Context Fix Patch === */';
const ORIG_PREFIX = '/* === ORIG_BASE64:';
const ORIG_SUFFIX = ' === */';

function validateJavaScript(code, filename = 'webview/index.js') {
  try {
    return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (err) {
    throw new SyntaxError(`${filename}: ${err.message}`);
  }
}

function walkAst(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit, ancestors);
    return;
  }
  if (typeof node.type === 'string') {
    visit(node, ancestors);
    ancestors.push(node);
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      walkAst(node[k], visit, ancestors);
    }
    ancestors.pop();
  }
}

function getPropKey(prop) {
  if (!prop || prop.type !== 'Property') return null;
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

function getBindingName(pattern) {
  if (!pattern) return null;
  if (pattern.type === 'Identifier') return pattern.name;
  if (pattern.type === 'AssignmentPattern' && pattern.left.type === 'Identifier') {
    return pattern.left.name;
  }
  return null;
}

function getFunctionName(fnNode, ancestors) {
  if (fnNode.id && fnNode.id.name) return fnNode.id.name;
  const parent = ancestors[ancestors.length - 1];
  if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent && parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') {
    return parent.left.name;
  }
  return null;
}

function findEnclosingStatement(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    const parent = i > 0 ? ancestors[i - 1] : null;
    if (parent && (parent.type === 'Program' || parent.type === 'BlockStatement')) {
      return node;
    }
  }
  return null;
}

function extractSessionExpr(usedTokensValueNode, source) {
  let found = null;
  walkAst(usedTokensValueNode, (n) => {
    if (found) return;
    if (
      n.type === 'MemberExpression' &&
      !n.computed &&
      n.property.type === 'Identifier' &&
      n.property.name === 'totalTokens' &&
      n.object.type === 'MemberExpression' &&
      !n.object.computed &&
      n.object.property.type === 'Identifier' &&
      n.object.property.name === 'value' &&
      n.object.object.type === 'MemberExpression' &&
      !n.object.object.computed &&
      n.object.object.property.type === 'Identifier' &&
      n.object.object.property.name === 'usageData'
    ) {
      found = source.slice(n.object.object.object.start, n.object.object.object.end);
    }
  });
  return found;
}

function isReturnNullStatement(stmt) {
  const checkReturn = (node) =>
    node &&
    node.type === 'ReturnStatement' &&
    node.argument &&
    node.argument.type === 'Literal' &&
    node.argument.value === null;

  if (checkReturn(stmt)) return true;
  if (stmt && stmt.type === 'BlockStatement' && stmt.body.length === 1) {
    return checkReturn(stmt.body[0]);
  }
  return false;
}

function nodeReferencesIdentifier(root, identName) {
  let hit = false;
  walkAst(root, (n, anc) => {
    if (hit) return;
    if (n.type === 'Identifier' && n.name === identName) {
      const parent = anc[anc.length - 1];
      if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) {
        return;
      }
      hit = true;
    }
  });
  return hit;
}

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
    `if(!(raw>0))return{raw:0,win:0,mo:0,pct:void 0,hasCap:w!==void 0};` +
    `var mo=ud&&ud.maxOutputTokens>0?ud.maxOutputTokens:(C.fallback.maxOutputTokens||2e4);` +
    `var win=w!==void 0?Math.min(raw,w):raw;` +
    `var pct=Q(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);if(pct===void 0)pct=C.fallback.pctOverride;` +
    `return{raw:raw,win:win,mo:mo,pct:pct,hasCap:w!==void 0||pct!==void 0}}` +
    `function D(win,mo){return win-Math.min(mo,2e4)-13e3}` +
    `function L(win,mo,pct){var thr=D(win,mo);if(pct!==void 0){var outBuf=Math.min(mo,2e4);thr=Math.min(Math.floor((win-outBuf)*(pct/100)),thr)}return thr>0?thr:0}` +
    `function F(n){if(!(n>=0))return"0";if(n<1e3)return String(Math.round(n));if(n<1e6){var k=n/1e3;return(k>=100||Math.abs(k-Math.round(k))<0.05?String(Math.round(k)):k.toFixed(1).replace(/\\.0$/,""))+"k"}var m=n/1e6;return m.toFixed(2).replace(/\\.?0+$/,"")+"M"}` +
    `G.__ccCtxFixLimit=function(sess,origOrGk){var d=R(sess);var orig=typeof origOrGk==="number"?origOrGk:(typeof origOrGk==="function"&&d.raw>0?origOrGk(d.raw,d.mo):0);if(!d.hasCap&&orig>0)return orig;if(!(d.win>0))return orig>0?orig:0;var lim=L(d.win,d.mo,d.pct);if(!(C.overrideWindow>0)&&orig>0&&lim>orig)return orig;return lim};` +
    `G.__ccCtxFixRawLimit=function(sess,origOrGk){var d=R(sess);if(!(d.raw>0))return typeof origOrGk==="number"&&origOrGk>0?origOrGk:0;var rawLim=typeof origOrGk==="function"?origOrGk(d.raw,d.mo):D(d.raw,d.mo);return rawLim>0?rawLim:0};` +
    `G.__ccCtxFixFmt=F;` +
    `G.__ccCtxFixAria=function(orig,ut,cw){if(!C.showTokenCounts||!(cw>0))return orig;var tag=" ("+F(ut)+" / "+F(cw)+")";if(/context used/i.test(orig))return orig.replace(/(context used)/i,"$1"+tag);return orig+tag};` +
    `G.__ccCtxFixTipSuffix=function(ut,cw,rw){if(!C.showTokenCounts||!(cw>0))return"";return" ("+F(ut)+" / "+F(cw)+")"+(rw>cw?" \\u00b7 Model max "+F(rw):"")};` +
    `G.__ccCtxFixCfg=C;` +
    `})(globalThis);`
  );
}

function locateAstTargets(ast, source) {
  const callsites = [];
  const outerCandidates = [];
  const fnByName = new Map();
  const innerFallbackCandidates = [];

  walkAst(ast, (node, ancestors) => {
    if (
      node.type === 'CallExpression' &&
      node.arguments.length === 2 &&
      node.arguments[1].type === 'ObjectExpression'
    ) {
      const props = node.arguments[1].properties;
      const byKey = new Map();
      for (const p of props) {
        const k = getPropKey(p);
        if (k) byKey.set(k, p);
      }
      if (byKey.has('usedTokens') && byKey.has('contextWindow') && byKey.has('threshold') && byKey.has('onCompact')) {
        const sessExpr = extractSessionExpr(byKey.get('usedTokens').value, source);
        if (sessExpr) {
          callsites.push({
            node,
            byKey,
            sessExpr,
            compName: node.arguments[0].type === 'Identifier' ? node.arguments[0].name : null,
          });
        }
      }
    }

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const name = getFunctionName(node, ancestors);
      const entry = { node, ancestors: [...ancestors], name };
      if (name) {
        if (!fnByName.has(name)) fnByName.set(name, []);
        fnByName.get(name).push(entry);
      }

      if (node.params.length >= 1 && node.params[0].type === 'ObjectPattern') {
        const pMap = new Map();
        for (const p of node.params[0].properties) {
          const k = getPropKey(p);
          if (k) pMap.set(k, p);
        }
        if (
          pMap.has('usedTokens') &&
          pMap.has('contextWindow') &&
          pMap.has('threshold') &&
          pMap.has('onCompact')
        ) {
          outerCandidates.push({ ...entry, pMap });
        }
        if (
          pMap.has('percentageUsed') &&
          pMap.has('onCompact') &&
          source.slice(node.start, node.end).includes('auto-compact')
        ) {
          innerFallbackCandidates.push({ ...entry, pMap });
        }
      }
    }
  });

  if (callsites.length === 0) {
    throw new Error('Expected at least 1 context indicator callsite, found 0');
  }

  let outer = null;
  const preferredName = callsites[0].compName;
  if (preferredName) {
    outer = outerCandidates.find((c) => c.name === preferredName) || null;
  }
  if (!outer && outerCandidates.length === 1) {
    outer = outerCandidates[0];
  }
  if (!outer) {
    throw new Error(`Expected 1 context indicator outer component, found ${outerCandidates.length}`);
  }

  const pUsed = getBindingName(outer.pMap.get('usedTokens')?.value);
  const pCtx = getBindingName(outer.pMap.get('contextWindow')?.value);
  const pThr = getBindingName(outer.pMap.get('threshold')?.value);
  if (!pUsed || !pCtx || !pThr) {
    throw new Error('Could not resolve destructured parameter names in outer context component');
  }

  // Find the gating `if (...) return null` inside outer
  const gateIfs = [];
  let innerCall = null;
  walkAst(outer.node.body, (n) => {
    if (n.type === 'IfStatement' && isReturnNullStatement(n.consequent)) {
      if (nodeReferencesIdentifier(n.test, pCtx) || nodeReferencesIdentifier(n.test, pThr)) {
        gateIfs.push(n);
      }
    }
    if (
      n.type === 'CallExpression' &&
      n.arguments.length === 2 &&
      n.arguments[1].type === 'ObjectExpression'
    ) {
      const props = n.arguments[1].properties;
      const byKey = new Map();
      for (const p of props) {
        const k = getPropKey(p);
        if (k) byKey.set(k, p);
      }
      if (byKey.has('percentageUsed') && byKey.has('onCompact')) {
        innerCall = { node: n, obj: n.arguments[1], byKey };
      }
    }
  });

  if (gateIfs.length !== 1) {
    throw new Error(`Expected 1 gating if-statement in outer component, found ${gateIfs.length}`);
  }
  if (!innerCall) {
    throw new Error('Could not find inner component call inside outer component');
  }

  let inner = null;
  if (innerCall.node.arguments[0].type === 'Identifier') {
    const innerName = innerCall.node.arguments[0].name;
    const named = (fnByName.get(innerName) || []).find(
      (f) => f.node.params.length >= 1 && f.node.params[0].type === 'ObjectPattern'
    );
    if (named) {
      const pMap = new Map();
      for (const p of named.node.params[0].properties) {
        const k = getPropKey(p);
        if (k) pMap.set(k, p);
      }
      inner = { ...named, pMap };
    }
  }
  if (!inner && innerFallbackCandidates.length === 1) {
    inner = innerFallbackCandidates[0];
  }
  if (!inner) {
    throw new Error('Could not locate inner context indicator component');
  }

  // Find aria-label property and tooltip text property inside inner
  const ariaProps = [];
  const tipTextProps = [];
  walkAst(inner.node.body, (n) => {
    if (n.type !== 'Property') return;
    const k = getPropKey(n);
    if (k === 'aria-label') {
      ariaProps.push(n);
    } else if (k === 'text') {
      const valSrc = source.slice(n.value.start, n.value.end);
      if (valSrc.includes('auto-compact') || valSrc.includes('remaining')) {
        tipTextProps.push(n);
      }
    }
  });

  if (ariaProps.length !== 1) {
    throw new Error(`Expected 1 aria-label property in inner component, found ${ariaProps.length}`);
  }
  if (tipTextProps.length !== 1) {
    throw new Error(`Expected 1 tooltip text property in inner component, found ${tipTextProps.length}`);
  }

  return {
    callsites,
    outer,
    pUsed,
    pCtx,
    pThr,
    gateIf: gateIfs[0],
    innerCall,
    inner,
    ariaProp: ariaProps[0],
    tipTextProp: tipTextProps[0],
  };
}

function patchWebviewCode(source, config = {}) {
  const { code: clean } = unpatchWebviewCode(source);
  const ast = validateJavaScript(clean, 'webview/index.js');
  const t = locateAstTargets(ast, clean);

  const helpers = buildRuntimeHelpers(config);
  const replacements = [];

  // 1. Insert runtime helpers before the statement enclosing outer component
  const outerStmt = findEnclosingStatement([...t.outer.ancestors, t.outer.node]);
  if (!outerStmt) {
    throw new Error('Could not find enclosing statement for outer context component');
  }
  replacements.push({
    start: outerStmt.start,
    end: outerStmt.start,
    replacement: wrapPatch(helpers, ''),
  });

  // 2. Patch each callsite's contextWindow property (and add rawContextWindow if absent)
  for (const cs of t.callsites) {
    const ctxProp = cs.byKey.get('contextWindow');
    const origProp = clean.slice(ctxProp.start, ctxProp.end);
    const origVal = clean.slice(ctxProp.value.start, ctxProp.value.end);
    const limitExpr = `(globalThis.__ccCtxFixLimit?globalThis.__ccCtxFixLimit(${cs.sessExpr},${origVal}):(${origVal}))`;
    let patchedProp = `contextWindow:${limitExpr}`;
    if (!cs.byKey.has('rawContextWindow')) {
      const rawExpr = `(globalThis.__ccCtxFixRawLimit?globalThis.__ccCtxFixRawLimit(${cs.sessExpr},${origVal}):(${origVal}))`;
      patchedProp += `,rawContextWindow:${rawExpr}`;
    }
    replacements.push({
      start: ctxProp.start,
      end: ctxProp.end,
      replacement: wrapPatch(patchedProp, origProp),
    });
  }

  // 3. Outer component: add rawContextWindow destructuring + bypass gate when threshold===0 && showBeforeFirstReply + pass token props to inner
  const outerParamPat = t.outer.node.params[0];
  if (!t.outer.pMap.has('rawContextWindow')) {
    const insertAt = outerParamPat.start + 1;
    replacements.push({
      start: insertAt,
      end: insertAt,
      replacement: wrapPatch('rawContextWindow:__ccCtxRw,', ''),
    });
  }
  const outerRwVar = t.outer.pMap.has('rawContextWindow')
    ? getBindingName(t.outer.pMap.get('rawContextWindow').value) || '__ccCtxRw'
    : '__ccCtxRw';

  const origGateTest = clean.slice(t.gateIf.test.start, t.gateIf.test.end);
  const patchedGateTest =
    `((${origGateTest})&&!((${t.pThr})===0&&(${t.pCtx})>0&&(${t.pUsed})===0&&globalThis.__ccCtxFixCfg&&globalThis.__ccCtxFixCfg.showBeforeFirstReply))`;
  replacements.push({
    start: t.gateIf.test.start,
    end: t.gateIf.test.end,
    replacement: wrapPatch(patchedGateTest, origGateTest),
  });

  const innerCallObj = t.innerCall.obj;
  const lastInnerCallProp = innerCallObj.properties[innerCallObj.properties.length - 1];
  const origInnerCallTail = clean.slice(lastInnerCallProp.end, innerCallObj.end);
  const addedInnerProps = [];
  if (!t.innerCall.byKey.has('usedTokens')) addedInnerProps.push(`usedTokens:${t.pUsed}`);
  if (!t.innerCall.byKey.has('contextWindow')) addedInnerProps.push(`contextWindow:${t.pCtx}`);
  if (!t.innerCall.byKey.has('rawContextWindow')) addedInnerProps.push(`rawContextWindow:${outerRwVar}`);
  if (addedInnerProps.length > 0) {
    replacements.push({
      start: lastInnerCallProp.end,
      end: innerCallObj.end,
      replacement: wrapPatch(`,${addedInnerProps.join(',')}}`, origInnerCallTail),
    });
  }

  // 4. Inner component: destructure usedTokens/contextWindow/rawContextWindow and augment aria-label + tooltip text
  const innerParamPat = t.inner.node.params[0];
  const addedParamBindings = [];
  const innerUtVar = t.inner.pMap.has('usedTokens')
    ? getBindingName(t.inner.pMap.get('usedTokens').value) || '__ccCtxUt'
    : (addedParamBindings.push('usedTokens:__ccCtxUt=0'), '__ccCtxUt');
  const innerCwVar = t.inner.pMap.has('contextWindow')
    ? getBindingName(t.inner.pMap.get('contextWindow').value) || '__ccCtxCw'
    : (addedParamBindings.push('contextWindow:__ccCtxCw=0'), '__ccCtxCw');
  const innerRwVar = t.inner.pMap.has('rawContextWindow')
    ? getBindingName(t.inner.pMap.get('rawContextWindow').value) || '__ccCtxRw'
    : (addedParamBindings.push('rawContextWindow:__ccCtxRw=0'), '__ccCtxRw');

  if (addedParamBindings.length > 0) {
    const insertAt = innerParamPat.start + 1;
    replacements.push({
      start: insertAt,
      end: insertAt,
      replacement: wrapPatch(`${addedParamBindings.join(',')},`, ''),
    });
  }

  const origAriaVal = clean.slice(t.ariaProp.value.start, t.ariaProp.value.end);
  const patchedAriaVal =
    `(globalThis.__ccCtxFixAria?globalThis.__ccCtxFixAria((${origAriaVal}),${innerUtVar},${innerCwVar}):(${origAriaVal}))`;
  replacements.push({
    start: t.ariaProp.value.start,
    end: t.ariaProp.value.end,
    replacement: wrapPatch(patchedAriaVal, origAriaVal),
  });

  const origTipVal = clean.slice(t.tipTextProp.value.start, t.tipTextProp.value.end);
  const patchedTipVal =
    `((${origTipVal})+(globalThis.__ccCtxFixTipSuffix?globalThis.__ccCtxFixTipSuffix(${innerUtVar},${innerCwVar},${innerRwVar}):""))`;
  replacements.push({
    start: t.tipTextProp.value.start,
    end: t.tipTextProp.value.end,
    replacement: wrapPatch(patchedTipVal, origTipVal),
  });

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < replacements.length; i++) {
    const prev = replacements[i - 1];
    const curr = replacements[i];
    if (curr.end > prev.start) {
      throw new Error(`Overlapping AST patch ranges: [${curr.start}, ${curr.end}] vs [${prev.start}, ${prev.end}]`);
    }
  }

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

function parseExtVersion(dirName) {
  const m = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(path.basename(dirName));
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareExtVersion(a, b) {
  const va = parseExtVersion(a);
  const vb = parseExtVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return a.localeCompare(b);
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
        matches.sort(compareExtVersion);
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
  compareExtVersion,
  findClaudeCodeExtDirs,
  applyPatchToDir,
  removePatchFromDir,
  getPatchStatus,
};
