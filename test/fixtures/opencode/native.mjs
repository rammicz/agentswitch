// Synthetic OpenCode 1.19.6 session/message/part profile, upstream f4e363c8295fa90a03dddc451882fffe8fbce357.
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export const id='ses_synthetic001';
export async function fixture(path,cwd,{revert=null}={}) {
 await mkdir(dirname(path),{recursive:true});const db=new DatabaseSync(path);
 db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,parent_id TEXT,title TEXT,version TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER,revert TEXT);
 CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
 CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
 CREATE TABLE session_message(session_id TEXT,data TEXT); CREATE TABLE credential(value TEXT); CREATE TABLE account(access_token TEXT);`);
 db.prepare('INSERT INTO credential VALUES (?)').run('PRIVATE_CREDENTIAL');db.prepare('INSERT INTO account VALUES (?)').run('PRIVATE_TOKEN');
 db.prepare('INSERT INTO session_message VALUES (?,?)').run(id,'PRIVATE_CONFLICTING_PROJECTION');
 db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,cwd,null,null,'OpenCode synthetic','1.19.6',1795255200000,1795255200000,null,revert&&JSON.stringify(revert));
 const message=(mid,role,time,extra={})=>db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(mid,id,time,time,JSON.stringify({role,time:{created:time,...(role==='assistant'?{completed:time+1}:{})},...extra}));
 const part=(pid,mid,data)=>db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(pid,mid,id,1,1,JSON.stringify(data));
 message('msg_b','assistant',2);message('msg_a','user',1,{system:'PRIVATE_SYSTEM'});
 part('prt_b','msg_a',{type:'text',text:'OpenCode public NEEDLE_SECRET'});part('prt_a','msg_a',{type:'text',text:'First public'});
 for(const [pid,data] of [['prt_c',{type:'reasoning',text:'PRIVATE_REASONING'}],['prt_d',{type:'text',text:'PRIVATE_SYNTHETIC',synthetic:true}],['prt_e',{type:'text',text:'PRIVATE_IGNORED',ignored:true}],['prt_f',{type:'file',url:'PRIVATE_FILE'}]])part(pid,'msg_a',data);
 part('prt_g','msg_b',{type:'tool',state:{status:'completed',input:{secret:'PRIVATE_INPUT'},metadata:{secret:'PRIVATE_METADATA'},output:'Safe output'}});
 part('prt_h','msg_b',{type:'tool',state:{status:'error',error:'Safe error'}});part('prt_i','msg_b',{type:'text',text:'OpenCode answer'});
 db.close();return path;
}
