// Synthetic public ConversationItem v1, xai-org/grok-build 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8.
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export const id='12345678-1234-4234-8234-123456789abc';
export const user=text=>({type:'user',content:[{type:'text',text}],prompt_index:1});
export async function fixture(root,cwd,{nativeId=id,bucket='opaque-long-path-hash',summary={},items}={}) {
 const directory=join(root,'sessions',bucket,nativeId);await mkdir(directory,{recursive:true});
 const metadata={info:{id:nativeId,cwd},chat_format_version:1,session_summary:'Grok synthetic',generated_title:'Grok public session',created_at:'2026-09-29T10:00:00Z',updated_at:'2026-09-29T11:00:00Z',...summary};
 const rows=items??[{type:'system',content:'PRIVATE_SYSTEM'},{type:'user',content:[{type:'text',text:'PRIVATE_LEGACY_PREFIX'}]},user('Grok public NEEDLE_SECRET'),{type:'reasoning',text:'PRIVATE_REASONING',encrypted:'PRIVATE_ENCRYPTED'},{type:'user',synthetic_reason:'system_reminder',content:[{type:'text',text:'PRIVATE_SYNTHETIC'}]},{type:'assistant',content:'Grok answer',reasoning:'PRIVATE_OLD_REASONING',tool_calls:[{arguments:'PRIVATE_ARGS'}]},{type:'tool_result',tool_call_id:'t1',content:'Safe output'}];
 const path=join(directory,'summary.json'),history=join(directory,'chat_history.jsonl');await writeFile(path,JSON.stringify(metadata));await writeFile(history,rows.map(JSON.stringify).join('\n')+'\n');return {directory,path,history,metadata,rows};
}
