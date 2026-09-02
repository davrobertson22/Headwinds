import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rd = require('react-dom');
rd.createPortal = function stubPortal(children) { return children; };
const mod = await import('react-dom');
console.log('named import is stub?', mod.createPortal.name);
