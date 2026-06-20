// Registers the on-the-fly JSX loader, then nothing else. Used via:
//   node --import ./tools/_register-loader.mjs tools/ui-smoke-test.mjs
import { register } from 'node:module';
register('./_jsx-loader.mjs', import.meta.url);
