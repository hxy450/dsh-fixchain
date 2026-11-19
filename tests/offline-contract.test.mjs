import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {memoryRuntime} from '../lib/offline.js';
test('standalone distillation runtime needs no evaluation or Studio plugin path', async t => {
 const root=await mkdtemp(join(tmpdir(),'fixchain-runtime-')); t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'runtime.json');
 await writeFile(file,JSON.stringify({schemaVersion:'hmbot.rsi.distillation-runtime/1',python:'python3',skills:'/data/skills',migloop:{directory:'/data/migloop'}}));
 const runtime=await memoryRuntime(file); assert.equal(runtime.skills,'/data/skills'); assert.equal(runtime.pluginRoot,undefined); assert.equal(runtime.evaluation,undefined);
});
