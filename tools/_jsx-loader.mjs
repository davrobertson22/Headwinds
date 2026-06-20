// Minimal Node ESM loader that transpiles .jsx → React.createElement on the fly,
// so the real components can be server-rendered in tests without vite/esbuild
// (whose native binaries are the wrong arch in this sandbox) or a JSX preset
// (not installable offline). Only .jsx files are touched; .js pass through.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

// ── JSX → React.createElement transform (classic runtime) ──────────────────────
const isValidIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s);

function cleanText(v) {
  if (!/\S/.test(v)) return v.includes('\n') ? null : (v ? ' ' : null);
  let s = v.replace(/\s+/g, ' ');
  if (/^\s*\n/.test(v)) s = s.replace(/^ /, '');
  if (/\n\s*$/.test(v)) s = s.replace(/ $/, '');
  return s;
}

const jsxPlugin = ({ types: t }) => {
  const convertName = (node) => {
    if (t.isJSXIdentifier(node)) {
      return /^[a-z]/.test(node.name) && isValidIdent(node.name)
        ? t.stringLiteral(node.name)
        : t.identifier(node.name);
    }
    if (t.isJSXMemberExpression(node)) {
      return t.memberExpression(convertName(node.object), t.identifier(node.property.name));
    }
    return t.stringLiteral('div');
  };
  const convertAttrs = (attrs) => {
    if (!attrs.length) return t.nullLiteral();
    const props = [];
    for (const a of attrs) {
      if (t.isJSXSpreadAttribute(a)) { props.push(t.spreadElement(a.argument)); continue; }
      const rawKey = t.isJSXNamespacedName(a.name) ? `${a.name.namespace.name}:${a.name.name.name}` : a.name.name;
      const key = isValidIdent(rawKey) ? t.identifier(rawKey) : t.stringLiteral(rawKey);
      let val;
      if (a.value == null) val = t.booleanLiteral(true);
      else if (t.isStringLiteral(a.value)) val = a.value;
      else if (t.isJSXExpressionContainer(a.value)) val = a.value.expression;
      else val = a.value;
      props.push(t.objectProperty(key, val));
    }
    return t.objectExpression(props);
  };
  const buildChildren = (children) => {
    const out = [];
    for (const c of children) {
      if (t.isJSXText(c)) { const s = cleanText(c.value); if (s != null) out.push(t.stringLiteral(s)); }
      else if (t.isJSXExpressionContainer(c)) { if (!t.isJSXEmptyExpression(c.expression)) out.push(c.expression); }
      else if (t.isJSXSpreadChild(c)) out.push(t.spreadElement(c.expression));
      else out.push(c); // already-transformed element / fragment
    }
    return out;
  };
  return {
    visitor: {
      JSXElement: { exit(path) {
        const o = path.node.openingElement;
        path.replaceWith(t.callExpression(
          t.memberExpression(t.identifier('React'), t.identifier('createElement')),
          [convertName(o.name), convertAttrs(o.attributes), ...buildChildren(path.node.children)],
        ));
      }},
      JSXFragment: { exit(path) {
        path.replaceWith(t.callExpression(
          t.memberExpression(t.identifier('React'), t.identifier('createElement')),
          [t.memberExpression(t.identifier('React'), t.identifier('Fragment')), t.nullLiteral(), ...buildChildren(path.node.children)],
        ));
      }},
    },
  };
};

export function transformJsx(src, filename) {
  const out = babel.transformSync(src, {
    babelrc: false, configFile: false,
    parserOpts: { plugins: ['jsx'] },
    plugins: [jsxPlugin],
    filename,
  });
  return `import React from 'react';\n${out.code}`;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const fp = fileURLToPath(url);
    return { format: 'module', shortCircuit: true, source: transformJsx(fs.readFileSync(fp, 'utf8'), fp) };
  }
  return nextLoad(url, context);
}
