import fs from 'node:fs';
import { client } from './db.mjs';
const c=await client();
const r=await c.query(`select id,
  state->'financialHistory' as fh,
  state->'fleet' as fleet,
  (state->>'newWorldRestrictions')::boolean as nwr
  from "Airline"`);
fs.writeFileSync('states.json', JSON.stringify(r.rows));
console.log('cached', r.rows.length, (fs.statSync('states.json').size/1e6).toFixed(1)+'MB');
await c.end();
