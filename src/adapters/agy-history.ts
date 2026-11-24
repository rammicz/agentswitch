import { createHash } from 'node:crypto';
import type { HistoryItem } from '../domain.js';

const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const validText = (v:unknown):v is string => typeof v==='string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]/u.test(v);
const fields = new Set(['step_index','source','type','status','created_at','content','model','input_tokens','cache_read_tokens','output_tokens','thinking','tool_calls']);
const plainFields = new Set(['step_index','source','type','status','created_at','content']);
// Unknown top-level keys from newer releases are ignored and never projected; known keys keep their checks.
const onlyPlainKnown = (row:Record<string,unknown>):boolean => Object.keys(row).every(key=>!fields.has(key)||plainFields.has(key));
function request(text:string):string {
  const boundary='\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n';
  const parts=text.split(boundary);
  if(parts.length!==2 || !parts[0]!.startsWith('<USER_REQUEST>\n')) throw Error('invalid-boundary');
  const value=parts[0]!.slice('<USER_REQUEST>\n'.length);
  if(!value || /<\/?(?:USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/.test(value))throw Error('invalid-boundary');
  if(!/^[\s\S]*\n<\/ADDITIONAL_METADATA>(?:\n<USER_SETTINGS_CHANGE>\n[\s\S]*\n<\/USER_SETTINGS_CHANGE>)?$/.test(parts[1]!) ||
     (parts[1]!.match(/<\/ADDITIONAL_METADATA>/g)?.length??0)!==1 ||
     (parts[1]!.match(/<USER_SETTINGS_CHANGE>/g)?.length??0)!==(parts[1]!.match(/<\/USER_SETTINGS_CHANGE>/g)?.length??0))throw Error('invalid-boundary');
  return value;
}

/** Complete means the reviewed public-text projection. Known tool carriers are accounted separately. */
export function parseAgyHistory(text:string,id:string,stepCount:number,limits:{maxItems:number;maxLineBytes:number}):{items:HistoryItem[];excludedSteps:number[]} {
  if(!text.endsWith('\n'))throw Error('partial-record');
  const lines=text.slice(0,-1).split('\n');
  if(lines.length!==stepCount || lines.length>limits.maxItems || !lines.length)throw Error('invalid-ordinal');
  const records=lines.map((line,index)=>{
    if(Buffer.byteLength(line)>limits.maxLineBytes)throw Error('input-limit');
    const row:unknown=JSON.parse(line);
    if(!object(row)||row.step_index!==index||row.status!=='DONE'||
       typeof row.created_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(row.created_at)||!Number.isFinite(Date.parse(row.created_at)))throw Error('unsupported-shape');
    if(row.thinking!==undefined && typeof row.thinking!=='string')throw Error('unsupported-shape');
    for(const key of ['input_tokens','cache_read_tokens','output_tokens'])if(row[key]!==undefined&&(!Number.isSafeInteger(row[key])||Number(row[key])<0))throw Error('unsupported-shape');
    if(row.model!==undefined&&(!validText(row.model)||row.model.length>200))throw Error('unsupported-shape');
    return row;
  });
  for(let index=1;index<records.length;index++) {
    if(Date.parse(records[index]!.created_at as string)<Date.parse(records[index-1]!.created_at as string)) {
      throw Error('invalid-ordinal');
    }
  }
  const items:HistoryItem[]=[],excludedSteps:number[]=[];
  let previousTime=0;
  for(let ordinal=0;ordinal<records.length;ordinal++) {
    const row=records[ordinal]!;
    const time=Date.parse(row.created_at as string);
    if(time<previousTime)throw Error('invalid-ordinal');previousTime=time;
    let role:HistoryItem['role'],value:string;
    if(row.type==='USER_INPUT'&&row.source==='USER_EXPLICIT'&&validText(row.content)&&row.thinking===undefined&&row.tool_calls===undefined) {
      if(!onlyPlainKnown(row))throw Error('unsupported-shape');
      if(items.length&&items.at(-1)!.role!=='assistant')throw Error('partial-record');
      role='user';value=request(row.content);
    } else if(row.type==='PLANNER_RESPONSE'&&row.source==='MODEL') {
      if(items.at(-1)?.role!=='user')throw Error('partial-record');
      if(row.tool_calls!==undefined) {
        const call=Array.isArray(row.tool_calls)&&row.tool_calls.length===1?row.tool_calls[0]:undefined;
        const result=records[ordinal+1];
        if(row.content!==undefined||!object(call)||
           Object.keys(call).some(k=>!['name','args'].includes(k))||call.name!=='read_file'||
           !object(call.args)||Object.keys(call.args).length!==1||typeof call.args.Path!=='string'||
           !result||result.type!=='GENERIC'||result.source!=='MODEL'||typeof result.content!=='string'||
           !onlyPlainKnown(result)) {
          throw Error('unsupported-shape');
        }
        excludedSteps.push(ordinal,ordinal+1);ordinal++;continue;
      }
      if(!validText(row.content)||!row.content)throw Error('unsupported-shape');
      role='assistant';value=row.content;
    } else throw Error('unsupported-shape');
    items.push({id:createHash('sha256').update(JSON.stringify([id,row.step_index,role,value])).digest('hex'),role,text:value,status:'complete'});
  }
  if(items.at(-1)?.role!=='assistant')throw Error('partial-record');
  return {items,excludedSteps};
}
