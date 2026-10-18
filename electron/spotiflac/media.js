const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { service } = require('./packages')

const jobs = new WeakMap()
const MIME = { flac:'audio/flac',mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'audio/mp4',ogg:'audio/ogg',opus:'audio/ogg',wav:'audio/wav',webm:'audio/webm',aac:'audio/aac' }
const redact=text=>String(text||'').replace(/(hmac|token|signature|sig|key|secret|grant|code)=([^&\s"]+)/gi,'$1=…').replace(/qbza_[\w-]+/g,'qbza_…').slice(0,500)
function logFailure(db,key,id,error){
  try{
    const name=service(db).find(key)?.manifest?.displayName || key
    const line=`[SpotiFLAC] ${name}: couldn't prepare ${String(id).slice(0,80)} for playback: ${redact(error?.message)}${error?.errorType?` (${error.errorType})`:''}`
    try{require('electron-log').warn(line)}catch{console.warn(line)}
  }catch{}
}
function state(db) {let value=jobs.get(db);if(!value){value=new Map();jobs.set(db,value)}return value}
function cacheKey(db,key,id){const addon=service(db).find(key);if(!addon?.enabled)throw new Error('Addon is not available');return crypto.createHash('sha256').update(JSON.stringify([key,id,addon.digest,service(db).settings(addon).downloadQuality])).digest('hex')}
function cached(db,key,id){
  const hash=cacheKey(db,key,id),dir=path.join(service(db).root,'audio-cache')
  for(const ext of Object.keys(MIME)){const file=path.join(dir,`${hash}.${ext}`);try{if(fs.statSync(file).size){const now=new Date();fs.utimesSync(file,now,now);return {type:'file',file,mime:MIME[ext],headers:{},format:ext}}}catch{}}
  return null
}
function prepare(db,key,id,{force=false}={}){
  if(!force){const hit=cached(db,key,id);if(hit)return {ok:true,package:true}}
  const map=state(db),hash=cacheKey(db,key,id)
  const existing=[...map.values()].find(job=>job.hash===hash&&job.status==='running')
  if(existing)return {pending:true,operationId:existing.id}
  const job={id:crypto.randomUUID(),hash,key,itemId:id,status:'running',progress:0,controller:new AbortController()};map.set(job.id,job)
  job.liveReady=new Promise(resolve=>{job.markLive=resolve})
  const fetchAudio=()=>service(db).download(key,id,{purpose:'playback',signal:job.controller.signal,onLive:info=>liveUpdate(job,info),onProgress:update=>{job.progress=update.percent ?? job.progress;job.message=job.live?.ready?'Playing while it downloads…':update.message || 'Preparing audio…'}})
  // A worker that ran out of memory is retried once, in a fresh worker.
  job.promise=fetchAudio().catch(error=>{if(job.controller.signal.aborted||!/memory limit|out of memory/i.test(error?.message))throw error;logFailure(db,key,id,error);job.message='Retrying…';return fetchAudio()}).then(async result=>{
    try{
      const dir=path.join(service(db).root,'audio-cache');await fsp.mkdir(dir,{recursive:true})
      // Played as it arrived: the cache keeps those very bytes (a rewritten
      // copy would put a later seek at different offsets than the stream had).
      const source=job.live?.ready&&job.live.done&&fs.existsSync(job.live.file)?job.live.file:result.file
      const ext=path.extname(source).slice(1).toLowerCase()
      if(!MIME[ext])throw new Error('Unsupported cached audio container')
      const file=path.join(dir,`${hash}.${ext}`)
      job.controller.signal.throwIfAborted()
      await fsp.copyFile(source,`${file}.tmp`);job.controller.signal.throwIfAborted();await fsp.rename(`${file}.tmp`,file)
      job.status='done';job.progress=100;job.result={type:'file',file,mime:MIME[ext],headers:{},format:ext}
      // The cache joins Lokal's shared limit; installed code and credentials do not.
      require('../cache').trim({keep:[file]})
    }finally{await result.cleanup()}
  }).catch(error=>{
    job.status=job.controller.signal.aborted?'cancelled':'error';job.error=error.message
    // Kept in Lokal's log: without it a song that won't stream says nothing about why.
    if(job.status==='error')logFailure(db,key,id,error)
  }).finally(()=>{
    job.finishedAt=Date.now();const timer=setTimeout(()=>map.delete(job.id),5*60*1000);timer.unref?.()
  })
  return {pending:true,operationId:job.id}
}
// ---------------------------------------------------------------- playing while it downloads
//
// A song an addon downloads as one plain FLAC file can be listened to as it
// arrives: the player gets the growing file (its full size is known up
// front), and a seek past what's arrived waits for it. Anything else
// (encrypted, in pieces, or a file the addon post-processes) is played once
// it's complete, as before. After the download, the cached copy holds the
// same bytes, so seeking carries on from it.
const LIVE_MIN_BYTES=64*1024
function liveUpdate(job,{part,file,total,written,done}){
  // A new file, or a retry that started over (fewer bytes than before): a
  // new live state, so a reader of the old one stops rather than mixing them.
  if(!job.live||job.live.part!==part||!done&&(Number(written)||0)<job.live.written)job.live={part,file,total:Number(total)||0,written:0,done:false,ready:false,checked:false}
  const live=job.live
  live.written=Math.max(live.written,Number(written)||0);if(done)live.done=true
  if(live.ready||live.checked||!live.total||live.written<LIVE_MIN_BYTES)return
  live.checked=true
  try{
    const fd=fs.openSync(done?file:part,'r'),head=Buffer.alloc(4)
    try{fs.readSync(fd,head,0,4,0)}finally{fs.closeSync(fd)}
    if(head.toString('latin1')==='fLaC'&&/\.flac$/i.test(file)){live.ready=true;job.message='Playing while it downloads…';job.markLive()}
  }catch{}
}
async function liveResponse(job,{range,signal,mime='audio/flac'}={}){
  const live=job.live,size=live.total,slice=rangeOf(range,size)
  const headers={'content-type':mime,'accept-ranges':'bytes'}
  if(!slice)return new Response(null,{status:416,headers:{...headers,'content-range':`bytes */${size}`}})
  let handle=null
  for(const file of [live.part,live.file]){try{handle=await fsp.open(file,'r');break}catch{}}
  if(!handle){
    // Finished (and moved) before the player asked: the complete copy answers.
    await job.promise
    if(job.status!=='done')throw new Error(job.error || 'Audio preparation cancelled')
    return fileResponse(job.result.file,{range,signal,mime:job.result.mime})
  }
  headers['content-length']=String(slice.end-slice.start+1)
  if(slice.status===206)headers['content-range']=`bytes ${slice.start}-${slice.end}/${size}`
  let position=slice.start,closed=false
  const close=async()=>{if(!closed){closed=true;await handle.close().catch(()=>{})}}
  const body=new ReadableStream({
    async pull(controller){
      for(;;){
        if(signal?.aborted){await close();controller.close();return}
        if(position<live.written){
          const length=Math.min(256*1024,slice.end+1-position,live.written-position),buffer=Buffer.alloc(length)
          const {bytesRead}=await handle.read(buffer,0,length,position)
          if(bytesRead>0){
            position+=bytesRead;controller.enqueue(new Uint8Array(buffer.buffer,buffer.byteOffset,bytesRead))
            if(position>slice.end){await close();controller.close()}
            return
          }
        }
        // The download stopped (failed, cancelled, or restarted elsewhere).
        if(job.live!==live||job.status==='error'||job.status==='cancelled'){await close();controller.error(new Error(job.error || 'The addon stopped downloading this song'));return}
        await new Promise(resolve=>setTimeout(resolve,120))
      }
    },
    async cancel(){await close()},
  })
  return new Response(body,{status:slice.status,headers})
}

function operation(db,id,cancel=false){
  const job=state(db).get(id)
  if(!job)return {error:'Audio preparation operation not found'}
  if(cancel)job.controller.abort()
  const live=job.status==='running'&&!!job.live?.ready
  return {id:job.id,status:job.status,progress:job.progress,message:job.message,error:job.error,ok:job.status==='done'||live,package:true,...(live?{live:true}:{})}
}
async function resolve(db,key,id,{signal,force=false}={}){
  const hit=!force&&cached(db,key,id);if(hit)return hit
  const started=prepare(db,key,id,{force});if(started.ok)return cached(db,key,id)
  const job=state(db).get(started.operationId)
  const abort=()=>job.controller.abort();signal?.addEventListener('abort',abort,{once:true})
  try{
    // Whichever comes first: the complete file, or a download that can be played as it arrives.
    await Promise.race([job.promise,job.liveReady])
    if(job.status==='running'&&job.live?.ready)return {type:'live',job,mime:'audio/flac',headers:{},format:'flac'}
    await job.promise
    if(job.status!=='done')throw new Error(job.error || 'Audio preparation cancelled')
    return job.result
  }finally{signal?.removeEventListener('abort',abort)}
}
function rangeOf(value,size){
  if(!value)return {start:0,end:size-1,status:200}
  const match=String(value).match(/^bytes=(\d*)-(\d*)$/)
  if(!match||!match[1]&&!match[2]||!size)return null
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2])),end=match[1]?(match[2]?Math.min(size-1,Number(match[2])):size-1):size-1
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start?{start,end,status:206}:null
}
async function fileResponse(file,{range,signal,mime='audio/*'}={}){
  const handle=await fsp.open(file,'r'),size=(await handle.stat()).size,slice=rangeOf(range,size)
  const headers={'content-type':mime,'accept-ranges':'bytes'}
  if(!slice){await handle.close();return new Response(null,{status:416,headers:{...headers,'content-range':`bytes */${size}`}})}
  headers['content-length']=String(slice.end-slice.start+1)
  if(slice.status===206)headers['content-range']=`bytes ${slice.start}-${slice.end}/${size}`
  const body=handle.createReadStream({start:slice.start,end:slice.end,autoClose:true,signal})
  return new Response(Readable.toWeb(body),{status:slice.status,headers})
}
/**
 * The cached playback copy of this song, waiting for one being made now
 * (so "save to library" right after it played doesn't download it twice).
 */
async function cachedOrPending(db,key,id){
  let hit=null
  try{hit=cached(db,key,id)}catch{return null}
  if(hit)return hit
  let hash;try{hash=cacheKey(db,key,id)}catch{return null}
  const job=[...state(db).values()].find(j=>j.hash===hash&&j.status==='running')
  if(!job)return null
  try{await job.promise}catch{}
  return job.status==='done'?job.result:null
}
module.exports={cachedOrPending,prepare,operation,resolve,cached,fileResponse,liveResponse,liveUpdate,rangeOf}
