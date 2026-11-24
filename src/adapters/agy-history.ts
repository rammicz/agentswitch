import { createHash } from 'node:crypto';
import type { HistoryItem } from '../domain.js';

const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const validText = (v:unknown):v is string => typeof v==='string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]/u.test(v);
// Unknown top-level keys from newer releases are ignored and never projected; known keys keep their checks.
const modelFields = ['model','input_tokens','cache_read_tokens','output_tokens','thinking','tool_calls'];
const onlyPlainKnown = (row:Record<string,unknown>):boolean => !modelFields.some(key=>Object.hasOwn(row,key));
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

/**
 * Complete means the reviewed public-text projection. Tool calls, their results and system messages are excluded
 * steps whose calls, results and bodies are never read into items, whatever their tool name or status. `lagging`
 * marks a writer that has not yet appended the last step its idle summary counts.
 */
export function parseAgyHistory(text:string,id:string,stepCount:number,limits:{maxItems:number;maxLineBytes:number}):{items:HistoryItem[];excludedSteps:number[];truncatedSteps:number[];lagging:boolean} {
  if(!text.endsWith('\n'))throw Error('partial-record');
  const lines=text.slice(0,-1).split('\n');
  const lagging=lines.length===stepCount-1;
  if((lines.length!==stepCount&&!lagging) || lines.length>limits.maxItems || !lines.length)throw Error('invalid-ordinal');
  const records=lines.map((line,index)=>{
    if(Buffer.byteLength(line)>limits.maxLineBytes)throw Error('input-limit');
    const row:unknown=JSON.parse(line);
    if(!object(row))throw Error('unsupported-shape');
    if(row.step_index!==index)throw Error('invalid-ordinal');
    if(typeof row.created_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(row.created_at)||!Number.isFinite(Date.parse(row.created_at)))throw Error('unsupported-shape');
    if(row.thinking!==undefined && typeof row.thinking!=='string')throw Error('unsupported-shape');
    // The producer lists the fields it shortened; only `content` of a projected step is public text.
    if(row.truncated_fields!==undefined&&(!Array.isArray(row.truncated_fields)||!row.truncated_fields.every(field=>typeof field==='string')))throw Error('unsupported-shape');
    for(const key of ['input_tokens','cache_read_tokens','output_tokens'])if(row[key]!==undefined&&(!Number.isSafeInteger(row[key])||Number(row[key])<0))throw Error('unsupported-shape');
    if(row.model!==undefined&&(!validText(row.model)||row.model.length>200))throw Error('unsupported-shape');
    return row;
  });
  const items:HistoryItem[]=[],excludedSteps:number[]=[],truncatedSteps:number[]=[];
  // Results are only accepted after a tool-call step, until the next public item.
  let previousTime=0,inTools=false;
  for(let ordinal=0;ordinal<records.length;ordinal++) {
    const row=records[ordinal]!;
    const time=Date.parse(row.created_at as string);
    if(time<previousTime)throw Error('invalid-ordinal');previousTime=time;
    if(typeof row.status!=='string')throw Error('unsupported-shape');
    if(row.type==='PLANNER_RESPONSE'&&row.source==='MODEL'&&row.tool_calls!==undefined) {
      if(!items.length)throw Error('partial-record');
      if(!Array.isArray(row.tool_calls))throw Error('unsupported-shape');
      excludedSteps.push(ordinal);inTools=true;
      if(row.content===undefined)continue;
    } else if((row.type==='GENERIC'&&row.source==='MODEL'&&inTools||row.type==='SYSTEM_MESSAGE'&&row.source==='SYSTEM')&&
              typeof row.content==='string'&&onlyPlainKnown(row)) {excludedSteps.push(ordinal);continue;}
    // Projected user and assistant steps must have completed.
    if(row.status!=='DONE')throw Error('unsupported-shape');
    let role:HistoryItem['role'],value:string;
    if(row.type==='USER_INPUT'&&row.source==='USER_EXPLICIT'&&validText(row.content)&&row.thinking===undefined&&row.tool_calls===undefined) {
      if(!onlyPlainKnown(row))throw Error('unsupported-shape');
      if(items.length&&items.at(-1)!.role!=='assistant')throw Error('partial-record');
      role='user';value=request(row.content);inTools=false;
    } else if(row.type==='PLANNER_RESPONSE'&&row.source==='MODEL') {
      if(!items.length)throw Error('partial-record');
      if(row.tool_calls===undefined)inTools=false;
      if(!validText(row.content)||!row.content)throw Error('unsupported-shape');
      role='assistant';value=row.content;
    } else throw Error('unsupported-shape');
    if(Array.isArray(row.truncated_fields)&&row.truncated_fields.includes('content'))truncatedSteps.push(ordinal);
    items.push({id:createHash('sha256').update(JSON.stringify([id,row.step_index,role,value])).digest('hex'),role,text:value,status:'complete'});
  }
  if(items.at(-1)?.role!=='assistant')throw Error('partial-record');
  return {items,excludedSteps,truncatedSteps,lagging};
}
