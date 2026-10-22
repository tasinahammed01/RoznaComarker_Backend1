'use strict';
const fs=require('fs'),path=require('path');
const PRIVATE_ROOT=path.resolve(__dirname,'../../../tests/fixtures/hybrid-source/private');
function privatePath(file){
 const absolute=path.resolve(file),base=fs.realpathSync(PRIVATE_ROOT);let parent=absolute;while(!fs.existsSync(parent))parent=path.dirname(parent);
 const real=fs.realpathSync(parent);if((absolute!==base&&!absolute.startsWith(base+path.sep))||(real!==base&&!real.startsWith(base+path.sep)))throw Error('PRIVATE_REVIEW_PATH_REQUIRED');return absolute;
}
function write(file,value){const absolute=privatePath(file);fs.mkdirSync(path.dirname(absolute),{recursive:true,mode:0o700});fs.writeFileSync(absolute,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(artifact,imageFile,htmlFile){
 const image=privatePath(imageFile),html=privatePath(htmlFile);if(!/\.(png|jpe?g)$/i.test(image)||!fs.existsSync(image))throw Error('LOCAL_REVIEW_IMAGE_REQUIRED');
 const relative=path.relative(path.dirname(html),image).split(path.sep).map(encodeURIComponent).join('/');
 const polygons=artifact.rows.flatMap(r=>(r.authority.geometryEvidence.polygons||[]).map(points=>`<polygon points="${points.map(p=>`${Number(p.x)},${Number(p.y)}`).join(' ')}"><title>${esc(r.code)} diagnostic geometry only</title></polygon>`)).join('');
 const body=artifact.rows.map(r=>`<tr><td>${esc(r.candidateKey)}</td><td>${esc(r.providerEvidenceQuote)}</td><td>${esc(r.operativeEdit.operativeEditSpan?.source||r.operativeEdit.characterChange?.source)} → ${esc(r.operativeEdit.operativeEditSpan?.replacement||r.operativeEdit.characterChange?.replacement)}</td><td>${esc(r.code)}</td><td>${esc(r.authority.semanticCorrectionAuthority.state)}</td><td>SUPPORTED / UNSUPPORTED / UNCERTAIN: record an explicit action in review-actions.json</td></tr>`).join('');
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>Private correction review</title><style>body{font:16px system-ui;max-width:1200px;margin:24px auto;padding:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:8px;overflow-wrap:anywhere;white-space:pre-wrap}.page{position:relative;max-width:640px}.page img{width:100%}.page svg{position:absolute;inset:0;width:100%;height:100%;fill:#ffb00033;stroke:#b05b00}pre{white-space:pre-wrap}</style><h1>Private shadow review</h1><p>Developer/reviewer artifact. No student publication, score change or authoritative marker. Boxes show available diagnostic geometry only. Edit the companion review-actions.json and run the offline receipt tool after explicit review.</p><div class="page"><img alt="Uploaded page for private human review" src="${esc(relative)}"><svg aria-label="Diagnostic operative geometry" viewBox="0 0 ${artifact.identity.width} ${artifact.identity.height}">${polygons}</svg></div><h2>Selected source (${esc(artifact.sourceMode)})</h2><pre>${esc(artifact.sources[artifact.sourceMode].transcript)}</pre><h2>Candidates</h2><table><thead><tr><th>Candidate key</th><th>Exact context</th><th>Operative edit</th><th>Code</th><th>Semantic state</th><th>Explicit decision</th></tr></thead><tbody>${body}</tbody></table></html>`;
}
function reviewActions(artifact){return {notice:'UNREVIEWED template. No decision/approval is inferred. Review each candidate explicitly.',actions:artifact.rows.filter(r=>r.candidateKey).map((r,i)=>({action:'RECORD_HUMAN_SEMANTIC_REVIEW',confirmed:false,reviewerId:'REVIEWER_ID',reviewId:`review-${i}`,candidateKey:r.candidateKey,decision:null,rationale:''}))};}
function repository({Evidence,Submission}){
 if(!Evidence||!Submission)throw Error('EXPLICIT_PRIVATE_REPOSITORY_REQUIRED');
 const isCurrent=async raw=>{const identity=require('./verifier').identity(raw);const query=Submission.exists({_id:identity.submissionId,ocrJobId:identity.runId,ocrPages:{$elemMatch:{fileId:identity.fileId,pageNumber:identity.pageNumber,sourceSha256:identity.sourceSha256,ocrInputSha256:identity.inputSha256,width:identity.width,height:identity.height}}});return Boolean(await (typeof query.maxTimeMS==='function'?query.maxTimeMS(3000):query));};
 return {isCurrent,save:async artifact=>{
  if(!await isCurrent(artifact.identity))return;
  const allowed=['version','identity','transcriptHash','sourceMode','sources','generator','status','rows','publishable','studentVisible','scoreMutation','markerPublication','pdfPublication','errorCode'];
  if(Object.keys(artifact).some(k=>!allowed.includes(k)))throw Error('PRIVATE_SHADOW_FIELDS_ONLY');
  if(artifact.publishable!==false||artifact.studentVisible!==false||artifact.scoreMutation!==false||Buffer.byteLength(JSON.stringify(artifact))>1500000)throw Error('PRIVATE_SHADOW_ONLY');
  const key=require('../hybridSource/reconcile').digest(JSON.stringify(artifact.identity));
  await Evidence.updateOne({_id:key},{$set:{submissionId:artifact.identity.submissionId,runId:artifact.identity.runId,status:artifact.status,payload:artifact,expiresAt:new Date(Date.now()+30*86400000)}},{upsert:true,maxTimeMS:3000});
 }};
}
module.exports={PRIVATE_ROOT,privatePath,write,render,reviewActions,repository};
