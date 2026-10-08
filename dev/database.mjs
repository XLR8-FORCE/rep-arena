import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function database(path=':memory:'){
 const sqlite=new DatabaseSync(path);
 sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY);');
 const migrations=resolve(import.meta.dirname,'../drizzle');
 for(const file of (await readdir(migrations)).filter(x=>x.endsWith('.sql')).sort())if(!sqlite.prepare('SELECT name FROM _migrations WHERE name=?').get(file)){sqlite.exec(await readFile(resolve(migrations,file),'utf8'));sqlite.prepare('INSERT INTO _migrations(name) VALUES(?)').run(file);}
 const DB={prepare(sql){const make=args=>({bind(...values){return make(values);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};},sql,args});return make([]);},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const r=statements.map(s=>{const result=sqlite.prepare(s.sql).run(...s.args);return {meta:{changes:Number(result.changes)}};});sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return {DB,sqlite};
}
