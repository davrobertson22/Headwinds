import fs from 'node:fs';
import pg from 'pg';
const envPath = new URL('../../apps/headwinds-server/.env', import.meta.url).pathname;
const env = Object.fromEntries(fs.readFileSync(envPath,'utf8').split('\n')
  .filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
export const url = env.DATABASE_URL;
export async function client(){
  const c = new pg.Client({ connectionString: url, ssl:{ rejectUnauthorized:false } });
  await c.connect();
  return c;
}
