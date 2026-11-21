// Source-derived synthetic records; see provenance.json. No captured histories.
export const ids = Array.from({length:12}, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12,'0')}`);
export const stamp = '2026-11-20T12:00:00.000Z';
export function entry(sessionId, cwd, uuid, parentUuid, type, content, extra = {}) {
  return {type,uuid,parentUuid,sessionId,cwd,timestamp:stamp,message:{...(type==='assistant'?{id:`response-${uuid}`} : {}),role:type,content},...extra};
}
export const encode = records => records.map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n')+'\n';
export function parallel(id,cwd) {
  const e=(uuid,parent,type,content,extra)=>entry(id,cwd,uuid,parent,type,content,extra);
  return [
    e('u',null,'user','Request'),
    e('old','u','assistant','PRIVATE_ABANDONED'),
    e('a','u','assistant',[{type:'thinking',thinking:'PRIVATE_THINKING',signature:'PRIVATE_SIGNATURE'},{type:'text',text:'Working'}],{message:{id:'response-main',content:[{type:'thinking',thinking:'PRIVATE_THINKING'},{type:'text',text:'Working'}]}}),
    e('c0','a','assistant',[{type:'tool_use',id:'call0',input:{secret:'PRIVATE_INPUT',cwd:'/fake',customTitle:'PRIVATE_TITLE'}}],{message:{id:'response-main',content:[{type:'tool_use',id:'call0',input:{secret:'PRIVATE_INPUT',cwd:'/fake',customTitle:'PRIVATE_TITLE'}}]}}),
    e('c1','c0','assistant',[],{message:{id:'response-main',content:[{type:'tool_use',id:'call1',input:{secret:'PRIVATE_INPUT'}}]}}),
    e('r1','c1','user',[{type:'tool_result',tool_use_id:'call1',content:[{type:'text',text:'Second result'},{type:'image',data:'PRIVATE_BINARY'}]}]),
    e('r0','c0','user',[{type:'tool_result',tool_use_id:'call0',content:'First failed',is_error:true}]),
    e('z','r0','assistant','Done'),
    e('p','z','progress',undefined),
    e('s','p','system','PRIVATE_SYSTEM'),
    e('side','u','user','PRIVATE_SIDECHAIN',{isSidechain:true,agentId:'other'}),
    e('team','u','user','PRIVATE_TEAM',{teamName:'team'}),
    e('meta','u','user','PRIVATE_META',{isMeta:true}),
  ];
}
