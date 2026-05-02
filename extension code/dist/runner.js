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

            if (currentNode.kind === 'Decision') {
                nextLabel = this.evalCondition(text, env) ? 'yes' : 'no';
            } 
            else if (currentNode.kind === 'Process') {
                const parts = text.split(/\s+/);
                if (parts[0] === 'from' && parts[2] === 'use') {
                    await this.loadModule(parts[1].replace(/['"]/g, ''));
                } else if (parts.length >= 2) {
                    env.set(parts[0], this.evalExpr(parts.slice(1).join(' '), env));
                }
            } 
            else if (currentNode.kind === 'Output') {
                this.onOutput(this.evalExpr(text, env));
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
        if (!url.startsWith('http')) url = 'https://' + url;
        this.onOutput(`🌐 Loading KH module: ${url}`);
        try {
            const res = await fetch(url);
            const code = await res.text();
            const { parsekh } = require('./parser');
            const subGraph = parsekh(code);
            
            // Register functions from the module
            for (const node of subGraph.nodes) {
                if (node.kind === 'Function') {
                    const name = node.text.split('(')[0].replace('fun ', '').trim();
                    this.functions.set(name, { nodes: subGraph.nodes, edges: subGraph.edges, startId: node.id });
                }
                if (node.kind === 'Process') {
                    const p = node.text.split(/\s+/);
                    if (p.length >= 2 && p[0] !== 'from') {
                        this.globals.set(p[0], this.evalExpr(p.slice(1).join(' '), this.globals));
                    }
                }
            }
            this.onOutput(`✅ Module loaded.`);
        } catch (e) {
            this.onOutput(`❌ Module error: ${e.message}`);
        }
    }

    evalExpr(expr, env) {
        if (env.has(expr)) return env.get(expr);
        if (!isNaN(expr)) return Number(expr);
        if (expr.includes('+')) {
            const p = expr.split('+');
            return this.evalExpr(p[0].trim(), env) + this.evalExpr(p[1].trim(), env);
        }
        return expr.replace(/['"]/g, '');
    }

    evalCondition(cond, env) {
        if (cond.includes('<')) {
            const p = cond.split('<');
            return this.evalExpr(p[0].trim(), env) < this.evalExpr(p[1].trim(), env);
        }
        if (cond.includes('>')) {
            const p = cond.split('>');
            return this.evalExpr(p[0].trim(), env) > this.evalExpr(p[1].trim(), env);
        }
        return !!this.evalExpr(cond, env);
    }
}
exports.Interpreter = Interpreter;
