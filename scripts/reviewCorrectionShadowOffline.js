'use strict';
// Developer-only local tool. All reads/writes restricted to the ignored private review root.
const fs=require('fs');
const store=require('../src/services/correctionShadow/privateReview');
const review=require('../src/services/correctionShadow/verifier');
const workflow=require('../src/services/correctionShadow/goldWorkflow');
function main(argv=process.argv.slice(2)){
 const [command,requestFile,registryFile,actionFile,outputFile]=argv;
 if(!['receipt','freeze-gold'].includes(command)||argv.length!==5)throw Error('Usage: receipt|freeze-gold request-or-draft.json registry.json explicit-action.json output.json');
 const read=f=>JSON.parse(fs.readFileSync(store.privatePath(f),'utf8'));
 const config=read(registryFile),trusted=review.registry(config.reviewers,config.generator),action=read(actionFile),value=read(requestFile);
 const result=command==='receipt'?review.humanReceipt(action,value,trusted):workflow.finalize(value,action,trusted);
 if(command==='freeze-gold'){
  const path=require('path'),files=[outputFile,path.join(path.dirname(outputFile),'human-gold.json'),path.join(path.dirname(outputFile),'human-corrections.json'),path.join(path.dirname(outputFile),'negative-controls.json')];
  if(files.some(f=>fs.existsSync(store.privatePath(f))))throw Error('FROZEN_REVIEW_ALREADY_EXISTS');
  store.write(files[1],result.humanGold);store.write(files[2],result.correctionGold);store.write(files[3],result.correctionGold.negativeCases);store.write(files[0],result);
 }else store.write(outputFile,result);
}
if(require.main===module){try{main();}catch{process.stderr.write('Private review action rejected. Check explicit action, registry, candidate/draft hash and private paths.\n');process.exitCode=1;}}
module.exports={main};
