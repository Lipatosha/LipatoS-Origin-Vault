import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {test} from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const langs=['en','cn','ru'];
function leaves(obj,p='',out={}) {for(const[k,v] of Object.entries(obj)){const key=p ? p+'.'+k:k;if(v && typeof v==='object'&&!Array.isArray(v))leaves(v,key,out);else out[key]=v;}return out;}
const files=Object.fromEntries(langs.map(l=>[l,leaves(JSON.parse(readFileSync(path.join(root,'lang',l+'.json'),'utf8')))]));
const vars=s=>[...s.matchAll(/\{[^{}]+\}|<[^<>]+>/g)].map(x=>x[0]).sort();
test('Russian localization covers all 772 keys and preserves variables',()=>{
 assert.equal(Object.keys(files.en).length,772);
 assert.deepEqual(Object.keys(files.en).sort(),Object.keys(files.ru).sort());
 assert.ok(Object.keys(files.cn).length >= 700, 'Original Chinese locale retained');
 for(const [k,eng] of Object.entries(files.en)){
  assert.equal(typeof files.ru[k],'string',k);
  assert.ok(files.ru[k].length>0,k);
  assert.deepEqual(vars(eng),vars(files.ru[k]),k);
 }
});
test('Foundry manifest registers Russian and preserves original module id',()=>{
 const m=JSON.parse(readFileSync(path.join(root,'module.json'),'utf8'));
 assert.equal(m.id,'origin-vault');
 assert.equal(m.version,'2.8.2');
 assert.ok(m.languages.some(l=>l.lang==='ru'&&l.path==='lang/ru.json'));
});
