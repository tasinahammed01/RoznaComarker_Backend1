'use strict';
// Topology admission only; actual edits still execute withTransaction and fail closed.
async function requireTransactions(connection=require('mongoose').connection){
  const hello=await connection.db.admin().command({hello:1});
  if(!(hello.setName||hello.msg==='isdbgrid')||hello.logicalSessionTimeoutMinutes==null||hello.maxWireVersion<7)
    throw Object.assign(Error('Source confirmation requires MongoDB replica-set or sharded transactions.'),{code:'OCR_SOURCE_TRANSACTIONS_REQUIRED',status:503});
  return true;
}
module.exports={requireTransactions};
