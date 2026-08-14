"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Interpreter = exports.Env = void 0;

class Env {
    constructor(parent = null) {
        this.parent = parent;
        this.vars = new Map();
    }
    get(name) {
        if (this.vars.has(name)) return this.vars.get(name);
        if (this.parent) return this.parent.get(name);
        return undefined;
    }
    set(name, value) {
        this.vars.set(name, value);
    }
    has(name) {
        if (this.vars.has(name)) return true;
        return this.parent?.has(name) ?? false;
    }
}
exports.Env = Env;

class Interpreter {
    constructor(options = {}) {
        this.onOutput = options.onOutput ?? (v => console.log(v));
        this.onInput = options.onInput ?? (() => "");
        this.globals = new Env();
        this.functions = new Map();
    }

    async run(nodes, edges, env = this.globals) {
        let currentNode = nodes.find(n => n.kind === 'Start') || nodes[0];
        let safetyCounter = 0;

        while (currentNode && safetyCounter < 10000) {
            safetyCounter++;
            const text = (currentNode.text || "").trim();
            let nextLabel = undefined;
            // 1. Handle Decisions (if/loop conditions)
            if (currentNode.kind === 'Decision') {
                const condition = text;
                const result = await this.evalCondition(condition, env);
                nextLabel = result ? 'yes' : 'no';
            } 
            // 2. Handle Assignments
            else if (currentNode.kind === 'Process') {
                const parts = text.split(/\s+/);
                
                // --- EXPERIMENTAL: from "url" use * ---
                if (parts[0] === 'from' && parts[2] === 'use') {
                    await this.loadModule(parts[1].replace(/['"]/g, ''));
                }
                
                else if (parts.length >= 2) {
                    const name = parts[0].trim();
                    const valExpr = parts.slice(1).join(' ').trim();
                    env.set(name, await this.evalExpr(valExpr, env));
                }
            } 
            // 3. Handle Output
            else if (currentNode.kind === 'Output') {
                this.onOutput(await this.evalExpr(text, env));
            }
            else if (currentNode.kind === 'Function') {
                const name = text.split('(')[0].replace('fun ', '').trim();
                this.functions.set(name, { nodes, edges, startId: currentNode.id });
                // Skip the function body in normal execution
                break; 
            }

            const nextEdge = edges.find(e => e.from === currentNode.id && (nextLabel === undefined || e.label === nextLabel));
            if (!nextEdge) break;
            currentNode = nodes.find(n => n.id === nextEdge.to);
        }
    }

    async loadModule(url) {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const crypto = require('crypto');

        if (url.startsWith('http:')) throw new Error("Insecure protocol: HTTPS is mandatory for KH modules.");
        if (!url.startsWith('http')) url = 'https://' + url;

        // Create Cache Path
        const cacheDir = path.join(os.tmpdir(), 'kh_cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
        const urlHash = crypto.createHash('md5').update(url).digest('hex');
        const cachePath = path.join(cacheDir, urlHash + '.kh');

        let code;
        if (fs.existsSync(cachePath)) {
            this.onOutput(`📦 Loading from local cache...`);
            code = fs.readFileSync(cachePath, 'utf8');
        } else {
            this.onOutput(`🌐 Loading KH module: ${url}`);
            const res = await fetch(url);
            code = await res.text();
            fs.writeFileSync(cachePath, code);
        }
        
        // Generate Fingerprint (SHA-256)
        const hashHex = crypto.createHash('sha256').update(code).digest('hex');
        
        // TOFU Verification (Trust-On-First-Use)
        const hashFilePath = path.join(cacheDir, urlHash + '.hash');
        if (fs.existsSync(hashFilePath)) {
            const storedHash = fs.readFileSync(hashFilePath, 'utf8');
            if (storedHash !== hashHex) {
                this.onOutput(`🚨 SECURITY ALERT: The module at ${url} has been modified!`);
                this.onOutput(`   Expected: ${storedHash.substring(0, 16)}...`);
                this.onOutput(`   Received: ${hashHex.substring(0, 16)}...`);
                throw new Error(`Integrity Failure: Remote code changed at ${url}`);
            }
            this.onOutput(`🔒 Verified: ${urlHash.substring(0, 8)}... (Integrity Match)`);
        } else {
            fs.writeFileSync(hashFilePath, hashHex);
            this.onOutput(`🛡️ New module pinned: ${urlHash.substring(0, 8)}...`);
        }

        const { parsekh } = require('./parser');
        const subGraph = parsekh(code);
        
        for (const node of subGraph.nodes) {
            if (node.kind === 'Function') {
                const name = node.text.split('(')[0].replace('fun ', '').trim();
                this.functions.set(name, { nodes: subGraph.nodes, edges: subGraph.edges, startId: node.id });
            }
            if (node.kind === 'Process') {
                const p = node.text.split(/\s+/);
                if (p.length >= 2 && p[0] !== 'from') {
                    this.globals.set(p[0], await this.evalExpr(p.slice(1).join(' '), this.globals));
                }
            }
        }
        this.onOutput(`✅ Module ready.`);
    }

    async evalExpr(expr, env) {
        if (env.has(expr)) return env.get(expr);
        if (!isNaN(expr)) return Number(expr);
        
        // --- NEW: Function Calls ---
        const callMatch = expr.match(/^([A-Za-z_]\w*)\((.*)\)$/);
        if (callMatch) {
            const name = callMatch[1];
            const argsStr = callMatch[2];
            if (this.functions.has(name)) {
                const func = this.functions.get(name);
                const subEnv = new Env(this.globals);
                await this.run(func.nodes, func.edges, subEnv);
                return subEnv.get('result') || 0;
            }
        }

        if (expr.includes('+')) {
            const p = expr.split('+');
            return (await this.evalExpr(p[0].trim(), env)) + (await this.evalExpr(p[1].trim(), env));
        }
        return expr.replace(/['"]/g, '');
    }

    async evalCondition(cond, env) {
        if (cond.includes('<')) {
            const p = cond.split('<');
            return (await this.evalExpr(p[0].trim(), env)) < (await this.evalExpr(p[1].trim(), env));
        }
        if (cond.includes('>')) {
            const p = cond.split('>');
            return (await this.evalExpr(p[0].trim(), env)) > (await this.evalExpr(p[1].trim(), env));
        }
        return !!(await this.evalExpr(cond, env));
    }
}
exports.Interpreter = Interpreter;
