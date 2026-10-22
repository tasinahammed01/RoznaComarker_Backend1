'use strict';
// Offline evaluation only. Gold is loaded after candidate discovery and never passed to it.
const fs=require('fs'),path=require('path');
const t=require('../src/services/sourceFidelity/targetedVerification');
const {classify}=require('./lib/ocrSourceAudit.cjs');
function evaluate(){
  const evidence=require('../tests/fixtures/source-fidelity/golden-002-readers.cjs');
  const plan=t.discover({...evidence,identity:evidence});
  const gold=require('../tests/fixtures/source-fidelity/golden-002.cjs');
  if(gold.inputSha256!==evidence.inputSha256||gold.status!=='HUMAN_GOLD')throw Error('GOLD_FIXTURE_IDENTITY');
  const map=t.tokenMap(gold.text,t.geometryWords(evidence.google));
  const findings=classify(gold.text,evidence.astra.activeTranscript,evidence.fable.activeTranscript).findings;
  const matrix=findings.map(f=>{
    const ids=[...new Set(map.filter(m=>m.start<f.end&&m.end>f.start).map(m=>m.id))];
    const regions=plan.regions.filter(r=>r.sourceGeometryWordIds.some(id=>ids.includes(id)));
    const directSignals=plan.signals.filter(s=>s.ids.some(id=>ids.includes(id)));
    const reasonCodes=[...new Set(regions.flatMap(r=>r.reasons))];
    const directReasons=[...new Set(directSignals.map(s=>s.reason))];
    const reasons=directReasons.length?directReasons:reasonCodes;
    const detectedBy=reasons.includes('ASTRA_FABLE_TEXT_DISAGREEMENT')?'DETECTED_BY_READER_DISAGREEMENT'
      :reasons.includes('ACTIVE_DELETED_CONFLICT')||reasons.includes('ASTRA_FABLE_SEGMENT_ROLE_CONFLICT')?'DETECTED_BY_ROLE_CONFLICT'
      :reasons.includes('READER_UNCERTAIN_SPAN')?'DETECTED_BY_READER_UNCERTAINTY'
      :reasons.includes('GEOMETRY_COVERAGE_GAP')||reasons.includes('POSSIBLE_READER_OMISSION')?'DETECTED_BY_GEOMETRY':'NOT_DETECTABLE_WITH_CURRENT_SIGNALS';
    return {...f,authority:'HUMAN_GOLD_TEST_ONLY',geometryWordIds:ids,detectedBy,reasonCodes,
      directSignalReasons:[...new Set(directSignals.map(s=>s.reason))],collateralCropCoverage:regions.length>0&&!directSignals.length,
      regionIds:regions.map(r=>r.id),mappingCaveat:'Gold-to-box alignment is offline evaluation support, not production source authority.'};
  });
  return {version:t.VERSION,inputSha256:gold.inputSha256,humanGoldFrozen:true,providerCalls:0,
    knownRegions:matrix.length,detectedRegions:matrix.filter(f=>f.regionIds.length).length,
    undetectableRegions:matrix.filter(f=>!f.regionIds.length).length,
    candidateRegionCount:plan.candidateRegionCount,omittedRegionCount:plan.omittedRegionCount,unlocalizedSignalCount:plan.unlocalizedSignalCount,
    regions:plan.regions,matrix};
}
if(require.main===module){const result=evaluate();const out=path.join(__dirname,'../tmp/targeted-v2');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'golden-002-coverage.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({known:result.knownRegions,detected:result.detectedRegions,undetectable:result.undetectableRegions,
    candidateRegions:result.candidateRegionCount,unlocalizedSignals:result.unlocalizedSignalCount,providerCalls:0}));}
module.exports={evaluate};
