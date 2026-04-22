// ivx-script.js — IVX Apps Script Transpiler & Deployer
// Converts WaitBlock AST nodes to Google Apps Script triggers and deploys them.
// Depends on: ivx-core.js (parse), ivx-drive.js (driveToken)
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.

'use strict';

// ── Apps Script transpiler + deployment ──────────────────────────────────────
//
// Converts WaitBlock AST nodes to Google Apps Script trigger functions.
// Called automatically from the Run button when WaitBlock nodes are present.

const AppsScriptTranspiler = (() => {

  // ── Value serializer: IVX runtime value → JS literal string ──────────────
  function jsLiteral(value) {
    if (value === null || value === undefined) return 'null';
    if (value === true)  return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(jsLiteral).join(', ') + ']';
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .filter(([k]) => !String(k).startsWith('__'))
        .map(([k, v]) => `${JSON.stringify(String(k))}: ${jsLiteral(v)}`);
      return '{' + entries.join(', ') + '}';
    }
    return JSON.stringify(String(value));
  }

  // ── AST node → JS string, resolving identifiers against globals snapshot ──
  function emitExpr(node, globals) {
    if (!node) return 'null';
    switch (node.type) {
      case 'NumberLit':  return String(node.value);
      case 'BoolLit':    return node.value === null ? 'null' : node.value ? 'true' : 'false';
      case 'StringLit':  return JSON.stringify(node.value);
      case 'ListLit':    return '[' + node.elements.map(e => emitExpr(e, globals)).join(', ') + ']';
      case 'DictLit':    return '{' + node.pairs.map(p =>
        `${emitExpr(p.key, globals)}: ${emitExpr(p.value, globals)}`).join(', ') + '}';
      case 'Identifier': {
        // If we have a snapshot value, bake it in as a literal
        if (globals && globals.has(node.name)) return jsLiteral(globals.get(node.name));
        return node.name;
      }
      case 'BinOp': {
        const opMap = { '=': '===', '!=': '!==', 'and': '&&', 'or': '||',
                        'not': '!', '^': '**', '//': 'Math.floor', 'xor': '^' };
        const op = opMap[node.op] ?? node.op;
        if (node.op === '//') return `Math.floor(${emitExpr(node.left, globals)} / ${emitExpr(node.right, globals)})`;
        return `${emitExpr(node.left, globals)} ${op} ${emitExpr(node.right, globals)}`;
      }
      case 'UnaryOp':
        return `!${emitExpr(node.operand, globals)}`;
      case 'Call':
        return `${node.name}(${node.args.map(a => emitExpr(a, globals)).join(', ')})`;
      case 'Invoke':
        return `${emitExpr(node.callee, globals)}(${node.args.map(a => emitExpr(a, globals)).join(', ')})`;
      case 'MemberAccess':
        return `${emitExpr(node.object, globals)}.${node.field}`;
      default:
        return '/* ? */';
    }
  }

  function emitStmt(node, globals, indent = '') {
    if (!node) return '';
    const E = n => emitExpr(n, globals);
    const S = (n, ind) => emitStmt(n, globals, ind ?? indent);
    const B = (stmts, ind) => (Array.isArray(stmts) ? stmts : []).map(s => emitStmt(s, globals, ind ?? indent + '  ')).join('\n');

    switch (node.type) {
      case 'Assign': {
        const target = node.target ? E(node.target) : node.name;
        return `${indent}var ${target} = ${E(node.expr)};`;
      }
      case 'Say':
        return `${indent}Logger.log(${E(node.expr)});`;
      case 'Gmail': {
        const to      = node.to      ? E(node.to)      : '""';
        const subject = node.subject ? E(node.subject) : '""';
        const body    = node.body    ? E(node.body)     : '""';
        return `${indent}GmailApp.sendEmail(${to}, ${subject}, ${body});`;
      }
      case 'If': {
        let out = `${indent}if (${E(node.condition)}) {\n${B(node.body)}\n${indent}}`;
        if (node.else_?.length) out += ` else {\n${B(node.else_)}\n${indent}}`;
        return out;
      }
      case 'Loop':
        return `${indent}while (${E(node.condition)}) {\n${B(node.body)}\n${indent}}`;
      case 'For':
        return `${indent}for (var ${node.iterVar} of ${node.target}) {\n${B(node.body)}\n${indent}}`;
      case 'Give':
        return `${indent}return ${E(node.expr)};`;
      case 'ExprStatement':
        return `${indent}${E(node.expr)};`;
      case 'SheetsOpen': {
        // Expand to Apps Script Sheets API calls
        const name = E(node.name);
        return `${indent}var _ss = SpreadsheetApp.openByName(${name});\n${indent}var _sheet = _ss.getActiveSheet();`;
      }
      default:
        return `${indent}// (${node.type})`;
    }
  }

  function transpileBodyToJS(stmts, globals) {
    if (!Array.isArray(stmts) || !stmts.length) return '  // (empty body)';
    return stmts.map(s => {
      try { return emitStmt(s, globals, '  '); }
      catch(e) { return `  // (could not transpile ${s?.type}: ${e.message})`; }
    }).filter(Boolean).join('\n');
  }

  // Transpile a single WaitBlock node to a .gs function + trigger registration
  function transpileWaitBlock(node, index, globals) {
    const fnName    = `ivxTrigger_${index}`;
    const trigger   = node.trigger;
    const recurring = node.recurring;

    const jsBody = transpileBodyToJS(node.body, globals);

    // Trigger installation
    let triggerSetup = '';
    if (trigger === 'time') {
      const timeStr = node.source?.value ?? '09:00';
      const [hh, mm] = timeStr.split(':');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (recurring) {
        triggerSetup = `  ScriptApp.newTrigger('${fnName}')
    .timeBased()
    .atHour(${parseInt(hh,10)})
    .nearMinute(${parseInt(mm||'0',10)})
    .everyDays(1)
    .create();`;
      } else {
        // Build the target date string in the user's local timezone
        // so Apps Script schedules it correctly regardless of server timezone
        triggerSetup = `  // Target: ${timeStr} in ${tz}
  var _now = new Date();
  var _tzOffset = new Date().toLocaleString('en-US', {timeZone: '${tz}', hour12: false, hour: '2-digit', minute: '2-digit'});
  var _d = new Date();
  _d.setHours(${parseInt(hh,10)}, ${parseInt(mm||'0',10)}, 0, 0);
  // Adjust for timezone offset between UTC and ${tz}
  var _localNow = new Date(_now.toLocaleString('en-US', {timeZone: '${tz}'}));
  var _tzDiff = _now - _localNow;
  _d = new Date(_d.getTime() + _tzDiff);
  if (_d < new Date()) _d.setDate(_d.getDate() + 1);
  ScriptApp.newTrigger('${fnName}').timeBased().at(_d).create();`;
      }
    } else if (trigger === 'sheets') {
      const sheetName = globals && node.source?.type === 'Identifier' && globals.has(node.source.name)
        ? jsLiteral(globals.get(node.source.name))
        : (node.source ? emitExpr(node.source, globals) : '""');
      triggerSetup = `  var _ss = SpreadsheetApp.openByName(${sheetName});
  ScriptApp.newTrigger('${fnName}').forSpreadsheet(_ss).onEdit().create();`;
    } else if (trigger === 'email') {
      triggerSetup = `  ScriptApp.newTrigger('${fnName}')
    .timeBased().everyMinutes(${recurring ? 5 : 1}).create();`;
    }

    // One-shot self-deletion
    const deleteSelf = recurring ? '' : `
  // One-shot: remove this trigger after firing
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === '${fnName}')
    .forEach(t => ScriptApp.deleteTrigger(t));`;

    // Trigger-specific preamble
    let preamble = '';
    if (trigger === 'email') {
      const addr = node.source ? emitExpr(node.source, globals) : '""';
      preamble = `  var _threads = GmailApp.search('is:unread from:' + ${addr}, 0, 1);
  if (!_threads.length) return;
  var _msg = _threads[0].getMessages()[0];
  var request = { subject: _msg.getSubject(), from: _msg.getFrom(), body: _msg.getPlainBody() };
  _msg.markRead();`;
    } else if (trigger === 'sheets') {
      preamble = `  var request = e;`;
    }

    const fn = `function ${fnName}(e) {
${preamble}
${jsBody}
${deleteSelf}
}`;

    return { fnName, fn, triggerSetup };
  }

  // Build the full Apps Script project
  function buildProject(waitBlocks, globals) {
    const functions = [], setups = [];
    const services  = new Set();

    waitBlocks.forEach((node, i) => {
      const { fn, fnName, triggerSetup } = transpileWaitBlock(node, i, globals);
      functions.push(fn);
      if (triggerSetup) setups.push(triggerSetup);

      // Scan trigger type AND entire body recursively for every service used
      const scanNode = n => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(scanNode); return; }
        switch (n.type) {
          case 'Gmail':       services.add('gmail');  break;
          case 'SheetsOpen':  services.add('sheets'); break;
          case 'Save':        services.add('drive');  break;
        }
        // Recurse into all child arrays
        if (Array.isArray(n.body))    n.body.forEach(scanNode);
        if (Array.isArray(n.else_))   n.else_.forEach(scanNode);
        if (Array.isArray(n.params))  n.params.forEach(scanNode);
        if (n.expr)      scanNode(n.expr);
        if (n.condition) scanNode(n.condition);
        if (n.left)      scanNode(n.left);
        if (n.right)     scanNode(n.right);
      };

      // Trigger type adds its own service
      if (node.trigger === 'email')  services.add('gmail');
      if (node.trigger === 'sheets') services.add('sheets');

      // Scan body for everything else
      scanNode(node.body);
    });

    const oauthScopes = [
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/script.projects',
    ];
    if (services.has('gmail'))  oauthScopes.push('https://www.googleapis.com/auth/gmail.modify');
    if (services.has('sheets')) oauthScopes.push('https://www.googleapis.com/auth/spreadsheets');
    if (services.has('drive'))  oauthScopes.push('https://www.googleapis.com/auth/drive.file');

    const setupFn = `function ivxSetupTriggers() {
  // Remove existing IVX triggers
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction().startsWith('ivxTrigger_'))
    .forEach(t => ScriptApp.deleteTrigger(t));
  // Install new triggers
${setups.join('\n')}
}`;

    const code = [
      '// Auto-generated by IVX — do not edit manually',
      '// Re-run your IVX program to regenerate',
      '',
      setupFn,
      '',
      ...functions,
    ].join('\n');

    // Scopes populated by body scanner above

    const manifest = JSON.stringify({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dependencies: {},
      exceptionLogging: 'STACKDRIVER',
      runtimeVersion: 'V8',
      oauthScopes,
    }, null, 2);

    return { code, manifest };
  }

  // Deploy to Apps Script REST API
  async function deploy(waitBlocks, globals, token) {
    if (!token) throw new Error('Not signed in to Google');

    const { code, manifest } = buildProject(waitBlocks, globals);

    const API    = 'https://script.googleapis.com/v1/projects';
    const DRIVE  = 'https://www.googleapis.com/drive/v3';
    const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Get or create the persistent IVX script project
    if (!localStorage.getItem('ivx_script_id')) {
      localStorage.setItem('ivx_script_id', '1ozcWRzBjlR8fltP3yM5WK2EJryw57mKJq9xgKdaq6iMOjK1spLib1VJf');
    }
    let scriptId = localStorage.getItem('ivx_script_id');

    // Try to update existing project — if it fails with 404, create a new one
    let upRes = await fetch(API + '/' + scriptId + '/content', {
      method: 'PUT', headers,
      body: JSON.stringify({
        files: [
          { name: 'ivx_triggers', type: 'SERVER_JS', source: code },
          { name: 'appsscript',   type: 'JSON',       source: manifest },
        ],
      }),
    });

    if (!upRes.ok) {
      const err = await upRes.json().catch(() => ({}));
      if (err?.error?.code === 404 || err?.error?.status === 'NOT_FOUND') {
        // Project was deleted — create a new one
        const createRes = await fetch(API, {
          method: 'POST', headers,
          body: JSON.stringify({ title: 'IVX Triggers' }),
        });
        if (!createRes.ok) {
          const cerr = await createRes.json().catch(() => ({}));
          throw new Error('Apps Script create failed: ' + (cerr?.error?.message ?? createRes.statusText));
        }
        scriptId = (await createRes.json()).scriptId;
        localStorage.setItem('ivx_script_id', scriptId);

        // Retry the update with the new project
        upRes = await fetch(API + '/' + scriptId + '/content', {
          method: 'PUT', headers,
          body: JSON.stringify({
            files: [
              { name: 'ivx_triggers', type: 'SERVER_JS', source: code },
              { name: 'appsscript',   type: 'JSON',       source: manifest },
            ],
          }),
        });
        if (!upRes.ok) {
          const uerr = await upRes.json().catch(() => ({}));
          throw new Error('Apps Script update failed: ' + (uerr?.error?.message ?? upRes.statusText));
        }
      } else {
        throw new Error('Apps Script update failed: ' + (err?.error?.message ?? upRes.statusText));
      }
    }

    // Check if this is the first deploy (no triggers installed yet)
    const triggersRes = await fetch('https://script.googleapis.com/v1/projects/' + scriptId + '/triggers', { headers });
    const triggersData = triggersRes.ok ? await triggersRes.json() : {};
    const existingTriggers = (triggersData.triggers || []).filter(t => t.functionName && t.functionName.startsWith('ivxTrigger_'));
    const firstDeploy = existingTriggers.length === 0;

    return { scriptId, triggerCount: waitBlocks.length, firstDeploy };
  }

  // Persist script ID — localStorage first (reliable), Drive as backup
  async function _loadScriptId(token, DRIVE) {
    // Try localStorage first — fastest and most reliable
    const local = localStorage.getItem('ivx_script_id');
    if (local) return local;

    // Fall back to Drive
    const h = { 'Authorization': 'Bearer ' + token };
    const q = encodeURIComponent("name='ivx_config.json' and trashed=false");
    const res = await fetch(DRIVE + '/files?q=' + q + '&fields=files(id)&spaces=drive', { headers: h });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.files || !data.files.length) return null;
    const content = await fetch(DRIVE + '/files/' + data.files[0].id + '?alt=media', { headers: h });
    if (!content.ok) return null;
    try {
      const j = await content.json();
      if (j.scriptId) {
        localStorage.setItem('ivx_script_id', j.scriptId); // cache locally
        return j.scriptId;
      }
      return null;
    } catch(e) { return null; }
  }

  async function _saveScriptId(scriptId, token, DRIVE, UPLOAD) {
    // Always save to localStorage immediately
    if (scriptId) {
      localStorage.setItem('ivx_script_id', scriptId);
    } else {
      localStorage.removeItem('ivx_script_id');
    }

    // Also persist to Drive for cross-device/cross-browser access
    const h = { 'Authorization': 'Bearer ' + token };
    const body = JSON.stringify({ scriptId: scriptId });
    const q = encodeURIComponent("name='ivx_config.json' and trashed=false");
    const res = await fetch(DRIVE + '/files?q=' + q + '&fields=files(id)&spaces=drive', { headers: h });
    const data = res.ok ? await res.json() : {};
    if (data.files && data.files.length) {
      await fetch(UPLOAD + '/files/' + data.files[0].id + '?uploadType=media', {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body,
      });
    } else {
      const meta = JSON.stringify({ name: 'ivx_config.json', mimeType: 'application/json' });
      const boundary = 'ivxboundary';
      const form = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + meta +
                   '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body +
                   '\r\n--' + boundary + '--';
      await fetch(UPLOAD + '/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: form,
      });
    }
  }

  function extractWaitBlocks(ast) {
    const blocks = [];
    const walk = stmts => {
      if (!Array.isArray(stmts)) return;
      for (const stmt of stmts) {
        if (!stmt) continue;
        if (stmt.type === 'WaitBlock') blocks.push(stmt);
        if (Array.isArray(stmt.body))  walk(stmt.body);
        if (Array.isArray(stmt.else_)) walk(stmt.else_);
      }
    };
    walk(ast?.body);
    return blocks;
  }

  return { deploy, extractWaitBlocks, buildProject };
})();

